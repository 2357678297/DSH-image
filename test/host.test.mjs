// dsh-plugin-velapi-image-go —— 宿主半边冒烟测试
//
// 不需要启动 dsh：把插件的 apply() 挂在一个最小 ctx 上，捕获它注册的那条
// prefix 路由，用一个本机 http server 还原 dsh 的派发行为，然后按真实调用
// 顺序打一遍端点。
//
//   node test/host.test.mjs                 # 只跑离线用例（不发上游请求）
//   VIG_KEY=xxx node test/host.test.mjs --live   # 追加上游真图用例
//
// 环境变量：
//   VIG_KEY   上游密钥（缺省读 VELAPI_API_KEY）
//   VIG_BASE  上游根，缺省 https://gank.velapi.cc/v1
//   VIG_MODEL 真图用例用的模型，缺省 gpt-image-2.5-c

import http from "node:http";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { apply } from "../lib/index.js";

const PLUGIN_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

const LIVE = process.argv.includes("--live");
const KEY = process.env.VIG_KEY || process.env.VELAPI_API_KEY || "";
const BASE = process.env.VIG_BASE || "https://gank.velapi.cc/v1";
const MODEL = process.env.VIG_MODEL || "gpt-image-2.5-c";

let failures = 0;
function check(name, ok, extra = "") {
  console.log(`${ok ? "  PASS" : "  FAIL"}  ${name}${extra ? ` — ${extra}` : ""}`);
  if (!ok) failures += 1;
}

/* ---- 1. 挂一个最小 ctx，捕获路由 ---------------------------------- */

// 素材目录的「指针」文件写在这个临时 DSH_HOME 下（换目录用例会写/删 location.json），
// 别碰真实的 ~/.dsh。
process.env.DSH_HOME = fs.mkdtempSync(path.join(os.tmpdir(), "vig-dsh-home-"));
// 单测别真去写开发机的系统剪贴板：关掉 PowerShell 兜底，专门验「写不了时如实报错」这条路
process.env.VIG_NO_CLIPBOARD = "1";
const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "vig-test-"));
const routes = [];
const ctx = {
  effect(fn) {
    const disposer = fn();
    return () => {
      try {
        if (typeof disposer === "function") disposer();
      } catch {
        /* ignore */
      }
    };
  },
  logger: { info: () => {}, warn: (...args) => console.log("  [warn]", ...args) },
  webServer: {
    register(route) {
      routes.push(route);
      return () => {};
    }
  }
};

const plugin = apply(ctx, {
  stateDir,
  baseUrl: BASE,
  apiKey: KEY,
  apiKeyEnv: "VIG_KEY",
  defaultModel: MODEL,
  concurrency: 2,
  timeoutMs: 300000,
  surfaces: ["settings"],
  guideCount: 1
});

check("apply() 注册了一条 prefix 路由", routes.length === 1 && routes[0].kind === "prefix", routes[0]?.path);
check("路由前缀是 /api/velapi-image-go", routes[0]?.path === "/api/velapi-image-go");
check("apply() 返回了只读状态视图", typeof plugin?.state?.stateDir === "string");

const route = routes[0];
const server = http.createServer((request, response) =>
  route.handler(request, response).catch((error) => {
    response.writeHead(500).end(String(error?.message ?? error));
  })
);
await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
const origin = `http://127.0.0.1:${server.address().port}`;
const API = `${origin}/api/velapi-image-go`;

async function call(pathname, init) {
  const options = { ...(init ?? {}) };
  if (options.body !== undefined && typeof options.body !== "string") {
    options.headers = { "content-type": "application/json", ...(options.headers ?? {}) };
    options.body = JSON.stringify(options.body);
  }
  const response = await fetch(`${API}${pathname}`, options);
  const text = await response.text();
  let body = null;
  try {
    body = text.length > 0 ? JSON.parse(text) : null;
  } catch {
    body = text;
  }
  return { status: response.status, body };
}

/* ---- 2. 离线用例 -------------------------------------------------- */

/* 清单闸门：dsh.client.inject 里写的是「别的客户端插件包名」（DSH 自己的模板就这么写：
   @deepseek-ai/dsh-client-ui-conversation）。以前这里写了两个根本不存在的东西
   —— dsh-client-runtime / dsh-client-ui-slots（它们是被 require 的模块，不是插件条目）。
   条目级依赖找不到只是跳过，所以这个错一直没吭声，但清单得是对的。 */
{
  const manifest = JSON.parse(fs.readFileSync(new URL("../package.json", import.meta.url), "utf8"));
  const client = manifest.dsh?.client ?? {};
  const inject = Array.isArray(client.inject) ? client.inject : [];
  check(
    "清单：dsh.client.immediately = true（页面一启动就登记，不等谁先来 require 我们）",
    client.immediately === true,
    JSON.stringify(client)
  );
  check(
    "清单：inject 全是真实存在的插件条目（shell.overlay / 右侧栏 / 设置三个席位的作者）",
    inject.includes("@deepseek-ai/dsh-client-ui-layout") &&
      inject.includes("@deepseek-ai/dsh-client-ui-sidebar-right") &&
      inject.includes("@deepseek-ai/dsh-client-ui-settings") &&
      inject.every((name) => /^@deepseek-ai\/dsh-(client-ui|api|client)-/.test(name)) &&
      !inject.includes("@deepseek-ai/dsh-client-runtime") &&
      !inject.includes("@deepseek-ai/dsh-client-ui-slots"),
    inject.join(",")
  );
}

const status = await call("/status");
check("GET /status 200", status.status === 200, `hasKey=${status.body?.config?.hasKey}`);
check("GET /status 报告落盘目录", path.resolve(status.body?.stateDir) === path.resolve(stateDir));

check(
  "GET /status 报告工具注册状态（没 tools 服务的 ctx 里也要如实写原因，不静默）",
  typeof status.body?.tool?.registered === "boolean" && typeof status.body?.tool?.reason === "string",
  JSON.stringify(status.body?.tool ?? null)
);
const bad = await call("/generate", { method: "POST", body: { prompt: "   " } });
check("空提示词被拒（400）", bad.status === 400 && bad.body?.code === "empty_prompt");

const unknown = await call("/nope");
check("未知端点 404", unknown.status === 404 && unknown.body?.code === "no_route");

/* 客户端自检回执：浏览器半边把「登记了哪些落点」写回宿主，落盘成文件。
   「重启后入口不见了」这种只发生在页面里的故障，全靠这条通道取证。 */
const reportEmpty = await call("/client-report");
check("GET /client-report 初始为空", reportEmpty.status === 200 && Array.isArray(reportEmpty.body?.items) && reportEmpty.body.items.length === 0);
const reportPost = await call("/client-report", {
  method: "POST",
  body: { phase: "settled", at: "2026-10-18T13:20:00.000Z", detail: { rightbarReady: false, rightbarWaiting: true, sidebarRightTabs: false } }
});
check("POST /client-report 收下回执", reportPost.status === 200 && reportPost.body?.kept === 1, JSON.stringify(reportPost.body));
const reportBack = await call("/client-report");
check(
  "回执落盘且能读回（phase/detail/at 原样）",
  reportBack.body?.items?.[0]?.phase === "settled" &&
    reportBack.body?.items?.[0]?.detail?.rightbarWaiting === true &&
    reportBack.body?.items?.[0]?.at === "2026-10-18T13:20:00.000Z"
);
check("回执文件就在 stateDir 下", fs.readFileSync(path.join(stateDir, "client-report.json"), "utf8").includes("sidebarRightTabs"));
for (let index = 0; index < 14; index += 1) {
  await call("/client-report", { method: "POST", body: { phase: `probe-${index}`, detail: null } });
}
const reportTrimmed = await call("/client-report");
check(
  "回执只留最近 12 条（不会无限涨）",
  reportTrimmed.body?.items?.length === 12 && reportTrimmed.body.items[0].phase === "probe-13",
  `实际 ${reportTrimmed.body?.items?.length}`
);

// 自定义快捷键：客户端丢一个 JSON 串过来，宿主原样存进 config.json，换端口也能捞回来
const keysBefore = await call("/config");
check("GET /config 默认带 shortcuts 字段（空串）", keysBefore.status === 200 && keysBefore.body?.config?.shortcuts === "");
const keysSave = await call("/config", { method: "POST", body: { shortcuts: '{"tool.select":"alt+1","undo":""}' } });
check("POST /config 存 shortcuts", keysSave.status === 200 && keysSave.body?.config?.shortcuts === '{"tool.select":"alt+1","undo":""}');
const keysRead = await call("/config");
check("GET /config 读回 shortcuts", keysRead.body?.config?.shortcuts === '{"tool.select":"alt+1","undo":""}');
const keysTooLong = await call("/config", { method: "POST", body: { shortcuts: "x".repeat(5000) } });
check("超长 shortcuts 被丢（不覆盖已存的）", keysTooLong.body?.config?.shortcuts === '{"tool.select":"alt+1","undo":""}');
check("config.json 里确实落了盘", fs.readFileSync(path.join(stateDir, "config.json"), "utf8").includes("alt+1"));

const note = await call("/notes", { method: "POST", body: { title: "测试信息", prompt: "一只在窗台上睡觉的橘猫", tags: ["测试"] } });
check("POST /notes 建信息", note.status === 200 && note.body?.items?.length === 1);
const notes = await call("/notes");
check("GET /notes 读回信息", notes.body?.items?.[0]?.title === "测试信息");
await call("/notes/delete", { method: "POST", body: { id: note.body.item.id } });
const notes2 = await call("/notes");
check("POST /notes/delete 删除信息", notes2.body?.items?.length === 0);

const tinyPng =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFAAH/q842iQAAAABJRU5ErkJggg==";
const upload = await call("/upload", { method: "POST", body: { name: "ref.png", data: `data:image/png;base64,${tinyPng}` } });
check("POST /upload 收参考图", upload.status === 200 && upload.body?.item?.format === "png", upload.body?.item?.url);
const fetched = await fetch(`${origin}${upload.body?.item?.url}`);
check("GET /upload/<file> 回图字节", fetched.status === 200 && fetched.headers.get("content-type") === "image/png");
check("静态原图嗅探后仍从零偏移流出，长度和每个字节均不变", Number(fetched.headers.get("content-length")) === Buffer.from(tinyPng, "base64").length && Buffer.from(await fetched.arrayBuffer()).equals(Buffer.from(tinyPng, "base64")));

const escape = await fetch(`${origin}/api/velapi-image-go/asset/..%2f..%2fconfig.json`);
check("静态端点挡住路径穿越", escape.status === 404);

const providers = await call("/providers");
check("GET /providers 有默认供应商", providers.body?.items?.length === 1);

/* ---- 2b. 模型目录：分类跟着中转站的 family 元数据 ------------------ *
 * 假的 `/v1/models`：一条带 image_family、一条带 video_family（omni 那种）、一条未开通。
 * 断言的是「kind 从 family 里读出来并落到供应商记录的 modelMeta」，不是靠名字猜。 */

const catalogServer = http.createServer((request, response) => {
  if (!String(request.url).endsWith("/models")) {
    response.writeHead(404).end("{}");
    return;
  }
  response.writeHead(200, { "content-type": "application/json" });
  response.end(
    JSON.stringify({
      data: [
        { id: "fake-image", object: "model", enabled: true, image_family: { kind: "image", label: "Fake Image", profiles: [{ mode: "t2i" }] } },
        { id: "omni-flash", object: "model", enabled: true, video_family: { kind: "video", label: "Omni Flash", profiles: [{ mode: "t2v" }, { mode: "r2v" }] } },
        { id: "imagen-4", object: "model", enabled: false, image_family: { kind: "image", label: "Imagen 4" } }
      ]
    })
  );
});
await new Promise((resolve) => catalogServer.listen(0, "127.0.0.1", resolve));
const catalogOrigin = `http://127.0.0.1:${catalogServer.address().port}`;

const createdProvider = await call("/providers", {
  method: "POST",
  body: { id: "catalog", name: "目录测试", baseUrl: catalogOrigin, apiKey: "sk-test", useRuntimeKey: false }
});
check("POST /providers 建供应商", createdProvider.status === 200 && createdProvider.body?.item?.id === "catalog");

const refreshed = await call("/models/refresh", { method: "POST", body: { providerId: "catalog" } });
check("POST /models/refresh 回 id 数组与条目", refreshed.status === 200 && refreshed.body?.models?.join(",") === "fake-image,imagen-4,omni-flash", JSON.stringify(refreshed.body?.models));
check(
  "refresh 的条目带 kind（family 权威值）",
  refreshed.body?.items?.find((item) => item.id === "omni-flash")?.kind === "video" &&
    refreshed.body?.items?.find((item) => item.id === "fake-image")?.kind === "image"
);
check("refresh 记下未开通的模型", refreshed.body?.items?.find((item) => item.id === "imagen-4")?.enabled === false);

const afterCatalog = await call("/providers");
const catalogProvider = afterCatalog.body?.items?.find((item) => item.id === "catalog");
check("modelMeta 落到供应商记录", catalogProvider?.modelMeta?.["omni-flash"]?.kind === "video", JSON.stringify(catalogProvider?.modelMeta?.["omni-flash"]));
check("modelMeta 保留未开通标记", catalogProvider?.modelMeta?.["imagen-4"]?.enabled === false);
check("modelMeta 不带密钥", !JSON.stringify(catalogProvider ?? {}).includes("sk-test"));

const catalogList = await call("/models?providerId=catalog");
check("GET /models 回目录条目（含 models id 数组）", catalogList.body?.items?.length === 3 && catalogList.body?.models?.length === 3);
await new Promise((resolve) => catalogServer.close(resolve));

/* ---- 2c. 预设卡：内置种子 + 增删改 + 随包参考图 -------------------- */

const presets = await call("/presets");
check("GET /presets 带内置预设卡", presets.status === 200 && (presets.body?.items?.length ?? 0) >= 6, `${presets.body?.items?.length} 张`);
check("内置卡里有带参考图的（趣味预设）", presets.body?.items?.some((item) => item.builtin && /\/preset\/.+\.png$/.test(item.image)));
check("内置卡也带提示词", presets.body?.items?.every((item) => item.prompt.length > 0));
check("预设卡出现在 /status 首屏", Array.isArray(status.body?.presets) && status.body.presets.length >= 6 && status.body?.counts?.presets === status.body.presets.length);

const seeded = presets.body.items.find((item) => item.image.includes("/preset/"));
const coverName = seeded.image.split("/").pop();
const cover = await fetch(`${origin}/api/velapi-image-go/preset/${coverName}`);
const coverBytes = Buffer.from(await cover.arrayBuffer());
check("随包参考图能取回且是 PNG", cover.status === 200 && coverBytes[0] === 0x89 && coverBytes.toString("latin1", 1, 4) === "PNG", `${coverBytes.length} bytes`);

const presetSave = await call("/presets", {
  method: "POST",
  body: { title: "测试预设", prompt: "一张测试用的极简插画", image: "/api/velapi-image-go/preset/ink-landscape.png", tags: ["测试"] }
});
check("POST /presets 新建一张卡", presetSave.status === 200 && presetSave.body?.item?.id && presetSave.body.items[0].title === "测试预设");
const customId = presetSave.body?.item?.id;

const presetEdit = await call("/presets", { method: "POST", body: { id: customId, title: "测试预设（改）", prompt: "改过的提示词", image: "" } });
check("POST /presets 改一张卡（参考图可清空）", presetEdit.body?.items?.find((item) => item.id === customId)?.title === "测试预设（改）" && presetEdit.body.items.find((item) => item.id === customId)?.image === "");

const presetBad = await call("/presets", { method: "POST", body: { title: "空卡", prompt: "", image: "" } });
check("提示词与参考图都空则拒收（400）", presetBad.status === 400 && presetBad.body?.code === "empty_preset");

const presetOutsider = await call("/presets", { method: "POST", body: { title: "外站图", prompt: "x", image: "https://example.com/a.png" } });
check("参考图只收本站路径或 dataURL", presetOutsider.body?.item?.image === "");

const presetDelete = await call("/presets/delete", { method: "POST", body: { id: customId } });
check("POST /presets/delete 删掉", !presetDelete.body?.items?.some((item) => item.id === customId));

const presetReset = await call("/presets/reset", { method: "POST", body: {} });
check("POST /presets/reset 找回内置卡", (presetReset.body?.items?.length ?? 0) >= 6);
const presetAgain = await call("/presets");
check("预设卡落盘可读回", presetAgain.body?.items?.length === presetReset.body.items.length);

const presetEscape = await fetch(`${origin}/api/velapi-image-go/preset/..%2f..%2fconfig.json`);
check("预设静态端点挡住路径穿越", presetEscape.status === 404);

/* ---- 2d. 上游报错留原始证据 + 端点协议决定路由 -------------------- */

/* 假上游：只认自己那张表，不出网、不连真中转站。
   按**请求路径**回包，不用全局模式开关 —— 队列里有并发，模式开关会在切换的瞬间被
   还在跑的任务读到，用例就会时绿时红（踩过：视频那条偶发拿到 502）。 */
const mockHits = [];
const hitPaths = () => mockHits.map((hit) => hit.url);
const mockServer = http.createServer((request, response) => {
  const chunks = [];
  request.on("data", (chunk) => chunks.push(chunk));
  request.on("end", () => {
    const raw = Buffer.concat(chunks).toString("utf8");
    let payload = null;
    try {
      payload = JSON.parse(raw || "null");
    } catch {
      payload = null;
    }
    const path = String(request.url || "");
    mockHits.push({
      method: request.method,
      url: path,
      auth: request.headers.authorization ?? "",
      body: payload,
      raw,
      contentType: String(request.headers["content-type"] ?? "")
    });
    /* 模型目录：用来验「key 是 A 家的、地址填的是 B 家」时那条解释（要有一家认这把 key）。 */
    const isModels = path.includes("/models") && String(request.method || "GET").toUpperCase() === "GET";
    /* 对话上下文管理：/chat/completions 回一个 JSON 计划；提示词里带「坏JSON」就回非 JSON（验容错） */
    const isChat = path.includes("/chat/completions");
    /* 只看最后一条 user 消息来分支 —— 系统提示词的示例里也有这些词，整包搜会全部误判 */
    const lastUserMessage = Array.isArray(payload?.messages)
      ? [...payload.messages].reverse().find((message) => message.role === "user")?.content ?? ""
      : "";
    const wantsBadPlan = String(lastUserMessage).includes("坏JSON");
    const wantsReply = String(lastUserMessage).includes("乱搞");
    const wantsEditPlan = String(lastUserMessage).includes("在上一张");
    const chatPlan = {
      choices: [
        {
          message: {
            content: wantsBadPlan
              ? "这不是 JSON，是一次跑偏的回答"
              : wantsReply
                ? JSON.stringify({
                    action: "reply",
                    prompt: "",
                    reply: "抱歉，S3 指的是你参考图里那台扫地机器人；我刚才多加了个人形机器人，不会这样改。",
                    referenceUrl: "",
                    reason: "用户在纠正理解，不该再出图"
                  })
                : wantsEditPlan
                  ? JSON.stringify({
                      action: "edit",
                      prompt: "在上一张图基础上：仓库更干净、光线更柔和，主体不变",
                      referenceUrl: "",
                      reason: "在最近一张结果图上改"
                    })
                  : JSON.stringify({
                      action: "generate",
                      prompt: "一只戴眼镜的橘猫，柔和顶光，浅灰背景",
                      mode: "generate",
                      referenceUrl: "",
                      reason: "用户嫌上一轮太夸张，改成柔和版本"
                    })
          }
        }
      ]
    };
    const video = path.includes("/videos/generations");
    /* 过程留痕用例：提示词里带「留痕」才回一张真 PNG（1x1），别的照旧 502。
       只在需要成功回包的一条路上开口子，其余断言不受影响。 */
    const provenanceOk = !video && path.includes("/images/generations") && String(payload?.prompt ?? "").includes("留痕");
    const body = isModels
      ? JSON.stringify({ data: [{ id: "mock-image" }, { id: "mock-model-b" }, { id: "mock-bad" }] })
      : isChat
        ? JSON.stringify(
            (() => {
              const chatMessages = Array.isArray(payload?.messages) ? payload.messages : [];
              const hasToolResult = chatMessages.some((item) => item?.role === "tool");
              if (Array.isArray(payload?.tools) && payload.tools.length > 0 && !hasToolResult) {
                // 第一轮：模型决定调 generate_image 工具
                return {
                  choices: [
                    {
                      index: 0,
                      finish_reason: "tool_calls",
                      message: {
                        role: "assistant",
                        content: "",
                        tool_calls: [
                          {
                            id: "call_mock_1",
                            type: "function",
                            function: {
                              name: "generate_image",
                              arguments: JSON.stringify({ prompt: "一只戴眼镜的橘猫，柔和顶光", count: 1 })
                            }
                          }
                        ]
                      }
                    }
                  ]
                };
              }
              // 第二轮（带 tool 结果）：模型用一句话收尾
              return hasToolResult
                ? { choices: [{ index: 0, finish_reason: "stop", message: { role: "assistant", content: "图我没能生成出来（上游 502），可以稍后重试。" } }] }
                : chatPlan;
            })()
          )
        : video
          ? JSON.stringify({ id: "vid_1", status: "processing", data: [{ url: "https://cdn.example.com/v.mp4" }] })
          : provenanceOk
            ? JSON.stringify({
                created: Math.floor(Date.now() / 1000),
                data: [
                  {
                    b64_json: "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
                    revised_prompt: "上游改过的那句留痕提示词"
                  }
                ]
              })
            : JSON.stringify({ error: { message: "生成请求失败，请查看具体上游错误", type: "upstream_error", code: "bad_gateway" } });
    response.writeHead(isModels || isChat || video || provenanceOk ? 200 : 502, {
      "content-type": "application/json",
      "content-length": Buffer.byteLength(body)
    });
    response.end(body);
  });
});
await new Promise((resolve) => mockServer.listen(0, "127.0.0.1", resolve));
const mockBase = `http://127.0.0.1:${mockServer.address().port}/v1`;

let mockProvider = null;
async function saveMockProvider(patch) {
  const saved = await call("/providers", {
    method: "POST",
    body: { name: "假上游", baseUrl: mockBase, apiKey: "sk-mock", models: ["mock-image"], ...patch }
  });
  return saved.body?.item ?? null;
}
/** 入队并等到终态。等 20s：本机假上游是毫秒级，超时说明真出事了（详情里会带状态）。 */
async function runMockJob(prompt, extra = {}) {
  const created = await call("/generate", {
    method: "POST",
    body: { prompt, providerId: mockProvider?.id ?? "", model: "mock-image", size: "1024x1024", n: 1, ...extra }
  });
  if (created.status !== 200) return { job: null, created };
  let last = null;
  for (let i = 0; i < 200; i += 1) {
    const polled = await call(`/job?id=${encodeURIComponent(created.body.job.id)}`);
    last = polled.body?.job ?? last;
    if (last && last.status !== "queued" && last.status !== "running") return { job: last, created };
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  return { job: last, created };
}

const protocols = await call("/status");
const protocolIds = (protocols.body?.protocols ?? []).map((row) => row.id);
check(
  "GET /status 给出端点协议表（自动检测 + 生图/编辑/视频三条链）",
  ["auto", "images_generations", "images_edits", "videos_generations"].every((id) => protocolIds.includes(id)) &&
    (protocols.body?.protocols ?? []).every((row) => typeof row.label === "string" && row.label.length > 0),
  protocolIds.join(",")
);

mockProvider = await saveMockProvider({ endpoint: "images_generations" });
check(
  "供应商能记住端点协议（存 id，界面拿 label / route）",
  mockProvider?.endpoint === "images_generations" &&
    mockProvider?.endpointRoute === "/images/generations" &&
    /图片生成/.test(mockProvider?.endpointLabel ?? ""),
  JSON.stringify(mockProvider)
);

mockHits.length = 0;
const failedJob = await runMockJob("上游会 502 的一次");
check(
  "上游 502 → 任务失败，文案就是中转站自己那句",
  failedJob.job?.status === "failed" &&
    failedJob.job?.error === "生成请求失败，请查看具体上游错误" &&
    failedJob.job?.errorCode === "bad_gateway",
  `${failedJob.job?.status} / ${failedJob.job?.errorCode}`
);
check(
  "失败任务留下原始证据：HTTP 状态 + 响应体原文 + 请求地址 + 模型",
  failedJob.job?.errorDetail?.status === 502 &&
    String(failedJob.job?.errorDetail?.body ?? "").includes("bad_gateway") &&
    failedJob.job?.errorDetail?.url === `${mockBase}/images/generations` &&
    failedJob.job?.errorDetail?.model === "mock-image",
  JSON.stringify(failedJob.job?.errorDetail ?? null)
);
check(
  "任务记下实际打的那条路由（界面上能直接显示）",
  failedJob.job?.endpoint === "/images/generations" && hitPaths().includes("/v1/images/generations"),
  `${failedJob.job?.endpoint} / ${hitPaths().join(",")}`
);
check("上游请求照旧带鉴权头", mockHits.some((hit) => hit.auth === "Bearer sk-mock"), mockHits[0]?.auth ?? "");

mockProvider = await saveMockProvider({ id: mockProvider.id, endpoint: "images_edits" });
mockHits.length = 0;
const PNG_FOR_EDIT = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";
await runMockJob("编辑协议", { size: "4K", aspect_ratio: "21:9", mode: "edit", image: `data:image/png;base64,${PNG_FOR_EDIT}` });
check("协议=图片编辑（带参考图）→ 打到 /v1/images/edits", hitPaths().includes("/v1/images/edits"), hitPaths().join(","));
/* 图生图必须 multipart：JSON + base64 会被 GPT 系模型回 400
   image file or image_url is required（用户截图那条） */
{
  const editHit = mockHits.filter((hit) => hit.url === "/v1/images/edits").pop();
  check("编辑协议：4K 和 21:9 是两个独立表单字段", /name="size"\r?\n\r?\n4K/.test(editHit?.raw) && /name="aspect_ratio"\r?\n\r?\n21:9/.test(editHit?.raw));
  check(
    "图生图走 multipart/form-data：image 是文件字段，model/prompt/size/n 都在",
    Boolean(editHit) &&
      String(editHit.contentType).startsWith("multipart/form-data") &&
      /name="image"/.test(editHit.raw) &&
      /filename="reference_1\.png"/.test(editHit.raw) &&
      /name="model"/.test(editHit.raw) &&
      /name="prompt"/.test(editHit.raw) &&
      /name="size"/.test(editHit.raw) &&
      /name="n"/.test(editHit.raw) &&
      !editHit.raw.trim().startsWith("{"),
    JSON.stringify({ contentType: editHit?.contentType, head: String(editHit?.raw ?? "").slice(0, 120) })
  );

}
/* 只选了编辑协议、却没带参考图：回落到生成，别发一条注定 400 的请求 */
mockHits.length = 0;
await runMockJob("编辑协议但没图");
check(
  "编辑协议但没参考图 → 回落图片生成（不硬发 edits）",
  hitPaths().includes("/v1/images/generations") && !hitPaths().includes("/v1/images/edits"),
  hitPaths().join(",")
);
/* 「用这条提示词重试」：历史里只留了 referenceUrl，宿主得从 uploads 把字节读回来再发 multipart */
{
  const uploaded = await call("/upload", { method: "POST", body: { name: "retry-edit.png", data: `data:image/png;base64,${PNG_FOR_EDIT}` } });
  const refUrl = uploaded.body?.item?.url ?? "";
  mockHits.length = 0;
  const retried = await call("/generate", {
    method: "POST",
    body: { prompt: "重试图生图", providerId: mockProvider.id, model: "mock-image", size: "512x512", n: 1, mode: "edit", referenceUrl: refUrl, endpoint: "images_edits" }
  });
  check("带 referenceUrl 的编辑任务能入队（参考图字节从 uploads 读回）", retried.status === 200 && Boolean(retried.body?.job?.id), JSON.stringify(retried.body ?? null));
  await pollJob(retried.body?.job?.id);
  const retryHit = mockHits.filter((hit) => hit.url === "/v1/images/edits").pop();
  check(
    "重试的图生图同样走 multipart（没有 image 字段也有文件）",
    Boolean(retryHit) && String(retryHit.contentType).startsWith("multipart/form-data") && /name="image"/.test(retryHit.raw) && /filename="reference_1\.png"/.test(retryHit.raw),
    JSON.stringify({ contentType: retryHit?.contentType, head: String(retryHit?.raw ?? "").slice(0, 100) })
  );
}
/* 假图防御：客户端曾把参考图 URL 字符串（/api/.../asset/xxx.png）当 image 发来，
   裸 base64 解出 37 字节假图、原样转发给上游吃 400（无法识别的二进制格式）。 */
{
  const urlAsImage = await call("/generate", {
    method: "POST",
    body: { prompt: "URL 当图发", providerId: mockProvider.id, model: "mock-image", size: "512x512", n: 1, mode: "edit", image: "/api/velapi-image-go/asset/img_ab12cd34.png", endpoint: "images_edits" }
  });
  check(
    "image 字段是 URL 字符串 → 400 missing_reference，不转发假图给上游",
    urlAsImage.status === 400 && urlAsImage.body?.code === "missing_reference",
    JSON.stringify({ status: urlAsImage.status, code: urlAsImage.body?.code })
  );
  const corrupt = path.join(stateDir, "uploads", "corrupt-ref.png");
  fs.mkdirSync(path.dirname(corrupt), { recursive: true });
  fs.writeFileSync(corrupt, "这是一段文本，不是图片内容，用来冒充参考图。");
  const corruptRef = await call("/generate", {
    method: "POST",
    body: { prompt: "坏参考图", providerId: mockProvider.id, model: "mock-image", size: "512x512", n: 1, mode: "edit", referenceUrl: "/api/velapi-image-go/upload/corrupt-ref.png", endpoint: "images_edits" }
  });
  check(
    "referenceUrl 指到的文件不是图 → 400 missing_reference，不硬发",
    corruptRef.status === 400 && corruptRef.body?.code === "missing_reference",
    JSON.stringify({ status: corruptRef.status, code: corruptRef.body?.code })
  );
  const bareBase64 = await call("/generate", {
    method: "POST",
    body: { prompt: "裸 base64 编辑", providerId: mockProvider.id, model: "mock-image", size: "512x512", n: 1, mode: "edit", image: PNG_FOR_EDIT, endpoint: "images_edits" }
  });
  check(
    "裸 base64 的真 PNG 仍然接受（魔数验证通过）",
    bareBase64.status === 200 && Boolean(bareBase64.body?.job?.id),
    JSON.stringify({ status: bareBase64.status, code: bareBase64.body?.code })
  );
  await pollJob(bareBase64.body?.job?.id);
}
/* 多参考图：images 数组 + referenceUrls 一起上，multipart 每张一个 image 字段 */
{
  const PNG_ALT = "iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAYAAABytg0kAAAAEklEQVR4nGP8z8DwnwEJMDEgAQBFaBFroU0UuAAAAABJRU5ErkJggg==";
  const uploadedB = await call("/upload", { method: "POST", body: { name: "ref-b.png", data: `data:image/png;base64,${PNG_ALT}` } });
  const refUrlB = uploadedB.body?.item?.url ?? "";
  mockHits.length = 0;
  const multi = await call("/generate", {
    method: "POST",
    body: {
      prompt: "多参考图编辑",
      providerId: mockProvider.id,
      model: "mock-image",
      size: "1024x1024",
      n: 1,
      mode: "edit",
      images: [`data:image/png;base64,${PNG_FOR_EDIT}`, `data:image/png;base64,${PNG_ALT}`],
      referenceUrls: [refUrlB],
      endpoint: "images_edits"
    }
  });
  check(
    "多参考图任务能入队（2 张字节图 + 1 张 URL 图）",
    multi.status === 200 && Boolean(multi.body?.job?.id) && multi.body?.job?.referenceUrls?.length === 1 && multi.body?.job?.referenceUrl === refUrlB,
    JSON.stringify({ status: multi.status, urls: multi.body?.job?.referenceUrls })
  );
  await pollJob(multi.body?.job?.id);
  const multiHit = mockHits.filter((hit) => hit.url === "/v1/images/edits").pop();
  const imageFields = multiHit ? (multiHit.raw.match(/name="image"/g) || []).length : 0;
  check(
    "多参考图走 multipart：3 张图各占一个 image 字段（reference_1/2/3）",
    Boolean(multiHit) && imageFields === 3 && /filename="reference_1\.png"/.test(multiHit.raw) && /filename="reference_2\.png"/.test(multiHit.raw) && /filename="reference_3\.png"/.test(multiHit.raw),
    JSON.stringify({ fields: imageFields, head: String(multiHit?.raw ?? "").slice(0, 80) })
  );
  /* 局部改图：mask（白=重画）随编辑一起走 multipart 的 mask 字段 */
  mockHits.length = 0;
  const masked = await call("/generate", {
    method: "POST",
    body: {
      prompt: "把框选的区域换成金属材质",
      providerId: mockProvider.id,
      model: "mock-image",
      size: "512x512",
      n: 1,
      mode: "edit",
      endpoint: "images_edits",
      images: [`data:image/png;base64,${PNG_FOR_EDIT}`],
      mask: `data:image/png;base64,${PNG_ALT}`
    }
  });
  check(
    "局部改图任务能入队（images + mask）",
    masked.status === 200 && Boolean(masked.body?.job?.id),
    JSON.stringify({ status: masked.status, code: masked.body?.code })
  );
  await pollJob(masked.body?.job?.id);
  const maskHit = mockHits.filter((hit) => hit.url === "/v1/images/edits").pop();
  check(
    "mask 走 multipart 的 mask 字段（filename=mask.png）",
    Boolean(maskHit) && /name="mask"/.test(maskHit.raw) && /filename="mask\.png"/.test(maskHit.raw),
    JSON.stringify({ head: String(maskHit?.raw ?? "").slice(0, 80) })
  );
  /* 假图混进数组：跳过坏的，好的照发 */
  mockHits.length = 0;
  const mixed = await call("/generate", {
    method: "POST",
    body: {
      prompt: "混入假图的编辑",
      providerId: mockProvider.id,
      model: "mock-image",
      size: "512x512",
      n: 1,
      mode: "edit",
      images: ["/api/velapi-image-go/asset/img_fake.png", `data:image/png;base64,${PNG_FOR_EDIT}`],
      endpoint: "images_edits"
    }
  });
  check(
    "images 数组里混 URL 字符串：跳过假图只发真图，不回 400",
    mixed.status === 200 && Boolean(mixed.body?.job?.id),
    JSON.stringify({ status: mixed.status, code: mixed.body?.code })
  );
  await pollJob(mixed.body?.job?.id);
}

mockProvider = await saveMockProvider({ id: mockProvider.id, endpoint: "videos_generations" });
mockHits.length = 0;
const videoJob = await runMockJob("视频协议");
check("协议=视频生成 → 打到 /v1/videos/generations", hitPaths().includes("/v1/videos/generations"), hitPaths().join(","));
check(
  "视频任务不假装出图：原样收下任务体，能认出地址就给出来",
  videoJob.job?.status === "succeeded" &&
    videoJob.job?.images?.length === 0 &&
    videoJob.job?.video?.url === "https://cdn.example.com/v.mp4" &&
    typeof videoJob.job?.video?.payload === "object",
  JSON.stringify(videoJob.job?.video ?? null)
);

/* 视频时长：秒数落到上游 body（OpenAI 视频接口的 seconds），缺省回落 4 */
mockHits.length = 0;
await runMockJob("视频带时长", { seconds: "8" });
{
  const hit = mockHits.find((item) => item.url.includes("/videos/generations"));
  check("视频时长：请求里的 seconds 落到上游 body（8 秒）", hit?.body?.seconds === "8", JSON.stringify({ seconds: hit?.body?.seconds ?? null }));
}
mockHits.length = 0;
await runMockJob("视频默认时长");
{
  const hit = mockHits.find((item) => item.url.includes("/videos/generations"));
  check("视频时长缺省回落 4 秒（不传也不会漏字段）", hit?.body?.seconds === "4", JSON.stringify({ seconds: hit?.body?.seconds ?? null }));
}
/* 视频比例 / 分辨率：原生字段（aspect_ratio + resolution）跟 size 像素一起带（Kling/Seedance/Veo 系认原生字段） */
{
  await call("/config", { method: "POST", body: { videoRatio: "9:16", videoResolution: "1080p" } });
  mockHits.length = 0;
  await runMockJob("视频原生字段");
  const hit = mockHits.find((item) => item.url.includes("/videos/generations"));
  check(
    "视频请求同时带原生字段（aspect_ratio=9:16 / resolution=1080p）与像素 size",
    hit?.body?.aspect_ratio === "9:16" && hit?.body?.resolution === "1080p" && typeof hit?.body?.size === "string",
    JSON.stringify({ aspect_ratio: hit?.body?.aspect_ratio ?? null, resolution: hit?.body?.resolution ?? null, size: hit?.body?.size ?? null })
  );
  await call("/config", { method: "POST", body: { videoRatio: "16:9", videoResolution: "720p" } });
}

const weirdProtocol = await saveMockProvider({ id: mockProvider.id, endpoint: "chatgpt-ultra" });
check("认不出的协议回落成「自动检测」，不把生成打死", weirdProtocol?.endpoint === "auto", weirdProtocol?.endpoint);

mockHits.length = 0;
await runMockJob("自动检测");
check(
  "自动检测：不带参考图走 /images/generations（老行为不变）",
  hitPaths().includes("/v1/images/generations"),
  hitPaths().join(",")
);

/* ---- 更新通道 /update/check ----------------------------------------
   用本地临时 git 仓库当 remote：ls-remote 对本地路径同样有效，不依赖网络。 */
{
  const tmpRemote = fs.mkdtempSync(path.join(os.tmpdir(), "vig-remote-"));
  const git = (args, cwd) => execFileSync("git", args, { cwd, windowsHide: true });
  git(["init", "-q", "-b", "main"], tmpRemote);
  git(["config", "user.name", "test"], tmpRemote);
  git(["config", "user.email", "test@example.com"], tmpRemote);
  fs.writeFileSync(path.join(tmpRemote, "a.txt"), "x");
  git(["add", "-A"], tmpRemote);
  git(["commit", "-q", "-m", "first"], tmpRemote);
  const ahead = await call("/update/check", { method: "POST", body: { remote: tmpRemote } });
  check(
    "更新通道：远端有别的提交 → code=behind + 短 SHA",
    ahead.body?.code === "behind" && ahead.body?.available === true && /^[0-9a-f]{7}$/.test(String(ahead.body?.short?.remote ?? "")),
    JSON.stringify({ code: ahead.body?.code, remote: ahead.body?.short?.remote })
  );
  const pkgVersion = JSON.parse(fs.readFileSync(path.join(PLUGIN_ROOT, "package.json"), "utf8")).version;
  const localBuild = await call("/update/check", { method:"POST", body:{localOnly:true, remote:path.join(tmpRemote,"not-a-remote")} });
  check("离线首屏使用本地包版本与安装目录 HEAD，不访问远端", localBuild.body?.code === "local" && localBuild.body.packageVersion === pkgVersion && localBuild.body.localSha === String(git(["rev-parse", "HEAD"], PLUGIN_ROOT)).trim());
  for (const api of ["/status", "/capabilities"]) check(api + " 报告实际加载的包版本", (await call(api)).body?.version === pkgVersion);
  const same = await call("/update/check", { method: "POST", body: { remote: PLUGIN_ROOT } });
  check(
    "更新通道：远端 = 本地仓库 → code=latest（已是最新）",
    same.body?.code === "latest" && same.body?.latest === true && Boolean(same.body?.short?.local),
    JSON.stringify({ code: same.body?.code, local: same.body?.short?.local })
  );
  const unreachable = await call("/update/check", { method: "POST", body: { remote: path.join(tmpRemote, "no-such-repo") } });
  check(
    "更新通道：远端不可达 → code=remote_unreachable + hint（不让界面以为有新版本）",
    unreachable.body?.code === "remote_unreachable" && unreachable.body?.available === false && Boolean(unreachable.body?.hint),
    JSON.stringify({ code: unreachable.body?.code })
  );

  /* /update/apply：已最新时不动仓库；远端不可达时给原因（不 execute 危险的 pull） */
  const applySame = await call("/update/apply", { method: "POST", body: { remote: PLUGIN_ROOT } });
  check(
    "更新通道：/update/apply 在已最新时不动仓库（pulled=false）",
    applySame.body?.pulled === false && applySame.body?.code === "latest" && Boolean(applySame.body?.short?.from),
    JSON.stringify({ code: applySame.body?.code, pulled: applySame.body?.pulled })
  );
  const applyBad = await call("/update/apply", { method: "POST", body: { remote: path.join(tmpRemote, "no-such-repo") } });
  check(
    "更新通道：/update/apply 远端不可达 → remote_unreachable（不执行 pull）",
    applyBad.body?.ok === false && applyBad.body?.code === "remote_unreachable",
    JSON.stringify({ code: applyBad.body?.code })
  );
  fs.rmSync(tmpRemote, { recursive: true, force: true });
}

/* ---- 模型属于谁就打到谁那儿 --------------------------------------
   踩过：provider 管理里加了两条链（grok / GPT），模型选了 GPT 的 gpt-image-2.5-c，
   但「当前供应商」还停在 grok、请求里的 providerId 也还指着 grok —— 于是 POST 打到
   api.velapi.cc，回 503「No available channel for model gpt-image-2.5-c under group grok」。
   现在：模型目录里有它的那条供应商优先，谁拥有模型就打到谁那儿。 */
const hitsB = [];
const mockBServer = http.createServer((request, response) => {
  const chunks = [];
  request.on("data", (chunk) => chunks.push(chunk));
  request.on("end", () => {
    hitsB.push(String(request.url || ""));
    const body = JSON.stringify({ data: [{ b64_json: "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==" }] });
    response.writeHead(200, { "content-type": "application/json", "content-length": Buffer.byteLength(body) });
    response.end(body);
  });
});
await new Promise((resolve) => mockBServer.listen(0, "127.0.0.1", resolve));
const mockBBase = `http://127.0.0.1:${mockBServer.address().port}/v1`;
const providerB = (
  await call("/providers", {
    method: "POST",
    body: { name: "假上游 B", baseUrl: mockBBase, apiKey: "sk-mock-b", models: ["mock-model-b"], endpoint: "images_generations" }
  })
).body?.item ?? null;
check(
  "备好第二条供应商链（它自己目录里是 mock-model-b）",
  Boolean(providerB?.id) && Array.isArray(providerB?.models) && providerB.models.includes("mock-model-b"),
  providerB?.id ?? ""
);
async function pollJob(id) {
  let last = null;
  for (let i = 0; i < 100; i += 1) {
    const polled = await call(`/job?id=${encodeURIComponent(id)}`);
    last = polled.body?.job ?? last;
    if (last && last.status !== "queued" && last.status !== "running") return last;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  return last;
}

/* 1) 当前供应商 = A，请求却点名 A，模型是 B 的 → 应该换到 B */
await call("/config", { method: "POST", body: { activeProviderId: mockProvider.id } });
mockHits.length = 0;
hitsB.length = 0;
const toOwner = await call("/generate", {
  method: "POST",
  body: { prompt: "模型归属 B", providerId: mockProvider.id, model: "mock-model-b", size: "512x512", n: 1, endpoint: "images_generations" }
});
const toOwnerJob = await pollJob(toOwner.body?.job?.id);
check(
  "生成：模型属于 B（虽然请求点名的是 A）→ 实际发给 B，任务也记下 B",
  toOwnerJob?.providerId === providerB.id && hitsB.includes("/v1/images/generations") && !mockHits.includes("/v1/images/generations"),
  JSON.stringify({ providerId: toOwnerJob?.providerId, hitsB: hitsB.join(","), hitsA: mockHits.map((hit) => hit.url).join(",") })
);

/* 2) 没人点名（providerId 空），当前供应商 = B，模型是 A 的 → 按模型发给 A */
await call("/config", { method: "POST", body: { activeProviderId: providerB.id } });
mockHits.length = 0;
hitsB.length = 0;
const toA = await call("/generate", {
  method: "POST",
  body: { prompt: "模型归属 A", providerId: "", model: "mock-image", size: "512x512", n: 1, endpoint: "images_generations" }
});
const toAJob = await pollJob(toA.body?.job?.id);
check(
  "生成：当前供应商是 B、模型是 A 的 → 不跟着当前供应商跑，按模型发给 A",
  toAJob?.providerId === mockProvider.id && mockHits.some((hit) => hit.url === "/v1/images/generations") && hitsB.length === 0,
  JSON.stringify({ providerId: toAJob?.providerId, hitsA: mockHits.map((hit) => hit.url).join(","), hitsB: hitsB.join(",") })
);

/* 3) 点名的供应商确实拥有这个模型 → 尊重它，不乱换 */
mockHits.length = 0;
hitsB.length = 0;
const explicitOwner = await call("/generate", {
  method: "POST",
  body: { prompt: "模型归属 B 显式", providerId: providerB.id, model: "mock-model-b", size: "512x512", n: 1, endpoint: "images_generations" }
});
const explicitOwnerJob = await pollJob(explicitOwner.body?.job?.id);
check(
  "生成：点名的供应商确实有该模型 → 不换，仍发给它（且能成功出图）",
  explicitOwnerJob?.providerId === providerB.id && explicitOwnerJob?.status === "succeeded" && hitsB.includes("/v1/images/generations"),
  JSON.stringify({ status: explicitOwnerJob?.status, providerId: explicitOwnerJob?.providerId, hitsB: hitsB.join(",") })
);

/* 收尾：删掉第二条链，后面的用例回到「只有一条供应商」的状态 */
await call("/providers/delete", { method: "POST", body: { id: providerB.id } });
await call("/config", { method: "POST", body: { activeProviderId: "" } });
await new Promise((resolve) => mockBServer.close(resolve));

/* 参考图缩略图：只收本站路径，别的一律丢掉（这条字段会进历史记录） */
const refOk = await call("/generate", {
  method: "POST",
  body: {
    prompt: "带着参考图",
    providerId: mockProvider.id,
    model: "mock-image",
    size: "1024x1024",
    n: 1,
    referenceUrl: "/api/velapi-image-go/upload/up_demo.png"
  }
});
check(
  "参考图缩略图：本站 upload 路径收下，并回给界面（乐观那条任务也能立刻显示）",
  refOk.body?.job?.referenceUrl === "/api/velapi-image-go/upload/up_demo.png",
  JSON.stringify(refOk.body?.job?.referenceUrl ?? null)
);
const refBad = await call("/generate", {
  method: "POST",
  body: {
    prompt: "外站参考图",
    providerId: mockProvider.id,
    model: "mock-image",
    size: "1024x1024",
    n: 1,
    referenceUrl: "https://evil.example.com/a.png"
  }
});
check("参考图缩略图：外站地址一律不收（只留空）", refBad.body?.job?.referenceUrl === "", JSON.stringify(refBad.body?.job?.referenceUrl ?? null));

/* 协议现在住在「对话生图」输入框那一行：跟着每次生成走，落成 config.defaultEndpoint。
   供应商记录上的 endpoint 仍然认（别人接 API 时可能这么用），优先级：请求 > 供应商 > 运行期默认。 */
await saveMockProvider({ id: mockProvider.id, endpoint: "auto" });
const configBad = await call("/config", { method: "POST", body: { defaultEndpoint: "chatgpt-ultra" } });
check("认不出的协议写进配置也回落成自动检测", configBad.body?.config?.defaultEndpoint === "auto", String(configBad.body?.config?.defaultEndpoint));
const configSet = await call("/config", { method: "POST", body: { defaultEndpoint: "images_edits" } });
check(
  "POST /config 能改端点协议（界面输入框那一行写的就是它）",
  configSet.body?.config?.defaultEndpoint === "images_edits",
  String(configSet.body?.config?.defaultEndpoint)
);

/* 视频参数与图片配置分开：videoSize 独立存，改它不影响 defaultSize */
{
  const before = await call("/config");
  const imageSize = before.body?.config?.defaultSize ?? "";
  const video = await call("/config", { method: "POST", body: { videoSize: "1920x1080" } });
  check(
    "视频尺寸独立存（videoSize=1920x1080，图片尺寸不被写坏）",
    video.body?.config?.videoSize === "1920x1080" && video.body?.config?.defaultSize === imageSize,
    JSON.stringify({ videoSize: video.body?.config?.videoSize, defaultSize: video.body?.config?.defaultSize })
  );
  const back = await call("/config", { method: "POST", body: { videoSize: "1280x720" } });
  check("视频尺寸可以改回 1280x720", back.body?.config?.videoSize === "1280x720", String(back.body?.config?.videoSize));

/* 视频参数按「比例 / 分辨率」分开存：互不影响，也不影响图片尺寸 */
{
  const imageBefore = (await call("/config")).body?.config?.defaultSize ?? "";
  const ratio = await call("/config", { method: "POST", body: { videoRatio: "9:16", videoResolution: "1080p" } });
  check(
    "视频比例/分辨率分开存（9:16 + 1080p，像素 size 由界面组合写回）",
    ratio.body?.config?.videoRatio === "9:16" &&
      ratio.body?.config?.videoResolution === "1080p" &&
      ratio.body?.config?.defaultSize === imageBefore,
    JSON.stringify({
      videoRatio: ratio.body?.config?.videoRatio,
      videoResolution: ratio.body?.config?.videoResolution,
      defaultSize: ratio.body?.config?.defaultSize
    })
  );
  await call("/config", { method: "POST", body: { videoRatio: "16:9", videoResolution: "720p" } });
}
}

mockHits.length = 0;
await runMockJob("按运行期默认协议", { mode: "edit", image: `data:image/png;base64,${PNG_FOR_EDIT}` });
check(
  "运行期默认协议生效：带参考图、不带 endpoint 的生成打到 /v1/images/edits",
  hitPaths().includes("/v1/images/edits"),
  hitPaths().join(",")
);

mockHits.length = 0;
const explicit = await call("/generate", {
  method: "POST",
  body: { prompt: "这次显式指定协议", providerId: mockProvider.id, model: "mock-image", size: "1024x1024", n: 1, endpoint: "images_generations" }
});
for (let i = 0; i < 80; i += 1) {
  const polled = await call(`/job?id=${encodeURIComponent(explicit.body.job.id)}`);
  if (polled.body?.job?.status !== "queued" && polled.body?.job?.status !== "running") break;
  await new Promise((resolve) => setTimeout(resolve, 100));
}
check(
  "请求里的 endpoint 压过配置（这次显式要图片生成）",
  hitPaths().includes("/v1/images/generations"),
  hitPaths().join(",")
);

mockHits.length = 0;
const garbage = await call("/generate", {
  method: "POST",
  body: { prompt: "协议写错", providerId: mockProvider.id, model: "mock-image", size: "1024x1024", n: 1, endpoint: "gpt-9-ultra" }
});
for (let i = 0; i < 80; i += 1) {
  const polled = await call(`/job?id=${encodeURIComponent(garbage.body.job.id)}`);
  if (polled.body?.job?.status !== "queued" && polled.body?.job?.status !== "running") break;
  await new Promise((resolve) => setTimeout(resolve, 100));
}
check(
  "请求里协议写错也只是回落，不把生成打死",
  (hitPaths().includes("/v1/images/generations") || hitPaths().includes("/v1/images/edits")),
  hitPaths().join(",")
);
/* ---- 对话上下文管理：/chat/plan 把多轮消息整理成本轮提示词 ---- */
mockProvider = await saveMockProvider({
  id: mockProvider.id,
  endpoint: "images_generations",
  models: ["mock-image", "mock-chat"],
  modelMeta: { "mock-chat": { kind: "chat" } }
});
{
  const statusChat = await call("/status");
  check(
    "GET /status 列出可用的对话模型（供应商目录里的 chat 模型）",
    (statusChat.body?.chatModels ?? []).some((item) => item.id === "mock-chat" && item.providerId === mockProvider.id),
    JSON.stringify(statusChat.body?.chatModels ?? null)
  );

  mockHits.length = 0;
  const plan = await call("/chat/plan", {
    method: "POST",
    body: {
      message: "太夸张了",
      draft: "太夸张了",
      model: "mock-image",
      size: "1024x1024",
      history: [{ user: "机器人在商场", prompt: "机器人在商场全景", images: [] }]
    }
  });
  check(
    "POST /chat/plan：对话模型给出的 prompt / mode / reason 原样交给界面",
    plan.body?.ok === true && plan.body?.prompt.includes("柔和顶光") && plan.body?.mode === "generate" && String(plan.body?.reason || "").includes("太夸张"),
    JSON.stringify(plan.body ?? null)
  );
  const chatHit = mockHits.find((hit) => hit.url.includes("/chat/completions"));
  check(
    "对话请求打到 /v1/chat/completions，并带上最近几轮与这句话",
    Boolean(chatHit) && JSON.stringify(chatHit.body ?? {}).includes("太夸张了") && JSON.stringify(chatHit.body ?? {}).includes("机器人在商场"),
    JSON.stringify({ url: chatHit?.url ?? null })
  );

  const badPlan = await call("/chat/plan", { method: "POST", body: { message: "坏JSON", draft: "坏JSON", model: "mock-image" } });
  check(
    "对话模型跑题（非 JSON）：ok:false + 原文回传，不把生成打死",
    badPlan.body?.ok === false && badPlan.body?.code === "plan_parse_failed" && String(badPlan.body?.raw || "").includes("跑偏"),
    JSON.stringify(badPlan.body ?? null)
  );

  const replyPlan = await call("/chat/plan", { method: "POST", body: { message: "乱搞，S3 就是我发的参考图机器人", draft: "乱搞", model: "mock-image" } });
  check(
    "用户在纠正（乱搞…）：plan 判成 action=reply，给一句话、不写提示词",
    replyPlan.body?.ok === true &&
      replyPlan.body?.action === "reply" &&
      String(replyPlan.body?.reply || "").includes("S3") &&
      replyPlan.body?.prompt === "",
    JSON.stringify(replyPlan.body ?? null)
  );
  const replyJob = await call("/chat/message", {
    method: "POST",
    body: { message: "乱搞，S3 就是我发的参考图机器人", reply: replyPlan.body?.reply || "抱歉", conversationId: "conv_default", chatModel: "mock-chat" }
  });
  check(
    "POST /chat/message：这一问一答存成会话记录（kind=reply，没有图）",
    replyJob.body?.ok === true &&
      replyJob.body?.job?.kind === "reply" &&
      String(replyJob.body.job.reply || "").includes("S3") &&
      Array.isArray(replyJob.body.job.images) &&
      replyJob.body.job.images.length === 0,
    JSON.stringify(replyJob.body?.job ? { kind: replyJob.body.job.kind } : null)
  );
  /* 聊天模式：/chat/say 真的问一次对话模型（mock 上游对 chat 请求回一段文本），落成 reply job */
  const say = await call("/chat/say", { method: "POST", body: { message: "你是谁", conversationId: "conv_default" } });
  check(
    "POST /chat/say：聊天模式真的问对话模型，落一条 reply job（不触发生图）",
    say.status === 200 && say.body?.ok === true && say.body?.job?.kind === "reply" && String(say.body?.job?.reply || "").length > 0,
    JSON.stringify({ status: say.status, body: say.body })
  );

  /* 参考图：本站图片以 data URI 作为多模态消息传给对话模型 */
  fs.mkdirSync(path.join(stateDir, "uploads"), { recursive: true });
  const refPng = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==", "base64");
  fs.writeFileSync(path.join(stateDir, "uploads", "ref_test.png"), refPng);
  const agentWithRef = await call("/chat/agent", {
    method: "POST",
    body: { message: "把 95% 改成 10%", references: ["/api/velapi-image-go/upload/ref_test.png"] }
  });
  const chatHits = mockHits.filter((hit) => hit.url.includes("/chat/completions"));
  const multimodalUser = chatHits
    .map((hit) => (Array.isArray(hit.body?.messages) ? hit.body.messages : []))
    .flat()
    .find((msg) => msg?.role === "user" && Array.isArray(msg.content));
  const parts = Array.isArray(multimodalUser?.content) ? multimodalUser.content : [];
  check(
    "参考图传给对话模型：user 消息是多模态（text + image_url data URI）",
    agentWithRef.status === 200 &&
      parts.some((part) => part.type === "text" && String(part.text).includes("95%")) &&
      parts.some((part) => part.type === "image_url" && String(part.image_url?.url || "").startsWith("data:image/png;base64,")),
    JSON.stringify({ status: agentWithRef.status, parts: parts.map((part) => part.type) })
  );

  /* 改图/出图类消息：tool_choice=required（防模型只回文字不出图）；寒暄不传 tools */
  await call("/chat/agent", { method: "POST", body: { message: "橙色改成灰色其他地方不要动" } });
  const requiredHit = mockHits.filter((hit) => hit.url.includes("/chat/completions") && hit.body?.tool_choice === "required").pop();
  check(
    "改图消息：tool_choice=required（模型必须调 generate_image，不能只回文字）",
    Boolean(requiredHit),
    JSON.stringify({ toolChoice: requiredHit?.body?.tool_choice ?? null })
  );
  await call("/chat/agent", { method: "POST", body: { message: "你好" } });
  const chitChatHit = mockHits
    .filter((hit) => hit.url.includes("/chat/completions") && !Array.isArray(hit.body?.tools))
    .pop();
  check(
    "寒暄消息：不传 tools（纯聊天，不会被当出图）",
    Boolean(chitChatHit),
    JSON.stringify({ tools: chitChatHit?.body?.tools ?? null })
  );
  /* 对话 agent：LLM 用 function calling 调 generate_image（mock 第一次回 tool_calls，第二次收尾） */
  const agent = await call("/chat/agent", { method: "POST", body: { message: "画一只戴眼镜的橘猫" } });
  check(
    "对话 agent：LLM 识别为「要图」→ 调 generate_image 工具 → 结果回填后给收尾回复",
    agent.status === 200 &&
      agent.body?.ok === true &&
      Array.isArray(agent.body?.toolCalls) &&
      agent.body.toolCalls.length === 1 &&
      agent.body.toolCalls[0]?.name === "generate_image" &&
      String(agent.body?.reply || "").length > 0,
    JSON.stringify({ status: agent.status, body: agent.body })
  );
  const editPlan = await call("/chat/plan", { method: "POST", body: { message: "在上一张基础上再柔和点", draft: "在上一张基础上再柔和点", model: "mock-image" } });
  check(
    "要求在上一张基础上改：plan 判成 action=edit，referenceUrl 可空（客户端用本会话最近一张结果图）",
    editPlan.body?.ok === true && editPlan.body?.action === "edit" && editPlan.body?.mode === "edit" && editPlan.body?.referenceUrl === "",
    JSON.stringify(editPlan.body ?? null)
  );

  const plannedJob = await runMockJob("上下文化的这轮", { userText: "太夸张了", planNote: "改成柔和版本" });
  check(
    "生成任务记下 userText（气泡显示原话）与 planNote（对话模型整理结果）",
    plannedJob.job?.userText === "太夸张了" && plannedJob.job?.planNote === "改成柔和版本",
    JSON.stringify({ userText: plannedJob.job?.userText, planNote: plannedJob.job?.planNote })
  );
}

/* ---- 对话（会话）：新建 / 改名 / 删除；会话之间历史隔离 ---- */
{
  const list0 = await call("/conversations");
  check(
    "GET /conversations：默认对话在，且带条数",
    (list0.body?.items ?? []).length >= 1 && typeof list0.body.items[0].count === "number",
    JSON.stringify((list0.body?.items ?? []).slice(0, 2))
  );
  const createdConv = await call("/conversations", { method: "POST", body: {} });
  const convB = createdConv.body?.item?.id ?? "";
  check("POST /conversations：新建一个对话", Boolean(convB) && (createdConv.body?.items ?? []).some((item) => item.id === convB), String(convB));

  // A 带一个不存在的会话 id → 落默认会话；B 明确落新会话
  const aJob = await call("/generate", {
    method: "POST",
    body: { prompt: "会话A的图", providerId: mockProvider.id, model: "mock-image", size: "512x512", n: 1, endpoint: "images_generations", conversationId: "conv_missing" }
  });
  const bJob = await call("/generate", {
    method: "POST",
    body: { prompt: "会话B的图", providerId: mockProvider.id, model: "mock-image", size: "512x512", n: 1, endpoint: "images_generations", conversationId: convB }
  });
  await pollJob(bJob.body?.job?.id);
  const bJobs = (await call(`/jobs?limit=50&conversationId=${encodeURIComponent(convB)}`)).body?.items ?? [];
  const defaultConvId = "conv_default";
  const defaultJobs = (await call(`/jobs?limit=50&conversationId=${defaultConvId}`)).body?.items ?? [];
  check(
    "任务按会话归档：B 的列表里没有 A 的，默认会话里也没有 B 的",
    bJobs.some((job) => job.prompt === "会话B的图") &&
      !bJobs.some((job) => job.prompt === "会话A的图") &&
      !defaultJobs.some((job) => job.prompt === "会话B的图"),
    JSON.stringify({ b: bJobs.length, def: defaultJobs.length })
  );
  check(
    "不存在的 conversationId 自动落默认会话（新对话不带记忆）",
    Boolean(aJob.body?.job?.conversationId) && aJob.body.job.conversationId !== convB,
    String(aJob.body?.job?.conversationId)
  );
  const renamed = await call("/conversations/rename", { method: "POST", body: { id: convB, title: "B 会话改名" } });
  check("POST /conversations/rename：改名生效", (renamed.body?.items ?? []).find((item) => item.id === convB)?.title === "B 会话改名", JSON.stringify(renamed.body?.item ?? null));
  const deletedConv = await call("/conversations/delete", { method: "POST", body: { id: convB } });
  const afterConv = (await call("/conversations")).body?.items ?? [];
  const orphan = (await call(`/jobs?limit=50&conversationId=${encodeURIComponent(convB)}`)).body?.items ?? [];
  check(
    "删除对话：连带删掉它的任务，别的会话不受影响",
    deletedConv.body?.ok === true &&
      !afterConv.some((item) => item.id === convB) &&
      orphan.length === 0 &&
      (deletedConv.body?.removedJobs ?? 0) >= 1,
    JSON.stringify(deletedConv.body ?? null)
  );
}

/* ---- 过程留痕：素材和「怎么来的」存在一起 ------------------------ */

mockProvider = await saveMockProvider({ id: mockProvider.id, endpoint: "images_generations" });
mockHits.length = 0;
const provenance = await call("/generate", {
  method: "POST",
  body: {
    prompt: "留痕测试图",
    providerId: mockProvider.id,
    model: "mock-image",
    size: "512x512",
    n: 1,
    /* 上面那几条用例把 defaultEndpoint 改成了 images_edits，这里显式钉住生成协议 */
    endpoint: "images_generations",
    source: "ui",
    sessionId: "sess-ui-1"
  }
});
let provenanceJob = null;
for (let i = 0; i < 100; i += 1) {
  const polled = await call(`/job?id=${encodeURIComponent(provenance.body?.job?.id ?? "")}`);
  provenanceJob = polled.body?.job ?? provenanceJob;
  if (provenanceJob && provenanceJob.status !== "queued" && provenanceJob.status !== "running") break;
  await new Promise((resolve) => setTimeout(resolve, 100));
}
check(
  "过程留痕：任务记下提示词 / 模型 / 尺寸 / 协议 / 来源 / 会话",
  provenanceJob?.status === "succeeded" &&
    provenanceJob?.source === "ui" &&
    provenanceJob?.sessionId === "sess-ui-1" &&
    provenanceJob?.prompt === "留痕测试图" &&
    provenanceJob?.model === "mock-image" &&
    provenanceJob?.size === "512x512" &&
    provenanceJob?.protocol === "images_generations",
  JSON.stringify({ status: provenanceJob?.status, source: provenanceJob?.source, sessionId: provenanceJob?.sessionId })
);
check(
  "过程留痕：上游改写的那句也收下（revisedPrompt）",
  provenanceJob?.revisedPrompt === "上游改过的那句留痕提示词",
  String(provenanceJob?.revisedPrompt ?? "")
);
{
  const lib = await call("/library?limit=200");
  const asset = (provenanceJob?.images ?? [])[0];
  const record = (lib.body?.items ?? []).find((item) => item.id === asset?.assetId);
  check(
    "过程留痕：素材记录也带提示词 / 模型 / 尺寸 / 来源 / 会话 / 任务号（图库能反查）",
    record?.prompt === "留痕测试图" &&
      record?.model === "mock-image" &&
      record?.size === "512x512" &&
      record?.source === "ui" &&
      record?.sessionId === "sess-ui-1" &&
      record?.jobId === provenanceJob?.id,
    JSON.stringify(record ? { prompt: record.prompt, source: record.source, sessionId: record.sessionId, jobId: record.jobId } : null)
  );
}
const apiSourced = await call("/generate", {
  method: "POST",
  body: { prompt: "外部接口打进来的", providerId: mockProvider.id, model: "mock-image", size: "512x512", n: 1 }
});
const apiSourcedRead = await call(`/job?id=${encodeURIComponent(apiSourced.body?.job?.id ?? "")}`);
check(
  "不写 source 的请求记成 api（界面 / 工具 / 外部三条来源分得开）",
  apiSourcedRead.body?.job?.source === "api",
  String(apiSourcedRead.body?.job?.source)
);
await call("/config", { method: "POST", body: { defaultEndpoint: "auto" } });

/* ---- 删除对话记录：只摘 job，不动图库素材 ------------------------ */
{
  const target = ((await call("/jobs?limit=1")).body?.items ?? [])[0] ?? null;
  const imagesBefore = (await call("/library?limit=1")).body?.items?.length ?? 0;
  const deleted = await call("/job/delete", { method: "POST", body: { ids: [target?.id ?? ""] } });
  const remaining = (await call("/jobs?limit=200")).body?.items ?? [];
  check(
    "删除对话记录：/job/delete 摘掉那一条，图库不动",
    Boolean(target?.id) &&
      deleted.body?.removed === 1 &&
      !remaining.some((job) => job.id === target.id) &&
      ((await call("/library?limit=1")).body?.items?.length ?? 0) === imagesBefore,
    JSON.stringify({ removed: deleted.body?.removed })
  );
  const emptyDelete = await call("/job/delete", { method: "POST", body: { ids: [] } });
  check("删除对话记录：空 ids 拒收（400）", emptyDelete.status === 400 && emptyDelete.body?.code === "empty_ids", JSON.stringify(emptyDelete.body));
}

/* ---- 密钥与接口地址不是一家的：编辑不抹 key + 401 时说人话 ---------- */

/* A) 编辑供应商时密钥框是空的（不回显明文）——空串 = 不改，不许把已存的 key 抹掉。
   踩过：改个接口地址顺手把 key 清空，之后测试连接回 invalid access key，查半天。 */
const keyBefore = (await call("/providers")).body?.items?.find((item) => item.id === mockProvider.id)?.keyMask ?? "";
const savedNoKey = await call("/providers", {
  method: "POST",
  body: { id: mockProvider.id, name: mockProvider.name, baseUrl: mockProvider.baseUrl, models: mockProvider.models, apiKey: "" }
});
check(
  "编辑供应商时密钥框留空 = 不改（不会被顺手清空）",
  keyBefore.length > 0 && savedNoKey.body?.item?.keyMask === keyBefore && savedNoKey.body?.item?.usesRuntimeKey === false,
  JSON.stringify({ before: keyBefore, after: savedNoKey.body?.item?.keyMask, usesRuntimeKey: savedNoKey.body?.item?.usesRuntimeKey })
);
const keyWins = await call("/providers", {
  method: "POST",
  body: { id: mockProvider.id, name: mockProvider.name, baseUrl: mockProvider.baseUrl, models: mockProvider.models, apiKey: "sk-mock", useRuntimeKey: true }
});
check(
  "填了 key 就不再标「用运行期密钥」（两者互斥，界面不会自相矛盾）",
  keyWins.body?.item?.usesRuntimeKey === false && Boolean(keyWins.body?.item?.keyMask),
  JSON.stringify({ keyMask: keyWins.body?.item?.keyMask, usesRuntimeKey: keyWins.body?.item?.usesRuntimeKey })
);
const switchedToRuntime = await call("/providers", {
  method: "POST",
  body: { id: mockProvider.id, name: mockProvider.name, baseUrl: mockProvider.baseUrl, models: mockProvider.models, useRuntimeKey: true }
});
check(
  "要换成运行期密钥时（useRuntimeKey:true）才清掉供应商自己的 key",
  switchedToRuntime.body?.item?.usesRuntimeKey === true && !switchedToRuntime.body?.item?.keyMask,
  JSON.stringify({ keyMask: switchedToRuntime.body?.item?.keyMask, usesRuntimeKey: switchedToRuntime.body?.item?.usesRuntimeKey })
);
await call("/providers", {
  method: "POST",
  body: { id: mockProvider.id, name: mockProvider.name, baseUrl: mockProvider.baseUrl, models: mockProvider.models, apiKey: "sk-mock" }
});

/* B) 只访问所选本地假上游，401/403 不得引出额外请求。 */
const mockKeySecret = "sk-mock";
const deniedHits = [];
let denyStatus = 401;
const badKeyServer = http.createServer((request, response) => {
  deniedHits.push({ url: request.url, auth: request.headers.authorization });
  const body = JSON.stringify({ error: { message: "invalid access key", code: "invalid_key", type: "auth" } });
  response.writeHead(denyStatus, { "content-type": "application/json", "content-length": Buffer.byteLength(body) });
  response.end(body);
});
await new Promise((resolve) => badKeyServer.listen(0, "127.0.0.1", resolve));
const badBase = `http://127.0.0.1:${badKeyServer.address().port}/v1`;
const originalRuntime = (await call("/status")).body?.config?.baseUrl ?? "";
await call("/config", { method: "POST", body: { baseUrl: mockBase, apiKey: "runtime-fixture" } });
const probe = (body) => call("/providers/test", { method: "POST", body });
await probe({ scope: "runtime", id: mockProvider.id });
check("运行期测试忽略供应商 id，只从运行期读取凭据", mockHits.at(-1)?.auth === "Bearer runtime-fixture");
await probe({ scope: "provider", id: mockProvider.id, apiKey: "" });
check("供应商测试留空使用其已存密钥", mockHits.at(-1)?.auth === "Bearer sk-mock");
await probe({ scope: "provider", id: mockProvider.id, apiKey: "", useRuntimeKey: true });
check("供应商测试显式切换可验证运行期密钥，不写回已存密钥", mockHits.at(-1)?.auth === "Bearer runtime-fixture");
const previousCount = mockHits.length;
const missing = await probe({ scope: "provider", baseUrl: mockBase, useRuntimeKey: false });
check("新供应商未选运行期且没填 key 时不借用全局凭据", missing.status === 400 && missing.body?.code === "missing_api_key" && previousCount === mockHits.length);
const unknownProviderProbe = await probe({ scope: "provider", id: "unknown-fixture" });
check("找不到的供应商不会回落到运行期", unknownProviderProbe.status === 404 && previousCount === mockHits.length);
const wrongOrigin = await probe({ scope: "provider", id: mockProvider.id, baseUrl: badBase });
check("未保存的跨源地址不能带走旧供应商密钥", wrongOrigin.body?.code === "credential_origin_changed" && !deniedHits.length);
const emptyProvider = (await call("/providers", { method: "POST", body: { name: "明确不继承", baseUrl: mockBase, models: ["missing-own-key"], useRuntimeKey: false } })).body.item;
const emptyTest = await probe({ scope: "provider", id: emptyProvider.id });
const emptyRefresh = await call("/models/refresh", { method: "POST", body: { providerId: emptyProvider.id } });
const emptyGen = await call("/generate", { method: "POST", body: { prompt: "本地拒绝", model: "missing-own-key", providerId: emptyProvider.id } });
const emptyJob = await pollJob(emptyGen.body.job?.id);
check("明确不继承的供应商：投影不显示全局 key，测试/刷新/生成均缺凭据且零上游请求", !emptyProvider.usesRuntimeKey && !emptyProvider.keyMask && emptyTest.body.code === "missing_api_key" && emptyRefresh.body.code === "missing_api_key" && emptyJob?.errorCode === "missing_api_key" && mockHits.length === previousCount);
const enabled = (await call("/providers", { method: "POST", body: { id: emptyProvider.id, useRuntimeKey: true } })).body.item;
const enabledRefresh = await call("/models/refresh", { method: "POST", body: { providerId: enabled.id } });
check("明确勾选后：公开状态与刷新使用的运行期凭据一致", enabled.usesRuntimeKey && enabled.keyMask && enabledRefresh.body.ok && mockHits.at(-1)?.auth === "Bearer runtime-fixture");
await call("/providers/delete", { method: "POST", body: { id: enabled.id } });
const otherHitsBefore = [mockHits.length, hitsB.length];
const keyMismatch = await probe({ scope: "provider", id: mockProvider.id, baseUrl: badBase, apiKey: mockKeySecret });
check(
  "测试连接 401：原文及本地排查提示保留，不向其它源发送凭据",
  keyMismatch.body?.ok === false && keyMismatch.body?.error === "invalid access key" &&
    keyMismatch.body?.hint?.includes("未向其他地址") && !keyMismatch.body.hint.includes(mockKeySecret) &&
    deniedHits.length === 1 && deniedHits[0].auth === "Bearer sk-mock" &&
    mockHits.length === otherHitsBefore[0] && hitsB.length === otherHitsBefore[1],
  JSON.stringify({ status: keyMismatch.body?.detail?.status, hint: keyMismatch.body?.hint })
);
check(
  "测试连接失败时带原始证据（GET /models 的地址与状态码）",
  keyMismatch.body?.detail?.status === 401 && String(keyMismatch.body?.detail?.url ?? "").startsWith(badBase),
  JSON.stringify(keyMismatch.body?.detail ?? null)
);

/* C) 真生成撞上 401 也一样：任务里的 errorDetail 带同样一句人话 */
const badProvider = (
  await call("/providers", {
    method: "POST",
    body: { name: "坏地址供应商", baseUrl: badBase, apiKey: "sk-mock", models: ["mock-bad"], endpoint: "images_generations" }
  })
).body?.item ?? null;
const badGen = await call("/generate", {
  method: "POST",
  body: { prompt: "撞 401", providerId: badProvider?.id ?? "", model: "mock-bad", size: "512x512", n: 1, endpoint: "images_generations" }
});
const badJob = await pollJob(badGen.body?.job?.id);
check(
  "生成 401：记录原始 HTTP 状态和本地提示，不发任何伴随探测",
  badJob?.status === "failed" && badJob.errorDetail?.status === 401 && badJob.errorDetail?.hint?.includes("未向其他地址") &&
    deniedHits.length === 2 && deniedHits[1].url === "/v1/images/generations" && mockHits.length === otherHitsBefore[0] && hitsB.length === otherHitsBefore[1]
);
denyStatus = 403;
const forbidden = await probe({ scope: "runtime", baseUrl: badBase, apiKey: "draft-fixture" });
check("403 仅验证当前显式输入的运行期草稿，不发第二次请求", forbidden.body?.hint?.includes("HTTP 403") &&
  deniedHits.length === 3 && deniedHits[2].auth === "Bearer draft-fixture" && mockHits.length === otherHitsBefore[0] && hitsB.length === otherHitsBefore[1]);
await call("/providers/delete", { method: "POST", body: { id: badProvider?.id ?? "" } });
await call("/config", { method: "POST", body: { baseUrl: originalRuntime, apiKey: KEY } });
await new Promise((resolve) => badKeyServer.close(resolve));

/* ---- 素材目录可配置：默认在本地，换目录时把现有素材复制过去 ------- */
{
  const before = (await call("/status")).body;
  check(
    "默认素材目录是本地目录（/status 与 config 都报它）",
    path.resolve(before?.config?.stateDir ?? "") === path.resolve(stateDir) && path.resolve(before?.stateDir ?? "") === path.resolve(stateDir),
    String(before?.config?.stateDir)
  );
  const nextDir = fs.mkdtempSync(path.join(os.tmpdir(), "vig-state-next-"));
  const switched = await call("/config", { method: "POST", body: { stateDir: nextDir } });
  const after = (await call("/status")).body;
  const imagesAfter = (await call("/library?limit=200")).body?.items?.length ?? 0;
  const jobsAfter = (await call("/jobs?limit=200")).body?.items?.length ?? 0;
  check(
    "换素材目录：立刻生效，文件和索引都复制过去（旧目录留着）",
    switched.body?.ok === true &&
      path.resolve(switched.body?.stateDir ?? "") === path.resolve(nextDir) &&
      switched.body?.moved?.changed === true &&
      (switched.body?.moved?.copied?.files ?? 0) > 0 &&
      fs.existsSync(path.join(nextDir, "library", "index.json")) &&
      imagesAfter === before?.counts?.images &&
      jobsAfter === before?.counts?.jobs,
    JSON.stringify({ moved: switched.body?.moved, imagesAfter, before: before?.counts?.images })
  );
  check(
    "换目录后 /status 与新任务的落盘都指向新目录",
    path.resolve(after?.stateDir ?? "") === path.resolve(nextDir) &&
      path.resolve(after?.config?.stateDir ?? "") === path.resolve(nextDir) &&
      fs.existsSync(path.join(nextDir, "uploads")),
    JSON.stringify({ stateDir: after?.stateDir })
  );
  const back = await call("/config", { method: "POST", body: { stateDir, cleanupSource: false } });
  check(
    "再换回原目录：同样带素材复制，索引还在",
    back.body?.ok === true && back.body?.moved?.cleanup?.removed === 0 && fs.existsSync(path.join(nextDir,"library","index.json")) && path.resolve(back.body?.stateDir ?? "") === path.resolve(stateDir) && ((await call("/library?limit=5")).body?.items?.length ?? 0) >= 1,
    JSON.stringify({ stateDir: back.body?.stateDir })
  );
  const emptyDir = await call("/config", { method: "POST", body: { stateDir: "   " } });
  check("空目录拒收（400），不会把素材指到空字符串", emptyDir.status === 400 && emptyDir.body?.code === "state_dir_failed", JSON.stringify(emptyDir.body));
  const revealMissing = await call("/state/reveal", { method: "POST", body: { dir: path.join(nextDir, "nope") } });
  check("打开一个不存在的目录：400，不乱 spawn", revealMissing.status === 400 && revealMissing.body?.code === "reveal_failed", JSON.stringify(revealMissing.body));
}

/* 显式清理仅作用于本机临时目录：冲突必须原子拒绝；成功时只删可证明且逐字节验证过的插件文件。 */
{
  const makeFixture = async (name, conflicting) => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), `vig-clean-${name}-home-`));
    const source = fs.mkdtempSync(path.join(os.tmpdir(), `vig-clean-${name}-source-`));
    const target = fs.mkdtempSync(path.join(os.tmpdir(), `vig-clean-${name}-target-`));
    const defaultRoot = path.join(home, "state", "velapi-image-go");
    const ownedBytes = Buffer.from(tinyPng, "base64"), targetConflict = Buffer.from("pre-existing user content");
    const index = [{ id:"img_owned", name:"owned.png", file:"owned.png", url:"/api/velapi-image-go/asset/owned.png", bytes:ownedBytes.length, format:"png", mime:"image/png", width:1, height:1, prompt:"fixture" }];
    const conversations = [{ id:"conv_cleanup_fixture", title:"Temporary migration fixture", createdAt:"2026-01-01T00:00:00.000Z", updatedAt:"2026-01-01T00:00:00.000Z" }];
    fs.mkdirSync(path.join(source,"library","files"),{recursive:true}); fs.mkdirSync(path.join(source,"uploads"),{recursive:true});
    fs.writeFileSync(path.join(source,"library","files","owned.png"),ownedBytes);
    fs.writeFileSync(path.join(source,"library","files","manual.txt"),"unindexed user file");
    fs.writeFileSync(path.join(source,"uploads","personal.png"),ownedBytes);
    fs.mkdirSync(path.join(source,"uploads","user-folder"));
    fs.writeFileSync(path.join(source,"uploads","user-folder","personal.txt"),"keep nested file");
    fs.writeFileSync(path.join(source,"library","index.json"),JSON.stringify(index));
    fs.writeFileSync(path.join(source,"conversations.json"),JSON.stringify(conversations));
    fs.writeFileSync(path.join(source,"jobs.json"),"[]");
    fs.writeFileSync(path.join(source,"config.json"),JSON.stringify({stateDir:source,baseUrl:BASE,apiKeyEnv:"VIG_KEY"}));
    fs.writeFileSync(path.join(source,"location.json"),JSON.stringify({stateDir:"user-owned marker"}));
    fs.writeFileSync(path.join(source,"README.user"),"unrelated state file");
    fs.mkdirSync(defaultRoot,{recursive:true});
    fs.writeFileSync(path.join(defaultRoot,"location.json"),JSON.stringify({stateDir:source}));
    if(conflicting){fs.mkdirSync(path.join(target,"library","files"),{recursive:true});fs.writeFileSync(path.join(target,"library","files","owned.png"),targetConflict);}
    const previousHome=process.env.DSH_HOME;process.env.DSH_HOME=home;
    const localRoutes=[];
    const localCtx={
      effect(fn){const disposer=fn();return()=>{if(typeof disposer==="function")disposer();};},
      logger:{info:()=>{},warn:()=>{}},
      webServer:{register(route){localRoutes.push(route);return()=>{};}}
    };
    let instance, server;
    try {
      instance=apply(localCtx,{baseUrl:BASE,apiKey:KEY,apiKeyEnv:"VIG_KEY",timeoutMs:300000});
      await new Promise(resolve=>setImmediate(resolve));
      server=http.createServer((request,response)=>localRoutes[0].handler(request,response).catch(error=>response.writeHead(500).end(String(error?.message??error))));
      await new Promise(resolve=>server.listen(0,"127.0.0.1",resolve));
    } finally {process.env.DSH_HOME=previousHome;}
    const base=`http://127.0.0.1:${server.address().port}/api/velapi-image-go`;
    const localCall=async (pathname,init={})=>{
      const options={...init};if(options.body!==undefined&&typeof options.body!=="string"){options.headers={"content-type":"application/json",...(options.headers??{})};options.body=JSON.stringify(options.body);}
      const response=await fetch(base+pathname,options),text=await response.text();let body;try{body=text?JSON.parse(text):null;}catch{body=text;}return{status:response.status,body};
    };
    return {home,source,target,defaultRoot,ownedBytes,targetConflict,conversations,index,instance,server,call:localCall};
  };
  const disposeFixture=async fixture=>{await new Promise(resolve=>fixture.server.close(resolve));for(const dir of [fixture.home,fixture.source,fixture.target])fs.rmSync(dir,{recursive:true,force:true});};

  const conflict=await makeFixture("conflict",true);
  try {
    const response=await conflict.call("/config",{method:"POST",body:{stateDir:conflict.target,cleanupSource:true}});
    const active=(await conflict.call("/status")).body;
    check("清理迁移遇到异字节同名图：409 并留在源目录",response.status===409&&response.body?.code==="state_dir_conflict"&&path.resolve(response.body?.stateDir??"")===path.resolve(conflict.source)&&path.resolve(active?.stateDir??"")===path.resolve(conflict.source),JSON.stringify({status:response.status,body:response.body,stateDir:active?.stateDir}));
    check("冲突不删源索引图/元数据/上传，也不覆盖目标和默认指针",fs.readFileSync(path.join(conflict.source,"library","files","owned.png")).equals(conflict.ownedBytes)&&fs.existsSync(path.join(conflict.source,"library","index.json"))&&fs.existsSync(path.join(conflict.source,"conversations.json"))&&fs.existsSync(path.join(conflict.source,"uploads","personal.png"))&&fs.readFileSync(path.join(conflict.target,"library","files","owned.png")).equals(conflict.targetConflict)&&JSON.parse(fs.readFileSync(path.join(conflict.defaultRoot,"location.json"),"utf8")).stateDir===conflict.source&&response.body?.cleanup?.removed===0&&(response.body?.cleanup?.retained??0)>=1);
  } finally {await disposeFixture(conflict);}

  const success=await makeFixture("success",false);
  try {
    const uploaded = await success.call("/upload", {method:"POST", body:{name:"fixture.png",data:`data:image/png;base64,${tinyPng}`}});
    const managedUpload = path.basename(uploaded.body.item.url);
    const sourceConfig=fs.readFileSync(path.join(success.source,"config.json"));
    const sourceIndex=fs.readFileSync(path.join(success.source,"library","index.json"));
    const sourceConversations=fs.readFileSync(path.join(success.source,"conversations.json"));
    const response=await success.call("/config",{method:"POST",body:{stateDir:success.target,cleanupSource:true}});
    const active=(await success.call("/status")).body;
    const list=(await success.call("/conversations")).body;
    const pointer=JSON.parse(fs.readFileSync(path.join(success.defaultRoot,"location.json"),"utf8"));
    check("成功清理仅在切换到目标后返回 removed/retained 统计",response.status===200&&response.body?.moved?.changed===true&&path.resolve(response.body?.stateDir??"")===path.resolve(success.target)&&path.resolve(active?.stateDir??"")===path.resolve(success.target)&&(response.body?.moved?.cleanup?.removed??0)>=3&&(response.body?.moved?.cleanup?.retained??0)>=1,JSON.stringify({moved:response.body?.moved}));
    check("已索引图库图和逐字节验证过的 conversations/index/provider 元数据可清理",!fs.existsSync(path.join(success.source,"library","files","owned.png"))&&!fs.existsSync(path.join(success.source,"library","index.json"))&&!fs.existsSync(path.join(success.source,"conversations.json"))&&fs.readFileSync(path.join(success.target,"library","files","owned.png")).equals(success.ownedBytes)&&fs.readFileSync(path.join(success.target,"library","index.json")).equals(sourceIndex)&&fs.readFileSync(path.join(success.target,"conversations.json")).equals(sourceConversations)&&list?.items?.some(item=>item.id==="conv_cleanup_fixture"));
    check("插件生成的上传清理源副本，手工命名图片和子目录保留",
      uploaded.status === 200 && !fs.existsSync(path.join(success.source,"uploads",managedUpload)) &&
      fs.readFileSync(path.join(success.target,"uploads",managedUpload)).equals(success.ownedBytes) &&
      fs.readFileSync(path.join(success.source,"uploads","personal.png")).equals(success.ownedBytes) &&
      fs.readFileSync(path.join(success.source,"uploads","user-folder","personal.txt"),"utf8") === "keep nested file");
    check("未索引图、旧配置、无关文件及源目录指针均未更改",
      fs.readFileSync(path.join(success.source,"library","files","manual.txt"),"utf8") === "unindexed user file" &&
      fs.readFileSync(path.join(success.source,"config.json")).equals(sourceConfig) &&
      fs.readFileSync(path.join(success.source,"README.user"),"utf8") === "unrelated state file" &&
      JSON.parse(fs.readFileSync(path.join(success.source,"location.json"),"utf8")).stateDir === "user-owned marker");
    check("默认指针和目标配置均指向新目录",pointer.stateDir===success.target &&
      JSON.parse(fs.readFileSync(path.join(success.target,"config.json"),"utf8")).stateDir === success.target);
  } finally {await disposeFixture(success);}
}

/* ---- 保存到本地：导出图库原图 + 拿 file:// 路径（拖出去给真文件用） ---- */
{
  const exportDir = path.join(stateDir, "export-test");
  await call("/config", { method: "POST", body: { saveDir: exportDir } });
  const lib = (await call("/library?limit=5")).body?.items ?? [];
  const diskFiles = fs.readdirSync(path.join(stateDir, "library", "files"));
  const fileName = String(lib[0]?.url || "").split("/").pop() || diskFiles[0] || "";
  const local = await call(`/asset/local?file=${encodeURIComponent(fileName)}`);
  check(
    "图库原图能查到本地绝对路径与 file:// URL",
    local.body?.ok === true && fs.existsSync(local.body.path) && String(local.body.fileUrl || "").startsWith("file:///"),
    JSON.stringify({ lib0: lib[0]?.url ?? null, fileName, diskFiles, local: local.body })
  );
  const exported = await call("/asset/export", { method: "POST", body: { files: [fileName] } });
  const savedPath = exported.body?.items?.[0]?.path ?? "";
  check(
    "保存到本地：复制到保存目录，字节与图库原图一致",
    exported.body?.ok === true &&
      savedPath !== "" &&
      fs.existsSync(savedPath) &&
      fs.readFileSync(savedPath).length === fs.readFileSync(local.body.path).length &&
      path.resolve(exported.body.dir) === path.resolve(exportDir),
    JSON.stringify(exported.body)
  );
  const again = await call("/asset/export", { method: "POST", body: { files: [fileName] } });
  const secondPath = again.body?.items?.[0]?.path ?? "";
  check("同名不覆盖：第二次落成 -1 后缀", secondPath !== "" && secondPath !== savedPath && /-1\.[a-z0-9]+$/i.test(secondPath), secondPath);
  const badLocal = await call("/asset/local?file=..%2fconfig.json");
  const badExport = await call("/asset/export", { method: "POST", body: { files: ["..\\config.json"] } });
  check(
    "路径穿越挡住：/asset/local 404、导出只认图库里的文件",
    badLocal.status === 404 && badExport.body?.ok === true && (badExport.body.items ?? []).length === 0,
    JSON.stringify({ local: badLocal.status, items: badExport.body?.items })
  );
  /* 原生拖出 / 复制图片：Node 里没有 Electron；PowerShell 兜底被 VIG_NO_CLIPBOARD 关掉后
     必须如实回 501（不是静默失败） */
  const capabilities = await call("/capabilities");
  const nativeDrag = await call("/drag/native", { method: "POST", body: { file: fileName } });
  const clipboard = await call("/clipboard/image", { method: "POST", body: { file: fileName } });
  check(
    "GET /capabilities：非 Electron 且关了 PowerShell 兜底时如实报 nativeDrag / clipboard 不可用",
    capabilities.status === 200 && capabilities.body?.electron === false && capabilities.body?.nativeDrag === false && capabilities.body?.clipboard === false,
    JSON.stringify(capabilities.body ?? null)
  );
  check(
    "原生拖出 / 复制图片：两条写不了的路都回 501 并说明原因",
    nativeDrag.status === 501 && nativeDrag.body?.code === "no_electron" && clipboard.status === 501 && clipboard.body?.code === "no_clipboard",
    JSON.stringify({ drag: nativeDrag.body, clipboard: clipboard.body })
  );
  const dragMissing = await call("/drag/native", { method: "POST", body: { file: "..\\nope.png" } });
  const copyMissing = await call("/clipboard/image", { method: "POST", body: { file: "nope.png" } });
  check(
    "原生拖出 / 复制图片只认图库里的文件（不存在 404）",
    dragMissing.status === 404 && copyMissing.status === 404,
    JSON.stringify({ drag: dragMissing.status, copy: copyMissing.status })
  );
}

/* Gemini 图像协议。旧 /images 路由和外链都指向这个本机夹具，误回落/下载会被逐次计数。 */
{
  const model = "Nano-Banana-2", legacy = "gemini-2.5-flash-image", protocol = "gemini_generate";
  const secret = "fixture-native-gemini-only", hits = [];
  const jpeg = '/9j/4AAQSkZJRgABAQAAAQABAAD/2wBDAAgGBgcGBQgHBwcJCQgKDBQNDAsLDBkSEw8UHRofHh0aHBwgJC4nICIsIxwcKDcpLDAxNDQ0Hyc5PTgyPC4zNDL/wAALCAABAAIBAREA/8QAFAABAAAAAAAAAAAAAAAAAAAAAf/EABQQAQAAAAAAAAAAAAAAAAAAAAD/2gAIAQEAAD8AH//Z'; // 2×1 grey JPEG, 159 bytes.
  const markdown = `生成结果：\n\n![Generated image](data:image/jpeg;base64,${jpeg})\n\n已完成。`;
  let releaseInspection, signalReading;
  const inspected = new Promise(resolve => { releaseInspection = resolve; });
  const reading = new Promise(resolve => { signalReading = resolve; });
  const candidate = (parts, finishReason = "STOP") => ({ candidates: [{ content: { role: "model", parts }, finishReason }] });
  const relay = http.createServer(async (req, res) => {
    const chunks = []; for await (const chunk of req) chunks.push(chunk);
    let body; try { body = JSON.parse(Buffer.concat(chunks).toString() || "null"); } catch { body = null; }
    hits.push({ method:req.method, url:req.url, body, bearer:req.headers.authorization === `Bearer ${secret}`, googleKey:!!req.headers['x-goog-api-key'], type:req.headers['content-type'] });
    const prompt = body?.contents?.[0]?.parts?.find(p => typeof p.text === "string")?.text;
    const image = { inlineData: { mimeType:"image/png", data:tinyPng } };
    let status = 200, result;
    switch (prompt) {
      case "Gemini inline": case "Gemini Flash 2.5": case "Gemini ordered refs": result = candidate([image]); break;
      case "Gemini Markdown parts": result = candidate([{text:markdown}]); break;
      case "Gemini Markdown choices":
        signalReading(); await inspected;
        result = {choices:[{message:{role:"assistant",content:markdown}}]}; break;
      case "Gemini no image": result = candidate([{text:"Only text, no picture"}]); break;
      case "Gemini external image": result = candidate([{text:`![external](http://127.0.0.1:${relay.address().port}/uncalled.png)`}]); break;
      case "Gemini blocked": result = {promptFeedback:{blockReason:"SAFETY"},candidates:[candidate([image]).candidates[0]]}; break;
      case "Gemini blocked candidate": result = candidate([image],'SAFETY'); break;
      case "Gemini invalid image": result = candidate([{inlineData:{mimeType:"image/png",data:Buffer.from('not an image').toString('base64')}}]); break;
      case "Gemini unauthorized": status = 401; result = {error:{code:401,status:"UNAUTHENTICATED",message:`Fixture key rejected: ${secret}`}}; break;
      case "Gemini redirect": res.writeHead(307,{location:"/uncalled-redirect"}).end(); return;
      default: status = 404; result = { error:{message:"Unexpected Gemini route or request"} };
    }
    res.writeHead(status,{'content-type':'application/json'}).end(JSON.stringify(result));
  });
  await new Promise(resolve => relay.listen(0,"127.0.0.1",resolve));
  const beforeHits = mockHits.length;
  let gemProvider;
  try {
    gemProvider = (await call('/providers',{method:'POST',body:{name:'Gemini loopback fixture',baseUrl:`http://127.0.0.1:${relay.address().port}/v1`,apiKey:secret,models:[model,legacy],endpoint:protocol}})).body?.item;
    if (!gemProvider?.id) throw Error('Gemini loopback provider setup failed');
    const submit = async (prompt, extra = {}) => {
      const since = hits.length, submitted = await call('/generate',{method:'POST',body:{providerId:gemProvider.id,model,endpoint:protocol,size:'1K',aspect_ratio:'1:1',n:1,prompt,...extra}});
      const id = submitted.body?.job?.id;
      if (prompt==='Gemini Markdown choices' && id) {
        let timer;
        try {
          await Promise.race([reading,new Promise(resolve=>{timer=setTimeout(resolve,2000);})]);
          const [one,list] = await Promise.all([call(`/job?id=${encodeURIComponent(id)}`),call('/jobs?limit=200')]);
          const records = [one.body?.job,list.body?.items?.find(j=>j.id===id),JSON.parse(fs.readFileSync(path.join(stateDir,'jobs.json'),'utf8')).find(j=>j.id===id)];
          check('Gemini 运行中任务：详情、列表及落盘均无参考图 base64 或密钥',records.every(j=>j?.status==='running' && ![PNG_FOR_EDIT,tinyPng,secret].some(s=>JSON.stringify(j).includes(s))));
        } finally { clearTimeout(timer); releaseInspection(); }
      }
      const job = id ? await pollJob(id) : null;
      return {submitted,job,requests:hits.slice(since)};
    };
    check('Gemini：宿主公开图像协议而非普通对话协议',protocols.body.protocols.find(p=>p.id===protocol)?.kind==='image');
    const cases = [
      ['Gemini inline', {size:'1K',aspect_ratio:'16:9'}, model, '1K','16:9', tinyPng,'png'],
      ['Gemini Markdown parts',{size:'2048x3072',aspect_ratio:undefined}, model, '2K','2:3',jpeg,'jpg'],
      ['Gemini Markdown choices',{size:'4K',aspect_ratio:'21:9',mode:'edit',images:[`data:image/png;base64,${PNG_FOR_EDIT}`,tinyPng],referenceUrls:[upload.body.item.url]}, model,'4K','21:9',jpeg,'jpg'],
      ['Gemini Flash 2.5',{model:legacy,size:'1K',aspect_ratio:'9:16'},legacy,undefined,'9:16',tinyPng,'png']
    ];
    for (const [prompt,opts,requestedModel,tier,ratio,expectedData,format] of cases) {
      const {submitted,job,requests} = await submit(prompt,opts), [hit] = requests;
      const expectedPath = `/v1beta/models/${requestedModel}:generateContent`, body = hit?.body;
      check(`${prompt}：一次 JSON POST 至大小写不变的模型，不重试 /images`,requests.length===1 && hit?.method==='POST' && hit.url===expectedPath && /^application\/json/i.test(hit.type) && hit.bearer && !hit.googleKey,`requests=${requests.length}, path=${hit?.url?.split('?')[0]}`);
      const content = body?.contents?.[0], parts = content?.parts || [], gen = body?.generationConfig;
      check(`${prompt}：文本、图像模态、比例和分辨率映射`,body?.contents?.length===1 && parts.some(p=>p.text===prompt) && gen?.responseModalities?.includes('IMAGE') && gen?.imageConfig?.aspectRatio===ratio && gen?.imageConfig?.imageSize===tier && !['prompt','model','n','size','response_format','aspect_ratio'].some(k=>Object.hasOwn(body||{},k)),JSON.stringify({ratio:gen?.imageConfig?.aspectRatio,tier:gen?.imageConfig?.imageSize}));
      const inputs = parts.filter(p=>p.inlineData).map(p=>[p.inlineData.mimeType,p.inlineData.data]);
      if (opts.mode==='edit') check('Gemini 多参考：上传字节和本地 referenceUrl 一并写入两个 inlineData',JSON.stringify(inputs)===JSON.stringify([['image/png',PNG_FOR_EDIT],['image/png',tinyPng]]));
      else check(`${prompt}：文生图不附参考图字节`,inputs.length===0);
      const out = job?.images?.[0], asset = (await call('/library?limit=200')).body.items.find(a=>a.id===out?.assetId && a.jobId===job?.id);
      const download = asset?.url?.startsWith('/api/velapi-image-go/asset/') ? await fetch(origin+asset.url) : null;
      const expected = Buffer.from(expectedData, 'base64'), mime = format==='jpg' ? 'image/jpeg' : 'image/png';
      const identical = download?.status===200 && download.headers.get('content-type')===mime && Buffer.from(await download.arrayBuffer()).equals(expected);
      check(`${prompt}：生成成功、图库关联当前任务，GET 图片逐字节一致`,submitted.status===200 && job?.status==='succeeded' && job?.protocol===protocol && job?.images?.length===1 && asset?.url===out?.url && asset?.model===requestedModel && asset?.format===format && asset?.bytes===expected.length && asset?.width===(format==='jpg'?2:1) && asset?.height===1 && identical,`status=${job?.status}, format=${asset?.format}, bytes=${asset?.bytes??0}, verified=${!!identical}`);
    }
    const refA = upload.body.item.url;
    const refB = (await call('/upload',{method:'POST',body:{name:'gemini-B.png',data:`data:image/png;base64,${PNG_FOR_EDIT}`}})).body.item.url;
    for (const [referenceUrls,expectedOrder,label] of [
      [[refA,refB],[tinyPng,PNG_FOR_EDIT],'完整预览次序 A,B 优先，B 不重复'],
      [[refA],[PNG_FOR_EDIT,tinyPng],'独立内嵌 B 加本地引用 A 按 B,A 发送']
    ]) {
      const {job,requests} = await submit('Gemini ordered refs',{mode:'edit',images:[PNG_FOR_EDIT],referenceUrls});
      const received = requests[0]?.body?.contents?.[0]?.parts?.filter(p=>p.inlineData).map(p=>p.inlineData.data);
      check(`Gemini 混合参考图：${label}`,job?.status==='succeeded' && requests.length===1 && JSON.stringify(received)===JSON.stringify(expectedOrder));
    }
    const count = (await call('/library?limit=200')).body.items.length;
    for (const prompt of ['Gemini no image','Gemini blocked','Gemini blocked candidate','Gemini external image','Gemini invalid image','Gemini unauthorized','Gemini redirect']) {
      const {job,requests} = await submit(prompt);
      check(`${prompt}：如实失败、不改打旧接口或跟随链接、不产生图片`,job?.status==='failed' && !job?.images?.length && !!job?.error && requests.length===1 && requests[0].url===`/v1beta/models/${model}:generateContent` && !JSON.stringify(job).includes(secret),`status=${job?.status}, calls=${requests.length}`);
      if (prompt==='Gemini unauthorized') check('Gemini 401：保留上游状态和失败原因',job?.errorDetail?.status===401 && job?.error?.includes('Fixture key rejected'));
    }
    for (const [label,opts] of [['多张',{n:2}],['蒙版',{mode:'edit',images:[tinyPng],mask:`data:image/png;base64,${tinyPng}`}],['尺寸',{size:'1234x567'}],['旧模型高档位',{model:legacy,size:'2K'}]]) {
      const {submitted,job,requests} = await submit('Gemini invalid options',opts);
      check(`Gemini ${label}：不支持的请求在用户输入端或本地任务报错，不产生上游流量`,requests.length===0 && (submitted.status===400 || job?.status==='failed'),`http=${submitted.status}, calls=${requests.length}`);
    }
    check('Gemini 负向回归不新增素材、也不向另一个供应商发请求',(await call('/library?limit=200')).body.items.length===count && mockHits.length===beforeHits);
  } finally {
    if (gemProvider?.id) await call('/providers/delete',{method:'POST',body:{id:gemProvider.id}});
    await new Promise(resolve=>relay.close(resolve));
  }
}

/* 官方 URL 不能替换成 localhost 测 origin 分支。只放行当前工作台的回环 HTTP，
   对 Google 精确地址直接从内存应答；其他目标一律抛错，不进行 DNS 查询。 */
{
  const apiOrigin = 'https://generativelanguage.googleapis.com', id = 'gemini-3.1-flash-image-preview';
  const secret = 'unit-test-official-key', upstream = [], realFetch = globalThis.fetch;
  const modelsRoute = '/v1beta/models?pageSize=1000', generateRoute = `/v1beta/models/${id}:generateContent`;
  const catalog = {models:[{name:`models/${id}`,supportedGenerationMethods:['generateContent']},{name:'models/embed-only',supportedGenerationMethods:['embedContent']}]};
  let officialId;
  globalThis.fetch = async (input, options = {}) => {
    const url = new URL(input instanceof Request ? input.url : input);
    if (url.origin === origin) return realFetch(input,options);
    if (url.origin !== apiOrigin) throw new Error('Only local host and mocked Google routes are permitted');
    const headers = new Headers(options.headers), route = url.pathname + url.search;
    upstream.push({route, method:options.method || 'GET', correctKey:headers.get('x-goog-api-key')===secret, hasBearer:headers.has('authorization')});
    const payload = route===modelsRoute ? catalog : route===generateRoute ? {candidates:[{content:{parts:[{inlineData:{mimeType:'image/png',data:tinyPng}}]}}]} : {error:{message:'Unexpected fixture route'}};
    return new Response(JSON.stringify(payload),{status:payload.error?404:200,headers:{'content-type':'application/json'}});
  };
  try {
    const provider = await call('/providers',{method:'POST',body:{name:'Fixture official Gemini',baseUrl:apiOrigin+'/v1beta',apiKey:secret,models:[id],endpoint:'gemini_generate'}});
    officialId = provider.body?.item?.id;
    if (!officialId) throw Error('Could not create fixture Google provider');
    const connection = await call('/providers/test',{method:'POST',body:{id:officialId,scope:'provider',baseUrl:apiOrigin}});
    const refreshed = await call('/models/refresh',{method:'POST',body:{providerId:officialId}});
    const hasModels = rows => Array.isArray(rows) && rows.length===1 && rows[0]===id;
    check('Gemini 官方模型列表：根地址和 /v1beta 走同一 GET，专用 header 鉴权，无 query key',upstream.length===2 && upstream.every(h=>h.route===modelsRoute && h.method==='GET' && h.correctKey && !h.hasBearer));
    check('Gemini 官方模型结果：test 与 refresh 都还原裸模型 ID 并去除不支持 generateContent 的模型',connection.status===200 && connection.body?.ok===true && hasModels(connection.body?.models?.map(m=>m.id)) && refreshed.status===200 && hasModels(refreshed.body?.models) && refreshed.body?.items?.[0]?.kind==='image');
    const generated = await runMockJob('Official auth fixture',{providerId:officialId,model:id,endpoint:'gemini_generate',size:'1K',aspect_ratio:'1:1'});
    const [generation] = upstream.slice(2);
    check('Gemini 官方生图：一次 POST 至 /v1beta，专用 header 鉴权，不携带 Bearer 或 URL 密钥',upstream.length===3 && generation.route===generateRoute && generation.method==='POST' && generation.correctKey && !generation.hasBearer && generated.job?.status==='succeeded' && !JSON.stringify(generated.job).includes(secret));
  } finally {
    try { if (officialId) await call('/providers/delete',{method:'POST',body:{id:officialId}}); }
    finally { globalThis.fetch = realFetch; }
  }
}

await new Promise((resolve) => mockServer.close(resolve));

/* 界面那份协议表与宿主这份必须是同一套 id：两边各写一份 label 可以，
   但 id 一旦漂移，用户在下拉里选的协议就会静默失效。 */
{
  const clientSource = fs.readFileSync(new URL("../client.js", import.meta.url), "utf8");
  const block = clientSource.match(/const PROTOCOL_IDS = \[([^\]]*)\]/s)?.[1] ?? "";
  const clientIds = [...block.matchAll(/"([a-z_]+)"/g)].map((match) => match[1]);
  check(
    "界面那份协议 id 与宿主完全一致",
    clientIds.length > 0 && clientIds.slice().sort().join(",") === protocolIds.slice().sort().join(","),
    `界面 ${clientIds.length} 条 / 宿主 ${protocolIds.length} 条`
  );
}

/* ---- 3. 真图用例 -------------------------------------------------- */

if (LIVE) {
  if (!KEY) {
    check("--live 需要密钥（VIG_KEY / VELAPI_API_KEY）", false);
  } else {
    const started = Date.now();
    const created = await call("/generate", {
      method: "POST",
      body: { prompt: "一张极简工作台 UI 线稿：左侧导航、中间对话、右侧卡片", model: MODEL, size: "1024x1024", n: 1 }
    });
    check("POST /generate 入队", created.status === 200 && created.body?.job?.id, created.body?.job?.id ?? JSON.stringify(created.body));
    const jobId = created.body?.job?.id;
    let job = null;
    for (let i = 0; i < 120; i += 1) {
      await new Promise((resolve) => setTimeout(resolve, 2000));
      const polled = await call(`/job?id=${encodeURIComponent(jobId)}`);
      job = polled.body?.job;
      if (job && job.status !== "queued" && job.status !== "running") break;
      if (job && (job.status === "queued" || job.status === "running")) {
        job = { ...job, status: `running(${Math.round((Date.now() - started) / 1000)}s)` };
      }
    }
    check("任务跑到终态", job?.status === "succeeded", job?.status === "succeeded" ? `${Math.round((Date.now() - started) / 1000)}s` : `${job?.status}: ${job?.error ?? ""}`);
    check("任务产出图片记录", Array.isArray(job?.images) && job.images.length > 0, `${job?.images?.length ?? 0} 张`);
    if (job?.images?.[0]) {
      const image = await fetch(`${origin}${job.images[0].url}`);
      const bytes = Buffer.from(await image.arrayBuffer());
      // velapi 归一化后可能回 PNG 也可能是 JFIF(JPEG)，只要魔数和记录的 format 对得上就算过。
      const magic = bytes.subarray(0, 12);
      const isPng = magic[0] === 0x89 && magic.toString("latin1", 1, 4) === "PNG";
      const isJpg = magic[0] === 0xff && magic[1] === 0xd8;
      const isWebp = magic.toString("latin1", 0, 4) === "RIFF";
      check(
        "产出的图能被 GET 取回且魔数合法",
        image.status === 200 && (isPng || isJpg || isWebp),
        `${bytes.length} bytes, format=${job.images[0].format}, mime=${image.headers.get("content-type")}`
      );
      const assets = await call("/library?limit=10");
      check("图库索引收录了这张图", assets.body?.items?.[0]?.id === job.images[0].assetId, `${assets.body?.total} total`);
      const out = path.join(os.tmpdir(), `vig-smoke.${job.images[0].format || "bin"}`);
      fs.writeFileSync(out, bytes);
      console.log(`  预览图: ${out}`);
    }
    const jobs = await call("/jobs?limit=5");
    check("GET /jobs 有历史", Array.isArray(jobs.body?.items) && jobs.body.items.length > 0);
  }
}

await new Promise((resolve) => server.close(resolve));
console.log(failures === 0 ? "\n全部通过" : `\n${failures} 项失败`);
// 不用 process.exit()：Windows 上 fetch 的 keep-alive handle 还在关闭中时强退
// 会触发 libuv 断言，退出码会被污染。设 exitCode 让事件循环自己收干净。
process.exitCode = failures === 0 ? 0 : 1;
