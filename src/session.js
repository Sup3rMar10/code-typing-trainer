// Typing-session state machine. No DOM, no timers, no Date: the caller passes the time in (`now`, milliseconds).
// Loaded as a plain script in the page and with require() in the Node tests.
//
// Rules (all of them are covered by test/session.test.js):
//
//  Position      The snippet is one string. `cursor` is the index of the next character to type, 0..length.
//  Keystrokes    type(char, now) takes ONE character; "\n" is Enter. tab(now) is the Tab key: it types the snippet's
//                indent unit if the snippet expects exactly that next, otherwise it counts as one wrong "\t".
//  Wrong keys    Default (continue mode): a wrong character is stored, marked wrong, and the cursor moves on.
//                Stop-on-error mode: a wrong character is rejected, the cursor stays, the position is still charged an error.
//  Error         The first wrong attempt at a position counts as ONE error for that position, per run (restart() clears
//                the run). Correcting it with Backspace does not remove the error, and repeated wrong attempts at the same
//                position do not add more. perKeyErrors counts that error under the EXPECTED character (what you missed).
//  Accuracy      100 * (attempted - errors) / attempted, where `attempted` (reported as `typed`) is the number of distinct
//                positions you have attempted at least once this run. 100 when nothing has been attempted yet.
//  WPM           Standard: correct characters / 5 per minute. `correct` is the number of positions that currently hold a
//                correct character you typed. WPM is 0 while elapsed time is 0 (never NaN or Infinity).
//                grossWpm uses every character currently in the buffer, wrong ones included.
//  Clock         Starts at the first accepted keystroke (not at createSession, and not for Backspace or ignored input).
//                Stops at the keystroke that completes the snippet. elapsedMs is clamped to >= 0 if the caller's clock
//                goes backwards. The first character is therefore "free": it starts the clock but spends no time.
//  Finished      cursor === length AND no wrong character remains in the buffer. In continue mode you can reach the end with
//                mistakes; then the session is not finished until Backspace and retyping fix them.
//  After finish  type, tab and backspace are ignored (results are locked) until restart().
//  Backspace     Ignored at position 0 (no clock start). Otherwise it removes one character, except that it removes an
//                auto-skipped indentation run together with the Enter that triggered it, so one Backspace undoes one Enter.
//  Auto-indent   With autoIndent on (default), after a CORRECT Enter every following space or tab is skipped and marked
//                "skipped". Skipping stops at the first non-whitespace character or at "\n", so a blank line still needs its
//                own Enter. Spaces and tabs are both skipped, mixed or not. Skipped characters count toward neither WPM nor
//                accuracy. After a wrong Enter (continue mode) nothing is skipped.
(function (root, factory) {
  if (typeof module === "object" && module.exports) module.exports = factory();
  else root.TypingSession = factory();
})(typeof self !== "undefined" ? self : this, function () {
  "use strict";

  const PENDING = 0;
  const CORRECT = 1;
  const WRONG = 2;
  const SKIPPED = 3;
  const MARK_NAMES = ["pending", "correct", "wrong", "skipped"];

  function checkNow(now) {
    if (typeof now !== "number" || !Number.isFinite(now)) throw new TypeError("now must be a finite number of milliseconds");
  }

  function createSession(snippet, options) {
    if (!snippet || typeof snippet.code !== "string" || snippet.code.length === 0) throw new TypeError("snippet.code must be a non-empty string");
    const code = snippet.code;
    const n = code.length;
    const indent = typeof snippet.indent === "string" && snippet.indent.length > 0 ? snippet.indent : "  ";
    const opts = {
      autoIndent: !options || options.autoIndent === undefined ? true : Boolean(options.autoIndent),
      stopOnError: Boolean(options && options.stopOnError),
    };

    let marks, attempted, errorAt, perKey, cursor, attemptedCount, errorCount, keystrokes, startAt, endAt, lastNow;

    function reset() {
      marks = new Array(n).fill(PENDING);
      attempted = new Array(n).fill(false);
      errorAt = new Array(n).fill(false);
      perKey = Object.create(null);
      cursor = 0;
      attemptedCount = 0;
      errorCount = 0;
      keystrokes = 0;
      startAt = null;
      endAt = null;
      lastNow = 0;
    }
    reset();

    function wrongCount() {
      let w = 0;
      for (let i = 0; i < cursor; i++) if (marks[i] === WRONG) w++;
      return w;
    }

    function isFinished() {
      return cursor === n && wrongCount() === 0;
    }

    function skipIndent() {
      while (cursor < n && (code[cursor] === " " || code[cursor] === "\t")) {
        marks[cursor] = SKIPPED;
        cursor++;
      }
    }

    function charge(position) {
      if (!attempted[position]) {
        attempted[position] = true;
        attemptedCount++;
      }
    }

    function recordError(position) {
      if (errorAt[position]) return;
      errorAt[position] = true;
      errorCount++;
      const k = code[position];
      perKey[k] = (perKey[k] || 0) + 1;
    }

    // Returns { status } with status one of: "correct", "wrong" (stored, continue mode), "rejected" (stop mode),
    // "ignored" (finished, invalid input, or nothing left to type).
    function type(ch, now) {
      checkNow(now);
      if (isFinished() || typeof ch !== "string" || ch.length !== 1 || cursor >= n) return { status: "ignored" };
      if (startAt === null) startAt = now;
      lastNow = now;
      keystrokes++;
      const pos = cursor;
      charge(pos);
      if (ch === code[pos]) {
        marks[pos] = CORRECT;
        cursor++;
        if (ch === "\n" && opts.autoIndent) skipIndent();
        if (isFinished()) endAt = now;
        return { status: "correct" };
      }
      recordError(pos);
      if (opts.stopOnError) return { status: "rejected" };
      marks[pos] = WRONG;
      cursor++;
      return { status: "wrong" };
    }

    function tab(now) {
      checkNow(now);
      if (isFinished() || cursor >= n) return { status: "ignored" };
      if (code.startsWith(indent, cursor)) {
        let last = { status: "ignored" };
        for (let i = 0; i < indent.length; i++) last = type(indent[i], now);
        return last;
      }
      return type("\t", now);
    }

    function backspace(now) {
      checkNow(now);
      if (isFinished() || cursor === 0) return { status: "ignored" };
      lastNow = now;
      let removed = 0;
      if (marks[cursor - 1] === SKIPPED) {
        while (cursor > 0 && marks[cursor - 1] === SKIPPED) {
          marks[--cursor] = PENDING;
          removed++;
        }
        if (cursor > 0 && code[cursor - 1] === "\n") {
          marks[--cursor] = PENDING;
          removed++;
        }
      } else {
        marks[--cursor] = PENDING;
        removed = 1;
      }
      return { status: "deleted", removed: removed };
    }

    function restart() {
      reset();
    }

    function stats(now) {
      if (now !== undefined) checkNow(now);
      const t = now === undefined ? lastNow : now;
      let correct = 0;
      let buffered = 0;
      for (let i = 0; i < cursor; i++) {
        if (marks[i] === CORRECT) {
          correct++;
          buffered++;
        } else if (marks[i] === WRONG) buffered++;
      }
      let elapsedMs = 0;
      if (startAt !== null) elapsedMs = Math.max(0, (endAt !== null ? endAt : t) - startAt);
      const minutes = elapsedMs / 60000;
      const perKeyErrors = {};
      Object.keys(perKey).forEach((k) => (perKeyErrors[k] = perKey[k]));
      return {
        wpm: elapsedMs > 0 ? correct / 5 / minutes : 0,
        grossWpm: elapsedMs > 0 ? buffered / 5 / minutes : 0,
        accuracy: attemptedCount === 0 ? 100 : ((attemptedCount - errorCount) / attemptedCount) * 100,
        errors: errorCount,
        correct: correct,
        typed: attemptedCount,
        keystrokes: keystrokes,
        elapsedMs: elapsedMs,
        finished: isFinished(),
        perKeyErrors: perKeyErrors,
      };
    }

    return {
      type: type,
      tab: tab,
      backspace: backspace,
      restart: restart,
      stats: stats,
      cursor: () => cursor,
      length: n,
      started: () => startAt !== null,
      finished: isFinished,
      options: () => Object.assign({}, opts),
      expected: () => (cursor < n ? code[cursor] : null),
      // One entry per character: "pending", "correct", "wrong" or "skipped".
      marks: () => marks.map((m) => MARK_NAMES[m]),
    };
  }

  return { createSession: createSession };
});
