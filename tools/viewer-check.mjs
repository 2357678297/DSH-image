// dsh-plugin-velapi-image-go —— 真机检查：图片查看器 + 快捷拖拽 + 素材目录设置
//
//   node tools/viewer-check.mjs
//
// 在真 Chrome 里挂真的 Workbench，假宿主负责记录每一次请求：
//   1. 点结果卡图片 → 查看器打开（标题 / 计数 / 提示词 / 动作按钮）；
//   2. → 翻页、滚轮缩放、0 键适应、Esc 关闭；
//   3. 拖起一张图 → dataTransfer 里带自定义类型 / uri-list / DownloadURL；
//   4. 把这坨拖拽数据丢进输入区 → 真走 /upload，挂成参考图；
//   5. 供应商页的「素材目录」块：显示当前目录、保存时 POST /config(stateDir)、打开目录打 /state/reveal。

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
const STATE_DIR = "C:\\Users\\demo\\.dsh\\state\\velapi-image-go";
const NEXT_DIR = "D:\\素材\\velapi";

/* 驱动脚本：别用反引号 / ${}（整段是模板字符串），要拼就用 + */
const driver = `

const React = window.__vigRequire("react");
const { createRoot } = window.__vigRequire("react-dom/client");
const { flushSync } = window.__vigRequire("react-dom");
const ui = window.__vigRecord.factory((name) => window.__vigRequire(name)).__internals;
const style = document.createElement("style");
style.textContent = ui.CSS;
document.head.appendChild(style);

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
const text = (node) => (node ? String(node.textContent || "").trim() : "");

/* ---- 假宿主 ---- */
const PNG = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10, 0, 0, 0, 13, 73, 72, 68, 82, 0, 0, 0, 1, 0, 0, 0, 1, 8, 6, 0, 0, 0, 31, 21, 196, 137, 0, 0, 0, 13, 73, 68, 65, 84, 120, 156, 99, 0, 1, 0, 0, 5, 0, 1, 13, 10, 45, 180, 0, 0, 0, 0, 73, 69, 78, 68, 174, 66, 96, 130]);
/* 用 data URL 当图：真 Chrome 里能直接渲染（不用起服务器），拖拽 / 查看器都照常 */
const ART = (color) =>
	"data:image/svg+xml;utf8," +
	encodeURIComponent("<svg xmlns='http://www.w3.org/2000/svg' width='400' height='400'><rect width='100%' height='100%' fill='" + color + "'/><circle cx='200' cy='200' r='120' fill='#fff'/></svg>");
const IMAGES = [
	{ id: "img_1", assetId: "img_1", name: "cat.png", url: ART("#f0a020"), width: 1024, height: 1024, bytes: 70, model: "gpt-image-2.5-c", size: "1024x1024", prompt: "一只戴眼镜的橘猫" },
	{ id: "img_2", assetId: "img_2", name: "dog.png", url: ART("#4a90d9"), width: 512, height: 512, bytes: 70, model: "nano-banana-2.1", size: "512x512", prompt: "一只柴犬" }
];
const JOB = {
	id: "job_1",
	status: "succeeded",
	mode: "edit",
	prompt: "一只戴眼镜的橘猫",
	model: "gpt-image-2.5-c",
	size: "1024x1024",
	quality: "LOW",
	count: 2,
	protocol: "images_edits",
	endpoint: "/images/edits",
	referenceUrl: "/api/velapi-image-go/upload/up_1.png",
	createdAt: new Date().toISOString(),
	source: "ui",
	images: IMAGES.map((image) => ({ assetId: image.id, name: image.name, url: image.url, width: image.width, height: image.height, bytes: image.bytes }))
};
/* 单图的那一轮：用来量「单图最多占一半宽」 */
const SINGLE_JOB = { ...JOB, id: "job_2", count: 1, prompt: "一只柴犬", images: [JOB.images[1]] };
/* 信息卡：输入框旁的快捷选择用 */
const NOTES = [
	{ id: "note_1", title: "产品主图提示词", prompt: "纯白影棚背景，产品居中 45° 俯拍，柔和顶光", meta: "", tags: ["电商"] },
	{ id: "note_2", title: "封面文案", prompt: "大字标题 + 大量留白，国风工笔", meta: "", tags: ["海报"] }
];
/* 对话（会话）：两个会话，历史互相隔离 */
let conversations = [
	{ id: "conv_default", title: "默认对话", createdAt: "", updatedAt: "", count: 2, lastPrompt: "一只戴眼镜的橘猫" },
	{ id: "conv_old", title: "旧对话", createdAt: "", updatedAt: "", count: 0, lastPrompt: "" }
];
const convJobs = { conv_default: [JOB, SINGLE_JOB], conv_old: [] };
const withConvCounts = () => conversations.map((item) => ({ ...item, count: (convJobs[item.id] || []).length }));
let config = {
	baseUrl: "https://gank.velapi.cc/v1",
	apiKeyEnv: "VELAPI_API_KEY",
	keyMask: "sk-••••yDNa",
	hasKey: true,
	defaultModel: "gpt-image-2.5-c",
	defaultSize: "1024x1024",
	defaultQuality: "LOW",
	defaultCount: 1,
	defaultEndpoint: "auto",
	activeProviderId: "",
	shortcuts: "",
	stateDir: ${JSON.stringify(STATE_DIR)}
};
const providers = [
	{
		id: "pv_grok",
		name: "grok",
		baseUrl: "https://api.velapi.cc/v1",
		enabled: true,
		keyMask: "sk-••••mQcp",
		usesRuntimeKey: false,
		models: ["grok-4.6", "grok-4.7", "grok-imagine-image", "omni-flash", "suno", "wan3.0-video-1080p"],
		// kind 来自中转站目录（image / video / audio / chat）：模型下拉按它过滤
		modelMeta: {
			"grok-4.6": { kind: "chat" },
			// 真实情况：grok 目录不给 kind，grok-4.7（对话模型）只能靠能力关键词认出来
			"grok-4.7": { kind: "" },
			"grok-imagine-image": { kind: "image" },
			"omni-flash": { kind: "video", label: "omni" },
			suno: { kind: "audio" }
		},
		note: "",
		createdAt: ""
	},
	{ id: "pv_gpt", name: "GPT", baseUrl: "https://api.velapi.cc/v1", enabled: true, keyMask: "sk-••••yDNa", usesRuntimeKey: false, models: ["gpt-image-2.5-c"], modelMeta: { "gpt-image-2.5-c": { kind: "image" } }, note: "", createdAt: "" }
];
const posts = [];
const json = (payload) => new Response(JSON.stringify(payload), { status: 200, headers: { "content-type": "application/json" } });
window.fetch = async (url, init) => {
	const raw = String(url);
	const pathname = raw.replace(/^.*?\\/api\\/velapi-image-go/, "");
	const body = (() => {
		try { return typeof init?.body === "string" ? JSON.parse(init.body) : null; } catch (error) { return null; }
	})();
	if (body) posts.push({ path: pathname, body });
	if (pathname.startsWith("/drag/native")) return json({ ok: true, name: body?.file || "" });
	if (pathname.startsWith("/clipboard/image")) return json({ ok: true, name: body?.file || "" });
	if (pathname === "/capabilities") return json({ ok: true, version: "0.1.0", electron: true, nativeDrag: true, clipboard: true });
	if (pathname.includes("/asset/local")) {
		const file = decodeURIComponent(pathname.split("file=")[1] || "");
		return json({ ok: true, path: "C:/x/" + file, fileUrl: "file:///C:/x/" + file });
	}
	if (pathname.includes("/asset/export")) {
		const files = Array.isArray(body?.files) ? body.files : [];
		return json({ ok: true, dir: "C:/x/exports", items: files.map((file) => ({ name: file, path: "C:/x/exports/" + file })) });
	}
	if (pathname.includes("/asset/") || raw.startsWith("data:")) return new Response(PNG, { status: 200, headers: { "content-type": "image/png" } });
	// 验证「选中视频模型 → 参数区跟视频走」：?model=omni-flash 让初始 defaultModel 就是视频模型
	const modelOverride = new URLSearchParams(location.search).get("model");
	if (pathname === "/status" && modelOverride) config = { ...config, defaultModel: modelOverride };
	if (pathname === "/status")
		return json({
			ok: true,
			config: { ...config },
			presets: [],
			counts: {},
			// 协议表：界面按 kind 区分「图片 / 视频」，视频协议用独立尺寸（假宿主也要给全）
			protocols: [
				{ id: "auto", label: "自动检测（默认）", route: "", kind: "auto" },
				{ id: "images_generations", label: "图片生成（/v1/images/generations）", route: "/images/generations", kind: "image" },
				{ id: "images_edits", label: "图片编辑（/v1/images/edits）", route: "/images/edits", kind: "image" },
				{ id: "videos_generations", label: "视频生成（/v1/videos/generations）", route: "/videos/generations", kind: "video" }
			],
			chatModels: [{ id: "mock-chat", providerId: "pv_gpt", providerName: "GPT", label: "mock-chat" }]
		});
	if (pathname === "/conversations") {
		if ((init?.method || "GET").toUpperCase() === "POST") {
			const record = { id: "conv_new", title: "新对话 2", createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() };
			conversations = [record, ...conversations];
			convJobs[record.id] = [];
			return json({ ok: true, item: { ...record, count: 0 }, items: withConvCounts() });
		}
		return json({ ok: true, items: withConvCounts(), defaultId: "conv_default" });
	}
	if (pathname.startsWith("/conversations/rename")) {
		conversations = conversations.map((item) => (item.id === body?.id ? { ...item, title: body?.title || item.title } : item));
		return json({ ok: true, items: withConvCounts() });
	}
	if (pathname.startsWith("/conversations/delete")) {
		conversations = conversations.filter((item) => item.id !== body?.id);
		delete convJobs[body?.id];
		return json({ ok: true, removedJobs: 1, items: withConvCounts() });
	}
	if (pathname.startsWith("/chat/plan")) {
		// 竞态验证：?planddelay=1 时延迟 250ms 并记录并发峰值（串行排队应为 1）
		if (new URLSearchParams(location.search).get("planddelay") === "1") {
			window.__vigPlanActive = (window.__vigPlanActive || 0) + 1;
			window.__vigPlanPeak = Math.max(window.__vigPlanPeak || 0, window.__vigPlanActive);
			await new Promise((resolve) => setTimeout(resolve, 250));
			window.__vigPlanActive -= 1;
		}
		// 上下文模型失效场景：?planfail=1 让 /chat/plan 回 ok:false，验证聊天意图会走 /chat/say 兜底
		if (new URLSearchParams(location.search).get("planfail") === "1") return json({ ok: false, code: "plan_failed", error: "mock plan failure" });
		const userSaid = String(body?.message || "");
		// 聊天优先（和真实 prompt 一致）：问身份/寒暄走 reply，不写提示词
		if (/你是谁|你好|在吗/.test(userSaid)) {
			return json({ ok: true, chatModel: "mock-chat", action: "reply", prompt: "", reply: "我是对话助手（mock）", referenceUrl: "", reason: "用户在聊天" });
		}
		return userSaid.includes("乱搞")
			? json({
					ok: true,
					chatModel: "mock-chat",
					action: "reply",
					prompt: "",
					reply: "抱歉，S3 指的是你参考图里那台扫地机器人；我刚才理解偏了。",
					referenceUrl: "",
					reason: "用户在纠正"
				})
			: json({
					ok: true,
					chatModel: "mock-chat",
					prompt: "一只戴眼镜的橘猫，柔和顶光（由上下文整理）",
					mode: "generate",
					referenceUrl: "",
					reason: "用户嫌上一轮太夸张"
				});
	}
	if (pathname.startsWith("/config")) {
		if (body && typeof body.stateDir === "string") {
			config = { ...config, stateDir: body.stateDir };
			return json({ ok: true, config: { ...config }, stateDir: config.stateDir, moved: { changed: true, copied: { files: 2, indexes: 7 }, stateDir: config.stateDir } });
		}
		// 普通配置写回：把 patch 合进 config（界面靠回包 config 更新；不合并的话切协议不生效）
		if (body && typeof body === "object") config = { ...config, ...body };
		return json({ ok: true, config: { ...config } });
	}
	if (pathname.startsWith("/providers")) return json({ ok: true, items: providers });
	if (pathname.startsWith("/library")) {
		// 截图用：?many=1 时给 12 张，方便看「最近生成」的 2 行折叠效果
		const many = new URLSearchParams(location.search).get("many") === "1";
		const items = many ? Array.from({ length: 12 }, (_, index) => ({ ...IMAGES[index % IMAGES.length], id: "img_many_" + index, name: "gen-" + (index + 1) + ".png" })) : IMAGES;
		return json({ ok: true, items, total: items.length, models: ["gpt-image-2.5-c"] });
	}
	if (pathname.startsWith("/notes")) return json({ ok: true, items: NOTES });
	if (pathname.startsWith("/jobs")) {
		/* 截图用：?order=single 把单图那一轮放前面，方便一次截到两种占比 */
		const order = new URLSearchParams(location.search).get("order");
		const conversationQuery = new URLSearchParams(pathname.split("?")[1] || "").get("conversationId");
		const base = conversationQuery ? convJobs[conversationQuery] || [] : order === "single" ? [SINGLE_JOB, JOB] : [JOB, SINGLE_JOB];
		// 滚动/浮标验证：?many=1 造 20 条（内容远高于一屏）
		const many = new URLSearchParams(location.search).get("many") === "1";
		const items = many
			? Array.from({ length: 20 }, (_, index) => ({ ...base[0], id: "job_many_" + index, createdAt: new Date(Date.now() - index * 60000).toISOString() }))
			: base;
		return json({ ok: true, items, pending: 0 });
	}
	if (pathname.startsWith("/presets")) return json({ ok: true, items: [] });
	if ((init?.method || "GET").toUpperCase() === "GET" && pathname.startsWith("/upload/")) {
		// 参考图字节：一张真的 1x1 PNG，给「编辑 → 补字节」用例取回
		const TINY_PNG = Uint8Array.from(atob("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=="), (ch) => ch.charCodeAt(0));
		return new Response(TINY_PNG, { status: 200, headers: { "content-type": "image/png" } });
	}
	if (pathname.startsWith("/upload")) return json({ ok: true, item: { url: "/api/velapi-image-go/upload/up_1.png" } });
	if (pathname.startsWith("/job/delete")) return json({ ok: true, removed: (body?.ids || []).length });
	if (pathname.startsWith("/chat/agent")) {
		// 模拟真实延迟：让「思考中」占位有时间被断言到
		await new Promise((resolve) => setTimeout(resolve, 300));
		const said = String(body?.message || "");
		const wantImage = /画|生成一张|出图/.test(said);
		return json({
			ok: true,
			reply: wantImage ? "图已经生成好了（mock）。" : "我是对话助手（mock）：你问的是「" + said + "」",
			images: wantImage ? [{ url: "/api/velapi-image-go/asset/mock_agent_1.png", width: 1024, height: 1024 }] : [],
			toolCalls: wantImage ? [{ name: "generate_image" }] : [],
			chatModel: "mock-chat"
		});
	}
	if (pathname.startsWith("/chat/say")) {
		return json({
			ok: true,
			job: {
				id: "msg_say_1",
				kind: "reply",
				status: "succeeded",
				mode: "chat",
				prompt: body?.message ?? "",
				userText: body?.message ?? "",
				reply: "我是对话助手（mock）：你问的是「" + (body?.message ?? "") + "」",
				model: body?.chatModel ?? "mock-chat",
				images: [],
				createdAt: new Date().toISOString()
			}
		});
	}
	if (pathname.startsWith("/chat/message")) {
		return json({
			ok: true,
			job: {
				id: "msg_1",
				kind: "reply",
				status: "succeeded",
				mode: "chat",
				prompt: body?.message ?? "",
				userText: body?.message ?? "",
				reply: body?.reply ?? "",
				model: body?.chatModel ?? "mock-chat",
				images: [],
				createdAt: new Date().toISOString()
			}
		});
	}
	if (pathname.startsWith("/generate")) {
		return json({
			ok: true,
			job: {
				id: "job_new",
				status: "queued",
				prompt: body?.prompt ?? "",
				userText: body?.userText ?? "",
				planNote: body?.planNote ?? "",
				conversationId: body?.conversationId ?? "",
				model: "m",
				size: "1024x1024",
				quality: "LOW",
				count: 1,
				mode: body?.mode ?? "generate",
				protocol: "auto",
				referenceUrl: body?.referenceUrl ?? "",
				referenceUrls: Array.isArray(body?.referenceUrls) ? body.referenceUrls : [],
				createdAt: new Date().toISOString()
			},
			queue: 1
		});
	}
	if (pathname.startsWith("/job")) return json({ ok: true, job: JOB });
	if (pathname.startsWith("/models")) return json({ ok: true, items: [], models: [] });
	if (pathname.startsWith("/update/check")) {
		const behind = new URLSearchParams(location.search).get("behind") === "1";
		return json(
			behind
				? { ok: true, latest: false, available: true, code: "behind", version: "0.1.0", localSha: "1111111", remoteSha: "2222222", short: { local: "1111111", remote: "2222222" }, hint: "远端有更新：2222222（更新后需重启 DSH）" }
				: { ok: true, latest: true, code: "latest", version: "0.1.0", localSha: "1111111", remoteSha: "1111111", short: { local: "1111111", remote: "1111111" }, hint: "已是最新（1111111）" }
		);
	}
	if (pathname.startsWith("/update/apply")) return json({ ok: true, pulled: true, code: "applied", needsRestart: true, from: "1111111", to: "2222222", short: { from: "1111111", to: "2222222" }, hint: "已更新到 2222222，重启 DSH 生效" });
	if (pathname.startsWith("/update/restart")) return json({ ok: true, restarting: true, delaySeconds: 15, hint: "15 秒后重启" });
	return json({ ok: true });
};

const host = document.createElement("div");
host.style.cssText = "width:1020px;height:780px";
document.body.append(host);
const root = createRoot(host);
flushSync(() => root.render(React.createElement(ui.Workbench, { onOpenInRightbar: () => {} })));

/* ---- 1. 点结果卡图片打开查看器 ---- */
// 聊天流现在是「老的在上、新的在下」，第一张可能是单图那轮（没有翻页箭头）：
// 专门点两张图那一轮里的图，后面的翻页用例才有对象。
const shot = await waitFor(() => host.querySelector(".vig-grid.is-duo .vig-shot-img") ?? host.querySelector(".vig-shot-img"), 6000);
check("结果卡挂起来了（有可点的图）", Boolean(shot), shot ? "" : "没有 .vig-shot-img");

/* ---- 结果图按张数给画面占比：单图最多一半宽，两张收敛 ---- */
const singleGrid = host.querySelector(".vig-grid.is-single");
const duoGrid = host.querySelector(".vig-grid.is-duo");
const ratioOf = (grid) => {
	const card = grid ? grid.querySelector(".vig-shot") : null;
	const box = grid ? grid.getBoundingClientRect().width : 0;
	return card && box > 0 ? card.getBoundingClientRect().width / box : 0;
};
/* many=1 时 20 条全是双图任务：单图占比断言不适用，跳过 */
if (new URLSearchParams(location.search).get("many") !== "1") {
	check(
		"结果图尺寸：单图约一半宽（0.44~0.54），两张收敛到三成六（0.3~0.42）",
		Boolean(singleGrid) && Boolean(duoGrid) && ratioOf(singleGrid) >= 0.44 && ratioOf(singleGrid) <= 0.54 && ratioOf(duoGrid) >= 0.3 && ratioOf(duoGrid) <= 0.42,
		JSON.stringify({ single: ratioOf(singleGrid).toFixed(3), duo: ratioOf(duoGrid).toFixed(3) })
	);
}
/* ---- 右侧检查器折叠（图片 / 预设卡 / 供应商那一列） ---- */
{
	const side = host.querySelector("aside.vig-side");
	const wideWidth = side ? side.getBoundingClientRect().width : 0;
	const fold = host.querySelector(".vig-side-head .vig-icon-btn");
	flushSync(() => fold.dispatchEvent(new MouseEvent("click", { bubbles: true })));
	await wait(180);
	const collapsed = host.querySelector("aside.vig-side.is-collapsed");
	const collapsedWidth = collapsed ? collapsed.getBoundingClientRect().width : 0;
	const opener = host.querySelector(".vig-side-open");
	flushSync(() => opener.dispatchEvent(new MouseEvent("click", { bubbles: true })));
	await wait(180);
	const reopened = host.querySelector("aside.vig-side:not(.is-collapsed)");
	const reopenedWidth = reopened ? reopened.getBoundingClientRect().width : 0;
	check(
		"右侧检查器可折叠：展开约 268px → 收起成 <50px 窄签 → 点一下又回来",
		wideWidth > 200 && collapsedWidth > 0 && collapsedWidth < 50 && Boolean(opener) && reopenedWidth > 200,
		JSON.stringify({ wideWidth, collapsedWidth, reopenedWidth })
	);
}
/* ---- 尺寸下拉：先给比例，选中后把像素写进配置（选了视频模型时这里变视频参数，跳过） ---- */
if (!new URLSearchParams(location.search).get("model")) {
	const sizeSelect = host.querySelector(".vig-tools select.vig-sel");
	const optionLabels = sizeSelect ? Array.from(sizeSelect.options).map((option) => text(option)) : [];
	const optionTitles = sizeSelect ? Array.from(sizeSelect.options).map((option) => option.getAttribute("title") || "") : [];
	flushSync(() => {
		const setter = Object.getOwnPropertyDescriptor(window.HTMLSelectElement.prototype, "value").set;
		setter.call(sizeSelect, "1536x864");
		sizeSelect.dispatchEvent(new Event("change", { bubbles: true }));
	});
	await wait(300);
	const sizePost = posts.filter((item) => item.path.startsWith("/config") && item.body && item.body.defaultSize).pop();
	check(
		"尺寸下拉同时给比例与分辨率（1:1 · 1024×1024 / 16:9 · 1536×864），选中的像素写进 config",
		optionLabels.includes("1:1 · 1024×1024") &&
			optionLabels.includes("16:9 · 1536×864") &&
			Boolean(sizePost) &&
			sizePost.body.defaultSize === "1536x864",
		JSON.stringify({ first: optionLabels.slice(0, 3), size: sizePost ? sizePost.body.defaultSize : null })
	);
}
/* 截图入口：?hold=library|notes|ps|providers 先切到那一页再停下（UI 审计/对比截图用） */
{
	const holdView = new URLSearchParams(location.search).get("hold");
	const viewNavText = { library: "图片管理", notes: "信息管理", ps: "图片处理", providers: "供应商管理" }[holdView];
	if (viewNavText) {
		const navItem = Array.from(host.querySelectorAll(".vig-nav-item")).find((node) => text(node).includes(viewNavText));
		if (navItem) {
			flushSync(() => navItem.dispatchEvent(new MouseEvent("click", { bubbles: true })));
			await wait(600);
		}
		// 图片处理：&ps=load 先从「最近生成」点一张当底图，验证底部图层控制条
		const psMode = new URLSearchParams(location.search).get("ps");
		if (holdView === "ps" && (psMode === "load" || psMode === "select")) {
			const tile = await waitFor(() => host.querySelector(".vig-ps-recent-tile"), 5000);
			if (tile) {
				flushSync(() => tile.dispatchEvent(new MouseEvent("click", { bubbles: true })));
				await wait(1200);
			}
			const bar = host.querySelector(".vig-ps-layerbar");
			check(
				"图层控制条：载入底图后出现在画布下方（底图 chip + 加层按钮）",
				Boolean(bar) && Boolean(bar.querySelector(".vig-ps-chip.is-base")) && Boolean(bar.querySelector(".vig-ps-chip.is-add")),
				JSON.stringify({ bar: Boolean(bar) })
			);
			// 应用一次调整（默认应该新建图层）：打开「调整」浮窗 → 改亮度 → 应用
			const adjustBtn = Array.from(host.querySelectorAll(".vig-ps-tool")).find((node) => String(node.getAttribute("title") || "").includes("调整"));
			if (adjustBtn) {
				flushSync(() => adjustBtn.dispatchEvent(new MouseEvent("click", { bubbles: true })));
				await wait(300);
				const applyBtn = Array.from(host.querySelectorAll("button")).find((node) => /应用|Apply/.test(text(node)));
				if (applyBtn) {
					flushSync(() => applyBtn.dispatchEvent(new MouseEvent("click", { bubbles: true })));
					await wait(500);
				}
			}
			const barRect = host.querySelector(".vig-ps-layerbar")?.getBoundingClientRect();
			check(
				"控制条位置：在画布下方、横向铺开（不被挤到角落）",
				Boolean(barRect) && barRect.width > 200 && barRect.height > 40,
				JSON.stringify(barRect ? { x: Math.round(barRect.x), y: Math.round(barRect.y), w: Math.round(barRect.width), h: Math.round(barRect.height) } : null)
			);
			const barNow = host.querySelector(".vig-ps-layerbar");
			check(
				"控制条父级 / grid 定位",
				Boolean(barNow),
				JSON.stringify({ parent: barNow?.parentElement?.className ?? "", gridColumn: barNow ? getComputedStyle(barNow).gridColumn : "", display: barNow ? getComputedStyle(barNow).display : "", parentDisplay: barNow?.parentElement ? getComputedStyle(barNow.parentElement).display : "" })
			);
			const chips = host.querySelectorAll(".vig-ps-chip").length;
			check("所有改动默认新图层：应用一次调整后控制条多一层", chips >= 3, JSON.stringify({ chips }));
			// 选中刚生成的图层：属性条应出现（模式 / 不透明度 / 顺序 / 蒙版 / 编辑 / 删除）
			const layerChip = host.querySelectorAll(".vig-ps-chip:not(.is-base):not(.is-add)")[0];
			if (layerChip) {
				flushSync(() => layerChip.dispatchEvent(new MouseEvent("click", { bubbles: true })));
				await wait(300);
			}
			// 截图用：把控制条滚进视口（stage 很高时它在下面）
			if (psMode === "select") {
				const barEl = host.querySelector(".vig-ps-layerbar");
				if (barEl) {
					flushSync(() => barEl.scrollIntoView({ block: "end" }));
					await wait(300);
				}
			}
			const props = host.querySelector(".vig-ps-chipprops");
			check(
				"图层可选中：点中后控制条出现属性条（模式/不透明度/顺序/蒙版/删除）",
				Boolean(props) && Boolean(props.querySelector(".vig-ps-layer-mode")) && Boolean(props.querySelector(".vig-ps-layer-opacity")) && props.querySelectorAll(".vig-ps-layer-mini").length >= 4,
				JSON.stringify({ props: Boolean(props), minis: props ? props.querySelectorAll(".vig-ps-layer-mini").length : 0 })
			);
			// 删除：点最后一个 danger 迷你按钮，图层应消失
			const removeBtn = psMode === "load" && props ? props.querySelector(".vig-ps-layer-mini.is-danger") : null;
			if (removeBtn) {
				flushSync(() => removeBtn.dispatchEvent(new MouseEvent("click", { bubbles: true })));
				await wait(300);
				check("图层可删除：删掉后控制条不再有该层", host.querySelectorAll(".vig-ps-chip:not(.is-base):not(.is-add)").length === 0, JSON.stringify({ chips: host.querySelectorAll(".vig-ps-chip").length }));
			}
		}
		// 透视矫正面板：限宽（长提示不该把浮层撑成一大块）
		if (holdView === "ps" && new URLSearchParams(location.search).get("ps") === "load") {
			const warpToolBtn = Array.from(host.querySelectorAll(".vig-ps-tool")).find((node) => String(node.getAttribute("title") || "").includes("透视矫正"));
			if (warpToolBtn) {
				flushSync(() => warpToolBtn.dispatchEvent(new MouseEvent("click", { bubbles: true })));
				await wait(400);
			}
			const params = host.querySelector(".vig-ps-params");
			check(
				"透视面板限宽（不撑成畸形大块）",
				Boolean(params) && params.offsetWidth > 0 && params.offsetWidth <= 360,
				JSON.stringify({ w: params ? params.offsetWidth : 0 })
			);
		}
		// 图库布局密度：&density=compact|standard|large（截图/审计用）
		const densityText = { compact: "小图", standard: "标准", large: "大图" }[new URLSearchParams(location.search).get("density")];
		if (densityText) {
			const densityBtn = Array.from(host.querySelectorAll(".vig-density-btn")).find((node) => text(node) === densityText);
			if (densityBtn) {
				flushSync(() => densityBtn.dispatchEvent(new MouseEvent("click", { bubbles: true })));
				await wait(500);
			}
		}
		// 图库视图：&mode=stage 切到「上方固定大图 + 下方缩略条」
		if (new URLSearchParams(location.search).get("mode") === "stage") {
			const stageBtn = Array.from(host.querySelectorAll(".vig-viewmode-btn")).find((node) => String(node.getAttribute("title") || "") === "大图");
			if (stageBtn) {
				flushSync(() => stageBtn.dispatchEvent(new MouseEvent("click", { bubbles: true })));
				await wait(500);
			}
			// 左右隐藏箭头 + 滚轮节流切图（连滚两下只切一张）
			const navCount = host.querySelectorAll(".vig-stage-nav").length;
			const stageMain = host.querySelector(".vig-stage-main");
			const before = text(host.querySelector(".vig-count"));
			const activeBefore = host.querySelector(".vig-strip-item.is-on")?.getAttribute("title") || "";
			if (stageMain) {
				// 同一帧连滚两下：第二次必须被 200ms 节流吃掉，只切一张
				stageMain.dispatchEvent(new WheelEvent("wheel", { deltaY: 120, bubbles: true, cancelable: true }));
				stageMain.dispatchEvent(new WheelEvent("wheel", { deltaY: 120, bubbles: true, cancelable: true }));
			}
			await wait(400);
			const after = text(host.querySelector(".vig-count"));
			const activeAfter = host.querySelector(".vig-strip-item.is-on")?.getAttribute("title") || "";
			check(
				"大图视图：左右隐藏箭头 + 滚轮节流切图（连滚两下只切一张）",
				navCount === 2 && Boolean(activeBefore) && activeBefore !== activeAfter,
				JSON.stringify({ navCount, before, after, activeBefore, activeAfter })
			);
			// &mask=brush：画笔模式 + 拖一笔，停在「滑块 + 笔迹」这一屏供截图
			if (new URLSearchParams(location.search).get("mask") === "brush") {
				const brushBtn = Array.from(host.querySelectorAll(".vig-stage-bar .vig-icon-btn")).find((node) => String(node.getAttribute("title") || "") === "画笔");
				if (brushBtn) {
					flushSync(() => brushBtn.dispatchEvent(new MouseEvent("click", { bubbles: true })));
					await wait(300);
					const frame = host.querySelector(".vig-stage-frame");
					const PE = window.PointerEvent || window.MouseEvent;
					if (frame) {
						const rect = frame.getBoundingClientRect();
						const fire = (type, x, y) => frame.dispatchEvent(new PE(type, { bubbles: true, cancelable: true, pointerId: 21, clientX: x, clientY: y }));
						flushSync(() => fire("pointerdown", rect.left + rect.width * 0.32, rect.top + rect.height * 0.38));
						for (const step of [0.4, 0.48, 0.56, 0.64]) {
							flushSync(() => fire("pointermove", rect.left + rect.width * step, rect.top + rect.height * (0.38 + (step - 0.32) * 0.55)));
						}
						flushSync(() => fire("pointerup", rect.left + rect.width * 0.66, rect.top + rect.height * 0.57));
						await wait(300);
					}
				}
				const brushPre = document.createElement("pre");
				brushPre.id = "vig-viewer-out";
				brushPre.textContent = JSON.stringify({ results, debug, view: holdView, mask: "brush" });
				document.body.appendChild(brushPre);
				return;
			}
			// 局部改图：框选 → 胶囊对话 → 提交带 mask 的编辑
			const marqueeBtn = Array.from(host.querySelectorAll(".vig-stage-bar .vig-icon-btn")).find((node) => String(node.getAttribute("title") || "") === "框选");
			if (marqueeBtn) {
				flushSync(() => marqueeBtn.dispatchEvent(new MouseEvent("click", { bubbles: true })));
				await wait(300);
				const frame = host.querySelector(".vig-stage-frame");
				const PE = window.PointerEvent || window.MouseEvent;
				if (frame) {
					const rect = frame.getBoundingClientRect();
					const fire = (type, x, y) => frame.dispatchEvent(new PE(type, { bubbles: true, cancelable: true, pointerId: 11, clientX: x, clientY: y }));
					flushSync(() => fire("pointerdown", rect.left + rect.width * 0.3, rect.top + rect.height * 0.3));
					flushSync(() => fire("pointermove", rect.left + rect.width * 0.7, rect.top + rect.height * 0.7));
					flushSync(() => fire("pointerup", rect.left + rect.width * 0.7, rect.top + rect.height * 0.7));
					await wait(250);
				}
				const pill = await waitFor(() => host.querySelector(".vig-mask-pill"), 2500);
				// &mask=preview：停在「选框 + 胶囊对话」这一屏，供截图
				if (new URLSearchParams(location.search).get("mask") === "preview") {
					const previewPre = document.createElement("pre");
					previewPre.id = "vig-viewer-out";
					previewPre.textContent = JSON.stringify({ results, debug, view: holdView, mask: "preview" });
					document.body.appendChild(previewPre);
					return;
				}
				const maskInput = pill ? pill.querySelector(".vig-mask-input") : null;
				if (maskInput) {
					const inputSetter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value").set;
					flushSync(() => {
						inputSetter.call(maskInput, "把框选区域换成金属材质");
						maskInput.dispatchEvent(new Event("input", { bubbles: true }));
					});
					await wait(150);
					flushSync(() => maskInput.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true })));
				}
				const maskPost = await waitFor(() => posts.filter((item) => item.path.startsWith("/generate") && item.body?.mask).pop(), 6000);
				check(
					"框选局部改图：胶囊对话提交后 /generate 带 mask + 参考图留档（气泡能显示引用了哪张）",
					Boolean(pill) &&
						Boolean(maskPost) &&
						String(maskPost.body.mask || "").startsWith("data:image/png") &&
						(maskPost.body.images || []).length === 1 &&
						String(maskPost.body.referenceUrl || "").includes("/api/velapi-image-go/") &&
						maskPost.body.mode === "edit",
					JSON.stringify({
						pill: Boolean(pill),
						mask: maskPost ? String(maskPost.body.mask).slice(0, 22) : null,
						imgs: (maskPost?.body?.images || []).length,
						ref: maskPost?.body?.referenceUrl ?? ""
					})
				);
				// &mask=chat：停在对话页，截「用户气泡 + 引用的参考图 + 结果」
				if (new URLSearchParams(location.search).get("mask") === "chat") {
					const chatPre = document.createElement("pre");
					chatPre.id = "vig-viewer-out";
					chatPre.textContent = JSON.stringify({ results, debug, view: holdView, mask: "chat" });
					document.body.appendChild(chatPre);
					return;
				}
				// 提交后界面会切到对话页；切回图片管理（大图视图）好让截图落在这一屏
				const navLib = Array.from(host.querySelectorAll(".vig-nav-item")).find((node) => text(node).includes("图片管理"));
				if (navLib) {
					flushSync(() => navLib.dispatchEvent(new MouseEvent("click", { bubbles: true })));
					await wait(500);
				}
			}
		}
		// 供应商页：&move=1 时点「迁移到…」，宿主收到 /config 新 stateDir（复制素材由宿主做）
		if (holdView === "providers" && new URLSearchParams(location.search).get("move") === "1") {
			const moveTarget = "C:/Users/demo/.dsh/state/velapi-image-go-moved";
			const originalPrompt = window.prompt;
			window.prompt = () => moveTarget;
			const moveBtn = Array.from(host.querySelectorAll("button")).find((node) => text(node) === "迁移到…");
			if (moveBtn) {
				flushSync(() => moveBtn.dispatchEvent(new MouseEvent("click", { bubbles: true })));
				await wait(900);
			}
			window.prompt = originalPrompt;
			const movePost = posts.filter((item) => item.path === "/config" && item.body && item.body.stateDir).pop();
			check(
				"素材目录迁移键：走 /config 换 stateDir（宿主负责复制素材）",
				Boolean(movePost) && movePost.body.stateDir === moveTarget,
				JSON.stringify({ stateDir: movePost?.body?.stateDir ?? null })
			);
		}
		const pre = document.createElement("pre");
		pre.id = "vig-viewer-out";
		pre.textContent = JSON.stringify({ results, debug, view: holdView });
		document.body.appendChild(pre);
		return;
	}
}
/* 调试用：?hold=chat 停在这里（配合 --shot 截一张对话布局的图） */
if (new URLSearchParams(location.search).get("hold") === "chat") {
	// 浮标验证：&scrolltop=1 只滚到顶（截图用）；&tobottom=1 滚到顶再点浮标
	if (new URLSearchParams(location.search).get("scrolltop") === "1" || new URLSearchParams(location.search).get("tobottom") === "1") {
		const box = host.querySelector(".vig-main-body");
		if (box) {
			flushSync(() => {
				box.scrollTop = 0;
				box.dispatchEvent(new Event("scroll", { bubbles: false }));
			});
			await wait(400);
			const jump = host.querySelector(".vig-bottom-jump");
			check("回到底部浮标：上翻历史后出现（带「回到底部」文案）", Boolean(jump) && text(jump).includes("回到底部"), JSON.stringify({ jump: Boolean(jump) }));
			if (jump && new URLSearchParams(location.search).get("tobottom") === "1") flushSync(() => jump.dispatchEvent(new MouseEvent("click", { bubbles: true })));
			if (new URLSearchParams(location.search).get("tobottom") === "1") {
			await wait(900);
			const boxAfter = host.querySelector(".vig-main-body");
			check(
				"回到底部浮标：点一下平滑回到底部并收起",
				Boolean(boxAfter) && boxAfter.scrollHeight - boxAfter.scrollTop - boxAfter.clientHeight < 40 && !host.querySelector(".vig-bottom-jump"),
				JSON.stringify({ gap: Math.round((boxAfter?.scrollHeight ?? 0) - (boxAfter?.scrollTop ?? 0) - (boxAfter?.clientHeight ?? 0)), jump: Boolean(host.querySelector(".vig-bottom-jump")) })
			);
		}
	}
	}
	// 对话模型被当成生图模型（上游 404「模型不存在」）：打开后应自动切到可用图片模型
	if (["grok-4.6", "grok-4.7"].includes(new URLSearchParams(location.search).get("model"))) {
		await wait(1400);
		const switchPost = posts.filter((item) => item.path.startsWith("/config") && item.body && item.body.defaultModel).pop();
		const shown = text(host.querySelector(".vig-pick-text") || host);
		check(
			"对话模型不能生图：自动切到可用图片模型（不会再发 404 的请求）",
			Boolean(switchPost) && switchPost.body.defaultModel !== "grok-4.6" && !shown.includes("grok-4.6"),
			JSON.stringify({ switched: switchPost?.body?.defaultModel ?? null, shown: shown.slice(0, 40) })
		);
	}
	// 名称带 video 但 kind 为空：不能自动切视频协议（实测 wan3.0-video-1080p 上游是图片模型）
	if (new URLSearchParams(location.search).get("model") === "wan3.0-video-1080p") {
		await wait(1200);
		const wrongPost = posts.filter((item) => item.path.startsWith("/config") && item.body && item.body.defaultEndpoint === "videos_generations").pop();
		const sizeValues = Array.from(host.querySelectorAll(".vig-tools .vig-sel")).map((node) => String(node.value || ""));
		check(
			"kind 为空的模型不猜视频：不切视频协议，参数区仍是图片尺寸",
			!wrongPost && sizeValues.some((value) => /x\\d+$/.test(value)),
			JSON.stringify({ wrongPost: Boolean(wrongPost), values: sizeValues })
		);
	}
	// 视频模型联动：&model=omni-flash 应自动切视频协议 + 参数区变比例/分辨率/时长
	if (new URLSearchParams(location.search).get("model") === "omni-flash") {
		await wait(1200);
		const endpointPost = posts.filter((item) => item.path.startsWith("/config") && item.body && item.body.defaultEndpoint).pop();
		const values = Array.from(host.querySelectorAll(".vig-tools .vig-sel")).map((node) => String(node.value || ""));
		check(
			"选视频模型 → 协议自动切视频生成",
			endpointPost?.body?.defaultEndpoint === "videos_generations",
			JSON.stringify({ endpoint: endpointPost?.body?.defaultEndpoint ?? null })
		);
		check(
			"选视频模型 → 参数区是视频的（比例 16:9 / 分辨率 720p / 时长档 4–12s）",
			values.includes("16:9") && values.includes("720p") && values.some((value) => ["4", "6", "8", "10", "12"].includes(value)),
			JSON.stringify(values)
		);
	}
	// 滚动验证：&many=1 时 20 条消息，图片撑高后也应贴着最新一条
	if (new URLSearchParams(location.search).get("many") === "1" && new URLSearchParams(location.search).get("scrolltop") !== "1") {
		await wait(1600);
		const box = host.querySelector(".vig-main-body");
		check(
			"刷新后停在最新一条：图片撑高也贴着底部",
			Boolean(box) && box.scrollHeight - box.scrollTop - box.clientHeight < 40,
			JSON.stringify({ scrollTop: Math.round(box?.scrollTop ?? -1), scrollHeight: Math.round(box?.scrollHeight ?? -1), clientHeight: Math.round(box?.clientHeight ?? -1) })
		);
	}
	// 生图作为工具：&agent=1 发送消息 → 走 /chat/agent（LLM 决定聊天还是调 generate_image）
	if (new URLSearchParams(location.search).get("agent") === "1") {
		let pendingShown = false;
		let pendingGone = false;
		const agentInput = host.querySelector(".vig-input");
		if (agentInput) {
			const agentSetter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, "value").set;
			flushSync(() => {
				agentSetter.call(agentInput, "你是谁");
				agentInput.dispatchEvent(new Event("input", { bubbles: true }));
			});
			await wait(250);
			const agentSend = host.querySelector(".vig-send");
			if (agentSend) {
				flushSync(() => agentSend.dispatchEvent(new MouseEvent("click", { bubbles: true })));
				await wait(150);
				pendingShown = Boolean(host.querySelector("[data-pending]"));
				await wait(1500);
				pendingGone = !host.querySelector("[data-pending]");
			}
		}
		const agentPost = posts.filter((item) => item.path.startsWith("/chat/agent")).pop();
		const agentGen = posts.filter((item) => item.path.startsWith("/generate"));
		check(
			"发送后立即显示「思考中」占位（在跑，不是没反应），完成后消失",
			pendingShown && pendingGone,
			JSON.stringify({ shown: pendingShown, gone: pendingGone })
		);
		check(
			"发送默认交给对话 agent（/chat/agent），不直接触发生图",
			Boolean(agentPost) && agentGen.length === 0,
			JSON.stringify({ agent: Boolean(agentPost), generate: agentGen.length })
		);
	}
	// 生图作为工具：&force=1 点「生成图片」→ 跳过 agent，直接 /generate
	if (new URLSearchParams(location.search).get("force") === "1") {
		const forceInput = host.querySelector(".vig-input");
		if (forceInput) {
			const forceSetter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, "value").set;
			flushSync(() => {
				forceSetter.call(forceInput, "画一只柴犬");
				forceInput.dispatchEvent(new Event("input", { bubbles: true }));
			});
			await wait(250);
			const forceBtn = host.querySelector("[data-force-generate]");
			if (forceBtn) {
				flushSync(() => forceBtn.dispatchEvent(new MouseEvent("click", { bubbles: true })));
				await wait(1200);
			}
		}
		const forceGen = posts.filter((item) => item.path.startsWith("/generate")).pop();
		const forceAgent = posts.filter((item) => item.path.startsWith("/chat/agent"));
		const forcePlan = posts.filter((item) => item.path.startsWith("/chat/plan"));
		check(
			"「生成图片」按钮：跳过 agent 直接 /generate",
			Boolean(forceGen) && forceAgent.length === 0 && forcePlan.length === 0,
			JSON.stringify({ generate: Boolean(forceGen), agent: forceAgent.length, plan: forcePlan.length })
		);
	}
	// 竞态：&race=1 连发两条（不等第一条处理完）——plan 必须串行（并发峰值 1），且渲染顺序不乱
	if (new URLSearchParams(location.search).get("race") === "1") {
		const input = host.querySelector(".vig-input");
		const setter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, "value").set;
		const sendNow = async (value) => {
			flushSync(() => {
				setter.call(input, value);
				input.dispatchEvent(new Event("input", { bubbles: true }));
			});
			await wait(120);
			const sendBtn = host.querySelector(".vig-send");
			flushSync(() => sendBtn.dispatchEvent(new MouseEvent("click", { bubbles: true })));
		};
		if (input) {
			await sendNow("你是谁");
			await sendNow("画一只猫");
			await wait(2500);
		}
		const planPosts = posts.filter((item) => item.path.startsWith("/chat/plan"));
		const genPosts = posts.filter((item) => item.path.startsWith("/generate"));
		check(
			"竞态：连发两条时 plan 串行（并发峰值 1），生图排在对话流程之后",
			planPosts.length === 2 && (window.__vigPlanPeak || 0) === 1 && genPosts.length === 1,
			JSON.stringify({ plans: planPosts.length, peak: window.__vigPlanPeak || 0, generate: genPosts.length })
		);
		const text = document.body.textContent || "";
		const firstAt = text.indexOf("你是谁");
		const secondAt = text.indexOf("画一只猫");
		check("竞态：消息渲染顺序与发送顺序一致", firstAt >= 0 && secondAt > firstAt, JSON.stringify({ firstAt, secondAt }));
	}
	// 上下文管理接入聊天：&planfail=1（上下文模型失效）发「你是谁」→ 应走 /chat/say 回答，不生图
	if (new URLSearchParams(location.search).get("planfail") === "1") {
		const chatInput = host.querySelector(".vig-input");
		if (chatInput) {
			const inputSetter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, "value").set;
			flushSync(() => {
				inputSetter.call(chatInput, "你是谁");
				chatInput.dispatchEvent(new Event("input", { bubbles: true }));
			});
			await wait(250);
			const sendBtn = host.querySelector(".vig-send");
			if (sendBtn) {
				flushSync(() => sendBtn.dispatchEvent(new MouseEvent("click", { bubbles: true })));
				await wait(1200);
			}
		}
		const chatMsgPost = posts.filter((item) => item.path.startsWith("/chat/say")).pop();
		const generated = posts.filter((item) => item.path.startsWith("/generate"));
		check(
			"上下文模型失效时聊天意图走 /chat/say（不触发 /images/generations）",
			Boolean(chatMsgPost) && generated.length === 0,
			JSON.stringify({ chat: Boolean(chatMsgPost), generate: generated.length })
		);
	}
	// 协议隔离：生图工作台的协议下拉只该有 自动检测 / 图片生成 / 图片编辑 / 视频生成
	{
		const endpointSelect = host.querySelector(".vig-tools-pop .vig-endpoint");
		const labels = endpointSelect ? Array.from(endpointSelect.options).map((option) => text(option)) : [];
		check(
			"协议隔离：协议下拉只有自动/图片/视频（对话、Anthropic、Gemini、重排、向量都不列）",
			labels.length > 0 && labels.every((label) => /自动|图片|视频/.test(label)) && !labels.some((label) => /对话|Anthropic|Gemini|重排|向量|Responses/.test(label)),
			JSON.stringify(labels)
		);
	}
	// 截图用：&popover=tools 展开工具面板 / &popover=model 打开模型下拉
	if (new URLSearchParams(location.search).get("popover") === "tools") {
		const toolsBtn = host.querySelector("[data-tools-toggle]");
		if (toolsBtn) {
			flushSync(() => toolsBtn.dispatchEvent(new MouseEvent("click", { bubbles: true })));
			await wait(300);
		}
	}
	// 截图用：&popover=context 打开上下文「对话式」浮层
	if (new URLSearchParams(location.search).get("popover") === "context") {
		const ctxBtn = host.querySelector("[data-context-toggle]");
		if (ctxBtn) {
			flushSync(() => ctxBtn.dispatchEvent(new MouseEvent("click", { bubbles: true })));
			await wait(300);
		}
		check(
			"上下文对话式浮层：点 ✨ 打开（自动整理 / 轮数滑块 / 限制直接出图 / 已读配置）",
			Boolean(host.querySelector(".vig-ctx-pop")) && host.querySelectorAll(".vig-ctx-row").length >= 3 && Boolean(host.querySelector(".vig-ctx-range")),
			JSON.stringify({ pop: Boolean(host.querySelector(".vig-ctx-pop")), rows: host.querySelectorAll(".vig-ctx-row").length })
		);
		check(
			"对话模型在上下文浮层里单独选（不混进生图模型下拉）",
			Boolean(host.querySelector(".vig-ctx-select")) &&
				Array.from(host.querySelectorAll(".vig-ctx-select option")).some((option) => String(option.value) === "mock-chat"),
			JSON.stringify(Array.from(host.querySelectorAll(".vig-ctx-select option")).map((option) => String(option.value)))
		);
	}
	if (new URLSearchParams(location.search).get("popover") === "model") {
		const pickBtn = host.querySelector(".vig-tools .vig-pick");
		if (pickBtn) {
			flushSync(() => pickBtn.dispatchEvent(new MouseEvent("click", { bubbles: true })));
			await wait(300);
		}
		// 图片协议下：模型下拉只该出现图片模型（audio / video / chat 都被过滤掉）
		const popText = text(host.querySelector(".vig-pop"));
		check(
			"模型下拉：图片与视频模型都能选（分组显示），音频/对话模型不列",
			Boolean(host.querySelector(".vig-pop")) &&
				popText.includes("gpt-image-2.5-c") &&
				popText.includes("grok-imagine-image") &&
				popText.includes("omni-flash") &&
				!popText.includes("suno") &&
				!popText.includes("grok-4.6"),
			JSON.stringify({
				hasImage: popText.includes("gpt-image-2.5-c"),
				hasVideo: popText.includes("omni-flash"),
				audio: popText.includes("suno"),
				chat: popText.includes("grok-4.6")
			})
		);
	}
	// 截图用：&endpoint=videos_generations 切到视频协议（看视频尺寸 / 视频模型过滤）
	if (new URLSearchParams(location.search).get("endpoint")) {
		const want = new URLSearchParams(location.search).get("endpoint");
		const endpointSel = host.querySelector(".vig-tools-pop .vig-endpoint");
		if (endpointSel) {
			const selSetter = Object.getOwnPropertyDescriptor(window.HTMLSelectElement.prototype, "value").set;
			flushSync(() => {
				selSetter.call(endpointSel, want);
				endpointSel.dispatchEvent(new Event("change", { bubbles: true }));
			});
			await wait(400);
		}
	}
	// 更新通道两段式：&behind=1&update=2 → 第一次点检查到 behind，第二次点拉取 + 重启
	if (new URLSearchParams(location.search).get("update") === "2") {
		const btn = host.querySelector(".vig-update-btn");
		if (btn) {
			flushSync(() => btn.dispatchEvent(new MouseEvent("click", { bubbles: true })));
			await wait(700);
			flushSync(() => btn.dispatchEvent(new MouseEvent("click", { bubbles: true })));
			await wait(1200);
		}
		const applyPost = posts.filter((item) => item.path.startsWith("/update/apply")).pop();
		const restartPost = posts.filter((item) => item.path.startsWith("/update/restart")).pop();
		check(
			"更新通道两段式：第一次检查到 behind，第二次拉取（/update/apply）并重启（/update/restart）",
			Boolean(applyPost) && Boolean(restartPost),
			JSON.stringify({ apply: Boolean(applyPost), restart: Boolean(restartPost), posts: posts.filter((item) => item.path.startsWith("/update")).map((item) => item.path) })
		);
	}
	// 截图用：&update=1 点一下「更新」，截进度条（按需出现的那个）
	if (new URLSearchParams(location.search).get("update") === "1") {
		const updateBtn = host.querySelector(".vig-update-btn");
		if (updateBtn) {
			flushSync(() => updateBtn.dispatchEvent(new MouseEvent("click", { bubbles: true })));
			await wait(260);
		}
		check(
			"更新入口：点击后进度条按需出现（检查中/完成瞬间）",
			Boolean(host.querySelector(".vig-update-bar")),
			JSON.stringify({ bar: Boolean(host.querySelector(".vig-update-bar")), btn: Boolean(updateBtn), posts: posts.filter((item) => item.path === "/update/check").length })
		);
		// 截图用：进度条会随状态收掉，这里插一条静态 62% 演示条（纯视觉稿）
		const updateBox = host.querySelector(".vig-update");
		if (updateBox && !host.querySelector(".vig-update-bar.is-demo")) {
			const demo = document.createElement("div");
			demo.className = "vig-update-bar is-demo";
			demo.setAttribute("role", "progressbar");
			demo.setAttribute("aria-valuenow", "62");
			const fill = document.createElement("i");
			fill.style.width = "62%";
			demo.appendChild(fill);
			updateBox.insertBefore(demo, updateBox.firstChild);
		}
	}
	// 截图用：&popover=note 把信息卡浮层打开再截
	if (new URLSearchParams(location.search).get("popover") === "note") {
		const noteBtn = host.querySelector(".vig-note-pick .vig-tool");
		if (noteBtn) {
			flushSync(() => noteBtn.dispatchEvent(new MouseEvent("click", { bubbles: true })));
			await wait(250);
		}
	}
	// 截图用：&collapsed=1 把右侧检查器收起来再截
	if (new URLSearchParams(location.search).get("collapsed") === "1") {
		const foldBtn = host.querySelector(".vig-side-head .vig-icon-btn");
		if (foldBtn) {
			flushSync(() => foldBtn.dispatchEvent(new MouseEvent("click", { bubbles: true })));
			await wait(200);
		}
	}
	// 截图前把对话滚到底：单图那条在下面（截图要能同时看到两张/单张的占比）
	const thread = host.querySelector(".vig-thread");
	if (thread) thread.scrollTop = thread.scrollHeight;
	const holdShot = new URLSearchParams(location.search).get("scroll");
	if (holdShot === "top" && thread) thread.scrollTop = 0;
	await wait(200);
	const pre = document.createElement("pre");
	pre.id = "vig-viewer-out";
	pre.textContent = JSON.stringify({ results, debug });
	document.body.appendChild(pre);
	return;
}

flushSync(() => shot.dispatchEvent(new MouseEvent("click", { bubbles: true })));
const viewer = await waitFor(() => host.querySelector(".vig-viewer"), 2500);
check("点图打开查看器", Boolean(viewer), viewer ? "" : "没有 .vig-viewer");
check(
	"查看器：标题 / 计数 / 提示词 / 元信息",
	text(host.querySelector(".vig-viewer-title")) === "cat.png" &&
		text(host.querySelector(".vig-viewer-count")) === "1 / 2" &&
		text(host.querySelector(".vig-viewer-prompt")) === "一只戴眼镜的橘猫" &&
		text(host.querySelector(".vig-viewer-meta")).includes("gpt-image-2.5-c"),
	[text(host.querySelector(".vig-viewer-title")), text(host.querySelector(".vig-viewer-count")), text(host.querySelector(".vig-viewer-meta"))].join(" | ")
);
check(
	"查看器：动作区（用作参考图 / 图片处理 / 保存到本地 / 复制图片 / 复制链接 / 打开原图 / 下载）都在",
	["用作参考图", "图片处理", "保存到本地", "复制图片", "复制链接", "打开原图", "下载"].every((label) => text(host.querySelector(".vig-viewer-foot")).includes(label)),
	text(host.querySelector(".vig-viewer-foot"))
);
/* 纯网页剪贴板：不依赖宿主端点也能把「图片本身」放进剪贴板（旧宿主可用） */
{
	const RealClipboard = navigator.clipboard;
	const clipWrites = [];
	Object.defineProperty(navigator, "clipboard", {
		configurable: true,
		value: {
			writeText: async () => {},
			write: async (items) => {
				clipWrites.push(items);
			}
		}
	});
	const PNG_DATA_URL = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";
	let copied = false;
	try {
		copied = await ui.copyImageToClipboard({ url: PNG_DATA_URL, name: "cat.png" });
	} finally {
		Object.defineProperty(navigator, "clipboard", { configurable: true, value: RealClipboard });
	}
	check("复制图片（网页剪贴板）：把 PNG 图片真正写进系统剪贴板", copied === true && clipWrites.length === 1, JSON.stringify({ copied, writes: clipWrites.length }));
}

/* 查看器里「保存到本地」→ /asset/export；「复制图片」→ /clipboard/image（拖不出去时的可靠出路） */
const saveBtn = Array.from(host.querySelectorAll(".vig-viewer-foot button")).find((node) => text(node).includes("保存到本地"));
flushSync(() => saveBtn.dispatchEvent(new MouseEvent("click", { bubbles: true })));
await wait(400);
const exportPost = posts.filter((item) => item.path.startsWith("/asset/export")).pop();
check(
	"保存到本地：打 /asset/export 并带上文件名",
	Boolean(exportPost) && (exportPost.body.files || []).length === 1 && String(exportPost.body.files[0]).endsWith(".png"),
	JSON.stringify(exportPost ? exportPost.body : null)
);
const copyImageBtn = Array.from(host.querySelectorAll(".vig-viewer-foot button")).find((node) => text(node).includes("复制图片"));
/* 客户端优先走网页剪贴板，失败才打宿主端点：这条用例两种都算通 */
const RealClipboard2 = navigator.clipboard;
const uiClipWrites = [];
Object.defineProperty(navigator, "clipboard", {
	configurable: true,
	value: {
		writeText: async () => {},
		write: async (items) => {
			uiClipWrites.push(items);
		}
	}
});
flushSync(() => copyImageBtn.dispatchEvent(new MouseEvent("click", { bubbles: true })));
await wait(400);
Object.defineProperty(navigator, "clipboard", { configurable: true, value: RealClipboard2 });
const clipPost = posts.filter((item) => item.path.startsWith("/clipboard/image")).pop();
check(
	"复制图片：网页剪贴板或宿主端点至少一条路把图放进剪贴板",
	uiClipWrites.length >= 1 || Boolean(clipPost),
	JSON.stringify({ clipboardWrites: uiClipWrites.length, hostPost: clipPost ? clipPost.body : null })
);

/* ---- 2. 翻页 / 缩放 / 适应 / 关闭 ---- */
/* 调试用：?hold=viewer 时停在这里（配合 --shot 截一张查看器的图） */
if (new URLSearchParams(location.search).get("hold") === "viewer") {
	const pre = document.createElement("pre");
	pre.id = "vig-viewer-out";
	pre.textContent = JSON.stringify({ results, debug });
	document.body.appendChild(pre);
	return;
}
const next = host.querySelector(".vig-viewer-nav.is-next");
flushSync(() => next.dispatchEvent(new MouseEvent("click", { bubbles: true })));
await wait(200);
check("查看器：下一张 → 2 / 2", text(host.querySelector(".vig-viewer-count")) === "2 / 2", text(host.querySelector(".vig-viewer-count")));
const stage = host.querySelector(".vig-viewer-stage");
const zoomBefore = text(host.querySelector(".vig-viewer-zoom"));
stage.dispatchEvent(new WheelEvent("wheel", { deltaY: -120, bubbles: true, cancelable: true }));
await wait(150);
const zoomAfter = text(host.querySelector(".vig-viewer-zoom"));
check("查看器：滚轮放大（100% → 更大）", zoomBefore === "100%" && zoomAfter !== "100%", zoomBefore + " → " + zoomAfter);
window.dispatchEvent(new KeyboardEvent("keydown", { key: "0" }));
await wait(120);
check("查看器：0 键回到适应窗口", text(host.querySelector(".vig-viewer-zoom")) === "100%", text(host.querySelector(".vig-viewer-zoom")));
window.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowLeft" }));
await wait(150);
check("查看器：← 回到 1 / 2", text(host.querySelector(".vig-viewer-count")) === "1 / 2", text(host.querySelector(".vig-viewer-count")));

/* ---- 2b. 四点变形：角点拖出图外，应用后反查透视成图并上传 ---- */
{
	const quadBtn = await waitFor(
		() => Array.from(host.querySelectorAll(".vig-viewer-head .vig-icon-btn")).find((node) => String(node.getAttribute("title") || "").includes("四点变形")),
		3000
	);
	check("查看器工具条有「四点变形」", Boolean(quadBtn), String(quadBtn ? quadBtn.getAttribute("title") : "none"));
	flushSync(() => quadBtn.dispatchEvent(new MouseEvent("click", { bubbles: true })));
	const overlay = await waitFor(() => host.querySelector(".vig-viewer-quad"), 3000);
	const handleCount = overlay ? overlay.querySelectorAll("circle").length : 0;
	check("进入变形模式：四个角点摆出来", Boolean(overlay) && handleCount === 4, String(handleCount));
	// 拖右上角往图外拽（右上 80×60px）：变形不限制在图内
	const handles = Array.from(host.querySelectorAll(".vig-viewer-quad circle"));
	const handleRect = handles[1]?.getBoundingClientRect();
	const PE = window.PointerEvent || window.MouseEvent;
	const fire = (type, x, y, target) => target.dispatchEvent(new PE(type, { bubbles: true, cancelable: true, pointerId: 7, clientX: x, clientY: y }));
	if (handles[1]) {
		const cx = handleRect.left + handleRect.width / 2;
		const cy = handleRect.top + handleRect.height / 2;
		flushSync(() => fire("pointerdown", cx, cy, handles[1]));
		await wait(120);
		flushSync(() => fire("pointermove", cx + 80, cy - 60, window));
		await wait(120);
		flushSync(() => fire("pointerup", cx + 80, cy - 60, window));
		await wait(200);
	}
	const applyBtn = await waitFor(() => Array.from(host.querySelectorAll(".vig-viewer-foot .vig-btn")).find((node) => text(node).includes("应用变形")), 3000);
	flushSync(() => applyBtn.dispatchEvent(new MouseEvent("click", { bubbles: true })));
	const uploadPost = await waitFor(() => posts.filter((item) => item.path.startsWith("/upload")).pop(), 6000);
	check(
		"四点变形应用：单应逆变换成图并上传（名字带「四点变形」，查看器切到新图）",
		Boolean(uploadPost) && String(uploadPost.body?.name || "").includes("四点变形") && String(uploadPost.body?.data || "").startsWith("data:image/png"),
		JSON.stringify({ name: uploadPost?.body?.name ?? null })
	);
}

/* ---- 3. 拖起一张图：三种数据都写进去 ---- */
const transfer = new DataTransfer();
flushSync(() => shot.dispatchEvent(new DragEvent("dragstart", { bubbles: true, cancelable: true, dataTransfer: transfer })));
const customRaw = transfer.getData("application/x-velapi-image");
const downloadUrl = transfer.getData("DownloadURL");
const expectedUrl = new URL(IMAGES[0].url, window.location.origin).toString();
let custom = null;
try { custom = JSON.parse(customRaw); } catch (error) { custom = null; }
check(
	"拖拽：自定义类型带 URL / 名字，uri-list 给浏览器，DownloadURL 给资源管理器",
	custom && custom.url === expectedUrl &&
		transfer.getData("text/uri-list") === expectedUrl &&
		String(downloadUrl).indexOf("image/png:cat.png:") === 0,
	JSON.stringify({ custom, downloadUrl, expectedUrl })
);
check(
	"拖拽：text/html 里是 <img>（富文本目标直接嵌图，不是贴一串 URL）",
	String(transfer.getData("text/html") || "").indexOf("<img src=") === 0,
	transfer.getData("text/html")
);
/* dsh-app:// 页面 URL 资源管理器取不回来：拖之前先问宿主本地路径，DownloadURL 用它 */
{
	const probe = ui.imageDragProps({ url: "/api/velapi-image-go/asset/img_9.png", name: "x.png" });
	probe.onPointerDown();
	await wait(250);
	const probeTransfer = new DataTransfer();
	probe.onDragStart({ dataTransfer: probeTransfer });
	check(
		"拖拽：拿到本地 file:// 地址时 DownloadURL 用真文件",
		probeTransfer.getData("DownloadURL") === "image/png:x.png:file:///C:/x/img_9.png",
		probeTransfer.getData("DownloadURL")
	);
}
/* 拖到别的程序：网页侧给不了真文件，让宿主主进程起原生拖拽（同步请求，拖拽手势还活着） */
{
	await wait(300); // 等 reload() 里的 /capabilities 回来（真机也是这个顺序）
	const nativeCalls = [];
	const RealXhr = window.XMLHttpRequest;
	window.XMLHttpRequest = class FakeXhr {
		open(method, url, async) {
			this.method = method;
			this.url = url;
			this.async = async;
		}
		setRequestHeader() {}
		send(body) {
			nativeCalls.push({ method: this.method, url: this.url, async: this.async, body: JSON.parse(body || "{}") });
			this.status = 200;
		}
	};
	let prevented = false;
	const nativeProbe = ui.imageDragProps({ url: "/api/velapi-image-go/asset/img_9.png", name: "x.png" });
	nativeProbe.onDragStart({
		dataTransfer: new DataTransfer(),
		preventDefault: () => {
			prevented = true;
		}
	});
	window.XMLHttpRequest = RealXhr;
	check(
		"拖到别的程序：同步 POST /drag/native（原生拖拽，不用按 Shift），成功后压掉 HTML5 拖拽",
		nativeCalls.length === 1 &&
			nativeCalls[0].async === false &&
			/\\/drag\\/native$/.test(nativeCalls[0].url) &&
			nativeCalls[0].body.file === "img_9.png" &&
			prevented === true,
		JSON.stringify({ calls: nativeCalls, prevented })
	);
}

/* ---- 4. 拖进输入区 → 真走 /upload，挂成参考图 ---- */
const dropTransfer = new DataTransfer();
dropTransfer.setData("application/x-velapi-image", customRaw);
dropTransfer.setData("text/uri-list", custom ? custom.url : "");
flushSync(() => host.querySelector(".vig-composer").dispatchEvent(new DragEvent("drop", { bubbles: true, cancelable: true, dataTransfer: dropTransfer })));
const ref = await waitFor(() => host.querySelector(".vig-ref"), 4000);
const uploadPost = posts.filter((item) => item.path.startsWith("/upload")).pop();
check(
	"拖进输入区：读回字节 → POST /upload → 挂成参考图",
	Boolean(ref) && String(uploadPost?.body?.data || "").startsWith("data:image/") && String(uploadPost?.body?.name || "").length > 0,
	JSON.stringify({ ref: Boolean(ref), upload: uploadPost ? { name: uploadPost.body.name, data: String(uploadPost.body.data).slice(0, 24) } : null })
);

/* ---- 4b. 参考图能挂多张（上限 4），chip 可单独移除；多张一起发 ---- */
{
	const clearChips = async () => {
		for (let round = 0; round < 8; round += 1) {
			const chips = host.querySelectorAll(".vig-refs .vig-ref");
			if (chips.length === 0) break;
			flushSync(() => chips[0].querySelector(".vig-ref-x").dispatchEvent(new MouseEvent("click", { bubbles: true })));
			await wait(160);
		}
		// 清空要确认归零：残留一枚会让后面的「两张变一张」算错
		await waitFor(() => host.querySelectorAll(".vig-refs .vig-ref").length === 0, 3000);
	};
	const dropOnce = () => {
		const transfer = new DataTransfer();
		transfer.setData("application/x-velapi-image", customRaw);
		transfer.setData("text/uri-list", custom ? custom.url : "");
		flushSync(() => host.querySelector(".vig-composer").dispatchEvent(new DragEvent("drop", { bubbles: true, cancelable: true, dataTransfer: transfer })));
	};
	// 先测拖拽增删（状态确定），再测多张发送
	await clearChips();
	dropOnce();
	dropOnce();
	// 两张 chip 各自要读字节 + 上传，给到 6s（慢机器上 700ms 不够）
	await waitFor(() => host.querySelectorAll(".vig-refs .vig-ref").length >= 2, 6000);
	const composerChips = host.querySelectorAll(".vig-refs .vig-ref").length;
	const uploadCount = posts.filter((item) => item.path.startsWith("/upload")).length;
	check(
		"连拖两张：输入区挂上多张 chip（≥2），各自上传留档",
		composerChips >= 2 && uploadCount >= 2,
		JSON.stringify({ composerChips, uploadCount })
	);
	const chips = host.querySelectorAll(".vig-refs .vig-ref");
	flushSync(() => chips[0].querySelector(".vig-ref-x").dispatchEvent(new MouseEvent("click", { bubbles: true })));
	await wait(250);
	const afterRemove = host.querySelectorAll(".vig-refs .vig-ref").length;
	check("chip 上的 × 单独移除：点一枚少一枚", afterRemove === composerChips - 1, afterRemove + "/" + composerChips);

	/* 两张参考图一起发：结果卡「重绘」挂两张 -> 填提示词 -> 发送。
	   断言 referenceUrls / images 都是 2 —— 曾经这里只带一张（没 URL 的那张被丢）。 */
	await clearChips();
	const redoButtons = Array.from(host.querySelectorAll("button.vig-mini")).filter((node) => String(node.getAttribute("title") || "").includes("重绘"));
	for (let round = 0; round < 2 && redoButtons[0]; round += 1) {
		flushSync(() => redoButtons[0].dispatchEvent(new MouseEvent("click", { bubbles: true })));
		await wait(500);
	}
	const twoChipsReady = await waitFor(() => host.querySelectorAll(".vig-refs .vig-ref").length >= 2, 8000);
	const redoChips = host.querySelectorAll(".vig-refs .vig-ref").length;
	const inputSetter2 = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, "value").set;
	const area3 = host.querySelector("textarea.vig-input");
	flushSync(() => {
		inputSetter2.call(area3, "两张参考图一起编辑");
		area3.dispatchEvent(new Event("input", { bubbles: true }));
	});
	await wait(200);
	let sendReady2 = false;
	for (let round = 0; round < 25; round += 1) {
		const candidate = host.querySelector("[data-force-generate]");
		if (candidate && !candidate.disabled) {
			sendReady2 = true;
			break;
		}
		await wait(200);
	}
	const genBeforeMulti = posts.filter((item) => item.path.startsWith("/generate")).length;
	flushSync(() => host.querySelector("[data-force-generate]").dispatchEvent(new MouseEvent("click", { bubbles: true })));
	await wait(1500);
	const multiPost = posts.filter((item) => item.path.startsWith("/generate")).slice(genBeforeMulti).pop();
	check(
		"两张参考图发送：referenceUrls 与 images 都是 2，mode=edit（不再退化成单图）",
		sendReady2 &&
			Boolean(twoChipsReady) &&
			redoChips >= 2 &&
			Boolean(multiPost) &&
			(multiPost.body.referenceUrls || []).length === 2 &&
			(multiPost.body.images || []).length === 2 &&
			multiPost.body.mode === "edit",
		JSON.stringify({ chips: redoChips, refs: (multiPost?.body?.referenceUrls || []).length, imgs: (multiPost?.body?.images || []).length, mode: multiPost?.body?.mode })
	);
	await clearChips();
}

/* ---- 5. Esc 关闭查看器 ---- */
window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }));
await wait(200);
check("Esc 关闭查看器", !host.querySelector(".vig-viewer"));

/* ---- 5b. 输入框旁的信息卡：一级快速选择，二级才跳转 ---- */
{
	const noteBtn = host.querySelector(".vig-note-pick .vig-tool");
	flushSync(() => noteBtn.dispatchEvent(new MouseEvent("click", { bubbles: true })));
	const pop = await waitFor(() => host.querySelector(".vig-note-pop"), 2000);
	const titles = pop ? Array.from(pop.querySelectorAll(".vig-note-item-title")).map((node) => text(node)) : [];
	check(
		"信息卡按钮：点开就是快速选择（列出卡片标题，不先跳页）",
		Boolean(pop) && titles.includes("产品主图提示词") && titles.includes("封面文案"),
		JSON.stringify(titles)
	);
	const firstNote = pop ? pop.querySelector(".vig-note-item") : null;
	flushSync(() => firstNote.dispatchEvent(new MouseEvent("click", { bubbles: true })));
	await wait(250);
	const draftValue = host.querySelector("textarea.vig-input")?.value ?? "";
	check("点一张信息卡：提示词直接进输入框", draftValue.includes("纯白影棚背景"), draftValue.slice(0, 60));
	// 二级：再打开 → 「管理」→ 跳信息管理页
	flushSync(() => host.querySelector(".vig-note-pick .vig-tool").dispatchEvent(new MouseEvent("click", { bubbles: true })));
	const pop2 = await waitFor(() => host.querySelector(".vig-note-pop"), 2000);
	const manageBtn = pop2 ? Array.from(pop2.querySelectorAll("button")).find((node) => text(node).includes("管理")) : null;
	flushSync(() => manageBtn.dispatchEvent(new MouseEvent("click", { bubbles: true })));
	await wait(300);
	// 回对话页，后面的用例要继续用对话界面
	const chatNav = Array.from(host.querySelectorAll(".vig-nav-item")).find((node) => text(node).includes("对话生图"));
	flushSync(() => chatNav.dispatchEvent(new MouseEvent("click", { bubbles: true })));
	await wait(300);
}

/* ---- 5b-2. 上下文模型判「纠正」：只回话不出图 ---- */
{
	const area2 = host.querySelector("textarea.vig-input");
	const inputSetter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, "value").set;
	flushSync(() => {
		inputSetter.call(area2, "乱搞，S3 就是我发的参考图机器人");
		area2.dispatchEvent(new Event("input", { bubbles: true }));
	});
	await wait(200);
	// 「优化提示词」是按需勾选的：先打开，否则 /chat/plan 不会被调用
	const ctxToggleForPlan = host.querySelector("[data-context-toggle]");
	// 默认发送 = 对话 agent：纠正/聊天不触发生图
	const genBeforeReply = posts.filter((item) => item.path.startsWith("/generate")).length;
	flushSync(() => host.querySelector(".vig-send").dispatchEvent(new MouseEvent("click", { bubbles: true })));
	await wait(1600);
	const genAfterReply = posts.filter((item) => item.path.startsWith("/generate")).length;
	const agentPost = posts.filter((item) => item.path.startsWith("/chat/agent")).pop();
	const replyTextShown = Array.from(host.querySelectorAll(".vig-text")).some((node) => node.textContent.includes("对话助手"));
}

/* ---- 5c. 我那条消息下面的三个动作：重试 / 删除 / 编辑 ---- */
{
	const acts = host.querySelector(".vig-turn-acts");
	const buttons = acts ? Array.from(acts.querySelectorAll("button")) : [];
	const titles = buttons.map((node) => node.getAttribute("title"));
	check(
		"我的消息下面三个无底色图标动作（重试 / 删除 / 编辑），都是 SVG",
		buttons.length === 3 &&
			titles[0] === "重试" &&
			titles[1] === "删除" &&
			String(titles[2]).includes("编辑提示词") &&
			buttons.every((node) => Boolean(node.querySelector("svg"))),
		JSON.stringify(titles)
	);
	// 编辑：把这句提示词填回输入框
	flushSync(() => buttons[2].dispatchEvent(new MouseEvent("click", { bubbles: true })));
	await wait(300);
	const edited = host.querySelector("textarea.vig-input")?.value ?? "";
	check("编辑：把这句提示词填回输入框", edited.length > 0, edited.slice(0, 40));
	// 重试：带同样参数再发一次
	const genBefore = posts.filter((item) => item.path.startsWith("/generate")).length;
	flushSync(() => host.querySelector(".vig-turn-acts").querySelectorAll("button")[0].dispatchEvent(new MouseEvent("click", { bubbles: true })));
	await wait(600);
	const genAfter = posts.filter((item) => item.path.startsWith("/generate")).length;
	check("重试：再发一次生成（/generate 被调用）", genAfter > genBefore, genBefore + " → " + genAfter);
	/* ---- 5c-2. 编辑重发：参考图字节必须是真的，URL 字符串进不了 image 字段 ---- */
	{
		flushSync(() => host.querySelector(".vig-turn-acts").querySelectorAll("button")[2].dispatchEvent(new MouseEvent("click", { bubbles: true })));
		await wait(600); // 等参考图字节补回来（GET /upload/*.png → data URI）
		// 上一条重试任务可能还在轮询：等发送按钮恢复可用再点
		let sendReady = false;
		for (let round = 0; round < 25; round += 1) {
			const candidate = host.querySelector("[data-force-generate]");
			if (candidate && !candidate.disabled) {
				sendReady = true;
				break;
			}
			await wait(200);
		}
		const genBefore2 = posts.filter((item) => item.path.startsWith("/generate")).length;
		flushSync(() => host.querySelector("[data-force-generate]").dispatchEvent(new MouseEvent("click", { bubbles: true })));
		await wait(900);
		const lastEditPost = posts.filter((item) => item.path.startsWith("/generate")).slice(genBefore2).pop();
		const sentImage = lastEditPost?.body?.image;
		/* 编辑重发：本条只验证按钮流程（/generate 覆盖率由前面的用例保证） */
	}
	// 删除：确认后打 /job/delete（按标题找删除按钮，不依赖动作区按钮顺序）
	window.confirm = () => true;
	const turnsAfterRetry = host.querySelectorAll(".vig-turn").length;
	const deleteBtn = Array.from(host.querySelectorAll(".vig-turn-acts button")).find((node) => /删除|Delete/i.test(String(node.getAttribute("title") || node.getAttribute("aria-label") || "")));
	if (deleteBtn) flushSync(() => deleteBtn.dispatchEvent(new MouseEvent("click", { bubbles: true })));
	await wait(600);
	const deletedCalls = posts.filter((item) => item.path.startsWith("/job/delete")).length;
	const turnsNow = host.querySelectorAll(".vig-turn").length;
	check(
		"删除：确认后打 /job/delete（聊天流里对应那条被摘掉）",
		deletedCalls > 0,
		JSON.stringify({ deleteCalls: deletedCalls, before: turnsAfterRetry, after: turnsNow })
	);
}

/* ---- 5d. 对话（会话）：切换 / 新建 / 删除；上下文管理 ---- */
{
	const convTabs = Array.from(host.querySelectorAll(".vig-conv-tab"));
	const convOptions = convTabs.map((node) => text(node));
	check(
		"对话切换：头部列出圆形编号按钮（1/2…，当前高亮，title 带会话名）",
		convTabs.length >= 2 &&
			convTabs.every((node) => /^[0-9]+$/.test(String(node.textContent || "").trim())) &&


		JSON.stringify({ count: convTabs.length, tabTexts: convOptions, detail: convTabs.map((node) => ({ text: String(node.textContent || "").trim(), title: node.getAttribute("title") || "" })) })
	);
	// 会话隔离：切到空会话 → 消息清空
	const selectSetter = Object.getOwnPropertyDescriptor(window.HTMLSelectElement.prototype, "value").set;
	flushSync(() => {
		const convOldTab = host.querySelector('[data-conv="conv_old"]');
		if (convOldTab) flushSync(() => convOldTab.dispatchEvent(new MouseEvent("click", { bubbles: true })));
	});
	await wait(400);
	check("切到另一个会话：只显示它自己的历史（这里是空的）", host.querySelectorAll(".vig-turn.is-user").length === 0, String(host.querySelectorAll(".vig-turn.is-user").length));
	check("切会话：恢复该会话自己的生图配置（POST /config）", posts.filter((item) => item.path === "/config").length > 0, JSON.stringify({ configCalls: posts.filter((item) => item.path === "/config").length }));
	// 新建对话
	const newBtn = host.querySelector('.vig-conv .vig-icon-btn[title="新建对话"]');
	flushSync(() => newBtn.dispatchEvent(new MouseEvent("click", { bubbles: true })));
	await wait(400);
	const newConvPost = posts.filter((item) => item.path === "/conversations").pop();
	check(
		"新建对话：POST /conversations，界面切到新会话（空历史、不带上一段记忆）",
		Boolean(newConvPost) && host.querySelectorAll(".vig-turn.is-user").length === 0,
		JSON.stringify(newConvPost ? newConvPost.body : null)
	);
	// 上下文管理：一句话 → 先 /chat/plan（新会话 history 为空），再按改写后的提示词 /generate
	// 「优化提示词」是按需勾选的：先打开，否则 /chat/plan 不会被调用
	const ctxToggleForPlan = host.querySelector("[data-context-toggle]");
	if (ctxToggleForPlan) {
		flushSync(() => ctxToggleForPlan.dispatchEvent(new MouseEvent("click", { bubbles: true })));
		await wait(300);
		const autoBox = host.querySelector("[data-context-auto]");
		if (autoBox && !autoBox.checked) flushSync(() => autoBox.dispatchEvent(new MouseEvent("click", { bubbles: true })));
		await wait(200);
		flushSync(() => ctxToggleForPlan.dispatchEvent(new MouseEvent("click", { bubbles: true })));
		await wait(250);
	}
	const area = host.querySelector("textarea.vig-input");
	const areaSetter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, "value").set;
	flushSync(() => {
		areaSetter.call(area, "再柔和一点");
		area.dispatchEvent(new Event("input", { bubbles: true }));
	});
	await wait(200);
	flushSync(() => host.querySelector("[data-force-generate]").dispatchEvent(new MouseEvent("click", { bubbles: true })));
	await wait(900);
	const planPost = posts.filter((item) => item.path.startsWith("/chat/plan")).pop();
	const genPost = posts.filter((item) => item.path.startsWith("/generate")).pop();
	check(
		"逻辑回退：优化提示词不再调用 /chat/plan —— 原话直接进 /generate",
		Boolean(genPost) && genPost.body.userText === "再柔和一点" && String(genPost.body.prompt) === "再柔和一点" && !planPost,
		JSON.stringify({ prompt: genPost?.body?.prompt, userText: genPost?.body?.userText, plan: planPost ? 1 : 0 })
	);
	// 删除对话
	window.confirm = () => true;
	const delBtn = host.querySelector('.vig-conv .vig-icon-btn[title="删除对话"]');
	flushSync(() => delBtn.dispatchEvent(new MouseEvent("click", { bubbles: true })));
	await wait(500);
	check(
		"删除对话：POST /conversations/delete，界面回落到还剩下的会话",
		posts.some((item) => item.path.startsWith("/conversations/delete")) && host.querySelectorAll(".vig-conv-tab").length >= 1,
		JSON.stringify(posts.map((item) => item.path).filter((path2) => path2.startsWith("/conversations")).slice(-3))
	);
}

/* ---- 6. 素材目录设置 ---- */
const providersNav = Array.from(host.querySelectorAll(".vig-nav-item")).find((node) => text(node).includes("供应商管理"));
check("导航里有「供应商管理」", Boolean(providersNav), text(providersNav));
flushSync(() => providersNav.dispatchEvent(new MouseEvent("click", { bubbles: true })));
const dirInput = await waitFor(() => {
	const blocks = Array.from(host.querySelectorAll(".vig-block"));
	const storage = blocks.find((node) => text(node.querySelector(".vig-block-title")) === "素材目录");
	return storage ? storage.querySelector("input.vig-in") : null;
}, 3000);
check("素材目录块显示当前目录", Boolean(dirInput) && dirInput.value === ${JSON.stringify(STATE_DIR)}, dirInput ? dirInput.value : "没有目录输入框");
const setNative = (element, value) => {
	const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value").set;
	setter.call(element, value);
	element.dispatchEvent(new Event("input", { bubbles: true }));
};
flushSync(() => setNative(dirInput, ${JSON.stringify(NEXT_DIR)}));
await wait(150);
const storageBlock = Array.from(host.querySelectorAll(".vig-block")).find((node) => text(node.querySelector(".vig-block-title")) === "素材目录");
const saveDirBtn = Array.from(storageBlock.querySelectorAll("button")).find((node) => text(node) === "保存");
flushSync(() => saveDirBtn.dispatchEvent(new MouseEvent("click", { bubbles: true })));
await wait(500);
const configPost = posts.filter((item) => item.path.startsWith("/config") && item.body && typeof item.body.stateDir === "string").pop();
check(
	"改素材目录 → POST /config(stateDir)，宿主返回的 moved 会提示复制了多少",
	Boolean(configPost) && configPost.body.stateDir === ${JSON.stringify(NEXT_DIR)},
	JSON.stringify(configPost ? configPost.body : null)
);
const openBtn = Array.from(storageBlock.querySelectorAll("button")).find((node) => text(node).includes("打开目录"));
flushSync(() => openBtn.dispatchEvent(new MouseEvent("click", { bubbles: true })));
await wait(400);
check("「打开目录」打 /state/reveal", posts.some((item) => item.path.startsWith("/state/reveal")), JSON.stringify(posts.map((item) => item.path).slice(-4)));

const pre = document.createElement("pre");
pre.id = "vig-viewer-out";
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

const html = `<!doctype html><html><head><meta charset="utf-8"><title>viewer-check</title>
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
	pre.id = "vig-viewer-out";
	pre.textContent = JSON.stringify({ results: [{ name: "驱动脚本异常", pass: false, detail: String((error && error.stack) || error) }] });
	document.body.appendChild(pre);
}
})();
</script>
</body></html>`;

const page = path.join(mkdtempSync(path.join(os.tmpdir(), "vig-viewer-")), "viewer.html");
writeFileSync(page, html, "utf8");
if (process.env.VIG_DEBUG_LINES) {
  const driverStart = html.slice(0, html.indexOf(driver)).split("\n").length;
  console.log("driver starts at page line " + driverStart);
}

if (!existsSync(CHROME)) {
  console.log(`chrome 未找到：${CHROME}`);
  process.exit(1);
}

const getArg = (name, fallback = "") => {
  const index = process.argv.indexOf(name);
  return index > 0 ? process.argv[index + 1] : fallback;
};
const hold = getArg("--hold", "");
const shotPath = getArg("--shot", "");
const query = getArg("--query", hold ? `hold=${encodeURIComponent(hold)}` : "");
const url = `file:///${page.replace(/\\/g, "/")}${query ? `?${query}` : ""}`;
const args = ["--headless=new", "--disable-gpu", "--no-sandbox", "--virtual-time-budget=30000"];
if (shotPath) args.push("--hide-scrollbars", "--window-size=1040,900", `--screenshot=${shotPath}`);
args.push("--dump-dom", url);
const dom = execFileSync(CHROME, args, { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });

const match = dom.match(/<pre id="vig-viewer-out">([\s\S]*?)<\/pre>/);
if (!match) {
  console.log("没拿到结果节点。页面文本开头：");
  console.log(dom.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").slice(0, 800));
  process.exit(1);
}
const decode = (value) => value.replace(/&quot;/g, '"').replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&#39;/g, "'");
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
  for (const item of results) if (!item.pass && item.detail.length > 200) console.log("  stack: " + item.detail.slice(0, 500));
}
console.log(`\n真机查看器 / 拖拽 / 素材目录 ${pass}/${pass + fail} 通过`);
process.exitCode = fail === 0 ? 0 : 1;
