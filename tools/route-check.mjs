// dsh-plugin-velapi-image-go —— 「模型属于谁就打到谁那儿」真机回归
//
// 报障：供应商里有 grok（api.velapi.cc）和 GPT（gank.velapi.cc）两条链，模型选了
// GPT 的 gpt-image-2.5-c，但生成请求打到了 grok 的 baseUrl，回
//   503 No available channel for model gpt-image-2.5-c under group grok
// 根因：请求里只带了「当前供应商」（还停在 grok / 甚至是空的），没有任何地方按模型选路，
// 宿主于是回落到列表里第一个供应商。
//
// 这个脚本在真 Chrome 里挂真的 Workbench，假宿主记下每一次 POST /config 与 /generate：
//   1. 用户那种状态（默认模型是 GPT 的、当前供应商空着）点生成 → providerId 必须是 GPT；
//   2. 模型下拉里每条都标出归属供应商（GPT / grok）；
//   3. 选 grok 的模型 → 顺手把当前供应商切到 grok，下一次生成也发给 grok；
//   4. 再选回 GPT 的模型 → 又切回 GPT，生成发给 GPT。
//
//   node tools/route-check.mjs

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

/* 驱动脚本：别用反引号 / ${}（整段是模板字符串），要拼就用 + */
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
		if (hit) return hit;
		await wait(40);
	}
	return predicate();
};

const PROVIDERS = [
	{ id: "pv_grok", name: "grok", enabled: true, baseUrl: "https://api.velapi.cc/v1", models: ["grok-4.6", "grok-imagine-image"], modelMeta: {}, note: "", createdAt: "" },
	{ id: "pv_gpt", name: "GPT", enabled: true, baseUrl: "https://gank.velapi.cc/v1", models: ["gpt-image-2.5-c"], modelMeta: {}, note: "", createdAt: "" }
];
let config = {
	baseUrl: "https://gank.velapi.cc/v1",
	apiKeyEnv: "VELAPI_API_KEY",
	keyMask: "63a••••4008",
	hasKey: true,
	// 用户当前真实状态：模型是 GPT 那条链的，当前供应商还空着
	defaultModel: "gpt-image-2.5-c",
	defaultSize: "1024x1024",
	defaultQuality: "LOW",
	defaultCount: 1,
	activeProviderId: "",
	defaultEndpoint: "auto",
	shortcuts: ""
};
const posts = [];
const json = (payload) => new Response(JSON.stringify(payload), { status: 200, headers: { "content-type": "application/json" } });

window.fetch = async (url, init) => {
	const pathname = String(url).replace("/api/velapi-image-go", "");
	let body = null;
	try { body = typeof init?.body === "string" ? JSON.parse(init.body) : null; } catch (error) { body = null; }
	if (body) posts.push({ path: pathname, body });
	if (pathname === "/status") return json({ ok: true, config: { ...config }, presets: [], counts: {}, protocols: [] });
	if (pathname.startsWith("/config")) {
		config = { ...config, ...body };
		return json({ ok: true, config: { ...config } });
	}
	if (pathname.startsWith("/providers")) return json({ ok: true, items: PROVIDERS });
	if (pathname.startsWith("/generate")) {
		return json({
			ok: true,
			job: { id: "job_" + posts.length, status: "succeeded", prompt: body?.prompt ?? "", model: body?.model ?? "", size: "1024x1024", protocol: body?.endpoint ?? "auto", createdAt: new Date().toISOString(), images: [] },
			queue: 0
		});
	}
	if (pathname.startsWith("/job")) {
		const id = decodeURIComponent((pathname.split("id=")[1] || "").split("&")[0]);
		return json({ ok: true, job: { id: id, status: "succeeded", images: [] } });
	}
	if (pathname.startsWith("/library")) return json({ ok: true, items: [], total: 0, models: [] });
	if (pathname.startsWith("/notes")) return json({ ok: true, items: [] });
	if (pathname.startsWith("/jobs")) return json({ ok: true, items: [], pending: 0 });
	if (pathname.startsWith("/presets")) return json({ ok: true, items: [] });
	return json({ ok: true });
};

const host = document.createElement("div");
host.style.cssText = "width:1000px;height:760px";
document.body.append(host);
const root = createRoot(host);
flushSync(() => root.render(React.createElement(ui.Workbench, { onOpenInRightbar: () => {} })));

const input = await waitFor(() => host.querySelector("textarea.vig-input"), 5000);
check("工作台挂起来了，输入框在", Boolean(input), input ? "" : "没有 textarea.vig-input");

const setNative = (element, value, proto) => {
	const setter = Object.getOwnPropertyDescriptor(proto, "value").set;
	setter.call(element, value);
	element.dispatchEvent(new Event("input", { bubbles: true }));
};
const generatePosts = () => posts.filter((item) => item.path.startsWith("/generate"));
const configPosts = () => posts.filter((item) => item.path.startsWith("/config"));

const sendPrompt = async (text) => {
	const area = host.querySelector("textarea.vig-input");
	flushSync(() => setNative(area, text, window.HTMLTextAreaElement.prototype));
	await wait(120);
	const send = host.querySelector("button.vig-send");
	flushSync(() => send.dispatchEvent(new MouseEvent("click", { bubbles: true })));
	// 等这一轮跑完（按钮上的转圈消失）再发下一次，不然按钮是 disabled 的
	await waitFor(() => !host.querySelector(".vig-send .vig-spin"), 5000);
	await wait(250);
	return generatePosts()[generatePosts().length - 1];
};

/* 1) 用户那种状态：模型是 GPT 的、当前供应商空着 —— 点生成就该发给 GPT */
const first = await sendPrompt("模型属于谁就打到谁那儿");
check(
	"生成：当前供应商空着、模型是 GPT 的 → providerId 发的是 GPT",
	first?.body?.providerId === "pv_gpt" && first?.body?.model === "gpt-image-2.5-c",
	JSON.stringify(first?.body ?? null)
);

/* 2) 模型下拉里每条都标出归属供应商 */
flushSync(() => host.querySelector("button.vig-pick").dispatchEvent(new MouseEvent("click", { bubbles: true })));
const opened = await waitFor(() => host.querySelector(".vig-pop"), 2000);
await wait(120);
const tags = Array.from(host.querySelectorAll(".vig-pop-item .vig-tag")).map((node) => node.textContent);
const titles = Array.from(host.querySelectorAll(".vig-pop-item")).map((node) => node.getAttribute("title"));
check("模型下拉展开", Boolean(opened), opened ? "" : "没有 .vig-pop");
check("每条模型都标出归属供应商（GPT / grok 都在）", tags.includes("GPT") && tags.includes("grok"), JSON.stringify(tags));
check("选项 title 里也带归属（gpt-image-2.5-c · GPT）", titles.some((text) => text === "gpt-image-2.5-c · GPT"), JSON.stringify(titles));

const pickModel = async (model) => {
	const button = host.querySelector("button.vig-pick");
	if (!host.querySelector(".vig-pop")) flushSync(() => button.dispatchEvent(new MouseEvent("click", { bubbles: true })));
	const item = await waitFor(() => {
		const spans = Array.from(host.querySelectorAll(".vig-pop-item-text"));
		const hit = spans.find((node) => node.textContent === model);
		return hit ? hit.closest("button.vig-pop-item") : null;
	}, 2500);
	if (!item) return false;
	flushSync(() => item.dispatchEvent(new MouseEvent("click", { bubbles: true })));
	await wait(400);
	return true;
};

/* 3) 选 grok 的模型 → 当前供应商跟着切，下一次生成也发给 grok */
const pickedGrok = await pickModel("grok-imagine-image");
const grokConfig = configPosts()[configPosts().length - 1];
check("选 grok 的模型：下拉里点得到它", pickedGrok, pickedGrok ? "" : "没找到 grok-imagine-image 那一项");
check(
	"选 grok 的模型：POST /config 顺手把当前供应商切到 grok",
	grokConfig?.body?.defaultModel === "grok-imagine-image" && grokConfig?.body?.activeProviderId === "pv_grok",
	JSON.stringify(grokConfig?.body ?? null)
);
const grokSend = await sendPrompt("grok 的模型走 grok");
check(
	"生成：模型是 grok 的 → providerId 发的是 grok",
	grokSend?.body?.providerId === "pv_grok" && grokSend?.body?.model === "grok-imagine-image",
	JSON.stringify(grokSend?.body ?? null)
);

/* 4) 再选回 GPT 的模型 → 又切回 GPT */
const pickedGpt = await pickModel("gpt-image-2.5-c");
const gptConfig = configPosts()[configPosts().length - 1];
check("选回 GPT 的模型：下拉里点得到它", pickedGpt, pickedGpt ? "" : "没找到 gpt-image-2.5-c 那一项");
check(
	"选回 GPT 的模型：当前供应商跟着切回 GPT",
	gptConfig?.body?.defaultModel === "gpt-image-2.5-c" && gptConfig?.body?.activeProviderId === "pv_gpt",
	JSON.stringify(gptConfig?.body ?? null)
);
const gptSend = await sendPrompt("GPT 的模型走 GPT");
check(
	"生成：模型是 GPT 的 → providerId 发的是 GPT（不是上一条）",
	gptSend?.body?.providerId === "pv_gpt" && gptSend?.body?.model === "gpt-image-2.5-c",
	JSON.stringify(gptSend?.body ?? null)
);

const pre = document.createElement("pre");
pre.id = "vig-route-out";
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

const html = `<!doctype html><html><head><meta charset="utf-8"><title>route-check</title>
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
	pre.id = "vig-route-out";
	pre.textContent = JSON.stringify({ results: [{ name: "驱动脚本异常", pass: false, detail: String((error && error.stack) || error) }] });
	document.body.appendChild(pre);
}
})();
</script>
</body></html>`;

const page = path.join(mkdtempSync(path.join(os.tmpdir(), "vig-route-")), "route.html");
writeFileSync(page, html, "utf8");

if (!existsSync(CHROME)) {
  console.log(`chrome 未找到：${CHROME}`);
  process.exit(1);
}

const dom = execFileSync(CHROME, ["--headless=new", "--disable-gpu", "--no-sandbox", "--virtual-time-budget=12000", "--dump-dom", `file:///${page.replace(/\\/g, "/")}`], {
  encoding: "utf8",
  maxBuffer: 64 * 1024 * 1024
});

const match = dom.match(/<pre id="vig-route-out">([\s\S]*?)<\/pre>/);
if (!match) {
  console.log("没拿到结果节点。标题里可能有线索：");
  console.log((dom.match(/<title>([\s\S]*?)<\/title>/) || [])[1] || "(无标题)");
  process.exit(1);
}
const decode = (text) => text.replace(/&quot;/g, '"').replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&#39;/g, "'");
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
console.log(`\n真机模型选路 ${pass}/${pass + fail} 通过`);
process.exitCode = fail === 0 ? 0 : 1;
