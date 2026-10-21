// dsh-plugin-velapi-image-go —— 适配性检查：这个宽度下会不会溢出 / 被裁
//
// 为什么需要它：插件会被塞进三种宽度完全不同的容器（设置页整页、产品右侧栏分栏后的
// 一栏 ~400px、停靠面板）。一旦里面有东西压不下去（典型的：<select> 的 min-width:auto
// 等于最长选项文字宽），整列就会被撑宽，超出容器的部分被宿主裁掉——看起来就是「渲染坏了」。
// 光看截图很难定位，所以这里用真浏览器量：把工作台放进固定宽度的框里，量
// scrollWidth / clientWidth / offsetWidth 的差额，超差就是溢出。
//
//   node tools/fit-check.mjs [--chrome PATH]
//
// 退出码 0 = 所有宽度都不溢出。

import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { loadClientBundle } from "./bundle.mjs";
import { failedMarkup, narrowMarkup, page, pickerMarkup, psMarkup, wideMarkup } from "./markup.mjs";

const args = process.argv.slice(2);
const flag = (name, fallback) => {
  const index = args.indexOf(name);
  return index >= 0 && args[index + 1] ? args[index + 1] : fallback;
};
const CHROME = flag("--chrome", process.env.VIG_CHROME || "C:/Program Files/Google/Chrome/Application/chrome.exe");
if (!existsSync(CHROME)) throw new Error(`找不到 Chrome：${CHROME}`);
process.env.VIG_QUIET = "1";

const { module } = loadClientBundle();
const ui = module.__internals;

/** 页内测量脚本：把结果塞进 <pre id="PROBE">，再用 --dump-dom 读回来。 */
const PROBE = `<script>
	window.addEventListener("load", () => {
		const box = (element) => (element ? { cw: element.clientWidth, sw: element.scrollWidth, ow: element.offsetWidth, oh: element.offsetHeight } : null);
		const report = {
			root: box(document.querySelector(".vig-root")),
			shell: box(document.querySelector(".vig-shell")),
			col: box(document.querySelector(".vig-col")),
			main: box(document.querySelector(".vig-main")),
			mainBody: box(document.querySelector(".vig-main-body")),
			composer: box(document.querySelector(".vig-composer")),
			tools: box(document.querySelector(".vig-tools")),
			side: box(document.querySelector(".vig-side")),
			nav: box(document.querySelector(".vig-nav")),
			head: box(document.querySelector(".vig-head")),
			doc: { cw: document.documentElement.clientWidth, sw: document.documentElement.scrollWidth }
		};
		const node = document.createElement("pre");
		node.id = "PROBE";
		node.textContent = "PROBE_JSON=" + JSON.stringify(report);
		document.body.appendChild(node);
	});
</script>`;

// 只检查真正可达的组合：
//  · 窄形态（data-compact=1）在任何宽度都得撑得住 —— 停靠面板、右侧栏分栏都走这条；
//  · 宽形态（data-compact=0）只在 ≥ 断点时可达，因为 useWide 会在窄容器里切成窄形态。
//    断点写在 client.js 的 useWide(ref, 660)。
const BREAKPOINT = 660;
const cases = [
  ...[320, 360, 400, 420, 470, 560, 660, 720, 900, 1280].map((width) => ({ width, compact: true, label: `窄 ${width}px` })),
  ...[BREAKPOINT, 700, 820, 1024, 1280].map((width) => ({ width, compact: false, label: `宽 ${width}px` }))
];

const rows = [];
let failures = 0;
const dir = mkdtempSync(path.join(tmpdir(), "vig-fit-"));
// 每个宽度写一份 HTML，一轮十几份就是几十 MB。跑完（或中途炸了）必须自己删掉：
// %TEMP% 是 C 盘的，攒十几轮就能把盘写满（踩过 ENOSPC）。
const cleanup = () => rmSync(dir, { recursive: true, force: true });
process.on("exit", cleanup);
try {
for (const item of cases) {
  const markup = (item.compact ? narrowMarkup : (u, v) => wideMarkup(u, v))(ui, "chat");
  const html = page(`fit ${item.label}`, markup, { width: item.width, compact: item.compact, css: ui.CSS, frame: { padding: 0, minHeight: 700 } }).replace(
    "</body>",
    `${PROBE}</body>`
  );
  const file = path.join(dir, `fit-${item.compact ? "compact" : "wide"}-${item.width}.html`);
  writeFileSync(file, html, "utf8");
  const dom = execFileSync(
    CHROME,
    ["--headless=new", "--disable-gpu", "--virtual-time-budget=2500", "--window-size=1600,900", "--dump-dom", `file:///${file.replace(/\\/g, "/")}`],
    { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 }
  );
  const match = dom.match(/PROBE_JSON=(\{.*?\})<\/pre>/s);
  if (!match) {
    console.log(`  ${item.label}  — 拿不到测量结果`);
    failures += 1;
    continue;
  }
  const report = JSON.parse(match[1].replace(/&quot;/g, '"'));
  const overflow = (report.root?.sw ?? 0) - (report.root?.cw ?? 0);
  const inner = Math.max(
    (report.tools?.sw ?? 0) - (report.tools?.cw ?? 0),
    (report.composer?.sw ?? 0) - (report.composer?.cw ?? 0),
    (report.main?.sw ?? 0) - (report.main?.cw ?? 0),
    (report.side?.sw ?? 0) - (report.side?.cw ?? 0)
  );
  const height = report.mainBody?.cw ?? 0;
  const ok = overflow <= 1 && inner <= 1;
  if (!ok) failures += 1;
  rows.push({
    宽度: item.label,
    根容器: report.root ? `${report.root.cw}px` : "—",
    内容溢出: `${Math.max(overflow, 0)}px`,
    内部最大溢出: `${Math.max(inner, 0)}px`,
    外壳高: report.shell ? `${report.shell.oh}px` : "—",
    导航高: report.nav ? `${report.nav.oh}px` : "—",
    结论: ok ? "PASS" : "FAIL"
  });
  void height;
}
} finally {
  cleanup();
}

/* ---- 弹层越界检查 -------------------------------------------------- *
 * 模型选择器展开后的弹层是卡片内部的绝对定位元素，卡片 overflow:hidden —— 
 * 越出卡片就等于被裁掉（踩过：宽栏 288px 弹层贴左、窄栏 236px 从 300px 的卡片里伸出去）。 */

const POP_PROBE = `<script>
	window.addEventListener("load", () => {
		const rect = (selector) => {
			const element = document.querySelector(selector);
			if (!element) return null;
			const box = element.getBoundingClientRect();
			return { l: Math.round(box.left), r: Math.round(box.right), t: Math.round(box.top), b: Math.round(box.bottom), h: Math.round(box.height) };
		};
		const node = document.createElement("pre");
		node.id = "PROBE";
		node.textContent = "PROBE_JSON=" + JSON.stringify({
			card: rect(".vig-main"), pop: rect(".vig-pop"), pick: rect(".vig-pick"), items: document.querySelectorAll(".vig-pop-item").length
		});
		document.body.appendChild(node);
	});
</script>`;

const popRows = [];
let popFailures = 0;
const popDir = mkdtempSync(path.join(tmpdir(), "vig-pop-"));
const popCleanup = () => rmSync(popDir, { recursive: true, force: true });
process.on("exit", popCleanup);
try {
  for (const item of [{ width: 320, compact: true }, { width: 420, compact: true }, { width: 560, compact: true }, { width: 660, compact: false }, { width: 1280, compact: false }]) {
    const html = page(`pop ${item.width}`, pickerMarkup(ui, { open: true, height: 620 }), {
      width: item.width,
      compact: item.compact,
      css: ui.CSS,
      frame: { padding: item.compact ? 10 : 14, minHeight: 700 }
    }).replace("</body>", `${POP_PROBE}</body>`);
    const file = path.join(popDir, `pop-${item.width}.html`);
    writeFileSync(file, html, "utf8");
    const dom = execFileSync(
      CHROME,
      ["--headless=new", "--disable-gpu", "--virtual-time-budget=2500", "--window-size=1600,900", "--dump-dom", `file:///${file.replace(/\\/g, "/")}`],
      { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 }
    );
    const match = dom.match(/PROBE_JSON=(\{.*?\})<\/pre>/s);
    if (!match) {
      console.log(`  弹层 ${item.width}px  — 拿不到测量结果`);
      popFailures += 1;
      continue;
    }
    const report = JSON.parse(match[1].replace(/&quot;/g, '"'));
    const outside = report.pop ? Math.max(0, report.card.l - report.pop.l) + Math.max(0, report.pop.r - report.card.r) : 999;
    const ok = Boolean(report.pop) && outside <= 1;
    if (!ok) popFailures += 1;
    popRows.push({
      宽度: `${item.compact ? "窄" : "宽"} ${item.width}px`,
      卡片: report.card ? `${report.card.r - report.card.l}px` : "—",
      弹层: report.pop ? `${report.pop.r - report.pop.l}px` : "—",
      越出卡片: `${outside}px`,
      选项数: report.items === undefined ? "—" : String(report.items),
      结论: ok ? "PASS" : "FAIL"
    });
  }
} finally {
  popCleanup();
}

console.log("");
console.log(["宽度", "卡片", "弹层", "越出卡片", "选项数", "结论"].join("  "));
for (const row of popRows) {
  console.log([row.宽度, row.卡片, row.弹层, row.越出卡片, row.选项数, row.结论].map((cell) => String(cell).padEnd(6, " ")).join("  "));
}
failures += popFailures;

/* ---- 图片处理工具箱：三栏（工具条 / 画布 / 参数）在窄栏里必须折成一栏且不溢出 ---- */

const PS_PROBE = `<script>
	window.addEventListener("load", () => {
		const box = (selector) => {
			const element = document.querySelector(selector);
			return element ? { cw: element.clientWidth, sw: element.scrollWidth, ow: element.offsetWidth } : null;
		};
		const node = document.createElement("pre");
		node.id = "PROBE";
		node.textContent = "PROBE_JSON=" + JSON.stringify({
			root: box(".vig-root"), ps: box(".vig-ps"), tools: box(".vig-ps-tools"), stage: box(".vig-ps-stage"), params: box(".vig-ps-params")
		});
		document.body.appendChild(node);
	});
</script>`;

const psRows = [];
let psFailures = 0;
const psDir = mkdtempSync(path.join(tmpdir(), "vig-ps-"));
const psCleanup = () => rmSync(psDir, { recursive: true, force: true });
process.on("exit", psCleanup);
try {
  for (const item of [{ width: 320, compact: true }, { width: 420, compact: true }, { width: 660, compact: false }, { width: 940, compact: false }, { width: 1280, compact: false }]) {
    const html = page(`ps ${item.width}`, psMarkup(ui, { tool: "select", selection: { x: 40, y: 52, w: 150, h: 112 } }), {
      width: item.width,
      compact: item.compact,
      css: ui.CSS,
      frame: { padding: item.compact ? 10 : 14, minHeight: 700 }
    }).replace("</body>", `${PS_PROBE}</body>`);
    const file = path.join(psDir, `ps-${item.width}.html`);
    writeFileSync(file, html, "utf8");
    const dom = execFileSync(
      CHROME,
      ["--headless=new", "--disable-gpu", "--virtual-time-budget=2500", "--window-size=1600,1000", "--dump-dom", `file:///${file.replace(/\\/g, "/")}`],
      { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 }
    );
    const match = dom.match(/PROBE_JSON=(\{.*?\})<\/pre>/s);
    if (!match) {
      console.log(`  工具箱 ${item.width}px — 拿不到测量结果`);
      psFailures += 1;
      continue;
    }
    const report = JSON.parse(match[1].replace(/&quot;/g, '"'));
    const overflow = (value) => (value ? Math.max(0, value.sw - value.cw) : 0);
    const worst = Math.max(overflow(report.root), overflow(report.ps), overflow(report.tools), overflow(report.stage), overflow(report.params));
    const columns = report.ps && report.stage ? Math.round((report.ps.ow - (report.tools?.ow ?? 0) - (report.params?.ow ?? 0)) / 10) : 0;
    const ok = worst <= 1;
    if (!ok) psFailures += 1;
    psRows.push({
      宽度: `${item.compact ? "窄" : "宽"} ${item.width}px`,
      工具箱: report.ps ? `${report.ps.ow}px` : "—",
      工具条: report.tools ? `${report.tools.ow}px` : "—",
      画布: report.stage ? `${report.stage.ow}px` : "—",
      参数: report.params ? `${report.params.ow}px` : "—",
      最大溢出: `${worst}px`,
      结论: ok ? "PASS" : "FAIL"
    });
    void columns;
  }
} finally {
  psCleanup();
}

console.log("");
console.log(["宽度", "工具箱", "工具条", "画布", "参数", "最大溢出", "结论"].join("  "));
for (const row of psRows) {
  console.log([row.宽度, row.工具箱, row.工具条, row.画布, row.参数, row.最大溢出, row.结论].map((cell) => String(cell).padEnd(6, " ")).join("  "));
}
failures += psFailures;

/* ---- 输入框那一行：协议选择（长选项名最容易把这一行撑开）+ 报错证据块都得压得住 ---- */

const UP_PROBE = `<script>
	window.addEventListener("load", () => {
		const box = (selector) => {
			const element = document.querySelector(selector);
			return element ? { cw: element.clientWidth, sw: element.scrollWidth, ow: element.offsetWidth, oh: element.offsetHeight } : null;
		};
		const node = document.createElement("pre");
		node.id = "PROBE";
		node.textContent = "PROBE_JSON=" + JSON.stringify({
			root: box(".vig-root"), tools: box(".vig-tools"), endpoint: box(".vig-endpoint"),
			block: box(".vig-fail"), pre: box(".vig-fail-pre"),
			options: document.querySelectorAll(".vig-endpoint option").length
		});
		document.body.appendChild(node);
	});
</script>`;

const upRows = [];
let upFailures = 0;
const upDir = mkdtempSync(path.join(tmpdir(), "vig-up-"));
const upCleanup = () => rmSync(upDir, { recursive: true, force: true });
process.on("exit", upCleanup);
try {
  for (const item of [{ width: 320, compact: true }, { width: 420, compact: true }, { width: 560, compact: true }, { width: 1280, compact: false }]) {
    const html = page(`upstream ${item.width}`, failedMarkup(ui), {
      width: item.width,
      compact: item.compact,
      css: ui.CSS,
      frame: { padding: item.compact ? 10 : 14, minHeight: 700 }
    }).replace("</body>", `${UP_PROBE}</body>`);
    const file = path.join(upDir, `up-${item.width}.html`);
    writeFileSync(file, html, "utf8");
    const dom = execFileSync(
      CHROME,
      ["--headless=new", "--disable-gpu", "--virtual-time-budget=2500", "--window-size=1600,1000", "--dump-dom", `file:///${file.replace(/\\/g, "/")}`],
      { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 }
    );
    const match = dom.match(/PROBE_JSON=(\{.*?\})<\/pre>/s);
    if (!match) {
      console.log(`  协议那一行 ${item.width}px — 拿不到测量结果`);
      upFailures += 1;
      continue;
    }
    const report = JSON.parse(match[1].replace(/&quot;/g, '"'));
    const overflow = (value) => (value ? Math.max(0, value.sw - value.cw) : 0);
    const worst = Math.max(overflow(report.root), overflow(report.tools), overflow(report.endpoint), overflow(report.block));
    // 窄栏里协议选择必须还在（11 个选项一个不少），失败卡不许横向跑出容器
    const ok = worst <= 1 && report.options === 11 && Boolean(report.endpoint) && Boolean(report.pre);
    if (!ok) upFailures += 1;
    upRows.push({
      宽度: `${item.compact ? "窄" : "宽"} ${item.width}px`,
      参数行: report.tools ? `${report.tools.ow}px` : "—",
      协议选择: report.endpoint ? `${report.endpoint.ow}px` : "—",
      选项数: String(report.options ?? "—"),
      响应体: report.pre ? `${report.pre.cw}px` : "—",
      最大溢出: `${worst}px`,
      结论: ok ? "PASS" : "FAIL"
    });
  }
} finally {
  upCleanup();
}

console.log("");
console.log(["宽度", "参数行", "协议选择", "选项数", "响应体", "最大溢出", "结论"].join("  "));
for (const row of upRows) {
  console.log([row.宽度, row.参数行, row.协议选择, row.选项数, row.响应体, row.最大溢出, row.结论].map((cell) => String(cell).padEnd(6, " ")).join("  "));
}
failures += upFailures;

console.log("");
const head = Object.keys(rows[0]);
console.log(["宽度", "根容器", "内容溢出", "内部最大溢出", "外壳高", "导航高", "结论"].join("  "));
for (const row of rows) {
  console.log([row.宽度, row.根容器, row.内容溢出, row.内部最大溢出, row.外壳高, row.导航高, row.结论].map((cell) => String(cell).padEnd(6, " ")).join("  "));
}
void head;
console.log(failures === 0 ? `\n全部 ${rows.length} 个宽度都不溢出` : `\n${failures} 个宽度存在横向溢出`);
process.exitCode = failures === 0 ? 0 : 1;
