// dsh-plugin-velapi-image-go —— 像素引擎独立测试
//
// client.js 是给 DSH 的 __ModuleLoader__ 用的自注册 bundle，不能 import。
// 这里照 test/client.test.mjs 的做法：读源码文本 → 最小浏览器沙箱 → vm 求值 →
// 从 __ModuleLoader__.load 抓 record → record.factory(假 react) → module.exports.__internals。
//
// 本文件只看纯函数（Uint8ClampedArray / LUT / 控制点），不渲染、不碰 canvas、
// 不发网络请求。和 client.test.mjs 完全独立，也不依赖它。
//
//   node test/engine.test.mjs
//
// 每条断言都写了「为什么」，失败时打印期望值与实际值。

import { readFileSync } from "node:fs";
import vm from "node:vm";

const SOURCE = readFileSync(new URL("../client.js", import.meta.url), "utf8");

let passed = 0;
let total = 0;

/** 一条断言：打印 PASS/FAIL + 名称；失败就记进 exitCode。 */
function check(name, ok, extra = "") {
	total += 1;
	if (ok) passed += 1;
	console.log(`${ok ? "  PASS" : "  FAIL"}  ${name}${extra ? ` — ${extra}` : ""}`);
	if (!ok) process.exitCode = 1;
}

/** 字节序列断言（Uint8ClampedArray / 普通数组都能比）。 */
function sameBytes(name, actual, expected, why = "") {
	const got = Array.from(actual ?? []);
	const ok = got.length === expected.length && got.every((value, index) => value === expected[index]);
	check(why ? `${name}（${why}）` : name, ok, ok ? "" : `期望 [${expected}] 实际 [${got}]`);
}

/** 控制点列表断言：[[x,y],...] 精确比较。 */
function samePoints(name, actual, expected, why = "") {
	const got = Array.isArray(actual) ? actual.map((point) => Array.from(point)) : actual;
	const ok = JSON.stringify(got) === JSON.stringify(expected);
	check(why ? `${name}（${why}）` : name, ok, ok ? "" : `期望 ${JSON.stringify(expected)} 实际 ${JSON.stringify(got)}`);
}

/* ---- 加载 bundle：最小浏览器沙箱 ---------------------------------- */

function boot() {
	const loaded = [];
	// factory 里只 require("react")，而且只取 createElement / 几个 hook；
	// 我们一个组件都不渲染，所以给一个够用的桩就行，不需要真的 react。
	const fakeReact = {
		createElement: () => null,
		Fragment: Symbol.for("react.fragment"),
		useCallback: (fn) => fn,
		useEffect: () => {},
		useLayoutEffect: () => {},
		useMemo: (fn) => fn(),
		useRef: (initial) => ({ current: initial }),
		useState: (initial) => [typeof initial === "function" ? initial() : initial, () => {}]
	};
	const sandbox = {
		console,
		setTimeout,
		clearTimeout,
		clearInterval,
		URL,
		navigator: { clipboard: { writeText: async () => {} } },
		// document 桩：bundle 顶层只做 typeof 判断，真正的 DOM 访问都在组件函数里，
		// 测试不会走到；有桩可以保证 typeof document !== "undefined" 这一支也不炸。
		document: {
			createElement: () => ({
				getContext: () => null,
				style: {},
				appendChild: () => {},
				setAttribute: () => {},
				remove: () => {}
			}),
			querySelector: () => null,
			querySelectorAll: () => [],
			body: { appendChild: () => {} },
			addEventListener: () => {},
			removeEventListener: () => {}
		}
	};
	sandbox.window = {
		location: { origin: "http://127.0.0.1:0" },
		localStorage: {
			getItem: () => null,
			setItem: () => {},
			removeItem: () => {}
		},
		addEventListener: () => {},
		removeEventListener: () => {},
		setTimeout,
		clearTimeout,
		__ModuleLoader__: { load: (record) => loaded.push(record) }
	};
	sandbox.globalThis = sandbox;
	vm.createContext(sandbox);
	vm.runInContext(SOURCE, sandbox, { filename: "client.js" });
	const record = loaded[0];
	if (!record) throw new Error("client.js 没有向 window.__ModuleLoader__ 注册");
	const module = record.factory((request) => {
		if (request === "react") return fakeReact;
		throw new Error(`client.js 只应该 require("react")，实际请求了 ${request}`);
	});
	const internals = module?.__internals;
	if (!internals) throw new Error("module.exports.__internals 不存在");
	return internals;
}

const I = boot();

/* ---- 0. bundle 形态 ------------------------------------------------- */

check("client.js 自注册且 __internals 可用", I !== null && typeof I === "object");

const REQUIRED = [
	"psAdjustPixels",
	"psCurveLut",
	"psCurvePreset",
	"psCurveNormalize",
	"psCurveHit",
	"psCurveMove",
	"psCurveAdd",
	"psCurveRemoveAt",
	"psLevelsLut",
	"psApplyLutPixels",
	"psVibrancePixels",
	"psBoxBlurPixels",
	"psSharpenPixels",
	"psNoisePixels",
	"psMaskAlpha",
	"psInvertAlpha"
];
const missing = REQUIRED.filter((name) => typeof I[name] !== "function");
check("__internals 暴露全部 16 个像素引擎函数", missing.length === 0, missing.length ? `缺少 ${missing.join(",")}` : "");

/* ---- 1. psAdjustPixels ---------------------------------------------- */

const emptyAdjust = new Uint8ClampedArray(0);
check(
	"psAdjustPixels 空数组原样返回（0 像素时循环体不执行，不该凭空造数）",
	I.psAdjustPixels(emptyAdjust, { brightness: 50 }) === emptyAdjust && emptyAdjust.length === 0
);

/* ---- 透视矫正数学：四点 → 规范矩形 ---- */
{
  // 异形（倾斜、透视）四边形，模拟拍照时的屏幕/纸张
  const quad = [
    { x: 100, y: 80 },
    { x: 520, y: 140 },
    { x: 480, y: 420 },
    { x: 60, y: 360 }
  ];
  const plan = I.psWarpPlan({ mode: "flat", src: quad, width: 800, height: 600 });
  const mapped = plan ? plan.from.map((point) => I.psApplyH(plan.forward, point)) : [];
  const forwardOk =
    Boolean(plan) &&
    mapped.length === 4 &&
    mapped.every((point, index) => Math.hypot(point.x - plan.to[index].x, point.y - plan.to[index].y) < 1);
  check("透视矫正数学：forward 把四个角准确映射到矩形四角", forwardOk, JSON.stringify({ size: plan?.size, mapped }));
  const back = plan ? plan.to.map((point) => I.psApplyH(plan.inverse, point)) : [];
  const backOk =
    Boolean(plan) &&
    back.length === 4 &&
    back.every((point, index) => Math.hypot(point.x - plan.from[index].x, point.y - plan.from[index].y) < 1);
  check("透视矫正数学：inverse 把矩形四角映射回原四点（采样方向正确）", backOk, JSON.stringify({ back }));
}
check("psAdjustPixels null 原样返回（无图可调时不抛异常）", I.psAdjustPixels(null, { brightness: 50 }) === null);

{
	const data = new Uint8ClampedArray([10, 20, 30, 40]);
	const returned = I.psAdjustPixels(data, { brightness: 100 });
	check("psAdjustPixels 就地修改并返回同一个数组（调用方不必接返回值）", returned === data);
	// brightness 100 → offset = 255，10+255/20+255/30+255 全部超过 255 → 夹到 255；alpha 不参与
	sameBytes("psAdjustPixels 亮度 +100 三通道全部饱和到 255，alpha=40 保持不动", data, [255, 255, 255, 40], "10/20/30 各加 255 后越界");
}
sameBytes(
	"psAdjustPixels 亮度 -100 三通道全部压到 0",
	I.psAdjustPixels(new Uint8ClampedArray([10, 20, 30, 40]), { brightness: -100 }),
	[0, 0, 0, 40],
	"10/20/30 各减 255 后为负，被 psClampByte 夹到 0"
);

/* ---- size 表达式（档位 + 宽高比） ---- */
{
  check("size 表达式：2K · 16:9 → 3072x1728", I.resolveSizeExpression("2K · 16:9") === "3072x1728", I.resolveSizeExpression("2K · 16:9"));
  check("size 表达式：4K → 4096x4096", I.resolveSizeExpression("4K") === "4096x4096", I.resolveSizeExpression("4K"));
  check("size 表达式：只有比例时按 fallback 档位（2048 宽 → 2K）", I.resolveSizeExpression("16:9", "2048x1152") === "3072x1728", I.resolveSizeExpression("16:9", "2048x1152"));
  check("size 表达式：像素原样保留", I.resolveSizeExpression("1280x720") === "1280x720", I.resolveSizeExpression("1280x720"));
}
{
	const a = I.psAdjustPixels(new Uint8ClampedArray([0, 100, 200, 255]), { brightness: 100 });
	const b = I.psAdjustPixels(new Uint8ClampedArray([0, 100, 200, 255]), { brightness: 999 });
	sameBytes("psAdjustPixels brightness 999 被夹到 100（参数上限），结果与 +100 完全一致", b, Array.from(a), "Math.max(-100, Math.min(100, ...))");
}
sameBytes(
	"psAdjustPixels 反相 10/20/30 → 245/235/225，alpha=40 不反相",
	I.psAdjustPixels(new Uint8ClampedArray([10, 20, 30, 40]), { invert: true }),
	[245, 235, 225, 40],
	"255-10/255-20/255-30；透明度不是颜色，不参与反相"
);
sameBytes(
	"psAdjustPixels 灰度把纯红 (255,0,0) 变成 r=g=b=128",
	I.psAdjustPixels(new Uint8ClampedArray([255, 0, 0, 255]), { grayscale: true }),
	[128, 128, 128, 255],
	"HSL 里红色的明度 l=0.5，去饱和后 0.5×255=127.5 四舍五入为 128"
);
{
	const plus = I.psAdjustPixels(new Uint8ClampedArray([255, 0, 0, 255]), { hue: 180 });
	const minus = I.psAdjustPixels(new Uint8ClampedArray([255, 0, 0, 255]), { hue: -180 });
	sameBytes("psAdjustPixels 纯红色相 +180° 变成青色 (0,255,255)", plus, [0, 255, 255, 255], "色相环转半圈，红→青");
	sameBytes("psAdjustPixels 色相 -180° 与 +180° 等价（转半圈方向无所谓）", minus, Array.from(plus), "两者都落到同一个互补色");
}
sameBytes(
	"psAdjustPixels 对比度 0 时中间调不动（128 是阈值中心）",
	I.psAdjustPixels(new Uint8ClampedArray([128, 128, 128, 255]), { contrast: 100 }),
	[128, 128, 128, 255],
	"factor×(128-128)+128 = 128，对比度公式的中点不变"
);
sameBytes(
	"psAdjustPixels 对比度 +100 把暗部 64 压到 0",
	I.psAdjustPixels(new Uint8ClampedArray([64, 64, 64, 255]), { contrast: 100 }),
	[0, 0, 0, 255],
	"factor≈2.27，(64-128)×2.27+128≈-17，夹到 0"
);
sameBytes(
	"psAdjustPixels 对比度 -100 把纯黑抬到 72",
	I.psAdjustPixels(new Uint8ClampedArray([0, 0, 0, 255]), { contrast: -100 }),
	[128, 128, 128, 255],
	"factor≈0.4385，(0-128)×0.4385+128≈71.9 → 72，不会变成注释里说的「全灰」但也不会是 0"
);
{
	const a = I.psAdjustPixels(new Uint8ClampedArray([0, 200, 128, 255]), { contrast: 100 });
	const b = I.psAdjustPixels(new Uint8ClampedArray([0, 200, 128, 255]), { contrast: 5000 });
	sameBytes("psAdjustPixels contrast 5000 被夹到 100，结果与 +100 一致", b, Array.from(a), "对比度同样有 [-100,100] 上限");
}
sameBytes(
	"psAdjustPixels 饱和度 -100 把纯红去成灰色 54",
	I.psAdjustPixels(new Uint8ClampedArray([255, 0, 0, 255]), { saturation: -100 }),
	[54, 54, 54, 255],
	"satFactor=0 后三通道都等于灰度 0.2126×255≈54.2 → 54"
);
{
	const out = I.psAdjustPixels(new Uint8ClampedArray([100, 110, 120, 255]), { saturation: 100 });
	// satFactor=2：out = gray + (v-gray)×2 = 2v - gray，因此 out[b]-out[r] = 2×(120-100) = 40
	check(
		"psAdjustPixels 饱和度 +100 把 100/110/120 的色差从 20 拉大到 40",
		out[2] - out[0] === 40 && out[0] < 100 && out[1] > 110 && out[2] > 120,
		`实际 r=${out[0]} g=${out[1]} b=${out[2]}（期望 r<100、g>110、b>120、b-r=40）`
	);
}
{
	const out = I.psAdjustPixels(new Uint8ClampedArray([10, 20, 30, 99]), {
		brightness: 20,
		contrast: 30,
		saturation: 40,
		hue: 30,
		invert: true
	});
	check("psAdjustPixels 组合参数下 alpha 仍然原样保留（alpha 永远不进颜色循环）", out[3] === 99, `alpha=${out[3]}`);
}

/* ---- 2. psCurveLut -------------------------------------------------- */

function allIdentity(lut) {
	return lut.length === 256 && Array.from(lut).every((value, index) => value === index);
}
check("psCurveLut 空数组回落恒等表（少于两点宁可不改）", allIdentity(I.psCurveLut([])));
check("psCurveLut 单点回落恒等表（一个点画不出插值）", allIdentity(I.psCurveLut([[128, 200]])));
check("psCurveLut null 回落恒等表（缺参不炸）", allIdentity(I.psCurveLut(null)));
check("psCurveLut 两端点 (0,0)/(255,255) 就是恒等表", allIdentity(I.psCurveLut([[0, 0], [255, 255]])));
{
	const lut = I.psCurveLut(I.psCurvePreset("invert"));
	check(
		"psCurveLut 反相曲线 0→255、64→191、128→127、255→0",
		lut[0] === 255 && lut[64] === 191 && lut[128] === 127 && lut[255] === 0,
		`实际 0→${lut[0]} 64→${lut[64]} 128→${lut[128]} 255→${lut[255]}`
	);
}
{
	const lut = I.psCurveLut(I.psCurvePreset("brighten"));
	check(
		"psCurveLut 提亮曲线 0→24、128→140、255→255",
		lut[0] === 24 && lut[128] === 140 && lut[255] === 255,
		`实际 0→${lut[0]} 128→${lut[128]} 255→${lut[255]}（24+231×128/255≈139.95）`
	);
}
{
	// 控制点在 [32,200] 之外：左边取第一个点的 y，右边取最后一个点的 y（端点保持）
	const lut = I.psCurveLut([[32, 10], [200, 250]]);
	check(
		"psCurveLut 曲线两端保持端点值：0..32→10，200..255→250",
		lut[0] === 10 && lut[32] === 10 && lut[200] === 250 && lut[255] === 250,
		`实际 0→${lut[0]} 32→${lut[32]} 200→${lut[200]} 255→${lut[255]}`
	);
}
check(
	"psCurveLut 越界/乱序控制点先夹到 0..255 再排序（[-5,-5]/[300,300] → 恒等）",
	allIdentity(I.psCurveLut([[300, 300], [-5, -5]]))
);
{
	const lut = I.psCurveLut([[0, 0], [2, 255]]);
	check(
		"psCurveLut 插值四舍五入：0..2 之间 (1) 取 127.5 的一半 → 128",
		lut[0] === 0 && lut[1] === 128 && lut[2] === 255 && lut[3] === 255,
		`实际 0→${lut[0]} 1→${lut[1]} 2→${lut[2]} 3→${lut[3]}`
	);
}
check(
	"psCurveLut 丢弃非数字控制点后只剩一个点 → 恒等（NaN 不参与插值）",
	allIdentity(I.psCurveLut([[0, 0], [NaN, 50], [255, 255]]))
);

/* ---- 3. psCurvePreset ----------------------------------------------- */

samePoints("psCurvePreset invert 预设就是 (0,255)/(255,0)", I.psCurvePreset("invert"), [[0, 255], [255, 0]], "黑白互换");
samePoints("psCurvePreset brighten 预设把黑场抬到 24", I.psCurvePreset("brighten"), [[0, 24], [255, 255]], "只提亮暗部");
samePoints("psCurvePreset 未知 id 回落恒等曲线", I.psCurvePreset("no-such-preset"), [[0, 0], [255, 255]], "兜底不改变画面");
{
	const ids = ["brighten", "darken", "contrast", "invert", "unknown"];
	const bad = ids.filter((id) => JSON.stringify(I.psCurveNormalize(I.psCurvePreset(id))) !== JSON.stringify(I.psCurvePreset(id)));
	check("psCurvePreset 每个预设都是规范形态（x 升序、首尾钉在 0/255）", bad.length === 0, bad.length ? `不规范：${bad.join(",")}` : "");
}

/* ---- 4. psCurveNormalize -------------------------------------------- */

samePoints("psCurveNormalize 空数组补成恒等两端点", I.psCurveNormalize([]), [[0, 0], [255, 255]]);
samePoints(
	"psCurveNormalize 单点补首尾：[[128,200]] → [0,200]/[128,200]/[255,200]",
	I.psCurveNormalize([[128, 200]]),
	[[0, 200], [128, 200], [255, 200]],
	"首尾继承最近点的 y"
);
samePoints("psCurveNormalize 按 x 升序排好乱序输入", I.psCurveNormalize([[255, 10], [0, 20]]), [[0, 20], [255, 10]], "排序后才做插值");
samePoints(
	"psCurveNormalize 先夹到 0..255 再四舍五入",
	I.psCurveNormalize([[-5, 999], [300, -4]]),
	[[0, 255], [255, 0]],
	"越界值不是丢弃而是夹紧"
);
samePoints(
	"psCurveNormalize 重复 x 只留先出现的一个（稳定排序），再补首尾",
	I.psCurveNormalize([[80, 10], [80, 90]]),
	[[0, 10], [80, 10], [255, 10]],
	"曲线要求 x 严格递增，重复 x 会导致除零；[80,10] 保留，首尾按它补"
);
samePoints("psCurveNormalize 小数控制点四舍五入", I.psCurveNormalize([[10.4, 20.6]]), [[0, 21], [10, 21], [255, 21]], "像素坐标必须是整数");
check("psCurveNormalize 非数组输入回落恒等", JSON.stringify(I.psCurveNormalize("nope")) === JSON.stringify([[0, 0], [255, 255]]));
samePoints("psCurveNormalize 容忍 null 控制点（?? 0 兜底后成为端点）", I.psCurveNormalize([null, [255, 255]]), [[0, 0], [255, 255]]);

/* ---- 5. psCurveHit -------------------------------------------------- */

{
	const points = [[0, 0], [128, 128], [255, 255]];
	check("psCurveHit 命中 128 附近 (130,130) → 下标 1", I.psCurveHit(points, 130, 130) === 1, "距离 √8≈2.83 < 14");
	check("psCurveHit 远离所有点 → -1（(200,20) 最近也有 100+ 距离）", I.psCurveHit(points, 200, 20) === -1);
	check("psCurveHit radius 0 只接受完全重合的点", I.psCurveHit(points, 0, 0, 0) === 0 && I.psCurveHit(points, 1, 1, 0) === -1);
	check(
		"psCurveHit 默认半径 14 是闭区间：距离 14 命中、15 落空",
		I.psCurveHit(points, 0, 14) === 0 && I.psCurveHit(points, 0, 15) === -1,
		"距离用 <= radius"
	);
	check("psCurveHit 多点时取最近的那个（(8,0) 离 10 比离 0 近）", I.psCurveHit([[0, 0], [10, 0]], 8, 0) === 1);
}
check("psCurveHit 空控制点列表 → -1（没有可拖的点）", I.psCurveHit([], 0, 0) === -1);

/* ---- 6. psCurveMove / psCurveAdd / psCurveRemoveAt ------------------- */

const CURVE3 = [[0, 0], [128, 128], [255, 255]];
samePoints(
	"psCurveMove 中间点 x 上限是右邻居 −1：250 合法保留，260 夹到 254",
	I.psCurveMove(CURVE3, 1, 250, 200),
	[[0, 0], [250, 200], [255, 255]],
	"x 必须严格小于下一个点，否则控制点会重叠"
);
samePoints(
	"psCurveMove 中间点 x 超出右邻居时被夹到 254（255-1）",
	I.psCurveMove(CURVE3, 1, 260, 200),
	[[0, 0], [254, 200], [255, 255]],
	"high = 下一个点 x − 1"
);
samePoints(
	"psCurveMove 中间点 x 被夹在左邻居右边（5 → 5，下限 1）",
	I.psCurveMove(CURVE3, 1, 5, 200),
	[[0, 0], [5, 200], [255, 255]],
	"x 必须严格大于前一个点"
);
samePoints("psCurveMove 中间点 y 越界被夹到 0", I.psCurveMove(CURVE3, 1, 128, -10), [[0, 0], [128, 0], [255, 255]], "y 范围 0..255");
samePoints("psCurveMove 首点只能上下动，x 钉在 0", I.psCurveMove(CURVE3, 0, 50, 20), [[0, 20], [128, 128], [255, 255]], "端点 x 不允许移动");
samePoints("psCurveMove 末点只能上下动，x 钉在 255", I.psCurveMove(CURVE3, 2, 50, 20), [[0, 0], [128, 128], [255, 20]], "端点 x 不允许移动");
samePoints("psCurveMove 非法下标原样返回规范化列表", I.psCurveMove(CURVE3, 99, 10, 10), CURVE3, "越界不修改");
{
	const moved = I.psCurveMove(CURVE3, 1, 200, 50);
	const xs = moved.map((point) => point[0]);
	check("psCurveMove 移动后 x 仍然严格递增", xs.every((x, index) => index === 0 || x > xs[index - 1]), `x=${xs.join(",")}`);
}
samePoints(
	"psCurveAdd 在 128 插入控制点，顺序保持",
	I.psCurveAdd(CURVE3.slice(0, 1).concat(CURVE3.slice(2)), 128, 200),
	[[0, 0], [128, 200], [255, 255]],
	"插到两个端点之间"
);
{
	const base = [[0, 0], [255, 255]];
	const nearStart = I.psCurveAdd(base, 2, 50);
	const nearEnd = I.psCurveAdd(base, 253, 50);
	const atZero = I.psCurveAdd(base, 0, 50);
	check(
		"psCurveAdd 离已有点 4 像素内拒绝添加（2 距 0 为 2、253 距 255 为 2）",
		nearStart.length === 2 && nearEnd.length === 2,
		`近起点 ${nearStart.length} 点、近终点 ${nearEnd.length} 点`
	);
	check(
		"psCurveAdd x=0 被夹到 1，仍因离首点太近而拒绝（端点不许被顶掉）",
		atZero.length === 2 && atZero[0][0] === 0,
		`实际 ${JSON.stringify(atZero)}`
	);
}
samePoints("psCurveAdd y 越界夹到 255", I.psCurveAdd([[0, 0], [255, 255]], 128, 300), [[0, 0], [128, 255], [255, 255]], "控制点 y 范围 0..255");
samePoints(
	"psCurveRemoveAt 删中间点后回到两端点",
	I.psCurveRemoveAt(CURVE3, 1),
	[[0, 0], [255, 255]],
	"至少保留两个点"
);
samePoints("psCurveRemoveAt 不许删首点", I.psCurveRemoveAt(CURVE3, 0), CURVE3, "index<=0 原样返回");
samePoints("psCurveRemoveAt 不许删末点", I.psCurveRemoveAt(CURVE3, 2), CURVE3, "末点 index 原样返回");
samePoints(
	"psCurveRemoveAt 只剩两个点时任何删除都无效（不能删成一条线都没有）",
	I.psCurveRemoveAt([[0, 0], [255, 255]], 0),
	[[0, 0], [255, 255]],
	"length<=2 直接返回"
);

/* ---- 7. psLevelsLut ------------------------------------------------- */

{
	const lut = I.psLevelsLut();
	check("psLevelsLut 默认参数（0/255, gamma 1, 0/255）就是恒等表", allIdentity(lut));
}
{
	// gamma 0 在实现里走 `Number(gamma) || 1` 的兜底分支，所以等价于 gamma 1，而不是钳到 0.01。
	const zero = I.psLevelsLut({ gamma: 0 });
	const one = I.psLevelsLut({ gamma: 1 });
	sameBytes(
		"psLevelsLut gamma 0 被兜底成 gamma 1（`0 || 1`），输出与恒等表一致",
		zero,
		Array.from(one),
		"0 是假值，|| 先把 gamma 换成 1；这是一条需要注意的实现细节"
	);
}
{
	const lut = I.psLevelsLut({ gamma: 9.99 });
	check(
		"psLevelsLut gamma 9.99 把 128 抬到 238，端点保持不变",
		lut[0] === 0 && lut[128] === 238 && lut[255] === 255,
		`实际 0→${lut[0]} 128→${lut[128]} 255→${lut[255]}（0.502^0.1×255≈238）`
	);
}
{
	const negative = I.psLevelsLut({ gamma: -5 });
	const smallest = I.psLevelsLut({ gamma: 0.01 });
	sameBytes(
		"psLevelsLut gamma -5 被钳到下限 0.01（负数按最小值处理）",
		negative,
		Array.from(smallest),
		"Math.max(0.01, ...) 把负 gamma 拉到 0.01"
	);
	check(
		"psLevelsLut gamma 0.01 把中间调压到 0（0.502^100 几乎为 0）",
		smallest[128] === 0 && smallest[255] === 255,
		`128→${smallest[128]} 255→${smallest[255]}`
	);
}
{
	const lut = I.psLevelsLut({ inBlack: 64, inWhite: 192 });
	check(
		"psLevelsLut 黑白场 [64,192]：64→0、128→128、192→255",
		lut[64] === 0 && lut[128] === 128 && lut[192] === 255 && lut[63] === 0,
		`实际 63→${lut[63]} 64→${lut[64]} 128→${lut[128]} 192→${lut[192]}`
	);
}
{
	const lut = I.psLevelsLut({ inBlack: 255, inWhite: 0 });
	check(
		"psLevelsLut 黑场 > 白场时自动纠正为 black=254/white=255，不出现反向色阶",
		lut[254] === 0 && lut[255] === 255,
		`实际 254→${lut[254]} 255→${lut[255]}`
	);
}
{
	const lut = I.psLevelsLut({ outBlack: 200, outWhite: 100 });
	check(
		"psLevelsLut 输出白场 < 黑场时压成平场 200（high=max(low, high)）",
		lut[0] === 200 && lut[128] === 200 && lut[255] === 200,
		`实际 0→${lut[0]} 128→${lut[128]} 255→${lut[255]}`
	);
}
{
	const lut = I.psLevelsLut({ outBlack: 100, outWhite: 200 });
	check(
		"psLevelsLut 输出范围 [100,200]：0→100、128→150、255→200",
		lut[0] === 100 && lut[128] === 150 && lut[255] === 200,
		`实际 0→${lut[0]} 128→${lut[128]} 255→${lut[255]}`
	);
}
{
	const lut = I.psLevelsLut({ gamma: 2.2 });
	const monotonic = Array.from(lut).every((value, index) => index === 0 || value >= lut[index - 1]);
	check("psLevelsLut gamma 2.2 输出单调不降且仍是 256 项（LUT 不能有空洞）", monotonic && lut.length === 256);
}

/* ---- 8. psApplyLutPixels -------------------------------------------- */

{
	const identity = Uint8ClampedArray.from({ length: 256 }, (_, index) => index);
	const invert = Uint8ClampedArray.from({ length: 256 }, (_, index) => 255 - index);
	const constant = new Uint8ClampedArray(256).fill(7);
	const data = new Uint8ClampedArray([10, 20, 30, 255]);
	const returned = I.psApplyLutPixels(data, identity, invert, constant);
	check("psApplyLutPixels 返回同一个数组（就地改像素）", returned === data);
	sameBytes(
		"psApplyLutPixels 三通道各用各的 LUT：R 恒等、G 反相、B 常量 7",
		data,
		[10, 235, 7, 255],
		"曲线面板就是三通道独立 LUT，这是它成立的前提"
	);
}
{
	const data = new Uint8ClampedArray([5, 6, 7, 8, 9, 10, 11, 12]);
	I.psApplyLutPixels(data, Array.from({ length: 256 }, (_, index) => index));
	sameBytes("psApplyLutPixels 恒等 LUT 不改任何像素", data, [5, 6, 7, 8, 9, 10, 11, 12]);
}
{
	const empty = new Uint8ClampedArray(0);
	check("psApplyLutPixels 空数组不炸、保持长度 0", I.psApplyLutPixels(empty, new Uint8ClampedArray(256)) === empty && empty.length === 0);
}
check("psApplyLutPixels null 原样返回", I.psApplyLutPixels(null, new Uint8ClampedArray(256)) === null);
{
	const data = new Uint8ClampedArray([10, 20, 30, 40]);
	const lut = I.psLevelsLut({ inBlack: 0, inWhite: 255, outBlack: 100, outWhite: 200 });
	I.psApplyLutPixels(data, lut);
	check(
		"psApplyLutPixels 只改 RGB，alpha=40 原样保留",
		data[3] === 40 && data[0] === 104 && data[1] === 108,
		`实际 ${Array.from(data)}（10→100+10/255×100≈104，20→108，alpha 不动）`
	);
}

/* ---- 9. psVibrancePixels -------------------------------------------- */

{
	const data = new Uint8ClampedArray([140, 128, 128, 255]);
	const returned = I.psVibrancePixels(data, 0);
	check("psVibrancePixels amount 0 直接返回原数组（不做无意义运算）", returned === data);
	sameBytes("psVibrancePixels amount 0 不改任何像素", data, [140, 128, 128, 255]);
}
sameBytes(
	"psVibrancePixels 灰色 (128,128,128) 在任何强度下都不动",
	I.psVibrancePixels(new Uint8ClampedArray([128, 128, 128, 255]), 100),
	[128, 128, 128, 255],
	"灰色已经没饱和度，boost 乘在 0 差上，结果还是灰"
);
sameBytes(
	"psVibrancePixels 纯红 +100 几乎不动（saturation=1 → boost=0）",
	I.psVibrancePixels(new Uint8ClampedArray([255, 0, 0, 255]), 100),
	[255, 0, 0, 255],
	"max-min/max=1，(1-saturation)=0，这正是 vibrance 与普通饱和度的区别"
);
sameBytes("psVibrancePixels 纯白不动", I.psVibrancePixels(new Uint8ClampedArray([255, 255, 255, 255]), 100), [255, 255, 255, 255], "白点 saturation=0 且差值全 0");
sameBytes("psVibrancePixels 纯黑不动", I.psVibrancePixels(new Uint8ClampedArray([0, 0, 0, 255]), 100), [0, 0, 0, 255], "max=0 时 saturation 记 0，差值为 0");
{
	const out = I.psVibrancePixels(new Uint8ClampedArray([140, 128, 128, 200]), 100);
	// (140,128,128) 的 saturation=12/140≈0.086 → boost≈0.914，色差 12 → 23
	check(
		"psVibrancePixels 低饱和像素 +100 被拉开：r-g 从 12 变成 23",
		out[0] === 149 && out[1] === 126 && out[2] === 126 && out[0] - out[1] === 23,
		`实际 ${Array.from(out)}（期望 [149,126,126,200]）`
	);
	check("psVibrancePixels 处理颜色但 alpha=200 保持不动", out[3] === 200, `alpha=${out[3]}`);
}
{
	const out = I.psVibrancePixels(new Uint8ClampedArray([140, 128, 128, 255]), -100);
	check(
		"psVibrancePixels -100 把低饱和色差从 12 压到 1",
		out[0] === 131 && out[1] === 130 && out[2] === 130 && out[0] - out[1] === 1,
		`实际 ${Array.from(out)}（期望 [131,130,130,255]）`
	);
}
{
	const a = I.psVibrancePixels(new Uint8ClampedArray([140, 128, 128, 255]), 150);
	const b = I.psVibrancePixels(new Uint8ClampedArray([140, 128, 128, 255]), 100);
	sameBytes("psVibrancePixels amount 150 被钳到 100（强度上限），结果与 +100 一致", a, Array.from(b), "Math.min(100, ...)");
}
sameBytes(
	"psVibrancePixels 1×1 单像素灰色图不动（边界尺寸不产生越界读写）",
	I.psVibrancePixels(new Uint8ClampedArray([128, 128, 128, 255]), 100),
	[128, 128, 128, 255]
);
{
	const empty = new Uint8ClampedArray(0);
	check("psVibrancePixels 空数组保持长度 0", I.psVibrancePixels(empty, 50) === empty && empty.length === 0);
}

/* ---- 10. psBoxBlurPixels -------------------------------------------- */

{
	const data = new Uint8ClampedArray([0, 0, 0, 255, 100, 100, 100, 255, 200, 200, 200, 255]);
	const returned = I.psBoxBlurPixels(data, 3, 1, 0);
	check("psBoxBlurPixels radius 0 直接返回原数组（模糊关闭时不复制不取整）", returned === data);
	sameBytes("psBoxBlurPixels radius 0 像素完全不变", data, [0, 0, 0, 255, 100, 100, 100, 255, 200, 200, 200, 255]);
}
sameBytes(
	"psBoxBlurPixels 负 radius 被夹到 0（等同关闭模糊）",
	I.psBoxBlurPixels(new Uint8ClampedArray([0, 0, 0, 255, 100, 100, 100, 255]), 2, 1, -5),
	[0, 0, 0, 255, 100, 100, 100, 255],
	"Math.max(0, Math.min(64, radius))"
);
sameBytes(
	"psBoxBlurPixels 1×1 单像素图 + radius 64 不变（所有采样只能取到它自己）",
	I.psBoxBlurPixels(new Uint8ClampedArray([10, 20, 30, 40]), 1, 1, 64),
	[10, 20, 30, 40],
	"边界 clamp 让 1×1 的卷积窗口只含一个像素"
);
{
	const data = new Uint8ClampedArray([0, 0, 0, 255, 0, 0, 0, 255, 255, 0, 0, 255]);
	I.psBoxBlurPixels(data, 3, 1, 1);
	sameBytes(
		"psBoxBlurPixels 3×1 梯度 [0,0,255] → [0,85,170]（可分离盒式平均）",
		data,
		[0, 0, 0, 255, 85, 0, 0, 255, 170, 0, 0, 255],
		"x=1 取 0/0/255 平均 85，x=2 取 0/255/255 平均 170；h=1 纵向不改变"
	);
}
{
	const data = new Uint8ClampedArray(4 * 4 * 4);
	for (let index = 0; index < 16; index += 1) {
		data[index * 4] = 100;
		data[index * 4 + 1] = 150;
		data[index * 4 + 2] = 200;
		data[index * 4 + 3] = 255;
	}
	const before = Array.from(data);
	I.psBoxBlurPixels(data, 4, 4, 2);
	sameBytes("psBoxBlurPixels 纯色图模糊后不变（均匀区域卷积仍是原值）", data, before, "4×4 全 100/150/200");
}
{
	const base = new Uint8ClampedArray(5 * 1 * 4);
	const values = [0, 50, 100, 150, 200];
	values.forEach((value, index) => {
		base[index * 4] = value;
		base[index * 4 + 3] = 255;
	});
	const at64 = new Uint8ClampedArray(base);
	const at100 = new Uint8ClampedArray(base);
	I.psBoxBlurPixels(at64, 5, 1, 64);
	I.psBoxBlurPixels(at100, 5, 1, 100);
	sameBytes("psBoxBlurPixels radius 100 被夹到 64（上限），结果与 radius 64 一致", at100, Array.from(at64), "Math.min(64, ...)");
}
{
	const data = new Uint8ClampedArray([10, 20, 30, 255, 40, 50, 60, 255, 70, 80, 90, 255, 100, 110, 120, 255]);
	I.psBoxBlurPixels(data, 2, 2, 64);
	const first = [data[0], data[1], data[2], data[3]];
	const uniform = [0, 4, 8, 12].every((offset) => first.every((value, channel) => data[offset + channel] === value));
	check("psBoxBlurPixels 2×2 + radius 64 输出四像素同值（大半径在小图上退化成全图均值）", uniform, `实际 ${Array.from(data)}`);
}
{
	// alpha 通道也参与盒式模糊：2×1 图 alpha [0,255] → [85,170]
	const data = new Uint8ClampedArray([0, 0, 0, 0, 0, 0, 0, 255]);
	I.psBoxBlurPixels(data, 2, 1, 1);
	check(
		"psBoxBlurPixels 连 alpha 一起模糊：2×1 的 [0,255] → [85,170]",
		data[3] === 85 && data[7] === 170,
		`实际 alpha=[${data[3]},${data[7]}]`
	);
}
{
	const empty = new Uint8ClampedArray(0);
	check("psBoxBlurPixels 空数组不炸、长度保持 0", I.psBoxBlurPixels(empty, 1, 1, 2) === empty && empty.length === 0);
}

/* ---- 11. psSharpenPixels -------------------------------------------- */

{
	const data = new Uint8ClampedArray([0, 0, 0, 255, 100, 100, 100, 255]);
	const returned = I.psSharpenPixels(data, 2, 1, 0);
	check("psSharpenPixels amount 0 直接返回原数组（不白算一遍模糊）", returned === data);
	sameBytes("psSharpenPixels amount 0 像素不变", data, [0, 0, 0, 255, 100, 100, 100, 255]);
}
sameBytes(
	"psSharpenPixels 负 amount 被夹到 0（等同关闭锐化）",
	I.psSharpenPixels(new Uint8ClampedArray([0, 0, 0, 255, 100, 100, 100, 255]), 2, 1, -30),
	[0, 0, 0, 255, 100, 100, 100, 255],
	"Math.max(0, ...) 不允许反向锐化"
);
{
	const data = new Uint8ClampedArray(16);
	for (let pixel = 0; pixel < 4; pixel += 1) {
		data[pixel * 4] = 100;
		data[pixel * 4 + 1] = 100;
		data[pixel * 4 + 2] = 100;
		data[pixel * 4 + 3] = 255;
	}
	const before = Array.from(data);
	I.psSharpenPixels(data, 4, 1, 100);
	sameBytes("psSharpenPixels 纯色图不变（原图 - 模糊图 = 0，USM 没有可锐化的边）", data, before, "均匀区域 USM 增量为 0");
}
{
	// 原图 4×1: [0,100,0,0]；blur radius 1 后 [33,33,33,0]；USM 100%：100+(100-33)=167
	const data = new Uint8ClampedArray([0, 0, 0, 255, 100, 100, 100, 255, 0, 0, 0, 255, 0, 0, 0, 255]);
	const returned = I.psSharpenPixels(data, 4, 1, 100);
	check("psSharpenPixels 返回同一个数组（就地锐化）", returned === data);
	check(
		"psSharpenPixels 100% 把亮边的中间像素 100 提到 167",
		data[4] === 167 && data[5] === 167 && data[6] === 167,
		`实际中心像素 [${data[4]},${data[5]},${data[6]}]，期望 [167,167,167]（100+(100-33)）`
	);
	check("psSharpenPixels 只动 RGB，alpha=255 原样保留", data[3] === 255 && data[7] === 255);
}
{
	const data = new Uint8ClampedArray([0, 0, 0, 255, 100, 100, 100, 255, 0, 0, 0, 255, 0, 0, 0, 255]);
	const a = new Uint8ClampedArray(data);
	const b = new Uint8ClampedArray(data);
	I.psSharpenPixels(a, 4, 1, 200);
	I.psSharpenPixels(b, 4, 1, 300);
	sameBytes("psSharpenPixels amount 300 被夹到 200（强度上限），结果与 200 一致", b, Array.from(a), "Math.min(200, ...)");
}
sameBytes(
	"psSharpenPixels 1×1 单像素图不变（半径 1 的模糊只取到自己）",
	I.psSharpenPixels(new Uint8ClampedArray([100, 120, 140, 255]), 1, 1, 100),
	[100, 120, 140, 255]
);

/* ---- 12. psNoisePixels ---------------------------------------------- */

{
	const data = new Uint8ClampedArray([100, 120, 140, 255]);
	const returned = I.psNoisePixels(data, 0, 7);
	check("psNoisePixels amount 0 直接返回原数组（无噪点模式不消耗随机数）", returned === data);
	sameBytes("psNoisePixels amount 0 像素不变", data, [100, 120, 140, 255]);
}
{
	const source = new Uint8ClampedArray(64);
	for (let index = 0; index < 16; index += 1) {
		source[index * 4] = 128;
		source[index * 4 + 1] = 128;
		source[index * 4 + 2] = 128;
		source[index * 4 + 3] = 255;
	}
	const a = I.psNoisePixels(new Uint8ClampedArray(source), 40, 7);
	const b = I.psNoisePixels(new Uint8ClampedArray(source), 40, 7);
	sameBytes("psNoisePixels 同种子 7 两次结果完全一致（固定种子才有可复现性）", a, Array.from(b), "LCG 状态由 seed 唯一决定");
	const c = I.psNoisePixels(new Uint8ClampedArray(source), 40, 8);
	check("psNoisePixels 换种子 8 得到不同噪点", Array.from(a).some((value, index) => value !== c[index]), "不同 seed 产生不同序列");
	check("psNoisePixels alpha=255 保持不动（噪点只落在颜色通道）", a[3] === 255 && a[63] === 255);
}
{
	const source = new Uint8ClampedArray([100, 120, 140, 255, 100, 120, 140, 255]);
	const a = I.psNoisePixels(new Uint8ClampedArray(source), 100, 3);
	const b = I.psNoisePixels(new Uint8ClampedArray(source), 150, 3);
	sameBytes("psNoisePixels amount 150 被夹到 100（噪点强度上限）", b, Array.from(a), "Math.min(100, ...)");
}
{
	const source = new Uint8ClampedArray([100, 120, 140, 255]);
	const a = I.psNoisePixels(new Uint8ClampedArray(source), 50, 0);
	const b = I.psNoisePixels(new Uint8ClampedArray(source), 50, 1);
	sameBytes("psNoisePixels seed 0 兜底成 seed 1（`|| 1` 防止 LCG 状态为 0）", a, Array.from(b), "state=0 会让 LCG 永远输出 0");
}
{
	const data = new Uint8ClampedArray([100, 120, 140, 255]);
	const a = I.psNoisePixels(new Uint8ClampedArray(data), 50, 7);
	const b = I.psNoisePixels(new Uint8ClampedArray(data), 50, 7);
	check("psNoisePixels 1×1 单像素图同种子可复现（边界尺寸也吃同一套序列）", a[0] === b[0] && a[1] === b[1] && a[2] === b[2] && a[3] === 255);
}
{
	const data = new Uint8ClampedArray([100, 120, 140, 255]);
	const returned = I.psNoisePixels(data, "abc", 7);
	check("psNoisePixels 非数字 amount 回落 0（不产生 NaN 花屏）", returned === data && data[0] === 100, `实际 ${Array.from(data)}`);
}

/* ---- 13. psMaskAlpha ------------------------------------------------- */

{
	const alpha = I.psMaskAlpha(4, 3, null);
	check("psMaskAlpha 没有选区 → 整张全 255（全可见）", alpha.length === 12 && Array.from(alpha).every((value) => value === 255));
}
{
	const alpha = I.psMaskAlpha(4, 3, { x: 1, y: 1, w: 2, h: 1 });
	const expected = new Array(12).fill(0);
	expected[5] = 255; // (x=1,y=1)
	expected[6] = 255; // (x=2,y=1)
	sameBytes("psMaskAlpha 选区内 255、选区外 0（4×3 + 选区 1,1,2,1）", alpha, expected, "蒙版覆盖率就是选区几何");
}
{
	const alpha = I.psMaskAlpha(4, 3, { x: 10, y: 10, w: 5, h: 5 });
	check("psMaskAlpha 选区整体越界 → 全 0（夹到边界后无交集）", Array.from(alpha).every((value) => value === 0));
}
{
	const alpha = I.psMaskAlpha(2, 2, { x: -10, y: -10, w: 100, h: 100 });
	check("psMaskAlpha 选区盖满且带负坐标 → 全 255（负坐标夹到 0，超出夹到宽高）", Array.from(alpha).every((value) => value === 255));
}
sameBytes(
	"psMaskAlpha 1×1 单像素图 + 1×1 选区 → [255]",
	I.psMaskAlpha(1, 1, { x: 0, y: 0, w: 1, h: 1 }),
	[255],
	"最小尺寸取整后仍是 1×1"
);
{
	const alpha = I.psMaskAlpha(0, -3, null);
	check("psMaskAlpha 宽高 0/负数被夹到 1（长度 1，不产生空图）", alpha.length === 1 && alpha[0] === 255);
}
sameBytes(
	"psMaskAlpha 小数选区按 floor 起点 / ceil 终点取整：w=1.2 → 覆盖两列",
	I.psMaskAlpha(3, 1, { x: 0, y: 0, w: 1.2, h: 1 }),
	[255, 255, 0],
	"x1=ceil(0+1.2)=2，所以 x=0,1 命中"
);
{
	const alpha = I.psMaskAlpha(2, 2, { x: 0, y: 0, w: 0, h: 0 });
	check("psMaskAlpha 零面积选区 → 全 0（没有选中任何像素）", Array.from(alpha).every((value) => value === 0));
}

/* ---- 14. psInvertAlpha ---------------------------------------------- */

{
	const input = new Uint8ClampedArray([0, 255, 128]);
	const out = I.psInvertAlpha(input);
	sameBytes("psInvertAlpha 0/255/128 → 255/0/127（255-a）", out, [255, 0, 127], "白黑互换");
	sameBytes("psInvertAlpha 不修改输入数组（返回新数组）", input, [0, 255, 128], "蒙版反相是可撤销操作");
}
sameBytes("psInvertAlpha 全 0 → 全 255", I.psInvertAlpha(new Uint8ClampedArray([0, 0, 0, 0])), [255, 255, 255, 255], "空蒙版反相成全显");
{
	const original = new Uint8ClampedArray([0, 17, 128, 240, 255]);
	const twice = I.psInvertAlpha(I.psInvertAlpha(original));
	sameBytes("psInvertAlpha 反相两次回到原值（对合运算）", twice, Array.from(original), "255-(255-a)=a");
}
{
	const empty = I.psInvertAlpha(new Uint8ClampedArray(0));
	check("psInvertAlpha 空蒙版 → 长度 0", empty.length === 0);
}
{
	const nullCase = I.psInvertAlpha(null);
	check("psInvertAlpha null → 返回长度 0 的数组（不抛异常）", nullCase.length === 0);
}

/* ---- 汇总 ----------------------------------------------------------- */

console.log(`\n${passed}/${total} 通过`);
if (passed !== total) process.exitCode = 1;
