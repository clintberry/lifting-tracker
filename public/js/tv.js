/*
 * TV view: read-only, follows whatever the phone is doing by polling the server.
 * ES5 so it runs on older smart-TV browsers.
 */
(function () {
  var $tv = document.getElementById('tv');
  var state = null;
  var ctx = null;
  var programs = [];
  var rev = '';
  var offset = 0;
  var online = true;

  function now() { return Date.now() + offset; }

  function poll() {
    var xhr = new XMLHttpRequest();
    xhr.open('GET', '/api/state?rev=' + encodeURIComponent(rev));
    xhr.timeout = 8000;
    xhr.onload = function () {
      var changed = !online;
      online = xhr.status === 200;
      if (online) {
        var res = JSON.parse(xhr.responseText);
        offset = res.now - Date.now();
        if (!res.unchanged) {
          rev = res.rev;
          state = res.state || emptyState();
          programs = res.programs;
          var entry = pickProgram(programs, state);
          ctx = entry ? { program: entry.program, logs: res.logs, settings: getSettings(state) } : null;
          changed = true;
        }
      }
      if (changed) render();
      setTimeout(poll, 1500);
    };
    xhr.onerror = xhr.ontimeout = function () {
      if (online) { online = false; render(); }
      setTimeout(poll, 3000);
    };
    xhr.send();
  }

  function header(title) {
    return '<div class="tv-top"><div>' + title + (online ? '' : '<span class="offline">● offline</span>') + '</div>' +
      '<div class="clock num" id="clock"></div></div>';
  }

  function render() {
    if (!state) {
      $tv.innerHTML = '<div class="waiting">' + (online ? 'Connecting…' : 'Can’t reach the server') + '</div>';
      return;
    }
    if (!ctx) {
      $tv.innerHTML = '<div class="waiting">No program loaded</div>';
      return;
    }
    var se = state.active && state.active.program === ctx.program.id ? state.active : null;
    if (se) renderSession(se);
    else renderOverview();
    tick();
  }

  function renderOverview() {
    var w = getWorkout(ctx.program, nextWorkoutId(ctx));
    var parts = w.name.split(' — ');
    var html = header('<b>' + esc(ctx.program.name) + '</b>') + '<div class="overview"><div class="eyebrow">Up next</div>' +
      '<h1>' + esc(parts[0]) + '</h1><div class="focus">' + esc(parts[1] || '') + (w.prep ? ' · Prep: ' + esc(w.prep) : '') + '</div><div class="grid">';
    w.blocks.forEach(function (b) {
      OL.members(b).forEach(function (def) {
        var main = '—', sub = 'set on phone', pt = '';
        var top = def.sets.filter(function (s) { return s.kind === 'top' || s.kind === 'work'; })[0] || def.sets[0];
        var of = def.sets.filter(function (s) { return s.load.of; })[0];
        var tw = null;
        if (of) {
          var base = lastTop(ctx, of.load.of);
          if (base) tw = roundLoad(ctx, def.exercise, base.weight * of.load.value / 100, false);
        } else if (usesTW(def)) {
          tw = suggestTW(ctx, def).tw;
        } else {
          tw = top.load.type === 'absolute' ? top.load.value : 0;
        }
        if (tw != null) {
          var f = fmtWeight(ctx, top, def.exercise, tw);
          main = f.main;
          sub = f.sub;
          pt = platesText(platesFor(ctx, top, def.exercise, tw));
        }
        html += '<div class="ex"><div class="name">' + esc(def.label || exerciseName(ctx, def.exercise)) + '</div>' +
          '<div class="w num">' + esc(main) + (sub ? '<small>' + esc(sub) + '</small>' : '') + '</div>' +
          '<div class="pt">' + esc(pt) + '</div></div>';
      });
    });
    html += '</div><div class="hint">Start the workout on your phone. This screen will follow along.</div></div>';
    $tv.innerHTML = html;
  }

  function renderSession(se) {
    var w = getWorkout(ctx.program, se.workout);
    var weights = weightsFor(ctx, se);
    var cur = currentIndex(se);
    var done = 0;
    se.steps.forEach(function (x) { if (x.done || x.skipped) done++; });

    var html = header('<b>' + esc(w.name) + '</b>');

    if (cur === -1) {
      $tv.innerHTML = html + '<div class="done-msg"><h1>All sets done 💪</h1><p>Finish the workout on your phone.</p></div>';
      return;
    }

    var st = se.steps[cur];
    var mem = se.members[st.m];
    var ex = mem.exercise;
    var block = w.blocks[st.block];
    var def = memberDef(ctx, se, st.m);
    var f = fmtWeight(ctx, st, ex, weights[cur]);
    var pl = platePlan(ctx, se, weights)[cur];
    var change = changeText(pl);
    var last = st.kind === 'top' ? lastTop(ctx, ex) : null;
    var title = (def.label || exerciseName(ctx, ex)) + (mem.option ? ' · ' + mem.option : '');
    var showBlock = block.type === 'superset';
    var reps = fmtReps(st.reps);

    html += '<div class="tv-main"><section class="now">' +
      (showBlock ? '<div class="block">' + esc(blockTitle(ctx, block)) + '</div>' : '') +
      '<h1>' + esc(title) + '</h1>' +
      '<div class="setline"><b>' + esc(st.label) + '</b> · ' +
        esc(st.reps === 'amrap' ? 'as many reps as possible' : st.reps === 'any' ? 'your call on reps' : reps + ' reps') +
        (st.optional ? ' · optional' : '') + '</div>' +
      (weights[cur] == null && st.load.type !== 'light'
        ? '<div class="sub">Enter a weight on your phone</div>'
        : '<div class="weight num">' + esc(f.main) +
          (/^\d/.test(f.main) ? '<span class="unit">' + esc(ctx.program.units) + '</span>' : '') +
          '<span class="reps">× ' + esc(st.reps === 'amrap' ? 'max' : reps) + '</span></div>' +
          (f.sub ? '<div class="sub">' + esc(f.sub) + '</div>' : '')) +
      (pl && pl.list.length ? '<div class="plate-wrap">' + platesHTML(pl) + '<div class="plate-text">' + esc(platesText(pl)) +
        (change ? '<div class="change">' + esc(change) + '</div>' : '') + '</div></div>' : '') +
      (st.note || block.notes ? '<div class="note">' + esc(st.note || block.notes) + '</div>' : '') +
      (last ? '<div class="last">Last time: ' + esc(last.bw ? bwLabel(last.weight, '−') : fmtNum(last.weight)) + ' × ' + last.reps + '</div>' : '') +
      '</section><aside class="side">' +
      '<div class="rest" id="rest" style="display:none"><div class="lbl">Rest</div><div class="time num" id="rest-time"></div><div class="rest-max" id="rest-max"></div><div class="track" id="rest-track"></div></div>' +
      '<div><div class="progress-line">Set ' + (done + 1) + ' of ' + se.steps.length + '</div>' +
      '<div class="progress-bar"><div style="width:' + (100 * done / se.steps.length) + '%"></div></div></div>' +
      '<div class="upnext"><h2>Up next</h2><ol>';

    var shown = 0;
    for (var i = cur + 1; i < se.steps.length && shown < 6; i++) {
      var n = se.steps[i];
      if (n.done || n.skipped) continue;
      var nex = se.members[n.m].exercise;
      var nf = fmtWeight(ctx, n, nex, weights[i]);
      html += '<li><span class="n">' + esc(stepName(ctx, se, n)) + '<small>' + esc(n.label) + '</small></span>' +
        '<span class="w num">' + esc(nf.main) + ' × ' + esc(n.reps === 'amrap' ? 'max' : fmtReps(n.reps)) + '</span></li>';
      shown++;
    }
    if (!shown) html += '<li><span class="n">Last set!</span></li>';
    html += '</ol></div></aside></div>';
    $tv.innerHTML = html;
  }

  // Runs often: only touches the clock and rest timer.
  function tick() {
    var clock = document.getElementById('clock');
    if (clock) {
      var d = new Date();
      var h = d.getHours() % 12 || 12, m = d.getMinutes();
      clock.textContent = h + ':' + (m < 10 ? '0' : '') + m;
    }
    var rest = document.getElementById('rest');
    if (!rest || !state) return;
    var left = (state.restEndsAt - now()) / 1000;
    if (!state.restEndsAt || left < -60) {
      rest.style.display = 'none';
      return;
    }
    rest.style.display = '';
    rest.className = 'rest' + (left <= 0 ? ' over' : '');
    document.getElementById('rest-time').textContent = left > 0 ? fmtClock(left) : 'Go!';
    document.getElementById('rest-max').textContent = state.restMax > state.restTotal ? 'Up to ' + fmtClock(state.restMax) : '';
    var pct = state.restTotal ? Math.max(0, Math.min(1, left / state.restTotal)) : 0;
    document.getElementById('rest-track').style.width = (pct * 100) + '%';
  }

  setInterval(tick, 250);
  poll();
})();
