// Serves the app, the OpenLifting programs in programs/, and stores app state + workout logs.
//   data/state.json   settings, the workout in progress, rest timer
//   data/logs/*.yaml  one OpenLifting log per finished workout
const http = require('http');
const fs = require('fs');
const path = require('path');
const os = require('os');
const yaml = require('js-yaml');
const OpenLifting = require('./public/js/openlifting.js');

const PORT = Number(process.env.PORT) || 3000;
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, 'data');
const PROGRAMS_DIR = process.env.PROGRAMS_DIR || path.join(__dirname, 'programs');
const STATE_FILE = path.join(DATA_DIR, 'state.json');
const LOGS_DIR = path.join(DATA_DIR, 'logs');
const PUBLIC = path.join(__dirname, 'public');
const MAX_BODY = 5 * 1024 * 1024;

const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
};

// CORE_SCHEMA keeps timestamps as strings instead of turning them into Dates.
const loadYaml = (text) => yaml.load(text, { schema: yaml.CORE_SCHEMA });
// Sets (depth 4) are written one per line in { } style, like the spec examples.
const dumpLog = (log) => yaml.dump(log, { flowLevel: 4, lineWidth: 120, schema: yaml.CORE_SCHEMA });

function writeAtomic(file, text) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file + '.tmp', text);
  fs.renameSync(file + '.tmp', file);
}

/* ---------- State ---------- */

// A corrupt file throws on purpose rather than silently starting over.
function loadState() {
  try {
    return JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
  } catch (e) {
    if (e.code === 'ENOENT') return { rev: 0, state: null };
    throw e;
  }
}

let store = loadState();

/* ---------- Logs ---------- */

function loadLogs() {
  const logs = [];
  let files = [];
  try {
    files = fs.readdirSync(LOGS_DIR).filter((f) => f.endsWith('.yaml'));
  } catch (e) {
    if (e.code !== 'ENOENT') throw e;
  }
  for (const f of files) {
    try {
      const log = loadYaml(fs.readFileSync(path.join(LOGS_DIR, f), 'utf8'));
      if (log && log['openlifting-log']) logs.push(Object.assign({ id: f.replace(/\.yaml$/, '') }, log));
    } catch (e) {
      console.error(`Skipping unreadable log ${f}: ${e.message}`);
    }
  }
  return logs.sort((a, b) => String(a.started).localeCompare(String(b.started)));
}

let logs = loadLogs();

const safeId = (s) => String(s).replace(/[^a-zA-Z0-9_-]+/g, '-').replace(/^-+|-+$/g, '');

function saveLog(log) {
  if (!log || log['openlifting-log'] !== 1 || !Array.isArray(log.entries)) throw new Error('Not an OpenLifting log');
  // A session is logged once: repeat saves (retries, double taps, delayed requests) return the first.
  const dup = log['x-session'] && logs.find((l) => l['x-session'] === log['x-session']);
  if (dup) return dup.id;
  const base = safeId(`${String(log.started).slice(0, 10)}-${log.workout}`);
  let id = base;
  for (let n = 2; fs.existsSync(path.join(LOGS_DIR, id + '.yaml')); n++) id = `${base}-${n}`;
  writeAtomic(path.join(LOGS_DIR, id + '.yaml'), dumpLog(log));
  logs.push(Object.assign({ id }, log));
  logs.sort((a, b) => String(a.started).localeCompare(String(b.started)));
  return id;
}

function deleteLog(id) {
  const file = path.join(LOGS_DIR, safeId(id) + '.yaml');
  fs.unlinkSync(file);
  logs = logs.filter((l) => l.id !== id);
}

/* ---------- Programs ---------- */

// Read fresh on every full fetch so edits to the YAML show up on refresh.
function programFiles() {
  try {
    return fs.readdirSync(PROGRAMS_DIR).filter((f) => /\.ya?ml$/.test(f)).sort();
  } catch (e) {
    if (e.code === 'ENOENT') return [];
    throw e;
  }
}

function programsStamp() {
  return programFiles().map((f) => f + ':' + fs.statSync(path.join(PROGRAMS_DIR, f)).mtimeMs).join('|');
}

function loadPrograms() {
  return programFiles().map((file) => {
    try {
      const raw = loadYaml(fs.readFileSync(path.join(PROGRAMS_DIR, file), 'utf8'));
      return { file, program: OpenLifting.normalizeProgram(raw) };
    } catch (e) {
      return { file, error: e.message };
    }
  });
}

/* ---------- HTTP ---------- */

// The rev clients compare against: app changes plus program file edits.
const currentRev = () => `${store.rev}:${programsStamp()}`;

function sendJSON(res, status, body) {
  res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(body));
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > MAX_BODY) {
        reject(new Error('Body too large'));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

function bump() {
  store.rev += 1;
  writeAtomic(STATE_FILE, JSON.stringify(store));
}

async function handleApi(req, res, url) {
  const p = url.pathname;
  if (p === '/api/state' && req.method === 'GET') {
    const rev = currentRev();
    // Clients pass the rev they have; an unchanged rev gets a tiny reply (the TV polls this).
    if (url.searchParams.get('rev') === rev) return sendJSON(res, 200, { rev, now: Date.now(), unchanged: true });
    return sendJSON(res, 200, { rev, now: Date.now(), state: store.state, logs, programs: loadPrograms() });
  }
  if (p === '/api/state' && req.method === 'PUT') {
    const body = JSON.parse(await readBody(req));
    if (!body || typeof body.state !== 'object' || body.state === null) return sendJSON(res, 400, { error: 'Expected { state: {...} }' });
    store.state = body.state;
    bump();
    return sendJSON(res, 200, { rev: currentRev(), now: Date.now() });
  }
  if (p === '/api/logs' && req.method === 'POST') {
    const id = saveLog(JSON.parse(await readBody(req)).log);
    bump();
    return sendJSON(res, 200, { id, rev: currentRev(), now: Date.now() });
  }
  const m = p.match(/^\/api\/logs\/([\w-]+)$/);
  if (m && req.method === 'DELETE') {
    deleteLog(m[1]);
    bump();
    return sendJSON(res, 200, { rev: currentRev(), now: Date.now() });
  }
  sendJSON(res, 404, { error: 'Not found' });
}

function serveStatic(req, res, url) {
  let rel = decodeURIComponent(url.pathname);
  if (rel === '/') rel = '/index.html';
  if (rel === '/tv' || rel === '/tv/') rel = '/tv.html';
  const file = path.normalize(path.join(PUBLIC, rel));
  if (!file.startsWith(PUBLIC + path.sep)) {
    res.writeHead(403);
    return res.end('Forbidden');
  }
  fs.readFile(file, (err, buf) => {
    if (err) {
      res.writeHead(404, { 'Content-Type': 'text/plain' });
      return res.end('Not found');
    }
    res.writeHead(200, {
      'Content-Type': TYPES[path.extname(file)] || 'application/octet-stream',
      'Cache-Control': 'no-cache',
    });
    res.end(buf);
  });
}

const server = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://localhost');
  if (url.pathname.startsWith('/api/')) {
    handleApi(req, res, url).catch((err) => sendJSON(res, 400, { error: err.message }));
  } else {
    serveStatic(req, res, url);
  }
});

server.listen(PORT, '0.0.0.0', () => {
  for (const p of loadPrograms()) {
    console.log(p.error ? `Program ${p.file}: ERROR ${p.error}` : `Program ${p.file}: ${p.program.name} (${p.program.workouts.length} workouts)`);
  }
  console.log(`Logs: ${logs.length} in ${LOGS_DIR}`);
  console.log(`Lifting tracker running:`);
  console.log(`  Phone: http://localhost:${PORT}/`);
  for (const addrs of Object.values(os.networkInterfaces())) {
    for (const a of addrs || []) {
      if (a.family === 'IPv4' && !a.internal) {
        console.log(`  LAN:   http://${a.address}:${PORT}/   (TV: http://${a.address}:${PORT}/tv)`);
      }
    }
  }
});
