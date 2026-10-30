// html-viewer's worker. It runs on the machine that has the file, started by the
// mod as `node --input-type=module -e <this file> herdr-html <command> ...`, so it
// uses only Node built-ins and never imports a sibling file.
//
//   resolve <input> <folder>   which file the typed input names, its kind and change time
//   stat <path>                the file's change time (0: gone)
//   list [folder]              the .html and .md files under folder (default: home)
//   open <path> <width>        lays the page out in this machine's Chrome and prints its
//                              key, height and tiles; the page stays open for `tile`
//   tile <key> <n> <out|->     the tile's PNG, to a file or raw to stdout (nothing else
//                              is printed then), which is how a remote tile travels
//   show <path> <width> <out|->   open, then tile 0; with `-`, the JSON line is followed
//                              by the PNG on stdout
//   stop                       closes this machine's Chrome now
//
// Every command but a `-` tile prints one JSON line. Chrome stays open between
// renders, owned by a background copy of this worker (`serve`) that listens on a
// unix socket and exits, closing Chrome, after IDLE_MS without a request.
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, renameSync, rmSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { request, createServer } from "node:http";
import { homedir, tmpdir } from "node:os";
import { basename, dirname, extname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

// Pinned and checked: a changed file on the CDN is refused, not run.
export const LIBS = {
  pele: { version: "1.12.0", url: "https://cdn.jsdelivr.net/npm/pele@1.12.0/dist/pele.global.js", sha256: "787ed66bb4bd56c15e224109ff5b89ed395ebfacf71fae2c0ccad1f86d6e24ef" },
  marked: { version: "18.1.1", url: "https://cdn.jsdelivr.net/npm/marked@18.1.1/lib/marked.umd.js", sha256: "b82b9334406d8bdd16b6236c08de1cb65b2a859873ca9503d9cc0b292ca3c12a" },
};
export const TILE = 1200;
export const MAX_HEIGHT = 60000;
const SCALE = 2;
const IDLE_MS = 3 * 60 * 1000;
const PAGES = 4;
// Under the app's 30 s exec limit, so a slow page fails with this message instead.
const TIMEOUT_MS = 25000;
const MERMAID_BLOCKS = "pre.mermaid, div.mermaid, code.language-mermaid";
const KINDS = { ".html": "html", ".htm": "html", ".md": "markdown", ".markdown": "markdown", ".mdown": "markdown" };
const dir = () => process.env.HERDR_HTML_DIR ?? join(homedir(), ".cache", "herdr-html");
const socket = () => join(dir(), "chrome.sock");

export const kindOf = (path) => KINDS[extname(path).toLowerCase()] ?? null;

// The paths a typed or pasted input may mean, most literal first. People paste paths
// from chat and terminals: wrapped in quotes or backticks, with a sentence's final
// period or comma, with shell-escaped spaces, as file:// URLs, with ~ or relative to
// the space's folder.
export function candidates(input, { home, folder }) {
  let s = String(input ?? "").trim().replace(/^(["'`<])(.*)(["'`>])$/s, "$2").trim();
  if (!s) return [];
  if (s.startsWith("file://")) {
    try { s = fileURLToPath(s); } catch { return []; }
  }
  const forms = [s];
  if (/\\ /.test(s)) forms.push(s.replace(/\\ /g, " "));
  for (const f of [...forms]) {
    const bare = f.replace(/[.,;:!?)\]}"'`]+$/, "");
    if (bare && bare !== f) forms.push(bare);
  }
  const absolute = (p) => (p === "~" ? home : p.startsWith("~/") ? join(home, p.slice(2)) : isAbsolute(p) ? p : resolve(folder || home, p));
  return [...new Set(forms.map(absolute))];
}

export function resolveInput(input, folder) {
  const tried = candidates(input, { home: homedir(), folder });
  if (!tried.length) return { ok: false, error: "Type or paste the path of an .html or .md file" };
  for (const path of tried) {
    let st;
    try { st = statSync(path); } catch { continue; }
    if (!st.isFile()) continue;
    const kind = kindOf(path);
    if (!kind) return { ok: false, error: `${basename(path)} is not an .html or .md file`, tried };
    return { ok: true, path, kind, mtime: st.mtimeMs };
  }
  return { ok: false, error: `No such file: ${tried[0]}`, tried };
}

export function stat(path) {
  try { return { ok: true, mtime: statSync(path).mtimeMs }; } catch { return { ok: true, mtime: 0 }; }
}

export function list(folder, { maxDepth = 5, max = 300 } = {}) {
  const out = [];
  (function walk(d, depth) {
    if (depth > maxDepth || out.length >= max) return;
    let entries;
    try { entries = readdirSync(d, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      if (e.name.startsWith(".") || e.name === "node_modules") continue;
      const p = join(d, e.name);
      if (e.isDirectory()) walk(p, depth + 1);
      else if (kindOf(e.name) && out.length < max) out.push(p);
    }
  })(folder, 0);
  return { ok: true, folder, files: out.sort() };
}

// The page cut into tiles of TILE CSS px: the first one shows while the rest come.
export function tiles(height) {
  const h = Math.min(height, MAX_HEIGHT), out = [];
  for (let y = 0; y < h; y += TILE) out.push({ y, h: Math.min(TILE, h - y) });
  return out;
}

export const pageKey = (path, mtime, width) => createHash("sha256").update(JSON.stringify([path, mtime, width])).digest("hex").slice(0, 16);

const escapeHtml = (s) => s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);

// The page a Markdown file is drawn in. The text itself goes in after load, through
// marked, so nothing in it is parsed as this page's HTML; the base makes the file's
// relative images and links resolve next to it.
export function markdownPage(path) {
  return `<!doctype html><html><head><meta charset="utf-8">
<base href="${escapeHtml(pathToFileURL(dirname(path)).href)}/"><title>${escapeHtml(basename(path))}</title>
<style>
body{margin:0;background:#fff;color:#1f2328;font:16px/1.6 -apple-system,BlinkMacSystemFont,"Segoe UI","Noto Sans",Helvetica,Arial,sans-serif}
article{max-width:880px;margin:0 auto;padding:32px 40px 48px}
h1,h2{border-bottom:1px solid #d1d9e0;padding-bottom:.3em}h1,h2,h3,h4{margin:1.5em 0 .6em;line-height:1.25}
a{color:#0969da}img{max-width:100%}hr{border:0;border-top:1px solid #d1d9e0;margin:24px 0}
code{font:85% ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;background:#f6f8fa;border-radius:6px;padding:.2em .4em}
pre{background:#f6f8fa;border-radius:6px;padding:16px;overflow:auto}pre code{background:none;padding:0}
pre.mermaid,pre:has(> svg){background:none;text-align:center}
article>:first-child{margin-top:0}
blockquote{margin:0;padding:0 1em;color:#59636e;border-left:.25em solid #d1d9e0}
table{border-collapse:collapse;display:block;overflow:auto}th,td{border:1px solid #d1d9e0;padding:6px 13px}tr:nth-child(2n){background:#f6f8fa}
</style></head><body><article id="markdown"></article></body></html>`;
}

const libs = new Map();
async function lib(name) {
  if (libs.has(name)) return libs.get(name);
  const { version, url, sha256 } = LIBS[name];
  const path = join(dir(), `${name}-${version}.js`);
  const digest = (text) => createHash("sha256").update(text).digest("hex");
  let text = existsSync(path) ? readFileSync(path, "utf8") : null;
  if (!text || digest(text) !== sha256) {
    const res = await fetch(url);
    if (!res.ok) throw new Error(`could not download ${name} ${version}: HTTP ${res.status}`);
    text = await res.text();
    if (digest(text) !== sha256) throw new Error(`${name} ${version} does not match its pinned hash`);
    mkdirSync(dir(), { recursive: true });
    writeFileSync(`${path}.tmp`, text);
    renameSync(`${path}.tmp`, path);
  }
  libs.set(name, text);
  return text;
}

function chromeBinary() {
  if (process.env.HTML_CHROME) return process.env.HTML_CHROME;
  // An installed Chrome first: on Ubuntu its AppArmor profile allows the sandbox,
  // which a Playwright headless shell is denied.
  const found = ["/usr/bin/google-chrome", "/usr/bin/chromium", "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"];
  for (const root of [join(homedir(), "Library/Caches/ms-playwright"), join(homedir(), ".cache/ms-playwright")]) {
    if (!existsSync(root)) continue;
    for (const d of readdirSync(root).filter((n) => n.startsWith("chromium_headless_shell-")).sort().reverse()) {
      for (const sub of readdirSync(join(root, d))) found.push(join(root, d, sub, "chrome-headless-shell"));
    }
  }
  const bin = found.find((p) => existsSync(p));
  if (!bin) throw new Error("no headless Chrome on this machine (HTML_CHROME picks one)");
  return bin;
}

// One DevTools session over Chrome's own WebSocket.
async function devtools(url) {
  const ws = new WebSocket(url);
  await new Promise((ok, fail) => { ws.onopen = ok; ws.onerror = () => fail(new Error("could not open DevTools")); });
  let seq = 0;
  const pending = new Map(), waiters = [];
  ws.onmessage = ({ data }) => {
    const m = JSON.parse(data);
    if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); }
    else if (m.method) for (const w of waiters.filter((w) => w.method === m.method)) w.resolve();
  };
  ws.onclose = () => { for (const p of pending.values()) p({ error: { message: "Chrome closed the page" } }); pending.clear(); };
  const send = (method, params = {}) => new Promise((ok, fail) => {
    const id = ++seq;
    pending.set(id, (m) => (m.error ? fail(new Error(`${method}: ${m.error.message}`)) : ok(m.result)));
    ws.send(JSON.stringify({ id, method, params }));
  });
  const next = (method, ms) => new Promise((ok) => { waiters.push({ method, resolve: ok }); setTimeout(ok, ms); });
  const evaluate = async (expression) => {
    const r = await send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true });
    if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description ?? r.exceptionDetails.text);
    return r.result.value;
  };
  return { send, next, evaluate, close: () => ws.close() };
}

// The background worker: one Chrome for this machine, the last PAGES pages kept
// laid out by key, and a request queue so pages never race each other.
async function serve() {
  mkdirSync(dir(), { recursive: true });
  // Binding first makes a second copy started at the same time give up before
  // launching a Chrome of its own.
  let handle;
  const ready = new Promise((ok) => (handle = ok));
  const server = createServer((req, res) => ready.then((fn) => fn(req, res)));
  await new Promise((ok, fail) => {
    server.once("error", (e) => {
      if (e.code !== "EADDRINUSE") return fail(e);
      // A socket file without a listener is left from a crash.
      const probe = request({ socketPath: socket(), path: "/ping" }, () => fail(new Error("already running")));
      probe.on("error", () => { unlinkSync(socket()); server.listen(socket(), ok); });
      probe.end();
    });
    server.listen(socket(), ok);
  });
  const profile = mkdtempSync(join(tmpdir(), "herdr-html-"));
  const chrome = spawn(chromeBinary(), [
    "--headless", "--remote-debugging-port=0", `--user-data-dir=${profile}`, "--hide-scrollbars",
    "--no-first-run", "--no-default-browser-check", "--allow-file-access-from-files",
    // No crash reporter: its handler outlives Chrome and keeps a remote exec from returning.
    "--disable-crash-reporter", "--disable-breakpad", "about:blank",
  ], { stdio: "ignore", detached: true });
  let ended = false;
  const end = () => {
    if (ended) return;
    ended = true;
    try { process.kill(-chrome.pid, "SIGKILL"); } catch {}
    server.close();
    try { unlinkSync(socket()); } catch {}
    rmSync(profile, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
    process.exit(0);
  };
  for (const sig of ["SIGTERM", "SIGINT"]) process.on(sig, end);
  // The exec that started it ends; this outlives it on purpose.
  process.on("SIGHUP", () => {});
  chrome.on("exit", end);
  let port;
  for (let i = 0; i < 200 && !port; i++) {
    const f = join(profile, "DevToolsActivePort");
    if (existsSync(f)) port = readFileSync(f, "utf8").split("\n")[0];
    else await new Promise((r) => setTimeout(r, 25));
  }
  if (!port) end();
  const http = (method, path) => fetch(`http://127.0.0.1:${port}${path}`, { method }).then((r) => r.json());

  let idle;
  const touch = () => { clearTimeout(idle); idle = setTimeout(end, IDLE_MS); };
  touch();
  const pages = new Map();
  let queue = Promise.resolve();
  const serial = (fn) => (queue = queue.then(fn, fn));

  async function open(path, width) {
    const { mtime } = stat(path);
    if (!mtime) throw new Error(`No such file: ${path}`);
    const kind = kindOf(path);
    if (!kind) throw new Error(`${basename(path)} is not an .html or .md file`);
    const key = pageKey(path, mtime, width);
    if (pages.has(key)) { const p = pages.get(key); pages.delete(key); pages.set(key, p); return p.meta; }
    const target = await http("PUT", "/json/new?about:blank");
    const page = await devtools(target.webSocketDebuggerUrl);
    try {
      const { send, next, evaluate } = page;
      await send("Page.enable");
      await send("Network.enable");
      // A page's own mermaid.js would race pele for the same blocks. Only scripts are
      // blocked, so a file or folder named after mermaid still loads.
      await send("Network.setBlockedURLs", { urls: ["*mermaid*.js", "*mermaid*.mjs", "*mermaid*.js?*", "*mermaid*.mjs?*", "*/npm/mermaid@*", "*/npm/mermaid/*"] });
      await send("Emulation.setDeviceMetricsOverride", { width, height: 900, deviceScaleFactor: SCALE, mobile: false });
      let url = pathToFileURL(path).href;
      if (kind === "markdown") {
        const html = join(profile, `${key}.html`);
        writeFileSync(html, markdownPage(path));
        url = pathToFileURL(html).href;
      }
      const loaded = next("Page.loadEventFired", 15000);
      await send("Page.navigate", { url });
      await loaded;
      if (kind === "markdown") {
        await evaluate(await lib("marked"));
        await evaluate(`document.getElementById("markdown").innerHTML = marked.parse(${JSON.stringify(readFileSync(path, "utf8"))}, { gfm: true })`);
      }
      const mermaid = await evaluate(`document.querySelectorAll(${JSON.stringify(MERMAID_BLOCKS)}).length`);
      if (mermaid > 0) {
        await evaluate(await lib("pele"));
        await evaluate(`(() => {
          for (const el of document.querySelectorAll(${JSON.stringify(MERMAID_BLOCKS)})) {
            const target = el.matches("code") && el.parentElement?.matches("pre") ? el.parentElement : el;
            const text = el.textContent;
            target.textContent = "";
            try { pele.mount(target, text, { zoom: false }); } catch (e) { target.textContent = "Mermaid: " + e.message; }
          }
        })()`);
      }
      await evaluate("document.fonts ? document.fonts.ready.then(() => true) : true");
      // Measured in a tiny viewport so a short page isn't padded to the window's height,
      // then laid out at full height so any tile is a clip without another layout.
      await send("Emulation.setDeviceMetricsOverride", { width, height: 50, deviceScaleFactor: SCALE, mobile: false });
      const full = await evaluate("Math.ceil(Math.max(document.documentElement.scrollHeight, document.body?.scrollHeight ?? 0))");
      const height = Math.max(50, Math.min(MAX_HEIGHT, full));
      await send("Emulation.setDeviceMetricsOverride", { width, height, deviceScaleFactor: SCALE, mobile: false });
      const meta = { ok: true, key, path, kind, width, height, clipped: full > MAX_HEIGHT, mermaid, tiles: tiles(height) };
      pages.set(key, { page, target: target.id, meta });
      while (pages.size > PAGES) {
        const [old, p] = pages.entries().next().value;
        pages.delete(old); p.page.close(); http("PUT", `/json/close/${p.target}`).catch(() => {});
      }
      return meta;
    } catch (e) {
      page.close(); http("PUT", `/json/close/${target.id}`).catch(() => {});
      throw e;
    }
  }

  async function tile(key, n) {
    const p = pages.get(key), t = p?.meta.tiles[n];
    if (!t) throw new Error("that page is no longer open");
    const { data } = await p.page.send("Page.captureScreenshot", { format: "png", clip: { x: 0, y: t.y, width: p.meta.width, height: t.h, scale: 1 } });
    return Buffer.from(data, "base64");
  }

  handle((req, res) => {
    touch();
    const q = new URL(req.url, "http://x").searchParams;
    const reply = (status, body, type = "application/json") => { res.writeHead(status, { "content-type": type }); res.end(body); };
    const json = (fn) => serial(fn).then((r) => reply(200, JSON.stringify(r)), (e) => reply(500, JSON.stringify({ ok: false, error: e.message })));
    if (req.url.startsWith("/ping")) reply(200, "{}");
    else if (req.url.startsWith("/open")) json(() => open(q.get("path"), Number(q.get("width"))));
    else if (req.url.startsWith("/tile")) serial(() => tile(q.get("key"), Number(q.get("n")))).then((png) => reply(200, png, "image/png"), (e) => reply(500, JSON.stringify({ ok: false, error: e.message })));
    else if (req.url.startsWith("/stop")) { reply(200, "{}"); setTimeout(end, 10); }
    else reply(404, "{}");
  });
}

function ask(path) {
  return new Promise((ok, fail) => {
    const req = request({ socketPath: socket(), path }, (res) => {
      const parts = [];
      res.on("data", (c) => parts.push(c));
      res.on("end", () => {
        const body = Buffer.concat(parts);
        if (res.statusCode === 200) ok(body);
        else fail(new Error(JSON.parse(body.toString()).error));
      });
    });
    req.on("error", fail);
    req.end();
  });
}

// This worker as a file: it may have arrived as `node -e <source>`, and a command
// line that long is mangled by systemd-run's $-expansion.
function workerFile() {
  const e = process.execArgv.indexOf("-e");
  const source = e === -1 ? readFileSync(process.argv[1], "utf8") : process.execArgv[e + 1];
  const file = join(dir(), `worker-${createHash("sha256").update(source).digest("hex").slice(0, 12)}.mjs`);
  if (!existsSync(file)) {
    mkdirSync(dir(), { recursive: true });
    writeFileSync(`${file}.tmp`, source);
    renameSync(`${file}.tmp`, file);
  }
  return file;
}

// herdr-core runs a remote exec in a systemd service and stops everything left in it
// when the command ends, so on a systemd machine the worker gets a unit of its own.
function start(argv) {
  const opts = { stdio: "ignore", detached: true };
  if (process.platform === "linux" && existsSync("/run/systemd/system")) {
    const env = ["HERDR_HTML_DIR", "HTML_CHROME"].filter((k) => process.env[k]).map((k) => `--setenv=${k}=${process.env[k]}`);
    const unit = spawn("systemd-run", ["--user", "--collect", "--quiet", `--unit=herdr-html-${Date.now()}`, ...env, "--", ...argv], opts);
    unit.on("error", () => spawn(argv[0], argv.slice(1), opts).unref());
    unit.unref();
    return;
  }
  spawn(argv[0], argv.slice(1), opts).unref();
}

// Asks the background worker, starting it first when nobody is listening.
async function daemon(path) {
  try { return await ask(path); } catch (e) { if (!["ENOENT", "ECONNREFUSED"].includes(e.code)) throw e; }
  start([process.execPath, workerFile(), "herdr-html", "serve"]);
  for (let i = 0; i < 200; i++) {
    await new Promise((r) => setTimeout(r, 25));
    try { await ask("/ping"); return await ask(path); } catch (e) { if (!["ENOENT", "ECONNREFUSED"].includes(e.code)) throw e; }
  }
  throw new Error("Chrome did not start");
}

// process.exit drops whatever a pipe has not taken yet, so wait until it has.
const toStdout = (...parts) => new Promise((done) => { for (const part of parts) process.stdout.write(part); process.stdout.write("", done); });

const COMMANDS = {
  resolve: ([input, folder]) => resolveInput(input, folder),
  stat: ([path]) => stat(path),
  list: ([folder]) => list(folder || homedir()),
  open: async ([path, width]) => JSON.parse(await daemon(`/open?${new URLSearchParams({ path, width: String(Math.max(320, Math.min(2400, Number(width) || 900))) })}`)),
  tile: async ([key, n, out]) => {
    const png = await daemon(`/tile?${new URLSearchParams({ key, n })}`);
    if (out === "-") { await toStdout(png); return null; }
    mkdirSync(dirname(out), { recursive: true });
    writeFileSync(`${out}.tmp`, png);
    renameSync(`${out}.tmp`, out);
    return { ok: true, out, bytes: png.length };
  },
  // open and the first tile in one trip; with `-`, the meta line and then the PNG.
  show: async ([path, width, out]) => {
    const meta = await COMMANDS.open([path, width]);
    if (!meta.ok) return meta;
    const png = await daemon(`/tile?${new URLSearchParams({ key: meta.key, n: "0" })}`);
    if (out === "-") { await toStdout(`${JSON.stringify(meta)}\n`, png); return null; }
    mkdirSync(dirname(out), { recursive: true });
    writeFileSync(`${out}.tmp`, png);
    renameSync(`${out}.tmp`, out);
    return { ...meta, out };
  },
  stop: async () => { await ask("/stop").catch(() => {}); return { ok: true }; },
};

// Only when started as the worker; tests import the functions above.
const at = process.argv.indexOf("herdr-html");
if (at !== -1) {
  const [command, ...args] = process.argv.slice(at + 1);
  if (command === "serve") await serve();
  else {
    const timer = setTimeout(() => { console.log(JSON.stringify({ ok: false, error: `took longer than ${TIMEOUT_MS / 1000} s` })); process.exit(1); }, TIMEOUT_MS);
    timer.unref();
    try {
      const run = COMMANDS[command];
      if (!run) throw new Error(`unknown command: ${command}`);
      const result = await run(args);
      if (result) console.log(JSON.stringify(result));
      process.exit(!result || result.ok ? 0 : 1);
    } catch (e) {
      console.log(JSON.stringify({ ok: false, error: String(e?.message ?? e) }));
      process.exit(1);
    }
  }
}
