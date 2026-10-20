const test = require("node:test");
const assert = require("node:assert/strict");
const { createServer, resolveRequest } = require("../scripts/serve.js");

test("resolveRequest serves the app and refuses everything else", () => {
  assert.ok(resolveRequest("/").endsWith("index.html"));
  assert.ok(resolveRequest("/src/session.js").endsWith("session.js"));
  assert.ok(resolveRequest("/index.html?x=1#y").endsWith("index.html"));
  for (const bad of ["/package.json", "/test/session.test.js", "/.git/config", "/../package.json", "/src/../package.json", "/%2e%2e/package.json", "/src/%00.js", "/%E0%A4%A", "/scripts/serve.js", "/docs/screenshot.png", "/README.md"]) {
    assert.equal(resolveRequest(bad), null, bad);
  }
});

test("the server returns the page and scripts with the right types, and 404 or 405 otherwise", async () => {
  const server = createServer();
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const base = "http://127.0.0.1:" + server.address().port;
  try {
    const page = await fetch(base + "/");
    assert.equal(page.status, 200);
    assert.match(page.headers.get("content-type"), /text\/html/);
    assert.match(await page.text(), /<title>Code Typing Trainer<\/title>/);

    const js = await fetch(base + "/src/session.js");
    assert.match(js.headers.get("content-type"), /text\/javascript/);
    const css = await fetch(base + "/src/styles.css");
    assert.match(css.headers.get("content-type"), /text\/css/);
    assert.equal(css.headers.get("x-content-type-options"), "nosniff");

    assert.equal((await fetch(base + "/package.json")).status, 404);
    assert.equal((await fetch(base + "/src/missing.js")).status, 404);
    assert.equal((await fetch(base + "/", { method: "POST" })).status, 405);
    assert.equal((await fetch(base + "/", { method: "HEAD" })).status, 200);
  } finally {
    await new Promise((r) => server.close(r));
  }
});

test("every script the page loads is served", async () => {
  const fs = require("node:fs");
  const path = require("node:path");
  const html = fs.readFileSync(path.join(__dirname, "..", "index.html"), "utf8");
  const refs = [...html.matchAll(/(?:src|href)="(src\/[^"]+)"/g)].map((m) => m[1]);
  assert.ok(refs.length >= 5, "found " + refs.length + " references");
  const server = createServer();
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const base = "http://127.0.0.1:" + server.address().port;
  try {
    for (const ref of refs) assert.equal((await fetch(base + "/" + ref)).status, 200, ref);
  } finally {
    await new Promise((r) => server.close(r));
  }
});
