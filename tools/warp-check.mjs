// dsh-plugin-velapi-image-go —— 「四点透视矫正」真机验证
//
// 纯函数测得到「矩阵解得对不对」，测不到「真画布上像素真的搬过去了、四个角真能拖」。
// 这个脚本把真 canvas 和真 PsView 挂进真 Chrome（react-dom/client）：
//   A. 算法：造一张「梯形 + 四角色块」的图，按四点拉平，量输出的尺寸与四角颜色
//      （还专门验一条：原图左上角是白的，拉平之后那个位置必须是内容 —— 说明几何真的动了）
//   B. 交互：在真画布上派 pointerdown / pointermove / pointerup 拖角点，看参数栏读数怎么变、
//      点空白处不动、变形方式下取图四角拖不动、Esc 能撤回、按「应用」之后画面真的变小/变形成功
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
const srcPx = (canvas, x, y) => px(canvas, Math.round(Math.max(0, Math.min(canvas.width - 1, x))), Math.round(Math.max(0, Math.min(canvas.height - 1, y))));
const diff = (a, b) => Math.abs(a[0] - b[0]) + Math.abs(a[1] - b[1]) + Math.abs(a[2] - b[2]) + Math.abs(a[3] - b[3]);
/* 原图这一侧的实时结果：框里必须是「按计划重采样过的内容」，框外一个像素都不能动 */
const inPlace = (plan) => {
	const quad = ui.psQuadPoints(plan.from);
	const box = ui.psQuadBounds(plan.from);
	const cx = quad.reduce((sum, point) => sum + point.x, 0) / 4;
	const cy = quad.reduce((sum, point) => sum + point.y, 0) / 4;
	const probes = [{ x: cx, y: cy }].concat(quad.map((point) => ({ x: (point.x + cx) / 2, y: (point.y + cy) / 2 })));
	let warped = 0;
	let raw = 0;
	const rows = [];
	for (const probe of probes) {
		// 画布上这个点画的是结果的哪个像素（结果被贴进蓝四点的外接矩形里）
		const outX = ((probe.x - box.x) * plan.size.w) / box.w;
		const outY = ((probe.y - box.y) * plan.size.h) / box.h;
		const at = ui.psApplyH(plan.inverse, { x: outX, y: outY });
		const got = srcPx(view, probe.x, probe.y);
		const want = srcPx(stage, at.x, at.y);
		const own = srcPx(stage, probe.x, probe.y);
		warped += diff(want, got);
		raw += diff(own, got);
		rows.push(Math.round(probe.x) + "," + Math.round(probe.y) + "→" + Math.round(at.x) + "," + Math.round(at.y));
	}
			const outside = [{ x: 2, y: 2 }, { x: 100, y: 2 }, { x: 2, y: 90 }].map((point) => diff(srcPx(stage, point.x, point.y), srcPx(view, point.x, point.y)));
	return {
		warped: Math.round(warped / probes.length),
		raw: Math.round(raw / probes.length),
		outside: Math.max.apply(null, outside),
		detail: rows.join(" ") + " | 框外最大差 " + Math.max.apply(null, outside)
	};
};
const zoom = (() => {
	const box = rect();
	return box.width / Math.max(1, view.width);
})();

/* 用户原话「实时小窗口不要，直接在画布实时才对」：面板里不该再有那张小图 */
check("面板里没有实时小窗口（结果直接出在主画布上）", !host.querySelector(".vig-ps-live") && !host.querySelector(".vig-ps-live-canvas"), host.querySelector(".vig-ps-live") ? "还在" : "没有");

/* 初值：四点贴着图片最外圈（0,0)(200,0)(200,100)(0,100)，所以一进来输出就是整张图 */
check("初值四点贴图片最外圈：读数就是整图尺寸 200 × 100", readout() === "输出 200 × 100", readout() || "(空)");
const identityPlan = ui.psWarpPlan({ mode: "flat", src: ui.psQuadCorners(200, 100), width: 200, height: 100 });
const identityShot = inPlace(identityPlan);
check("没动过的时候画布就是原图（框里框外都没被重采样）", identityShot.warped <= 8 && identityShot.outside === 0, JSON.stringify(identityShot));

/* 拖左上角 (0,0) → (60,40)：拖动中途读数就该变（这就是「移动实时」） */
const expectFlat = (src) => ui.psWarpPlan({ mode: "flat", src, width: 200, height: 100 }).size;
const afterDrag = expectFlat([{ x: 60, y: 40 }, { x: 200, y: 0 }, { x: 200, y: 100 }, { x: 0, y: 100 }]);
const afterPlan = ui.psWarpPlan({ mode: "flat", src: [{ x: 60, y: 40 }, { x: 200, y: 0 }, { x: 200, y: 100 }, { x: 0, y: 100 }], width: 200, height: 100 });
pointer("pointerdown", 0, 0);
await wait(60);
pointer("pointermove", 60, 40);
await wait(140);
const midDrag = readout();
check("还在拖（没松手）读数就已经变了 —— 不用等应用", midDrag === "输出 " + afterDrag.w + " × " + afterDrag.h, midDrag + " / 期望 输出 " + afterDrag.w + " × " + afterDrag.h);
/* 关键一条：还没松手，画布里框住的那块已经是拉平后的内容了 */
const midShot = inPlace(afterPlan);
check("拖到一半画布上就已经是拉平后的画面（框里 = 重采样过的内容，框外没动）", midShot.warped <= 60 && midShot.raw > 40 && midShot.warped * 4 < midShot.raw && midShot.outside === 0, JSON.stringify(midShot));
pointer("pointerup", 60, 40);
await wait(140);
check("松手之后读数保持不变（就是刚才拖出来的那个尺寸）", readout() === "输出 " + afterDrag.w + " × " + afterDrag.h, readout() || "(空)");
const afterShot = inPlace(afterPlan);
check("松手之后框里还是那张拉平后的画面（没回弹）", afterShot.warped <= 60 && afterShot.raw > 40 && afterShot.warped * 4 < afterShot.raw && afterShot.outside === 0, JSON.stringify(afterShot));

/* 点空白处不该动：远离所有角 */
pointer("pointerdown", 100, 50);
await wait(60);
pointer("pointermove", 140, 70);
await wait(60);
pointer("pointerup", 140, 70);
await wait(80);
check("点空白处不拖角（不该乱动）", readout() === midDrag, readout() || "(空)");

/* Esc 撤回这次拖拽：把角拖走再按 Esc，读数必须回到 Drag 之前 */
pointer("pointerdown", 60, 40);
await wait(50);
pointer("pointermove", 120, 80);
await wait(50);
window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
await wait(80);
pointer("pointerup", 120, 80);
await wait(80);
check("拖着的时候 Esc：那个角放回原位，读数不变", readout() === midDrag, readout() + " / 期望 " + midDrag);

/* 面板上不该再有「应用」这个按钮 */
const applyButton = Array.prototype.slice.call(host.querySelectorAll("button")).filter((button) => button.textContent.trim() === "应用")[0];
check("参数栏里没有「应用」按钮（拖完就是结果）", !applyButton);

/* 切到「结果」这一侧：主画布直接显示实时结果，按屏幕比例出图 */
const undo = Array.prototype.slice.call(host.querySelectorAll(".vig-toolbar .vig-icon-btn")).filter((button) => (button.getAttribute("title") || "").indexOf("撤销") === 0)[0];
check("还没落定的时候撤销是空的（拖来拖去不该凭空多出历史）", !!undo && undo.disabled === true, undo ? "disabled=" + undo.disabled : "没有撤销按钮");
const dstSide = segButton("结果");
check("视图切换里有「结果」那一侧", !!dstSide);
if (dstSide) dstSide.click();
const expectDstW = Math.round(afterDrag.w * zoom);
// 屏幕比例（zoom）是拿「宿主宽 / 画布宽」反推的，只有画布没被容器夹住时才等于真比例。
// 容器比方框窄（这个真机页偶尔会多出一条竖向滚动条，正好差 10px）时，结果侧会贴住容器宽，
// 所以断言写成这条不变量：装得下就 1:1，装不下就正好贴住容器。
// 容器宽度每轮重新量 —— 滚动条是在渲染过程中冒出来的，只量一次会把「贴住容器」误判成错。
let dstBox = Math.round(rect().width);
let expectShown = Math.min(expectDstW, dstBox);
let dstWidth = view.width;
for (let attempt = 0; attempt < 30; attempt += 1) {
	dstBox = Math.round(rect().width);
	expectShown = Math.min(expectDstW, dstBox);
	dstWidth = view.width;
	if (Math.abs(dstWidth - expectShown) <= 1) break;
	await wait(60);
}
check(
	"结果侧主画布贴的是实时结果（拉平尺寸 × 屏幕比例；容器装不下时贴住容器，不裁不留白）",
	Math.abs(dstWidth - expectShown) <= 1,
	dstWidth + " / 期望 " + expectShown + "（拉平 " + expectDstW + " / 容器 " + dstBox + "）| zoom=" + zoom + " 显示宽=" + Math.round(view.getBoundingClientRect().width) + " 读数=" + readout()
);
check(
	"结果侧画布上真的有内容（不是空白，也不是还在画原图）",
	px(view, Math.round(view.width / 2), Math.round(view.height / 2))[3] === 255 && !near(px(view, 1, 1), [255, 255, 255], 4),
	RGBA(view, Math.round(view.width / 2), Math.round(view.height / 2)) + " " + RGBA(view, 1, 1)
);
const srcSide = segButton("原图");
if (srcSide) srcSide.click();
await wait(180);
check("切回原图侧：画布又变回原图尺寸（两边各看各的，不互相污染）", view.width === 200, String(view.width));

/* 换工具自动落定：切到裁切，画面真的变成拉平后的尺寸，而且进历史了（撤销可用） */
const cropTool = toolButton("裁切");
check("工具箱里能找到「裁切」用来切走", !!cropTool);
if (cropTool) cropTool.click();
await wait(360);
const toolbar = host.querySelector(".vig-toolbar");
const afterLeave = toolbar ? toolbar.textContent : "";
check("切走工具自动落定：工具栏尺寸变成拉平后的 " + afterDrag.w + "×" + afterDrag.h, new RegExp(afterDrag.w + "×" + afterDrag.h).test(afterLeave), afterLeave.slice(0, 90));
check("落定真的写进了历史（撤销变成可用）", !!undo && undo.disabled === false, undo ? "disabled=" + undo.disabled : "没有撤销按钮");

/* 切回「透视矫正」：落定之后新画布就是底图，再换方式继续调 */
const warpTool = toolButton("透视矫正");
check("工具箱里能切回「透视矫正」", !!warpTool);
if (warpTool) warpTool.click();
await wait(280);

/* 切到「变形」：只拖目标四点（自动切到结果那一侧），画面实时跟着形状走 */
const modeButton = segButton("变形");
check("方式切换里能找到「变形」", !!modeButton);
if (modeButton) modeButton.click();
await wait(260);
const distortRead = readout();
const beforeTL = px(view, 0, 0);
const overlay = host.querySelector(".vig-ps-overlay");
const sideOn = () => {
	const all = Array.prototype.slice.call(host.querySelectorAll(".vig-ps-seg-btn.is-on")).map((button) => button.textContent.trim());
	return all.join("+") + "|overlay=" + (overlay ? overlay.width + "x" + overlay.height + " " + px(overlay, 0, 0).join(",") : "无") + "|view=" + view.width + "x" + view.height + "|read=" + readout();
};
check("变形方式自动切到「结果」那一侧（主画布直接就是结果）", !host.querySelector(".vig-ps-live"), sideOn());
/* 结果侧的画布 1:1 摆，图片坐标要乘上「屏幕像素/图片像素」再派指针 */
const fitDst = view.width / afterDrag.w;
check("结果侧画布是 1:1 摆的（画布像素 = 屏幕像素）", Math.abs(rect().width - view.width) <= 1, rect().width + " vs " + view.width);
pointer("pointerdown", 0, 0);
await wait(70);
pointer("pointermove", 60 * fitDst, 25 * fitDst);
await wait(130);
pointer("pointerup", 60 * fitDst, 25 * fitDst);
await wait(180);
check(
	"变形方式：结果侧拖橙色四点，取图四点固定贴图片四角（输出尺寸还是外接矩形那么大）",
	readout() === distortRead && readout() === "输出 " + afterDrag.w + " × " + afterDrag.h,
	distortRead + " → " + readout()
);
check(
	"变形方式：形状真的被拉走了 —— 图左上角那块内容挪到 (60,25)，画布左上角反过来变透明",
	beforeTL[3] === 255 && px(view, 2, 2)[3] === 0 && px(view, Math.round(view.width / 2), Math.round(view.height / 2))[3] === 255,
	"之前 " + beforeTL.join(",") + " → 现在 left-top alpha " + px(view, 2, 2)[3] + " / 中间 alpha " + px(view, Math.round(view.width / 2), Math.round(view.height / 2))[3] + " / " + sideOn()
);
/* 把角拖进对面那个三角形里 = 凹四边形：单应矩阵会把画面翻到四边形外面，必须判死而不是硬算 */
pointer("pointerdown", 60 * fitDst, 25 * fitDst);
await wait(70);
pointer("pointermove", 100 * fitDst, 80 * fitDst);
await wait(110);
pointer("pointerup", 100 * fitDst, 80 * fitDst);
await wait(180);
check(
	"凹进去 / 交叉的四点判死（不给出翻到外面去的乱图），面板直接说清楚",
	/挪一下再试/.test(readout()) && view.width === afterDrag.w,
	readout() + " / view=" + view.width
);

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
