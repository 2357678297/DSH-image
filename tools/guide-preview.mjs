// dsh-plugin-velapi-image-go —— 「右侧栏开始页」预览
//
// 用户要的是「按钮写在右侧栏那片空位」：那片空位是 ui-sidebar-right 的 guide 页面，
// 里面的卡片来自 sidebarRightTabs.register({ guide: [...] })。这个脚本把宿主真实的
// GuideBody CSS（从 `@deepseek-ai/dsh-client-ui-sidebar-right/lib/client.js` 里抠出来）
// 套在样例卡片上，把「我的卡片长什么样」截成图，免得靠肉眼在应用里确认。
//
//   node tools/guide-preview.mjs [--out DIR] [--host BUNDLE] [--theme light|dark]
//
// 产物：<out>/rightbar-guide.png（340px 宽，跟右侧栏一栏的宽度一致）
//
// 注意：宿主 CSS 用的是 --dsw-alias-* 设计令牌，这里给了一组近似值只为让预览有颜色，
// 不是宿主的真值；真实渲染以应用内为准。

import { execFileSync } from "node:child_process";
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, readSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import vm from "node:vm";

const args = process.argv.slice(2);
const flag = (name, fallback) => {
  const index = args.indexOf(name);
  return index >= 0 && args[index + 1] ? args[index + 1] : fallback;
};
const OUT = path.resolve(flag("--out", path.join(process.cwd(), "docs", "preview")));
// 卡片本身是 width:380px 的，列宽给足才不会被裁 —— 应用里右侧栏一栏大约 420~456px。
const WIDTH = Number.parseInt(flag("--width", "420"), 10);
const HOST = flag("--host", "G:/deepseek-harness/resources/app/dsh/node_modules/@deepseek-ai/dsh-client-ui-sidebar-right/lib/client.js");

/**
 * 宿主 bundle 读取：DSH 是打包发布的（resources/app.asar），没有解包目录也很正常。
 * 先从磁盘上直接读；读不到就从 asar 里掏 —— asar 格式就一句话：
 * 偏移 4 是头部 JSON 长度、偏移 12 是 JSON 本体长度，JSON 从 16 开始，文件数据按 4 字节对齐跟在后面。
 */
function readHostBundle(target) {
  if (existsSync(target)) return { text: readFileSync(target, "utf8"), from: target };
  const archive = flag("--asar", "G:/deepseek-harness/resources/app.asar");
  if (!existsSync(archive)) throw new Error(`找不到宿主 bundle：${target}（也没有 ${archive}）`);
  const inner = target.replace(/\\/g, "/").replace(/^.*?resources\/(?:app\.asar|app)\//, "");
  const fd = openSync(archive, "r");
  try {
    const head = Buffer.alloc(16);
    readSync(fd, head, 0, 16, 0);
    const jsonSize = head.readUInt32LE(12);
    const json = Buffer.alloc(jsonSize);
    readSync(fd, json, 0, jsonSize, 16);
    const base = Math.ceil((16 + jsonSize) / 4) * 4;
    let node = JSON.parse(json.toString("utf8"));
    for (const part of inner.split("/")) {
      node = node && node.files ? node.files[part] : undefined;
      if (!node) throw new Error(`asar 里没有 ${inner}`);
    }
    if (!Number.isFinite(Number(node.offset)) || !Number.isFinite(Number(node.size))) throw new Error(`asar 条目不是文件：${inner}`);
    const out = Buffer.alloc(Number(node.size));
    readSync(fd, out, 0, out.length, base + Number(node.offset));
    return { text: out.toString("utf8"), from: `${archive}!${inner}` };
  } finally {
    closeSync(fd);
  }
}
const REACT_ROOT = process.env.VIG_REACT_ROOT || "G:/Gg-gank/frontend/deeix-chat/frontend/node_modules";
const CHROME = process.env.VIG_CHROME || "C:/Program Files/Google/Chrome/Application/chrome.exe";

const nodeRequire = createRequire(path.join(REACT_ROOT, "anchor.cjs"));
const React = nodeRequire("react");
const { renderToStaticMarkup } = nodeRequire("react-dom/server");

/* ---- 1. 从宿主 bundle 抠出 guide 的 CSS 与类名映射 ---------------- */

const hostBundle = readHostBundle(HOST);
const host = hostBundle.text;
const cssMatch = host.match(/"((?:[^"\\]|\\.)*unKlVG_(?:entry|guide)\{(?:[^"\\]|\\.)*)"/);
if (!cssMatch) throw new Error("没能从宿主 bundle 里抠出 GuideBody 的 CSS（宿主可能换过包）");
const guideCss = JSON.parse(`"${cssMatch[1]}"`);
const mapMatch = host.match(/GuideBody_module_css_default = \{([\s\S]{0,600}?)\};/);
const classMap = {};
for (const row of mapMatch?.[1]?.matchAll(/"([a-zA-Z]+)":\s*"([^"]+)"/g) ?? []) classMap[row[1]] = row[2];
if (!classMap.entry) throw new Error("没能解析 GuideBody 的类名映射");

/* ---- 2. 用我自己的 bundle 渲染卡片图标 --------------------------- */

const captured = [];
const sandbox = { console, setTimeout, clearTimeout, URL, fetch: async () => ({ ok: true, status: 200, text: async () => "{}" }) };
sandbox.window = { location: { origin: "" }, localStorage: { getItem: () => null, setItem: () => {} }, __ModuleLoader__: { load: (record) => captured.push(record) } };
sandbox.globalThis = sandbox;
vm.createContext(sandbox);
vm.runInContext(readFileSync(new URL("../client.js", import.meta.url), "utf8"), sandbox, { filename: "client.js" });
const ui = captured[0].factory((request) => {
  if (request === "react") return React;
  throw new Error(request);
}).__internals;

const icon = (name, size) => renderToStaticMarkup(React.createElement(ui.Icon, { name, size }));

/* ---- 3. 拼页面 --------------------------------------------------- */

const theme = flag("--theme", "light");
const tokens =
  theme === "dark"
    ? `--dsw-alias-bg-layer-1:#232833;--dsw-alias-border-l3:#333a47;--dsw-alias-label-primary:#e8eaee;--dsw-alias-label-secondary:#9aa3b2;--dsw-alias-label-tertiary:#7b8494;--dsw-alias-interactive-bg-hover:#2b313d;--dsw-static-neutral-700:#4a5262;--dsw-radius-xl:14px;--vig-page:#1b1f27`
    : `--dsw-alias-bg-layer-1:#ffffff;--dsw-alias-border-l3:#e6e8ec;--dsw-alias-label-primary:#1b1f27;--dsw-alias-label-secondary:#6b7280;--dsw-alias-label-tertiary:#a3a9b3;--dsw-alias-interactive-bg-hover:#f4f6f8;--dsw-static-neutral-200:#e3e6ea;--dsw-radius-xl:14px;--vig-page:#f7f8fa`;

const cell = (glyph, title, description) => `
	<div class="${classMap.entryCell}">
		<button type="button" class="${classMap.entry}" data-sidebar-right-guide-entry="preview">
			<span class="${classMap.entryIcon}">${glyph}</span>
			<span class="${classMap.entryText}">
				<span class="${classMap.entryTitle}">${title}</span>
				${description ? `<span class="${classMap.entryDescription}">${description}</span>` : ""}
			</span>
		</button>
	</div>`;

const body = `
	<div class="${classMap.guide}" data-sidebar-right-guide>
		<span class="${classMap.hero}">${icon("spark", 56)}</span>
		${cell(icon("external", 26), "工作区文件", "浏览会话工作区的文件")}
		${cell(icon("grid", 26), "新建终端", "在会话工作区运行命令")}
		${cell(icon("chat", 26), "浏览器", "浏览网页")}
		${cell(icon("spark", 26), "生图工作台", "对话生图 · 图库 · 供应商")}
	</div>`;

const page = `<!doctype html>
<html lang="zh-CN"${theme === "dark" ? ' data-ds-dark-theme="true"' : ""}><head><meta charset="utf-8"><title>右侧栏开始页</title>
<style>
	:root{${tokens}}
	html,body{margin:0;background:var(--vig-page);font-family:"Segoe UI","Microsoft YaHei",system-ui,sans-serif}
	.column{width:${WIDTH}px;min-height:520px;padding:14px;box-sizing:border-box;display:flex;background:var(--vig-page)}
	.column>div{flex:1}
	${guideCss}
</style></head>
<body${theme === "dark" ? ' data-ds-dark-theme' : ""}><div class="column">${body}</div></body></html>`;

mkdirSync(OUT, { recursive: true });
const file = path.join(OUT, `rightbar-guide${theme === "dark" ? "-dark" : ""}.html`);
writeFileSync(file, page, "utf8");
console.log(`  html  ${path.basename(file)}`);

if (!existsSync(CHROME)) {
  console.log(`  chrome 未找到，跳过截图：${CHROME}`);
} else {
  const png = path.join(OUT, `rightbar-guide${theme === "dark" ? "-dark" : ""}.png`);
  execFileSync(
    CHROME,
    [
      "--headless=new",
      "--disable-gpu",
      "--hide-scrollbars",
      "--force-device-scale-factor=2",
      "--window-size=" + WIDTH + ",520",
      `--screenshot=${png}`,
      `file:///${file.replace(/\\/g, "/")}`
    ],
    { stdio: "ignore" }
  );
  console.log(`  png   ${path.basename(png)}`);
}
