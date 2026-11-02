// Phone view: pick a workout, log sets, run the rest timer. State is saved to the server (which
// the TV follows); finished workouts are saved as OpenLifting log files.
(function () {
  const $app = document.getElementById('app');
  const $rest = document.getElementById('rest');
  let state = null;
  let logs = [];
  let programs = [];
  let ctx = null; // { program, logs, settings } or null if no program loaded
  let offset = 0; // server clock − local clock, so rest timers agree across devices
  let saving = Promise.resolve();
  let restBuzzed = false;
  let wakeLock = null;
  let finishing = false; // a Finish save is in flight; ignore repeat taps

  const now = () => Date.now() + offset;

  // Requests give up after 15s so a flaky connection shows an error instead of hanging silently.
  function api(method, url, body) {
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), 15000);
    return fetch(url, {
      method,
      headers: body ? { 'Content-Type': 'application/json' } : undefined,
      body: body ? JSON.stringify(body) : undefined,
      signal: ctl.signal,
    }).then((r) => r.json().then((j) => {
      if (!r.ok) throw new Error(j.error || 'Server error ' + r.status);
      if (j.now) offset = j.now - Date.now();
      return j;
    }), (err) => {
      throw err.name === 'AbortError' ? new Error('no response from the server (check your connection)') : err;
    }).finally(() => clearTimeout(timer));
  }

  function load() {
    saving = saving.then(() => api('GET', '/api/state')).then((res) => {
      state = res.state || emptyState();
      logs = res.logs;
      programs = res.programs;
      rebuildCtx();
      render();
    }).catch(showError);
    return saving;
  }

  function rebuildCtx() {
    const entry = pickProgram(programs, state);
    ctx = entry ? { program: entry.program, logs, settings: getSettings(state) } : null;
  }

  function save() {
    saving = saving.then(() => api('PUT', '/api/state', { state })).catch(showError);
    return saving;
  }

  function showError(err) {
    console.error(err);
    const el = document.createElement('p');
    el.className = 'error';
    el.textContent = 'Problem talking to the server: ' + err.message;
    $app.prepend(el);
  }

  // In-page replacement for confirm()/prompt(). Phone browsers can silently block native dialogs
  // (after "don't show more dialogs"), which made buttons look dead. Resolves true/false, or with
  // { input } the entered string (null if cancelled).
  function ask(message, opts = {}) {
    return new Promise((resolve) => {
      const el = document.createElement('div');
      el.className = 'modal';
      el.innerHTML = '<form class="box"><p>' + esc(message) + '</p>' +
        (opts.input != null
          ? '<div class="field-row"><input type="text" inputmode="decimal" autocomplete="off" value="' + esc(opts.input) + '">' +
            (opts.sign ? '<button type="button" class="sign" data-msign>±</button>' : '') + '</div>'
          : '') +
        '<div class="btn-row"><button type="button" class="btn big" data-mno>' + esc(opts.no || 'Cancel') + '</button>' +
        '<button type="submit" class="btn big primary' + (opts.danger ? ' danger-fill' : '') + '">' + esc(opts.yes || 'OK') + '</button></div></form>';
      document.body.appendChild(el);
      const input = el.querySelector('input');
      const done = (v) => { el.remove(); resolve(v); };
      el.querySelector('form').addEventListener('submit', (e) => {
        e.preventDefault();
        done(input ? input.value : true);
      });
      el.querySelector('[data-mno]').addEventListener('click', () => done(input ? null : false));
      const sign = el.querySelector('[data-msign]');
      if (sign) sign.addEventListener('click', () => {
        const v = input.value.trim();
        input.value = v.startsWith('-') ? v.slice(1) : v ? '-' + v : '-';
        input.focus();
      });
      if (input) { input.focus(); input.select(); }
    });
  }

  const active = () => (state && ctx && state.active && state.active.program === ctx.program.id ? state.active : null);

  /* ---------- Rendering ---------- */

  function render() {
    if (!state) return;
    const route = location.hash.replace('#', '');
    if (!ctx && route !== 'settings') renderNoProgram();
    else if (route === 'session' && active()) renderSession();
    else if (route === 'history') renderHistory();
    else if (route.startsWith('log/')) renderLog(decodeURIComponent(route.slice(4)));
    else if (route.startsWith('workout/')) renderWorkout(decodeURIComponent(route.slice(8)));
    else if (route === 'settings') renderSettings();
    else renderHome();
    updateRest();
    updateWakeLock();
  }

  function programErrors() {
    const bad = programs.filter((p) => p.error);
    return bad.map((p) => '<p class="error">' + esc(p.file) + ': ' + esc(p.error) + '</p>').join('');
  }

  function renderNoProgram() {
    $app.innerHTML = '<header class="top"><h1>Lifting</h1></header>' + programErrors() +
      '<section class="card"><h2>No program loaded</h2><p class="focus">Put an OpenLifting program (.yaml) in the <code>programs/</code> folder and refresh.</p></section>';
  }

  function weightHTML(f) {
    return esc(f.main) + (f.sub ? '<small>' + esc(f.sub) + '</small>' : '');
  }

  // Top weights for a workout you haven't started, from your logs.
  // Suggested working weight for one exercise, as preview HTML.
  function previewWeight(def) {
    const sug = suggestTW(ctx, def);
    const of = def.sets.filter((s) => s.load.of)[0];
    if (of) {
      const base = lastTop(ctx, of.load.of);
      return base ? fmtNum(roundLoad(ctx, def.exercise, base.weight * of.load.value / 100, false)) + '<small>' + of.load.value + '% of ' + esc(exerciseName(ctx, of.load.of)) + '</small>' : '<small>set on start</small>';
    }
    if (!usesTW(def)) {
      const s = def.sets.filter((x) => x.kind !== 'warmup')[0];
      return s.load.type === 'absolute' ? fmtNum(s.load.value) : 'BW';
    }
    if (sug.tw == null) return '<small>set on start</small>';
    const top = def.sets.filter((s) => s.kind === 'top' || s.kind === 'work')[0];
    const pl = platesFor(ctx, top, def.exercise, sug.tw);
    return weightHTML(fmtWeight(ctx, top, def.exercise, sug.tw)) + (pl && pl.list.length ? '<span class="pt">' + esc(platesText(pl)) + '</span>' : '');
  }

  function workoutPreview(w) {
    let html = '<ul class="preview">';
    w.blocks.forEach((b) => {
      OL.members(b).forEach((def) => {
        html += '<li><span>' + esc(def.label || exerciseName(ctx, def.exercise)) + '</span><span class="w num">' + previewWeight(def) + '</span></li>';
      });
    });
    return html + '</ul>';
  }

  // How a planned set is loaded, in words ("90%", "−10", "light").
  function loadText(load) {
    switch (load.type) {
      case 'tw': return 'top-set weight';
      case 'percent': return load.value + '%' + (load.of ? ' of ' + exerciseName(ctx, load.of) : '');
      case 'relative': return (load.delta > 0 ? '+' : '−') + fmtNum(Math.abs(load.delta));
      case 'absolute': return fmtNum(load.value);
      case 'bar': return 'empty bar';
      case 'light': return 'light';
      case 'bodyweight': return load.plus === 'tw' ? 'BW + top-set weight' : load.plus ? 'BW+' + fmtNum(load.plus.value) : 'BW';
      case 'inherit': return 'same weight';
      default: return '';
    }
  }

  // A workout before you start it: every exercise and planned set, then an explicit Start button.
  function renderWorkout(id) {
    const w = ctx.program.workouts.find((x) => x.id === id);
    const head = '<header class="top"><a class="btn ghost" href="#">‹ Home</a>';
    if (!w) {
      $app.innerHTML = head + '<h1>Not found</h1><span></span></header><p class="loading">No workout called ' + esc(id) + '.</p>';
      return;
    }
    const parts = w.name.split(' — ');
    let html = head + '<div class="title"><h1>' + esc(parts[0]) + '</h1><div>' + esc(parts[1] || '') + '</div></div><span></span></header>';
    if (w.id === nextWorkoutId(ctx)) html += '<div class="eyebrow">Up next</div>';
    if (w.prep) html += '<p class="focus">Prep: ' + esc(w.prep) + '</p>';
    if (w.notes) html += '<p class="focus">' + esc(w.notes) + '</p>';
    w.blocks.forEach((b) => {
      html += '<section class="card block">';
      if (b.type === 'superset') html += '<div class="eyebrow">Superset</div>' + (b.notes ? '<div class="note">' + esc(b.notes) + '</div>' : '');
      OL.members(b).forEach((def) => {
        html += '<div class="plan-ex"><div class="plan-head"><h3>' + esc(def.label || exerciseName(ctx, def.exercise)) + '</h3>' +
          '<span class="w num">' + previewWeight(def) + '</span></div>' +
          (def.notes ? '<div class="note">' + esc(def.notes) + '</div>' : '');
        const total = {}, seen = {};
        def.sets.forEach((x) => { total[x.kind] = (total[x.kind] || 0) + 1; });
        def.sets.forEach((x) => {
          seen[x.kind] = (seen[x.kind] || 0) + 1;
          const label = (KIND_LABEL[x.kind] || x.kind) + (total[x.kind] > 1 ? ' ' + seen[x.kind] : '');
          html += '<div class="logset' + (x.kind === 'warmup' ? ' warm' : '') + '"><span class="lbl">' + esc(label) +
            (x.optional ? ' <span class="tag">optional</span>' : '') + (x.note ? '<small>' + esc(x.note) + '</small>' : '') + '</span>' +
            '<span class="w num">' + esc(loadText(x.load)) + '</span><span class="r num">× ' + esc(fmtReps(x.reps)) + '</span></div>';
        });
        if (def.fallback) html += '<div class="note">Fallback: ' + esc(def.fallback.when) + '</div>';
        html += '</div>';
      });
      html += '</section>';
    });
    html += '<div class="start-bar"><button class="btn primary big" data-start="' + esc(w.id) + '">Start workout</button></div>';
    $app.innerHTML = html;
  }

  function renderHome() {
    const se = active();
    const p = ctx.program;
    const next = getWorkout(p, nextWorkoutId(ctx));
    let html = '<header class="top"><div class="title"><h1>Lifting</h1><div>' + esc(p.name) + '</div></div>' +
      '<a class="btn ghost" href="#settings">Settings</a></header>' + programErrors();

    if (se) {
      const w = getWorkout(p, se.workout);
      const done = se.steps.filter((s) => s.done || s.skipped).length;
      html += '<section class="card resume"><div class="eyebrow">In progress</div><h2>' + esc(w.name) + '</h2>' +
        '<div class="focus">' + done + ' of ' + se.steps.length + ' sets</div>' +
        '<div class="btn-row"><a class="btn primary big" href="#session">Resume workout</a>' +
        '<button class="btn big danger" data-cancel>Cancel workout</button></div></section>';
    } else {
      html += '<section class="card"><div class="eyebrow">Up next</div><h2>' + esc(next.name) + '</h2>' +
        (next.prep ? '<div class="focus">Prep: ' + esc(next.prep) + '</div>' : '') + workoutPreview(next) +
        '<button class="btn primary big" data-start="' + esc(next.id) + '">Start workout</button></section>';
    }

    html += '<h3 class="section-title">' + (se ? 'Start a different workout' : 'Or pick a workout') + '</h3><div class="picker">';
    p.workouts.forEach((w) => {
      const parts = w.name.split(' — ');
      html += '<a href="#workout/' + encodeURIComponent(w.id) + '" class="' + (w.id === next.id ? 'next' : '') + '"><b>' +
        esc(parts[0]) + '</b><span>' + esc(parts[1] || '') + '</span></a>';
    });
    html += '</div>';

    if (logs.length) {
      html += '<h3 class="section-title">Recent</h3>' + historyList(logs.slice(-5).reverse());
      if (logs.length > 5) html += '<a href="#history">All history →</a>';
    }

    html += '<div class="links"><a class="btn" href="/tv" target="_blank">Open TV view</a>' +
      '<a class="btn" href="#history">History</a></div>' +
      '<p class="tv-hint">On your TV’s browser, open <code>' + esc(location.origin) + '/tv</code>. It follows this phone live.</p>';
    $app.innerHTML = html;
  }

  function historyList(list) {
    let html = '<ul class="history">';
    list.forEach((log) => {
      const tops = logHighlights(ctx, log).map((h) => esc(h.name) + ' <b class="num">' + esc(h.text) + '</b>');
      html += '<li><a href="#log/' + encodeURIComponent(log.id) + '"><div class="head"><b>' + esc(logTitle(log)) + '</b><span class="date">' +
        esc(logDate(log)) + ' ›</span></div>' +
        '<div class="tops">' + (tops.join(' · ') || 'No top sets logged') + '</div></a></li>';
    });
    return html + '</ul>';
  }

  function logTitle(log) {
    const w = ctx && log.program === ctx.program.id ? getWorkout(ctx.program, log.workout) : null;
    return w ? w.name : log.workout;
  }

  function logDate(log, long) {
    const date = new Date(log.started);
    return isNaN(date) ? String(log.started) : date.toLocaleDateString(undefined, long
      ? { weekday: 'long', month: 'long', day: 'numeric', year: 'numeric' }
      : { weekday: 'short', month: 'short', day: 'numeric' });
  }

  function renderHistory() {
    $app.innerHTML = '<header class="top"><a class="btn ghost" href="#">‹ Home</a><h1>History</h1><span></span></header>' +
      (logs.length ? historyList(logs.slice().reverse()) : '<p class="loading">Nothing logged yet.</p>') +
      '<p class="tv-hint">Each workout is saved as an OpenLifting log in <code>data/logs/</code> on the server.</p>';
  }

  const KIND_LABEL = { warmup: 'Warm-up', top: 'Top set', work: 'Set', backoff: 'Back-off', drop: 'Drop', restpause: 'Rest-pause' };

  // One finished workout, every set.
  function renderLog(id) {
    const log = logs.find((l) => l.id === id);
    const back = '<header class="top"><a class="btn ghost" href="#history">‹ History</a>';
    if (!log) {
      $app.innerHTML = back + '<h1>Not found</h1><span></span></header><p class="loading">That workout log is gone.</p>';
      return;
    }
    const started = new Date(log.started), finished = new Date(log.finished);
    const mins = Math.round((finished - started) / 60000);
    const units = log.units || (ctx && ctx.program.units) || '';
    let html = back + '<div class="title"><h1>' + esc(logTitle(log)) + '</h1><div>' + esc(logDate(log, true)) +
      (isNaN(started) ? '' : ' · ' + esc(started.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' }))) +
      (mins > 0 ? ' · ' + mins + ' min' : '') + '</div></div><span></span></header>';

    (log.entries || []).forEach((e) => {
      const sets = (e.sets || []).map(logSet);
      // Number repeated kinds: "Drop 1", "Drop 2".
      const total = {}, seen = {};
      sets.forEach((x) => { total[x.kind] = (total[x.kind] || 0) + 1; });
      const tags = [];
      if (e.option) tags.push(esc(e.option));
      if (e.tw != null) tags.push('Top-set weight ' + esc(typeof e.tw === 'number' && sets.some((x) => x.bw) ? bwLabel(e.tw, '−') : fmtNum(e.tw) + ' ' + units));
      if (e['x-fallback']) tags.push('fallback sets');
      if (e['x-progress'] === 'none') tags.push('light day');
      html += '<section class="card block"><h3>' + esc(ctx ? exerciseName(ctx, e.exercise) : e.exercise) + '</h3>' +
        (tags.length ? '<div class="note">' + tags.join(' · ') + '</div>' : '') + '<div class="sets">';
      sets.forEach((x) => {
        seen[x.kind] = (seen[x.kind] || 0) + 1;
        const label = (KIND_LABEL[x.kind] || x.kind) + (total[x.kind] > 1 ? ' ' + seen[x.kind] : '');
        const w = x.bw ? bwLabel(x.weight, '−') : x.weight != null ? fmtNum(x.weight) + ' ' + units : x.kind === 'warmup' ? 'light' : '—';
        html += '<div class="logset' + (x.skipped ? ' skipped' : '') + (x.kind === 'warmup' ? ' warm' : '') + '">' +
          '<span class="lbl">' + esc(label) + '</span><span class="w num">' + esc(w) + '</span>' +
          '<span class="r num">' + (x.skipped ? 'skipped' : '× ' + x.reps) + '</span></div>';
      });
      html += '</div></section>';
    });
    if (!(log.entries || []).length) html += '<p class="loading">No sets in this log.</p>';
    html += '<button class="btn danger" data-del="' + esc(log.id) + '">Delete this workout</button>' +
      '<p class="tv-hint">Saved as <code>data/logs/' + esc(log.id) + '.yaml</code></p>';
    $app.innerHTML = html;
  }

  function renderSettings() {
    const s = getSettings(state);
    const ok = programs.filter((p) => p.program);
    const cur = pickProgram(programs, state);
    let html = '<header class="top"><a class="btn ghost" href="#">‹ Home</a><h1>Settings</h1><span></span></header>' + programErrors() +
      '<section class="card">';
    if (ok.length > 1) {
      html += '<div class="field"><label>Program<small>From the programs/ folder</small></label><select data-setting="program">' +
        ok.map((p) => '<option value="' + esc(p.file) + '"' + (cur && cur.file === p.file ? ' selected' : '') + '>' + esc(p.program.name) + '</option>').join('') +
        '</select></div>';
    } else if (cur) {
      html += '<div class="field"><label>Program<small>' + esc(cur.file) + '</small></label><span>' + esc(cur.program.name) + '</span></div>';
    }
    html += '<div class="field"><label>Plates you have<small>Per plate, comma separated. Plates under 5 count as one per side.</small></label>' +
      '<input type="text" data-setting="plates" value="' + esc(s.plates.join(', ')) + '"></div>' +
      '<div class="field"><label>Dumbbells<small>2.5 lb steps up to this weight, then 5 lb steps</small></label>' +
      '<input type="number" inputmode="decimal" data-setting="dumbbellFineUpTo" value="' + esc(s.dumbbellFineUpTo) + '"></div>' +
      '</section><p class="tv-hint">Top-set weights go up by the smallest jump you can load (at least the program’s step, +2.5 lb) when you hit the top of the rep range. Bar weights and steps come from the program file.</p>';
    $app.innerHTML = html;
  }

  function renderSession() {
    const se = active();
    const p = ctx.program;
    const w = getWorkout(p, se.workout);
    const weights = weightsFor(ctx, se);
    const plan = platePlan(ctx, se, weights);
    const cur = currentIndex(se);
    const done = se.steps.filter((x) => x.done || x.skipped).length;

    let html = '<header class="top"><a class="btn ghost" href="#">‹</a><div class="title"><h1>' + esc(w.name) + '</h1>' +
      '<div>' + done + '/' + se.steps.length + ' sets' + (w.prep ? ' · Prep: ' + esc(w.prep) : '') + '</div></div>' +
      '<button class="btn" data-finish>Finish</button></header>' +
      '<div class="progress"><div style="width:' + (100 * done / se.steps.length) + '%"></div></div>';

    w.blocks.forEach((b, bi) => {
      const ms = OL.members(b);
      const base = se.members.findIndex((m) => m.block === bi);
      const started = blockStarted(se, bi);
      html += '<section class="card block"><h3>' + esc(blockTitle(ctx, b)) + '</h3>' +
        (b.notes ? '<div class="note">' + esc(b.notes) + '</div>' : '');

      ms.forEach((def, k) => {
        const mi = base + k;
        const mem = se.members[mi];
        const ex = p.exercises[def.exercise];
        const name = ms.length > 1 ? '<b>' + esc(def.label || ex.name) + '</b>' : '';
        let row = '';
        if (ex.options.length) {
          row += '<div class="opt">' + ex.options.map((o) =>
            '<button class="chip' + (mem.option === o ? ' on' : '') + '" data-opt="' + mi + '" data-val="' + esc(o) + '">' + esc(o) + '</button>').join('') + '</div>';
        }
        if (usesTW(def) && !mem.fallback) {
          const sug = suggestTW(ctx, def);
          const bw = ex.equipment === 'weighted-bodyweight';
          row += '<label>' + name + (bw ? 'Added weight<small>0 = BW · negative = band assist</small>' : 'Top-set weight') + (ex.equipment === 'dumbbell' ? ' · per dumbbell' : '') + '</label>' +
            // Phone number pads have no minus key, so bodyweight lifts get a ± button.
            (bw ? '<button class="sign" data-sign="' + mi + '" aria-label="Flip between added weight and band assist">±</button>' : '') +
            '<input type="number" inputmode="decimal" step="any" data-tw="' + mi + '" value="' + (mem.tw == null ? '' : mem.tw) + '" placeholder="' + esc(p.units) + '">' +
            (sug.why ? '<div class="hint' + (sug.up ? ' up' : '') + '">' + esc(sug.why) + '</div>' : '');
        } else {
          const of = def.sets.filter((s) => s.load.of)[0];
          if (of) {
            const baseTop = lastTop(ctx, of.load.of);
            row += '<label>' + name + of.load.value + '% of your last ' + esc(exerciseName(ctx, of.load.of).toLowerCase()) + ' top set</label>' +
              '<div class="hint">' + (baseTop ? 'Last top set: ' + fmtNum(baseTop.weight) + ' × ' + baseTop.reps : 'None logged yet. Tap a weight below to set it.') + '</div>';
          } else if (name && row) {
            row = '<label>' + name + '</label>' + row;
          }
        }
        if (def.fallback && !started) {
          row += '<button class="btn ghost fallback" data-fallback="' + mi + '">' +
            (mem.fallback ? 'Back to the normal sets' : esc(def.fallback.when) + '?') + '</button>';
        } else if (mem.fallback) {
          row += '<div class="hint">Using the fallback: ' + esc(def.fallback.when) + '</div>';
        }
        if (row) html += '<div class="tw">' + row + '</div>';
      });

      html += '<div class="sets">';
      se.steps.forEach((st, i) => {
        if (st.block !== bi) return;
        const mem = se.members[st.m];
        const f = fmtWeight(ctx, st, mem.exercise, weights[i]);
        const skippable = !st.done && !st.skipped && canSkip(se, st);
        const cls = ['set', st.kind, st.done ? 'done' : '', st.skipped ? 'skipped' : '', i === cur ? 'cur' : ''].join(' ');
        html += '<div class="' + cls + '" id="set-' + i + '">' +
          '<div class="lbl">' + (ms.length > 1 ? '<span class="ex">' + esc(shortName(ctx, mem.exercise)) + '</span>' : '') +
          esc(st.label) + (st.optional ? ' <span class="tag">optional</span>' : '') +
          (st.note ? '<small>' + esc(st.note) + '</small>' : '') +
          (st.skipped ? '<small>Skipped</small>' : '') +
          (skippable ? '<button class="skip" data-skip="' + i + '">Skip</button>' : '') + '</div>' +
          '<button class="wt' + (st.w != null && !st.done ? ' override' : '') + '" data-wt="' + i + '">' + weightHTML(f) + '</button>' +
          '<input class="reps" type="number" inputmode="numeric" data-reps="' + i + '" placeholder="' +
            esc(st.reps === 'amrap' ? 'max' : fmtReps(st.reps)) + '" value="' + (st.r == null ? '' : st.r) + '"' + (st.skipped ? ' disabled' : '') + '>' +
          '<button class="chk" data-chk="' + i + '" aria-label="Done">' + (st.skipped ? '–' : '✓') + '</button>';
        if (i === cur && plan[i]) {
          const pl = plan[i];
          const change = changeText(pl);
          html += '<div class="platerow">' + platesHTML(pl) + '<span>' + esc(platesText(pl)) +
            (change ? '<b class="change">' + esc(change) + '</b>' : '') + '</span></div>';
        }
        html += '</div>';
      });
      html += '</div></section>';
    });

    if (cur === -1) {
      html += '<section class="card finish-card"><h2>All sets done 💪</h2><p>Nice work.</p>' +
        '<button class="btn primary big" data-finish>Finish workout</button></section>';
    }
    $app.innerHTML = html;
  }

  /* ---------- Rest timer ---------- */

  function updateRest() {
    const se = active();
    const left = (state.restEndsAt - now()) / 1000;
    // Show briefly past zero so you notice it ended, then hide.
    if (!state.restEndsAt || !se || location.hash !== '#session' || left < -60) {
      $rest.hidden = true;
      return;
    }
    if (left <= 0 && !restBuzzed) {
      restBuzzed = true;
      if (navigator.vibrate) navigator.vibrate([200, 100, 200]);
    }
    const cur = currentIndex(se);
    const next = cur >= 0 ? se.steps[cur] : null;
    let nextText = 'Rest';
    if (next) {
      const ex = se.members[next.m].exercise;
      const f = fmtWeight(ctx, next, ex, weightsFor(ctx, se)[cur]);
      nextText = 'Next: <b>' + esc(stepName(ctx, se, next)) + ' · ' + esc(next.label) + '</b>' +
        esc(f.main + (f.sub ? ' ' + f.sub : '') + ' × ' + fmtReps(next.reps));
    }
    const pct = state.restTotal ? Math.max(0, Math.min(1, left / state.restTotal)) : 0;
    // Rest ranges like 3-5m time the low end and mention the high end.
    const maxText = state.restMax > state.restTotal ? 'Up to ' + fmtClock(state.restMax) : '';
    $rest.hidden = false;
    $rest.className = 'rest' + (left <= 0 ? ' over' : '');
    $rest.innerHTML = '<div class="bar" style="width:' + (pct * 100) + '%"></div><div class="inner">' +
      '<div class="time">' + (left > 0 ? fmtClock(left) : 'Go!') + '</div>' +
      '<div class="label">' + nextText + (maxText ? '<span class="max">' + maxText + '</span>' : '') + '</div>' +
      '<button class="btn" data-rest="30">+30s</button><button class="btn" data-rest="skip">Skip</button></div>';
  }
  setInterval(() => { if (state) updateRest(); }, 250);

  /* ---------- Wake lock (keep phone screen on mid-workout) ---------- */

  function updateWakeLock() {
    const want = location.hash === '#session' && document.visibilityState === 'visible';
    if (want && !wakeLock && navigator.wakeLock) {
      navigator.wakeLock.request('screen').then((l) => {
        wakeLock = l;
        l.addEventListener('release', () => { wakeLock = null; });
      }).catch(() => {});
    } else if (!want && wakeLock) {
      wakeLock.release();
    }
  }

  /* ---------- Actions ---------- */

  function start(workoutId) {
    const se = active();
    if (!se) return begin(workoutId);
    ask('You have a workout in progress. Abandon it and start this one?', { yes: 'Start new' }).then((ok) => {
      if (!ok) return;
      // Keep what you did.
      if (se.steps.some((s) => s.done)) finishSession(se).then(() => begin(workoutId), () => {});
      else begin(workoutId);
    });
  }

  function begin(workoutId) {
    state.active = newSession(ctx, workoutId);
    state.restEndsAt = 0;
    save();
    location.hash = 'session';
    render();
  }

  // Write the log file, then clear the session. If the log can't be saved, the session stays.
  function finishSession(se) {
    const log = buildLog(ctx, se, now());
    const write = log.entries.length ? api('POST', '/api/logs', { log }) : Promise.resolve(null);
    return write.then((res) => {
      if (res) logs.push(Object.assign({ id: res.id }, log));
      state.active = null;
      state.restEndsAt = 0;
      return save();
    }).catch((err) => {
      // Leave the session in place and the error on screen (callers don't re-render on failure).
      showError(err);
      throw err;
    });
  }

  function finish() {
    const se = active();
    const sure = currentIndex(se) === -1 ? Promise.resolve(true)
      : ask('Finish now? Sets you haven’t checked off will be logged as 0 reps.', { yes: 'Finish' });
    sure.then((ok) => {
      if (!ok || finishing) return;
      finishing = true;
      document.querySelectorAll('[data-finish]').forEach((b) => { b.disabled = true; b.dataset.txt = b.textContent; b.textContent = 'Saving…'; });
      finishSession(se).then(() => {
        finishing = false;
        location.hash = '';
        render();
      }, () => {
        // Keep the error on screen; let them try again.
        finishing = false;
        document.querySelectorAll('[data-finish]').forEach((b) => { b.disabled = false; b.textContent = b.dataset.txt; });
      });
    });
  }

  // Throw the workout away without logging anything.
  function cancel() {
    ask('Cancel this workout? Nothing from it will be logged.', { yes: 'Discard', no: 'Keep', danger: true }).then((ok) => {
      if (!ok) return;
      state.active = null;
      state.restEndsAt = 0;
      save();
      location.hash = '';
      render();
    });
  }

  function startRest(se, st) {
    if (st.restSec && currentIndex(se) !== -1) {
      state.restEndsAt = now() + st.restSec.min * 1000;
      state.restTotal = st.restSec.min;
      state.restMax = st.restSec.max;
      restBuzzed = false;
    } else if (!inSuperset(ctx, se, st) || currentIndex(se) === -1) {
      // In a superset, a set without its own rest leaves the other exercise's timer running.
      state.restEndsAt = 0;
    }
  }

  function toggleSet(i) {
    const se = active();
    const st = se.steps[i];
    if (st.done || st.skipped) {
      st.done = false;
      st.skipped = false;
      delete st.dw;
      save();
      render();
      return;
    }
    const input = document.querySelector('[data-reps="' + i + '"]');
    let reps = input && input.value !== '' ? Number(input.value) : null;
    if (reps == null) {
      // Exact reps and warm-ups can be checked off without typing; ranges, AMRAP and "any" need a number.
      if (typeof st.reps === 'object' && (st.reps.min === st.reps.max || st.kind === 'warmup')) reps = st.reps.min;
      else {
        input.classList.add('need');
        input.focus();
        return;
      }
    }
    st.r = reps;
    st.dw = weightsFor(ctx, se)[i];
    st.done = true;
    startRest(se, st);
    save();
    render();
    scrollToCurrent(se);
  }

  function skipSet(i) {
    const se = active();
    se.steps[i].skipped = true;
    save();
    render();
    scrollToCurrent(se);
  }

  function scrollToCurrent(se) {
    const cur = currentIndex(se);
    const el = cur >= 0 && document.getElementById('set-' + cur);
    if (el) el.scrollIntoView({ behavior: 'smooth', block: 'center' });
  }

  function overrideWeight(i) {
    const se = active();
    const st = se.steps[i];
    if (st.done) return;
    const current = weightsFor(ctx, se)[i];
    const bw = isBW(ctx, st, se.members[st.m].exercise);
    ask((bw ? 'Added weight (negative = band assist)' : 'Weight') + ' for ' + st.label + ' (' + ctx.program.units + '). Leave blank to use the calculated weight.',
      { input: current == null ? '' : String(current), sign: bw, yes: 'Set' }).then((val) => {
      if (val === null) return;
      const n = Number(val);
      if (val.trim() !== '' && !isFinite(n)) return;
      st.w = val.trim() === '' ? null : n;
      save();
      render();
    });
  }

  $app.addEventListener('click', (e) => {
    const t = e.target.closest('[data-start],[data-chk],[data-wt],[data-finish],[data-cancel],[data-del],[data-skip],[data-opt],[data-fallback],[data-sign]');
    if (!t) return;
    const d = t.dataset;
    if (d.start) start(d.start);
    else if (d.chk) toggleSet(Number(d.chk));
    else if (d.skip) skipSet(Number(d.skip));
    else if (d.wt) overrideWeight(Number(d.wt));
    else if ('finish' in d) finish();
    else if ('cancel' in d) cancel();
    else if (d.sign) {
      const mem = active().members[Number(d.sign)];
      if (mem.tw) {
        mem.tw = -mem.tw;
        save();
        render();
      }
    }
    else if (d.opt) {
      active().members[Number(d.opt)].option = d.val;
      save();
      render();
    } else if (d.fallback) {
      const se = active();
      const mi = Number(d.fallback);
      setFallback(ctx, se, mi, !se.members[mi].fallback);
      save();
      render();
    } else if (d.del) {
      ask('Delete this workout log?', { yes: 'Delete', danger: true }).then((ok) => {
        if (!ok) return;
        return api('DELETE', '/api/logs/' + encodeURIComponent(d.del)).then(() => {
          logs = logs.filter((l) => l.id !== d.del);
          rebuildCtx();
          location.hash = 'history';
          render();
        });
      }).catch(showError);
    }
  });

  $rest.addEventListener('click', (e) => {
    const t = e.target.closest('[data-rest]');
    if (!t) return;
    if (t.dataset.rest === 'skip') state.restEndsAt = 0;
    else {
      state.restEndsAt = Math.max(state.restEndsAt, now()) + 30000;
      state.restTotal += 30;
      restBuzzed = false;
    }
    save();
    updateRest();
  });

  $app.addEventListener('change', (e) => {
    const t = e.target;
    const se = active();
    if (t.dataset.tw && se) {
      se.members[Number(t.dataset.tw)].tw = t.value === '' ? null : Number(t.value);
      save();
      render();
    } else if (t.dataset.reps && se) {
      se.steps[Number(t.dataset.reps)].r = t.value === '' ? null : Number(t.value);
      save();
    } else if (t.dataset.setting) {
      state.settings = state.settings || {};
      if (t.dataset.setting === 'plates') {
        const plates = t.value.split(/[ ,]+/).map(Number).filter((n) => n > 0);
        if (plates.length) state.settings.plates = plates;
      } else {
        state.settings[t.dataset.setting] = t.value;
      }
      rebuildCtx();
      save();
      render();
    }
  });

  $app.addEventListener('input', (e) => {
    if (e.target.classList.contains('need')) e.target.classList.remove('need');
  });

  window.addEventListener('hashchange', () => {
    render();
    if (/^#(log|workout)\//.test(location.hash)) window.scrollTo(0, 0);
  });
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') load();
    else updateWakeLock();
  });

  load();
})();
