const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const root = path.join(__dirname, "..");
const read = (p) => fs.readFileSync(path.join(root, p), "utf8");
const html = read("index.html");
const app = read("src/app.js");

// There is no DOM in Node, so these are static checks on the page source. They do not replace the manual browser check.

test("the UI code builds DOM nodes only through createElement/textContent: no HTML-string APIs", () => {
  for (const file of ["src/app.js", "src/session.js", "src/lib.js", "src/snippets.js"]) {
    const src = read(file);
    for (const banned of ["innerHTML", "outerHTML", "insertAdjacentHTML", "document.write", "eval(", "new Function"]) {
      assert.ok(!src.includes(banned), file + " uses " + banned);
    }
  }
});

test("every element id that app.js looks up exists in index.html", () => {
  const ids = [...app.matchAll(/\$\("([a-z0-9-]+)"\)/g)].map((m) => m[1]);
  assert.ok(ids.length >= 25, "found " + ids.length + " lookups");
  for (const id of new Set(ids)) assert.ok(html.includes('id="' + id + '"'), "index.html has no #" + id);
});

test("index.html has no duplicate ids and loads the scripts in dependency order", () => {
  const ids = [...html.matchAll(/\sid="([^"]+)"/g)].map((m) => m[1]);
  assert.equal(new Set(ids).size, ids.length, "duplicate ids");
  const order = [...html.matchAll(/<script src="src\/([a-z]+\.js)"/g)].map((m) => m[1]);
  assert.deepEqual(order, ["snippets.js", "session.js", "lib.js", "app.js"]);
});

test("the globals app.js reads are the ones the UMD modules publish", () => {
  assert.match(app, /window\.TypingSnippets/);
  assert.match(app, /window\.TypingLib/);
  assert.match(app, /window\.TypingSession/);
  assert.match(read("src/snippets.js"), /root\.TypingSnippets = factory/);
  assert.match(read("src/lib.js"), /root\.TypingLib = factory/);
  assert.match(read("src/session.js"), /root\.TypingSession = factory/);
});

test("the page follows the system theme and does not pull anything from the network", () => {
  assert.match(read("src/styles.css"), /prefers-color-scheme: dark/);
  assert.match(html, /name="color-scheme" content="light dark"/);
  for (const file of ["index.html", "src/app.js", "src/styles.css", "src/lib.js", "src/session.js"]) {
    assert.ok(!/https?:\/\//.test(read(file)), file + " references a URL");
  }
});

test("package.json has no dependencies and the documented scripts", () => {
  const pkg = JSON.parse(read("package.json"));
  assert.equal(pkg.dependencies, undefined);
  assert.equal(pkg.devDependencies, undefined);
  assert.equal(pkg.scripts.test, "node --test");
  assert.equal(pkg.scripts.start, "node scripts/serve.js");
});
