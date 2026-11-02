/*
 * Shared logic for the phone and TV views, built on the OpenLifting model (openlifting.js).
 * ES5 on purpose (TV browsers).
 *
 * ctx = { program, logs, settings }   — program is the parsed model; logs are OpenLifting logs
 * state = { settings, active, restEndsAt (server ms), restTotal (s), restMax (s) }
 * active session = {
 *   id, program, workout, started (ms),
 *   members: [{ block, member, exercise, tw, option, fallback }],   one per exercise in each block
 *   steps:   [{ block, m (index into members), kind, reps, load, restSec, optional, note, label,
 *               done, skipped, r (reps), w (weight override), dw (weight when done) }]
 * }
 * Weights for bodyweight-style sets are the ADDED weight; "BW" is 0.
 */

var OL = OpenLifting;

// Your equipment. Only changed values are stored in state.settings; these fill in the rest.
//   bars: the bars you own. barFor: which bar a barbell exercise uses (otherwise the program's bar).
//   dumbbellFineUpTo: dumbbells come in 2.5 lb steps up to this weight, 5 lb steps above it.
//   machineStep: weight steps on cables and machines (otherwise the program's increment).
var DEFAULT_SETTINGS = {
  plates: [45, 35, 25, 10, 5, 1.75],
  bars: [
    { id: 'standard', name: 'Standard bar', weight: 45 },
    { id: 'deadlift', name: 'Deadlift bar', weight: 55 },
    { id: 'ez', name: 'EZ curl bar', weight: 25 }
  ],
  barFor: { deadlift: 'deadlift', 'ez-bar-curl': 'ez' },
  dumbbellFineUpTo: 35,
  machineStep: null
};

function emptyState() {
  return { settings: {}, active: null, restEndsAt: 0, restTotal: 0, restMax: 0 };
}

function getSettings(state) {
  var s = {}, k;
  for (k in DEFAULT_SETTINGS) s[k] = DEFAULT_SETTINGS[k];
  for (k in (state && state.settings) || {}) s[k] = state.settings[k];
  s.plates = s.plates.slice().sort(function (a, b) { return b - a; });
  s.dumbbellFineUpTo = Number(s.dumbbellFineUpTo) || 0;
  s.machineStep = Number(s.machineStep) || null;
  return s;
}

// The chosen program entry ({ file, program } or { file, error }), falling back to the first that loaded.
function pickProgram(programs, state) {
  var want = state && state.settings && state.settings.program, first = null;
  for (var i = 0; i < programs.length; i++) {
    if (programs[i].file === want) return programs[i];
    if (!first && programs[i].program) first = programs[i];
  }
  return first;
}

function getWorkout(program, id) {
  for (var i = 0; i < program.workouts.length; i++) if (program.workouts[i].id === id) return program.workouts[i];
  return null;
}

// schedule: rotate — the workout after the most recently logged one.
function nextWorkoutId(ctx) {
  var ws = ctx.program.workouts;
  for (var i = ctx.logs.length - 1; i >= 0; i--) {
    var log = ctx.logs[i];
    if (log.program !== ctx.program.id) continue;
    for (var j = 0; j < ws.length; j++) if (ws[j].id === log.workout) return ws[(j + 1) % ws.length].id;
  }
  return ws[0].id;
}

function exerciseName(ctx, id) {
  var ex = ctx.program.exercises[id];
  return ex ? ex.name : OL.titleCase(id);
}

// "Curls" for "DB Hammer Curls" — only used to tell superset members apart.
function shortName(ctx, id) {
  var words = exerciseName(ctx, id).split(' ');
  return words[words.length - 1];
}

// Name for a step outside its block card: short inside a superset, full otherwise.
function stepName(ctx, session, st) {
  var ex = session.members[st.m].exercise;
  return inSuperset(ctx, session, st) ? shortName(ctx, ex) : exerciseName(ctx, ex);
}

function blockTitle(ctx, block) {
  var ms = OL.members(block);
  if (ms.length === 1) return ms[0].label || exerciseName(ctx, ms[0].exercise);
  return 'Superset: ' + ms.map(function (m) { return m.label || exerciseName(ctx, m.exercise); }).join(' + ');
}

/* ---------- Logs ---------- */

// One logged set → { kind, reps, weight (added weight for BW), bw, skipped }
function logSet(s) {
  var kind = null;
  OL.KINDS.forEach(function (k) { if (s[k] !== undefined && !kind) kind = k; });
  var w = s.weight, num = null, bw = false, m;
  if (typeof w === 'number') num = w;
  else if (typeof w === 'string' && (m = w.match(/^BW(?:\s*([+-])\s*([\d.]+))?$/i))) {
    bw = true;
    num = m[2] ? Number(m[2]) * (m[1] === '-' ? -1 : 1) : 0;
  } else if (w != null && !isNaN(Number(w))) num = Number(w);
  return { kind: kind, reps: Number(s[kind]), weight: num, bw: bw, skipped: !!s.skipped };
}

// Whether a log entry should drive progression (§6): not a light day, not a fallback.
function entryCounts(ctx, log, entry) {
  if (entry['x-fallback']) return false;
  if (entry['x-progress'] !== undefined) return entry['x-progress'] !== 'none';
  // Logs written elsewhere: look the block up in the program.
  var w = log.program === ctx.program.id && getWorkout(ctx.program, log.workout);
  var counts = true;
  if (w) w.blocks.forEach(function (b) {
    OL.members(b).forEach(function (m) { if (m.exercise === entry.exercise && m.progress === 'none') counts = false; });
  });
  return counts;
}

// Calls fn(entry, log) for every logged entry of an exercise, newest first, until fn returns true.
function eachEntry(ctx, exercise, fn) {
  for (var i = ctx.logs.length - 1; i >= 0; i--) {
    var log = ctx.logs[i];
    for (var j = 0; j < (log.entries || []).length; j++) {
      if (log.entries[j].exercise === exercise && fn(log.entries[j], log)) return;
    }
  }
}

// Most recent logged top set of an exercise (for "85% of squat" and "last time").
function lastTop(ctx, exercise) {
  var found = null;
  eachEntry(ctx, exercise, function (entry, log) {
    (entry.sets || []).some(function (raw) {
      var s = logSet(raw);
      if (s.kind === 'top' && !s.skipped && s.weight != null) found = { weight: s.weight, bw: s.bw, reps: s.reps, date: log.started };
      return found;
    });
    return found;
  });
  return found;
}

function lastOption(ctx, exercise) {
  var opt = null;
  eachEntry(ctx, exercise, function (entry) { opt = entry.option || null; return opt; });
  var ex = ctx.program.exercises[exercise];
  return opt || (ex && ex.options.length ? ex.options[0] : null);
}

/* ---------- Weights ---------- */

function fmtNum(w) { return String(Math.round(w * 100) / 100); }

// The bar this exercise uses: the one picked in Setup, else the program's bar weight.
function barFor(ctx, exercise) {
  var id = ctx.settings.barFor[exercise];
  return ctx.settings.bars.filter(function (b) { return b.id === id; })[0] || null;
}

function barWeight(ctx, exercise) {
  var bar = barFor(ctx, exercise);
  if (bar) return bar.weight;
  var ex = ctx.program.exercises[exercise];
  return ex && ex.bar != null ? ex.bar : ctx.program.defaults.bar;
}

// The program's increment (the step for cables, machines and anything without its own rule).
function increment(ctx, exercise) {
  var ex = ctx.program.exercises[exercise] || {};
  if (ex.increment != null) return ex.increment;
  return ctx.settings.machineStep || ctx.program.defaults.increment;
}

function isBarbell(ctx, exercise) { return (ctx.program.exercises[exercise] || {}).equipment === 'barbell'; }

// Plate totals you can make on one side (or a belt): any number of the full plates (5 lb and up),
// plus at most one of each fractional plate (under 5 lb).
function plateSums(plates, max) {
  var full = plates.filter(function (p) { return p >= 5; }), frac = plates.filter(function (p) { return p < 5; });
  var step = full.length ? full[full.length - 1] : 5, subs = [0], out = [];
  frac.forEach(function (f) { subs = subs.concat(subs.map(function (x) { return x + f; })); });
  for (var k = 0; k * step <= max; k++) subs.forEach(function (x) { out.push(Math.round((k * step + x) * 100) / 100); });
  return out;
}

// Every weight you can actually load for an exercise, ascending.
function loadable(ctx, exercise, bw) {
  ctx.loadCache = ctx.loadCache || {};
  var key = exercise + (bw ? ':bw' : '');
  if (ctx.loadCache[key]) return ctx.loadCache[key];
  var eq = (ctx.program.exercises[exercise] || {}).equipment, s = ctx.settings, list = [], w;
  if (bw) {
    // Belt plates on top; band assistance (negative) in 2.5 steps.
    for (w = -150; w < 0; w += 2.5) list.push(w);
    list = list.concat(plateSums(s.plates, 200));
  } else if (eq === 'barbell') {
    var bar = barWeight(ctx, exercise);
    list = plateSums(s.plates, 400).map(function (x) { return bar + 2 * x; });
  } else if (eq === 'dumbbell') {
    for (w = 2.5; w <= 200; w += w < s.dumbbellFineUpTo - 1e-9 ? 2.5 : 5) list.push(w);
  } else {
    var inc = increment(ctx, exercise) || 2.5;
    for (w = inc; w <= 600; w += inc) list.push(Math.round(w * 100) / 100);
  }
  list = list.filter(function (x, i, a) { return a.indexOf(x) === i; }).sort(function (a, b) { return a - b; });
  ctx.loadCache[key] = list;
  return list;
}

function lowest(ctx, exercise, bw) {
  // Bodyweight loads can go below zero: negative added weight is band assistance.
  if (bw) return -Infinity;
  return loadable(ctx, exercise, false)[0];
}

// Round a calculated load to the nearest weight you can load.
function roundLoad(ctx, exercise, w, bw) {
  var list = loadable(ctx, exercise, bw), best = w, d = Infinity;
  list.forEach(function (x) { if (Math.abs(x - w) < d - 1e-9) { d = Math.abs(x - w); best = x; } });
  return best;
}

// Smallest loadable weight at or above w.
function loadAtLeast(ctx, exercise, w, bw) {
  var list = loadable(ctx, exercise, bw);
  for (var i = 0; i < list.length; i++) if (list[i] >= w - 1e-9) return list[i];
  return w;
}

function isBW(ctx, step, exercise) {
  var eq = (ctx.program.exercises[exercise] || {}).equipment;
  return step.load.type === 'bodyweight' || eq === 'weighted-bodyweight' || eq === 'bodyweight';
}

// Does this exercise in this block use the lifter's TW (so the app should ask for one)?
function usesTW(def) {
  return def.sets.concat(def.fallback ? def.fallback.sets : []).some(function (s) {
    var L = s.load;
    return L.type === 'tw' || (L.type === 'percent' && !L.of) || (L.type === 'bodyweight' && L.plus === 'tw');
  });
}

// Suggested TW for an exercise block (§6): { tw, why, up }
function suggestTW(ctx, def) {
  if (!usesTW(def)) return { tw: null, why: '' };
  var rule = OL.progressRule(ctx.program, def), last = null;
  eachEntry(ctx, def.exercise, function (entry, log) {
    if (!entryCounts(ctx, log, entry)) return false;
    var sets = (entry.sets || []).map(logSet).filter(function (s) { return !s.skipped; });
    var top = sets.filter(function (s) { return s.kind === 'top'; })[0];
    // What you actually lifted on the top set beats the planned TW (you may have changed it mid-workout).
    var tw = top && top.weight != null ? top.weight : entry.tw != null ? Number(entry.tw) : null;
    if (tw == null) return false;
    last = { tw: tw, sets: sets, top: top };
    return true;
  });
  if (!last) return { tw: null, why: 'First time. Enter your top-set weight.' };

  var specTop = def.sets.filter(function (s) { return s.kind === 'top'; })[0];
  var eq = (ctx.program.exercises[def.exercise] || {}).equipment;
  var twText = eq === 'weighted-bodyweight' ? bwLabel(last.tw, '−') : fmtNum(last.tw);
  var hit, desc;
  if (specTop) {
    hit = last.top && typeof specTop.reps === 'object' && last.top.reps >= specTop.reps.max;
    desc = last.top ? twText + ' × ' + last.top.reps : twText;
  } else {
    // No top set: every work set must reach the top of its range.
    var specWork = def.sets.filter(function (s) { return s.kind === 'work'; });
    var work = last.sets.filter(function (s) { return s.kind === 'work'; });
    hit = specWork.length > 0 && work.length >= specWork.length && specWork.every(function (sp, i) {
      return typeof sp.reps === 'object' && work[i].reps >= sp.reps.max;
    });
    desc = twText + ' × ' + work.map(function (s) { return s.reps; }).join('/');
  }
  if (specTop && !last.top) return { tw: last.tw, why: 'Last: ' + desc + ' (top set skipped)' };
  if (rule === 'none' || !hit) {
    return { tw: last.tw, why: 'Last: ' + desc + (rule === 'none' ? '' : ' (hit the top of the range to add weight)') };
  }
  // The lightest weight you can load that is at least the rule's minimum step up.
  var bw = eq === 'weighted-bodyweight' || eq === 'bodyweight';
  var next = loadAtLeast(ctx, def.exercise, last.tw + rule.add.min, bw), add = next - last.tw;
  return { tw: next, why: 'Last: ' + desc + ' → +' + fmtNum(add), up: true };
}

function memberDef(ctx, session, mi) {
  var mem = session.members[mi], w = getWorkout(ctx.program, session.workout);
  return OL.members(w.blocks[mem.block])[mem.member];
}

// Weight of every step (null = unknown, or "light" — the lifter picks).
function weightsFor(ctx, session) {
  var prev = {}, out = [];
  session.steps.forEach(function (st) {
    var w = stepWeight(ctx, session, st, prev[st.m]);
    out.push(w);
    prev[st.m] = w;
  });
  return out;
}

function stepWeight(ctx, session, st, prev) {
  if (st.done) return st.dw;
  if (st.w != null) return st.w;
  var mem = session.members[st.m], ex = mem.exercise, L = st.load, tw = mem.tw, bw = isBW(ctx, st, ex);
  if (L.type === 'tw' || (L.type === 'bodyweight' && L.plus === 'tw')) return tw;
  var w;
  switch (L.type) {
    case 'percent':
      var base = L.of ? (lastTop(ctx, L.of) || {}).weight : tw;
      w = base == null ? null : roundLoad(ctx, ex, base * L.value / 100, bw);
      break;
    case 'relative': w = prev == null ? null : Math.max(prev + L.delta, lowest(ctx, ex, bw)); break;
    case 'absolute': w = L.value; break;
    case 'bar': w = barWeight(ctx, ex); break;
    case 'bodyweight': w = L.plus ? L.plus.value : 0; break;
    case 'inherit': w = prev == null ? null : prev; break;
    default: w = null; // light
  }
  // Band-assisted (negative TW): warm-ups and "BW only" sets get at least the top set's
  // assistance, so they're never harder than the top set.
  if (bw && w != null && tw != null && tw < 0) w = Math.min(w, tw);
  return w;
}

// "BW", "BW+25", or "BW-30" (band assisted); pass minus='−' for display.
function bwLabel(w, minus) {
  if (!w) return 'BW';
  return w > 0 ? 'BW+' + fmtNum(w) : 'BW' + (minus || '-') + fmtNum(-w);
}

// { main, sub } for display.
function fmtWeight(ctx, st, exercise, w) {
  var eq = (ctx.program.exercises[exercise] || {}).equipment;
  if (w == null && st.load.type === 'light') return { main: 'light', sub: 'your pick' };
  if (w == null) return { main: '—', sub: st.load.of ? 'tap to set' : 'needs weight' };
  if (isBW(ctx, st, exercise)) return { main: bwLabel(w, '−'), sub: w < 0 ? 'band assist' : '' };
  var subs = { dumbbell: 'per dumbbell', cable: 'stack', plate: 'plate' };
  return { main: fmtNum(w), sub: subs[eq] || '' };
}

function fmtReps(reps) {
  if (reps === 'amrap') return 'AMRAP';
  if (reps === 'any') return 'any';
  return reps.min === reps.max ? String(reps.min) : reps.min + '–' + reps.max;
}

/* ---------- Plates ---------- */

// Barbells show plates per side; weighted dips/chins show what goes on the belt.
function plateMode(ctx, st, exercise) {
  var eq = (ctx.program.exercises[exercise] || {}).equipment;
  if (eq === 'barbell') return 'side';
  if (eq === 'weighted-bodyweight' || (eq !== 'bodyweight' && st.load.type === 'bodyweight')) return 'belt';
  return null;
}

function greedyPlates(load, plates) {
  var list = [], rem = Math.max(load, 0);
  plates.forEach(function (p) {
    while (rem >= p - 1e-9) { list.push(p); rem -= p; }
  });
  return { list: list, rem: Math.round(rem * 100) / 100 };
}

function platesFor(ctx, st, exercise, w) {
  var mode = plateMode(ctx, st, exercise);
  if (!mode || w == null || (mode === 'belt' && w < 0)) return null;
  var g = greedyPlates(mode === 'side' ? (w - barWeight(ctx, exercise)) / 2 : w, ctx.settings.plates);
  return { perSide: mode === 'side', list: g.list, rem: g.rem };
}

/*
 * Choose plates for a run of sets on the same bar so going set to set moves as few plates as
 * possible. Plates come off and go on from the outside, so a change from stack A to stack B
 * costs (plates removed above their shared base) + (plates added). Candidates for each set keep
 * some inner part of a previous set's stack and fill the rest greedily, and are capped at one
 * plate more than the fewest possible so the bar doesn't fill up with 10s and 5s.
 * Ties go to fewer plates, then to the usual heaviest-inside order.
 */
function planStacks(loads, plates) {
  function moves(a, b) {
    var k = 0;
    while (k < a.length && k < b.length && a[k] === b[k]) k++;
    return (a.length - k) + (b.length - k);
  }
  function inversions(list) {
    var n = 0;
    for (var i = 1; i < list.length; i++) if (list[i] > list[i - 1]) n++;
    return n;
  }
  // Big plates may stack in any order (25 under 45 is fine), but small change plates
  // stay outermost — nobody wants to dig a 10 out from under two 45s.
  function sensible(list) {
    for (var i = 1; i < list.length; i++) if (list[i] >= 25 && list[i - 1] < 25) return false;
    return true;
  }
  var states = [{ list: [], rem: 0, score: 0, path: [] }];
  loads.forEach(function (load) {
    var greedy = greedyPlates(load, plates);
    var maxLen = greedy.list.length + 1;
    var cands = {};
    function consider(base) {
      var sum = 0;
      base.forEach(function (p) { sum += p; });
      if (sum > load + 1e-9) return;
      var fill = greedyPlates(load - sum, plates);
      var list = base.concat(fill.list);
      if (list.length > maxLen || fill.rem !== greedy.rem || !sensible(list)) return;
      cands[list.join(',')] = { list: list, rem: fill.rem };
    }
    consider([]);
    states.forEach(function (st) {
      for (var k = 1; k <= st.list.length; k++) consider(st.list.slice(0, k));
    });
    var next = [];
    for (var key in cands) {
      var c = cands[key], best = null;
      states.forEach(function (st) {
        // moves first, then plate count, then conventional order
        var score = st.score + moves(st.list, c.list) * 10000 + c.list.length * 100 + inversions(c.list);
        if (!best || score < best.score) best = { list: c.list, rem: c.rem, score: score, path: st.path.concat([c]) };
      });
      next.push(best);
    }
    next.sort(function (a, b) { return a.score - b.score; });
    states = next.slice(0, 40);
  });
  return states[0].path;
}

// Plate plan for every step in a session, indexed like session.steps (undefined where no plates).
// Each entry: { perSide, list, rem, add, remove, first } — add/remove are the change from the
// previous set of the same exercise.
function platePlan(ctx, session, weights) {
  var plan = [], byMember = {}, order = [];
  session.steps.forEach(function (st, i) {
    var ex = session.members[st.m].exercise, mode = plateMode(ctx, st, ex);
    // Band-assisted sets have nothing on the belt.
    if (!mode || weights[i] == null || (mode === 'belt' && weights[i] < 0)) return;
    if (!byMember[st.m]) { byMember[st.m] = []; order.push(st.m); }
    byMember[st.m].push(i);
  });
  order.forEach(function (mi) {
    var idx = byMember[mi], ex = session.members[mi].exercise;
    var loads = idx.map(function (i) {
      return plateMode(ctx, session.steps[i], ex) === 'side' ? (weights[i] - barWeight(ctx, ex)) / 2 : weights[i];
    });
    var stacks = planStacks(loads, ctx.settings.plates), prev = [];
    idx.forEach(function (i, k) {
      var list = stacks[k].list, n = 0;
      while (n < prev.length && n < list.length && prev[n] === list[n]) n++;
      plan[i] = {
        perSide: plateMode(ctx, session.steps[i], ex) === 'side',
        list: list,
        rem: stacks[k].rem,
        remove: prev.slice(n).reverse(),
        add: list.slice(n),
        first: k === 0
      };
      prev = list;
    });
  });
  return plan;
}

// "Take off 10 · Put on 25 each side" for the change from the previous set.
function changeText(pl) {
  if (!pl) return '';
  var each = pl.perSide ? ' each side' : '';
  if (pl.first) return '';
  if (!pl.remove.length && !pl.add.length) return 'No change';
  var parts = [];
  if (pl.remove.length) parts.push('Take off ' + pl.remove.map(fmtNum).join(', '));
  if (pl.add.length) parts.push('Put on ' + pl.add.map(fmtNum).join(', '));
  return parts.join(' · ') + each;
}

function plateClass(p) { return 'p' + String(p).replace('.', '_'); }

function platesText(pl) {
  if (!pl) return '';
  if (!pl.list.length) return pl.perSide ? 'Empty bar' : '';
  var txt = (pl.perSide ? 'Per side: ' : 'Belt: ') + pl.list.map(fmtNum).join(' + ');
  if (pl.rem) txt += ' (+' + fmtNum(pl.rem) + ' won’t fit)';
  return txt;
}

function platesHTML(pl) {
  if (!pl || !pl.list.length) return '';
  var html = '<div class="plates' + (pl.perSide ? ' bar' : '') + '">';
  if (pl.perSide) html += '<span class="shaft"></span><span class="collar"></span>';
  pl.list.forEach(function (p) { html += '<span class="plate ' + plateClass(p) + '">' + fmtNum(p) + '</span>'; });
  if (pl.perSide) html += '<span class="sleeve"></span>';
  return html + '</div>';
}

/* ---------- Sessions ---------- */

var STEP_LABELS = { warmup: 'Warm-up', top: 'Top set', work: 'Set', backoff: 'Back-off', drop: 'Drop', restpause: 'Rest-pause' };

// Steps for one block, honoring each member's fallback choice. base = index of the block's first member.
function blockSteps(ctx, session, bi, base) {
  var block = getWorkout(ctx.program, session.workout).blocks[bi], fb = {};
  OL.members(block).forEach(function (m, mi) { if (session.members[base + mi].fallback) fb[mi] = true; });
  var steps = OL.expandBlock(ctx.program, block, { fallback: fb });
  var totals = {}, seen = {};
  steps.forEach(function (st) { var k = st.member + st.kind; totals[k] = (totals[k] || 0) + 1; });
  return steps.map(function (st) {
    var k = st.member + st.kind, n = (seen[k] = (seen[k] || 0) + 1), t = totals[k];
    var label = STEP_LABELS[st.kind] +
      (st.kind === 'warmup' && t > 1 ? ' ' + n + '/' + t : '') +
      (st.kind !== 'warmup' && st.kind !== 'top' && t > 1 ? ' ' + n : '');
    var out = { block: bi, m: base + st.member, kind: st.kind, reps: st.reps, load: st.load, label: label, done: false, skipped: false, r: null, w: null };
    if (st.restSec) out.restSec = st.restSec;
    if (st.optional) out.optional = st.optional;
    if (st.note) out.note = st.note;
    return out;
  });
}

function newSession(ctx, workoutId) {
  var w = getWorkout(ctx.program, workoutId);
  var session = {
    id: 's' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6),
    program: ctx.program.id,
    workout: w.id,
    started: Date.now(),
    members: [],
    steps: []
  };
  w.blocks.forEach(function (b, bi) {
    var base = session.members.length;
    OL.members(b).forEach(function (def, mi) {
      session.members.push({
        block: bi, member: mi, exercise: def.exercise,
        tw: suggestTW(ctx, def).tw, option: lastOption(ctx, def.exercise), fallback: false
      });
    });
    session.steps = session.steps.concat(blockSteps(ctx, session, bi, base));
  });
  return session;
}

// Switch an exercise to (or back from) its fallback sets. Only before any set in the block is done.
function setFallback(ctx, session, mi, on) {
  var bi = session.members[mi].block, base = mi - session.members[mi].member;
  session.members[mi].fallback = on;
  var first = -1, rest = [];
  session.steps.forEach(function (st, i) {
    if (st.block === bi) { if (first < 0) first = i; } else rest.push(st);
  });
  var fresh = blockSteps(ctx, session, bi, base);
  session.steps = rest.slice(0, first).concat(fresh, rest.slice(first));
}

function blockStarted(session, bi) {
  return session.steps.some(function (st) { return st.block === bi && (st.done || st.skipped); });
}

function currentIndex(session) {
  for (var i = 0; i < session.steps.length; i++) if (!session.steps[i].done && !session.steps[i].skipped) return i;
  return -1;
}

// Can this step be skipped right now? (optional: true, or top_reps_at_least met today)
function canSkip(session, st) {
  if (st.optional === true) return true;
  if (!st.optional) return false;
  return session.steps.some(function (o) { return o.m === st.m && o.kind === 'top' && o.done && o.r >= st.optional.topRepsAtLeast; });
}

function inSuperset(ctx, session, st) {
  return getWorkout(ctx.program, session.workout).blocks[st.block].type === 'superset';
}

function isoLocal(ms) {
  var d = new Date(ms), off = -d.getTimezoneOffset(), p = function (n) { return (n < 10 ? '0' : '') + n; };
  return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate()) + 'T' +
    p(d.getHours()) + ':' + p(d.getMinutes()) + ':' + p(d.getSeconds()) +
    (off >= 0 ? '+' : '-') + p(Math.floor(Math.abs(off) / 60)) + ':' + p(Math.abs(off) % 60);
}

// The finished workout as an OpenLifting log (§7). Sets you didn't do (skipped, or unchecked
// when finishing early) are logged as 0 reps with skipped: true.
function buildLog(ctx, session, finishedMs) {
  var weights = weightsFor(ctx, session), entries = [];
  session.members.forEach(function (mem, mi) {
    var sets = [];
    session.steps.forEach(function (st, i) {
      if (st.m !== mi) return;
      var o = {};
      o[st.kind] = st.done ? st.r : 0;
      if (weights[i] != null) {
        o.weight = isBW(ctx, st, mem.exercise) ? bwLabel(weights[i]) : weights[i];
      }
      if (!st.done) o.skipped = true;
      sets.push(o);
    });
    var def = memberDef(ctx, session, mi), e = { exercise: mem.exercise };
    if (mem.option) e.option = mem.option;
    if (mem.tw != null && usesTW(def) && !mem.fallback) e.tw = mem.tw;
    e.sets = sets;
    // App extensions so the log alone says whether it should drive progression.
    if (def.progress === 'none') e['x-progress'] = 'none';
    if (mem.fallback) e['x-fallback'] = true;
    entries.push(e);
  });
  return {
    'openlifting-log': 1,
    program: ctx.program.id,
    workout: session.workout,
    started: isoLocal(session.started),
    finished: isoLocal(finishedMs),
    units: ctx.program.units,
    // App extension: lets the server ignore repeat saves of the same session (retries, double taps).
    'x-session': session.id,
    entries: entries
  };
}

// "Bench Press 225 × 7" for each exercise's top set (or first work set) in a log.
function logHighlights(ctx, log) {
  return (log.entries || []).map(function (e) {
    var sets = (e.sets || []).map(logSet).filter(function (s) { return !s.skipped; });
    var s = sets.filter(function (x) { return x.kind === 'top'; })[0] || sets.filter(function (x) { return x.kind === 'work'; })[0];
    if (!s) return null;
    var w = s.bw ? bwLabel(s.weight, '−') : s.weight != null ? fmtNum(s.weight) : '';
    return { name: exerciseName(ctx, e.exercise), text: (w ? w + ' × ' : '') + s.reps };
  }).filter(Boolean);
}

function fmtClock(sec) {
  sec = Math.max(0, Math.ceil(sec));
  var m = Math.floor(sec / 60), s = sec % 60;
  return m + ':' + (s < 10 ? '0' : '') + s;
}

function esc(str) {
  return String(str).replace(/[&<>"']/g, function (c) {
    return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
  });
}
