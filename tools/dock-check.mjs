// dsh-plugin-velapi-image-go —— 「侧栏 tab 挂着 ≠ 看得见」真机验证
//
// 用户报障：重启 DSH 后「按键又不见了」。根因是宿主对 keepMounted 的 tab 会一直
// 挂着，非激活时只是被 display:none 藏着；旧代码只认「挂载」，于是停靠面板和入口
// 胶囊一起收起来 —— 工作台一个入口都不剩。
//
// 纯函数 / SSR 测得到「渲染决策」，测不到「IntersectionObserver 在真浏览器里到底
// 怎么判一个 display:none 的盒子」。这个脚本把真的 PaneHost 和真的 RightDock 挂进
// 真的 Chrome，验四件事：
//   1. 可见宿主 → 广播 {mounted:true, visible:true}
//   2. display:none 宿主 → 广播 {mounted:true, visible:false}   ← 报障现场
//   3. 把它显示出来 → 广播翻成 visible:true（观察者真的在动）
//   4. 卸载 → 广播 {mounted:false, visible:false}
// 以及两条渲染断言：隐藏态下 RightDock 真的渲染出入口胶囊、可见态下渲染为空。
//
//   node tools/dock-check.mjs
//
// 环境变量：
//   VIG_REACT_ROOT  含 react / react-dom 的 node_modules（同 test/client.test.mjs）

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
const PANE_EVENT = "velapi-image-go:rightbar-pane";

/* 页面里跑的东西：真组件 + 真观察者 + 收广播。 */
const driver = `
const React = window.__vigRequire("react");
const { createRoot } = window.__vigRequire("react-dom/client");
const { flushSync } = window.__vigRequire("react-dom");
const plugin = window.__vigRecord.factory((name) => window.__vigRequire(name));
const ui = plugin.__internals;
// 入口按钮点下去是 sidebarRight.openTab(kind) —— 这里给一个假的控制器，验「点下去真的叫了它」。
const openedTabs = [];
const fakeSlots = { inject: (_name, register) => { register(); }, register: () => ({ dispose() {} }) };
plugin.apply(
	{
		slots: fakeSlots,
		effect: (fn) => { const disposer = fn(); return () => { if (typeof disposer === "function") disposer(); }; },
		get: () => null,
		sidebarRightTabs: { register: () => ({ dispose() {} }), guide: () => [], get: () => null },
		sidebarRight: { openTab: (kind) => openedTabs.push(kind) }
	},
	{ surfaces: [] }
);

const results = [];
const debug = [];
window.addEventListener("error", (event) => debug.push(String(event.message)));
const check = (name, pass, detail) => results.push({ name, pass: Boolean(pass), detail: detail === undefined ? "" : String(detail) });
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const events = [];
window.addEventListener(${JSON.stringify(PANE_EVENT)}, (event) => events.push(event.detail));
const last = (list) => list[list.length - 1];
const waitFor = async (predicate, ms) => {
	// 一帧一帧等：观察者的回调跟着渲染帧投递，光 sleep 在 --virtual-time-budget 下可能一帧都不出。
	const frame = () => new Promise((resolve) => requestAnimationFrame(() => resolve()));
	const end = Date.now() + ms;
	while (Date.now() < end) {
		if (predicate()) return true;
		await Promise.race([frame(), wait(50)]);
	}
	return predicate();
};
const box = React.createElement("div", { style: { width: "100%", height: "100%" } }, "工作台占位");
// 同一时刻只挂一个 PaneHost：两个都挂上时广播会互相盖掉（真机上只有一个面板）。
const state = () => ui.paneState();

// 1) 可见宿主
const visibleHost = document.createElement("div");
visibleHost.style.cssText = "width:420px;height:320px";
document.body.append(visibleHost);
const visibleRoot = createRoot(visibleHost);
flushSync(() => visibleRoot.render(React.createElement(ui.PaneHost, null, box)));
await wait(250);
check("可见宿主：paneState = mounted+visible", state().mounted === true && state().visible === true, JSON.stringify(state()));
check("可见宿主：真的在屏幕上（onScreen=true，只有它能让停靠层让位）", state().onScreen === true, JSON.stringify(state()));
flushSync(() => visibleRoot.unmount());
await wait(200);
check("可见宿主卸载：paneState 归零", state().mounted === false && state().visible === false, JSON.stringify(state()));

// 1b) 「挂着、几何量也说看得见，但根本没在屏幕上」——右侧栏停在别的页时的真实形态：
//     宿主把面板留在 DOM 里、尺寸也正常，只是整体在视口外。几何量会说谎，观察者不会。
const offscreenHost = document.createElement("div");
offscreenHost.style.cssText = "position:fixed;left:-9999px;top:0;width:420px;height:320px";
document.body.append(offscreenHost);
const offscreenRoot = createRoot(offscreenHost);
flushSync(() => offscreenRoot.render(React.createElement(ui.PaneHost, null, box)));
// 等过观察者的 800ms 宽限期：宽限期内拿不准算「在屏幕上」，之后只认观察者的判断。
await wait(1400);
check(
	"视口外的宿主：mounted=true / visible=true / onScreen=false（几何量说谎的那一档）",
	state().mounted === true && state().visible === true && state().onScreen === false,
	JSON.stringify(state())
);
const offscreenPillHost = document.createElement("div");
document.body.append(offscreenPillHost);
const offscreenPillRoot = createRoot(offscreenPillHost);
flushSync(() =>
	offscreenPillRoot.render(React.createElement(ui.RightDock, { initialPane: { mounted: true, visible: true, onScreen: false }, initialOpen: false, initialWidth: 420 }))
);
check(
	"没在屏幕上（视口外）→ 面板本体照旧在（常驻，没有收起这一档）",
	offscreenPillHost.querySelector(".vig-dock-body") !== null && !/<button class="vig-dock-launch"/.test(offscreenPillHost.innerHTML),
	offscreenPillHost.innerHTML.slice(0, 90)
);
// 真事件把 onScreen 翻成 true → 立刻让位。
// 先把视口外的 PaneHost 卸掉：它每秒的兜底复量会一直广播 onScreen=false，盖掉这条事件。
flushSync(() => offscreenRoot.unmount());
await wait(150);
flushSync(() => window.dispatchEvent(new CustomEvent(${JSON.stringify(PANE_EVENT)}, { detail: { mounted: true, visible: true, onScreen: true } })));
await wait(120);
flushSync(() => {});
check("onScreen 翻成 true → 停靠层让位（事件带 onScreen 的接线是通的）", offscreenPillHost.innerHTML.trim() === "", offscreenPillHost.innerHTML.slice(0, 60));
flushSync(() => offscreenPillRoot.unmount());
await wait(150);

// 2) display:none 宿主 —— 报障现场：tab 挂着，但被宿主藏着
const hiddenHost = document.createElement("div");
hiddenHost.style.cssText = "display:none";
document.body.append(hiddenHost);
const hiddenRoot = createRoot(hiddenHost);
flushSync(() => hiddenRoot.render(React.createElement(ui.PaneHost, null, box)));
await wait(400);
check(
	"display:none 宿主：mounted=true 但 visible=false（报障现场）",
	state().mounted === true && state().visible === false,
	JSON.stringify(state())
);

// 3) 把它显示出来（用户切回工作台那个 tab）→ 必须自己翻回来
const markShow = events.length;
hiddenHost.style.display = "block";
const flipped = await waitFor(() => state().visible === true, 2500);
check("显示出来之后 visible 翻成 true（复量真的在跑）", flipped, JSON.stringify(events.slice(markShow)));

// 渲染决策：隐藏态 + 面板收起 → 必须有入口胶囊；侧栏转为可见 → 立刻让位
const pillHost = document.createElement("div");
document.body.append(pillHost);
const pillRoot = createRoot(pillHost);
flushSync(() =>
	pillRoot.render(React.createElement(ui.RightDock, { initialPane: { mounted: true, visible: false }, initialOpen: false, initialWidth: 420 }))
);
check(
	"宿主把 tab 藏着 → 面板本体在，且没有第二颗浮动胶囊",
	pillHost.querySelector(".vig-dock-body") !== null && !/<button class="vig-dock-launch"/.test(pillHost.innerHTML),
	pillHost.innerHTML.slice(0, 90)
);
// 走真事件而不是改 props：这条同时验了 PANE_EVENT 的接线
flushSync(() => window.dispatchEvent(new CustomEvent(${JSON.stringify(PANE_EVENT)}, { detail: { mounted: true, visible: true } })));
await wait(120);flushSync(() => {});
check("侧栏转为可见 → 停靠层渲染为空（不重复占位）", pillHost.innerHTML.trim() === "", pillHost.innerHTML.slice(0, 60));

// 卸载 → 收尾广播
const markUnmount = events.length;
flushSync(() => hiddenRoot.unmount());
await waitFor(() => state().mounted === false, 800);
const afterUnmount = events.slice(markUnmount);
check(
	"卸载广播 mounted=false / visible=false",
	afterUnmount.some((item) => item.mounted === false && item.visible === false) && state().mounted === false && state().visible === false,
	JSON.stringify(afterUnmount)
);

/* 固定入口：公开落点上的那颗按钮点了必须真把面板叫出来（不依赖任何别的插件）。
   放在所有 PaneHost 都卸掉之后：这时模块里的三态才是干净的「侧栏没在显示工作台」。 */
const launchHost = document.createElement("div");
document.body.append(launchHost);
const launchDockHost = document.createElement("div");
document.body.append(launchDockHost);
window.localStorage.removeItem("dsh.velapi-image-go.dock.v2");
const launchDockRoot = createRoot(launchDockHost);
flushSync(() => launchDockRoot.render(React.createElement(ui.RightDock, { initialPane: { mounted: false, visible: false }, initialOpen: false, initialWidth: 420 })));
const launchRoot = createRoot(launchHost);
flushSync(() => launchRoot.render(React.createElement(ui.WorkbenchLauncher, null)));
const launchButton = launchHost.querySelector("button.vig-launch");
check(
	"入口按钮渲染在公开落点里（一句话：生图工作台）",
	launchButton !== null && launchButton.textContent.includes("生图工作台"),
	launchButton ? launchButton.outerHTML.slice(0, 90) : launchHost.innerHTML.slice(0, 90)
);
flushSync(() => launchButton && launchButton.click());
await wait(120);
check(
	"点那颗按钮 → 叫 sidebarRight.openTab(我们的 kind)，打开右上角侧边栏里的工作台",
	openedTabs.includes("velapi-image-go"),
	JSON.stringify(openedTabs)
);
flushSync(() => launchRoot.unmount());
flushSync(() => launchDockRoot.unmount());
await wait(80);

const pre = document.createElement("pre");
pre.id = "vig-dock-out";
pre.textContent = JSON.stringify({ results, debug });
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

const html = `<!doctype html><html><head><meta charset="utf-8"><title>dock-check</title>
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
	pre.id = "vig-dock-out";
	pre.textContent = JSON.stringify({ results: [{ name: "驱动脚本异常", pass: false, detail: String((error && error.stack) || error) }] });
	document.body.appendChild(pre);
}
})();
</script>
</body></html>`;

const page = path.join(mkdtempSync(path.join(os.tmpdir(), "vig-dock-")), "dock.html");
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

const match = dom.match(/<pre id="vig-dock-out">([\s\S]*?)<\/pre>/);
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
console.log(`\n真机停靠入口 ${pass}/${pass + fail} 通过${fail ? `，${fail} 项失败` : ""}`);
process.exitCode = fail === 0 ? 0 : 1;
