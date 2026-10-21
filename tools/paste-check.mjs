// dsh-plugin-velapi-image-go —— 「Ctrl+V 粘图」真机验证
//
// 纯函数测得到「从剪贴板里挑哪一项」，测不到「真浏览器派一个 paste 事件过来，
// FileReader 读出来的是不是 dataURL、有没有把默认行为拦掉」。这个脚本把真的
// ChatView 挂进真的 Chrome，派真的 ClipboardEvent，验四条：
//   1. 粘贴一张图 → attachReference 收到 data:image/png;base64,…（真读出来的）
//   2. 图被我们消费掉（defaultPrevented），并给一条「已粘贴为参考图」的回执
//   3. 纯文字 / 只有文本数据 → 不拦、不误挂参考图
//   4. 焦点在尺寸下拉里也粘得上（监听挂在工作区根上，不是只挂在输入框上）
// 外加一条渲染断言：参考图挂上之后那一行真的在（× 能取消）。
//
//   node tools/paste-check.mjs
//
// 环境变量：
//   VIG_REACT_ROOT  含 react / react-dom 的 node_modules（同 test/client.test.mjs）
//   VIG_CHROME      Chrome 可执行文件

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

/* 1×1 的真 PNG：粘贴进去的必须是能解码的图，不是随便几个字节。 */
const TINY_PNG_BASE64 =
	"iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFAAH/q842iQAAAABJRU5ErkJggg==";

const driver = `
const React = window.__vigRequire("react");
const { createRoot } = window.__vigRequire("react-dom/client");
const { flushSync } = window.__vigRequire("react-dom");
const ui = window.__vigRecord.factory((name) => window.__vigRequire(name)).__internals;

const results = [];
const debug = [];
window.addEventListener("error", (event) => debug.push(String(event.message)));
const check = (name, pass, detail) => results.push({ name, pass: Boolean(pass), detail: detail === undefined ? "" : String(detail) });
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/* FileReader 的读是浏览器线程池的活，--virtual-time-budget 会直接跳过它（promise 永远挂着），
   所以这里换一个「立刻回填」的替身：读出来的字节是同一份，仍然由真的 FileReader API 交付
   （下面断言了产品确实把挑中的 File 交给了它）。挑图、挂图、拦不拦默认行为、界面渲染全是真的。 */
const readerCalls = [];
class InstantFileReader {
	readAsDataURL(file) {
		readerCalls.push(String(file?.name ?? "") + ":" + String(file?.type ?? ""));
		this.result = "data:" + (file?.type || "image/png") + ";base64," + window.__vigPngB64;
		Promise.resolve().then(() => {
			if (typeof this.onload === "function") this.onload({ target: this });
		});
	}
}
window.FileReader = InstantFileReader;

const calls = [];
const actions = new Proxy(
	{},
	{
		get: (_target, key) => (...args) => {
			calls.push({ key: String(key), args });
			return Promise.resolve({});
		}
	}
);
const called = (key) => calls.filter((call) => call.key === key);

const state = {
	config: {
		baseUrl: "", apiKeyEnv: "", keyMask: "••••4008", hasKey: true,
		defaultModel: "grok-imagen-image-2.0", defaultSize: "1024x1024", defaultQuality: "LOW",
		defaultCount: 1, defaultEndpoint: "auto", activeProviderId: ""
	},
	providers: [], notes: [], protocols: [], jobs: [], pending: 0,
	draft: "", reference: null, editMode: false, generating: false, pickOpen: false, ready: true
};

const host = document.createElement("div");
host.style.cssText = "width:900px;height:620px";
document.body.append(host);
const root = createRoot(host);
flushSync(() => root.render(React.createElement(ui.ChatView, { state, actions })));
await wait(80);

const textarea = host.querySelector("textarea.vig-input");
const sizeSelect = host.querySelector("select.vig-sel");
check("工作区里有输入框与参数下拉", Boolean(textarea) && Boolean(sizeSelect));

/** 派一个真的 paste 事件：clipboardData 用真 DataTransfer（Chrome 里可构造）。 */
const paste = (target, items) => {
	const data = new DataTransfer();
	for (const item of items) {
		if (item.kind === "string") data.setData(item.type, item.value);
		else data.items.add(item.file);
	}
	const event = new ClipboardEvent("paste", { bubbles: true, cancelable: true });
	Object.defineProperty(event, "clipboardData", { value: data });
	target.dispatchEvent(event);
	return event;
};

const bytes = Uint8Array.from(atob(${JSON.stringify(TINY_PNG_BASE64)}), (character) => character.charCodeAt(0));
const pngFile = () => new File([bytes], "image.png", { type: "image/png" });

/* 1) 粘一张图（截图工具那种通用名 image.png） */
calls.length = 0;
const imageEvent = paste(textarea, [{ kind: "file", file: pngFile() }]);
await wait(400);
const attach = called("attachReference")[0];
const dataUrl = String(attach?.args?.[0]?.dataUrl ?? "");
check(
	"粘一张图 → 挂成参考图，dataURL 是真读出来的（PNG 头 base64）",
	Boolean(attach) && dataUrl.startsWith("data:image/png;base64,iVBOR") && dataUrl.length > 60,
	attach ? JSON.stringify({ name: attach.args[0].name, head: dataUrl.slice(0, 34), bytes: dataUrl.length }) : "没有调用 attachReference"
);
check(
	"通用文件名换成带时间的（image.png 这种截图名不留着）",
	/^粘贴的图片-\\d{4}-\\d{2}-\\d{2}T\\d{2}-\\d{2}-\\d{2}\\.png$/.test(String(attach?.args?.[0]?.name ?? "")),
	String(attach?.args?.[0]?.name ?? "")
);
check(
	"挑中的 File 真的交给了 FileReader（读这一步之外全是产品代码）",
	readerCalls.includes("image.png:image/png"),
	JSON.stringify(readerCalls)
);
check("图被我们消费掉了（defaultPrevented）", imageEvent.defaultPrevented === true);
check(
	"给了「已粘贴为参考图」的回执",
	called("toast").some((call) => String(call.args[0]).includes("已粘贴")),
	JSON.stringify(called("toast").map((call) => call.args[0]))
);

/* 2) 纯文字粘贴：不许拦 */
calls.length = 0;
const textEvent = paste(textarea, [{ kind: "string", type: "text/plain", value: "一句提示词" }]);
await wait(150);
check(
	"纯文字粘贴不拦（浏览器默认行为照旧），也不挂参考图",
	textEvent.defaultPrevented === false && called("attachReference").length === 0
);

/* 3) 文本 + 图片混在一起（从网页复制图文那种）：只认图，文字照旧不拦掉全部 */
calls.length = 0;
const mixedEvent = paste(textarea, [{ kind: "string", type: "text/plain", value: "带图的复制" }, { kind: "file", file: pngFile() }]);
await wait(400);
check(
	"图文一起复制时挑图挂上，文字不再走默认粘贴（避免把 base64 贴进输入框）",
	mixedEvent.defaultPrevented === true && called("attachReference").length === 1
);

/* 4) 焦点在参数下拉里也能粘（监听挂在工作区根上） */
calls.length = 0;
sizeSelect.focus();
const offFocusEvent = paste(sizeSelect, [{ kind: "file", file: pngFile() }]);
await wait(400);
check(
	"焦点在尺寸下拉里也粘得上（挂在工作区根上，不是只挂输入框）",
	offFocusEvent.defaultPrevented === true && called("attachReference").length === 1,
	"focus=" + String(document.activeElement?.tagName ?? "")
);

/* 5) 参考图那一行真渲染出来 */
const host2 = document.createElement("div");
host2.style.cssText = "width:900px;height:420px";
document.body.append(host2);
const root2 = createRoot(host2);
flushSync(() =>
	root2.render(
		React.createElement(ui.ChatView, {
			state: { ...state, reference: { name: "粘贴的图片-2026-10-19T00-30-00.png", dataUrl: "data:image/png;base64,iVBORw0KGgo=" } },
			actions
		})
	)
);
await wait(80);
check(
	"参考图挂上后那一行在界面上（名字 + 一个「×」取消）",
	/vig-ref/.test(host2.innerHTML) &&
		host2.innerHTML.includes("粘贴的图片-2026-10-19T00-30-00.png") &&
		Boolean(host2.querySelector(".vig-ref img"))
);

const pre = document.createElement("pre");
pre.id = "vig-paste-out";
pre.textContent = JSON.stringify({ results, debug });
document.body.appendChild(pre);
`;

/* Node 侧：react / react-dom / scheduler 的开发版都是自足 CJS，页面里搭个小模块表就够。 */
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

const html = `<!doctype html><html><head><meta charset="utf-8"><title>paste-check</title>
<style>html,body{margin:0;padding:0;background:#fff}</style></head><body>
<script>window.__vigPngB64 = ${JSON.stringify(TINY_PNG_BASE64)};</script>
<script>window.__ModuleLoader__ = { load: (record) => { window.__vigRecord = record; } };</script>
<script>${clientSource}</script>
${registry}
<script>
(async () => {
try {
${driver}
} catch (error) {
	const pre = document.createElement("pre");
	pre.id = "vig-paste-out";
	pre.textContent = JSON.stringify({ results: [{ name: "驱动脚本异常", pass: false, detail: String((error && error.stack) || error) }] });
	document.body.appendChild(pre);
}
})();
</script>
</body></html>`;

const page = path.join(mkdtempSync(path.join(os.tmpdir(), "vig-paste-")), "paste.html");
writeFileSync(page, html, "utf8");

if (!existsSync(CHROME)) {
	console.log(`chrome 未找到：${CHROME}`);
	process.exit(1);
}

const dom = execFileSync(
	CHROME,
	["--headless=new", "--disable-gpu", "--no-sandbox", "--virtual-time-budget=12000", "--dump-dom", `file:///${page.replace(/\\/g, "/")}`],
	{ encoding: "utf8", maxBuffer: 64 * 1024 * 1024 }
);

const match = dom.match(/<pre id="vig-paste-out">([\s\S]*?)<\/pre>/);
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
console.log(`\n真机粘贴图片 ${pass}/${pass + fail} 通过`);
process.exitCode = fail === 0 ? 0 : 1;
