// dsh-plugin-velapi-image-go —— 「四点透视矫正」真机验证
//
// 纯函数测得到「矩阵解得对不对」，测不到「真画布上像素真的搬过去了、四个角真能拖」。
// 这个脚本把真 canvas 和真 PsView 挂进真 Chrome（react-dom/client）：
//   A. 算法：造一张「梯形 + 四角色块」的图，按四点拉平，量输出的尺寸与四角颜色
//      （还专门验一条：原图左上角是白的，拉平之后那个位置必须是内容 —— 说明几何真的动了）
//   B. 交互：在真画布上派 pointerdown / pointermove / pointerup 拖角点，看参数栏读数怎么变、
//      乱序取点 / 重置 / 退化 / Esc / 切工具不提交，显式确认后检查像素和撤销
//
//   node tools/warp-check.mjs
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

const driver = `
const React = window.__vigRequire("react");
const { createRoot } = window.__vigRequire("react-dom/client");
const ui = window.__vigRecord.factory((name) => {
	if (name === "react") return React;
	throw new Error("client.js 只应该 require react，实际请求了 " + name);
}).__internals;

const results = [];
const check = (name, pass, detail) => results.push({ name, pass: !!pass, detail: detail == null ? "" : String(detail) });
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const logs = [];
const origError = console.error;
console.error = function () {
	logs.push(Array.prototype.map.call(arguments, (item) => String((item && item.stack) || item)).join(" "));
	origError.apply(console, arguments);
};
window.addEventListener("error", (event) => logs.push("window.error: " + String((event.error && event.error.stack) || event.message)));

const px = (canvas, x, y) => Array.from(canvas.getContext("2d").getImageData(Math.round(x), Math.round(y), 1, 1).data);
const near = (a, b, tol) => Math.abs(a[0] - b[0]) <= tol && Math.abs(a[1] - b[1]) <= tol && Math.abs(a[2] - b[2]) <= tol;
const white = (p) => p[0] > 244 && p[1] > 244 && p[2] > 244;
const RGBA = (canvas, x, y) => "[" + px(canvas, x, y).join(",") + "]";

function newCanvas(w, h) {
	const canvas = document.createElement("canvas");
	canvas.width = w;
	canvas.height = h;
	return canvas;
}

/* 梯形 + 四角色块：左上红、右上绿、右下蓝、左下黄，面是灰的 */
const QUAD = [{ x: 40, y: 40 }, { x: 280, y: 40 }, { x: 350, y: 250 }, { x: 10, y: 250 }];
function skewed() {
	const canvas = newCanvas(360, 300);
	const ctx = canvas.getContext("2d");
	ctx.fillStyle = "#ffffff";
	ctx.fillRect(0, 0, 360, 300);
	ctx.fillStyle = "#8a8f98";
	ctx.beginPath();
	ctx.moveTo(QUAD[0].x, QUAD[0].y);
	for (let i = 1; i < 4; i += 1) ctx.lineTo(QUAD[i].x, QUAD[i].y);
	ctx.closePath();
	ctx.fill();
	const dot = (point, color) => {
		ctx.fillStyle = color;
		ctx.fillRect(point.x - 12, point.y - 12, 24, 24);
	};
	dot(QUAD[0], "#ff2d2d");
	dot(QUAD[1], "#22c55e");
	dot(QUAD[2], "#2f6bff");
	dot(QUAD[3], "#f5c518");
	return canvas;
}

/* 直边 + 四角色块（自由拉伸/变形用） */
function plain() {
	const canvas = newCanvas(200, 100);
	const ctx = canvas.getContext("2d");
	ctx.fillStyle = "#8a8f98";
	ctx.fillRect(0, 0, 200, 100);
	const dot = (x, y, color) => {
		ctx.fillStyle = color;
		ctx.fillRect(x - 10, y - 10, 20, 20);
	};
	dot(0, 0, "#ff2d2d");
	dot(200, 0, "#22c55e");
	dot(200, 100, "#2f6bff");
	dot(0, 100, "#f5c518");
	return canvas;
}

/* 渐变 + 细条纹底图（B 段交互用）：横向红→蓝、纵向压一层白，再叠 8px 一格的明暗条 ——
 * 只要有一点点重采样，像素上就藏不住（平滑渐变上量误差会被抹平）。 */
function gradient() {
	const canvas = newCanvas(200, 100);
	const ctx = canvas.getContext("2d");
	const across = ctx.createLinearGradient(0, 0, 200, 0);
	across.addColorStop(0, "#ff2d2d");
	across.addColorStop(0.5, "#8a8f98");
	across.addColorStop(1, "#2f6bff");
	ctx.fillStyle = across;
	ctx.fillRect(0, 0, 200, 100);
	const down = ctx.createLinearGradient(0, 0, 0, 100);
	down.addColorStop(0, "rgba(255,255,255,0)");
	down.addColorStop(1, "rgba(255,255,255,0.45)");
	ctx.fillStyle = down;
	ctx.fillRect(0, 0, 200, 100);
	for (let x = 0, index = 0; x < 200; x += 8, index += 1) {
		ctx.fillStyle = index % 2 ? "rgba(255,255,255,0.2)" : "rgba(0,0,0,0.2)";
		ctx.fillRect(x, 0, 8, 100);
	}
	return canvas;
}

/* ---------- A. 算法：真 canvas 上量像素 ---------- */
const shot = skewed();
const flatPlan = ui.psWarpPlan({ mode: "flat", src: QUAD, dst: null, width: 360, height: 300 });
check("拉平计划：尺寸 = 对边平均（上 240 / 下 340 → 290，左 212.1 / 右 221.4 → 217）", flatPlan && flatPlan.size.w === 290 && flatPlan.size.h === 217, flatPlan ? flatPlan.size.w + "×" + flatPlan.size.h : "无计划");
const flat = ui.psWarpCanvas(shot, flatPlan.inverse, flatPlan.size.w, flatPlan.size.h);
check("拉平输出：画布尺寸跟着计划走", flat.width === 290 && flat.height === 217, flat.width + "×" + flat.height);
const flatTL = px(flat, 3, 3);
const flatTR = px(flat, flat.width - 4, 3);
const flatBR = px(flat, flat.width - 4, flat.height - 4);
const flatBL = px(flat, 3, flat.height - 4);
check("四角各就各位：左上红 / 右上绿 / 右下蓝 / 左下黄", near(flatTL, [255, 45, 45], 70) && near(flatTR, [34, 197, 94], 70) && near(flatBR, [47, 107, 255], 70) && near(flatBL, [245, 197, 24], 70), [flatTL, flatTR, flatBR, flatBL].map((p) => "[" + p.join(",") + "]").join(" "));
check("中间还是那块灰色面（不是采样错位拉出来的花图）", near(px(flat, 145, 108), [138, 143, 152], 26), RGBA(flat, 145, 108));
check("几何真的动了：原图 (5,5) 是白的，拉平之后同一位置必须是内容", white(px(shot, 5, 5)) && !white(px(flat, 5, 5)), "源 " + RGBA(shot, 5, 5) + " → 出 " + RGBA(flat, 5, 5));
check("输出里没有整块透明的破洞（拉平区域全覆盖）", px(flat, 145, 108)[3] === 255 && px(flat, 40, 20)[3] === 255, "alpha=" + px(flat, 145, 108)[3] + "/" + px(flat, 40, 20)[3]);

/* 自由拉伸：源四点（整图四角）→ 目标任意四边形，输出贴外接矩形，四边形外面留透明 */
const base = plain();
const DST = [{ x: 0, y: 50 }, { x: 150, y: 0 }, { x: 200, y: 50 }, { x: 50, y: 100 }];
const freePlan = ui.psWarpPlan({ mode: "free", src: ui.psQuadCorners(200, 100), dst: DST, width: 200, height: 100 });
const free = ui.psWarpCanvas(base, freePlan.inverse, freePlan.size.w, freePlan.size.h);
check("自由拉伸：八个角都能给，输出尺寸 = 目标四点的外接矩形", free.width === 200 && free.height === 100, free.width + "×" + free.height);
check("自由拉伸：源左上（红）落到目标左上角", near(px(free, 3, 50), [255, 45, 45], 80), RGBA(free, 3, 50));
check("自由拉伸：源右下（蓝）落到目标右下角", near(px(free, 197, 50), [47, 107, 255], 80), RGBA(free, 197, 50));
check("自由拉伸：四边形外面的地方留透明（不是把画布铺满）", px(free, 2, 2)[3] === 0, "alpha=" + px(free, 2, 2)[3]);

/* 变形：取图四点固定是整图四角，只给目标四点 */
const DIST = [{ x: 0, y: 30 }, { x: 170, y: 0 }, { x: 190, y: 70 }, { x: 20, y: 100 }];
const distPlan = ui.psWarpPlan({ mode: "distort", src: ui.psQuadCorners(200, 100), dst: DIST, width: 200, height: 100 });
const distorted = ui.psWarpCanvas(base, distPlan.inverse, distPlan.size.w, distPlan.size.h);
check("变形：整幅图被拉成目标四边形（源左上红仍在目标左上）", near(px(distorted, 2, 30), [255, 45, 45], 80), RGBA(distorted, 2, 30));
check("变形：目标四边形之外是透明的", px(distorted, 2, 2)[3] === 0, "alpha=" + px(distorted, 2, 2)[3]);
check("退化输入不硬算：三点共线的目标四点给不出计划", ui.psWarpPlan({ mode: "free", src: ui.psQuadCorners(200, 100), dst: [{ x: 0, y: 0 }, { x: 50, y: 50 }, { x: 100, y: 100 }, { x: 150, y: 0 }], width: 200, height: 100 }) === null);

/* ---------- B. 交互：真组件上拖角点 ---------- */
const host = document.createElement("div");
host.style.width = "900px";
host.style.height = "640px";
document.body.appendChild(host);
/* 环境钉死：真机页偶尔冒出一条滚动条，画布区宽度就差 10px，适配比例跟着变，
   「结果侧画布 = 拉平尺寸 × 屏幕比例」这条就会偶发差 10px。这是量具的噪声，不是产品问题。 */
document.documentElement.style.overflow = "hidden";
document.body.style.margin = "0";
const root = createRoot(host);
const actions = new Proxy({}, { get: () => async () => ({}) });
const stage = gradient();
window.__vigRequire("react-dom").flushSync(() => {
	root.render(React.createElement(ui.PsView, {
		state: Object.assign({}, window.__vigFixture, { library: [], presets: [] }),
		actions,
		initial: { name: "warp.png", canvas: stage, width: 200, height: 100, tool: "warp", dpi: 72 }
	}));
});
await wait(160);

const view = host.querySelector(".vig-ps-canvas");
if (!view) {
	const pre = document.createElement("pre");
	pre.id = "vig-warp-out";
	pre.textContent = JSON.stringify({ results: [{ name: "挂载失败：找不到真画布", pass: false, detail: logs.slice(0, 3).join(" || ") + " ### " + host.innerHTML.slice(0, 300) }] });
	document.body.appendChild(pre);
	throw new Error("找不到 .vig-ps-canvas");
}
check("挂载成功：真画布出现 + 光标挂 is-warp", !!view && view.className.indexOf("is-warp") > 0, view.className);

const readout = () => {
	const node = host.querySelector(".vig-ps-readout");
	return node ? node.textContent.trim() : "";
};
const segButton = (label) => Array.prototype.slice.call(host.querySelectorAll(".vig-ps-seg-btn")).filter((button) => button.textContent.trim() === label)[0];
const toolButton = (title) => Array.prototype.slice.call(host.querySelectorAll(".vig-ps-tool")).filter((button) => (button.getAttribute("title") || "").indexOf(title) === 0)[0];
const rect = () => view.getBoundingClientRect();
const toClient = (x, y) => {
	const box = rect();
	return { clientX: box.left + x * (box.width / Math.max(1, view.width)), clientY: box.top + y * (box.height / Math.max(1, view.height)) };
};
const pointer = (type, x, y) => {
	view.dispatchEvent(new PointerEvent(type, Object.assign({
		bubbles: true, cancelable: true, composed: true, pointerId: 1, pointerType: "mouse", isPrimary: true,
		button: type === "pointermove" ? -1 : 0, buttons: type === "pointerup" ? 0 : 1
	}, toClient(x, y))));
};
const button = (sel) => host.querySelector(sel);
const confirm = () => button("[data-warp-confirm]");
const click = async (el) => { el.click(); await wait(60); };
const aim = async (x,y) => { pointer("pointerdown",x,y); await wait(40); pointer("pointerup",x,y); await wait(40); };
const drag = async (x,y,u,v,cancel=false) => {
  pointer("pointerdown",x,y); await wait(40); pointer("pointermove",u,v); await wait(40);
  if(cancel){window.dispatchEvent(new KeyboardEvent("keydown",{key:"Escape",bubbles:true}));await wait(40);}
  pointer("pointerup",u,v); await wait(40);
};
const undo = button('.vig-toolbar button[title="撤销"]');
check("平面模式初始无点、无可确认结果", readout()==="已选 0 / 4" && confirm().disabled);
for(const pt of [[20,10],[180,90],[180,10],[20,90]]) await aim(...pt);
check("乱序四角的合法框选能确认",readout()==="输出 160 × 80" && !confirm().disabled,readout());
await drag(20,10,60,35,true);
check("Esc 取消一次拖角且不改底图",readout()==="输出 160 × 80" && view.toDataURL()===stage.toDataURL() && undo.disabled,readout());
await click(button("[data-warp-pick]"));
for(const pt of [[1,1],[10,10],[20,20],[30,30]])await aim(...pt);
check("退化四点不可提交且说明原因",confirm().disabled&&readout().includes("挪一下再试"),readout());
await click(toolButton("裁切"));
check("退出草稿不改像素和历史",view.toDataURL()===stage.toDataURL()&&undo.disabled);
await click(toolButton("透视矫正"));await click(segButton("自由拉伸"));
check("自由拉伸可分别选择取图点和目标点", !!segButton("取图点") && !!segButton("目标点"));
await click(segButton("目标点"));await drag(0,0,25,20);
check("拖目标点仅改草稿，原图逐像素不变",view.toDataURL()===stage.toDataURL() && !confirm().disabled);
await click(confirm());
check("确认自由拉伸后目标外侧透明",px(view,1,1)[3]===0 && px(view,100,50)[3]===255 && !undo.disabled);
await click(undo);await click(segButton("变形"));
check("变形模式只提供目标点",!segButton("取图点") && !!segButton("目标点"));
await drag(0,0,45,25);await click(confirm());
check("变形显式提交后形状改变、可撤回",px(view,1,1)[3]===0 && px(view,120,60)[3]===255);
await click(undo);check("撤回变形恢复原始像素",stage.toDataURL()===view.toDataURL());

const pre = document.createElement("pre");
pre.id = "vig-warp-out";
pre.textContent = JSON.stringify({ results, debug: logs.slice(0, 4) });
document.body.appendChild(pre);
`;

/* Node 侧：react / react-dom / scheduler 的开发版都是自足 CJS（只 require 上面这几个名字） */
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

const html = `<!doctype html><html><head><meta charset="utf-8"><title>warp-check</title>
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
	pre.id = "vig-warp-out";
	pre.textContent = JSON.stringify({ results: [{ name: "驱动脚本异常", pass: false, detail: String((error && error.stack) || error) }] });
	document.body.appendChild(pre);
}
})();
</script>
</body></html>`;

mkdirSync(OUT, { recursive: true });
const page = path.join(mkdtempSync(path.join(os.tmpdir(), "vig-warp-")), "warp.html");
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

const match = dom.match(/<pre id="vig-warp-out">([\s\S]*?)<\/pre>/);
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
console.log(`\n真机四点矫正 ${pass}/${pass + fail} 通过${fail ? `，${fail} 项失败` : ""}`);
process.exit(fail === 0 ? 0 : 1);
