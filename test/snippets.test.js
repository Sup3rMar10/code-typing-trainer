const test = require("node:test");
const assert = require("node:assert/strict");
const vm = require("node:vm");
const snippets = require("../src/snippets.js");
const { validateSnippet, validateSnippets, keyToAction, LANGUAGES, DIFFICULTIES } = require("../src/lib.js");
const { createSession } = require("../src/session.js");

test("there are at least 14 snippets and the set validates as a whole (unique ids included)", () => {
  assert.ok(snippets.length >= 14, "have " + snippets.length);
  assert.deepEqual(validateSnippets(snippets), []);
  assert.equal(new Set(snippets.map((s) => s.id)).size, snippets.length);
  assert.equal(new Set(snippets.map((s) => s.code)).size, snippets.length, "no two snippets have the same text");
});

test("every language and every difficulty is represented", () => {
  for (const l of LANGUAGES) assert.ok(snippets.some((s) => s.language === l), "no " + l + " snippet");
  for (const d of DIFFICULTIES) assert.ok(snippets.filter((s) => s.difficulty === d).length >= 3, "too few " + d + " snippets");
});

test("between them the snippets use the symbols a programmer needs", () => {
  const all = snippets.map((s) => s.code).join("\n");
  for (const ch of "{}[]()<>=;:\"'\\|&*`$#/-+%!,._") assert.ok(all.includes(ch), "no snippet contains " + JSON.stringify(ch));
  assert.ok(all.includes("=>"), "an arrow");
  assert.ok(all.includes("\t"), "a real tab");
  assert.ok(snippets.some((s) => s.code.includes("\n\n")), "a blank line");
  assert.ok(snippets.some((s) => s.indent === "\t") && snippets.some((s) => s.indent === "    ") && snippets.some((s) => s.indent === "  "));
});

test("the JSON snippet is valid JSON and the JavaScript snippets are at least syntactically valid", () => {
  const json = snippets.find((s) => s.language === "json");
  assert.doesNotThrow(() => JSON.parse(json.code));
  assert.equal(JSON.parse(json.code).path, "C:\\data\\logs", "the backslashes survive");
  for (const s of snippets.filter((x) => x.language === "javascript")) {
    assert.doesNotThrow(() => new vm.Script(s.code, { filename: s.id }), s.id); // compiled, never run
  }
});

for (const sn of snippets) {
  test("snippet " + sn.id + " is valid", () => {
    assert.deepEqual(validateSnippet(sn), []);
    assert.ok(sn.code.length > 0);
    assert.ok(!sn.code.endsWith("\n"));
    assert.ok(!/[ \t]+$/m.test(sn.code), "no trailing whitespace");
    assert.ok(!/[^\x20-\x7e\n\t]/.test(sn.code), "only keys the handler can produce");
  });

  test("snippet " + sn.id + ": a scripted perfect typist finishes with 100% accuracy and 0 errors, auto-indent on and off", () => {
    for (const autoIndent of [true, false]) {
      const s = createSession(sn, { autoIndent: autoIndent });
      let t = 0;
      let guard = 0;
      while (!s.finished()) {
        assert.ok(guard++ < sn.code.length, "typist is stuck");
        s.type(sn.code[s.cursor()], (t += 150));
      }
      const st = s.stats(t);
      assert.equal(st.accuracy, 100, sn.id + " autoIndent=" + autoIndent);
      assert.equal(st.errors, 0);
      assert.equal(st.finished, true);
      assert.deepEqual(st.perKeyErrors, {});
      assert.equal(st.correct, st.typed);
      if (autoIndent) assert.ok(s.marks().includes("skipped") || !/\n[ \t]/.test(sn.code), "indented lines were skipped");
      else assert.ok(!s.marks().includes("skipped"));
    }
  });

  test("snippet " + sn.id + ": typed through real key events (Enter, Tab for whole indent units), in both modes and in stop-on-error mode", () => {
    for (const opts of [{ autoIndent: true }, { autoIndent: false }, { autoIndent: false, stopOnError: true }]) {
      const s = createSession(sn, opts);
      let t = 0;
      let guard = 0;
      while (!s.finished()) {
        assert.ok(guard++ < sn.code.length, "typist is stuck");
        const c = s.cursor();
        let ev;
        if (sn.code[c] === "\n") ev = { key: "Enter" };
        else if (sn.code.startsWith(sn.indent, c) && (c === 0 || sn.code[c - 1] === "\n" || sn.code[c - 1] === " " || sn.code[c - 1] === "\t")) ev = { key: "Tab" };
        else ev = { key: sn.code[c], shiftKey: /[A-Z{}<>?:"|~!@#$%^&*()_+]/.test(sn.code[c]) };
        const act = keyToAction(ev);
        assert.ok(act, "the key handler must produce " + JSON.stringify(sn.code[c]));
        t += 150;
        const res = act.action === "tab" ? s.tab(t) : act.action === "type" ? s.type(act.char, t) : null;
        assert.equal(res && res.status, "correct", sn.id + " at " + c);
      }
      assert.equal(s.stats(t).errors, 0);
      assert.equal(s.stats(t).accuracy, 100);
    }
  });
}
