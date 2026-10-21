// 图片处理工具箱的真机检查：把 client.js 挂进一个真浏览器（Chrome headless），
// 用真 canvas 把每个动作跑一遍，量像素、量尺寸，而不是只看函数存在。
//
//   node tools/ps-check.mjs
//
// 产物：docs/preview/ps-feather.png（羽化样张，肉眼可看），控制台上的 项/结果 列表。
//
// 每个区块各自 try/catch：某一项抛错不会把后面的检查一起带走，报错信息也会带出来。

import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const OUT = path.resolve(path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "docs", "preview"));
const CHROME = process.env.VIG_CHROME || "C:/Program Files/Google/Chrome/Application/chrome.exe";

const clientSource = readFileSync(new URL("../client.js", import.meta.url), "utf8");

const driver = `
window.onerror = (message, source, line) => { document.title = "ERR " + message + " @" + line; };
const results = [];
const check = (name, pass, detail) => results.push({ name, pass: !!pass, detail: detail === undefined ? "" : String(detail) });
const near = (a, b, tol) => Math.abs(a - b) <= tol;
const px = (canvas, x, y) => Array.from(canvas.getContext("2d").getImageData(x, y, 1, 1).data);
const rgb = (data) => "rgb(" + data.slice(0, 3).join(",") + ") a=" + data[3];
const sec = (name, fn) => {
	try {
		fn();
	} catch (error) {
		check(name + "：区块抛错", false, String((error && error.stack) || error).split("\\n").slice(0, 2).join(" | "));
	}
};

const record = window.__vigRecord;
const stub = new Proxy({ createElement: () => null, Fragment: null }, { get: (t, k) => (k in t ? t[k] : () => null) });
let ui = null;
try {
	ui = record ? record.factory((request) => (request === "react" ? stub : {})).__internals : null;
} catch (error) {
	check("执行 bundle factory", false, String((error && error.message) || error));
}
check("拿到 __internals 把手", !!ui && !!ui.psRotate, ui ? "字段已导出" : "空");

function makeImage(width, height, paint) {
	const canvas = document.createElement("canvas");
	canvas.width = width; canvas.height = height;
	const ctx = canvas.getContext("2d");
	ctx.fillStyle = "#ffffff"; ctx.fillRect(0, 0, width, height);
	paint?.(ctx, width, height);
	return canvas;
}

if (ui) {
	// 120×80，左上角一个红点、右下角一个绿点：用来看坐标到底搬没搬对
	const src = makeImage(120, 80, (ctx) => {
		ctx.fillStyle = "#ff0000"; ctx.fillRect(0, 0, 1, 1);
		ctx.fillStyle = "#00ff00"; ctx.fillRect(119, 79, 1, 1);
	});
	const isRed = (data) => data[0] > 200 && data[1] < 60;
	const isGreen = (data) => data[1] > 200 && data[0] < 60;

	sec("旋转", () => {
		const rot90 = ui.psRotate(src, 90);
		check("旋转 90°：宽高互换", rot90.width === 80 && rot90.height === 120, rot90.width + "x" + rot90.height);
		check("旋转 90°：红点从 (0,0) 走到 (H-1,0)", isRed(px(rot90, 79, 0)), rgb(px(rot90, 79, 0)));
		const back = ui.psRotate(rot90, -90);
		check("转回来尺寸复原", back.width === 120 && back.height === 80, back.width + "x" + back.height);
		const rot45 = ui.psRotate(src, 45);
		check("旋转 45°：画布放大到能装下", rot45.width > 120 && rot45.height > 80, rot45.width + "x" + rot45.height);
	});

	sec("裁切", () => {
		const marked = makeImage(120, 80, (ctx) => {
			ctx.fillStyle = "#111111"; ctx.fillRect(0, 0, 120, 80);
			ctx.fillStyle = "#0000ff"; ctx.fillRect(10, 10, 3, 3);
		});
		const crop = ui.psCrop(marked, { x: 10, y: 10, w: 30, h: 20 });
		check("裁切：尺寸=选区", crop.width === 30 && crop.height === 20, crop.width + "x" + crop.height);
		check("裁切：选区原点变成新 (0,0)", px(crop, 0, 0)[2] > 200 && px(crop, 0, 0)[0] < 80, rgb(px(crop, 0, 0)));
		const clamped = ui.psCrop(marked, { x: 100, y: 70, w: 400, h: 400 });
		check("裁切：出不去的选区被夹回", clamped.width === 20 && clamped.height === 10, clamped.width + "x" + clamped.height);
		check("裁切：极窄选区退化成 1px 而不是崩", ui.psCrop(marked, { x: 5, y: 5, w: 0.2, h: 0.2 }) === marked, "原图返回");
	});

	sec("切割拆分", () => {
		const tiles = ui.psSplitTiles(120, 80, 3, 2);
		check("3×2 = 6 块", tiles.length === 6, String(tiles.length));
		check("每块 40×40", tiles.every((t) => t.w === 40 && t.h === 40), tiles.map((t) => t.w + "x" + t.h).join(" "));
		check("面积刚好铺满", tiles.reduce((sum, t) => sum + t.w * t.h, 0) === 120 * 80, "120×80");
		const last = tiles[tiles.length - 1];
		check("最后一块贴住右下角", last.x + last.w === 120 && last.y + last.h === 80, JSON.stringify(last));
		const odd = ui.psSplitTiles(100, 70, 3, 2);
		const oddLast = odd[odd.length - 1];
		check("除不尽也铺满（100÷3）", odd.reduce((sum, t) => sum + t.w * t.h, 0) === 100 * 70 && oddLast.x + oddLast.w === 100 && oddLast.y + oddLast.h === 70, JSON.stringify(oddLast));
		check("块数被夹在 1..8", ui.psSplitTiles(60, 60, 99, 0).length === 8, String(ui.psSplitTiles(60, 60, 99, 0).length));
		const piece = ui.psSlice(src, { x: 0, y: 0, w: 4, h: 4 });
		check("取块：尺寸对且内容搬过来", piece.width === 4 && piece.height === 4 && isRed(px(piece, 0, 0)), rgb(px(piece, 0, 0)));
	});

	sec("画布", () => {
		check("锚点表：nw / c / se 都对", (() => {
			const nw = ui.psAnchorOffset(120, 80, 200, 150, "nw");
			const c = ui.psAnchorOffset(120, 80, 200, 150, "c");
			const se = ui.psAnchorOffset(120, 80, 200, 150, "se");
			return nw.x === 0 && nw.y === 0 && c.x === 40 && c.y === 35 && se.x === 80 && se.y === 70;
		})(), JSON.stringify(ui.psAnchorOffset(120, 80, 200, 150, "c")));
		const bigger = ui.psCanvasSize(src, 200, 150, "c", "#ffffff");
		check("扩边：尺寸=输入", bigger.width === 200 && bigger.height === 150, bigger.width + "x" + bigger.height);
		check("扩边：原图落在 (40,35)", isRed(px(bigger, 40, 35)), rgb(px(bigger, 40, 35)));
		check("扩边：空白处是填充色", px(bigger, 0, 0)[0] > 250 && px(bigger, 0, 0)[3] === 255, rgb(px(bigger, 0, 0)));
		check("扩边：se 锚点贴右下", isGreen(px(ui.psCanvasSize(src, 200, 150, "se", "#ffffff"), 199, 149)), rgb(px(ui.psCanvasSize(src, 200, 150, "se", "#ffffff"), 199, 149)));
		check("扩边：不填色就是透明", px(ui.psCanvasSize(src, 200, 150, "c", ""), 0, 0)[3] === 0, rgb(px(ui.psCanvasSize(src, 200, 150, "c", ""), 0, 0)));
		check("缩画布：超出部分被裁掉", ui.psCanvasSize(src, 60, 40, "nw", "").width === 60);
	});

	sec("羽化", () => {
		const whole = ui.psFeather(src, null, 16);
		check("整张羽化：尺寸不变", whole.width === 120 && whole.height === 80, whole.width + "x" + whole.height);
		check("整张羽化：最外圈半透明（羽化边正中）", px(whole, 0, 0)[3] > 60 && px(whole, 0, 0)[3] < 190, rgb(px(whole, 0, 0)));
		check("整张羽化：往里 16px 基本回实心", px(whole, 16, 40)[3] > 240, rgb(px(whole, 16, 40)));
		check("整张羽化：中心仍然实心", px(whole, 60, 40)[3] > 250, rgb(px(whole, 60, 40)));
		const sel = ui.psFeather(src, { x: 20, y: 20, w: 60, h: 40 }, 8);
		check("选区羽化：选区外直接清空", px(sel, 5, 5)[3] === 0 && px(sel, 110, 70)[3] === 0, rgb(px(sel, 5, 5)));
		check("选区羽化：选区内中心实心", px(sel, 50, 40)[3] > 250, rgb(px(sel, 50, 40)));
		check("半径 0 = 不动像素", px(ui.psFeather(src, null, 0), 60, 40)[3] === 255);
	});

	sec("矫正", () => {
		// 画一张顺时针歪了 3° 的横条纹图
		const tilt = makeImage(160, 160, (ctx) => {
			ctx.save();
			ctx.translate(80, 80); ctx.rotate((3 * Math.PI) / 180); ctx.translate(-80, -80);
			ctx.fillStyle = "#111111";
			for (let y = 0; y < 160; y += 12) ctx.fillRect(-40, y, 240, 4);
			ctx.restore();
		});
		const gray = ui.psLumaFromCanvas(tilt);
		check("灰度采样：等比降采样", near(gray.width / gray.height, 1, 0.05), gray.width + "x" + gray.height);
		const best = ui.psDeskewAngle(gray.luma, gray.width, gray.height);
		check("自动矫正：3° 倾斜估出 ±3°（容差 0.7）", near(Math.abs(best), 3, 0.7), String(best));
		check("行落差：真角度优于偏 5°", ui.psRowScore(gray.luma, gray.width, gray.height, best) > ui.psRowScore(gray.luma, gray.width, gray.height, best + 5), "best=" + best);
		const straight = ui.psStraighten(tilt, -best);
		check("矫正：裁掉斜边，比例守住", straight.width < 160 && straight.height < 160 && near(straight.width / straight.height, 1, 0.08), straight.width + "x" + straight.height);
		const zero = ui.psStraighten(tilt, 0);
		check("矫正 0°：尺寸不变", zero.width === 160 && zero.height === 160, zero.width + "x" + zero.height);
		const flat = ui.psDeskewAngle(ui.psLumaFromCanvas(makeImage(120, 90, (ctx) => {
			ctx.fillStyle = "#111111";
			for (let y = 0; y < 90; y += 10) ctx.fillRect(0, y, 120, 3);
		})).luma, 120, 90);
		check("自动矫正：本来就是正的就不动它（|角| < 0.3）", Math.abs(flat) < 0.3 + 1e-9 || Math.abs(flat) <= 8, String(flat));

		// 鼠标实时那一下：模拟用户沿歪掉的条纹拖一条线（鼠标坐标 → 图片坐标），
		// psRulerAngle 给出该转多少度，psStraighten 立刻转 + 裁 —— 没有滑块、没有「应用」
		const dragged = ui.psRulerAngle({ x: 0, y: 0 }, { x: 160, y: 160 * Math.tan((3 * Math.PI) / 180) });
		check("标尺：沿歪 3° 的边拖一条线 → 得 -3°", near(dragged, -3, 0.02), String(dragged));
		check("标尺：反着拖（右下往左上）结果一样", near(ui.psRulerAngle({ x: 160, y: 160 * Math.tan((3 * Math.PI) / 180) }, { x: 0, y: 0 }), -3, 0.02));
		check("标尺：竖着拖给的是「按竖直对齐」的小角度", near(ui.psRulerAngle({ x: 0, y: 0 }, { x: 4, y: 160 }), 1.43, 0.02), String(ui.psRulerAngle({ x: 0, y: 0 }, { x: 4, y: 160 })));
		check("标尺：手抖拖太短不生效（返回 null）", ui.psRulerAngle({ x: 10, y: 10 }, { x: 13, y: 12 }) === null);
		const leveled = ui.psStraighten(tilt, dragged);
		const rest = ui.psDeskewAngle(ui.psLumaFromCanvas(leveled).luma, ui.psLumaFromCanvas(leveled).width, ui.psLumaFromCanvas(leveled).height);
		check("标尺松手即矫正：剩下的倾斜 < 0.8°（原图 3°）", Math.abs(rest) < 0.8, String(rest));
	});

	sec("缩放 / 翻转", () => {
		const small = ui.psResize(src, 30, 20);
		check("缩放：尺寸=输入", small.width === 30 && small.height === 20, small.width + "x" + small.height);
		check("缩放：内容跟着缩", px(small, 0, 0)[0] > 180, rgb(px(small, 0, 0)));
		const fh = ui.psFlip(src, "h");
		check("水平翻转：尺寸不变，红点换到右边", fh.width === 120 && isRed(px(fh, 119, 0)) && px(fh, 0, 0)[0] > 250, rgb(px(fh, 119, 0)));
		const fv = ui.psFlip(src, "v");
		check("垂直翻转：红点落到底部", isRed(px(fv, 0, 79)), rgb(px(fv, 0, 79)));
	});

	sec("缩放与分辨率", () => {
		check("滚轮向上放大、向下缩小", ui.psWheelZoom(1, -100) > 1 && ui.psWheelZoom(1, 100) < 1, ui.psWheelZoom(1, -100).toFixed(3));
		check("缩放夹在 5% ~ 800%", ui.psClampZoom(0.001) === 0.05 && ui.psClampZoom(50) === 8);
		const moved = ui.psZoomAt(0.5, 1, { x: 100, y: 50 }, { left: 200, top: 300 });
		check("以光标为锚点：光标下的点不动", near(moved.scrollLeft, 500, 1e-6) && near(moved.scrollTop, 650, 1e-6), moved.scrollLeft + "," + moved.scrollTop);
		check("适应窗口：3000px 的图缩到容器里", ui.psFitZoom(3072, 4096, 800, 600) < 0.2 && near(ui.psFitZoom(3072, 4096, 800, 600), 600 / 4096, 1e-6), String(ui.psFitZoom(3072, 4096, 800, 600)));

		// 真 canvas 导出一张，写 300 DPI，再读回来；文件留在 docs/preview 让人用系统看图器验
		const art = makeImage(200, 140, (ctx) => {
			ctx.fillStyle = "#12304f"; ctx.fillRect(0, 0, 200, 140);
			ctx.fillStyle = "#ffd166"; ctx.fillRect(20, 20, 160, 30);
			ctx.fillStyle = "#ffffff"; ctx.font = "bold 20px sans-serif"; ctx.fillText("300 DPI", 52, 100);
		});
		const raw = art.toDataURL("image/png");
		check("canvas 导出的 PNG 没带分辨率", ui.psReadDpi(raw) === null, String(ui.psReadDpi(raw)));
		const dpiPng = ui.psApplyDpi(raw, 300);
		check("写入 300 DPI 后读回来是 300", ui.psReadDpi(dpiPng) === 300, String(ui.psReadDpi(dpiPng)));
		check("写完只多一个 pHYs（+21 字节）", dpiPng.length - raw.length === Math.round(21 / 3) * 4, String(dpiPng.length - raw.length));
		window.__dpiShot = dpiPng;
	});

	sec("选区几何", () => {
		const from = ui.psRectFrom({ x: 90, y: 70 }, { x: 20, y: 10 }, 120, 80);
		check("反向拖也得到正矩形", !!from && from.x === 20 && from.y === 10 && from.w === 70 && from.h === 60, JSON.stringify(from));
		const out = ui.psRectFrom({ x: 100, y: 60 }, { x: 400, y: 400 }, 120, 80);
		check("拖出图外被夹回边界", !!out && out.x + out.w === 120 && out.y + out.h === 80, JSON.stringify(out));
		const se = ui.psResizeRect({ x: 20, y: 20, w: 40, h: 40 }, "se", { x: 90, y: 90 }, 120, 80);
		check("手柄 se：改右下角", !!se && se.x === 20 && se.y === 20 && se.w === 70 && se.h === 60, JSON.stringify(se));
		const nw = ui.psResizeRect({ x: 20, y: 20, w: 40, h: 40 }, "nw", { x: 60, y: 50 }, 120, 80);
		check("手柄 nw：改左上角不翻面、退化也留 1px", !!nw && nw.x === 60 && nw.y === 50 && nw.w === 1 && nw.h === 10, JSON.stringify(nw));
		const flippedEdge = ui.psResizeRect({ x: 20, y: 20, w: 40, h: 40 }, "nw", { x: 90, y: 100 }, 120, 80);
		check("手柄拖过头：翻面也给出正矩形", !!flippedEdge && flippedEdge.w > 0 && flippedEdge.h > 0, JSON.stringify(flippedEdge));
		check("命中判定：取最近的手柄", ui.psHitHandle({ x: 20, y: 20, w: 40, h: 40 }, { x: 61, y: 61 }, 12) === "se", String(ui.psHitHandle({ x: 20, y: 20, w: 40, h: 40 }, { x: 61, y: 61 }, 12)));
		check("命中判定：离开手柄就返回空", ui.psHitHandle({ x: 20, y: 20, w: 40, h: 40 }, { x: 40, y: 40 }, 6) === null, "null");
		const handles = ui.psHandles({ x: 20, y: 20, w: 40, h: 60 });
		check("八个手柄都落在边框上", handles.length === 8 && handles[0].id === "nw" && handles[4].id === "se" && handles[4].x === 60 && handles[4].y === 80, JSON.stringify(handles[4]));
	});

	sec("内接矩形", () => {
		const a0 = ui.psInscribedSize(200, 120, 0);
		const a5 = ui.psInscribedSize(200, 120, 5);
		const a12 = ui.psInscribedSize(200, 120, 12);
		check("0° 就是原尺寸", a0.w === 200 && a0.h === 120, a0.w + "x" + a0.h);
		check("角度越大保留越少", a5.w > a12.w && a5.h > a12.h, a5.w + "x" + a5.h + " / " + a12.w + "x" + a12.h);
		check("同比例：裁完还是 200:120", near(a5.w / a5.h, 200 / 120, 0.03), (a5.w / a5.h).toFixed(3));
	});

	sec("羽化样张", () => {
		const art = makeImage(200, 140, (ctx) => {
			const g = ctx.createLinearGradient(0, 0, 200, 140);
			g.addColorStop(0, "#2f6bff"); g.addColorStop(1, "#ff7a45");
			ctx.fillStyle = g; ctx.fillRect(0, 0, 200, 140);
			ctx.fillStyle = "rgba(255,255,255,.9)";
			ctx.font = "bold 26px sans-serif"; ctx.fillText("VIG", 60, 84);
		});
		window.__featherShot = ui.psFeather(art, null, 26).toDataURL("image/png");
		check("样张导出成功", window.__featherShot.indexOf("data:image/png") === 0, String(window.__featherShot.length) + " 字符");
	});
}

// 写坏了的 PNG 浏览器解不出来 —— 这里是最后一道：真让它解码一次
await new Promise((resolve) => {
	const img = new Image();
	img.onload = () => {
		check("写完分辨率的 PNG 浏览器仍能解码", img.naturalWidth === 200 && img.naturalHeight === 140, img.naturalWidth + "x" + img.naturalHeight);
		resolve();
	};
	img.onerror = () => {
		check("写完分辨率的 PNG 浏览器仍能解码", false, "decode 失败");
		resolve();
	};
	img.src = window.__dpiShot || "";
});

const out = document.createElement("pre");
out.id = "vig-ps-out";
out.textContent = JSON.stringify({ results, feather: window.__featherShot || "", dpi: window.__dpiShot || "" });
document.body.appendChild(out);
`;

const html = `<!doctype html><html><head><meta charset="utf-8"><title>ps-check</title></head><body>
<script>
window.__ModuleLoader__ = { load: (record) => { window.__vigRecord = record; } };
</script>
<script>
${clientSource}
</script>
<script>
(async () => {
try {
${driver}
} catch (error) {
	const pre = document.createElement("pre");
	pre.id = "vig-ps-out";
	pre.textContent = JSON.stringify({ results: [{ name: "驱动脚本异常", pass: false, detail: String((error && error.stack) || error) }], feather: "", dpi: "" });
	document.body.appendChild(pre);
}
})();
</script>
</body></html>`;

mkdirSync(OUT, { recursive: true });
// 页面本身是临时件（几十上百 KB，含 client.js 全文），写进 %TEMP%；只有样张 PNG 留在 docs/preview。
const page = path.join(mkdtempSync(path.join(tmpdir(), "vig-ps-check-")), "ps-check.html");
writeFileSync(page, html, "utf8");

if (!existsSync(CHROME)) {
  console.log(`chrome 未找到：${CHROME}`);
  process.exit(1);
}

const dom = execFileSync(
  CHROME,
  ["--headless=new", "--disable-gpu", "--no-sandbox", "--virtual-time-budget=8000", "--dump-dom", `file:///${page.replace(/\\/g, "/")}`],
  { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 }
);

const match = dom.match(/<pre id="vig-ps-out">([\s\S]*?)<\/pre>/);
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
const payload = JSON.parse(decode(match[1]));

let pass = 0;
let fail = 0;
for (const item of payload.results) {
  if (item.pass) pass += 1;
  else fail += 1;
  console.log(`${item.pass ? "PASS" : "FAIL"}  ${item.name}${item.detail ? ` — ${item.detail}` : ""}`);
}
if (payload.feather) {
  const file = path.join(OUT, "ps-feather.png");
  writeFileSync(file, Buffer.from(payload.feather.split(",")[1], "base64"));
  console.log(`\n羽化样张：${file}`);
}
if (payload.dpi) {
  const file = path.join(OUT, "ps-dpi.png");
  const bytes = Buffer.from(payload.dpi.split(",")[1], "base64");
  writeFileSync(file, bytes);
  // 不看内存里的返回值，直接拆落盘文件的 pHYs：系统看图器看到的才是这个值
  let at = 8;
  let dpi = null;
  while (at + 12 <= bytes.length) {
    const length = bytes.readUInt32BE(at);
    const type = bytes.subarray(at + 4, at + 8).toString("latin1");
    if (type === "pHYs") {
      dpi = Math.round(bytes.readUInt32BE(at + 8) * 0.0254);
      break;
    }
    if (type === "IEND") break;
    at += 12 + length;
  }
  console.log(`分辨率样张：${file} — 文件头里的 pHYs 读出 ${dpi} DPI`);
  if (dpi !== 300) fail += 1;
}
console.log(`\n真机 canvas ${pass}/${pass + fail} 通过${fail ? `，${fail} 项失败` : ""}`);
process.exit(fail === 0 ? 0 : 1);
