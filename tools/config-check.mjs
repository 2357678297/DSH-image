// dsh-plugin-velapi-image-go —— 「配置改不动」真机回归
//
// 报障：协议下拉选了「图片编辑」，关掉再打开又回到「自动检测」——选不动。
// 根因：宿主那半边（lib/index.js）只有重启后才认识 config.defaultEndpoint。
// 老宿主收到 POST /config 会把不认识的字段丢掉，回一份**没有** defaultEndpoint 的
// config；界面当时是 setConfig(payload.config) 直接覆盖 —— 用户刚选的值被冲回默认。
//
// 这个脚本在真 Chrome 里把真的 Workbench 挂起来，用一层**故意不认 defaultEndpoint**
// 的假 fetch（模拟老宿主）验三件事：
//   1. 选一次协议，界面上必须留住（不被回包冲掉）；
//   2. POST /config 真的带着 defaultEndpoint 发出去了（宿主重启后就能吃到）；
//   3. 本地那份（localStorage）也记下了 —— 老宿主 + 刷新一次，选择照样不丢。
//
//   node tools/config-check.mjs

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
const waitFor = async (predicate, ms) => {
	const end = Date.now() + ms;
	while (Date.now() < end) {
		const hit = predicate();
		if (hit) return hit; // 返回命中的那个东西本身（这里要的是元素，不是 true）
		await wait(40);
	}
	return predicate();
};

/* 假宿主：状态 200、字段齐全，但**故意不带 defaultEndpoint**（老宿主的行为）。 */
const baseConfig = {
	baseUrl: "https://gank.velapi.cc/v1",
	apiKeyEnv: "VELAPI_API_KEY",
	keyMask: "63a••••4008",
	hasKey: true,
	defaultModel: "grok-imagen-image-2.0",
	defaultSize: "1024x1024",
	defaultQuality: "LOW",
	defaultCount: 1,
	activeProviderId: "",
	shortcuts: ""
};
const configPosts = [];
window.fetch = async (url, init) => {
	const path = String(url).replace("/api/velapi-image-go", "");
	const body = typeof init?.body === "string" ? JSON.parse(init.body) : null;
	if (body) configPosts.push({ path, body });
	const json = (payload) => new Response(JSON.stringify(payload), { status: 200, headers: { "content-type": "application/json" } });
	if (path === "/status") return json({ ok: true, config: { ...baseConfig }, presets: [], counts: {}, protocols: [] });
	if (path.startsWith("/config")) return json({ ok: true, config: { ...baseConfig } }); // ← 吞掉 defaultEndpoint
	if (path.startsWith("/providers")) return json({ ok: true, items: [] });
	if (path.startsWith("/library")) return json({ ok: true, items: [], total: 0, models: [] });
	if (path.startsWith("/notes")) return json({ ok: true, items: [] });
	if (path.startsWith("/jobs")) return json({ ok: true, items: [], pending: 0 });
	if (path.startsWith("/presets")) return json({ ok: true, items: [] });
	return json({ ok: true });
};

const host = document.createElement("div");
host.style.cssText = "width:1000px;height:760px";
document.body.append(host);
const root = createRoot(host);
flushSync(() => root.render(React.createElement(ui.Workbench, { onOpenInRightbar: () => {} })));

const select = await waitFor(() => host.querySelector("select.vig-endpoint"), 4000);
check("协议下拉挂起来了", Boolean(select), select ? select.value : "没有 select.vig-endpoint");
check("初始是自动检测", select?.value === "auto", String(select?.value ?? ""));

/* 真的改一次：改 value + 派一个真的 change 事件（React 在 select 上听的就是它） */
const setSelect = (element, value) => {
	element.value = value;
	element.dispatchEvent(new Event("change", { bubbles: true }));
};
flushSync(() => setSelect(select, "images_edits"));
await wait(400);

const after = host.querySelector("select.vig-endpoint");
check(
	"选「图片编辑」之后界面留住它（老宿主回包里没有这个字段，也不许冲掉）",
	after?.value === "images_edits",
	"回包里没有 defaultEndpoint；界面现在=" + String(after?.value ?? "")
);
check(
	"POST /config 真的把 defaultEndpoint 发出去了（宿主重启后就能吃到）",
	configPosts.some((post) => post.path.startsWith("/config") && post.body?.defaultEndpoint === "images_edits"),
	JSON.stringify(configPosts)
);
check(
	"本地也记了一份（老宿主 + 刷新一次，选择照样在）",
	window.localStorage.getItem("dsh.velapi-image-go.endpoint") === "images_edits",
	String(window.localStorage.getItem("dsh.velapi-image-go.endpoint"))
);

/* 再选一次别的，确认不是「只能改一次」 */
const select2 = host.querySelector("select.vig-endpoint");
flushSync(() => setSelect(select2, "videos_generations"));
await wait(400);
const after2 = host.querySelector("select.vig-endpoint");
check("再改成「视频生成」同样留得住", after2?.value === "videos_generations", String(after2?.value ?? ""));

const pre = document.createElement("pre");
pre.id = "vig-config-out";
pre.textContent = JSON.stringify({ results, debug });
document.body.appendChild(pre);
`;

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

const html = `<!doctype html><html><head><meta charset="utf-8"><title>config-check</title>
<style>html,body{margin:0;padding:0;background:#fff}</style></head><body>
<script>window.__ModuleLoader__ = { load: (record) => { window.__vigRecord = record; } };</script>
<script>${clientSource}</script>
${registry}
<script>
(async () => {
try {
${driver}
} catch (error) {
	const pre = document.createElement("pre");
	pre.id = "vig-config-out";
	pre.textContent = JSON.stringify({ results: [{ name: "驱动脚本异常", pass: false, detail: String((error && error.stack) || error) }] });
	document.body.appendChild(pre);
}
})();
</script>
</body></html>`;

const page = path.join(mkdtempSync(path.join(os.tmpdir(), "vig-config-")), "config.html");
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

const match = dom.match(/<pre id="vig-config-out">([\s\S]*?)<\/pre>/);
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
console.log(`\n真机配置改得动 ${pass}/${pass + fail} 通过`);
process.exitCode = fail === 0 ? 0 : 1;
