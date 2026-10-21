// 真机 harness：图层蒙版合成 + 曲线编辑器拖拽。
//
//   node tools/curve-mask-check.mjs
//
// 为什么非得真浏览器：蒙版走的是 canvas 原生 `destination-in`，混合走的是原生
// `multiply`，曲线是在真 DOM 上收 pointerdown / pointermove / contextmenu ——
// 这些行为 Node 里都没有（jsdom 也没有画布像素和真事件坐标）。
//
// 页面里挂的是 loadClientBundle() 取出的那一份 client.js factory 源码，React 用
// node_modules 里的开发版 CJS 构建（和 tools/dock-check.mjs 同一套模块表），所以
// 跑的就是插件自己的代码，不是替身。
//
// 环境变量：
//   VIG_CHROME      chrome.exe 路径（默认 C:/Program Files/Google/Chrome/Application/chrome.exe）
//   VIG_REACT_ROOT  含 react / react-dom 的 node_modules（默认 G:/Gg-gank/frontend/deeix-chat/frontend/node_modules）
//
// 六条：psMaskedCanvas 蒙版裁剪 / destination-in 颜色保持 / psDrawLayers 三层叠加 /
//       蒙版 + 50% 不透明度 / 曲线拖中间点 / 曲线加点与右键删点。

import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";

const CHROME = process.env.VIG_CHROME || "C:/Program Files/Google/Chrome/Application/chrome.exe";
const REACT_ROOT = process.env.VIG_REACT_ROOT || "G:/Gg-gank/frontend/deeix-chat/frontend/node_modules";

if (!existsSync(CHROME)) {
	console.log(`chrome 未找到：${CHROME}`);
	console.log("装 Chrome，或用 VIG_CHROME 指向 chrome.exe 再跑。");
	process.exit(1);
}
if (!existsSync(REACT_ROOT)) {
	console.log(`React 目录不存在：${REACT_ROOT}`);
	console.log("用 VIG_REACT_ROOT 指向含 react / react-dom 的 node_modules 再跑。");
	process.exit(1);
}

// bundle 走 tools/bundle.mjs 的 loadClientBundle()：页面里的 factory 源码就从它取，
// 保证真机跑的是 Node 这里载入的同一份 client.js。
let bundle;
try {
	bundle = await import("./bundle.mjs");
} catch (error) {
	console.log("载入 tools/bundle.mjs 失败（React 依赖可能没装好）：");
	console.log(String((error && error.message) || error));
	process.exit(1);
}

let loaded;
let ui;
try {
	loaded = bundle.loadClientBundle();
	ui = loaded.module && loaded.module.__internals;
} catch (error) {
	console.log("loadClientBundle() 失败：");
	console.log(String((error && error.stack) || error).split("\n").slice(0, 6).join("\n"));
	process.exit(1);
}

// 先做一次 Node 侧的点名：缺把手就别开浏览器了，报清楚缺什么。
const NEEDED = [
	"psMaskAlpha",
	"psMaskCanvas",
	"psMaskedCanvas",
	"psDrawLayers",
	"psBlendOp",
	"psCanvas",
	"psCurveLut",
	"psCurveNormalize",
	"psCurveHit",
	"psCurveMove",
	"psCurveAdd",
	"psCurveRemoveAt",
	"CurveEditor"
];
const missing = !ui ? NEEDED : NEEDED.filter((key) => typeof ui[key] !== "function");
if (!ui || missing.length) {
	console.log("client bundle 缺少内部把手：" + missing.join("、"));
	process.exit(1);
}

/* Node 侧：react / react-dom / scheduler 的开发版都是自足 CJS（只 require 上面这几个
   名字），页面里搭一个极小的模块表就够，不需要打包器（同 tools/dock-check.mjs）。 */
const nodeRequire = bundle.reactRequire;
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

const factorySource = loaded.record.factory.toString();
if (factorySource.indexOf("</script") !== -1) {
	console.log("client bundle 的 factory 源码里含 </script，没法内联进页面。");
	process.exit(1);
}
if (!/^\s*(async\s+)?(\(|function\b)/.test(factorySource)) {
	console.log("factory 源码形态不认识：" + factorySource.slice(0, 60));
	process.exit(1);
}

const driver = `
const results = [];
const check = (name, pass, detail) => results.push({ name: name, pass: Boolean(pass), detail: detail === undefined ? "" : String(detail) });
const near = (a, b, tol) => Math.abs(a - b) <= tol;
const rgba = (data) => "rgba(" + data.join(",") + ")";
const px = (canvas, x, y) => Array.from(canvas.getContext("2d").getImageData(x, y, 1, 1).data);
const firstLine = (error) => String((error && error.stack) || error).split("\\n").slice(0, 2).join(" | ");
const rgbaNear = (data, expect, tol) => expect.every((value, index) => near(data[index], value, tol));
const solid = (width, height, color) => {
	const canvas = document.createElement("canvas");
	canvas.width = width;
	canvas.height = height;
	const ctx = canvas.getContext("2d");
	ctx.fillStyle = color;
	ctx.fillRect(0, 0, width, height);
	return canvas;
};

const LABELS = [
	"1. psMaskedCanvas：红图 + 左半 alpha=0 / 右半 alpha=255 的蒙版 → 合成图左半 alpha=0、右半 alpha=255",
	"2. destination-in 之后右半像素仍是纯红（颜色没被蒙版带偏）",
	"3. psDrawLayers：normal + multiply(128 灰) + 带蒙版层叠在真画布上 → 最终像素符合预期",
	"4. 蒙版 + 不透明度 0.5 → 右半按半强度叠（±3），左半保持原样",
	"5. CurveEditor 真 DOM：pointerdown 拖中间控制点 → onChange 新点 x 变了且仍夹在邻居之间",
	"6. CurveEditor 真 DOM：空白 pointerdown 加点 +1；contextmenu 中间点删点 -1"
];

const run = async (label, fn) => {
	try {
		await fn();
	} catch (error) {
		check(label, false, "区块抛错：" + firstLine(error));
	}
};

try {
	const React = window.__vigRequire("react");
	const ReactDOMClient = window.__vigRequire("react-dom/client");
	const ReactDOM = window.__vigRequire("react-dom");
	const createRoot = ReactDOMClient.createRoot;
	const flushSync = ReactDOM.flushSync;
	const plugin = window.__vigFactory(function (name) { return window.__vigRequire(name); });
	const ui = plugin && plugin.__internals;

	if (!ui) {
		for (const label of LABELS) check(label, false, "client bundle 没给出 __internals");
	} else {
		// ---- 共用素材：40×20，纯红图；蒙版左半 alpha=0、右半 alpha=255 ----
		const W = 40;
		const H = 20;
		const maskAlpha = ui.psMaskAlpha(W, H, { x: W / 2, y: 0, w: W / 2, h: H });
		const maskCanvas = ui.psMaskCanvas(W, H, maskAlpha);
		const red = solid(W, H, "#ff0000");
		const masked = ui.psMaskedCanvas(red, maskCanvas);
		const maskLeft = px(maskCanvas, 5, 10);
		const maskRight = px(maskCanvas, 30, 10);
		const maskedLeft = px(masked, 5, 10);
		const maskedRight = px(masked, 30, 10);

		// 1) 蒙版裁剪：左右 alpha 分界必须干净
		await run(LABELS[0], () => {
			check(
				LABELS[0],
				masked.width === W &&
					masked.height === H &&
					maskLeft[3] === 0 &&
					maskRight[3] === 255 &&
					maskedLeft[3] === 0 &&
					maskedRight[3] === 255,
				"尺寸=" + masked.width + "x" + masked.height + "；蒙版 left=" + rgba(maskLeft) + " right=" + rgba(maskRight) + "；合成 left=" + rgba(maskedLeft) + " right=" + rgba(maskedRight)
			);
		});

		// 2) destination-in 只动 alpha：右边像素的颜色通道必须原样是纯红
		await run(LABELS[1], () => {
			check(
				LABELS[1],
				maskedRight[3] === 255 && maskedRight[0] >= 250 && maskedRight[1] <= 5 && maskedRight[2] <= 5,
				"右半=" + rgba(maskedRight) + "（期望 255,0,0,255）"
			);
		});

		// 3) 三层：白底 → 蓝(normal) → 128 灰(multiply) → 右半红(蒙版层)
		await run(LABELS[2], () => {
			const base = solid(W, H, "#ffffff");
			const ctx = base.getContext("2d");
			const layers = [
				{ id: "normal", canvas: solid(W, H, "#0000ff"), mode: "normal", opacity: 1, visible: true },
				{ id: "multiply", canvas: solid(W, H, "rgb(128,128,128)"), mode: "multiply", opacity: 1, visible: true },
				{ id: "masked", canvas: solid(W, H, "#ff0000"), mode: "normal", opacity: 1, visible: true, mask: maskCanvas }
			];
			const drawn = ui.psDrawLayers(ctx, layers, W, H, (layer) => ui.psMaskedCanvas(layer.canvas, layer.mask));
			const leftPixel = px(base, 5, 10);
			const rightPixel = px(base, 30, 10);
			check(
				LABELS[2],
				drawn === 3 && rgbaNear(leftPixel, [0, 0, 128, 255], 2) && rgbaNear(rightPixel, [255, 0, 0, 255], 2),
				"drawn=" + drawn + "；左=" + rgba(leftPixel) + "（期望 0,0,128）右=" + rgba(rightPixel) + "（期望 255,0,0,255）"
			);
		});

		// 4) 蒙版层不透明度 0.5：红 50% 叠在白底上 = (255,128,128)，左半仍纯白
		await run(LABELS[3], () => {
			const base = solid(W, H, "#ffffff");
			const ctx = base.getContext("2d");
			const drawn = ui.psDrawLayers(
				ctx,
				[{ id: "half", canvas: red, mode: "normal", opacity: 0.5, visible: true, mask: maskCanvas }],
				W,
				H,
				(layer) => ui.psMaskedCanvas(layer.canvas, layer.mask)
			);
			const leftPixel = px(base, 5, 10);
			const rightPixel = px(base, 30, 10);
			const expectRight = [255, 127.5, 127.5, 255];
			const ok =
				drawn === 1 &&
				rgbaNear(leftPixel, [255, 255, 255, 255], 3) &&
				rightPixel[3] === 255 &&
				rgbaNear(rightPixel, expectRight, 3);
			check(
				LABELS[3],
				ok,
				"drawn=" + drawn + "；左=" + rgba(leftPixel) + "（期望纯白）右=" + rgba(rightPixel) + "（期望 255,127~128,127~128）"
			);
		});

		/* ---- 曲线编辑器：真 DOM + 真 PointerEvent ---- */
		const pointOnCurve = (svg, x, y) => {
			const rect = svg.getBoundingClientRect();
			return {
				clientX: rect.left + (x / 255) * rect.width,
				clientY: rect.top + ((255 - y) / 255) * rect.height
			};
		};
		const pointer = (target, type, position) => {
			const event = new PointerEvent(type, {
				bubbles: true,
				cancelable: true,
				composed: true,
				pointerId: 1,
				pointerType: "mouse",
				isPrimary: true,
				button: 0,
				buttons: type === "pointerup" ? 0 : 1,
				clientX: position.clientX,
				clientY: position.clientY
			});
			flushSync(() => {
				target.dispatchEvent(event);
			});
			flushSync(() => {});
			return event;
		};
		const contextMenu = (target, position) => {
			const event = new MouseEvent("contextmenu", {
				bubbles: true,
				cancelable: true,
				button: 2,
				buttons: 2,
				clientX: position.clientX,
				clientY: position.clientY
			});
			flushSync(() => {
				target.dispatchEvent(event);
			});
			flushSync(() => {});
			return event;
		};
		const curveMount = (initial) => {
			const host = document.createElement("div");
			host.style.cssText = "width:320px;height:320px";
			document.body.append(host);
			const state = { points: initial, log: [] };
			const Host = function () {
				const pair = React.useState(initial);
				const points = pair[0];
				const setPoints = pair[1];
				state.points = points;
				return React.createElement(ui.CurveEditor, {
					points: points,
					onChange: (next) => {
						state.log.push(next);
						setPoints(next);
					},
					onApply: () => {}
				});
			};
			const root = createRoot(host);
			flushSync(() => {
				root.render(React.createElement(Host));
			});
			return { host: host, root: root, state: state, svg: host.querySelector("svg.vig-curve-svg") };
		};

		// 5) 拖中间控制点：x 必须变，且仍严格夹在两端之间
		await run(LABELS[4], () => {
			const mount = curveMount([[0, 0], [128, 128], [255, 255]]);
			const svg = mount.svg;
			if (!svg) {
				check(LABELS[4], false, "没找到 svg.vig-curve-svg");
				mount.root.unmount();
				return;
			}
			pointer(svg, "pointerdown", pointOnCurve(svg, 128, 128));
			pointer(svg, "pointermove", pointOnCurve(svg, 160, 90));
			const received = mount.state.log[mount.state.log.length - 1];
			pointer(svg, "pointerup", pointOnCurve(svg, 160, 90));
			const moved = received && received[1];
			const ok =
				Boolean(received) &&
				received.length === 3 &&
				Boolean(moved) &&
				moved[0] !== 128 &&
				near(moved[0], 160, 2) &&
				moved[0] > received[0][0] &&
				moved[0] < received[2][0] &&
				near(moved[1], 90, 2) &&
				received[0][0] === 0 &&
				received[2][0] === 255;
			const rect = svg.getBoundingClientRect();
			mount.root.unmount();
			check(
				LABELS[4],
				ok,
				"svg=" + Math.round(rect.width) + "x" + Math.round(rect.height) + "；onChange 收到 " + (received ? JSON.stringify(received) : "无") + "（原中间点 [128,128]）"
			);
		});

		// 6) 空白处加一个点，再右键把它删掉：2 → 3 → 2
		await run(LABELS[5], () => {
			const mount = curveMount([[0, 0], [255, 255]]);
			const svg = mount.svg;
			if (!svg) {
				check(LABELS[5], false, "没找到 svg.vig-curve-svg");
				mount.root.unmount();
				return;
			}
			const before = mount.state.points.length;
			pointer(svg, "pointerdown", pointOnCurve(svg, 64, 192));
			pointer(svg, "pointerup", pointOnCurve(svg, 64, 192));
			const afterAdd = mount.state.points;
			const addedPoint = afterAdd.length === before + 1 ? afterAdd[1] : null;
			const addOk =
				afterAdd.length === before + 1 &&
				Boolean(addedPoint) &&
				near(addedPoint[0], 64, 2) &&
				near(addedPoint[1], 192, 2);
			let removeOk = false;
			if (addedPoint) {
				contextMenu(svg, pointOnCurve(svg, addedPoint[0], addedPoint[1]));
				removeOk = mount.state.points.length === before;
			}
			const afterRemove = mount.state.points;
			mount.root.unmount();
			check(
				LABELS[5],
				addOk && removeOk,
				"点数 " + before + "→" + afterAdd.length + "→" + afterRemove.length + "；新点=" + (addedPoint ? JSON.stringify(addedPoint) : "无") + "；删后=" + JSON.stringify(afterRemove)
			);
		});
	}
} catch (error) {
	if (results.length === 0) {
		for (const label of LABELS) check(label, false, "驱动异常：" + firstLine(error));
	} else {
		check("驱动脚本异常", false, firstLine(error));
	}
}

const out = document.createElement("pre");
out.id = "vig-curve-mask-out";
out.textContent = JSON.stringify({ results: results });
document.body.appendChild(out);
`;

const html = `<!doctype html><html><head><meta charset="utf-8"><title>curve-mask-check</title>
<style>html,body{margin:0;padding:0;background:#fff}</style></head><body>
<script>
window.__vigFactory = ${factorySource};
</script>
${registry}
<script>
(async () => {
try {
${driver}
} catch (error) {
	const pre = document.createElement("pre");
	try {
		const host = document.createElement("div");
		document.body.appendChild(host);
		const makeImage = (w, h) => {
			const canvas = document.createElement("canvas");
			canvas.width = w;
			canvas.height = h;
			const ctx = canvas.getContext("2d");
			ctx.fillStyle = "#ffffff";
			ctx.fillRect(0, 0, w, h);
			ctx.fillStyle = "#e5484d";
			ctx.fillRect(3, 3, 6, 6);
			return canvas;
		};
		const root = createRoot(host);
		flushSync(() =>
			root.render(
				React.createElement(ui.PsView, {
					state: { library: [], presets: [] },
					actions: { toast: () => {}, attachReference: async () => {} },
					initial: { name: "history.png", canvas: makeImage(60, 40), tool: "rotate" }
				})
			)
		);
		flushSync(() => {});
		const findButton = (label) =>
			Array.from(host.querySelectorAll("button")).find((node) => (node.textContent || "").trim() === label) || null;
		const undoButton = host.querySelector('button[title="撤销"]');
		const redoButton = host.querySelector('button[title="重做"]');
		const sizeText = () => {
			const node = host.querySelector(".vig-ps-title, .vig-item-sub, .vig-ps-size");
			return node ? (node.textContent || "").trim() : host.textContent || "";
		};
		const before = sizeText();
		const turnRight = findButton("顺时针 90°");
		if (turnRight) flushSync(() => turnRight.click());
		flushSync(() => {});
		const rotated = sizeText();
		const undoEnabled = undoButton ? undoButton.disabled === false : false;
		if (undoButton && undoButton.disabled === false) flushSync(() => undoButton.click());
		flushSync(() => {});
		const undone = sizeText();
		const redoEnabled = redoButton ? redoButton.disabled === false : false;
		if (redoButton && redoButton.disabled === false) flushSync(() => redoButton.click());
		flushSync(() => {});
		const redone = sizeText();
		const historyItems = Array.from(host.querySelectorAll(".vig-ps-history-item"));
		check(
			LABELS[6],
			Boolean(turnRight) && undoEnabled && redoEnabled && undone !== rotated && redone !== undone,
			\`旋转后=\${rotated}｜撤销后=\${undone}｜重做后=\${redone}｜撤销可用=\${undoEnabled}｜重做可用=\${redoEnabled}\`
		);
		check(
			LABELS[7],
			historyItems.length >= 2 && historyItems.some((node) => node.className.includes("is-current")),
			\`历史条 \${historyItems.length} 项：\${historyItems.map((node) => (node.textContent || "").trim()).join(" / ")}\`
		);
		flushSync(() => root.unmount());
	} catch (error) {
		check(LABELS[6], false, "撤销用例抛错：" + firstLine(error));
		check(LABELS[7], false, "历史条用例抛错：" + firstLine(error));
	}

	pre.id = "vig-curve-mask-out";
	pre.textContent = JSON.stringify({ results: [{ name: "驱动脚本异常（外层）", pass: false, detail: String((error && error.stack) || error) }] });
	document.body.appendChild(pre);
}
})();
</script>
</body></html>`;

const page = path.join(mkdtempSync(path.join(os.tmpdir(), "vig-curve-mask-")), "curve-mask-check.html");
writeFileSync(page, html, "utf8");

console.log(`chrome：${CHROME}`);
console.log(`react：${bundle.React.version} @ ${REACT_ROOT}`);
console.log(`client bundle：${loaded.record.id}（loadClientBundle() 取出 factory 源码 ${factorySource.length} 字符）`);
console.log(`临时页面：${page}`);
console.log("");

let dom;
try {
	dom = execFileSync(
		CHROME,
		[
			"--headless=new",
			"--disable-gpu",
			"--no-sandbox",
			"--virtual-time-budget=12000",
			"--dump-dom",
			`file:///${page.replace(/\\/g, "/")}`
		],
		{ encoding: "utf8", maxBuffer: 256 * 1024 * 1024, timeout: 180000, windowsHide: true }
	);
} catch (error) {
	console.log("Chrome 跑不起来（headless 启动失败）：" + CHROME);
	console.log(String((error && error.stderr) || (error && error.message) || error).split("\n").slice(0, 10).join("\n"));
	process.exit(1);
}

const match = dom.match(/<pre id="vig-curve-mask-out">([\s\S]*?)<\/pre>/);
if (!match) {
	console.log("没拿到结果节点。标题里可能有线索：");
	console.log((dom.match(/<title>([\s\S]*?)<\/title>/) || [])[1] || "(无标题)");
	process.exit(1);
}
const decode = (text) =>
	text
		.replace(/&quot;/g, '"')
		.replace(/&amp;/g, "&")
		.replace(/&lt;/g, "<")
		.replace(/&gt;/g, ">")
		.replace(/&#39;/g, "'");

let payload;
try {
	payload = JSON.parse(decode(match[1]));
} catch (error) {
	console.log("结果节点不是合法 JSON：" + String((error && error.message) || error));
	console.log(decode(match[1]).slice(0, 500));
	process.exit(1);
}

let pass = 0;
let fail = 0;
for (const item of payload.results || []) {
	if (item.pass) pass += 1;
	else fail += 1;
	console.log(`${item.pass ? "PASS" : "FAIL"}  ${item.name}${item.detail ? ` — ${item.detail}` : ""}`);
}
if (!payload.results || payload.results.length === 0) console.log("页面没有产出任何检查项。");
console.log(`\n真机曲线/蒙版 ${pass}/${pass + fail} 通过`);
process.exitCode = fail === 0 && pass > 0 ? 0 : 1;
