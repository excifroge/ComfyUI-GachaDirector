// The panel in a browser without a window: a headless Edge or Chrome driven over its
// debugging port, for tests that have to click and type, and for screenshots. Nothing
// appears on the desktop and nothing takes the focus.
//
//   node --experimental-websocket tests/shot.mjs SCENARIO.mjs [--lang zh|ja|en] [--url URL]
//
// The server has to be running (--url, default http://127.0.0.1:8189/).
//
// SCENARIO.mjs exports `default async function (page)`. `page` offers:
//
//   page.eval(fn or text, ...args)   run in the page, awaits a promise, returns the value
//   page.shot(file, {selector, clip}) a PNG of the viewport, of one element, or of a
//                                    rectangle {x, y, width, height}
//   page.reload()                    load the page again and wait until it is ready
//   page.viewport(width, height)     the size of the page (device pixel ratio 1, or GD_DPR)
//   page.wait(ms)
//   page.open(workflow, doc, more)   load a workflow file, put a clip document into its Gacha
//                                    Director node (and `more`: other widgets by name),
//                                    open the panel
//   page.tab(index)                  switch the panel to its nth page
//   page.scrollTo(selector, pad)     scroll the showing page so that element is at its top
//
// Needs Node 20.10 or later (for the WebSocket flag) and Edge or Chrome installed.
// GD_DPR=2 takes the pictures at twice the pixels (for a picture that will be enlarged);
// GD_NOGPU=1 keeps the browser off the graphics card (while it is rendering).
// GD_PLAIN=1 with --url: any page, not ComfyUI; page.eval, page.shot and page.wait work on it,
// page.open and page.tab do not.

import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

const BROWSERS = [
  process.env.GD_BROWSER,
  "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe",
  "C:/Program Files/Microsoft/Edge/Application/msedge.exe",
  "C:/Program Files/Google/Chrome/Application/chrome.exe",
  "/usr/bin/google-chrome", "/usr/bin/chromium",
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
].filter(Boolean);

const args = process.argv.slice(2);
const flag = (name, fallback) => {
  const i = args.indexOf(name);
  return i >= 0 ? args.splice(i, 2)[1] : fallback;
};
const url = flag("--url", "http://127.0.0.1:8189/");
// 0: the browser picks a free port, so two of these can run side by side. (With one fixed
// port the second would have driven, and then closed, the first one's browser.)
const wanted = Number(flag("--port", "0"));
const lang = flag("--lang", "");
const scenario = args[0];
const DPR = Number(process.env.GD_DPR || 1);
if (!scenario) {
  console.error("usage: node --experimental-websocket shot.mjs SCENARIO.mjs [--lang zh|ja|en] [--url URL] [--port N]");
  process.exit(2);
}

const exe = BROWSERS.find((p) => existsSync(p));
if (!exe) { console.error("no Edge or Chrome found; set GD_BROWSER"); process.exit(2); }
const profile = join(tmpdir(), `gd-shot-${process.pid}`);
mkdirSync(profile, { recursive: true });
const browser = spawn(exe, [
  "--headless=new", `--remote-debugging-port=${wanted}`, `--user-data-dir=${profile}`,
  "--no-first-run", "--no-default-browser-check", "--hide-scrollbars", "--mute-audio",
  "--disable-extensions",            // one that opens a welcome tab would bury the page
  ...(process.env.GD_NOGPU ? ["--disable-gpu"] : []),
  "--window-size=1680,1000", "about:blank",
], { stdio: "ignore" });

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** The port the browser is listening on: it writes it into its profile once it is up. */
async function debugPort() {
  if (wanted) return wanted;
  for (let i = 0; i < 150; i++) {
    try {
      const n = Number(readFileSync(join(profile, "DevToolsActivePort"), "utf8").split("\n")[0]);
      if (n) return n;
    } catch (e) { /* not written yet */ }
    await sleep(100);
  }
  throw new Error("the browser did not say which debugging port it took");
}

async function target() {
  const port = await debugPort();
  for (let i = 0; i < 100; i++) {
    try {
      const list = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
      const hit = list.find((x) => x.type === "page" && x.url === "about:blank")
        || list.find((x) => x.type === "page");
      if (hit) return hit.webSocketDebuggerUrl;
    } catch (e) { /* not up yet */ }
    await sleep(100);
  }
  throw new Error("the browser did not open its debugging port");
}

let code = 0;
let close = async () => {};      // tells the browser to close, once there is a connection to it
try {
  const ws = new WebSocket(await target());
  await new Promise((ok, no) => { ws.onopen = ok; ws.onerror = no; });
  let seq = 0;
  const waiting = new Map();
  ws.onmessage = (m) => {
    const msg = JSON.parse(m.data);
    if (msg.id && waiting.has(msg.id)) {
      const [ok, no] = waiting.get(msg.id);
      waiting.delete(msg.id);
      if (msg.error) no(new Error(msg.error.message)); else ok(msg.result);
    }
  };
  const send = (method, params = {}) => new Promise((ok, no) => {
    const id = ++seq;
    waiting.set(id, [ok, no]);
    ws.send(JSON.stringify({ id, method, params }));
  });
  close = () => Promise.race([send("Browser.close").catch(() => {}), sleep(3000)]);

  const page = {
    wait: sleep,
    async eval(fn, ...a) {
      const expression = typeof fn === "function" ? `(${fn})(...${JSON.stringify(a)})` : String(fn);
      const r = await send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true });
      if (r.exceptionDetails) {
        throw new Error(r.exceptionDetails.exception?.description || r.exceptionDetails.text);
      }
      return r.result.value;
    },
    async viewport(width, height) {
      await send("Emulation.setDeviceMetricsOverride", { width, height, deviceScaleFactor: DPR, mobile: false });
    },
    async shot(file, { selector, clip } = {}) {
      const params = { format: "png" };
      if (clip) params.clip = { ...clip, scale: 1 };
      if (selector) {
        const box = await page.eval((sel) => {
          const e = document.querySelector(sel);
          if (!e) return null;
          const r = e.getBoundingClientRect();
          return { x: r.x, y: r.y, width: r.width, height: r.height, scale: 1 };
        }, selector);
        if (!box) throw new Error(`nothing matches ${selector}`);
        params.clip = box;
      }
      // a page in the background is not drawn, and its screenshot never arrives
      await send("Page.bringToFront");
      const r = await send("Page.captureScreenshot", params);
      mkdirSync(dirname(resolve(file)), { recursive: true });
      writeFileSync(file, Buffer.from(r.data, "base64"));
      console.log("wrote", file);
    },
    /** Load a workflow, give its Gacha Director node a clip document, open the panel. */
    async open(workflow, doc, more = {}) {
      const graph = JSON.parse(readFileSync(workflow, "utf8"));
      await page.eval(async (graph, doc, more) => {
        await window.app.loadGraphData(graph);
        const node = window.app.graph._nodes.find((n) => n.type === "GachaDirector");
        if (!node) throw new Error("the workflow has no Gacha Director node");
        const set = (name, value) => { node.widgets.find((w) => w.name === name).value = value; };
        if (doc) set("gd_timeline", JSON.stringify(doc));
        for (const [name, value] of Object.entries(more)) set(name, value);
      }, graph, doc, more);
      await sleep(500);
      await page.eval(() => { document.querySelector(".gd-launcher button").click(); });
      await sleep(900);
    },
    async reload() {
      await send("Page.reload");
      await sleep(1000);
      await ready();
    },
    async tab(index) {
      await page.eval((i) => { document.querySelectorAll(".gd-tab")[i].click(); }, index);
      await sleep(700);
    },
    async scrollTo(selector, pad = 8) {
      await page.eval((sel, pad) => {
        const target = document.querySelector(sel);
        if (!target) throw new Error(`nothing matches ${sel}`);
        let box = target.parentElement;
        while (box && !/(auto|scroll)/.test(getComputedStyle(box).overflowY)) box = box.parentElement;
        if (!box) return;
        box.scrollTop += target.getBoundingClientRect().top - box.getBoundingClientRect().top - pad;
      }, selector, pad);
      await sleep(400);
    },
  };

  await send("Page.enable");
  await send("Runtime.enable");
  // a headless page is not "focused": without this, focus() and blur() do nothing
  await send("Emulation.setFocusEmulationEnabled", { enabled: true });
  await page.viewport(1680, 1000);
  // the language is read once, when the page's scripts load: set before anything runs
  if (lang) {
    await send("Page.addScriptToEvaluateOnNewDocument",
      { source: `try { localStorage.setItem("gachadirector.lang", ${JSON.stringify(lang)}); } catch (e) {}` });
  }
  async function ready() {
    for (let i = 0; i < 300; i++) {
      // GD_PLAIN: a page that is not ComfyUI (--url says which); it is ready once it has loaded
      const up = await page.eval(process.env.GD_PLAIN ? "document.readyState === 'complete'"
        : "!!(window.app && window.app.graph && window.app.graph._nodes && window.app.extensionManager)").catch(() => false);
      if (up) break;
      if (i === 299) throw new Error(`${url} did not finish loading`);
      await sleep(200);
    }
    await sleep(1500);
  }
  await send("Page.navigate", { url });
  await ready();
  const run = (await import(pathToFileURL(resolve(scenario)).href)).default;
  await run(page);
} catch (e) {
  console.error(String(e && e.stack || e));
  code = 1;
} finally {
  // The whole browser, whatever happened: it is told to close, the tree of the process
  // that was started is ended, and so is every process that runs on this run's profile
  // folder. The last is what catches the rest on Windows: the process that was started
  // hands over to others that are not its children, and after a scenario that failed they
  // (renderers, the GPU process and the memory they hold) stayed for good.
  await close();
  if (process.platform === "win32") {
    if (browser.pid) spawnSync("taskkill", ["/PID", String(browser.pid), "/T", "/F"], { stdio: "ignore" });
    const mark = basename(profile).replace(/'/g, "''");
    spawnSync("powershell", ["-NoProfile", "-NonInteractive", "-Command",
      `Get-CimInstance Win32_Process | Where-Object { $_.CommandLine -match '${mark}(?![0-9])' -and $_.ProcessId -ne $PID } | `
      + "ForEach-Object { try { Stop-Process -Id $_.ProcessId -Force -ErrorAction Stop } catch {} }"],
      { stdio: "ignore", windowsHide: true });
  }
  browser.kill();
  await sleep(300);
  try { rmSync(profile, { recursive: true, force: true }); } catch (e) { /* the browser still holds it */ }
}
process.exit(code);
