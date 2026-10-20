const test = require("node:test");
const assert = require("node:assert/strict");
const lib = require("../src/lib.js");
const snippets = require("../src/snippets.js");

const { validateSnippet, validateSnippets, pickSnippet, keyToAction, formatWpm, formatPercent, formatDuration, liveWpmLabel, displayChar, topMistyped, compareToBest, createStore } = lib;

const good = () => ({ id: "ok-one", title: "OK", language: "python", difficulty: "easy", indent: "    ", code: "def f():\n    return 1\n\nprint(f())" });
const problemsOf = (patch) => validateSnippet(Object.assign(good(), patch));

// ---- snippet validation ----

test("a well-formed snippet has no problems", () => {
  assert.deepEqual(validateSnippet(good()), []);
});

test("validation catches missing or malformed fields", () => {
  assert.ok(validateSnippet(null).length > 0);
  assert.ok(validateSnippet("x").length > 0);
  assert.match(problemsOf({ id: "Bad_Id" }).join(), /id must be/);
  assert.match(problemsOf({ id: undefined }).join(), /id must be/);
  assert.match(problemsOf({ title: " " }).join(), /title/);
  assert.match(problemsOf({ language: "cobol" }).join(), /unknown language/);
  assert.match(problemsOf({ difficulty: "brutal" }).join(), /unknown difficulty/);
  assert.match(problemsOf({ indent: "" }).join(), /indent must be/);
  assert.match(problemsOf({ indent: "\t\t" }).join(), /indent must be/);
  assert.match(problemsOf({ indent: undefined }).join(), /indent must be/);
  assert.match(problemsOf({ code: "" }).join(), /non-empty/);
  assert.match(problemsOf({ code: 5 }).join(), /non-empty/);
});

test("validation rejects trailing spaces, trailing newlines, leading whitespace and CRLF", () => {
  assert.match(problemsOf({ code: "a\nb \nc\nd" }).join(), /line 2 has trailing whitespace/);
  assert.match(problemsOf({ code: "a\nb\nc\nd\n" }).join(), /ends with whitespace or a newline/);
  assert.match(problemsOf({ code: "\na\nb\nc\nd" }).join(), /starts with whitespace/);
  assert.match(problemsOf({ code: "a\r\nb\r\nc\r\nd" }).join(), /carriage return/);
  assert.match(problemsOf({ code: "a\nb\n \nc\nd" }).join(), /trailing whitespace/, "a whitespace-only line");
});

test("validation rejects a tab/space mix, wrong indent style and irregular indent depth", () => {
  assert.match(problemsOf({ code: "a\n\t  b\nc\nd" }).join(), /mixes tabs and spaces/);
  assert.match(problemsOf({ code: "a\n    b\nc\nd", indent: "\t" }).join(), /indented with spaces but the snippet's indent is a tab/);
  assert.match(problemsOf({ code: "a\n\tb\nc\nd" }).join(), /indented with a tab but the snippet's indent is spaces/);
  assert.match(problemsOf({ code: "a\n   b\nc\nd" }).join(), /not a multiple of 4/);
  assert.match(problemsOf({ code: "a\nb\tc\nd\ne" }).join(), /tab after the indentation/);
  assert.deepEqual(problemsOf({ code: "a\n\tb\n\t\tc\nd", indent: "\t" }), []);
});

test("validation rejects characters the keyboard handler cannot produce", () => {
  assert.match(problemsOf({ code: "caf\u00e9\nb\nc\nd" }).join(), /cannot produce: U\+00e9/);
  assert.match(problemsOf({ code: "a\nb\u2192\nc\nd" }).join(), /U\+2192/);
  assert.match(problemsOf({ code: "a\nb\u0000\nc\nd" }).join(), /U\+0000/);
  assert.match(problemsOf({ code: "a\nb\u000b\nc\nd" }).join(), /cannot produce/);
});

test("validation enforces 4 to 15 lines, a length cap and no double blank lines", () => {
  assert.match(problemsOf({ code: "a\nb\nc" }).join(), /3 lines/);
  assert.deepEqual(problemsOf({ code: "a\nb\nc\nd" }), []);
  assert.deepEqual(problemsOf({ code: Array.from({ length: 15 }, (_, i) => "l" + i).join("\n") }), []);
  assert.match(problemsOf({ code: Array.from({ length: 16 }, (_, i) => "l" + i).join("\n") }).join(), /16 lines/);
  assert.match(problemsOf({ code: ("x".repeat(50) + "\n").repeat(13) + "end" }).join(), /longer than 600/);
  assert.match(problemsOf({ code: "a\n\n\nb\nc" }).join(), /second blank line/);
});

test("validateSnippets reports duplicate ids", () => {
  const a = good();
  const b = good();
  assert.match(validateSnippets([a, b]).join(), /duplicate id/);
  assert.deepEqual(validateSnippets([a, Object.assign(good(), { id: "other" })]), []);
});

// ---- picking ----

test("pickSnippet filters by language and difficulty", () => {
  const rngFirst = () => 0;
  assert.equal(pickSnippet(snippets, { language: "go" }, rngFirst).language, "go");
  const hardRust = pickSnippet(snippets, { language: "rust", difficulty: "hard" }, rngFirst);
  assert.equal(hardRust.id, "rust-parse-port");
  assert.equal(pickSnippet(snippets, { language: "css", difficulty: "hard" }, rngFirst), null);
  assert.equal(pickSnippet([], {}, rngFirst), null);
});

test("pickSnippet is driven by the injected rng, including the edges 0 and just under 1", () => {
  assert.equal(pickSnippet(snippets, {}, () => 0), snippets[0]);
  assert.equal(pickSnippet(snippets, {}, () => 0.999999), snippets[snippets.length - 1]);
  assert.equal(pickSnippet(snippets, {}, () => 1), snippets[snippets.length - 1], "a misbehaving rng cannot index out of range");
  assert.equal(pickSnippet(snippets, {}, () => -1), snippets[0]);
});

test("pickSnippet avoids repeating the last snippet when there is a choice", () => {
  assert.notEqual(pickSnippet(snippets, {}, () => 0, snippets[0].id).id, snippets[0].id);
  const onlyGo = snippets.filter((s) => s.language === "go");
  const picked = pickSnippet(onlyGo, { language: "go" }, () => 0, onlyGo[0].id);
  assert.equal(picked.id, onlyGo[1].id);
  assert.equal(pickSnippet([snippets[0]], {}, () => 0, snippets[0].id).id, snippets[0].id, "a single candidate is still returned");
});

test("pickSnippet with the default rng returns members of the pool", () => {
  for (let i = 0; i < 50; i++) assert.ok(snippets.includes(pickSnippet(snippets, {})));
});

// ---- key mapping ----

test("keyToAction maps the special keys", () => {
  assert.deepEqual(keyToAction({ key: "Enter" }), { action: "type", char: "\n" });
  assert.deepEqual(keyToAction({ key: "Tab" }), { action: "tab" });
  assert.deepEqual(keyToAction({ key: "Backspace" }), { action: "backspace" });
  assert.deepEqual(keyToAction({ key: "Escape" }), { action: "restart" });
});

test("keyToAction passes printable characters through, including symbols, space and capitals", () => {
  for (const ch of "aZ09 {}[]()<>=;:\"'\\|&*`$#/-+%!,._~?@^") assert.deepEqual(keyToAction({ key: ch }), { action: "type", char: ch }, ch);
  assert.deepEqual(keyToAction({ key: "A", shiftKey: true }), { action: "type", char: "A" });
});

test("every character that appears in a snippet can be produced by the key handler", () => {
  const chars = new Set(snippets.map((s) => s.code).join(""));
  for (const ch of chars) {
    const ev = ch === "\n" ? { key: "Enter" } : ch === "\t" ? { key: "Tab" } : { key: ch };
    assert.ok(keyToAction(ev), JSON.stringify(ch));
  }
});

test("keyToAction ignores shortcuts, modifiers, function and arrow keys, and IME events", () => {
  for (const ev of [
    { key: "c", ctrlKey: true },
    { key: "r", metaKey: true },
    { key: "Backspace", ctrlKey: true },
    { key: "Shift" },
    { key: "Control" },
    { key: "F5" },
    { key: "ArrowLeft" },
    { key: "CapsLock" },
    { key: "Dead" },
    { key: "Process" },
    { key: "Unidentified" },
    { key: "a", isComposing: true },
    { key: "Tab", shiftKey: true },
    { key: "\u{1F600}" },
    { key: "" },
    {},
    null,
  ]) assert.equal(keyToAction(ev), null, JSON.stringify(ev));
});

test("keyToAction accepts Alt-only and Ctrl+Alt (AltGr) characters", () => {
  assert.deepEqual(keyToAction({ key: "{", ctrlKey: true, altKey: true }), { action: "type", char: "{" });
  assert.deepEqual(keyToAction({ key: "[", altKey: true }), { action: "type", char: "[" });
});

// ---- formatting ----

test("formatWpm and formatPercent use one decimal and survive bad numbers", () => {
  assert.equal(formatWpm(10), "10.0");
  assert.equal(formatWpm(41.26), "41.3");
  assert.equal(formatPercent(100), "100.0%");
  assert.equal(formatPercent(97.14), "97.1%");
  for (const bad of [NaN, Infinity, undefined, null, "x"]) {
    assert.equal(formatWpm(bad), "0.0");
    assert.equal(formatPercent(bad), "0.0%");
  }
});

test("formatDuration prints m:ss.t", () => {
  assert.equal(formatDuration(0), "0:00.0");
  assert.equal(formatDuration(7450), "0:07.4");
  assert.equal(formatDuration(59999), "0:59.9");
  assert.equal(formatDuration(60000), "1:00.0");
  assert.equal(formatDuration(723000), "12:03.0");
  assert.equal(formatDuration(-5), "0:00.0");
  assert.equal(formatDuration(NaN), "0:00.0");
});

test("liveWpmLabel shows a dash for the first second and then the number", () => {
  assert.equal(liveWpmLabel({ elapsedMs: 0, wpm: 0 }), "\u2013");
  assert.equal(liveWpmLabel({ elapsedMs: 999, wpm: 300 }), "\u2013");
  assert.equal(liveWpmLabel({ elapsedMs: 1000, wpm: 24 }), "24.0");
});

test("displayChar names the whitespace keys", () => {
  assert.equal(displayChar("\n"), "Enter");
  assert.equal(displayChar("\t"), "Tab");
  assert.equal(displayChar(" "), "Space");
  assert.equal(displayChar("{"), "{");
});

test("topMistyped sorts by count, breaks ties by character, limits, and ignores junk", () => {
  const list = topMistyped({ "}": 2, a: 5, " ": 2, "\n": 1, z: 0, q: NaN });
  assert.deepEqual(list.map((x) => x.char), ["a", " ", "}", "\n"]);
  assert.deepEqual(list[1], { char: " ", label: "Space", count: 2 });
  assert.deepEqual(list[3], { char: "\n", label: "Enter", count: 1 });
  assert.equal(topMistyped({ a: 1, b: 2, c: 3 }, 2).length, 2);
  assert.deepEqual(topMistyped({}), []);
  assert.deepEqual(topMistyped(null), []);
  assert.equal(topMistyped({ a: 1, b: 1, c: 1, d: 1, e: 1, f: 1, g: 1 }).length, 5, "default limit is 5");
});

// ---- personal best comparison ----

test("compareToBest reports first, new-best, tie and below", () => {
  const best = { wpm: 40, accuracy: 95 };
  assert.deepEqual(compareToBest({ wpm: 30, accuracy: 90 }, null), { kind: "first", previous: null, wpmDelta: 0, accuracyDelta: 0 });
  assert.equal(compareToBest({ wpm: 41, accuracy: 80 }, best).kind, "new-best");
  assert.equal(compareToBest({ wpm: 40, accuracy: 96 }, best).kind, "new-best", "same WPM, better accuracy");
  assert.equal(compareToBest({ wpm: 40, accuracy: 95 }, best).kind, "tie");
  assert.equal(compareToBest({ wpm: 40, accuracy: 94 }, best).kind, "below");
  const below = compareToBest({ wpm: 35, accuracy: 99 }, best);
  assert.equal(below.kind, "below");
  assert.equal(below.wpmDelta, -5);
  assert.equal(below.accuracyDelta, 4);
});

// ---- the history / best / prefs store ----

function memoryStorage(initial) {
  const m = new Map(Object.entries(initial || {}));
  return { getItem: (k) => (m.has(k) ? m.get(k) : null), setItem: (k, v) => m.set(k, String(v)), raw: (k) => m.get(k) };
}

const run = (over) => Object.assign({ id: "js-debounce", language: "javascript", wpm: 40, accuracy: 96, elapsedMs: 20000, errors: 2, at: "2026-10-20T10:00:00.000Z" }, over);

test("the first result becomes the personal best and is added to the history", () => {
  const s = createStore(memoryStorage(), "k");
  assert.equal(s.best("js-debounce"), null);
  const res = s.addResult(run());
  assert.equal(res.saved, true);
  assert.equal(res.persisted, true);
  assert.equal(res.comparison.kind, "first");
  assert.equal(s.best("js-debounce").wpm, 40);
  assert.equal(s.history().length, 1);
});

test("a better run replaces the best, a worse one does not, and the comparison is against the previous best", () => {
  const s = createStore(memoryStorage(), "k");
  s.addResult(run());
  const worse = s.addResult(run({ wpm: 30 }));
  assert.equal(worse.comparison.kind, "below");
  assert.equal(s.best("js-debounce").wpm, 40);
  const better = s.addResult(run({ wpm: 55 }));
  assert.equal(better.comparison.kind, "new-best");
  assert.equal(better.comparison.previous.wpm, 40);
  assert.equal(better.comparison.wpmDelta, 15);
  assert.equal(s.best("js-debounce").wpm, 55);
  assert.equal(s.history().length, 3);
});

test("bests are kept per snippet", () => {
  const s = createStore(memoryStorage(), "k");
  s.addResult(run({ id: "a", wpm: 20 }));
  s.addResult(run({ id: "b", wpm: 60 }));
  assert.equal(s.best("a").wpm, 20);
  assert.equal(s.best("b").wpm, 60);
  assert.deepEqual(Object.keys(s.bests()).sort(), ["a", "b"]);
});

test("history, bests and prefs survive a reload from the same storage", () => {
  const storage = memoryStorage();
  const a = createStore(storage, "k");
  a.addResult(run({ wpm: 44.5 }));
  a.setPrefs({ autoIndent: false, stopOnError: true, showHint: false });
  const b = createStore(storage, "k");
  assert.equal(b.best("js-debounce").wpm, 44.5);
  assert.equal(b.history().length, 1);
  assert.deepEqual(b.prefs(), { autoIndent: false, stopOnError: true, showHint: false });
});

test("prefs default to auto-indent on, stop-on-error off, hint on, and only accept booleans", () => {
  const s = createStore(memoryStorage(), "k");
  assert.deepEqual(s.prefs(), { autoIndent: true, stopOnError: false, showHint: true });
  s.setPrefs({ autoIndent: "no", stopOnError: 1, showHint: false, bogus: true });
  assert.deepEqual(s.prefs(), { autoIndent: true, stopOnError: false, showHint: false });
  const loaded = createStore(memoryStorage({ k: JSON.stringify({ prefs: { autoIndent: "x", stopOnError: true } }) }), "k");
  assert.deepEqual(loaded.prefs(), { autoIndent: true, stopOnError: true, showHint: true });
});

test("history is capped at the most recent 100 runs", () => {
  const s = createStore(memoryStorage(), "k");
  for (let i = 0; i < 130; i++) s.addResult(run({ wpm: i, at: String(i) }));
  const h = s.history();
  assert.equal(h.length, lib.HISTORY_LIMIT);
  assert.equal(h[0].at, "30");
  assert.equal(h[h.length - 1].at, "129");
  assert.equal(s.best("js-debounce").wpm, 129, "the best is kept separately from the capped history");
});

test("an invalid result is refused and stores nothing", () => {
  const s = createStore(memoryStorage(), "k");
  for (const bad of [null, {}, run({ id: "" }), run({ wpm: NaN }), run({ wpm: -1 }), run({ accuracy: 101 }), run({ accuracy: -1 }), run({ elapsedMs: Infinity }), run({ errors: "2" })]) {
    assert.deepEqual(s.addResult(bad), { saved: false, persisted: false, comparison: null });
  }
  assert.equal(s.history().length, 0);
  assert.deepEqual(s.bests(), {});
});

test("clearHistory removes history and bests but keeps the options", () => {
  const storage = memoryStorage();
  const s = createStore(storage, "k");
  s.addResult(run());
  s.setPrefs({ stopOnError: true });
  s.clearHistory();
  assert.equal(s.history().length, 0);
  assert.equal(s.best("js-debounce"), null);
  assert.equal(createStore(storage, "k").prefs().stopOnError, true);
});

test("the store ignores corrupt or wrongly shaped saved data instead of crashing", () => {
  for (const raw of ["{not json", "null", "[]", '"str"', "42", '{"history":"x","best":[],"prefs":5}', '{"history":{"a":1}}']) {
    const s = createStore(memoryStorage({ k: raw }), "k");
    assert.deepEqual(s.history(), [], raw);
    assert.deepEqual(s.bests(), {}, raw);
    assert.deepEqual(s.prefs(), { autoIndent: true, stopOnError: false, showHint: true }, raw);
  }
});

test("bad entries inside otherwise good saved data are dropped one by one", () => {
  const saved = {
    history: [run({ wpm: 10 }), { id: "x" }, null, 5, run({ accuracy: 500 }), run({ wpm: "fast" }), run({ wpm: 20 })],
    best: { good: run({ id: "ignored", wpm: 33 }), bad: { wpm: "x" }, worse: null, neg: run({ wpm: -4 }) },
  };
  const s = createStore(memoryStorage({ k: JSON.stringify(saved) }), "k");
  assert.deepEqual(s.history().map((h) => h.wpm), [10, 20]);
  assert.deepEqual(Object.keys(s.bests()), ["good"]);
  assert.equal(s.best("good").wpm, 33);
  assert.equal(s.best("good").id, "good", "the id comes from the map key");
});

test("the store keeps working in memory when storage is missing", () => {
  const s = createStore(null, "k");
  const res = s.addResult(run());
  assert.equal(res.saved, true);
  assert.equal(s.best("js-debounce").wpm, 40);
  assert.equal(s.history().length, 1);
  assert.equal(s.setPrefs({ stopOnError: true }), true);
  assert.equal(s.prefs().stopOnError, true);
});

test("a full storage (setItem throws) reports persisted:false but the session still remembers the result", () => {
  const full = createStore({ getItem: () => null, setItem: () => { throw new Error("QuotaExceededError"); } }, "k");
  const res = full.addResult(run());
  assert.equal(res.saved, true);
  assert.equal(res.persisted, false);
  assert.equal(full.best("js-debounce").wpm, 40);
  assert.equal(full.history().length, 1);
  assert.equal(full.setPrefs({ showHint: false }), false);
  assert.equal(full.prefs().showHint, false);
});

test("a storage whose getItem throws (access denied) gives an empty store", () => {
  const s = createStore({ getItem: () => { throw new Error("SecurityError"); }, setItem: () => {} }, "k");
  assert.deepEqual(s.history(), []);
  assert.equal(s.addResult(run()).persisted, true);
});

test("returned history and bests are copies", () => {
  const s = createStore(memoryStorage(), "k");
  s.addResult(run());
  s.history().push({ junk: 1 });
  s.best("js-debounce").wpm = 999;
  s.prefs().autoIndent = false;
  assert.equal(s.history().length, 1);
  assert.equal(s.best("js-debounce").wpm, 40);
  assert.equal(s.prefs().autoIndent, true);
});

test("the default storage key is namespaced and the saved JSON has the documented shape", () => {
  const storage = memoryStorage();
  createStore(storage).addResult(run());
  const saved = JSON.parse(storage.raw("code-typing-trainer.v1"));
  assert.deepEqual(Object.keys(saved).sort(), ["best", "history", "prefs"]);
});
