// dsh-plugin-velapi-image-go —— 静态预览生成器
//
// 把客户端的各个视图喂上样例数据渲染成独立 HTML，再用本机 Chrome 截成 PNG。
// 用的是 client.js 里真实的组件与样式（不是另画一张图），所以预览和跑在
// dsh 里的是同一套像素。
//
//   node tools/preview.mjs [--out DIR] [--no-shot]
//
// 产物：
//   <out>/chat.html      对话生图（宽屏三栏）
//   <out>/chat-dock.html 右侧停靠面板（窄容器堆叠）
//   <out>/library.html / notes.html / providers.html
//   <out>/*.png          同名截图
//
// 想量「这个宽度下会不会溢出」用 tools/fit-check.mjs。

import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { loadClientBundle } from "./bundle.mjs";
import { failedMarkup, launcherMarkup, narrowMarkup, page, pickerMarkup, presetMarkup, psMarkup, toastMarkup, wideMarkup } from "./markup.mjs";

const args = process.argv.slice(2);
const flag = (name, fallback) => {
  const index = args.indexOf(name);
  return index >= 0 && args[index + 1] ? args[index + 1] : fallback;
};
const OUT = path.resolve(flag("--out", path.join(process.cwd(), "docs", "preview")));
const SHOT = !args.includes("--no-shot");
const CHROME = process.env.VIG_CHROME || "C:/Program Files/Google/Chrome/Application/chrome.exe";

const { module } = loadClientBundle();
const ui = module.__internals;
if (!ui) throw new Error("client.js 没有导出 __internals");

const targets = [
  { name: "chat", title: "对话生图 · 宽屏三栏", view: "chat", width: 1280, compact: false },
  { name: "library", title: "图片管理", view: "library", width: 1280, compact: false, inspector: false },
  { name: "notes", title: "信息管理", view: "notes", width: 1280, compact: false, inspector: false },
  { name: "providers", title: "供应商管理", view: "providers", width: 1280, compact: false, inspector: false },
  { name: "chat-dock", title: "右侧停靠面板（420px）", view: "chat", width: 420, compact: true, height: 1560 },
  { name: "model-picker", title: "模型选择器 · 展开（按前缀分组）", picker: { open: true }, width: 520, compact: false },
  { name: "launcher", title: "固定入口：宿主公开落点上的那颗按钮（左侧栏底部 / 输入框 dock）", launcher: {}, width: 720, compact: false, height: 300 },
  { name: "toast", title: "提示条：窗口额头居中悬浮（内容两侧各留三字白）+ 参考图小矩形卡", toast: {}, width: 900, compact: false, height: 560 },
  { name: "chat-failed", title: "对话生图 · 上游报错：气泡里摆原始响应体，协议选择在输入框那一行", failed: {}, width: 1120, compact: false, height: 900 },
  { name: "model-picker-dock", title: "模型选择器 · 窄栏展开（420px）", picker: { open: true, width: 300 }, width: 420, compact: true },
  { name: "presets", title: "预设卡 · 卡片墙", preset: {}, width: 640, compact: false, height: 560 },
  { name: "preset-dialog", title: "预设卡 · 编辑器", preset: { dialog: true }, width: 640, compact: false, height: 700 },
  { name: "ps", title: "图片处理 · 框选（左工具条 / 中画布 / 右参数）", ps: { tool: "select", selection: { x: 40, y: 52, w: 150, h: 112 } }, width: 940, compact: false, height: 620 },
  { name: "ps-canvas", title: "图片处理 · 画布（尺寸 / 常用比例 / 分辨率 / 锚点）", ps: { tool: "canvasSize", dpi: 300 }, width: 940, compact: false, height: 620 },
  { name: "ps-zoom", title: "图片处理 · 滚轮放大到 200%（比例条 / 适应 / 1:1）", ps: { tool: "rotate", scale: 2 }, width: 940, compact: false, height: 620 },
  { name: "ps-focus", title: "图片处理 · 专注画布（两侧收起，画布铺开）", ps: { tool: "select", selection: { x: 40, y: 52, w: 150, h: 112 }, collapsed: true }, width: 940, compact: false, height: 620 },
  { name: "ps-keys", title: "图片处理 · 快捷键表（? 打开，点键帽即可改键）", ps: { tool: "select", keys: true }, width: 940, compact: false, height: 760 },
  { name: "ps-collapsed", title: "图片处理 · 参数收起（贴右边缘的窄抽屉，只剩一个竖排小签）", ps: { tool: "select", collapsed: true }, width: 940, compact: false, height: 760 },
  { name: "ps-adjust", title: "图片处理 · 调整（规范化表单：分区 + 两列网格 + 右对齐动作行）", ps: { tool: "adjust" }, width: 420, compact: true, height: 1560 },
  { name: "ps-empty", title: "图片处理 · 空画面（最近生成铺满这块空间）", ps: { empty: true }, width: 1000, compact: false, height: 780 },
  { name: "ps-ruler", title: "图片处理 · 矫正：鼠标拖一条参考线，画面实时转（PS 标尺）", ps: { tool: "straighten", ruler: { from: { x: 18, y: 96 }, to: { x: 238, y: 79 }, angle: 4.3 } }, width: 1080, compact: false, height: 760 },
  { name: "ps-warp", title: "图片处理 · 四点畸变：拖蓝四点框住歪着的画面，拉平成正矩形", ps: { tool: "warp", warpMode: "flat", warp: { src: [{ x: 22, y: 46 }, { x: 236, y: 30 }, { x: 244, y: 208 }, { x: 14, y: 224 }] } }, width: 1080, compact: false, height: 760 },
  { name: "ps-warp-free", title: "图片处理 · 自由拉伸：蓝四点从哪儿取，橙四点放到哪儿（八个角都能拖）", ps: { tool: "warp", warpMode: "free", warp: { src: [{ x: 30, y: 40 }, { x: 226, y: 40 }, { x: 226, y: 216 }, { x: 30, y: 216 }], dst: [{ x: 58, y: 74 }, { x: 238, y: 44 }, { x: 206, y: 232 }, { x: 20, y: 196 }] } }, width: 1080, compact: false, height: 760 },
  { name: "ps-warp-distort", title: "图片处理 · 变形：取图四点钉在图片四角，拖橙四点把画面拉成形状（结果侧实时）", ps: { tool: "warp", warpMode: "distort", warp: { src: [{ x: 0, y: 0 }, { x: 256, y: 0 }, { x: 256, y: 256 }, { x: 0, y: 256 }], dst: [{ x: 62, y: 58 }, { x: 250, y: 26 }, { x: 232, y: 240 }, { x: 18, y: 214 }] } }, width: 1080, compact: false, height: 760 },
  { name: "ps-dock", title: "图片处理 · 窄栏（420px，工具条折成一行）", ps: { tool: "feather" }, width: 420, compact: true, height: 1080 }
];

mkdirSync(OUT, { recursive: true });
const files = [];

for (const target of targets) {
  const inner = target.picker
    ? pickerMarkup(ui, target.picker)
    : target.preset
      ? presetMarkup(ui, target.preset)
      : target.launcher
        ? launcherMarkup(ui)
        : target.toast
        ? toastMarkup(ui)
        : target.failed
          ? failedMarkup(ui, target.failed)
          : target.ps
            ? psMarkup(ui, target.ps)
            : target.compact
              ? narrowMarkup(ui, target.view)
              : wideMarkup(ui, target.view, target.inspector !== false);
  const file = path.join(OUT, `${target.name}.html`);
  writeFileSync(file, page(target.title, inner, { width: target.width, compact: target.compact, css: ui.CSS }), "utf8");
  files.push({ name: target.name, html: file, width: target.width, height: target.height });
  console.log(`  html  ${target.name}.html`);
}

if (SHOT) {
  if (!existsSync(CHROME)) {
    console.log(`  chrome 未找到，跳过截图：${CHROME}`);
  } else {
    for (const item of files) {
      const png = path.join(OUT, `${item.name}.png`);
      execFileSync(
        CHROME,
        [
          "--headless=new",
          "--disable-gpu",
          "--hide-scrollbars",
          "--force-device-scale-factor=2",
          `--window-size=${item.width},${item.height || 820}`,
          `--screenshot=${png}`,
          `file:///${item.html.replace(/\\/g, "/")}`
        ],
        { stdio: "ignore" }
      );
      console.log(`  png   ${item.name}.png`);
    }
  }
}

console.log(`\n产物目录：${OUT}`);
