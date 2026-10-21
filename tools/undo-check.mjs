// dsh-plugin-velapi-image-go —— 「撤销到底能不能撤回操作」的真机检查
//
// 用户连报两次「撤销无效」。这个脚本只做一件事：在真 Chrome 里挂真 PsView，
// 点真按钮做一次旋转，再点真撤销，看画布尺寸有没有回去。
//
//   node tools/undo-check.mjs
//
// 环境变量：VIG_CHROME / VIG_REACT_ROOT

import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, "..");
const CHROME = process.env.VIG_CHROME || "C:/Program Files/Google/Chrome/Application/chrome.exe";
const REACT_ROOT = process.env.VIG_REACT_ROOT || "G:/Gg-gank/frontend/deeix-chat/frontend/node_modules";
if (!existsSync(REACT_ROOT)) {
  console.log(`React 目录不存在：${REACT_ROOT}`);
  process.exit(1);
}
const clientSource = readFileSync(path.join(ROOT, "client.js"), "utf8");

const driver = `
const React = window.__vigRequire("react");
const { createRoot } = window.__vigRequire("react-dom/client");
const { flushSync } = window.__vigRequire("react-dom");
const ui = window.__vigRecord.factory((name) => {
  if (name === "react") return React;
  return window.__vigRequire(name);
}).__internals;

const results = [];
const check = (name, pass, detail) => results.push({ name, pass: Boolean(pass), detail: detail === undefined ? "" : String(detail) });
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const firstLine = (error) => String((error && error.stack) || error).split("\\n").slice(0, 2).join(" | ");

try {
  const makeImage = (w, h) => {
    const canvas = document.createElement("canvas");
    canvas.width = w;
    canvas.height = h;
    const ctx = canvas.getContext("2d");
    ctx.fillStyle = "#ffffff";
    ctx.fillRect(0, 0, w, h);
    ctx.fillStyle = "#e5484d";
    ctx.fillRect(4, 4, 8, 8);
    return canvas;
  };
  const image = makeImage(60, 40);
  const host = document.createElement("div");
  host.style.cssText = "width:1100px;height:900px";
  document.body.appendChild(host);
  const root = createRoot(host);
  flushSync(() =>
    root.render(
      React.createElement(ui.PsView, {
        state: { library: [], presets: [] },
        actions: { toast: () => {}, attachReference: async () => {} },
        initial: { name: "undo.png", canvas: image, width: image.width, height: image.height, tool: "rotate" }
      })
    )
  );
  flushSync(() => {});
  await wait(60);

  const sizeText = () => {
    const match = (host.textContent || "").match(/(\\d{2,5})\\s*[×x]\\s*(\\d{2,5})/);
    return match ? match[1] + "×" + match[2] : "";
  };
  const button = (label) => Array.from(host.querySelectorAll("button")).find((node) => (node.textContent || "").trim() === label) || null;
  const undoButton = () => host.querySelector('button[title="撤销"]');
  const redoButton = () => host.querySelector('button[title="重做"]');
  const historyItems = () => Array.from(host.querySelectorAll(".vig-ps-history-item"));

  const start = sizeText();
  check("挂载后画布尺寸 = 60×40", start === "60×40", "读数=" + start);

  const turnRight = button("顺时针 90°");
  check("找到「顺时针 90°」按钮", Boolean(turnRight), turnRight ? "有" : "没有（工具面板没渲染？）");
  if (turnRight) flushSync(() => turnRight.click());
  flushSync(() => {});
  await wait(40);
  const rotated = sizeText();
  check("旋转 90° 后尺寸互换 40×60", rotated === "40×60", "读数=" + rotated);

  const undoNow = undoButton();
  check("旋转之后撤销按钮可用", Boolean(undoNow) && undoNow.disabled === false, undoNow ? "disabled=" + undoNow.disabled : "没找到撤销按钮");
  const historyBefore = historyItems().map((node) => (node.textContent || "").trim());
  check("历史条里出现了「旋转」这一步", historyBefore.some((label) => label.indexOf("旋转") >= 0), JSON.stringify(historyBefore));

  if (undoNow && undoNow.disabled === false) flushSync(() => undoNow.click());
  flushSync(() => {});
  await wait(40);
  const undone = sizeText();
  check("点撤销后尺寸回到 60×40", undone === "60×40", "读数=" + undone + "（期望 60×40）");

  const redoNow = redoButton();
  check("撤销之后重做按钮可用", Boolean(redoNow) && redoNow.disabled === false, redoNow ? "disabled=" + redoNow.disabled : "没找到重做按钮");
  if (redoNow && redoNow.disabled === false) flushSync(() => redoNow.click());
  flushSync(() => {});
  await wait(40);
  check("点重做后尺寸又是 40×60", sizeText() === "40×60", "读数=" + sizeText());

  // 历史条点回：点第一项（过去的那一步）
  const items = historyItems();
  const past = items.find((node) => node.className.indexOf("is-past") >= 0);
  if (past) flushSync(() => past.click());
  flushSync(() => {});
  await wait(40);
  check("点历史条上过去的步骤也能回去（60×40）", sizeText() === "60×40", "读数=" + sizeText() + "｜历史=" + JSON.stringify(items.map((n) => n.textContent.trim())));

  /* ---- 第二条链：调整类操作（像素变了 → 撤销必须变回来） ---- */
  const toolButton = (label) => Array.from(host.querySelectorAll("button")).find((node) => (node.textContent || "").trim() === label) || null;
  const adjustTool = toolButton("调整");
  check("找到左侧「调整」工具", Boolean(adjustTool), adjustTool ? "有" : "没有");
  if (adjustTool) flushSync(() => adjustTool.click());
  flushSync(() => {});
  await wait(40);
  const pixel = (x, y) => {
    const canvas = host.querySelector("canvas.vig-ps-canvas");
    if (!canvas) return [];
    return Array.from(canvas.getContext("2d").getImageData(x, y, 1, 1).data);
  };
  const isDark = (rgba) => rgba.length === 4 && rgba[0] < 60 && rgba[1] < 60 && rgba[2] < 60;
  const isLight = (rgba) => rgba.length === 4 && rgba[0] > 200 && rgba[1] > 200 && rgba[2] > 200;
  check("调整前画布左上角是浅色", isLight(pixel(1, 1)), JSON.stringify(pixel(1, 1)));
  const invertButton = toolButton("反相");
  check("找到「反相」开关", Boolean(invertButton), invertButton ? "有" : "没有");
  if (invertButton) flushSync(() => invertButton.click());
  flushSync(() => {});
  const applyButton = Array.from(host.querySelectorAll("button")).find((node) => (node.textContent || "").trim() === "应用");
  check("找到「应用」按钮", Boolean(applyButton), applyButton ? "有" : "没有");
  if (applyButton) flushSync(() => applyButton.click());
  flushSync(() => {});
  await wait(60);
  check("应用反相后左上角变深色", isDark(pixel(1, 1)), JSON.stringify(pixel(1, 1)));
  const historyAfterAdjust = historyItems().map((node) => (node.textContent || "").trim());
  check("历史条里出现「调整」这一步", historyAfterAdjust.some((label) => label === "调整"), JSON.stringify(historyAfterAdjust));
  const undoAfterAdjust = undoButton();
  check("调整之后撤销按钮可用", Boolean(undoAfterAdjust) && undoAfterAdjust.disabled === false, undoAfterAdjust ? "disabled=" + undoAfterAdjust.disabled : "没有撤销按钮");
  if (undoAfterAdjust) flushSync(() => undoAfterAdjust.click());
  flushSync(() => {});
  await wait(60);
  check("点撤销后左上角又变回浅色", isLight(pixel(1, 1)), JSON.stringify(pixel(1, 1)));
  flushSync(() => root.unmount());
} catch (error) {
  check("驱动脚本异常", false, firstLine(error));
}

const pre = document.createElement("pre");
pre.id = "vig-undo-out";
pre.textContent = JSON.stringify({ results });
document.body.appendChild(pre);
`;

const nodeRequire = createRequire(path.join(REACT_ROOT, "anchor.cjs"));
const pkgFile = (pkg, file) => path.join(path.dirname(nodeRequire.resolve(pkg)), "cjs", file);
const schedulerRequire = createRequire(nodeRequire.resolve("react-dom"));
const MODULES = {
  react: pkgFile("react", "react.development.js"),
  "react-dom": pkgFile("react-dom", "react-dom.development.js"),
  "react-dom/client": pkgFile("react-dom", "react-dom-client.development.js"),
  scheduler: path.join(path.dirname(schedulerRequire.resolve("scheduler")), "cjs", "scheduler.development.js")
};
for (const [name, file] of Object.entries(MODULES)) {
  if (!existsSync(file)) {
    console.log(`缺少 ${name} 的浏览器构建：${file}`);
    process.exit(1);
  }
}
const registry = `<script>
window.__vigModules = {};
window.__vigCache = {};
window.__vigRequire = function (name) {
  if (window.__vigCache[name]) return window.__vigCache[name].exports;
  const factory = window.__vigModules[name];
  if (!factory) throw new Error("模块表里没有 " + name);
  const module = { exports: {} };
  window.__vigCache[name] = module;
  factory(module, module.exports, window.__vigRequire);
  return module.exports;
};
</script>
${Object.entries(MODULES)
  .map(
    ([name, file]) => `<script>
window.__vigModules[${JSON.stringify(name)}] = function (module, exports, require) {
const process = { env: { NODE_ENV: "development" } };
${readFileSync(file, "utf8")}
};
</script>`
  )
  .join("\n")}`;

const html = `<!doctype html><html><head><meta charset="utf-8"><title>undo-check</title>
<style>html,body{margin:0;padding:0;background:#fff}</style></head><body>
<script>window.__ModuleLoader__ = { load: (record) => { window.__vigRecord = record; } };</script>
<script>${clientSource}</script>
${registry}
<script>
(async () => {
try {
${driver}
} catch (error) {
  const pre = document.createElement("pre");
  pre.id = "vig-undo-out";
  pre.textContent = JSON.stringify({ results: [{ name: "驱动脚本异常", pass: false, detail: String((error && error.stack) || error) }] });
  document.body.appendChild(pre);
}
})();
</script>
</body></html>`;

const page = path.join(mkdtempSync(path.join(os.tmpdir(), "vig-undo-")), "undo.html");
writeFileSync(page, html, "utf8");
if (!existsSync(CHROME)) {
  console.log(`chrome 未找到：${CHROME}`);
  process.exit(1);
}
const dom = execFileSync(
  CHROME,
  ["--headless=new", "--disable-gpu", "--no-sandbox", "--virtual-time-budget=12000", "--dump-dom", `file:///${page.replace(/\\/g, "/")}`],
  { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 }
);
const match = dom.match(/<pre id="vig-undo-out">([\s\S]*?)<\/pre>/);
if (!match) {
  console.log("没拿到结果节点");
  process.exit(1);
}
const decode = (text) =>
  text.replace(/&quot;/g, '"').replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&#39;/g, "'");
const { results } = JSON.parse(decode(match[1]));
let pass = 0;
let fail = 0;
for (const item of results) {
  if (item.pass) pass += 1;
  else fail += 1;
  console.log(`${item.pass ? "PASS" : "FAIL"}  ${item.name}${item.detail ? ` — ${item.detail}` : ""}`);
}
console.log(`\n撤销/重做 ${pass}/${pass + fail} 通过`);
process.exitCode = fail === 0 && pass > 0 ? 0 : 1;
