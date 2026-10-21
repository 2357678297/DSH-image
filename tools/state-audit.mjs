// dsh-plugin-velapi-image-go —— 状态审计：图层几何联动（含四点透视）+ undo 记图层
//
// 独立审计脚本（对 task-5 / warp-sync 的产物做黑盒验收，不信任其报告）：
//   * 用 node:vm 搭一个最小浏览器沙箱求值 client.js（window / localStorage / document /
//     会记账的假 canvas），从 window.__ModuleLoader__.load 捕获自注册记录；
//   * record.factory(假 react) → module.exports.__internals，只拿纯函数；
//   * 逐条断言「底图几何变换（六种：crop/rotate/canvasSize/resize/flip/warp）后图层的
//     画布 / 蒙版 alpha / 尺寸」与「撤销快照结构」；warp 的期望值按自定梯形四点手算硬编码。
//
//   node tools/state-audit.mjs
//
// 输出：逐条 PASS/FAIL + 名称 + 关键数值；最后一行「状态审计 N/M 通过」；
// 有 FAIL 时 exitCode = 1，并把每个失败的「输入 → 期望 → 实际」单列出来。

import { readFileSync } from "node:fs";
import path from "node:path";
import vm from "node:vm";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SOURCE = readFileSync(path.join(HERE, "..", "client.js"), "utf8");

/* ------------------------------------------------------------------ *
 * 假画布：只记账。psCrop / psRotate / psResize / psCanvasSize / psFlip /
 * psMaskCanvas / psLayerExport 要的 2d 算子全给桩，drawImage 记录铺图框。
 * ------------------------------------------------------------------ */
function fakeCanvas(width = 1, height = 1) {
	const canvas = { width, height, __log: [], __ctx: null };
	canvas.getContext = (kind) => {
		if (kind !== "2d") return null;
		if (canvas.__ctx) return canvas.__ctx;
		const stack = [];
		const ctx = {
			canvas,
			globalAlpha: 1,
			globalCompositeOperation: "source-over",
			imageSmoothingQuality: "low",
			fillStyle: "#000000",
			strokeStyle: "#000000",
			lineWidth: 1,
			filter: "none",
			__log: canvas.__log,
			translate(x, y) {
				canvas.__log.push({ kind: "translate", args: [x, y] });
			},
			rotate(angle) {
				canvas.__log.push({ kind: "rotate", args: [angle] });
			},
			scale(x, y) {
				canvas.__log.push({ kind: "scale", args: [x, y] });
			},
			setTransform(...args) {
				canvas.__log.push({ kind: "setTransform", args });
			},
			resetTransform() {},
			save() {
				stack.push({ alpha: ctx.globalAlpha, op: ctx.globalCompositeOperation });
				canvas.__log.push({ kind: "save" });
			},
			restore() {
				const prev = stack.pop();
				if (prev) {
					ctx.globalAlpha = prev.alpha;
					ctx.globalCompositeOperation = prev.op;
				}
				canvas.__log.push({ kind: "restore" });
			},
			drawImage(bitmap, ...args) {
				canvas.__log.push({ kind: "draw", bitmap, args: args.slice(), alpha: ctx.globalAlpha, op: ctx.globalCompositeOperation });
			},
			createImageData(w, h) {
				return { width: w, height: h, data: new Uint8ClampedArray(w * h * 4) };
			},
			getImageData(x, y, w, h) {
				canvas.__log.push({ kind: "getImageData", args: [x, y, w, h] });
				return { width: w, height: h, data: new Uint8ClampedArray(w * h * 4) };
			},
			putImageData(imageData, x, y) {
				canvas.__log.push({ kind: "put", imageData, x, y });
			},
			clearRect() {},
			fillRect() {},
			strokeRect() {},
			beginPath() {},
			moveTo() {},
			lineTo() {},
			closePath() {},
			clip() {},
			rect() {},
			fill() {},
			stroke() {},
			setLineDash() {},
			fillText() {},
			strokeText() {},
			arc() {},
			ellipse() {},
			quadraticCurveTo() {},
			bezierCurveTo() {}
		};
		canvas.__ctx = ctx;
		return ctx;
	};
	canvas.toDataURL = (type) => `data:${type || "image/png"};base64,FAKE`;
	return canvas;
}

/* ------------------------------------------------------------------ *
 * 启动沙箱：和浏览器里一样走 window.__ModuleLoader__ → factory(require)。
 * ------------------------------------------------------------------ */
function boot() {
	const loaded = [];
	const created = [];
	const store = {};
	const sandbox = {
		console,
		setTimeout,
		clearTimeout,
		setInterval,
		clearInterval,
		URL,
		fetch: async () => ({ ok: true, status: 200, json: async () => ({}), text: async () => "{}" }),
		navigator: { clipboard: { writeText: async () => {} } },
		document: {
			createElement(tag) {
				const name = String(tag).toLowerCase();
				if (name !== "canvas") throw new Error(`假 document 只支持 canvas，实际收到 ${tag}`);
				const canvas = fakeCanvas();
				created.push(canvas);
				return canvas;
			},
			addEventListener() {},
			removeEventListener() {}
		}
	};
	sandbox.window = {
		location: { origin: "http://127.0.0.1:19387" },
		localStorage: {
			getItem: (key) => (key in store ? store[key] : null),
			setItem(key, value) {
				store[key] = value;
			},
			removeItem(key) {
				delete store[key];
			}
		},
		addEventListener() {},
		removeEventListener() {},
		__ModuleLoader__: {
			load(record) {
				loaded.push(record);
			}
		}
	};
	sandbox.globalThis = sandbox;
	vm.createContext(sandbox);
	vm.runInContext(SOURCE, sandbox, { filename: "client.js" });

	const record = loaded[0];
	if (!record) throw new Error("client.js 没有向 window.__ModuleLoader__ 注册");
	// 只加载 __internals，不渲染组件：一个最小 react 桩就够（模块顶层只取
	// createElement / useLayoutEffect，其余 hook 都在组件体内才调用）。
	const react = {
		createElement: (type, props, ...children) => ({ type, props, children }),
		Fragment: "Fragment",
		useState: (initial) => [typeof initial === "function" ? initial() : initial, () => {}],
		useEffect() {},
		useLayoutEffect() {},
		useMemo: (fn) => fn(),
		useCallback: (fn) => fn,
		useRef: (value) => ({ current: value }),
		memo: (component) => component
	};
	// factory 直接返回 module.exports（不是 module 对象）
	const exported = record.factory((request) => {
		if (request === "react") return react;
		throw new Error(`client.js 只应该 require("react")，实际请求了 ${request}`);
	});
	const ui = exported?.__internals;
	if (!ui) throw new Error("module.exports.__internals 不存在");
	return { ui, module: exported, sandbox, created };
}

/* ------------------------------ 视图工具 ------------------------------ */

const drawsOf = (canvas) => (canvas?.__log ?? []).filter((entry) => entry.kind === "draw");
const transformsOf = (canvas, kind) => (canvas?.__log ?? []).filter((entry) => entry.kind === kind);
/** psMaskCanvas 铺出来的 alpha 覆盖率（按像素顺序取 alpha 通道）。 */
const coverageOf = (canvas) => {
	const put = (canvas?.__log ?? []).filter((entry) => entry.kind === "put").pop();
	if (!put) return [];
	const data = put.imageData.data;
	const pixels = [];
	for (let index = 3; index < data.length; index += 4) pixels.push(data[index]);
	return pixels;
};
const isClampedArray = (value) => Object.prototype.toString.call(value) === "[object Uint8ClampedArray]";
const dimsOf = (canvas) => `${canvas?.width}x${canvas?.height}`;
const box = (entry) => JSON.stringify(entry?.args ?? []);

/* ---------------------------- 逐条断言 ---------------------------- */

const results = [];
function check(id, name, run) {
	let ok = false;
	let detail = "";
	try {
		const out = run();
		ok = Boolean(out?.ok);
		detail = String(out?.detail ?? "");
	} catch (error) {
		ok = false;
		detail = `抛异常：${error?.message ?? error}`;
	}
	results.push({ id, name, ok, detail: detail || (ok ? "" : "见下") });
	console.log(`${ok ? "PASS" : "FAIL"}  ${id}  ${name}${detail ? ` — ${detail}` : ""}`);
}

const { ui, created } = boot();
console.log("[state-audit] dsh-plugin-velapi-image-go · 图层几何联动 + undo 记图层 独立审计");
console.log(`[state-audit] internals 导出 ${Object.keys(ui).length} 项\n`);

/* 1. 裁切：每层画布尺寸 = 新底图尺寸，mask.alpha 长度 = 图层宽×高 */
check("01", "crop：每层画布 = 新底图尺寸，mask.alpha 长度 = 宽×高（含尺寸不一致的层）", () => {
	const base = fakeCanvas(200, 100);
	const crop = { x: 20, y: 10, w: 120, h: 60 };
	const newBase = ui.psCrop(base, crop);
	const l1 = {
		id: "a",
		name: "A",
		mode: "screen",
		opacity: 0.5,
		canvas: fakeCanvas(200, 100),
		mask: { canvas: fakeCanvas(200, 100), alpha: ui.psMaskAlpha(200, 100, null) }
	};
	const l2 = {
		id: "b",
		canvas: fakeCanvas(60, 40),
		mask: { canvas: fakeCanvas(60, 40), alpha: ui.psMaskAlpha(60, 40, null) }
	};
	const layers = [l1, l2];
	const out = ui.psTransformLayers(layers, { kind: "crop", rect: crop, width: 200, height: 100 });
	const a1 = out?.[0]?.mask?.alpha;
	const a2 = out?.[1]?.mask?.alpha;
	const ok =
		newBase.width === 120 &&
		newBase.height === 60 &&
		out !== layers &&
		out.length === 2 &&
		dimsOf(out[0].canvas) === dimsOf(newBase) &&
		dimsOf(out[1].canvas) === dimsOf(newBase) &&
		out[0].width === 120 &&
		out[0].height === 60 &&
		out[1].width === 120 &&
		out[1].height === 60 &&
		isClampedArray(a1) &&
		a1.length === 120 * 60 &&
		isClampedArray(a2) &&
		a2.length === 120 * 60 &&
		dimsOf(out[0].mask.canvas) === "120x60" &&
		dimsOf(out[1].mask.canvas) === "120x60" &&
		out[0].id === "a" &&
		out[0].mode === "screen" &&
		out[0].opacity === 0.5 &&
		dimsOf(l1.canvas) === "200x100" &&
		dimsOf(l2.canvas) === "60x40" &&
		l1.mask.alpha.length === 200 * 100;
	return {
		ok,
		detail: `新底图 ${dimsOf(newBase)}（期望 120x60）；layer1 ${dimsOf(out[0].canvas)} alpha=${a1?.length}；layer2 ${dimsOf(out[1].canvas)} alpha=${a2?.length}；mask 画布 ${dimsOf(out[0].mask.canvas)}`
	};
});

/* 2. 裁切：越界选区被夹回，图层跟着夹 */
check("02", "crop：越界选区被夹回（200×100 裁 x=150,w=100 → 50×50），图层同步", () => {
	const base = fakeCanvas(200, 100);
	const crop = { x: 150, y: 50, w: 100, h: 100 };
	const newBase = ui.psCrop(base, crop);
	const layer = { id: "a", canvas: fakeCanvas(200, 100), mask: { canvas: fakeCanvas(200, 100), alpha: ui.psMaskAlpha(200, 100, null) } };
	const out = ui.psTransformLayers([layer], { kind: "crop", rect: crop, width: 200, height: 100 })[0];
	return {
		ok:
			dimsOf(newBase) === "50x50" &&
			dimsOf(out.canvas) === "50x50" &&
			out.mask.alpha.length === 50 * 50 &&
			dimsOf(out.mask.canvas) === "50x50",
		detail: `新底图 ${dimsOf(newBase)}（期望 50x50）；图层 ${dimsOf(out.canvas)} alpha=${out?.mask?.alpha?.length}（期望 2500）`
	};
});

/* 3. 旋转 90°：宽高互换，mask.alpha 跟着重算（非正方形，上一版测试漏的口子） */
check("03", "rotate 90°：200×100 → 100×200 宽高互换，mask.alpha 长度 20000 且亮区上半→右半", () => {
	const base = fakeCanvas(200, 100);
	const rotated = ui.psRotate(base, 90);
	const alpha = ui.psMaskAlpha(200, 100, { x: 0, y: 0, w: 200, h: 50 }); // 上半亮
	const layer = { id: "r", canvas: fakeCanvas(200, 100), mask: { canvas: fakeCanvas(200, 100), alpha } };
	const out = ui.psTransformLayers([layer], { kind: "rotate", angle: 90, width: 200, height: 100 })[0];
	const next = out.mask.alpha;
	const outW = out.canvas.width;
	const at = (x, y) => next[y * outW + x];
	const geomDims = ui.psGeometryDims({ kind: "rotate", angle: 90 }, 200, 100);
	return {
		ok:
			dimsOf(rotated) === "100x200" &&
			geomDims.w === 100 &&
			geomDims.h === 200 &&
			dimsOf(out.canvas) === "100x200" &&
			out.width === 100 &&
			out.height === 200 &&
			next.length === 100 * 200 &&
			dimsOf(out.mask.canvas) === "100x200" &&
			at(80, 100) === 255 &&
			at(20, 100) === 0 &&
			layer.mask.alpha === alpha,
		detail: `psRotate ${dimsOf(rotated)}；图层 ${dimsOf(out.canvas)}；alpha=${next.length}（期望 20000）；右半 (80,100)=${at(80, 100)}（期望 255），左半 (20,100)=${at(20, 100)}（期望 0）`
	};
});

/* 4. 缩放：图层同比例重采样，蒙版 alpha 长度重算且内容不丢 */
check("04", "resize：200×100 → 300×150，图层画布 300×150、mask.alpha 长度 45000 且内容全 255", () => {
	const base = fakeCanvas(200, 100);
	const resized = ui.psResize(base, 300, 150);
	const layer = { id: "s", canvas: fakeCanvas(200, 100), mask: { canvas: fakeCanvas(200, 100), alpha: ui.psMaskAlpha(200, 100, null) } };
	const out = ui.psTransformLayers([layer], { kind: "resize", w: 300, h: 150, width: 200, height: 100 })[0];
	const pixels = coverageOf(out.mask.canvas);
	const allFull = pixels.length === 45000 && pixels.every((value) => value === 255);
	return {
		ok:
			dimsOf(resized) === "300x150" &&
			dimsOf(out.canvas) === "300x150" &&
			out.mask.alpha.length === 300 * 150 &&
			dimsOf(out.mask.canvas) === "300x150" &&
			out.width === 300 &&
			out.height === 150 &&
			allFull,
		detail: `底图 ${dimsOf(resized)}；图层 ${dimsOf(out.canvas)}；alpha=${out.mask.alpha.length}（期望 45000）；铺图 alpha 全 255=${allFull}`
	};
});

/* 5. 改画布：按锚点重铺，新区域透明，alpha 长度重算 */
check("05", "canvasSize：200×100 → 260×160 anchor=nw，图层贴左上 (0,0)，alpha 新区域 0、长度 41600", () => {
	const base = fakeCanvas(200, 100);
	const expanded = ui.psCanvasSize(base, 260, 160, "nw", "");
	const layer = { id: "c", canvas: fakeCanvas(200, 100), mask: { canvas: fakeCanvas(200, 100), alpha: ui.psMaskAlpha(200, 100, null) } };
	const out = ui.psTransformLayers([layer], { kind: "canvasSize", w: 260, h: 160, anchor: "nw", width: 200, height: 100 })[0];
	const pixels = coverageOf(out.mask.canvas);
	const draw = drawsOf(out.canvas)[0];
	return {
		ok:
			dimsOf(expanded) === "260x160" &&
			dimsOf(out.canvas) === "260x160" &&
			dimsOf(out.mask.canvas) === "260x160" &&
			out.mask.alpha.length === 260 * 160 &&
			pixels.length === 260 * 160 &&
			pixels[0] === 255 &&
			pixels[259] === 0 &&
			pixels[159 * 260] === 0 &&
			drawsOf(out.canvas).length === 1 &&
			box(draw) === "[0,0]",
		detail: `底图 ${dimsOf(expanded)}；图层 ${dimsOf(out.canvas)}；alpha=${out.mask.alpha.length}（期望 41600）；新区域 alpha p[259]=${pixels[259]} p[159*260]=${pixels[159 * 260]}；图层 draw box=${box(draw)}（期望 [0,0]）`
	};
});

/* 6. 翻转：尺寸不变，内容方向镜像；画布 translate/scale 与蒙版 alpha 同向 */
check("06", "flip h：200×100 尺寸不变，mask.alpha 左右镜像（x=0→0, x=199→255），画布 translate(200,0)/scale(-1,1)", () => {
	const base = fakeCanvas(200, 100);
	const flipped = ui.psFlip(base, "h");
	const alpha = ui.psMaskAlpha(200, 100, { x: 0, y: 0, w: 100, h: 100 }); // 左半亮
	const layer = { id: "f", canvas: fakeCanvas(200, 100), mask: { canvas: fakeCanvas(200, 100), alpha } };
	const out = ui.psTransformLayers([layer], { kind: "flip", axis: "h", width: 200, height: 100 })[0];
	const coverage = out.mask.alpha;
	const translate = transformsOf(out.canvas, "translate")[0];
	const scale = transformsOf(out.canvas, "scale")[0];
	return {
		ok:
			dimsOf(flipped) === "200x100" &&
			dimsOf(out.canvas) === "200x100" &&
			out.mask.alpha.length === 200 * 100 &&
			coverage[0] === 0 &&
			coverage[199] === 255 &&
			JSON.stringify(translate?.args) === "[200,0]" &&
			JSON.stringify(scale?.args) === "[-1,1]",
		detail: `底图 ${dimsOf(flipped)}；图层 ${dimsOf(out.canvas)}；alpha=${coverage.length}；x=0→${coverage[0]}（期望 0），x=199→${coverage[199]}（期望 255）；translate=${JSON.stringify(translate?.args)} scale=${JSON.stringify(scale?.args)}`
	};
});

/* 7. 没有图层 / 空 op / 未知 kind：返回空数组或原数组，不抛 */
check("07", "无图层/空输入/未知 kind：返回空数组或原样数组、不抛异常", () => {
	const layer = { id: "a", canvas: fakeCanvas(5, 5) };
	const empty = [];
	const sameEmpty = ui.psTransformLayers(empty, { kind: "crop", rect: { x: 0, y: 0, w: 5, h: 5 }, width: 10, height: 10 });
	const fromUndefined = ui.psTransformLayers(undefined, { kind: "rotate", angle: 90 });
	const fromNull = ui.psTransformLayers(null, { kind: "flip", axis: "h" });
	const list = [layer];
	const unknown = ui.psTransformLayers(list, { kind: "feather" });
	const noOp = ui.psTransformLayers(list, null);
	return {
		ok:
			Array.isArray(empty) &&
			empty.length === 0 &&
			sameEmpty === empty &&
			Array.isArray(fromUndefined) &&
			fromUndefined.length === 0 &&
			Array.isArray(fromNull) &&
			fromNull.length === 0 &&
			unknown === list &&
			noOp === list &&
			unknown[0].canvas === layer.canvas &&
			ui.psTransformLayers([{ id: "no-canvas" }], { kind: "crop", rect: { x: 0, y: 0, w: 1, h: 1 }, width: 5, height: 5 }).length === 1,
		detail: `空数组→${sameEmpty?.length}（期望 0，且同一引用=${sameEmpty === empty}）；undefined→${fromUndefined?.length}；null→${fromNull?.length}；未知 kind 原样=${unknown === list}；op=null 原样=${noOp === list}`
	};
});

/* 8. 图层尺寸与底图不一致：先按底图重铺，再裁；不能拿旧坐标系直接裁掉内容 */
check("08", "尺寸不一致：50×40 图层先重铺到 200×100 再裁 → 100×100（crop 源画布 = 重铺后的 200×100）", () => {
	const base = fakeCanvas(200, 100);
	const crop = { x: 100, y: 0, w: 100, h: 100 };
	const newBase = ui.psCrop(base, crop);
	const layer = { id: "m", canvas: fakeCanvas(50, 40), mask: { canvas: fakeCanvas(50, 40), alpha: ui.psMaskAlpha(50, 40, null) } };
	const out = ui.psTransformLayers([layer], { kind: "crop", rect: crop, width: 200, height: 100 })[0];
	const draws = drawsOf(out.canvas);
	const cropDraw = draws[0];
	// 最终画布的 draw 只有一次「从重铺画布裁一块」；重铺那一步记在中间画布自己的 log 上
	const replate = cropDraw?.bitmap;
	const replateDraw = drawsOf(replate)[0];
	const maskCoverage = coverageOf(out.mask.canvas);
	return {
		ok:
			dimsOf(newBase) === "100x100" &&
			dimsOf(out.canvas) === "100x100" &&
			out.mask.alpha.length === 100 * 100 &&
			maskCoverage.length === 100 * 100 &&
			maskCoverage.every((value) => value === 255) &&
			draws.length === 1 &&
			box(cropDraw) === "[100,0,100,100,0,0,100,100]" &&
			dimsOf(replate) === "200x100" &&
			replate !== layer.canvas &&
			replateDraw?.bitmap === layer.canvas &&
			box(replateDraw) === "[0,0,200,100]",
		detail: `新底图 ${dimsOf(newBase)}；图层 ${dimsOf(out.canvas)}；alpha=${out.mask.alpha.length} 全 255=${maskCoverage.every((value) => value === 255)}；crop 源画布 ${dimsOf(replate)}（重铺 draw bitmap=${replateDraw?.bitmap === layer.canvas} box=${box(replateDraw)}）；crop draw=${box(cropDraw)}`
	};
});

/* 8b. 旋转非 90°：非正方形画布旋转后尺寸按外接矩形变大，alpha 长度一致且角上透明 */
check("08b", "rotate 30°：200×100 → 223×187（外接框变大），alpha=41701，角上 0、中心 255", () => {
	const base = fakeCanvas(200, 100);
	const rotated = ui.psRotate(base, 30);
	const layer = { id: "r30", canvas: fakeCanvas(200, 100), mask: { canvas: fakeCanvas(200, 100), alpha: ui.psMaskAlpha(200, 100, null) } };
	const out = ui.psTransformLayers([layer], { kind: "rotate", angle: 30, width: 200, height: 100 })[0];
	const pixels = out.mask.alpha;
	const geomDims = ui.psGeometryDims({ kind: "rotate", angle: 30 }, 200, 100);
	const cx = Math.floor(out.canvas.width / 2);
	const cy = Math.floor(out.canvas.height / 2);
	return {
		ok:
			dimsOf(rotated) === "223x187" &&
			geomDims.w === 223 &&
			geomDims.h === 187 &&
			dimsOf(out.canvas) === "223x187" &&
			pixels.length === 223 * 187 &&
			dimsOf(out.mask.canvas) === "223x187" &&
			pixels[0] === 0 &&
			pixels[cy * out.canvas.width + cx] === 255,
		detail: `psRotate ${dimsOf(rotated)}；geomDims ${geomDims.w}x${geomDims.h}；图层 ${dimsOf(out.canvas)}；alpha=${pixels.length}（期望 41701）；角 [0]=${pixels[0]}（期望 0），中心=${pixels[cy * out.canvas.width + cx]}（期望 255）`
	};
});

/* 8c. 蒙版坐标系与底图不一致：先归一到旧底图尺寸再变换，alpha 长度按新尺寸 */
check("08c", "蒙版画布 100×50 而底图 200×100：crop 后 alpha 归一重算为 100×50、内容全 255", () => {
	const base = fakeCanvas(200, 100);
	const crop = { x: 50, y: 25, w: 100, h: 50 };
	const newBase = ui.psCrop(base, crop);
	const layer = { id: "cm", canvas: fakeCanvas(200, 100), mask: { canvas: fakeCanvas(100, 50), alpha: ui.psMaskAlpha(100, 50, null) } };
	const out = ui.psTransformLayers([layer], { kind: "crop", rect: crop, width: 200, height: 100 })[0];
	const pixels = coverageOf(out.mask.canvas);
	return {
		ok:
			dimsOf(newBase) === "100x50" &&
			out.mask.alpha.length === 100 * 50 &&
			dimsOf(out.mask.canvas) === "100x50" &&
			pixels.length === 100 * 50 &&
			pixels.every((value) => value === 255),
		detail: `新底图 ${dimsOf(newBase)}；alpha=${out.mask.alpha.length}（期望 5000）；mask 画布 ${dimsOf(out.mask.canvas)}；归一后全 255=${pixels.every((value) => value === 255)}`
	};
});

/* 9. 拉直几何：角度 0 不变；角度非 0 时外接矩形变大，最终尺寸 = 内接框且和 psStraighten 一致 */
check("09", "psStraightenGeometry：0° 不变 200×100；7° 外接框 211×124 ⊃ 原图，最终 162×81 = psStraighten 实测", () => {
	const base = fakeCanvas(200, 100);
	const straight = ui.psStraighten(base, 7);
	const rotated = ui.psRotate(base, 7);
	const zero = ui.psStraightenGeometry(200, 100, 0);
	const zeroRotate = ui.psGeometryDims(zero[0], 200, 100);
	const zeroCrop = ui.psGeometryDims(zero[1], zeroRotate.w, zeroRotate.h);
	const geometry = ui.psStraightenGeometry(200, 100, 7);
	const rotateDims = ui.psGeometryDims(geometry[0], 200, 100);
	const cropDims = ui.psGeometryDims(geometry[1], rotateDims.w, rotateDims.h);
	const rect = geometry[1].rect;
	const inside =
		rect.x >= 0 &&
		rect.y >= 0 &&
		rect.x + rect.w <= rotateDims.w &&
		rect.y + rect.h <= rotateDims.h;
	return {
		ok:
			zero.length === 2 &&
			zero[0].kind === "rotate" &&
			zero[1].kind === "crop" &&
			`${zeroRotate.w}x${zeroRotate.h}` === "200x100" &&
			`${zeroCrop.w}x${zeroCrop.h}` === "200x100" &&
			geometry[0].kind === "rotate" &&
			geometry[1].kind === "crop" &&
			rotateDims.w === rotated.width &&
			rotateDims.h === rotated.height &&
			rotateDims.w > 200 &&
			rotateDims.h > 100 &&
			cropDims.w === straight.width &&
			cropDims.h === straight.height &&
			inside,
		detail: `0° 旋转后 ${zeroRotate.w}x${zeroRotate.h} 最终 ${zeroCrop.w}x${zeroCrop.h}；7° 外接框 ${rotateDims.w}x${rotateDims.h}（⊃200x100），crop rect=${JSON.stringify(rect)}，最终 ${cropDims.w}x${cropDims.h} vs psStraighten ${dimsOf(straight)}`
	};
});

/* 10. 拉直几何应用到图层：图层尺寸/蒙版 alpha 与 psStraighten 一致 */
check("10", "拉直几何 → 图层：图层 162×81、mask.alpha 长度 13122，与 psStraighten 实测尺寸一致", () => {
	const base = fakeCanvas(200, 100);
	const straight = ui.psStraighten(base, 7);
	const geometry = ui.psStraightenGeometry(200, 100, 7).map((step) => ({ ...step, width: 200, height: 100 }));
	const layer = { id: "g", canvas: fakeCanvas(200, 100), mask: { canvas: fakeCanvas(200, 100), alpha: ui.psMaskAlpha(200, 100, null) } };
	const out = ui.psTransformLayers([layer], geometry)[0];
	return {
		ok:
			dimsOf(out.canvas) === dimsOf(straight) &&
			out.width === straight.width &&
			out.height === straight.height &&
			out.mask.alpha.length === straight.width * straight.height &&
			dimsOf(out.mask.canvas) === dimsOf(straight),
		detail: `图层 ${dimsOf(out.canvas)} vs psStraighten ${dimsOf(straight)}；out.width/height=${out.width}x${out.height}；alpha=${out.mask.alpha.length}（期望 ${straight.width * straight.height}）`
	};
});

/* 11. 历史快照结构：带 layers 与 layerSession；没有 canvas 时不产快照 */
check("11", "psHistorySnapshot：带 layers（数组拷贝、元素同引用）与 layerSession；source 无 canvas → null", () => {
	const base = fakeCanvas(200, 100);
	const layers = [{ id: "a", canvas: fakeCanvas(200, 100) }, { id: "b", canvas: fakeCanvas(60, 40) }];
	const session = { id: "b", name: "B", base: { name: "底图.png", canvas: base } };
	const snapshot = ui.psHistorySnapshot({ name: "底图.png", canvas: base }, layers, session);
	const noCanvas = ui.psHistorySnapshot({ name: "只有尺寸", width: 10, height: 10 }, layers, session);
	const noSource = ui.psHistorySnapshot(null, layers, session);
	const beforeLen = snapshot.layers.length;
	layers.push({ id: "c", canvas: fakeCanvas(1, 1) });
	return {
		ok:
			snapshot !== null &&
			snapshot.canvas === base &&
			snapshot.name === "底图.png" &&
			Array.isArray(snapshot.layers) &&
			snapshot.layers !== layers &&
			beforeLen === 2 &&
			snapshot.layers.length === 2 &&
			snapshot.layers[0] === layers[0] &&
			snapshot.layerSession === session &&
			noCanvas === null &&
			noSource === null,
		detail: `快照字段=${Object.keys(snapshot ?? {}).join(",")}；layers 长度 快照 ${snapshot?.layers?.length}/原数组 ${layers.length}（push 后快照不变）；layerSession 同引用=${snapshot?.layerSession === session}；无 canvas→${noCanvas}`
	};
});

/* 12. 旧快照（只有 canvas）容错：不抛、layers 不丢、layerSession 不丢；显式 null 会清空 */
check("12", "psHistoryRestore 旧快照：不抛、layers 沿用当前（不 undefined）、layerSession 沿用；显式 null 尊重", () => {
	const old = { name: "老图.png", canvas: fakeCanvas(20, 10) };
	const layers = [{ id: "a", canvas: fakeCanvas(20, 10) }];
	const session = { id: "a", name: "A", base: { name: "底图.png", canvas: fakeCanvas(20, 10) } };
	const restored = ui.psHistoryRestore(old, { layers, layerSession: session });
	const withoutCurrent = ui.psHistoryRestore(old, null);
	const cleared = ui.psHistoryRestore({ name: "新图.png", canvas: fakeCanvas(30, 20), layers: [], layerSession: null }, { layers, layerSession: session });
	const noCanvas = ui.psHistoryRestore({ name: "没有画布" }, { layers });
	return {
		ok:
			restored !== null &&
			restored.canvas === old.canvas &&
			restored.name === "老图.png" &&
			restored.width === 20 &&
			restored.height === 10 &&
			restored.layers === layers &&
			restored.layers !== undefined &&
			restored.layerSession === session &&
			Array.isArray(withoutCurrent.layers) &&
			withoutCurrent.layers.length === 0 &&
			withoutCurrent.layerSession === null &&
			cleared.layerSession === null &&
			cleared.width === 30 &&
			cleared.height === 20 &&
			noCanvas === null,
		detail: `旧快照→layers 同引用=${restored?.layers === layers}，layers 类型=${Object.prototype.toString.call(restored?.layers)}，layerSession 同引用=${restored?.layerSession === session}；当前为 null→layers=${JSON.stringify(withoutCurrent?.layers)}；显式 session=null→${String(cleared?.layerSession)}；无 canvas→${noCanvas}`
	};
});

/* 13. 撤销/重做走快照：变换前快照 → crop → 撤销回底图 + 原图层 + 会话；重做回变换后 */
check("13", "undo/redo 路径：crop 前快照撤销回 200×100 + 原图层 + 会话，重做回 80×50 + 变换后图层", () => {
	const base = fakeCanvas(200, 100);
	const layer = { id: "a", canvas: fakeCanvas(200, 100), mask: { canvas: fakeCanvas(200, 100), alpha: ui.psMaskAlpha(200, 100, null) } };
	const layers = [layer];
	const session = { id: "a", name: "A", base: { name: "底图.png", canvas: base } };
	const before = ui.psHistorySnapshot({ name: "底图.png", canvas: base }, layers, session);
	const crop = { x: 10, y: 20, w: 80, h: 50 };
	const nextBase = ui.psCrop(base, crop);
	const steps = [{ kind: "crop", rect: crop, width: 200, height: 100, w: nextBase.width, h: nextBase.height }];
	const nextLayers = ui.psTransformLayers(layers, steps);
	const after = ui.psHistorySnapshot({ name: "底图.png", canvas: nextBase }, nextLayers, null);
	const undone = ui.psHistoryRestore(before, { layers: nextLayers, layerSession: null });
	const redone = ui.psHistoryRestore(after, { layers, layerSession: session });
	return {
		ok:
			dimsOf(nextBase) === "80x50" &&
			dimsOf(nextLayers[0].canvas) === "80x50" &&
			undone !== null &&
			undone.canvas === base &&
			undone.width === 200 &&
			undone.height === 100 &&
			undone.layers[0] === layer &&
			undone.layerSession === session &&
			redone !== null &&
			redone.canvas === nextBase &&
			redone.width === 80 &&
			redone.height === 50 &&
			redone.layers[0] === nextLayers[0] &&
			redone.layerSession === null,
		detail: `crop 后底图 ${dimsOf(nextBase)} 图层 ${dimsOf(nextLayers[0].canvas)}；撤销→${undone?.width}x${undone?.height} 图层同引用=${undone?.layers[0] === layer} 会话同引用=${undone?.layerSession === session}；重做→${redone?.width}x${redone?.height} 图层同引用=${redone?.layers[0] === nextLayers[0]} 会话=${String(redone?.layerSession)}`
	};
});

/* 14. sanity：变换后 psLayerExport 的导出尺寸 = 新底图尺寸，所有层按同一个框铺 */
check("14", "sanity：crop 后 psLayerExport 导出 120×60 = 新底图，每层 draw box=[0,0,120,60]（底图+2 层=3 次）", () => {
	const base = fakeCanvas(200, 100);
	const crop = { x: 20, y: 10, w: 120, h: 60 };
	const newBase = ui.psCrop(base, crop);
	const layers = [
		{ id: "a", canvas: fakeCanvas(200, 100), mask: { canvas: fakeCanvas(200, 100), alpha: ui.psMaskAlpha(200, 100, null) } },
		{ id: "b", canvas: fakeCanvas(60, 40), opacity: 0.5, mode: "multiply" }
	];
	const out = ui.psTransformLayers(layers, { kind: "crop", rect: crop, width: 200, height: 100 });
	const exported = ui.psLayerExport(newBase, out, newBase.width, newBase.height);
	const composite = ui.psExportComposite(newBase, out, false);
	const draws = drawsOf(exported);
	const boxes = draws.map((entry) => box(entry));
	return {
		ok:
			dimsOf(newBase) === "120x60" &&
			dimsOf(exported) === dimsOf(newBase) &&
			dimsOf(composite) === dimsOf(newBase) &&
			composite !== newBase &&
			draws.length === 3 &&
			boxes.every((entry) => entry === "[0,0,120,60]") &&
			draws.every((entry) => dimsOf(entry.bitmap) === "120x60") &&
			out.every((layer) => dimsOf(layer.canvas) === dimsOf(newBase)),
		detail: `新底图 ${dimsOf(newBase)}；psLayerExport ${dimsOf(exported)}；psExportComposite ${dimsOf(composite)}；draw ${draws.length} 次 box=${boxes.join(" | ")}；图层尺寸=${out.map((layer) => dimsOf(layer.canvas)).join(",")}`
	};
});

/* 15. 几何矩阵不变量：多种底图尺寸 × 五种算子（含角度 / 锚点 / 翻转）→ 图层尺寸与 alpha 长度都跟底图一致 */
check("15", "几何矩阵不变量：5 种尺寸 × 14 种算子（crop/rotate 多角度/resize/canvasSize/flip）图层尺寸=底图、alpha 长度=新宽×新高", () => {
	const sizes = [[200, 100], [100, 80], [7, 3], [1, 1], [300, 200]];
	const ops = [
		{ step: { kind: "crop", rect: { x: 0, y: 0, w: 100, h: 50 } }, base: (canvas) => ui.psCrop(canvas, { x: 0, y: 0, w: 100, h: 50 }) },
		{ step: { kind: "crop", rect: { x: 5, y: 3, w: 120, h: 90 } }, base: (canvas) => ui.psCrop(canvas, { x: 5, y: 3, w: 120, h: 90 }) },
		{ step: { kind: "rotate", angle: 0 }, base: (canvas) => ui.psRotate(canvas, 0) },
		{ step: { kind: "rotate", angle: 30 }, base: (canvas) => ui.psRotate(canvas, 30) },
		{ step: { kind: "rotate", angle: 45 }, base: (canvas) => ui.psRotate(canvas, 45) },
		{ step: { kind: "rotate", angle: 90 }, base: (canvas) => ui.psRotate(canvas, 90) },
		{ step: { kind: "rotate", angle: 180 }, base: (canvas) => ui.psRotate(canvas, 180) },
		{ step: { kind: "rotate", angle: 270 }, base: (canvas) => ui.psRotate(canvas, 270) },
		{ step: { kind: "rotate", angle: -30 }, base: (canvas) => ui.psRotate(canvas, -30) },
		{ step: { kind: "resize", w: 150, h: 75 }, base: (canvas) => ui.psResize(canvas, 150, 75) },
		{ step: { kind: "resize", w: 1, h: 1 }, base: (canvas) => ui.psResize(canvas, 1, 1) },
		{ step: { kind: "canvasSize", w: 250, h: 180, anchor: "c" }, base: (canvas) => ui.psCanvasSize(canvas, 250, 180, "c", "") },
		{ step: { kind: "canvasSize", w: 50, h: 30, anchor: "nw" }, base: (canvas) => ui.psCanvasSize(canvas, 50, 30, "nw", "") },
		{ step: { kind: "flip", axis: "h" }, base: (canvas) => ui.psFlip(canvas, "h") },
		{ step: { kind: "flip", axis: "v" }, base: (canvas) => ui.psFlip(canvas, "v") }
	];
	const failures = [];
	let combos = 0;
	for (const [width, height] of sizes) {
		for (const op of ops) {
			combos += 1;
			const expected = op.base(fakeCanvas(width, height));
			const geomDims = ui.psGeometryDims(op.step, width, height);
			const layerSame = { id: "s", canvas: fakeCanvas(width, height), mask: { canvas: fakeCanvas(width, height), alpha: ui.psMaskAlpha(width, height, null) } };
			const layerOdd = { id: "o", canvas: fakeCanvas(1, 1), mask: { canvas: fakeCanvas(1, 1), alpha: ui.psMaskAlpha(1, 1, null) } };
			const out = ui.psTransformLayers([layerSame, layerOdd], { ...op.step, width, height });
			const want = `${expected.width}x${expected.height}`;
			const reports = out.map((layer) => {
				const okCanvas = dimsOf(layer.canvas) === want && `${geomDims.w}x${geomDims.h}` === want;
				const alpha = layer.mask?.alpha;
				const okMask =
					isClampedArray(alpha) &&
					alpha.length === expected.width * expected.height &&
					dimsOf(layer.mask.canvas) === want &&
					dimsOf(layer.mask.canvas) === dimsOf(layer.canvas);
				return { ok: okCanvas && okMask && layer.width === expected.width && layer.height === expected.height, actual: `${dimsOf(layer.canvas)}/alpha=${alpha?.length}/mask=${dimsOf(layer.mask?.canvas)}` };
			});
			if (!reports.every((entry) => entry.ok)) {
				failures.push(`${width}x${height} ${op.step.kind}${op.step.angle ?? ""}${op.step.axis ?? ""}${op.step.anchor ?? ""}: 期望 ${want}/alpha=${expected.width * expected.height}，实际 ${reports.map((entry) => entry.actual).join(" & ")}`);
			}
		}
	}
	return {
		ok: failures.length === 0,
		detail: `${combos} 组组合，失败 ${failures.length} 组${failures.length ? `：${failures.slice(0, 3).join("；")}` : ""}`
	};
});

/* 16. 拉直（rotate + crop 两步）矩阵：最终图层尺寸 = psStraighten、alpha 长度 = 最终宽×高 */
check("16", "拉直矩阵：角度 -45/-7/0/7/30/90 × 4 种底图 → 图层尺寸 = psStraighten、alpha 长度 = 最终宽×高", () => {
	const sizes = [[200, 100], [100, 80], [7, 3], [1, 1]];
	const angles = [-45, -7, 0, 7, 30, 90];
	const failures = [];
	let combos = 0;
	for (const [width, height] of sizes) {
		for (const angle of angles) {
			combos += 1;
			const straight = ui.psStraighten(fakeCanvas(width, height), angle);
			const geometry = ui.psStraightenGeometry(width, height, angle).map((step) => ({ ...step, width, height }));
			const layer = { id: "st", canvas: fakeCanvas(width, height), mask: { canvas: fakeCanvas(width, height), alpha: ui.psMaskAlpha(width, height, null) } };
			const out = ui.psTransformLayers([layer], geometry)[0];
			const ok =
				dimsOf(out.canvas) === dimsOf(straight) &&
				out.width === straight.width &&
				out.height === straight.height &&
				out.mask.alpha.length === straight.width * straight.height &&
				dimsOf(out.mask.canvas) === dimsOf(straight);
			if (!ok) {
				failures.push(`${width}x${height} ${angle}°: 期望 ${dimsOf(straight)}/alpha=${straight.width * straight.height}，实际 ${dimsOf(out.canvas)}/alpha=${out.mask.alpha.length}/mask=${dimsOf(out.mask.canvas)}`);
			}
		}
	}
	return {
		ok: failures.length === 0,
		detail: `${combos} 组组合，失败 ${failures.length} 组${failures.length ? `：${failures.slice(0, 3).join("；")}` : ""}`
	};
});

/* 17. 蒙版只有 alpha、没有画布：变换后补画布、长度按新尺寸重算 */
check("17", "只有 alpha 没有画布的蒙版：crop 后补出 120×60 画布、alpha 长度 7200（不抛）", () => {
	const base = fakeCanvas(200, 100);
	const crop = { x: 20, y: 10, w: 120, h: 60 };
	const newBase = ui.psCrop(base, crop);
	const layer = { id: "alpha-only", canvas: fakeCanvas(200, 100), mask: { alpha: ui.psMaskAlpha(200, 100, null) } };
	const out = ui.psTransformLayers([layer], { kind: "crop", rect: crop, width: 200, height: 100 })[0];
	return {
		ok:
			dimsOf(newBase) === "120x60" &&
			!!out.mask &&
			dimsOf(out.mask.canvas) === "120x60" &&
			isClampedArray(out.mask.alpha) &&
			out.mask.alpha.length === 120 * 60,
		detail: `新底图 ${dimsOf(newBase)}；out.mask.canvas=${dimsOf(out.mask?.canvas)}（期望 120x60）；alpha=${out.mask?.alpha?.length}（期望 7200）`
	};
});

/* --------------------------- 透视（warp）几何复审 --------------------------- */
//
// task-6 复审：warp-sync 把四点透视接进了 psTransformLayers（kind: "warp" + plan），
// 提交点 commit(baked, null, { kind: "warp", plan })，「未落定导出」路径也按同一份 plan
// 变形图层。下面用**自定的梯形四点**造 plan：源 200×100 → 目标梯形外接框 300×150，
// 期望值（300×150、映射到源坐标的落点）全部按四点几何手算硬编码，不拿被测函数反推。

const WARP_SRC = [
	{ x: 0, y: 0 },
	{ x: 200, y: 0 },
	{ x: 200, y: 100 },
	{ x: 0, y: 100 }
];
const WARP_DST = [
	{ x: 0, y: 0 },
	{ x: 300, y: 0 },
	{ x: 250, y: 150 },
	{ x: 50, y: 150 }
];
/** 目标梯形的外接框：x 0..300、y 0..150 → 输出 300×150（底图是 200×100）。 */
const WARP_SIZE = { w: 300, h: 150 };
const warpPlanOf = (dst = WARP_DST) => ui.psWarpPlan({ mode: "free", src: WARP_SRC, dst, width: 200, height: 100 });

/* 18. 透视后图层画布尺寸 = plan.size（硬编码 300×150），和底图 200×100 不同 */
check("18", "warp：四点自定梯形（外接框 300×150）→ 每层画布 300×150、宽高字段同步（含尺寸不一致的层）", () => {
	const plan = warpPlanOf();
	const layers = [
		{ id: "wa", canvas: fakeCanvas(200, 100), mask: { canvas: fakeCanvas(200, 100), alpha: ui.psMaskAlpha(200, 100, null) } },
		{ id: "wb", canvas: fakeCanvas(60, 40), mask: { canvas: fakeCanvas(60, 40), alpha: ui.psMaskAlpha(60, 40, null) } }
	];
	const out = ui.psTransformLayers(layers, { kind: "warp", plan, width: 200, height: 100 });
	const put = (canvas) => (canvas?.__log ?? []).filter((entry) => entry.kind === "put").pop();
	return {
		ok:
			plan !== null &&
			plan.size.w === 300 &&
			plan.size.h === 150 &&
			out !== layers &&
			out.length === 2 &&
			dimsOf(out[0].canvas) === "300x150" &&
			dimsOf(out[1].canvas) === "300x150" &&
			out[0].width === 300 &&
			out[0].height === 150 &&
			out[1].width === 300 &&
			out[1].height === 150 &&
			put(out[0].canvas)?.imageData.width === 300 &&
			put(out[0].canvas)?.imageData.height === 150 &&
			// 入参没被改
			dimsOf(layers[0].canvas) === "200x100" &&
			dimsOf(layers[1].canvas) === "60x40",
		detail: `plan.size=${plan?.size?.w}x${plan?.size?.h}（期望 300x150，由梯形外接框 0..300×0..150 手算）；layerA ${dimsOf(out[0].canvas)} layerB ${dimsOf(out[1].canvas)}；putImageData=${put(out[0].canvas)?.imageData.width}x${put(out[0].canvas)?.imageData.height}`
	};
});

/* 19. 透视后 mask.alpha 长度 = 300×150，内容按 plan.inverse 映射（手算落点） */
check("19", "warp：mask.alpha 长度 45000，梯形内外落点符合 plan.inverse（中心 255；左/右/下外侧 0）", () => {
	const plan = warpPlanOf();
	const layer = { id: "wm", canvas: fakeCanvas(200, 100), mask: { canvas: fakeCanvas(200, 100), alpha: ui.psMaskAlpha(200, 100, null) } };
	const out = ui.psTransformLayers([layer], { kind: "warp", plan, width: 200, height: 100 })[0];
	const alpha = out.mask.alpha;
	const at = (x, y) => alpha[y * WARP_SIZE.w + x];
	// 梯形四条边：上边 y=0 横贯 0..300；左边 (0,0)-(50,150) → x=y/3；右边 (300,0)-(250,150) → x=300-y/3
	// 手算 plan.inverse：v=2Y/(450-Y)，u=(X(0.5v+1)-75v)/300，源坐标=(200u,100v)
	const probes = [
		{ x: 150, y: 75, want: 255 }, // 源 (100,40)：梯形正中
		{ x: 150, y: 149, want: 255 }, // 源 (100,99)：底下边内侧
		{ x: 0, y: 75, want: 0 }, // 源 (-20,40)：左边外
		{ x: 299, y: 75, want: 0 }, // 源 (219,40)：右边外
		{ x: 0, y: 149, want: 0 }, // 源 (-49,99)：左下角外
		{ x: 299, y: 149, want: 0 } // 源 (249,99)：右下角外
	];
	const actual = probes.map((probe) => at(probe.x, probe.y));
	const coverage = coverageOf(out.mask.canvas);
	return {
		ok:
			alpha.length === 45000 &&
			dimsOf(out.mask.canvas) === "300x150" &&
			coverage.length === 45000 &&
			coverage[75 * 300 + 150] === 255 &&
			coverage[75 * 300 + 0] === 0 &&
			probes.every((probe, index) => actual[index] === probe.want),
		detail: `alpha=${alpha.length}（期望 45000）mask=${dimsOf(out.mask.canvas)}；落点 ${probes.map((probe, index) => `(${probe.x},${probe.y})=${actual[index]} 期望 ${probe.want}`).join("；")}`
	};
});

/* 20. 图层尺寸与底图不一致：先重铺到 200×100 再透视（重铺画布 draw 与 warp 读取尺寸都是 200×100） */
check("20", "warp：60×40 图层先重铺到 200×100 再透视（重铺 draw [0,0,200,100]、warp 读 getImageData 200×100）", () => {
	const plan = warpPlanOf();
	const layer = { id: "small", canvas: fakeCanvas(60, 40), mask: { canvas: fakeCanvas(60, 40), alpha: ui.psMaskAlpha(60, 40, null) } };
	const beforeCount = created.length;
	const out = ui.psTransformLayers([layer], { kind: "warp", plan, width: 200, height: 100 })[0];
	const createdNow = created.slice(beforeCount);
	// 重铺出来的中间画布：200×100，先把 60×40 的原图层铺满它，再被 psWarpCanvas 读走
	const replate = createdNow.find((canvas) => canvas.width === 200 && canvas.height === 100);
	const replateDraw = drawsOf(replate).find((entry) => entry.bitmap === layer.canvas && box(entry) === "[0,0,200,100]");
	const read = (replate?.__log ?? []).filter((entry) => entry.kind === "getImageData").pop();
	return {
		ok:
			dimsOf(out.canvas) === "300x150" &&
			out.mask.alpha.length === 45000 &&
			!!replate &&
			!!replateDraw &&
			JSON.stringify(read?.args) === "[0,0,200,100]" &&
			// 原图层（60×40）自己没被改，也没被按 60×40 直接透视
			dimsOf(layer.canvas) === "60x40" &&
			drawsOf(layer.canvas).length === 0 &&
			(layer.canvas.__log ?? []).filter((entry) => entry.kind === "getImageData").length === 0,
		detail: `图层 ${dimsOf(out.canvas)}（期望 300x150）；重铺画布 ${dimsOf(replate)} draw=${box(replateDraw)}（期望 [0,0,200,100]）；warp 读取 ${JSON.stringify(read?.args)}（期望 [0,0,200,100]）`
	};
});

/* 21. plan 为 null / 四点退化（psWarpPlan 返回 null）/ plan 字段坏：不抛、尺寸不变 */
check("21", "warp 退化：plan=null / 四点自交凹（psWarpPlan null）/ size=0 / inverse 坏 → 不抛、图层仍 200×100、alpha 20000", () => {
	// 凹四边形（TL,TR,内侧点,BL）不是凸的：计划必须是 null
	const degenerate = ui.psWarpPlan({ mode: "free", src: WARP_SRC, dst: [{ x: 0, y: 0 }, { x: 300, y: 0 }, { x: 150, y: 50 }, { x: 0, y: 150 }], width: 200, height: 100 });
	const variants = [
		{ label: "plan=null", plan: null },
		{ label: "psWarpPlan=null", plan: degenerate },
		{ label: "size=0", plan: { size: { w: 0, h: 0 }, inverse: [1, 0, 0, 0, 1, 0, 0, 0, 1] } },
		{ label: "inverse 坏", plan: { size: { w: 300, h: 150 }, inverse: [1, 2] } }
	];
	const reports = [];
	let allOk = degenerate === null;
	for (const variant of variants) {
		const layer = { id: variant.label, canvas: fakeCanvas(200, 100), mask: { canvas: fakeCanvas(200, 100), alpha: ui.psMaskAlpha(200, 100, null) } };
		try {
			const out = ui.psTransformLayers([layer], { kind: "warp", plan: variant.plan, width: 200, height: 100 })[0];
			const ok =
				dimsOf(out.canvas) === "200x100" &&
				out.width === 200 &&
				out.height === 100 &&
				out.mask.alpha.length === 200 * 100 &&
				dimsOf(out.mask.canvas) === "200x100";
			allOk = allOk && ok;
			reports.push(`${variant.label}: ${ok ? "不变" : `实际 ${dimsOf(out.canvas)}/alpha=${out.mask.alpha.length}`}`);
		} catch (error) {
			allOk = false;
			reports.push(`${variant.label}: 抛异常 ${error?.message ?? error}`);
		}
	}
	return {
		ok: allOk,
		detail: `凹四边形 psWarpPlan=${String(degenerate)}（期望 null）；${reports.join("；")}`
	};
});

/* 22. 没有图层：warp 也不抛、返回空数组或原样 */
check("22", "warp 无图层：[]/undefined/null → 空数组不抛，无 canvas 的层原样返回", () => {
	const plan = warpPlanOf();
	const empty = [];
	const sameEmpty = ui.psTransformLayers(empty, { kind: "warp", plan, width: 200, height: 100 });
	const fromUndefined = ui.psTransformLayers(undefined, { kind: "warp", plan, width: 200, height: 100 });
	const fromNull = ui.psTransformLayers(null, { kind: "warp", plan, width: 200, height: 100 });
	const noPlan = ui.psTransformLayers(empty, { kind: "warp", plan: null, width: 200, height: 100 });
	const bare = { id: "bare" };
	const bareList = [bare];
	const bareOut = ui.psTransformLayers(bareList, { kind: "warp", plan, width: 200, height: 100 });
	return {
		ok:
			Array.isArray(empty) &&
			sameEmpty === empty &&
			fromUndefined.length === 0 &&
			fromNull.length === 0 &&
			noPlan === empty &&
			bareOut.length === 1 &&
			bareOut[0] === bare,
		detail: `[] 同引用=${sameEmpty === empty}；undefined→${fromUndefined?.length}；null→${fromNull?.length}；无 plan→${noPlan?.length}；无 canvas 层原样=${bareOut[0] === bare}（数组是新数组=${bareOut !== bareList}）`
	};
});

/* 23. 「未落定导出」路径 sanity：live 图层按同一份 plan 变形后再合成，导出 = 300×150 且层层对齐 */
check("23", "warp 未落定导出：live 图层按 plan 变形后 psExportComposite=300×150，3 次 draw 全 [0,0,300,150]；撤销回 200×100", () => {
	const plan = warpPlanOf();
	const base = fakeCanvas(200, 100);
	const layers = [
		{ id: "a", canvas: fakeCanvas(200, 100), mask: { canvas: fakeCanvas(200, 100), alpha: ui.psMaskAlpha(200, 100, null) } },
		{ id: "b", canvas: fakeCanvas(200, 100), opacity: 0.5, mode: "multiply" }
	];
	const session = { id: "a", name: "A", base: { name: "底图.png", canvas: base } };
	const before = ui.psHistorySnapshot({ name: "底图.png", canvas: base }, layers, session);
	// 和 PsView 的「未落定导出」同一套：live = warpFullCanvas 结果，layers 先按同一份 plan 变形
	const live = ui.psWarpCanvas(base, plan.inverse, 300, 150);
	const liveLayers = ui.psTransformLayers(layers, { kind: "warp", plan, width: 200, height: 100 });
	const exported = ui.psExportComposite(live, liveLayers, false);
	const draws = drawsOf(exported);
	const boxes2 = draws.map((entry) => box(entry));
	const undone = ui.psHistoryRestore(before, { layers: liveLayers, layerSession: null });
	return {
		ok:
			dimsOf(live) === "300x150" &&
			exported !== live &&
			dimsOf(exported) === "300x150" &&
			draws.length === 3 &&
			boxes2.every((entry) => entry === "[0,0,300,150]") &&
			draws.every((entry) => dimsOf(entry.bitmap) === "300x150") &&
			liveLayers.every((layer) => dimsOf(layer.canvas) === "300x150") &&
			undone !== null &&
			undone.canvas === base &&
			undone.width === 200 &&
			undone.height === 100 &&
			undone.layers[0] === layers[0] &&
			undone.layerSession === session,
		detail: `live=${dimsOf(live)}；导出=${dimsOf(exported)}（期望 300x150）；draw=${draws.length} box=${boxes2.join(" | ")}；撤销→${undone?.width}x${undone?.height} 图层同引用=${undone?.layers[0] === layers[0]} 会话同引用=${undone?.layerSession === session}`
	};
});


/* --------------------------- 接线核对（不计入通过数） --------------------------- */

// 行为断言验的是纯函数；这里再静态核对 PsView 的两个接线点确实存在（防止函数写对了但没人调用）：
//   1) 透视落定提交点：commit(baked, null, { kind: "warp", plan })；
//   2) 未落定时导出：live 图层按同一份 plan 变形（psTransformLayers(layers, { kind: "warp", plan, ... })）。
const warpCommitWired = /commit\(baked, null, \{ kind: "warp", plan \}\)/.test(SOURCE);
const warpLiveExportWired = /live \? psTransformLayers\(layers, \{ kind: "warp", plan, width: stage\.width, height: stage\.height \}\)/.test(SOURCE);
console.log("\n[接线核对] 不计入通过数：");
console.log(
	`  · 落定提交点带 plan=${warpCommitWired}；未落定导出按同一份 plan 变形图层=${warpLiveExportWired}（两者都 true 才说明纯函数真的接进了 PsView）`
);
if (!warpCommitWired || !warpLiveExportWired) {
	results.push({ id: "W", name: "PsView 透视接线核对（静态）", ok: false, detail: `commit 带几何=${warpCommitWired} / live 导出行变形=${warpLiveExportWired}` });
	console.log("  · FAIL：接线缺失，见上面的 false 项");
}

/* ------------------------------- 汇总 ------------------------------- */

const passed = results.filter((entry) => entry.ok).length;
const total = results.length;
const failed = results.filter((entry) => !entry.ok);

if (failed.length > 0) {
	console.log("\n[BUG] 失败断言的「输入 → 期望 → 实际」：");
	for (const entry of failed) {
		console.log(`  ${entry.id} ${entry.name}`);
		console.log(`    实际：${entry.detail}`);
	}
}
console.log(`\n状态审计 ${passed}/${total} 通过`);
if (!passed || failed.length > 0) process.exitCode = 1;
