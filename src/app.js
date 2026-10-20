// Browser UI. Pure logic lives in session.js and lib.js (both tested in Node); this file only touches the DOM,
// reads the clock (performance.now) and talks to localStorage. All text goes in through textContent; no HTML strings are ever parsed.
(function () {
  "use strict";

  const snippets = window.TypingSnippets;
  const lib = window.TypingLib;
  const Session = window.TypingSession;

  let storage = null;
  try {
    storage = window.localStorage;
  } catch (e) {
    storage = null; // blocked (private mode, disabled cookies): history then lasts for this page load only
  }
  const store = lib.createStore(storage);

  const $ = (id) => document.getElementById(id);
  const el = {
    language: $("filter-language"),
    difficulty: $("filter-difficulty"),
    select: $("snippet-select"),
    random: $("random"),
    restart: $("restart"),
    autoIndent: $("opt-auto-indent"),
    stopOnError: $("opt-stop-on-error"),
    showHint: $("opt-show-hint"),
    wpm: $("stat-wpm"),
    accuracy: $("stat-accuracy"),
    errors: $("stat-errors"),
    time: $("stat-time"),
    title: $("snippet-title"),
    lang: $("snippet-language"),
    diff: $("snippet-difficulty"),
    best: $("snippet-best"),
    typing: $("typing"),
    code: $("code"),
    hint: $("next-hint"),
    srStatus: $("sr-status"),
    results: $("results"),
    clearHistory: $("clear-history"),
    historyEmpty: $("history-empty"),
    historyTable: $("history-table"),
    historyBody: $("history-body"),
  };

  const clock = () => performance.now();
  const focusTyping = () => el.typing.focus({ preventScroll: true }); // no page jump when a button hands focus to the typing area

  let current = null;
  let session = null;
  let spans = [];
  let lastClass = [];
  let rejectedAt = null; // stop-on-error: position of the key that was just refused, shown red until the next key
  let timer = null;
  let resultsShown = false;
  let clearTimer = null;

  function node(tag, props, children) {
    const n = document.createElement(tag);
    if (props) Object.keys(props).forEach((k) => (k === "text" ? (n.textContent = props[k]) : n.setAttribute(k, props[k])));
    (children || []).forEach((c) => n.appendChild(typeof c === "string" ? document.createTextNode(c) : c));
    return n;
  }

  function cap(s) {
    return s.charAt(0).toUpperCase() + s.slice(1);
  }

  // ---- snippet picker ----

  function filter() {
    return { language: el.language.value, difficulty: el.difficulty.value };
  }

  function matching() {
    const f = filter();
    return snippets.filter((s) => (!f.language || s.language === f.language) && (!f.difficulty || s.difficulty === f.difficulty));
  }

  function renderPicker() {
    const list = matching();
    el.select.replaceChildren();
    list.forEach((s) => el.select.appendChild(node("option", { value: s.id, text: s.title + " (" + s.language + ", " + s.difficulty + ")" })));
    if (list.length === 0) el.select.appendChild(node("option", { value: "", text: "No snippet matches these filters" }));
    if (current && list.some((s) => s.id === current.id)) el.select.value = current.id;
    el.random.disabled = list.length === 0;
  }

  // ---- the typing area ----

  function buildCode() {
    el.code.replaceChildren();
    spans = [];
    lastClass = [];
    for (let i = 0; i < current.code.length; i++) {
      const ch = current.code[i];
      const span = node("span", { class: "ch", text: ch === "\n" ? "↵" : ch });
      if (ch === "\n") span.classList.add("nl");
      el.code.appendChild(span);
      spans.push(span);
      lastClass.push("ch");
      if (ch === "\n") el.code.appendChild(document.createElement("br"));
    }
  }

  const MARK_CLASS = { pending: "", correct: " ok", wrong: " bad", skipped: " skip" };

  function renderCode() {
    const marks = session.marks();
    const cur = session.cursor();
    for (let i = 0; i < spans.length; i++) {
      let cls = "ch" + MARK_CLASS[marks[i]];
      if (current.code[i] === "\n") cls += " nl";
      if (i === cur && !session.finished()) cls += " cur" + (rejectedAt === i ? " bad" : "");
      if (cls !== lastClass[i]) {
        spans[i].className = cls;
        lastClass[i] = cls;
      }
    }
    const next = session.expected();
    el.hint.replaceChildren();
    if (store.prefs().showHint && next !== null && !session.finished()) {
      el.hint.appendChild(document.createTextNode("Next: "));
      el.hint.appendChild(node("kbd", { text: lib.displayChar(next) }));
    }
  }

  function renderStats() {
    const s = session.stats(clock());
    el.wpm.textContent = lib.liveWpmLabel(s);
    el.accuracy.textContent = lib.formatPercent(s.accuracy);
    el.errors.textContent = String(s.errors);
    el.time.textContent = lib.formatDuration(s.elapsedMs);
  }

  function renderBest() {
    const b = store.best(current.id);
    el.best.textContent = b ? "Your best: " + lib.formatWpm(b.wpm) + " WPM at " + lib.formatPercent(b.accuracy) : "No personal best yet";
  }

  function startTimer() {
    if (timer === null) timer = setInterval(tick, 100);
  }

  function stopTimer() {
    clearInterval(timer);
    timer = null;
  }

  function tick() {
    if (session.finished() || !session.started()) return stopTimer();
    renderStats();
  }

  function choose(id) {
    const s = snippets.find((x) => x.id === id) || snippets[0];
    current = s;
    el.title.textContent = s.title;
    el.lang.textContent = s.language;
    el.diff.textContent = s.difficulty;
    el.diff.className = "badge " + s.difficulty;
    renderPicker();
    renderBest();
    buildCode();
    newRun();
  }

  function newRun() {
    stopTimer();
    session = Session.createSession(current, store.prefs());
    rejectedAt = null;
    resultsShown = false;
    el.results.hidden = true;
    el.results.replaceChildren();
    renderCode();
    renderStats();
  }

  function restart() {
    if (session.started() || resultsShown) newRun();
    else rejectedAt = null;
    focusTyping();
    el.srStatus.textContent = "Restarted";
  }

  // ---- keyboard ----

  function onKeyDown(ev) {
    const act = lib.keyToAction(ev);
    if (!act) return;
    if (act.action === "tab" && session.finished()) return; // let Tab reach the buttons on the results screen
    ev.preventDefault();
    const now = clock();
    if (act.action === "restart") return restart();
    let res;
    if (act.action === "type") res = session.type(act.char, now);
    else if (act.action === "tab") res = session.tab(now);
    else res = session.backspace(now);
    rejectedAt = res.status === "rejected" ? session.cursor() : null;
    if (session.started() && !session.finished()) startTimer();
    renderCode();
    renderStats();
    if (session.finished() && !resultsShown) finish(now);
  }

  // ---- results and history ----

  function stat(label, value) {
    return node("div", { class: "stat" }, [node("span", { class: "label", text: label }), node("span", { class: "value", text: value })]);
  }

  function verdictFor(cmp) {
    if (cmp.kind === "first") return { cls: "good", text: "First run on this snippet: saved as your personal best." };
    if (cmp.kind === "new-best") return { cls: "good", text: "New personal best: +" + lib.formatWpm(cmp.wpmDelta) + " WPM over " + lib.formatWpm(cmp.previous.wpm) + " WPM." };
    if (cmp.kind === "tie") return { cls: "", text: "You matched your personal best exactly (" + lib.formatWpm(cmp.previous.wpm) + " WPM)." };
    return { cls: "", text: "Your personal best is " + lib.formatWpm(cmp.previous.wpm) + " WPM at " + lib.formatPercent(cmp.previous.accuracy) + "; this run was " + lib.formatWpm(-cmp.wpmDelta) + " WPM lower." };
  }

  function finish(now) {
    resultsShown = true;
    stopTimer();
    const s = session.stats(now);
    const saved = store.addResult({ id: current.id, language: current.language, wpm: s.wpm, accuracy: s.accuracy, elapsedMs: s.elapsedMs, errors: s.errors, at: new Date().toISOString() });
    renderStats();
    renderBest();
    renderHistory();

    const box = el.results;
    box.replaceChildren();
    box.appendChild(node("h2", { text: "Results: " + current.title }));
    box.appendChild(node("div", { class: "big" }, [stat("WPM", lib.formatWpm(s.wpm)), stat("Accuracy", lib.formatPercent(s.accuracy)), stat("Time", lib.formatDuration(s.elapsedMs)), stat("Errors", String(s.errors))]));
    if (saved.comparison) {
      const v = verdictFor(saved.comparison);
      box.appendChild(node("p", { class: "verdict " + v.cls, id: "verdict", text: v.text }));
    }
    if (saved.saved && !saved.persisted) box.appendChild(node("p", { class: "muted", text: "Local storage is unavailable or full, so this run is kept only until you close the page." }));

    box.appendChild(node("h3", { text: "Characters you missed most" }));
    const missed = lib.topMistyped(s.perKeyErrors, 8);
    if (missed.length === 0) box.appendChild(node("p", { class: "muted", text: "No mistakes on this run." }));
    else {
      const body = node("tbody");
      missed.forEach((m) => body.appendChild(node("tr", {}, [node("td", { class: "mono", text: m.label }), node("td", { text: String(m.count) })])));
      box.appendChild(node("table", { class: "grid", id: "missed-table" }, [node("thead", {}, [node("tr", {}, [node("th", { text: "Expected key" }), node("th", { text: "Missed" })])]), body]));
    }

    const again = node("button", { type: "button", class: "primary", text: "Try again" });
    again.addEventListener("click", () => restart());
    const next = node("button", { type: "button", text: "Next random snippet" });
    next.addEventListener("click", () => randomSnippet());
    box.appendChild(node("div", { class: "actions" }, [again, next]));
    box.hidden = false;
    el.srStatus.textContent = "Finished. " + lib.formatWpm(s.wpm) + " words per minute, " + lib.formatPercent(s.accuracy) + " accuracy.";
  }

  function titleOf(id) {
    const s = snippets.find((x) => x.id === id);
    return s ? s.title : id;
  }

  function renderHistory() {
    const rows = store.history().slice(-10).reverse();
    el.historyBody.replaceChildren();
    rows.forEach((r) => {
      const when = r.at ? r.at.slice(0, 16).replace("T", " ") : "";
      el.historyBody.appendChild(
        node("tr", {}, [
          node("td", { text: titleOf(r.id) }),
          node("td", { class: "mono", text: lib.formatWpm(r.wpm) }),
          node("td", { class: "mono", text: lib.formatPercent(r.accuracy) }),
          node("td", { class: "mono", text: lib.formatDuration(r.elapsedMs) }),
          node("td", { class: "mono", text: String(r.errors) }),
          node("td", { text: when }),
        ])
      );
    });
    el.historyTable.hidden = rows.length === 0;
    el.historyEmpty.hidden = rows.length > 0;
  }

  function randomSnippet() {
    const s = lib.pickSnippet(snippets, filter(), Math.random, current && current.id);
    if (s) choose(s.id);
    focusTyping();
  }

  // ---- wiring ----

  function wire() {
    lib.LANGUAGES.forEach((l) => el.language.appendChild(node("option", { value: l, text: cap(l) })));
    const p = store.prefs();
    el.autoIndent.checked = p.autoIndent;
    el.stopOnError.checked = p.stopOnError;
    el.showHint.checked = p.showHint;

    function onFilter() {
      const list = matching();
      if (list.length && !list.some((s) => s.id === current.id)) choose(list[0].id);
      else renderPicker();
    }
    el.language.addEventListener("change", onFilter);
    el.difficulty.addEventListener("change", onFilter);
    el.select.addEventListener("change", () => {
      if (el.select.value) choose(el.select.value);
      focusTyping();
    });
    el.random.addEventListener("click", randomSnippet);
    el.restart.addEventListener("click", restart);

    el.autoIndent.addEventListener("change", () => {
      store.setPrefs({ autoIndent: el.autoIndent.checked });
      newRun(); // options are fixed for the length of a run, so changing one starts a fresh run
      focusTyping();
    });
    el.stopOnError.addEventListener("change", () => {
      store.setPrefs({ stopOnError: el.stopOnError.checked });
      newRun();
      focusTyping();
    });
    el.showHint.addEventListener("change", () => {
      store.setPrefs({ showHint: el.showHint.checked });
      renderCode();
      focusTyping();
    });

    el.typing.addEventListener("keydown", onKeyDown);
    el.clearHistory.addEventListener("click", () => {
      if (clearTimer === null) {
        el.clearHistory.textContent = "Click again to clear";
        clearTimer = setTimeout(resetClear, 4000);
        return;
      }
      resetClear();
      store.clearHistory();
      renderHistory();
      renderBest();
    });
  }

  function resetClear() {
    clearTimeout(clearTimer);
    clearTimer = null;
    el.clearHistory.textContent = "Clear history";
  }

  wire();
  renderHistory();
  choose(snippets[0].id);
})();
