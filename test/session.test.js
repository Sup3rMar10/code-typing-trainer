const test = require("node:test");
const assert = require("node:assert/strict");
const { createSession } = require("../src/session.js");
const snippets = require("../src/snippets.js");

const snip = (code, indent) => ({ id: "t", code: code, indent: indent });

// Types `text` one character at a time starting at t0, `step` ms apart. Returns the time of the last keystroke.
function feed(session, text, t0, step) {
  let t = t0;
  for (const ch of text) {
    session.type(ch, t);
    t += step;
  }
  return t - step;
}

// Small deterministic PRNG (mulberry32) for the seeded tests.
function rng(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// ---- basics ----

test("a fresh session has zeroed stats, 100% accuracy and is not finished", () => {
  const s = createSession(snip("abc"));
  assert.deepEqual(s.stats(0), {
    wpm: 0, grossWpm: 0, accuracy: 100, errors: 0, correct: 0, typed: 0, keystrokes: 0, elapsedMs: 0, finished: false, perKeyErrors: {},
  });
  assert.equal(s.cursor(), 0);
  assert.equal(s.length, 3);
  assert.equal(s.expected(), "a");
  assert.equal(s.started(), false);
});

test("createSession rejects snippets without usable code", () => {
  for (const bad of [null, undefined, {}, { code: "" }, { code: 5 }, { code: ["a"] }]) assert.throws(() => createSession(bad), TypeError);
});

test("options default to auto-indent on and stop-on-error off", () => {
  assert.deepEqual(createSession(snip("a")).options(), { autoIndent: true, stopOnError: false });
  assert.deepEqual(createSession(snip("a"), { autoIndent: false, stopOnError: true }).options(), { autoIndent: false, stopOnError: true });
  assert.deepEqual(createSession(snip("a"), {}).options(), { autoIndent: true, stopOnError: false });
});

test("typing the right characters advances the cursor and marks them correct", () => {
  const s = createSession(snip("abc"));
  assert.deepEqual(s.type("a", 0), { status: "correct" });
  assert.equal(s.cursor(), 1);
  assert.deepEqual(s.marks(), ["correct", "pending", "pending"]);
  assert.equal(s.expected(), "b");
});

test("a wrong character is stored, marked wrong, and the cursor moves on (continue mode)", () => {
  const s = createSession(snip("abc"));
  assert.deepEqual(s.type("x", 0), { status: "wrong" });
  assert.equal(s.cursor(), 1);
  assert.deepEqual(s.marks(), ["wrong", "pending", "pending"]);
  assert.equal(s.stats(0).errors, 1);
});

// ---- the clock and WPM ----

test("known answer: 50 correct characters in 60 seconds is 10 WPM", () => {
  const code = "a".repeat(50);
  const s = createSession(snip(code));
  // first key at t=1000 (the clock starts there), last key exactly 60 s later
  for (let i = 0; i < 50; i++) s.type("a", 1000 + Math.round((i * 60000) / 49));
  const st = s.stats(61000);
  assert.equal(st.finished, true);
  assert.equal(st.elapsedMs, 60000);
  assert.equal(st.wpm, 10);
  assert.equal(st.grossWpm, 10);
  assert.equal(st.accuracy, 100);
});

test("known answer: 100 correct characters in 30 seconds is 40 WPM", () => {
  const s = createSession(snip("b".repeat(100)));
  for (let i = 0; i < 100; i++) s.type("b", Math.round((i * 30000) / 99));
  const st = s.stats(30000);
  assert.equal(st.elapsedMs, 30000);
  assert.equal(st.wpm, 40);
});

test("live WPM mid-run: 25 correct characters after 30 seconds is 10 WPM", () => {
  const s = createSession(snip("a".repeat(50)));
  for (let i = 0; i < 25; i++) s.type("a", 1000 + i * 100);
  const st = s.stats(31000); // 30 s after the first key, the last of the 25 keys was long ago but the clock still runs
  assert.equal(st.elapsedMs, 30000);
  assert.equal(st.correct, 25);
  assert.equal(st.wpm, 10);
  assert.equal(st.finished, false);
});

test("WPM is 0 at elapsed 0, never NaN or Infinity", () => {
  const s = createSession(snip("abc"));
  assert.equal(s.stats(500).wpm, 0);
  s.type("a", 500);
  const st = s.stats(500);
  assert.equal(st.elapsedMs, 0);
  assert.equal(st.wpm, 0);
  assert.equal(st.grossWpm, 0);
});

test("a whole snippet typed in zero time reports 0 WPM, not Infinity", () => {
  const s = createSession(snip("abc"));
  feed(s, "abc", 700, 0);
  const st = s.stats(700);
  assert.equal(st.finished, true);
  assert.equal(st.wpm, 0);
});

test("the clock starts at the first keystroke, not at creation or when stats is read", () => {
  const s = createSession(snip("abcd"));
  assert.equal(s.stats(10000).elapsedMs, 0);
  s.type("a", 20000);
  assert.equal(s.started(), true);
  assert.equal(s.stats(23000).elapsedMs, 3000);
});

test("a wrong first key also starts the clock", () => {
  const s = createSession(snip("abcd"));
  s.type("x", 100);
  assert.equal(s.stats(1100).elapsedMs, 1000);
});

test("the clock stops at the last correct character and stays stopped", () => {
  const s = createSession(snip("abc"));
  feed(s, "abc", 1000, 500); // keys at 1000, 1500, 2000
  assert.equal(s.stats(2000).elapsedMs, 1000);
  assert.equal(s.stats(9999999).elapsedMs, 1000);
  assert.equal(s.stats(2000).wpm, 3 / 5 / (1000 / 60000));
});

test("Backspace and ignored input never start the clock", () => {
  const s = createSession(snip("abc"));
  s.backspace(100);
  s.type("ab", 200); // two characters in one call: ignored
  s.type("", 300);
  s.type(5, 400);
  assert.equal(s.started(), false);
  assert.equal(s.stats(900).elapsedMs, 0);
  assert.equal(s.stats(900).keystrokes, 0);
});

test("a clock that goes backwards gives elapsed 0, not a negative time", () => {
  const s = createSession(snip("abc"));
  s.type("a", 5000);
  assert.equal(s.stats(4000).elapsedMs, 0);
  assert.equal(s.stats(4000).wpm, 0);
});

test("non-finite times are a programming error and throw", () => {
  const s = createSession(snip("abc"));
  for (const bad of [NaN, Infinity, -Infinity, "1", null, undefined]) {
    assert.throws(() => s.type("a", bad), TypeError);
    assert.throws(() => s.backspace(bad), TypeError);
    assert.throws(() => s.tab(bad), TypeError);
  }
  assert.throws(() => s.stats(NaN), TypeError);
  assert.equal(s.cursor(), 0, "nothing changed");
});

test("stats() with no argument reuses the last time the session saw", () => {
  const s = createSession(snip("abcd"));
  s.type("a", 1000);
  s.type("b", 3000);
  assert.equal(s.stats().elapsedMs, 2000);
});

// ---- errors and accuracy ----

test("mistake then correct: the error stays counted and accuracy stays below 100", () => {
  const s = createSession(snip("abcdefghij"));
  feed(s, "ab", 0, 100);
  s.type("x", 200); // wrong at index 2
  s.backspace(300);
  assert.equal(s.cursor(), 2);
  assert.equal(s.stats(300).errors, 1);
  feed(s, "cdefghij", 400, 100);
  const st = s.stats(2000);
  assert.equal(st.finished, true);
  assert.equal(st.errors, 1);
  assert.equal(st.typed, 10);
  assert.equal(st.accuracy, 90);
  assert.deepEqual(st.perKeyErrors, { c: 1 });
});

test("wrong, backspace, wrong again at the same position still counts once", () => {
  const s = createSession(snip("abc"));
  s.type("x", 0);
  s.backspace(10);
  s.type("y", 20);
  s.backspace(30);
  s.type("z", 40);
  assert.equal(s.stats(40).errors, 1);
  assert.deepEqual(s.stats(40).perKeyErrors, { a: 1 });
});

test("correct at first, then Backspace and a wrong key at that position, is charged once", () => {
  const s = createSession(snip("abc"));
  s.type("a", 0);
  s.backspace(10);
  s.type("x", 20);
  assert.equal(s.stats(20).errors, 1);
  assert.equal(s.stats(20).typed, 1);
});

test("mistakes at different positions are charged separately", () => {
  const s = createSession(snip("abcd"));
  feed(s, "xbzd", 0, 100);
  const st = s.stats(300);
  assert.equal(st.errors, 2);
  assert.deepEqual(st.perKeyErrors, { a: 1, c: 1 });
  assert.equal(st.accuracy, 50);
  assert.equal(st.correct, 2);
  assert.equal(st.typed, 4);
});

test("accuracy known answer: 2 errors in 10 positions is 80%", () => {
  const s = createSession(snip("abcdefghij"));
  feed(s, "abXdeYghij", 0, 100);
  assert.equal(s.stats(900).accuracy, 80);
});

test("wrong characters still in the text count for grossWpm but not for WPM", () => {
  const s = createSession(snip("abcdefghij"));
  feed(s, "abxdefghij", 0, 100);
  s.type("q", 60000); // ignored: cursor is at the end
  const st = s.stats(60000);
  assert.equal(st.finished, false);
  assert.equal(st.correct, 9);
  assert.equal(st.wpm, 9 / 5);
  assert.equal(st.grossWpm, 10 / 5);
});

test("perKeyErrors is keyed by the expected character, including Enter and space", () => {
  const s = createSession(snip("a b\nc"));
  s.type("a", 0);
  s.type("x", 10); // expected " "
  s.type("b", 20);
  s.type("q", 30); // expected "\n"
  assert.deepEqual(s.stats(30).perKeyErrors, { " ": 1, "\n": 1 });
});

test("perKeyErrors in the stats is a copy", () => {
  const s = createSession(snip("abc"));
  s.type("x", 0);
  const st = s.stats(0);
  st.perKeyErrors.a = 99;
  st.perKeyErrors.z = 1;
  assert.deepEqual(s.stats(0).perKeyErrors, { a: 1 });
});

test("typed counts distinct positions attempted; keystrokes counts every accepted key", () => {
  const s = createSession(snip("abc"));
  s.type("x", 0);
  s.backspace(1);
  s.type("a", 2);
  const st = s.stats(2);
  assert.equal(st.typed, 1);
  assert.equal(st.keystrokes, 2);
});

// ---- finishing ----

test("reaching the end with a mistake left in the text is not finished until it is fixed", () => {
  const s = createSession(snip("abc"));
  feed(s, "abx", 0, 100);
  assert.equal(s.cursor(), 3);
  assert.equal(s.finished(), false);
  assert.deepEqual(s.type("c", 300), { status: "ignored" }, "nothing to type past the end");
  s.backspace(400);
  assert.equal(s.cursor(), 2);
  s.type("c", 500);
  const st = s.stats(500);
  assert.equal(st.finished, true);
  assert.equal(st.elapsedMs, 500);
  assert.equal(st.errors, 1);
});

test("typing every character wrong reaches the end unfinished; fixing all of them finishes", () => {
  const s = createSession(snip("abc"));
  feed(s, "xyz", 0, 10);
  assert.equal(s.finished(), false);
  for (let i = 0; i < 3; i++) s.backspace(100 + i);
  assert.equal(s.cursor(), 0);
  feed(s, "abc", 200, 10);
  const st = s.stats(220);
  assert.equal(st.finished, true);
  assert.equal(st.errors, 3);
  assert.equal(st.accuracy, 0);
});

test("typing and Backspace after finish are ignored and change nothing", () => {
  const s = createSession(snip("ab"));
  feed(s, "ab", 0, 1000);
  const before = JSON.stringify(s.stats(1000));
  assert.deepEqual(s.type("a", 5000), { status: "ignored" });
  assert.deepEqual(s.backspace(6000), { status: "ignored" });
  assert.deepEqual(s.tab(7000), { status: "ignored" });
  assert.equal(JSON.stringify(s.stats(9000)), before);
  assert.equal(s.cursor(), 2);
});

test("Backspace at position 0 does nothing", () => {
  const s = createSession(snip("abc"));
  assert.deepEqual(s.backspace(0), { status: "ignored" });
  assert.equal(s.cursor(), 0);
  s.type("a", 10);
  s.backspace(20);
  assert.deepEqual(s.backspace(30), { status: "ignored" });
  assert.equal(s.cursor(), 0);
  assert.equal(s.stats(30).correct, 0);
});

test("restart clears the run but keeps the options, and the next run starts a fresh clock", () => {
  const s = createSession(snip("abc"), { stopOnError: true, autoIndent: false });
  s.type("x", 0);
  s.type("a", 10);
  s.restart();
  assert.deepEqual(s.stats(500), {
    wpm: 0, grossWpm: 0, accuracy: 100, errors: 0, correct: 0, typed: 0, keystrokes: 0, elapsedMs: 0, finished: false, perKeyErrors: {},
  });
  assert.equal(s.cursor(), 0);
  assert.equal(s.started(), false);
  assert.deepEqual(s.options(), { autoIndent: false, stopOnError: true });
  feed(s, "abc", 9000, 100);
  assert.equal(s.stats(9200).elapsedMs, 200);
  assert.equal(s.stats(9200).errors, 0);
});

test("a finished session can be restarted and typed again", () => {
  const s = createSession(snip("ab"));
  feed(s, "ab", 0, 10);
  assert.equal(s.finished(), true);
  s.restart();
  assert.equal(s.finished(), false);
  feed(s, "ab", 100, 10);
  assert.equal(s.finished(), true);
});

// ---- stop-on-error ----

test("stop-on-error rejects wrong keys, keeps the cursor, and charges the position once", () => {
  const s = createSession(snip("abc"), { stopOnError: true });
  assert.deepEqual(s.type("x", 0), { status: "rejected" });
  assert.deepEqual(s.type("x", 10), { status: "rejected" });
  assert.deepEqual(s.type("y", 20), { status: "rejected" });
  assert.equal(s.cursor(), 0);
  assert.deepEqual(s.marks(), ["pending", "pending", "pending"]);
  const st = s.stats(20);
  assert.equal(st.errors, 1);
  assert.equal(st.typed, 1);
  assert.equal(st.keystrokes, 3);
  assert.deepEqual(st.perKeyErrors, { a: 1 });
  assert.deepEqual(s.type("a", 30), { status: "correct" });
  assert.equal(s.cursor(), 1);
});

test("stop-on-error: perfect finish after one slip gives the exact accuracy", () => {
  const s = createSession(snip("abc"), { stopOnError: true });
  s.type("a", 0);
  s.type("z", 100);
  s.type("b", 200);
  s.type("c", 300);
  const st = s.stats(300);
  assert.equal(st.finished, true);
  assert.equal(st.errors, 1);
  assert.equal(st.typed, 3);
  assert.equal(st.accuracy, (2 / 3) * 100);
  assert.equal(st.wpm, 3 / 5 / (300 / 60000));
});

test("stop-on-error never stores a wrong character, so a finished run has no wrong marks", () => {
  const s = createSession(snip("abc"), { stopOnError: true });
  for (const ch of "xaybzc") s.type(ch, 0);
  assert.equal(s.finished(), true);
  assert.ok(!s.marks().includes("wrong"));
});

test("stop-on-error still allows Backspace to step back over correct characters", () => {
  const s = createSession(snip("abc"), { stopOnError: true });
  feed(s, "ab", 0, 10);
  assert.deepEqual(s.backspace(30), { status: "deleted", removed: 1 });
  assert.equal(s.cursor(), 1);
});

// ---- auto-indent ----

test("auto-indent skips the indentation after a correct Enter", () => {
  const s = createSession(snip("a\n    b"));
  s.type("a", 0);
  s.type("\n", 10);
  assert.equal(s.cursor(), 6);
  assert.equal(s.expected(), "b");
  assert.deepEqual(s.marks().slice(2, 6), ["skipped", "skipped", "skipped", "skipped"]);
  s.type("b", 20);
  const st = s.stats(20);
  assert.equal(st.finished, true);
  assert.equal(st.correct, 3, "skipped characters are not counted");
  assert.equal(st.typed, 3);
  assert.equal(st.accuracy, 100);
});

test("with auto-indent off the indentation must be typed", () => {
  const s = createSession(snip("a\n  b"), { autoIndent: false });
  feed(s, "a\n", 0, 10);
  assert.equal(s.cursor(), 2);
  assert.equal(s.expected(), " ");
  feed(s, "  b", 20, 10);
  const st = s.stats(40);
  assert.equal(st.finished, true);
  assert.equal(st.correct, 5);
});

test("auto-indent stops at a blank line: the blank line needs its own Enter, then the next line is skipped", () => {
  const s = createSession(snip("a\n  b\n\n  c"));
  feed(s, "a\nb\n", 0, 10); // after "b\n" the cursor sits on the blank line's newline
  assert.equal(s.expected(), "\n");
  assert.equal(s.cursor(), 6);
  s.type("\n", 100);
  assert.equal(s.expected(), "c");
  s.type("c", 110);
  const st = s.stats(110);
  assert.equal(st.finished, true);
  assert.equal(st.correct, 6); // a \n b \n \n c
});

test("auto-indent skips tabs and spaces together, mixed in any order", () => {
  const s = createSession(snip("x\n\t  \ty"));
  s.type("x", 0);
  s.type("\n", 1);
  assert.equal(s.expected(), "y");
  assert.deepEqual(s.marks().slice(2, 6), ["skipped", "skipped", "skipped", "skipped"]);
});

test("auto-indent also skips whitespace on a whitespace-only line but still stops at its newline", () => {
  const s = createSession(snip("a\n  \nb"));
  s.type("a", 0);
  s.type("\n", 1);
  assert.equal(s.expected(), "\n");
  s.type("\n", 2);
  s.type("b", 3);
  assert.equal(s.finished(), true);
});

test("no skipping after a wrong Enter (continue mode)", () => {
  const s = createSession(snip("a\n  b"));
  s.type("a", 0);
  s.type("x", 1); // wrong, expected "\n"
  assert.equal(s.cursor(), 2);
  assert.equal(s.expected(), " ");
  assert.ok(!s.marks().includes("skipped"));
});

test("skipping still happens after a correct Enter even if an earlier mistake is left in the text", () => {
  const s = createSession(snip("abc\n  d"));
  feed(s, "xbc\n", 0, 10);
  assert.equal(s.expected(), "d");
  s.type("d", 100);
  assert.equal(s.finished(), false, "the leftover mistake blocks finishing");
});

test("a skip that runs to the end of the snippet finishes it", () => {
  const s = createSession(snip("a\n  "));
  s.type("a", 0);
  s.type("\n", 100);
  assert.equal(s.finished(), true);
  assert.equal(s.stats(100).elapsedMs, 100);
});

test("one Backspace after an auto-skipped indent removes the indent and the Enter together", () => {
  const s = createSession(snip("a\n    b"));
  feed(s, "a\n", 0, 10);
  assert.equal(s.cursor(), 6);
  assert.deepEqual(s.backspace(100), { status: "deleted", removed: 5 });
  assert.equal(s.cursor(), 1);
  assert.equal(s.expected(), "\n");
  assert.deepEqual(s.marks(), ["correct", "pending", "pending", "pending", "pending", "pending", "pending"]);
  feed(s, "\nb", 200, 10);
  assert.equal(s.finished(), true);
});

test("Backspace on an Enter that had no indentation to skip removes just the Enter", () => {
  const s = createSession(snip("a\nb"));
  feed(s, "a\n", 0, 10);
  assert.deepEqual(s.backspace(50), { status: "deleted", removed: 1 });
  assert.equal(s.cursor(), 1);
});

test("with auto-indent off, Backspace removes one character at a time", () => {
  const s = createSession(snip("a\n  b"), { autoIndent: false });
  feed(s, "a\n  ", 0, 10);
  assert.equal(s.cursor(), 4);
  assert.deepEqual(s.backspace(100), { status: "deleted", removed: 1 });
  assert.equal(s.cursor(), 3);
});

// ---- the Tab key ----

test("Tab types the indent unit when the snippet expects exactly that", () => {
  const s = createSession(snip("if\n    x", "    "), { autoIndent: false });
  feed(s, "if\n", 0, 10);
  assert.deepEqual(s.tab(100), { status: "correct" });
  assert.equal(s.cursor(), 7);
  assert.equal(s.stats(100).errors, 0);
});

test("Tab works with a tab indent unit", () => {
  const s = createSession(snip("{\n\tx", "\t"), { autoIndent: false });
  feed(s, "{\n", 0, 10);
  s.tab(50);
  s.type("x", 60);
  assert.equal(s.finished(), true);
});

test("Tab where the snippet does not expect the indent is ONE wrong key, not several", () => {
  const s = createSession(snip("ab", "    "));
  assert.deepEqual(s.tab(0), { status: "wrong" });
  assert.equal(s.cursor(), 1);
  assert.equal(s.stats(0).errors, 1);
  assert.deepEqual(s.stats(0).perKeyErrors, { a: 1 });
});

test("Tab in stop-on-error mode is rejected when it does not match", () => {
  const s = createSession(snip("ab"), { stopOnError: true });
  assert.deepEqual(s.tab(0), { status: "rejected" });
  assert.equal(s.cursor(), 0);
  assert.equal(s.stats(0).errors, 1);
});

test("a snippet without an indent field uses two spaces for Tab", () => {
  const s = createSession({ code: "a\n  b" }, { autoIndent: false });
  feed(s, "a\n", 0, 1);
  s.tab(5);
  assert.equal(s.cursor(), 4);
});

test("Tab before only part of the indent unit is wrong (all or nothing)", () => {
  const s = createSession(snip("a\n  b", "    "), { autoIndent: false });
  feed(s, "a\n", 0, 1);
  assert.deepEqual(s.tab(5), { status: "wrong" });
});

// ---- misc input handling ----

test("only single characters are accepted by type()", () => {
  const s = createSession(snip("abc"));
  for (const bad of ["ab", "", 7, null, undefined, {}, "\u{1F600}"]) assert.deepEqual(s.type(bad, 0), { status: "ignored" });
  assert.equal(s.cursor(), 0);
});

test("marks() reports pending, correct, wrong and skipped", () => {
  const s = createSession(snip("a\n  bc"));
  feed(s, "x\nb", 0, 1); // wrong, correct newline, skipped, correct
  assert.deepEqual(s.marks(), ["wrong", "correct", "skipped", "skipped", "correct", "pending"]);
});

test("every real snippet reports sane stats at every step of a perfect run", () => {
  for (const sn of snippets) {
    const s = createSession(sn);
    let t = 0;
    while (!s.finished()) {
      s.type(sn.code[s.cursor()], (t += 120));
      const st = s.stats(t);
      assert.ok(st.accuracy === 100 && st.errors === 0, sn.id);
      assert.ok(Number.isFinite(st.wpm) && st.wpm >= 0, sn.id);
    }
  }
});

// ---- seeded random and model-based properties ----

const ALPHABET = "abcxyz XY{}[]()<>=;:\"'\\|&*\n\t~";

function checkInvariants(s, code, ctx) {
  const st = s.stats();
  const n = code.length;
  const marks = s.marks();
  assert.ok(s.cursor() >= 0 && s.cursor() <= n, ctx + ": cursor in range");
  assert.equal(marks.length, n, ctx);
  for (let i = 0; i < n; i++) {
    if (i < s.cursor()) assert.notEqual(marks[i], "pending", ctx + ": behind the cursor nothing is pending");
    else assert.equal(marks[i], "pending", ctx + ": ahead of the cursor everything is pending");
  }
  for (const k of ["wpm", "grossWpm", "accuracy", "errors", "correct", "typed", "keystrokes", "elapsedMs"]) {
    assert.ok(Number.isFinite(st[k]), ctx + ": " + k + " is finite, got " + st[k]);
    assert.ok(st[k] >= 0, ctx + ": " + k + " is not negative");
  }
  assert.ok(st.accuracy >= 0 && st.accuracy <= 100, ctx + ": accuracy within 0..100");
  assert.ok(st.errors <= st.typed && st.typed <= n, ctx + ": errors <= typed <= length");
  assert.ok(st.correct <= st.typed, ctx + ": correct <= typed");
  assert.ok(st.grossWpm >= st.wpm, ctx + ": gross >= net");
  assert.equal(Object.values(st.perKeyErrors).reduce((a, b) => a + b, 0), st.errors, ctx + ": per-key errors add up");
  if (st.finished) {
    assert.equal(s.cursor(), n, ctx + ": finished implies cursor at the end");
    assert.ok(!marks.includes("wrong"), ctx + ": finished implies no wrong characters");
  }
  if (!s.started()) assert.equal(st.elapsedMs, 0, ctx);
  return st;
}

test("seeded random operations never break the invariants (40 seeds x 500 steps, all option combinations)", () => {
  const pool = snippets.concat([snip("a\n\tb\n\n  c\t\n", "\t"), snip("x"), snip("\n\n"), snip(" \t \n \t")]);
  for (let seed = 1; seed <= 40; seed++) {
    const r = rng(seed);
    const sn = pool[Math.floor(r() * pool.length)];
    const opts = { autoIndent: r() < 0.5, stopOnError: r() < 0.5 };
    const s = createSession(sn, opts);
    let t = Math.floor(r() * 1000);
    let prevErrors = 0;
    let wasFinished = false;
    for (let step = 0; step < 500; step++) {
      const ctx = "seed " + seed + " step " + step;
      const roll = r();
      t += Math.floor(r() * 400) - (r() < 0.02 ? 300 : 0); // the clock occasionally goes backwards
      let restarted = false;
      const frozen = wasFinished ? JSON.stringify(s.stats(t)) : null;
      const cursorBefore = s.cursor();
      if (roll < 0.55) {
        const ch = r() < 0.7 && s.expected() !== null ? s.expected() : ALPHABET[Math.floor(r() * ALPHABET.length)];
        s.type(ch, t);
      } else if (roll < 0.8) s.backspace(t);
      else if (roll < 0.9) s.tab(t);
      else if (roll < 0.93) {
        s.restart();
        restarted = true;
      } else s.type(ALPHABET[Math.floor(r() * ALPHABET.length)], t);
      const st = checkInvariants(s, sn.code, ctx);
      if (restarted) prevErrors = 0;
      assert.ok(st.errors >= prevErrors, ctx + ": errors never decrease between restarts");
      prevErrors = st.errors;
      if (wasFinished && !restarted) {
        assert.equal(s.cursor(), cursorBefore, ctx + ": locked after finish");
        assert.equal(JSON.stringify(s.stats(t)), frozen, ctx + ": stats frozen after finish");
      }
      if (opts.stopOnError) assert.ok(!s.marks().includes("wrong"), ctx + ": stop mode never stores wrong characters");
      wasFinished = restarted ? false : st.finished;
    }
  }
});

test("model check: a typist who makes random slips and fixes them ends with exactly the slips the model counted (continue mode)", () => {
  for (let seed = 1; seed <= 20; seed++) {
    const r = rng(1000 + seed);
    for (const sn of snippets) {
      const s = createSession(sn, { autoIndent: r() < 0.5 });
      const slipped = new Set();
      const attempted = new Set();
      let t = 0;
      while (!s.finished()) {
        const cursor = s.cursor();
        if (r() < 0.15) {
          const k = 1 + Math.floor(r() * 3);
          for (let i = 0; i < k && s.cursor() < sn.code.length; i++) {
            slipped.add(s.cursor());
            attempted.add(s.cursor());
            s.type("~", (t += 100));
          }
          while (s.cursor() > cursor) s.backspace((t += 100));
        }
        attempted.add(s.cursor());
        s.type(sn.code[s.cursor()], (t += 100));
      }
      const st = s.stats(t);
      assert.equal(st.errors, slipped.size, sn.id + " seed " + seed);
      assert.equal(st.finished, true);
      // `typed` is every position attempted at least once. With auto-indent on, a slip made over indentation positions
      // keeps those positions charged even though the correct Enter later skips them.
      assert.equal(st.typed, attempted.size, sn.id + " seed " + seed);
      assert.equal(st.accuracy, ((attempted.size - slipped.size) / attempted.size) * 100);
    }
  }
});

test("model check: stop-on-error with random wrong keys charges each position at most once", () => {
  for (let seed = 1; seed <= 20; seed++) {
    const r = rng(2000 + seed);
    for (const sn of snippets) {
      const s = createSession(sn, { stopOnError: true });
      const slipped = new Set();
      let t = 0;
      while (!s.finished()) {
        const pos = s.cursor();
        const wrongTimes = r() < 0.12 ? 1 + Math.floor(r() * 3) : 0;
        for (let i = 0; i < wrongTimes; i++) {
          assert.equal(s.type("~", (t += 100)).status, "rejected");
          slipped.add(pos);
          assert.equal(s.cursor(), pos);
        }
        s.type(sn.code[pos], (t += 100));
      }
      const st = s.stats(t);
      assert.equal(st.errors, slipped.size, sn.id + " seed " + seed);
      assert.ok(st.keystrokes >= st.typed);
    }
  }
});
