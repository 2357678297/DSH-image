// 工具探针：证明「宿主那半边真的能注册 generate_image」——不用重启 DSH。
//
//   node tools/tool-probe.mjs                 # 默认读本机 DSH 的 app.asar
//   node tools/tool-probe.mjs --asar <路径>    # 换一个安装位置
//
// 做法：
//   1. 从 DSH 的 app.asar 里抠出 **真的** `@deepseek-ai/dsh-tools/lib/index.js`
//      （宿主跑起来时 import 的就是它），连它的 7 个依赖一起用最小桩补上；
//   2. 把桩树摆成宿主眼里的目录形状 `<resources>/app.asar/dsh/node_modules/…`，
//      设好 `process.resourcesPath`，让插件自己的 `loadDefineTool()` 按原路找到它；
//   3. 挂最小 ctx（含 `tools.register`）跑 `apply()`，捕获注册上来的工具定义；
//   4. 把工具定义原样 `execute()` 一次，打本机假上游，验「等到底拿到图 + 过程字段」；
//   5. 再验落盘的图库索引里那张素材带着 prompt / source=tool / sessionId，
//      以及 `GET /status.tool.registered === true`。
//
// 这一步只碰临时目录；不写插件 state，不连真上游。

import fs from "node:fs";
import fsp from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { apply } from "../lib/index.js";

const TEMP = os.tmpdir();
let failures = 0;
const check = (name, ok, extra = "") => {
  console.log(`${ok ? "  PASS" : "  FAIL"}  ${name}${extra ? ` — ${extra}` : ""}`);
  if (!ok) failures += 1;
};

/* ---- 1. 找到 DSH 的 app.asar ------------------------------------- */

const argIndex = process.argv.indexOf("--asar");
const asarPath =
  (argIndex > 0 ? process.argv[argIndex + 1] : "") ||
  process.env.DSH_ASAR ||
  "G:/deepseek-harness/resources/app.asar";
if (!fs.existsSync(asarPath)) {
  console.error(`找不到 ${asarPath}：用 --asar 指到 DSH 安装目录的 resources/app.asar`);
  process.exit(2);
}

/** 从 asar 里按内部路径取一个文件（asar = 16 字节头 + 头部 JSON + 数据区）。 */
function extractFromAsar(file, internalPath) {
  const fd = fs.openSync(file, "r");
  try {
    const head = Buffer.alloc(16);
    fs.readSync(fd, head, 0, 16, 0);
    const jsonLength = head.readUInt32LE(12);
    const headerBuffer = Buffer.alloc(jsonLength);
    let read = 0;
    while (read < jsonLength) {
      const got = fs.readSync(fd, headerBuffer, read, Math.min(1 << 20, jsonLength - read), 16 + read);
      if (got === 0) break;
      read += got;
    }
    const header = JSON.parse(headerBuffer.toString("utf8"));
    let node = header;
    for (const part of internalPath.split("/").filter(Boolean)) {
      node = node.files?.[part];
      if (!node) return null;
    }
    if (node.files || node.size === undefined) return null;
    const data = Buffer.alloc(node.size);
    fs.readSync(fd, data, 0, node.size, 16 + jsonLength + Number(node.offset));
    return data;
  } finally {
    fs.closeSync(fd);
  }
}

const DSH_TOOLS_ENTRY = "dsh/node_modules/@deepseek-ai/dsh-tools/lib/index.js";
const dshToolsSource = extractFromAsar(asarPath, DSH_TOOLS_ENTRY);
check("能从 app.asar 里抠出真的 dsh-tools（宿主 import 的就是这份）", Boolean(dshToolsSource) && dshToolsSource.length > 1000, `${dshToolsSource?.length ?? 0} bytes`);
if (!dshToolsSource) process.exit(1);

/* ---- 2. 搭桩树：<resources>/app.asar/dsh/node_modules/@deepseek-ai/… ---- */

const RES_ROOT = path.join(TEMP, "vig-tool-probe", "resources");
const SCOPE_MODULES = path.join(RES_ROOT, "app.asar", "dsh", "node_modules", "@deepseek-ai");
const TOOLS_LIB = path.join(SCOPE_MODULES, "dsh-tools", "lib");

/* dsh-tools 只用到这些包的一小部分；defineTool 那条路上一个都用不到，
   但模块顶层会摸它们，所以给最小实现，别在导入时就炸。 */
const STUBS = {
  cordis: `
export class Service { constructor() {} }
export const symbols = new Proxy({}, { get: (_t, key) => Symbol(String(key)) });
export const Context = class Context {};
export default { Service, symbols };
`,
  schemastery: `
function make(...args) {
  const fn = (...inner) => make(...inner);
  return new Proxy(fn, {
    get: (_t, key) => {
      if (key === "then") return undefined;
      if (key === "toString") return () => "[schemastery stub]";
      if (key === Symbol.toPrimitive) return () => 0;
      return make(String(key));
    },
    apply: () => make()
  });
}
export default make("root");
`,
  "dsh-scope": `
export class AnonymousEntries {}
export class NamedEntries {}
export class ScopedLayers {}
export const scopeOf = () => null;
export const scopeTarget = () => null;
`,
  "dsh-llm": `
export class HarnessError extends Error {
  constructor(message, code) { super(message); this.code = code; this.name = "HarnessError"; }
}
export const createUserMessage = (content) => ({ role: "user", content });
export class LlmError extends HarnessError {}
`,
  "dsh-util-values": `
export const assertNever = (_value, label) => { throw new Error("assertNever: " + label); };
export const deepFreeze = (value) => value;
export const isJsonValue = () => true;
export const snapshotJsonValue = (value) => value;
`,
  "dsh-brand": `
export const brandString = (value) => value;
`,
  "dsh-sandbox": `
export const ESCALATION_TARGETS = [];
export const approveEscalation = async () => ({});
export const validateEscalationArgs = () => [];
`
};

fs.rmSync(RES_ROOT, { recursive: true, force: true });
await fsp.mkdir(TOOLS_LIB, { recursive: true });
fs.writeFileSync(path.join(TOOLS_LIB, "index.js"), dshToolsSource);
for (const [name, source] of Object.entries(STUBS)) {
  const dir = path.join(SCOPE_MODULES, name);
  await fsp.mkdir(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "package.json"), JSON.stringify({ name, version: "0.0.0", type: "module", main: "index.js" }));
  fs.writeFileSync(path.join(dir, "index.js"), source);
}
process.resourcesPath = RES_ROOT;
const dshTools = await import(pathToFileURL(path.join(TOOLS_LIB, "index.js")).href).catch((error) => {
  console.log("  桩依赖导入失败：", error.message);
  return null;
});
check("桩路径能解析到真的 defineTool（和宿主走的同一个 fallback 位置）", typeof dshTools?.defineTool === "function");

/* ---- 3. 假上游：回一张 1x1 PNG ---- */

const PNG_1X1 = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";
const hits = [];
const mock = http.createServer((request, response) => {
  const chunks = [];
  request.on("data", (chunk) => chunks.push(chunk));
  request.on("end", () => {
    hits.push(String(request.url || ""));
    const body = JSON.stringify({
      created: Math.floor(Date.now() / 1000),
      data: [{ b64_json: PNG_1X1, revised_prompt: "探针改写过的那句" }]
    });
    response.writeHead(200, { "content-type": "application/json", "content-length": Buffer.byteLength(body) });
    response.end(body);
  });
});
await new Promise((resolve) => mock.listen(0, "127.0.0.1", resolve));
const mockBase = `http://127.0.0.1:${mock.address().port}/v1`;

/* ---- 4. 最小 ctx + 真 apply() ---- */

const stateDir = fs.mkdtempSync(path.join(TEMP, "vig-tool-probe-"));
const routes = [];
const registered = [];
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
  logger: { info: () => {}, warn: () => {} },
  webServer: {
    register(route) {
      routes.push(route);
      return () => {};
    }
  },
  tools: {
    register(definition) {
      registered.push(definition);
      return () => {};
    }
  }
};
apply(ctx, {
  stateDir,
  baseUrl: mockBase,
  apiKey: "sk-mock",
  apiKeyEnv: "VIG_KEY",
  defaultModel: "mock-image",
  concurrency: 2,
  timeoutMs: 30000,
  surfaces: ["settings"],
  guideCount: 1
});

/* 注册发生在 ready 里：给它一点时间 */
for (let i = 0; i < 100 && registered.length === 0; i += 1) {
  await new Promise((resolve) => setTimeout(resolve, 50));
}
const definition = registered[0] ?? null;
check("宿主 ctx.tools.register 收到一个工具", registered.length === 1, `${registered.length} 个`);
check("工具名是 generate_image", definition?.name === "generate_image", String(definition?.name ?? ""));
check(
  "参数 schema 编译成对象根（prompt 在里面，别的都可省）",
  definition?.parameters?.type === "object" &&
    Object.keys(definition?.parameters?.properties ?? {}).includes("prompt") &&
    !(definition?.parameters?.required ?? []).includes("prompt"),
  JSON.stringify(definition?.parameters?.required ?? [])
);
check(
  "输出 schema 是对象根（ok / jobId / assets …）",
  definition?.output?.schema?.type === "object" && Object.keys(definition?.output?.schema?.properties ?? {}).includes("assets"),
  Object.keys(definition?.output?.schema?.properties ?? {}).join(",")
);
check(
  "presentCall 能给出调用卡片",
  (() => {
    const card = definition?.presentCall?.({ prompt: "探针图" });
    return card && card.card === "generic" && card.title === "generate_image";
  })(),
  JSON.stringify(definition?.presentCall?.({ prompt: "探针图" }) ?? null)
);

/* ---- 5. 真跑一次 execute() ---- */

let result = null;
let thrown = null;
try {
  result = await definition.execute(
    { prompt: "探针图一只猫", model: "mock-image", size: "1024x1024", n: 1, protocol: "images_generations" },
    { sessionId: "sess-probe-1" }
  );
} catch (error) {
  thrown = error;
}
check("execute() 没炸", thrown === null, thrown ? String(thrown?.message ?? thrown) : "");
check(
  "execute() 返回 ok 且带图（等到底，不是一个 task id）",
  result?.ok === true &&
    Array.isArray(result?.assets) &&
    result.assets.length === 1 &&
    /^\/api\/velapi-image-go\/asset\//.test(result.assets[0]?.url ?? ""),
  JSON.stringify(result?.assets?.[0] ?? null)
);
check(
  "返回体带过程：提示词 / 模型 / 尺寸 / 协议 / 会话 / 耗时",
  result?.prompt === "探针图一只猫" &&
    result?.model === "mock-image" &&
    result?.size === "1024x1024" &&
    result?.protocol === "images_generations" &&
    result?.sessionId === "sess-probe-1" &&
    typeof result?.elapsedMs === "number",
  JSON.stringify({ prompt: result?.prompt, model: result?.model, protocol: result?.protocol, sessionId: result?.sessionId })
);
check("上游真的被打了一次 /v1/images/generations", hits.includes("/v1/images/generations"), hits.join(","));

/* ---- 6. 落盘素材与 /status ---- */

const libraryRaw = JSON.parse(fs.readFileSync(path.join(stateDir, "library", "index.json"), "utf8"));
const libraryItems = Array.isArray(libraryRaw) ? libraryRaw : (libraryRaw.items ?? []);
const asset = libraryItems[0] ?? null;
check(
  "图库索引里的素材带 prompt / model / size / jobId / source=tool / sessionId",
  asset?.prompt === "探针图一只猫" &&
    asset?.model === "mock-image" &&
    asset?.size === "1024x1024" &&
    asset?.jobId === result?.jobId &&
    asset?.source === "tool" &&
    asset?.sessionId === "sess-probe-1",
  JSON.stringify(asset ? { prompt: asset.prompt, source: asset.source, sessionId: asset.sessionId, jobId: asset.jobId } : null)
);

const route = routes[0];
const server = http.createServer((request, response) => route.handler(request, response));
await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
const origin = `http://127.0.0.1:${server.address().port}`;
const status = await (await fetch(`${origin}/api/velapi-image-go/status`)).json();
check(
  "GET /status 报 tool.registered = true",
  status?.tool?.registered === true && status?.tool?.name === "generate_image",
  JSON.stringify(status?.tool ?? null)
);

await new Promise((resolve) => server.close(resolve));
await new Promise((resolve) => mock.close(resolve));
fs.rmSync(RES_ROOT, { recursive: true, force: true });
fs.rmSync(stateDir, { recursive: true, force: true });
console.log(failures === 0 ? "\n工具探针全部通过" : `\n${failures} 项失败`);
process.exitCode = failures === 0 ? 0 : 1;
