/*
 * OpenLifting v1 loader (https://github.com/clintberry/openlifting-spec).
 *
 * normalizeProgram(raw) turns a parsed YAML program into the spec's "parsed model".
 * expandBlock(program, block, opts) turns one block into the ordered steps a lifter performs:
 * `sets: N` expanded, supersets put in turn order by cluster, and the §4 rest rules applied.
 *
 * Shared by the server (Node) and both browser views, so it's ES5 with no dependencies.
 */
(function (root) {
  var KINDS = ['warmup', 'top', 'work', 'backoff', 'drop', 'restpause'];
  var EQUIPMENT = ['barbell', 'dumbbell', 'cable', 'machine', 'bodyweight', 'weighted-bodyweight', 'plate', 'other'];

  /* ---------- Scalars ---------- */

  function parseRange(str, what) {
    var m = String(str).trim().match(/^(\d+(?:\.\d+)?)(?:\s*-\s*(\d+(?:\.\d+)?))?$/);
    if (!m) throw new Error('Bad ' + what + ': "' + str + '"');
    var min = Number(m[1]);
    return { min: min, max: m[2] ? Number(m[2]) : min };
  }

  function parseReps(v) {
    if (typeof v === 'number') return { min: v, max: v };
    var s = String(v).trim().toLowerCase();
    if (s === 'amrap') return 'amrap';
    if (s === 'any') return 'any';
    return parseRange(s, 'reps');
  }

  // "90s", "3m", "1m30s" → seconds
  function parseDuration(str) {
    var s = String(str).trim(), m = s.match(/^(?:(\d+)m)?(?:(\d+)s)?$/);
    if (!m || (!m[1] && !m[2])) throw new Error('Bad duration: "' + str + '"');
    return Number(m[1] || 0) * 60 + Number(m[2] || 0);
  }

  // "3m", "3-5m", "20-30s", "1m30s", { min, max } → { min, max } seconds
  function parseRest(v) {
    if (v == null) return null;
    if (typeof v === 'object') return { min: parseDuration(v.min), max: parseDuration(v.max != null ? v.max : v.min) };
    var s = String(v).trim(), m = s.match(/^(\d+)\s*-\s*(\d+)\s*([ms])$/);
    if (m) {
      var mult = m[3] === 'm' ? 60 : 1;
      return { min: Number(m[1]) * mult, max: Number(m[2]) * mult };
    }
    var d = parseDuration(s);
    return { min: d, max: d };
  }

  // "5lb", "60kg", "45" → { value, unit }
  function parseAmount(v, units) {
    var m = String(v).trim().match(/^([+-]?\d+(?:\.\d+)?)\s*(lb|kg)?$/i);
    if (!m) return null;
    return { value: Number(m[1]), unit: (m[2] || units).toLowerCase() };
  }

  function parseLoad(v, units) {
    if (typeof v === 'number') return { type: 'absolute', value: v, unit: units };
    var s = String(v).trim(), low = s.toLowerCase(), m;
    if (low === 'tw') return { type: 'tw' };
    if (low === 'bar') return { type: 'bar' };
    if (low === 'light') return { type: 'light' };
    if (low === 'bw') return { type: 'bodyweight' };
    if ((m = s.match(/^bw\s*\+\s*(.+)$/i))) {
      if (m[1].trim().toLowerCase() === 'tw') return { type: 'bodyweight', plus: 'tw' };
      var plus = parseAmount(m[1], units);
      if (plus) return { type: 'bodyweight', plus: plus };
    }
    if ((m = s.match(/^(\d+(?:\.\d+)?)\s*%(?:\s+of\s+(\S+))?$/i))) {
      var p = { type: 'percent', value: Number(m[1]) };
      if (m[2]) p.of = m[2];
      return p;
    }
    if (/^[+-]/.test(s)) {
      var rel = parseAmount(s, units);
      if (rel) return { type: 'relative', delta: rel.value, unit: rel.unit };
    }
    var abs = parseAmount(s, units);
    if (abs) return { type: 'absolute', value: abs.value, unit: abs.unit };
    throw new Error('Bad weight: "' + s + '"');
  }

  // "+2.5-5lb", "+5lb", "none" → "none" | { add: Range, unit }
  function parseProgress(v, units) {
    if (v == null) return undefined;
    var s = String(v).trim();
    if (s.toLowerCase() === 'none') return 'none';
    var m = s.match(/^\+?\s*(\d+(?:\.\d+)?)(?:\s*-\s*(\d+(?:\.\d+)?))?\s*(lb|kg)?$/i);
    if (!m) throw new Error('Bad progress rule: "' + s + '"');
    return { add: { min: Number(m[1]), max: Number(m[2] || m[1]) }, unit: (m[3] || units).toLowerCase() };
  }

  function titleCase(id) {
    return String(id).split('-').map(function (w) { return w.charAt(0).toUpperCase() + w.slice(1); }).join(' ');
  }

  /* ---------- Program ---------- */

  var DEFAULT_LOAD = { top: { type: 'tw' }, work: { type: 'tw' }, backoff: { type: 'inherit' }, restpause: { type: 'inherit' } };

  function normalizeSet(raw, units, where) {
    var kinds = KINDS.filter(function (k) { return raw && raw[k] !== undefined; });
    if (kinds.length !== 1) throw new Error(where + ': each set needs exactly one of ' + KINDS.join(', '));
    var kind = kinds[0];
    var set = { kind: kind, reps: parseReps(raw[kind]) };
    if (raw.weight !== undefined) set.load = parseLoad(raw.weight, units);
    else if (DEFAULT_LOAD[kind]) set.load = DEFAULT_LOAD[kind];
    else throw new Error(where + ': ' + kind + ' sets need a weight');
    if (raw.rest !== undefined) set.rest = parseRest(raw.rest);
    if (raw.optional === true) set.optional = true;
    else if (raw.optional && raw.optional.top_reps_at_least != null) set.optional = { topRepsAtLeast: Number(raw.optional.top_reps_at_least) };
    if (raw.note != null) set.note = String(raw.note);
    var copies = raw.sets != null ? Number(raw.sets) : 1, out = [];
    for (var i = 0; i < copies; i++) out.push(set);
    return out;
  }

  function normalizeSets(list, units, where) {
    if (!Array.isArray(list) || !list.length) throw new Error(where + ': needs a list of sets');
    var out = [];
    list.forEach(function (raw, i) { out = out.concat(normalizeSet(raw, units, where + ', set ' + (i + 1))); });
    return out;
  }

  function normalizeExerciseBlock(raw, units, where, exercises) {
    var id = raw.exercise;
    if (!id) throw new Error(where + ': block needs an exercise');
    if (!exercises[id]) exercises[id] = { name: titleCase(id), equipment: 'other', options: [] };
    var b = { type: 'exercise', exercise: id, sets: normalizeSets(raw.sets, units, where + ' (' + id + ')') };
    if (raw.label) b.label = String(raw.label);
    if (raw.notes) b.notes = String(raw.notes);
    var pr = parseProgress(raw.progress, units);
    if (pr) b.progress = pr;
    if (raw.fallback) {
      b.fallback = {
        when: String(raw.fallback.when || 'Alternative'),
        sets: normalizeSets(raw.fallback.sets, units, where + ' (' + id + ' fallback)')
      };
    }
    return b;
  }

  function normalizeProgram(raw) {
    if (!raw || typeof raw !== 'object') throw new Error('Program file is empty');
    if (raw.openlifting == null) throw new Error('Not an OpenLifting program (missing "openlifting: 1")');
    if (!raw.name) throw new Error('Program needs a name');
    var units = String(raw.units || 'lb').toLowerCase();
    var d = raw.defaults || {};
    var defaults = {
      prep: d.prep ? String(d.prep) : undefined,
      increment: d.increment != null ? parseAmount(d.increment, units).value : 5,
      bar: d.bar != null ? parseAmount(d.bar, units).value : (units === 'kg' ? 20 : 45),
      progress: parseProgress(d.progress, units),
      rest: {}
    };
    for (var k in d.rest || {}) defaults.rest[k] = parseRest(d.rest[k]);

    var exercises = {};
    for (var id in raw.exercises || {}) {
      var e = raw.exercises[id] || {};
      var ex = {
        name: e.name ? String(e.name) : titleCase(id),
        equipment: EQUIPMENT.indexOf(e.equipment) >= 0 ? e.equipment : 'other',
        options: Array.isArray(e.options) ? e.options.map(String) : []
      };
      if (e.increment != null) ex.increment = parseAmount(e.increment, units).value;
      if (e.bar != null) ex.bar = parseAmount(e.bar, units).value;
      if (e.progress != null) ex.progress = parseProgress(e.progress, units);
      if (e.notes) ex.notes = String(e.notes);
      exercises[id] = ex;
    }

    if (!Array.isArray(raw.workouts) || !raw.workouts.length) throw new Error('Program needs at least one workout');
    var seen = {};
    var workouts = raw.workouts.map(function (w, wi) {
      var where = 'Workout ' + (w.id || wi + 1);
      if (!w.id) throw new Error(where + ' needs an id');
      if (seen[w.id]) throw new Error('Duplicate workout id "' + w.id + '"');
      seen[w.id] = true;
      if (!Array.isArray(w.blocks) || !w.blocks.length) throw new Error(where + ' needs blocks');
      return {
        id: String(w.id),
        name: w.name ? String(w.name) : String(w.id),
        week: w.week,
        prep: w.prep ? String(w.prep) : defaults.prep,
        notes: w.notes ? String(w.notes) : undefined,
        blocks: w.blocks.map(function (b, bi) {
          var bw = where + ', block ' + (bi + 1);
          if (b.superset) {
            return {
              type: 'superset',
              members: b.superset.map(function (m) { return normalizeExerciseBlock(m, units, bw, exercises); }),
              notes: b.notes ? String(b.notes) : undefined
            };
          }
          return normalizeExerciseBlock(b, units, bw, exercises);
        })
      };
    });

    // `% of <id>` must name an exercise id.
    workouts.forEach(function (w) {
      w.blocks.forEach(function (b) {
        members(b).forEach(function (m) {
          m.sets.concat(m.fallback ? m.fallback.sets : []).forEach(function (s) {
            if (s.load.of && !exercises[s.load.of]) throw new Error(w.id + ': "% of ' + s.load.of + '" names an unknown exercise');
          });
        });
      });
    });

    return {
      id: raw.id ? String(raw.id) : String(raw.name).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, ''),
      name: String(raw.name),
      units: units,
      schedule: raw.schedule || 'rotate',
      notes: raw.notes ? String(raw.notes) : undefined,
      defaults: defaults,
      exercises: exercises,
      workouts: workouts
    };
  }

  /* ---------- Running ---------- */

  function members(block) {
    return block.type === 'superset' ? block.members : [block];
  }

  // Progression rule for an exercise block: block overrides exercise overrides program default.
  function progressRule(program, member) {
    if (member.progress !== undefined) return member.progress;
    var ex = program.exercises[member.exercise];
    if (ex && ex.progress !== undefined) return ex.progress;
    return program.defaults.progress || 'none';
  }

  /*
   * Ordered steps for a block. opts.fallback[i] = true uses member i's fallback sets.
   * Each step: { member, kind, reps, load, restSec, optional, note }
   */
  function expandBlock(program, block, opts) {
    var ms = members(block), superset = block.type === 'superset';
    var fb = (opts && opts.fallback) || {};
    var lists = ms.map(function (m, mi) {
      var sets = fb[mi] && m.fallback ? m.fallback.sets : m.sets;
      return sets.map(function (s, i) {
        var next = sets[i + 1], rest;
        if (next && next.kind === 'drop') rest = { min: 0, max: 0 };
        else if (s.rest) rest = s.rest;
        else if (!superset && program.defaults.rest[s.kind]) rest = program.defaults.rest[s.kind];
        var step = { member: mi, kind: s.kind, reps: s.reps, load: s.load };
        if (rest && rest.max > 0) step.restSec = rest;
        if (s.optional) step.optional = s.optional;
        if (s.note) step.note = s.note;
        return step;
      });
    });

    var steps;
    if (!superset) {
      steps = lists[0];
    } else {
      // A cluster is one set plus the drop / rest-pause sets right after it; members take turns by cluster.
      var clusters = lists.map(function (list) {
        var out = [];
        list.forEach(function (st) {
          if (out.length && (st.kind === 'drop' || st.kind === 'restpause')) out[out.length - 1].push(st);
          else out.push([st]);
        });
        return out;
      });
      steps = [];
      for (var round = 0; ; round++) {
        var any = false;
        clusters.forEach(function (c) {
          if (c[round]) { steps = steps.concat(c[round]); any = true; }
        });
        if (!any) break;
      }
    }
    // No rest after the last set of a block.
    if (steps.length) delete steps[steps.length - 1].restSec;
    return steps;
  }

  var api = {
    KINDS: KINDS,
    normalizeProgram: normalizeProgram,
    expandBlock: expandBlock,
    members: members,
    progressRule: progressRule,
    parseLoad: parseLoad,
    parseReps: parseReps,
    titleCase: titleCase
  };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.OpenLifting = api;
})(this);
