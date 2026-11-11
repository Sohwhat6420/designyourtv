import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { quietHub, raw, tmpDir } from "./helpers.mjs";
import { resolveSafe } from "../lib/http-util.mjs";

// A small project tree so the test never depends on the real plates.
const root = tmpDir("root");
for (const [f, s] of Object.entries({
  "tv-setup.html": "<!doctype html><title>t</title>", "plates/placeholder.plate.webp": "RIFFxxxxWEBP", "icons/a.png": "png",
  "data/claude-activity.json": "{}", "refs/secret.txt": "no", "masters/m.png": "no", "models/x.onnx": "no", "plates-4k/a.webp": "RIFFxxxxWEBP", "plates-4k/a.scene.png": "no",
  "mockup/a.html": "no", "research/a.md": "no", "tools/a.py": "no", "hub/state/config.json": "{\"secret\":1}", ".env": "KEY=1", "plates/.hidden": "no",
})) { fs.mkdirSync(path.join(root, path.dirname(f)), { recursive: true }); fs.writeFileSync(path.join(root, f), s); }

const hub = await quietHub({ root });
test.after(() => hub.close());

test("pages and plates are served with the right type, ETag and Last-Modified", async () => {
  const r = await raw(hub.port, "/tv-setup.html");
  assert.equal(r.status, 200);
  assert.match(r.headers["content-type"], /^text\/html/);
  assert.ok(r.headers.etag && r.headers["last-modified"]);
  const p = await raw(hub.port, "/plates/placeholder.plate.webp");
  assert.equal(p.status, 200); assert.equal(p.headers["content-type"], "image/webp");
  const hd = await raw(hub.port, "/plates-4k/a.webp");             // the laptops' 4K plates (webp only; the PNGs are denied below)
  assert.equal(hd.status, 200); assert.equal(hd.headers["content-type"], "image/webp");
  const again = await raw(hub.port, "/plates/placeholder.plate.webp", { headers: { "if-none-match": p.headers.etag } });
  assert.equal(again.status, 304);
  const lm = await raw(hub.port, "/tv-setup.html", { headers: { "if-modified-since": r.headers["last-modified"] } });
  assert.equal(lm.status, 304);
  const head = await raw(hub.port, "/tv-setup.html", { method: "HEAD" });
  assert.equal(head.status, 200); assert.equal(head.body, "");
  const range = await raw(hub.port, "/plates/placeholder.plate.webp", { headers: { range: "bytes=0-3" } });
  assert.equal(range.status, 206); assert.equal(range.body, "RIFF");
});

test("denied folders, state and dotfiles are 404", async () => {
  for (const p of ["/refs/secret.txt", "/masters/m.png", "/models/x.onnx", "/plates-4k/a.scene.png", "/mockup/a.html", "/research/a.md",
    "/tools/a.py", "/hub/state/config.json", "/.env", "/plates/.hidden", "/REFS/secret.txt", "/Hub/State/config.json", "/refs./secret.txt", "/refs%20/secret.txt"]) {
    const r = await raw(hub.port, p);
    assert.equal(r.status, 404, p);
    assert.doesNotMatch(r.body, /secret|KEY=/, p);
  }
});

test("path traversal is refused in every spelling", async () => {
  for (const p of ["/../hub/state/config.json", "/plates/../../etc/passwd", "/plates/../hub/state/config.json", "/%2e%2e/hub/state/config.json",
    "/plates/%2E%2E/%2e%2e/x", "/plates%2f..%2f..%2fhub%2fstate%2fconfig.json", "/plates/..%5c..%5chub%5cstate%5cconfig.json", "/plates\\..\\hub\\state\\config.json",
    "/%252e%252e/hub/state/config.json", "/tv-setup.html::$DATA", "/C:/Windows/win.ini", "/plates/placeholder.plate.webp%00.html", "/CON"]) {
    const r = await raw(hub.port, p);
    assert.ok(r.status === 404 || r.status === 400, `${p} -> ${r.status}`);
    assert.doesNotMatch(r.body, /secret/, p);
  }
});

test("resolveSafe never leaves its root", () => {
  assert.equal(resolveSafe(root, "/../x"), null);
  assert.equal(resolveSafe(root, "/a/%2e%2e/%2e%2e/x"), null);
  assert.equal(resolveSafe(root, "/a\\b"), null);
  assert.equal(resolveSafe(root, "/PLATES~1/a.webp"), null);
  assert.equal(resolveSafe(root, "/plates/placeholder.plate.webp").rel, "plates/placeholder.plate.webp");
});

test("the API refuses unknown hosts (DNS rebinding) but answers its own address", async () => {
  assert.equal((await raw(hub.port, "/api/health", { headers: { host: "rebind.attacker.example" } })).status, 403);
  const ok = await raw(hub.port, "/api/health");
  assert.equal(ok.status, 200);
  assert.equal(JSON.parse(ok.body).ok, true);
  assert.equal(ok.headers["cache-control"], "no-store");
});
