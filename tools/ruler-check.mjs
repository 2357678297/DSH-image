// dsh-plugin-velapi-image-go —— 「鼠标实时矫正」真机验证
//
// 纯函数测得到「角度算得对不对」，测不到「拖的时候画面真的在转、松手真的裁了」。
// 这个脚本把真的 PsView 挂进真的 Chrome（react-dom/client），在真画布上派发
// pointerdown / pointermove / pointerup，然后看：
//   1. 拖动过程中底图的 CSS transform 是不是跟着变（实时预览）
//   2. 参数栏读数是不是跟着跳
//   3. 第二层 canvas 有没有把「裁完还剩多少」的暗角画出来
//   4. 松手之后画面尺寸真的变小了（裁掉斜边）、transform 收回去、toast 报角度
//
//   node tools/ruler-check.mjs
//
// 环境变量：
//   VIG_REACT_ROOT  含 react / react-dom 的 node_modules（同 test/client.test.mjs）

import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { state as FIXTURE_STATE } from "./markup.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, "..");
const OUT = path.join(ROOT, "docs", "preview");
const CHROME = process.env.VIG_CHROME || "C:/Program Files/Google/Chrome/Application/chrome.exe";
const REACT_ROOT = process.env.VIG_REACT_ROOT || "G:/Gg-gank/frontend/deeix-chat/frontend/node_modules";

if (!existsSync(REACT_ROOT)) {
  console.log(`React 目录不存在：${REACT_ROOT}`);
  process.exit(1);
}

const clientSource = readFileSync(path.join(ROOT, "client.js"), "utf8");
const reactPath = (name) => path.join(REACT_ROOT, name).replace(/\\/g, "/");

/* 页面里跑的东西：挂真组件 + 派真事件 + 收结果。
   注意不能用 require("react-dom/client") —— 页面是 file:// 的纯 <script>，
   所以由 Node 侧把 UMD/开发版直接注入。这里改用 ESM 动态 import 的等价做法：
   先把 react / react-dom 的浏览器构建读进来内联。 */
const driver = `
const React = window.__vigRequire("react");
const { createRoot } = window.__vigRequire("react-dom/client");
const ui = window.__vigRecord.factory((name) => {
	if (name === "react") return React;
	throw new Error("client.js 只应该 require react，实际请求了 " + name);
}).__internals;

const results = [];
const check = (name, pass, detail) => results.push({ name, pass: !!pass, detail: detail == null ? "" : String(detail) });

/* 页面里看不到 console，抓起来塞进结果里，免得渲染报错只剩「容器是空的」 */
const logs = [];
const origError = console.error;
console.error = function () {
	logs.push(Array.prototype.map.call(arguments, (item) => String((item && item.stack) || item)).join(" "));
	origError.apply(console, arguments);
};
window.addEventListener("error", (event) => logs.push("window.error: " + String((event.error && event.error.stack) || event.message)));
window.addEventListener("unhandledrejection", (event) => logs.push("unhandled: " + String((event.reason && event.reason.stack) || event.reason)));

/* 一张顺时针歪 3° 的横条纹图，240x240 */
function tilted() {
	const canvas = document.createElement("canvas");
	canvas.width = 240;
	canvas.height = 240;
	const ctx = canvas.getContext("2d");
	ctx.fillStyle = "#ffffff";
	ctx.fillRect(0, 0, 240, 240);
	ctx.save();
	ctx.translate(120, 120);
	ctx.rotate((3 * Math.PI) / 180);
	ctx.translate(-120, -120);
	ctx.fillStyle = "#111111";
	for (let y = -40; y < 300; y += 16) ctx.fillRect(-60, y, 360, 5);
	ctx.restore();
	return canvas;
}

const host = document.createElement("div");
host.style.width = "900px";
host.style.height = "620px";
document.body.appendChild(host);
const root = createRoot(host);

const stage = tilted();
const toasts = [];
const actions = new Proxy({}, {
	get: (target, key) => async (...args) => {
		if (key === "toast") toasts.push(String(args[0]));
		return {};
	}
});
// flushSync：同步渲染，挂完就在 DOM 里，不赌调度时机
window.__vigRequire("react-dom").flushSync(() => {
	root.render(React.createElement(ui.PsView, {
		state: Object.assign({}, window.__vigFixture, { library: [], presets: [] }),
		actions,
		initial: { name: "tilt.png", canvas: stage, width: 240, height: 240, tool: "straighten", dpi: 72 }
	}));
});

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
await wait(120);

const view = host.querySelector(".vig-ps-canvas");
const overlay = host.querySelectorAll("canvas")[1];
const toolbar = host.querySelector(".vig-toolbar");
if (!view) {
	const pre = document.createElement("pre");
	pre.id = "vig-ruler-out";
	pre.textContent = JSON.stringify({ results: [{ name: "挂载失败：找不到真画布", pass: false, detail: logs.slice(0, 3).join(" || ") + " ### " + host.innerHTML.slice(0, 300) }] });
	document.body.appendChild(pre);
	throw new Error("找不到 .vig-ps-canvas");
}
check("挂载成功：真画布出现", !!view && !!overlay, view ? "canvas ok" : "找不到 .vig-ps-canvas");
check("工具是矫正，光标挂 is-ruler", view.className.indexOf("is-ruler") > 0, view.className);

/* 真机上「沿一条歪 3° 的边拖线」= 在图片坐标 (20,120) → (220,120+200*tan3°) 上拖
   画布按 240 逻辑像素 1:1 显示时，clientX/Y 与图片坐标差一个 rect 偏移 */
const rect = view.getBoundingClientRect();
const toClient = (x, y) => ({ clientX: rect.left + x * (rect.width / 240), clientY: rect.top + y * (rect.height / 240) });
const pointer = (type, x, y, extra) => {
	const point = toClient(x, y);
	view.dispatchEvent(new PointerEvent(type, Object.assign({
		bubbles: true, cancelable: true, composed: true, pointerId: 1, pointerType: "mouse", isPrimary: true,
		button: type === "pointermove" ? -1 : 0, buttons: type === "pointerup" ? 0 : 1
	}, point, extra || {})));
};
const dy = 200 * Math.tan((3 * Math.PI) / 180);

pointer("pointerdown", 20, 120);
await wait(60);
pointer("pointermove", 120, 120 + dy / 2);
await wait(60);
const midTransform = view.style.transform;
const midRead = (host.textContent.match(/实时预览\\s*(-?[\\d.]+)°/) || [])[1];
check("拖到一半：底图已经在转（实时，不是松手才转）", /rotate\\(-?[\\d.]+deg\\)/.test(midTransform), midTransform || "(无 transform)");
check("拖到一半：面板读数跟着跳（这条线就是 3°，-3°）", midRead !== undefined && Math.abs(Number(midRead) + 3) < 0.4, "读数 " + midRead);
check("拖到一半：参数栏没有「应用」按钮（PS 标尺不需要按）", host.querySelector('input[type="range"]') === null && host.textContent.indexOf("手动角度") < 0);

/* 第二层 canvas 有没有把「裁完还剩多少」画出来：左上角应该是被压暗的 */
const corner = overlay.getContext("2d").getImageData(2, 2, 1, 1).data;
check("拖到一半：暗角框画出来了（裁掉的部分变暗）", corner[3] > 40, "左上角 alpha=" + corner[3]);

pointer("pointermove", 220, 120 + dy);
await wait(60);
pointer("pointerup", 220, 120 + dy);
await wait(120);

const after = host.querySelector(".vig-ps-canvas");
check("松手：transform 收回去（已经落到像素上了）", !after.style.transform, after.style.transform || "(空)");
const size = (toolbar.textContent.match(/(\\d+)×(\\d+)/) || []);
check("松手：真的裁了（240×240 → 更小的同比例）", Number(size[1]) < 240 && Number(size[1]) > 180 && size[1] === size[2], size.slice(1).join("×") || "?");
check("松手：把角度报给宿主（actions.toast）", toasts.some((item) => /已矫正\\s*-?[\\d.]+°/.test(item)), JSON.stringify(toasts.slice(-2)));
check("提示接对了（页面里不再有 toast is not defined）", logs.filter((line) => line.indexOf("toast is not defined") >= 0).length === 0, logs.slice(0, 1).join(""));

/* Esc 撤销这次拖拽：按下去 → Esc → transform 收回、不裁 */
pointer("pointerdown", 30, 130);
await wait(40);
pointer("pointermove", 200, 130 + dy * 0.85);
await wait(40);
window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
await wait(80);
pointer("pointerup", 200, 130 + dy * 0.85);
await wait(80);
const afterEsc = host.querySelector(".vig-ps-canvas");
check("拖着的时候 Esc：撤掉这次拖拽，画面不动", !afterEsc.style.transform && Number((host.querySelector(".vig-toolbar").textContent.match(/(\\d+)×/) || [])[1]) === Number(size[1]));

const pre = document.createElement("pre");
pre.id = "vig-ruler-out";
pre.textContent = JSON.stringify({ results, debug: logs.slice(0, 4) });
document.body.appendChild(pre);
`;

/* Node 侧：react / react-dom / scheduler 的开发版都是自足 CJS（只 require 上面这几个名字），
   所以页面里搭一个极小的模块表就够，不需要打包器。 */
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

const html = `<!doctype html><html><head><meta charset="utf-8"><title>ruler-check</title>
<style>html,body{margin:0;padding:0;background:#fff}</style></head><body>
<script>window.__ModuleLoader__ = { load: (record) => { window.__vigRecord = record; } };</script>
<script>window.__vigFixture = ${JSON.stringify(FIXTURE_STATE).replace(/</g, "\\u003c")};</script>
<script>${clientSource}</script>
${registry}
<script>
(async () => {
try {
${driver}
} catch (error) {
	const pre = document.createElement("pre");
	pre.id = "vig-ruler-out";
	pre.textContent = JSON.stringify({ results: [{ name: "驱动脚本异常", pass: false, detail: String((error && error.stack) || error) }] });
	document.body.appendChild(pre);
}
})();
</script>
</body></html>`;

mkdirSync(OUT, { recursive: true });
const page = path.join(mkdtempSync(path.join(os.tmpdir(), "vig-ruler-")), "ruler.html");
writeFileSync(page, html, "utf8");

if (!existsSync(CHROME)) {
  console.log(`chrome 未找到：${CHROME}`);
  process.exit(1);
}

const dom = execFileSync(
  CHROME,
  ["--headless=new", "--disable-gpu", "--no-sandbox", "--virtual-time-budget=9000", "--dump-dom", `file:///${page.replace(/\\/g, "/")}`],
  { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 }
);

const match = dom.match(/<pre id="vig-ruler-out">([\s\S]*?)<\/pre>/);
if (!match) {
  console.log("没拿到结果节点。标题里可能有线索：");
  console.log((dom.match(/<title>([\s\S]*?)<\/title>/) || [])[1] || "(无标题)");
  process.exit(1);
}
const decode = (text) =>
  text.replace(/&quot;/g, '"').replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&#39;/g, "'");
const { results, debug } = JSON.parse(decode(match[1]));

let pass = 0;
let fail = 0;
for (const item of results) {
  if (item.pass) pass += 1;
  else fail += 1;
  console.log(`${item.pass ? "PASS" : "FAIL"}  ${item.name}${item.detail ? ` — ${item.detail}` : ""}`);
}
if (debug && debug.length) {
  console.log("\n页面里的报错（前几条）：");
  for (const line of debug) console.log("  · " + line.split("\n")[0].slice(0, 200));
}
console.log(`\n真机鼠标拖拽 ${pass}/${pass + fail} 通过${fail ? `，${fail} 项失败` : ""}`);
process.exit(fail === 0 ? 0 : 1);
