// UI-independent helpers: snippet validation and picking, key mapping, formatting, and the history / personal-best store.
// Loaded as a plain script in the page and with require() in the Node tests.
(function (root, factory) {
  if (typeof module === "object" && module.exports) module.exports = factory();
  else root.TypingLib = factory();
})(typeof self !== "undefined" ? self : this, function () {
  "use strict";

  const LANGUAGES = ["javascript", "python", "sql", "go", "rust", "shell", "html", "css", "json"];
  const DIFFICULTIES = ["easy", "medium", "hard"];
  const MIN_LINES = 4;
  const MAX_LINES = 15;
  const MAX_CHARS = 600;
  const HISTORY_LIMIT = 100;
  const DEFAULT_PREFS = { autoIndent: true, stopOnError: false, showHint: true };

  // ---- snippets ----

  // Returns a list of problems (empty when the snippet is fine). A snippet may only contain characters the key handler can
  // produce: printable ASCII, "\n" (Enter) and "\t" (Tab).
  function validateSnippet(s) {
    const problems = [];
    if (!s || typeof s !== "object") return ["snippet is not an object"];
    const label = typeof s.id === "string" ? s.id : "(no id)";
    const add = (msg) => problems.push(label + ": " + msg);
    if (typeof s.id !== "string" || !/^[a-z0-9]+(-[a-z0-9]+)*$/.test(s.id)) add("id must be lower-case words joined by hyphens");
    if (typeof s.title !== "string" || s.title.trim() === "") add("title is missing");
    if (!LANGUAGES.includes(s.language)) add("unknown language " + JSON.stringify(s.language));
    if (!DIFFICULTIES.includes(s.difficulty)) add("unknown difficulty " + JSON.stringify(s.difficulty));
    const indentOk = typeof s.indent === "string" && (s.indent === "\t" || /^ {1,8}$/.test(s.indent));
    if (!indentOk) add("indent must be 1 to 8 spaces or a single tab");
    if (typeof s.code !== "string" || s.code === "") {
      add("code must be a non-empty string");
      return problems;
    }
    const code = s.code;
    if (code.length > MAX_CHARS) add("code is longer than " + MAX_CHARS + " characters");
    if (/\r/.test(code)) add("contains a carriage return; use \\n only");
    const bad = code.match(/[^\x20-\x7e\n\t]/);
    if (bad) add("contains a character the keyboard handler cannot produce: U+" + bad[0].charCodeAt(0).toString(16).padStart(4, "0"));
    if (/^\s/.test(code)) add("starts with whitespace");
    if (/\s$/.test(code)) add("ends with whitespace or a newline");
    const lines = code.split("\n");
    if (lines.length < MIN_LINES || lines.length > MAX_LINES) add("has " + lines.length + " lines; expected " + MIN_LINES + " to " + MAX_LINES);
    let blankRun = 0;
    lines.forEach((line, i) => {
      const where = "line " + (i + 1);
      if (/[ \t]+$/.test(line)) add(where + " has trailing whitespace");
      const lead = line.match(/^[ \t]*/)[0];
      if (lead.includes("\t") && lead.includes(" ")) add(where + " mixes tabs and spaces in its indentation");
      else if (indentOk && lead !== "") {
        if (s.indent === "\t" && lead.includes(" ")) add(where + " is indented with spaces but the snippet's indent is a tab");
        else if (s.indent !== "\t" && lead.includes("\t")) add(where + " is indented with a tab but the snippet's indent is spaces");
        else if (s.indent !== "\t" && lead.length % s.indent.length !== 0) add(where + " is indented by " + lead.length + ", not a multiple of " + s.indent.length);
      }
      if (line.slice(lead.length).includes("\t")) add(where + " has a tab after the indentation");
      blankRun = line === "" ? blankRun + 1 : 0;
      if (blankRun > 1) add(where + " is a second blank line in a row");
    });
    return problems;
  }

  function validateSnippets(list) {
    const problems = [];
    const seen = new Set();
    list.forEach((s) => {
      validateSnippet(s).forEach((p) => problems.push(p));
      if (s && seen.has(s.id)) problems.push(s.id + ": duplicate id");
      if (s) seen.add(s.id);
    });
    return problems;
  }

  // filter: { language, difficulty } (empty means any). rng is injectable for tests. excludeId avoids repeating the last snippet
  // when there is another choice. Returns null when nothing matches.
  function pickSnippet(snippets, filter, rng, excludeId) {
    const f = filter || {};
    let pool = snippets.filter((s) => (!f.language || s.language === f.language) && (!f.difficulty || s.difficulty === f.difficulty));
    if (excludeId && pool.length > 1) pool = pool.filter((s) => s.id !== excludeId);
    if (pool.length === 0) return null;
    const r = (rng || Math.random)();
    return pool[Math.min(pool.length - 1, Math.max(0, Math.floor(r * pool.length)))];
  }

  // ---- keyboard ----

  // Maps a keydown event (or any object with the same fields) to what the session should do, or null to ignore it
  // (the caller then must not preventDefault, so browser shortcuts keep working).
  // Returns { action: "type", char } | { action: "tab" } | { action: "backspace" } | { action: "restart" } | null.
  function keyToAction(ev) {
    if (!ev || typeof ev.key !== "string") return null;
    if (ev.isComposing || ev.key === "Process" || ev.key === "Dead" || ev.key === "Unidentified") return null; // IME input is not supported
    if (ev.metaKey) return null;
    if (ev.ctrlKey && !ev.altKey) return null; // Ctrl+C, Ctrl+R ... stay with the browser. Ctrl+Alt is AltGr on Windows layouts.
    switch (ev.key) {
      case "Escape":
        return { action: "restart" };
      case "Enter":
        return { action: "type", char: "\n" };
      case "Tab":
        return ev.shiftKey ? null : { action: "tab" }; // Shift+Tab stays available to leave the typing area
      case "Backspace":
        return { action: "backspace" };
      default:
        return ev.key.length === 1 ? { action: "type", char: ev.key } : null;
    }
  }

  // ---- formatting ----

  const finite = (x) => (typeof x === "number" && Number.isFinite(x) ? x : 0);

  function formatWpm(x) {
    return finite(x).toFixed(1);
  }

  function formatPercent(x) {
    return finite(x).toFixed(1) + "%";
  }

  // m:ss.t, for example 0:07.4 or 12:03.0
  function formatDuration(ms) {
    const tenths = Math.floor(Math.max(0, finite(ms)) / 100);
    const m = Math.floor(tenths / 600);
    const s = Math.floor((tenths % 600) / 10);
    return m + ":" + String(s).padStart(2, "0") + "." + (tenths % 10);
  }

  // The live WPM figure is meaningless in the first second (one fast keystroke gives hundreds of WPM), so show a dash until then.
  function liveWpmLabel(stats) {
    return stats.elapsedMs < 1000 ? "–" : formatWpm(stats.wpm);
  }

  function displayChar(c) {
    if (c === "\n") return "Enter";
    if (c === "\t") return "Tab";
    if (c === " ") return "Space";
    return c;
  }

  // perKeyErrors is { expectedChar: count }. Most missed first; ties by character code, so the order is stable.
  function topMistyped(perKeyErrors, limit) {
    const max = limit === undefined ? 5 : limit;
    return Object.keys(perKeyErrors || {})
      .filter((k) => Number.isFinite(perKeyErrors[k]) && perKeyErrors[k] > 0)
      .sort((a, b) => perKeyErrors[b] - perKeyErrors[a] || (a < b ? -1 : a > b ? 1 : 0))
      .slice(0, max)
      .map((k) => ({ char: k, label: displayChar(k), count: perKeyErrors[k] }));
  }

  // ---- personal bests ----

  // Higher WPM wins; equal WPM is decided by accuracy.
  function isBetter(a, b) {
    return a.wpm > b.wpm || (a.wpm === b.wpm && a.accuracy > b.accuracy);
  }

  // kind: "first" (no earlier best), "new-best", "tie", "below".
  function compareToBest(result, best) {
    if (!best) return { kind: "first", previous: null, wpmDelta: 0, accuracyDelta: 0 };
    const kind = isBetter(result, best) ? "new-best" : result.wpm === best.wpm && result.accuracy === best.accuracy ? "tie" : "below";
    return { kind: kind, previous: best, wpmDelta: result.wpm - best.wpm, accuracyDelta: result.accuracy - best.accuracy };
  }

  function cleanResult(r) {
    if (!r || typeof r !== "object") return null;
    if (typeof r.id !== "string" || r.id === "") return null;
    const wpm = r.wpm;
    const accuracy = r.accuracy;
    const elapsedMs = r.elapsedMs;
    const errors = r.errors;
    if (![wpm, accuracy, elapsedMs, errors].every((x) => typeof x === "number" && Number.isFinite(x))) return null;
    if (wpm < 0 || accuracy < 0 || accuracy > 100 || elapsedMs < 0 || errors < 0) return null;
    return {
      id: r.id,
      language: typeof r.language === "string" ? r.language : "",
      wpm: wpm,
      accuracy: accuracy,
      elapsedMs: elapsedMs,
      errors: errors,
      at: typeof r.at === "string" ? r.at : "",
    };
  }

  function isPlainMap(v) {
    return v !== null && typeof v === "object" && !Array.isArray(v);
  }

  // History, personal bests (one per snippet) and options. Falls back to memory if storage is missing, full, or holds corrupt
  // data; entries that fail validation are dropped one by one instead of discarding everything.
  function createStore(storage, storageKey) {
    const KEY = storageKey || "code-typing-trainer.v1";
    let history = [];
    let best = {};
    let prefs = Object.assign({}, DEFAULT_PREFS);

    try {
      const raw = storage && storage.getItem(KEY);
      if (raw) {
        const parsed = JSON.parse(raw);
        if (isPlainMap(parsed)) {
          if (Array.isArray(parsed.history)) history = parsed.history.map(cleanResult).filter(Boolean).slice(-HISTORY_LIMIT);
          if (isPlainMap(parsed.best)) {
            Object.keys(parsed.best).forEach((id) => {
              const c = cleanResult(Object.assign({}, parsed.best[id], { id: id }));
              if (c) best[id] = c;
            });
          }
          if (isPlainMap(parsed.prefs)) {
            Object.keys(DEFAULT_PREFS).forEach((k) => {
              if (typeof parsed.prefs[k] === "boolean") prefs[k] = parsed.prefs[k];
            });
          }
        }
      }
    } catch (e) {
      history = [];
      best = {};
      prefs = Object.assign({}, DEFAULT_PREFS);
    }

    function persist() {
      try {
        if (storage) storage.setItem(KEY, JSON.stringify({ history: history, best: best, prefs: prefs }));
        return true;
      } catch (e) {
        return false;
      }
    }

    return {
      history: () => history.slice(),
      best: (id) => (best[id] ? Object.assign({}, best[id]) : null),
      bests: () => Object.assign({}, best),
      prefs: () => Object.assign({}, prefs),
      // result: { id, language, wpm, accuracy, elapsedMs, errors, at }. The comparison is made against the best from BEFORE
      // this run. Returns { saved, persisted, comparison }; saved is false for an invalid result (nothing is stored).
      addResult(result) {
        const clean = cleanResult(result);
        if (!clean) return { saved: false, persisted: false, comparison: null };
        const comparison = compareToBest(clean, best[clean.id] || null);
        if (comparison.kind === "first" || comparison.kind === "new-best") best[clean.id] = clean;
        history.push(clean);
        if (history.length > HISTORY_LIMIT) history = history.slice(-HISTORY_LIMIT);
        return { saved: true, persisted: persist(), comparison: comparison };
      },
      setPrefs(partial) {
        Object.keys(DEFAULT_PREFS).forEach((k) => {
          if (partial && typeof partial[k] === "boolean") prefs[k] = partial[k];
        });
        return persist();
      },
      clearHistory() {
        history = [];
        best = {};
        return persist();
      },
    };
  }

  return {
    LANGUAGES: LANGUAGES,
    DIFFICULTIES: DIFFICULTIES,
    HISTORY_LIMIT: HISTORY_LIMIT,
    DEFAULT_PREFS: DEFAULT_PREFS,
    validateSnippet: validateSnippet,
    validateSnippets: validateSnippets,
    pickSnippet: pickSnippet,
    keyToAction: keyToAction,
    formatWpm: formatWpm,
    formatPercent: formatPercent,
    formatDuration: formatDuration,
    liveWpmLabel: liveWpmLabel,
    displayChar: displayChar,
    topMistyped: topMistyped,
    isBetter: isBetter,
    compareToBest: compareToBest,
    createStore: createStore,
  };
});
