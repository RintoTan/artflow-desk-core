#!/usr/bin/env node
/**
 * 把 src/assets/app-icons/*.svg 栅格化成 PNG，并生成默认变体的安装包图标。
 *
 * 为什么用无头 Chrome 而不是 rsvg/imagemagick：这台机器上没有，
 * 而 Chrome 已经在 layout-probe 里用过，渲染结果就是 WKWebView 之外最接近的一致性来源。
 * 这里只做"同一份矢量按不同尺寸出像素"，不重新设计任何图形。
 *
 * 输出：
 *   src/assets/app-icons/png/<variant>-<size>.png   1024 / 256 / 64 / 32
 *   src-tauri/icons/icon.png                        1024，默认变体
 *   src-tauri/icons/icon.icns                       macOS 安装包图标，默认变体
 *   src-tauri/icons/icon.ico                        Windows 安装包图标，默认变体
 *
 * 用法：node scripts/build-app-icons.mjs [--only=svg|icons]
 */
import { spawn } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";

const CHROME = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const ROOT = resolve(import.meta.dirname, "..");
const SRC = join(ROOT, "src/assets/app-icons");
const PNG_DIR = join(SRC, "png");
const TAURI_ICONS = join(ROOT, "src-tauri/icons");

// 三个标识 × 两种明暗 = 六份 SVG（由 make-icon-variants.mjs 从原始文件派生）
const VARIANTS = [
  "orbit",
  "orbit-light",
  "orbit-dark",
  "layers",
  "layers-light",
  "layers-dark",
  "wave-a",
  "wave-a-light",
  "wave-a-dark",
];
const PNG_SIZES = [1024, 256, 64, 32];
// 安装包图标仍取自原始 orbit.svg：本轮不改动打包图标
const BUILD_ICON_SOURCE = "orbit";
const ICO_SIZES = [16, 24, 32, 48, 64, 128, 256];

const port = 9400 + Math.floor(Math.random() * 90);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function targetUrl() {
  for (let i = 0; i < 60; i += 1) {
    try {
      const res = await fetch(`http://127.0.0.1:${port}/json/list`);
      const list = await res.json();
      const page = list.find((item) => item.type === "page");
      if (page?.webSocketDebuggerUrl) return page.webSocketDebuggerUrl;
    } catch {
      /* 还没起来 */
    }
    await sleep(200);
  }
  throw new Error("Chrome 调试端口没有就绪");
}

async function renderSquares(pairs) {
  /* pairs: [{ file, width, height, out }] 全部按页面坐标 (0,0)-(w,h) 截图 */
  const profile = mkdtempSync(join(tmpdir(), "app-icons-"));
  const chrome = spawn(
    CHROME,
    [
      "--headless=new",
      `--remote-debugging-port=${port}`,
      `--user-data-dir=${profile}`,
      "--no-first-run",
      "--no-default-browser-check",
      "--disable-gpu",
      "--allow-file-access-from-files",
      "--force-device-scale-factor=1",
      "about:blank",
    ],
    { stdio: "ignore" },
  );

  const ws = new WebSocket(await targetUrl());
  await new Promise((res, rej) => {
    ws.addEventListener("open", res, { once: true });
    ws.addEventListener("error", rej, { once: true });
  });

  let seq = 0;
  const pending = new Map();
  ws.addEventListener("message", (event) => {
    const msg = JSON.parse(event.data);
    if (msg.id && pending.has(msg.id)) {
      pending.get(msg.id)(msg);
      pending.delete(msg.id);
    }
  });
  const send = (method, params = {}) => {
    const id = ++seq;
    return new Promise((done) => {
      pending.set(id, done);
      ws.send(JSON.stringify({ id, method, params }));
    });
  };

  await send("Page.enable");
  await send("Runtime.enable");
  // 圆角之外要透明，不能是白底
  await send("Emulation.setDefaultBackgroundColorOverride", {
    color: { r: 0, g: 0, b: 0, a: 0 },
  });

  for (const pair of pairs) {
    const page = join(profile, "page.html");
    writeFileSync(
      page,
      `<!doctype html><meta charset="utf-8">
       <style>html,body{margin:0;padding:0;background:transparent;overflow:hidden}
       img{display:block;width:${pair.width}px;height:${pair.height}px}</style>
       <img id="art" src="${pair.file}">`,
    );
    await send("Emulation.setDeviceMetricsOverride", {
      width: pair.width,
      height: pair.height,
      deviceScaleFactor: 1,
      mobile: false,
    });
    await send("Page.navigate", { url: `file://${page}` });
    await sleep(600);
    const ready = await send("Runtime.evaluate", {
      expression: `(() => { const i = document.getElementById("art"); return i && i.complete && i.naturalWidth > 0; })()`,
      returnByValue: true,
    });
    if (!ready.result?.result?.value) {
      throw new Error(`SVG 没有加载出来：${pair.file}`);
    }
    const shot = await send("Page.captureScreenshot", {
      format: "png",
      clip: { x: 0, y: 0, width: pair.width, height: pair.height, scale: 1 },
      captureBeyondViewport: false,
    });
    const data = shot.result?.data;
    if (!data) throw new Error(`截图失败：${pair.file} @${pair.width}`);
    mkdirSync(dirname(pair.out), { recursive: true });
    writeFileSync(pair.out, Buffer.from(data, "base64"));
  }

  ws.close();
  chrome.kill("SIGKILL");
  rmSync(profile, { recursive: true, force: true });
}

/** PNG 内嵌的 ICO：Windows Vista 以后都支持，尺寸大的条目本来就要求 PNG。 */
function buildIco(pngBySize) {
  const entries = [...pngBySize.entries()].sort((a, b) => a[0] - b[0]);
  const header = Buffer.alloc(6);
  header.writeUInt16LE(0, 0);
  header.writeUInt16LE(1, 2);
  header.writeUInt16LE(entries.length, 4);

  const dir = Buffer.alloc(16 * entries.length);
  let offset = header.length + dir.length;
  entries.forEach(([size, png], index) => {
    const at = index * 16;
    dir.writeUInt8(size >= 256 ? 0 : size, at + 0);
    dir.writeUInt8(size >= 256 ? 0 : size, at + 1);
    dir.writeUInt8(0, at + 2);
    dir.writeUInt8(0, at + 3);
    dir.writeUInt16LE(1, at + 4);
    dir.writeUInt16LE(32, at + 6);
    dir.writeUInt32LE(png.length, at + 8);
    dir.writeUInt32LE(offset, at + 12);
    offset += png.length;
  });

  return Buffer.concat([header, dir, ...entries.map(([, png]) => png)]);
}

function icnsFrom(iconsetDir, out) {
  const r = spawn("iconutil", ["-c", "icns", iconsetDir, "-o", out], { stdio: "inherit" });
  return new Promise((res, rej) => {
    r.on("exit", (code) => (code === 0 ? res() : rej(new Error(`iconutil 退出码 ${code}`))));
  });
}

// ---------------------------------------------------------------- 主流程

const only = process.argv.find((a) => a.startsWith("--only="))?.slice(7) ?? "all";

if (only === "all" || only === "svg") {
  const jobs = [];
  for (const variant of VARIANTS) {
    for (const size of PNG_SIZES) {
      jobs.push({
        file: join(SRC, `${variant}.svg`),
        width: size,
        height: size,
        out: join(PNG_DIR, `${variant}-${size}.png`),
      });
    }
  }
  await renderSquares(jobs);
  console.log(`PNG ${jobs.length} 张 → ${PNG_DIR}`);
}

if (only === "all" || only === "icons") {
  const base = join(PNG_DIR, `${BUILD_ICON_SOURCE}-1024.png`);
  writeFileSync(join(TAURI_ICONS, "icon.png"), readFileSync(base));

  // iconutil 要求目录名以 .iconset 结尾
  const iconsetRoot = mkdtempSync(join(tmpdir(), "app-icon-"));
  const iconset = join(iconsetRoot, "AppIcon.iconset");
  mkdirSync(iconset, { recursive: true });
  const macSizes = [
    [16, "icon_16x16.png"],
    [32, "icon_16x16@2x.png"],
    [32, "icon_32x32.png"],
    [64, "icon_32x32@2x.png"],
    [128, "icon_128x128.png"],
    [256, "icon_128x128@2x.png"],
    [256, "icon_256x256.png"],
    [512, "icon_256x256@2x.png"],
    [512, "icon_512x512.png"],
    [1024, "icon_512x512@2x.png"],
  ];
  for (const [size, name] of macSizes) {
    const src = join(PNG_DIR, `${BUILD_ICON_SOURCE}-${size}.png`);
    const dest = join(iconset, name);
    const r = spawn("sips", ["-z", String(size), String(size), src, "--out", dest], {
      stdio: "ignore",
    });
    await new Promise((res, rej) =>
      r.on("exit", (code) => (code === 0 ? res() : rej(new Error(`sips ${size} 失败`)))),
    );
  }
  await icnsFrom(iconset, join(TAURI_ICONS, "icon.icns"));
  rmSync(iconsetRoot, { recursive: true, force: true });
  console.log(`icon.icns / icon.png 已更新（来源 ${BUILD_ICON_SOURCE}.svg）`);

  // ICO 需要 16/24/32/48/64/128/256，只有 32/64/256 是现成的，其余从 1024 缩放
  const icoTmp = mkdtempSync(join(tmpdir(), "app-icon.ico-"));
  const pngBySize = new Map();
  for (const size of ICO_SIZES) {
    const out = join(icoTmp, `${size}.png`);
    const r = spawn("sips", ["-z", String(size), String(size), base, "--out", out], {
      stdio: "ignore",
    });
    await new Promise((res, rej) =>
      r.on("exit", (code) => (code === 0 ? res() : rej(new Error(`sips ${size} 失败`)))),
    );
    pngBySize.set(size, readFileSync(out));
  }
  writeFileSync(join(TAURI_ICONS, "icon.ico"), buildIco(pngBySize));
  rmSync(icoTmp, { recursive: true, force: true });
  console.log(`icon.ico 已生成（${ICO_SIZES.join("/")}，PNG 条目）`);
}
