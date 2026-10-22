/**
 * dsh-plugin-velapi-image-go — host half.
 *
 * 「API 对话生图工作台」的服务端半边。整个插件只有两件事：
 *
 * 1. 把浏览器半边（`client.js`，注册在右侧栏 / 设置页的席位）需要的一切
 *    暴露成一组普通 HTTP 路由，前缀 `/api/velapi-image-go`；
 * 2. 真正去上游把图生出来——OpenAI 兼容的 `POST /v1/images/generations`
 *    与 `POST /v1/images/edits`，然后把产出的图**落盘**成本地图库，而不是
 *    只把一段会过期的 URL 丢给浏览器。
 *
 * 为什么不是一条 `/api` RPC：`/api/*` 是 connection 的 RPC 面，未认领的
 * 端点会返回 200 + 失败信封（见 dsh-plugin-present-open 的注释）。路由匹配
 * 顺序是「先整表精确 → 再最长前缀 → 最后 fallback」，所以这里注册一条比
 * `/api` 更长的前缀 route 即可稳定胜出，且不与任何内置端点相撞。
 *
 * 落盘位置：`$DSH_HOME/state/velapi-image-go/`（默认 `~/.dsh/state/velapi-image-go`）
 *
 *   config.json          运行期配置（含明文密钥，权限收紧到 0600）
 *   providers.json       供应商清单
 *   catalog.json         各供应商模型目录缓存
 *   notes.json           信息管理：提示词 / 元信息记录
 *   presets.json         预设卡：标题 / 提示词 / 参考图（首次启动种一批趣味预设）
 *   jobs.json            任务历史（保留最近 200 条）
 *   library/index.json   图库索引
 *   library/files/*      图库原图
 *   uploads/*            上传的参考图
 *   assets/presets/*     内置预设卡的参考图（随包分发）
 *
 * @module dsh-plugin-velapi-image-go
 */

import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import crypto from "node:crypto";
import { spawn, execFile } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";

/**
 * `defineTool` 随 app.asar 发布，插件目录里解析不到它 ——
 * 先按常规解析，再按 Electron 的 asar 布局找（Electron 的 fs 能读 asar 内部路径）。
 * 全失败就退化成「只有 HTTP 接口、没有工具」，并在 /status 里写明原因，不静默。
 */
async function loadDefineTool() {
  try {
    const module = await import("@deepseek-ai/dsh-tools");
    if (typeof module?.defineTool === "function") return module.defineTool;
  } catch {
    /* 插件目录里没有这个包，走 asar 布局 */
  }
  const resources = process.resourcesPath;
  if (!resources) return null;
  const candidates = [
    ["app.asar", "dsh", "node_modules"],
    ["app.asar", "node_modules"],
    ["app", "node_modules"]
  ].map((parts) => pathToFileURL(path.join(resources, ...parts, "@deepseek-ai", "dsh-tools", "lib", "index.js")).href);
  for (const href of candidates) {
    try {
      const module = await import(href);
      if (typeof module?.defineTool === "function") return module.defineTool;
    } catch {
      /* 换下一个布局 */
    }
  }
  return null;
}

/** Cordis plugin name. */
export const name = "velapi-image-go";

/** 需要的宿主服务：HTTP 服务器（注册路由）与日志。 */
export const inject = ["webServer", "tools"];

/** 路由前缀：比 `/api` 更长，所以稳定赢过 RPC 面的前缀 route。 */
const ROUTE_PREFIX = "/api/velapi-image-go";

/** 单次生成张数上限（velapi 文档：图片 n ≤ 8）。 */
const MAX_N = 8;

/**
 * 端点协议：供应商记一个协议，生成时按协议决定打到哪条路由。
 * 选项抄中转站自己那张表（自动检测 / OpenAI / Responses / Responses compact / Anthropic /
 * Gemini / Jina Rerank / Embeddings），再补上生图这条链要用的三条：
 * `POST /v1/images/generations`、`POST /v1/images/edits`、`POST /v1/videos/generations`。
 * `baseUrl` 已经含 `/v1`，所以这里的 route 是相对路径。
 */
const PROTOCOLS = [
  { id: "auto", label: "自动检测（默认）", route: "", kind: "auto" },
  { id: "openai_chat", label: "OpenAI（/v1/chat/completions）", route: "/chat/completions", kind: "chat" },
  { id: "openai_responses", label: "OpenAI Responses（/v1/responses）", route: "/responses", kind: "chat" },
  { id: "openai_responses_compact", label: "OpenAI Response Compaction（/v1/responses/compact）", route: "/responses/compact", kind: "chat" },
  { id: "anthropic_messages", label: "Anthropic（/v1/messages）", route: "/messages", kind: "chat" },
  { id: "gemini_generate", label: "Gemini（/v1beta/models/{model}:generateContent）", route: "/models/{model}:generateContent", kind: "chat" },
  { id: "jina_rerank", label: "Jina Rerank（/v1/rerank）", route: "/rerank", kind: "rerank" },
  { id: "images_generations", label: "图片生成（/v1/images/generations）", route: "/images/generations", kind: "image" },
  { id: "images_edits", label: "图片编辑（/v1/images/edits）", route: "/images/edits", kind: "image" },
  { id: "videos_generations", label: "视频生成（/v1/videos/generations）", route: "/videos/generations", kind: "video" },
  { id: "embeddings", label: "向量（/v1/embeddings）", route: "/embeddings", kind: "embedding" }
];

const PROTOCOL_IDS = new Set(PROTOCOLS.map((protocol) => protocol.id));

/** 认不出来的协议一律回落到「自动检测」，不因为一个手滑的字符串把生成打死。 */
function normalizeProtocolId(value) {
  const id = String(value ?? "").trim();
  return PROTOCOL_IDS.has(id) ? id : "auto";
}

function protocolById(value) {
  const id = normalizeProtocolId(value);
  return PROTOCOLS.find((protocol) => protocol.id === id) ?? PROTOCOLS[0];
}

/**
 * 协议取舍：谁更明确听谁的。
 * 请求里写死的 > 界面上选的（`config.defaultEndpoint`）> 供应商记录 > 自动检测。
 * 「自动检测」是缺省值，所以它不压过上层任何更明确的选择 —— 否则在输入框那一行
 * 选了「图片编辑」，却因为供应商记录里留着 auto 而静默失效。
 */
function resolveProtocol({ requested, preferred, fallback }) {
  for (const candidate of [requested, preferred, fallback]) {
    const id = normalizeProtocolId(candidate);
    if (id !== "auto") return id;
  }
  return "auto";
}

/** 原始报错留多少字：够看清上游说了什么，又不至于把 jobs.json 撑爆。 */
const MAX_ERROR_BODY = 4000;

/** 随包分发的内置资源目录（预设卡的参考图）。 */
const PRESET_ROOT = path.join(path.dirname(path.dirname(fileURLToPath(import.meta.url))), "assets", "presets");

/* ------------------------------------------------------------------ *
 * 更新通道（/update/check）
 *
 * 插件源码在 GitHub（package.json 的 repository 指向它）。检查更新的方式：
 * `git ls-remote <repo> refs/heads/main` 拿远端 HEAD，和本地 `git rev-parse HEAD` 比。
 * 走 git 而不是 GitHub API：公开仓库不需要 token，也不会被 API 速率卡住；
 * 本机 git 已经能 push（凭据在 Credential Manager 里），ls-remote 自然也能用。
 * ------------------------------------------------------------------ */
const PLUGIN_ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const PLUGIN_VERSION = "0.1.0";
const UPDATE_REPO_DEFAULT = "https://github.com/2357678297/DSH-image.git";
const UPDATE_BRANCH = "main";

/** 跑一条 git 命令：失败不抛，返回 {ok, stdout, stderr}。 */
function runGit(args, { cwd = PLUGIN_ROOT, timeout = 15000 } = {}) {
  return new Promise((resolve) => {
    execFile("git", args, { cwd, timeout, windowsHide: true, maxBuffer: 4 * 1024 * 1024 }, (error, stdout, stderr) => {
      resolve({
        ok: !error,
        stdout: String(stdout || "").trim(),
        stderr: String(stderr || error?.message || "").trim()
      });
    });
  });
}

/**
 * 内置预设卡：标题 + 提示词 + 参考图。
 * 参考图是随包的 256×256 PNG（`assets/presets/*`），走宿主 `/preset/<name>` 提供；
 * 首次启动写进 `stateDir/presets.json`，之后随便改随便删，不会被覆盖回来。
 */
function seedPresets() {
  const now = new Date().toISOString();
  const card = (id, title, prompt, image, tags) => ({
    id,
    title,
    prompt,
    image: image ? `/api/velapi-image-go/preset/${image}` : "",
    tags,
    builtin: true,
    createdAt: now,
    updatedAt: now
  });
  return [
    card(
      "seed-product",
      "产品主图",
      "一张极简产品主图：纯白影棚背景，柔和顶光与淡淡投影，产品居中 45° 俯拍，杂志级商业摄影，高清细节",
      "product-stand.png",
      ["电商", "白底", "商业"]
    ),
    card(
      "seed-sticker",
      "爆炸贴纸",
      "一枚夸张的爆炸形贴纸：粗黑描边、高饱和撞色、卡通漫画风，白底居中，适合做表情包",
      "sticker-burst.png",
      ["贴纸", "趣味", "表情包"]
    ),
    card(
      "seed-pixel",
      "像素冒险",
      "16bit 像素风游戏画面：等距视角的小场景，复古色板、硬边像素、无抗锯齿，像 SFC 时代的截图",
      "pixel-quest.png",
      ["像素", "游戏", "复古"]
    ),
    card(
      "seed-ink",
      "国风工笔",
      "国风工笔山水：宣纸暖底，淡墨远山与朱红落日，留白讲究，笔触细腻，题款位置留空",
      "ink-landscape.png",
      ["国风", "插画", "留白"]
    ),
    card("seed-lineart", "工作台线稿", "极简工作台 UI 线稿：左侧导航、中间对话区、右侧信息卡片，细线条、无阴影、白底", "", ["UI", "线稿", "参考图"]),
    card("seed-avatar", "头像特写", "一位创作者的半身头像：柔和侧光、浅灰背景、胶片质感、眼神有故事感，竖构图", "", ["人物", "头像", "胶片"]),
    card("seed-scene", "窗边场景", "木桌上的产品场景图：清晨窗边自然光、绿植虚化背景、浅景深、暖色调，真实摄影质感", "", ["场景", "自然光", "生活方式"]),
    card("seed-poster", "极简海报", "极简海报版式：大字标题 + 几何色块分割 + 细网格对齐，留白充足，适合电商活动主视觉", "", ["海报", "版式", "极简"])
  ];
}

/** 预设卡规范化：标题/提示词必填其一，参考图只收本站路径或 dataURL。 */
function normalizePreset(input, existing) {
  const image = typeof input?.image === "string" ? input.image.trim() : existing?.image ?? "";
  return {
    id: "",
    title: trimText(input?.title, 60) || existing?.title || "未命名预设",
    prompt: trimText(input?.prompt, 2000),
    image: /^(data:image\/|\/api\/velapi-image-go\/)/.test(image) ? image.slice(0, 400000) : "",
    tags: Array.isArray(input?.tags)
      ? input.tags.map((tag) => trimText(String(tag), 16)).filter(Boolean).slice(0, 6)
      : existing?.tags ?? [],
    builtin: Boolean(existing?.builtin),
    createdAt: existing?.createdAt || new Date().toISOString(),
    updatedAt: new Date().toISOString()
  };
}

/** 任务历史上限。 */
const MAX_JOBS = 200;
// 对话（会话）：任务都归到某个对话下；老数据没有 conversationId 就归默认对话
const DEFAULT_CONVERSATION_ID = "conv_default";
/** 客户端自检回执保留条数：够看清「一次重启里 apply / 登记 / 落定」三个阶段就够。 */
const MAX_CLIENT_REPORTS = 12;

/** 请求体上限：参考图走 base64，留 24 MiB。 */
const MAX_BODY_BYTES = 24 * 1024 * 1024;

/** 视频生成常用的比例与分辨率档（主流 API 的 aspect_ratio / resolution 归一到这里）。 */
const VIDEO_RATIOS = ["16:9", "9:16", "1:1", "4:3", "3:4", "21:9"];
const VIDEO_RESOLUTIONS = ["480p", "720p", "1080p"];
/** 视频时长档（秒）：主流 API 的 seconds / duration 归一到这里。 */
const VIDEO_SECONDS = ["4", "6", "8", "10", "12"];

/** 生产可用的默认值；cordis.patch.yml 里的 config 逐字段覆盖。 */
const DEFAULTS = Object.freeze({
  surfaces: ["rightbar", "settings"],
  baseUrl: "https://api.velapi.cc/v1",
  apiKey: "",
  apiKeyEnv: "VELAPI_API_KEY",
  defaultModel: "nano-banana-2.1",
  defaultSize: "1024x1024",
  // 视频模型单独一套尺寸：切协议时不会把图片尺寸写坏（用户要求「视频参数和图片配置分开」）
  videoSize: "1280x720",
  // 视频参数按「比例 / 分辨率」分开选（用户要求）：像素 size 由两者组合得出
  videoRatio: "16:9",
  videoResolution: "720p",
  videoSeconds: "4",
  defaultQuality: "LOW",
  defaultCount: 1,
  // 生成时打哪条路由：界面上输入框那一行的「协议」选择写的就是它。
  // 空值 = 自动检测（带参考图走 /images/edits，不带就走 /images/generations）。
  defaultEndpoint: "auto",
  // 对话上下文管理模型：用一个「对话模型」接住多轮消息 → 写成这一轮的出图提示词。
  // 空 = 自动从供应商目录里挑一个对话模型；contextTurns = 喂给它最近几轮。
  chatModel: "",
  contextTurns: 6,
  concurrency: 3,
  timeoutMs: 300000,
  stateDir: "",
  saveDir: "",
  guideOrder: 30
});

/* ------------------------------------------------------------------ *
 * 基础工具
 * ------------------------------------------------------------------ */

/** 展开 `~` 与 `~/`：宿主可能从服务或桌面两种入口拉起，路径要都能认。 */
function expandHome(value) {
  if (typeof value !== "string" || value.length === 0) return value;
  if (value === "~") return os.homedir();
  if (value.startsWith("~/") || value.startsWith("~\\")) {
    return path.join(os.homedir(), value.slice(2));
  }
  return value;
}

/** 解析 harness 数据根：显式 stateDir > $DSH_HOME > ~/.dsh。 */
function resolveStateDir(config) {
  if (config?.stateDir) return path.resolve(expandHome(String(config.stateDir)));
  const envHome = typeof process.env.DSH_HOME === "string" ? process.env.DSH_HOME.trim() : "";
  const home = envHome.length > 0 ? envHome : path.join(os.homedir(), ".dsh");
  return path.join(home, "state", "velapi-image-go");
}

/**
 * 素材目录的「指针」：默认目录下放一份 location.json，里面写真正在用的目录。
 * config.json 会跟着素材一起搬到新目录，所以不能拿它当指针 —— 否则换了目录之后
 * 重启会先回默认目录、读那里的旧配置，改动就丢了。
 */
function readStateRoot(fallbackDir) {
  try {
    const raw = JSON.parse(fs.readFileSync(path.join(fallbackDir, "location.json"), "utf8"));
    const value = typeof raw?.stateDir === "string" ? raw.stateDir.trim() : "";
    if (value) return path.resolve(expandHome(value));
  } catch {
    /* 没有指针文件 = 用默认目录 */
  }
  return "";
}

/** 写/清指针文件：切回默认目录时把它删掉，菜单里的「默认」才算真的回到默认。 */
async function writeStateRoot(fallbackDir, nextDir) {
  await fsp.mkdir(fallbackDir, { recursive: true });
  const file = path.join(fallbackDir, "location.json");
  if (!nextDir || path.resolve(nextDir) === path.resolve(fallbackDir)) {
    await fsp.rm(file, { force: true });
    return;
  }
  await writeJsonAtomic(file, { stateDir: nextDir, updatedAt: new Date().toISOString() });
}

/** 短 id：时间有序 + 随机尾巴，肉眼可排序、并发不撞。 */
function newId(prefix) {
  const stamp = Date.now().toString(36);
  const rnd = crypto.randomBytes(4).toString("hex");
  return `${prefix}_${stamp}${rnd}`;
}

/** 只露尾四位，用它给界面一个可核对的把手。 */
function maskKey(secret) {
  const value = typeof secret === "string" ? secret.trim() : "";
  if (value.length === 0) return "";
  if (value.length <= 8) return "•".repeat(value.length);
  return `${value.slice(0, 3)}••••${value.slice(-4)}`;
}

/**
 * 原子写：同目录临时文件 + rename，避免半截 JSON 被下次启动读进去。
 *
 * Windows 上 rename 覆盖已存在的文件会被外部句柄（杀软 / 索引器 / 另一个写者）挡下来，
 * 抛 EPERM / EBUSY / EACCES —— 一次抖动不该让任务崩掉，所以：
 *   1. 同一个文件串行化（队列按路径排队），自己人不跟自己人撞；
 *   2. rename 失败退避重试几次（最常见的就是几百毫秒的锁）；
 *   3. 临时文件写歪了也要清掉，别在状态目录里攒垃圾。
 */
const writeQueues = new Map();
const RENAME_RETRY_DELAYS = [20, 60, 150, 300];

async function writeJsonAtomicOnce(file, value, mode) {
  const dir = path.dirname(file);
  await fsp.mkdir(dir, { recursive: true });
  const tmp = path.join(dir, `.${path.basename(file)}.${process.pid}.${Date.now()}.tmp`);
  await fsp.writeFile(tmp, `${JSON.stringify(value, null, 2)}\n`, { encoding: "utf8", mode });
  let lastError = null;
  for (let attempt = 0; attempt <= RENAME_RETRY_DELAYS.length; attempt += 1) {
    try {
      await fsp.rename(tmp, file);
      return;
    } catch (error) {
      lastError = error;
      if (!["EPERM", "EBUSY", "EACCES", "EEXIST"].includes(error?.code)) break;
      await new Promise((resolve) => setTimeout(resolve, RENAME_RETRY_DELAYS[attempt] ?? 300));
    }
  }
  await fsp.rm(tmp, { force: true }).catch(() => {});
  throw lastError;
}

async function writeJsonAtomic(file, value, mode = 0o600) {
  const previous = writeQueues.get(file) ?? Promise.resolve();
  const next = previous.catch(() => {}).then(() => writeJsonAtomicOnce(file, value, mode));
  // 队列自己不能因为一次失败就断掉（下一个写者还得排上）
  writeQueues.set(
    file,
    next.catch(() => {})
  );
  return next;
}

async function readJson(file, fallback) {
  try {
    const raw = await fsp.readFile(file, "utf8");
    if (raw.trim().length === 0) return fallback;
    return JSON.parse(raw);
  } catch {
    return fallback;
  }
}

/** 把未知输入收成一个有限标量集合里的值。 */
function oneOf(value, allowed, fallback) {
  return allowed.includes(value) ? value : fallback;
}

function clampInt(value, min, max, fallback) {
  const num = Number.parseInt(value, 10);
  if (!Number.isFinite(num)) return fallback;
  return Math.min(max, Math.max(min, num));
}

function trimText(value, limit = 4000) {
  if (typeof value !== "string") return "";
  const text = value.trim();
  return text.length > limit ? text.slice(0, limit) : text;
}

/** 从 "1024x1024" 里取宽高；上游对 size 的校验很松，这里只做展示用解析。 */
function parseSize(size) {
  const match = /^(\d{2,5})\s*[x×]\s*(\d{2,5})$/i.exec(String(size ?? ""));
  if (!match) return { width: 0, height: 0 };
  return { width: Number(match[1]), height: Number(match[2]) };
}

/** 最小图片嗅探：只读头部，用来在图库里标注真实格式与像素。 */
function sniffImage(buffer) {
  const out = { format: "bin", mime: "application/octet-stream", width: 0, height: 0 };
  if (!Buffer.isBuffer(buffer) || buffer.length < 16) return out;
  if (buffer[0] === 0x89 && buffer.toString("latin1", 1, 4) === "PNG") {
    out.format = "png";
    out.mime = "image/png";
    out.width = buffer.readUInt32BE(16);
    out.height = buffer.readUInt32BE(20);
    return out;
  }
  if (buffer[0] === 0xff && buffer[1] === 0xd8) {
    out.format = "jpg";
    out.mime = "image/jpeg";
    let offset = 2;
    while (offset + 9 < buffer.length) {
      if (buffer[offset] !== 0xff) {
        offset += 1;
        continue;
      }
      const marker = buffer[offset + 1];
      const length = buffer.readUInt16BE(offset + 2);
      if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
        out.height = buffer.readUInt16BE(offset + 5);
        out.width = buffer.readUInt16BE(offset + 7);
        return out;
      }
      offset += 2 + length;
    }
    return out;
  }
  if (buffer.toString("latin1", 0, 4) === "RIFF" && buffer.toString("latin1", 8, 12) === "WEBP") {
    out.format = "webp";
    out.mime = "image/webp";
    return out;
  }
  if (buffer.toString("latin1", 0, 3) === "GIF") {
    out.format = "gif";
    out.mime = "image/gif";
    out.width = buffer.readUInt16LE(6);
    out.height = buffer.readUInt16LE(8);
  }
  return out;
}

const MIME_EXT = {
  "image/png": "png",
  "image/jpeg": "jpg",
  "image/jpg": "jpg",
  "image/webp": "webp",
  "image/gif": "gif",
  "image/avif": "avif"
};

/** 解码 data URL / 裸 base64；顺带把 mime 归一化。
 *  裸 base64 必须真解出一张可识别的图（PNG/JPEG/WebP/GIF 魔数）才认：
 *  踩过「把 /api/.../asset/xxx.png 这串 URL 当 base64 解出 37 字节假图、
 *  原样发给上游吃 400」的坑 —— URL 里的字母数字能解出字节，但没有图片魔数。 */
function decodeBase64Image(input) {
  const raw = typeof input === "string" ? input.trim() : "";
  if (raw.length === 0) return null;
  const match = /^data:([\w./+-]+);base64,(.*)$/is.exec(raw);
  const data = match ? match[2] : raw;
  let buffer;
  try {
    buffer = Buffer.from(data.replace(/\s+/g, ""), "base64");
  } catch {
    return null;
  }
  if (buffer.length === 0) return null;
  if (!match) {
    // 没有 data: 前缀就不信 mime，按魔数验一遍；验不出 = 不是图片
    const sniffed = sniffImage(buffer);
    if (sniffed.format === "bin") return null;
    return { buffer, mime: sniffed.mime };
  }
  return { buffer, mime: match[1].toLowerCase() };
}

/* ------------------------------------------------------------------ *
 * 上游调用
 * ------------------------------------------------------------------ */

/** 生成请求的载荷：只带上游认识的字段，其余一律不加。 */
function buildGenerationBody(request, model, size, quality, count) {
  const body = {
    model,
    prompt: request.prompt,
    n: count,
    size,
    response_format: "url"
  };
  if (quality) body.quality = quality;
  return body;
}

/** 去掉空字段（视频那条链的可选参数不少，塞 null 会被上游当非法参数拒掉）。 */
function cleanBody(input) {
  const output = {};
  for (const [key, value] of Object.entries(input ?? {})) {
    if (value === undefined || value === null || value === "") continue;
    output[key] = value;
  }
  return output;
}

/** 从上游响应里尽量捞一个可点的地址（视频任务体各家中转站字段不一致）。 */
function findFirstUrl(payload, depth = 0) {
  if (!payload || depth > 4) return null;
  if (typeof payload === "string") return /^https?:\/\//i.test(payload) ? payload : null;
  if (Array.isArray(payload)) {
    for (const item of payload) {
      const hit = findFirstUrl(item, depth + 1);
      if (hit) return hit;
    }
    return null;
  }
  if (typeof payload !== "object") return null;
  for (const key of ["url", "video_url", "videoUrl", "output", "download_url", "file_url", "result_url"]) {
    const value = payload[key];
    if (typeof value === "string" && /^https?:\/\//i.test(value)) return value;
  }
  for (const value of Object.values(payload)) {
    const hit = findFirstUrl(value, depth + 1);
    if (hit) return hit;
  }
  return null;
}

/**
 * 上游请求统一走这里：超时、错误信封、以及「上游返回非 JSON」的兜底。
 * `error.code` 会原样带到界面上，便于区分配置错误与上游拒绝；
 * `error.detail` 带的是**原始**证据（HTTP 状态、响应体原文、请求地址、模型），
 * 界面上那句「生成请求失败」就是中转站自己的话，真正有用的东西在 detail 里。
 */
async function callUpstream({ baseUrl, apiKey, route, body, form = null, timeoutMs, signal }) {
  const url = `${baseUrl.replace(/\/+$/, "")}${route}`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const onAbort = () => controller.abort();
  if (signal) signal.addEventListener("abort", onAbort, { once: true });
  const startedAt = Date.now();
  try {
    // 图生图（/images/edits）必须走 multipart/form-data：OpenAI 那套接口只认文件字段，
    // 塞 JSON + base64 会被回 400 "image file or image_url is required"（踩过）。
    const headers = { authorization: `Bearer ${apiKey}` };
    if (!form) headers["content-type"] = "application/json";
    // 证据里要写清这次用的模型：表单请求只能从 form 里取
    const requestModel = form ? String(form.get("model") || "") : body?.model || "";
    const response = await fetch(url, {
      method: "POST",
      headers,
      body: form ?? JSON.stringify(body),
      signal: controller.signal
    });
    const text = await response.text();
    let payload = null;
    try {
      payload = text.length > 0 ? JSON.parse(text) : null;
    } catch {
      payload = null;
    }
    if (!response.ok) {
      const message =
        payload?.error?.message || payload?.message || text.slice(0, 400) || `HTTP ${response.status}`;
      const error = new Error(message);
      error.code = payload?.error?.code || `upstream_${response.status}`;
      error.status = response.status;
      error.detail = {
        kind: "upstream",
        method: "POST",
        url,
        status: response.status,
        statusText: response.statusText || "",
        code: error.code,
        model: requestModel,
        route,
        body: text.slice(0, MAX_ERROR_BODY),
        json: payload
      };
      throw error;
    }
    if (!payload) {
      const error = new Error("上游返回了非 JSON 响应");
      error.code = "upstream_non_json";
      error.detail = { kind: "upstream_non_json", method: "POST", url, status: response.status, model: requestModel, body: text.slice(0, MAX_ERROR_BODY) };
      throw error;
    }
    return { payload, elapsedMs: Date.now() - startedAt };
  } catch (error) {
    if (error?.name === "AbortError") {
      const timeout = new Error(`上游请求超时（${Math.round(timeoutMs / 1000)}s）`);
      timeout.code = "upstream_timeout";
      timeout.detail = { kind: "timeout", method: "POST", url, timeoutMs, model: requestModel };
      throw timeout;
    }
    // 连不上（DNS / 拒绝连接 / 证书）：fetch 抛的是 TypeError，真正的原因在 cause 上
    if (!error?.detail && (error?.name === "TypeError" || error?.cause)) {
      error.detail = {
        kind: "network",
        method: "POST",
        url,
        model: requestModel,
        cause: String(error?.cause?.code || error?.cause?.message || error?.message || "")
      };
    }
    throw error;
  } finally {
    clearTimeout(timer);
    if (signal) signal.removeEventListener("abort", onAbort);
  }
}

/** 取模型目录：`GET /v1/models`。
 *  中转站每条会带 image_family / video_family，里面写明 kind（image / video）——
 *  这是分类的权威来源，不要靠模型名猜（踩过：omni-flash 被猜成「对话」，实际是视频）。 */
async function fetchModels({ baseUrl, apiKey, timeoutMs }) {
  const url = `${baseUrl.replace(/\/+$/, "")}/models`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), Math.min(timeoutMs, 30000));
  try {
    const response = await fetch(url, {
      headers: { authorization: `Bearer ${apiKey}` },
      signal: controller.signal
    });
    const text = await response.text();
    let payload = null;
    try {
      payload = text.length > 0 ? JSON.parse(text) : null;
    } catch {
      payload = null;
    }
    if (!response.ok) {
      const message = payload?.error?.message || text.slice(0, 300) || `HTTP ${response.status}`;
      const error = new Error(message);
      error.status = response.status;
      error.code = payload?.error?.code || `upstream_${response.status}`;
      error.detail = {
        kind: "upstream",
        method: "GET",
        url,
        status: response.status,
        statusText: response.statusText || "",
        code: error.code,
        body: text.slice(0, MAX_ERROR_BODY)
      };
      throw error;
    }
    const items = Array.isArray(payload?.data) ? payload.data : [];
    return items
      .map((item) => {
        const id = typeof item?.id === "string" ? item.id : null;
        if (!id) return null;
        const family = item?.image_family || item?.video_family || item?.audio_family || null;
        const profiles = Array.isArray(family?.profiles) ? family.profiles : [];
        return {
          id,
          kind: typeof family?.kind === "string" ? family.kind : typeof item?.kind === "string" ? item.kind : "",
          label: typeof family?.label === "string" ? family.label : "",
          enabled: item?.enabled !== false,
          status: typeof item?.status === "string" ? item.status : "",
          modes: [...new Set(profiles.map((profile) => profile?.mode).filter(Boolean))]
        };
      })
      .filter(Boolean)
      .sort((a, b) => a.id.localeCompare(b.id));
  } finally {
    clearTimeout(timer);
  }
}

/** 上游返回的图：url 与 b64_json 两种形态都要收。 */
function pickImagePayload(payload) {
  const first = Array.isArray(payload?.data) ? payload.data[0] : null;
  if (!first) return null;
  if (typeof first.b64_json === "string" && first.b64_json.length > 0) {
    const decoded = decodeBase64Image(first.b64_json);
    if (decoded) return { kind: "b64", ...decoded };
  }
  if (typeof first.url === "string" && first.url.length > 0) return { kind: "url", url: first.url };
  return null;
}

/** 下载上游图；失败就报错，不做静默降级（图库里不允许出现半张图）。 */
async function downloadImage(url, timeoutMs) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), Math.min(timeoutMs, 180000));
  try {
    const response = await fetch(url, { signal: controller.signal, redirect: "follow" });
    if (!response.ok) {
      const text = await response.text().catch(() => "");
      const error = new Error(`下载图片失败：HTTP ${response.status}`);
      error.code = `download_${response.status}`;
      error.detail = { kind: "download", method: "GET", url, status: response.status, body: text.slice(0, MAX_ERROR_BODY) };
      throw error;
    }
    const buffer = Buffer.from(await response.arrayBuffer());
    if (buffer.length === 0) {
      const error = new Error("下载图片得到空响应");
      error.code = "download_empty";
      error.detail = { kind: "download", method: "GET", url, status: response.status, body: "" };
      throw error;
    }
    return buffer;
  } finally {
    clearTimeout(timer);
  }
}

/* ------------------------------------------------------------------ *
 * 对话上下文管理：把多轮消息整理成这一轮的出图提示词
 * ------------------------------------------------------------------ */

/** 从 OpenAI 兼容的 chat/completions 回包里捞出正文（兼容字符串 / parts 数组）。 */
function extractChatText(payload) {
  const content = payload?.choices?.[0]?.message?.content ?? payload?.choices?.[0]?.text ?? payload?.output?.text ?? "";
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content.map((part) => (typeof part === "string" ? part : part?.text ?? "")).join("");
  }
  return "";
}

/** 对话模型被要求只输出 JSON；容错掉 ```json 围栏与前后废话。 */
function parsePlanJson(text) {
  let raw = String(text || "").trim();
  if (!raw) return null;
  raw = raw.replace(/^```(?:json)?/i, "").replace(/```\s*$/, "").trim();
  const start = raw.indexOf("{");
  const end = raw.lastIndexOf("}");
  if (start < 0 || end <= start) return null;
  try {
    const object = JSON.parse(raw.slice(start, end + 1));
    const actionRaw = String(object?.action || object?.mode || "").toLowerCase();
    const reply = typeof object?.reply === "string" ? object.reply.trim() : "";
    const prompt = typeof object?.prompt === "string" ? object.prompt.trim() : "";
    const reason = typeof object?.reason === "string" ? object.reason.trim().slice(0, 400) : "";
    // 用户在纠正/抱怨/提问：只回一句话，不出图（这是「越改越错」的根子）
    if (actionRaw === "reply") {
      if (!reply) return null;
      return { action: "reply", prompt: "", reply: reply.slice(0, 2000), mode: "generate", referenceUrl: "", reason };
    }
    if (!prompt) return null;
    const action = actionRaw === "edit" ? "edit" : "generate";
    return {
      action,
      prompt: prompt.slice(0, 4000),
      reply: "",
      mode: action,
      referenceUrl: typeof object?.referenceUrl === "string" ? object.referenceUrl.trim() : "",
      reason
    };
  } catch {
    return null;
  }
}

/** 给对话模型的系统提示：先判断「他是在出新图，还是在纠正我」，再落成提示词。 */
const PLAN_SYSTEM_PROMPT = [
  "你是「API 对话生图工作台」的对话上下文管理模型。你只做两件事：判断用户这句话的意图，以及把出图意图落成提示词。",
  "",
  "第一步，先分类 action：",
  '- "reply"：用户在聊天、打招呼、提问或讨论（例如「你是谁」「你好」「这个风格怎么样」「为什么多了一个人」），',
  '  或是在纠正你、抱怨结果不对（例如「乱搞，S3 就是我发的参考图机器人」「这不对」），并且**没有明确要求再出一张图**。',
  '  这时用 reply 写一句简短中文直接回答（聊天就正常回答；纠正就承认并复述正确理解）；prompt 留空。',
  '- "generate"：用户明确要一张新图（「画一只…」「生成一张…」「来一张…」）。',
  '- "edit"：用户明确要在最近一张结果图上改（「再柔和点」「把背景换成仓库」）。',
  "聊天优先：只要用户不是明确在要图/改图（寒暄、问你是谁、问功能、讨论风格、吐槽），一律 action=reply，不要凭空写提示词。",
  "纠正优先：用户指出错误时先 action=reply；只有他明确说「重新生成 / 按这个再出一张」才转成 generate/edit。",
  "",
  "第二步，写提示词（只在 generate/edit 时写）：",
  "- 中文；完整、可直接交给图片模型；保留用户明确说过的风格/构图/光线/禁忌；不要解释过程。",
  "- 「S3 / 它 / 这台 / 上面那个」这类指代，默认指用户发过的参考图里的那个主体；参考图里是什么就保持是什么，",
  "  **绝不能凭空新增用户没提过的主体**（把扫地机器人「升级」成扫地机器人 + 人形机器人是错的）。",
  '- edit 时 referenceUrl 可以留空 —— 客户端会取本会话最近一张结果图；若用户明确要基于他发的参考图，就填那个参考图的 URL。',
  "",
  "只输出一个 JSON 对象，不要代码块、不要多余文字：",
  '{"action":"generate|edit|reply","prompt":"完整提示词（reply 时为空串）","reply":"回复用户的一句话（仅 reply 时）","referenceUrl":"/api/velapi-image-go/asset/xxx.png 或空","reason":"一句话说明你怎么理解"}'
].join("\n");

/** 最近几轮压成文本：用户原话 / 实际提示词 / 结果图，够模型判断「这个」「上一张」指什么。 */
function planHistoryText(history, turns) {
  const rows = history.slice(-Math.max(1, turns));
  if (rows.length === 0) return "";
  return rows
    .map((row, index) => {
      const user = String(row?.user ?? "").trim().slice(0, 500);
      const prompt = String(row?.prompt ?? "").trim().slice(0, 500);
      const images = (Array.isArray(row?.images) ? row.images : [])
        .map((url) => String(url || ""))
        .filter((url) => /^\/api\/velapi-image-go\/(upload|asset)\/[A-Za-z0-9._-]+$/.test(url))
        .slice(0, 2);
      return `第${index + 1}轮｜用户说：${user || "(空)"}｜实际提示词：${prompt || "(空)"}${images.length ? `｜结果图：${images.join(" ")}` : ""}`;
    })
    .join("\n");
}

/* ------------------------------------------------------------------ *
 * 插件主体
 * ------------------------------------------------------------------ */

export function apply(ctx, rawConfig = {}) {
  const config = { ...DEFAULTS, ...(rawConfig && typeof rawConfig === "object" ? rawConfig : {}) };
  const logger = ctx.logger ?? console;

  /**
   * 素材目录：默认就在本地（`$DSH_HOME/state/velapi-image-go`），界面上可以改成别的盘 / 目录。
   * 目录指针写在**默认目录**的 `location.json` 里：config.json 会跟着素材一起搬走，
   * 拿它当指针的话，换了目录重启会先回默认目录读旧配置，改动就丢了。
   */
  const fallbackStateDir = resolveStateDir({});
  const explicitStateDir = config.stateDir ? path.resolve(expandHome(String(config.stateDir))) : "";
  let stateDir = explicitStateDir || readStateRoot(fallbackStateDir) || fallbackStateDir;
  /** 目录 → 全部落点。换目录时整套换掉，别留半新半旧的路径。 */
  function stateLayout(dir) {
    return {
      filesDir: path.join(dir, "library", "files"),
      uploadsDir: path.join(dir, "uploads"),
      indexPath: path.join(dir, "library", "index.json"),
      providersPath: path.join(dir, "providers.json"),
      notesPath: path.join(dir, "notes.json"),
      presetsPath: path.join(dir, "presets.json"),
      jobsPath: path.join(dir, "jobs.json"),
      conversationsPath: path.join(dir, "conversations.json"),
      catalogPath: path.join(dir, "catalog.json"),
      configPath: path.join(dir, "config.json"),
      clientReportPath: path.join(dir, "client-report.json")
    };
  }
  let { filesDir, uploadsDir, indexPath, providersPath, notesPath, presetsPath, jobsPath, conversationsPath, catalogPath, configPath, clientReportPath } = stateLayout(stateDir);

  fs.mkdirSync(filesDir, { recursive: true });
  fs.mkdirSync(uploadsDir, { recursive: true });

  /** 运行期配置：进程内的那一份，持久化在 config.json。 */
  let runtime = {
    baseUrl: String(config.baseUrl || DEFAULTS.baseUrl),
    apiKey: String(config.apiKey || ""),
    apiKeyEnv: String(config.apiKeyEnv || DEFAULTS.apiKeyEnv),
    defaultModel: String(config.defaultModel || DEFAULTS.defaultModel),
    defaultSize: String(config.defaultSize || DEFAULTS.defaultSize),
    videoSize: /^\d{2,5}x\d{2,5}$/.test(String(config.videoSize || "")) ? String(config.videoSize) : DEFAULTS.videoSize,
    videoRatio: VIDEO_RATIOS.includes(String(config.videoRatio || "")) ? String(config.videoRatio) : DEFAULTS.videoRatio,
    videoResolution: VIDEO_RESOLUTIONS.includes(String(config.videoResolution || "")) ? String(config.videoResolution) : DEFAULTS.videoResolution,
    videoSeconds: VIDEO_SECONDS.includes(String(config.videoSeconds || "")) ? String(config.videoSeconds) : DEFAULTS.videoSeconds,
    defaultQuality: oneOf(String(config.defaultQuality || "").toUpperCase(), ["LOW", "MEDIUM", "HIGH"], DEFAULTS.defaultQuality),
    defaultCount: clampInt(config.defaultCount, 1, MAX_N, DEFAULTS.defaultCount),
    // 端点协议：认不出的值回落成自动检测（界面上那一行选的、或老配置文件里没有这个字段）
    defaultEndpoint: normalizeProtocolId(config.defaultEndpoint ?? DEFAULTS.defaultEndpoint),
    chatModel: String(config.chatModel || ""),
    contextTurns: clampInt(config.contextTurns, 0, 12, DEFAULTS.contextTurns),
    concurrency: clampInt(config.concurrency, 1, 20, DEFAULTS.concurrency),
    timeoutMs: clampInt(config.timeoutMs, 5000, 900000, DEFAULTS.timeoutMs),
    activeProviderId: String(rawConfig.activeProviderId || ""),
    shortcuts: typeof rawConfig.shortcuts === "string" ? rawConfig.shortcuts.slice(0, 4096) : "",
    // 素材目录（有效绝对路径）跟着 config.json 存一份，界面直接显示它
    stateDir
  };

  /** 供应商 / 图库 / 信息 / 预设 / 任务 / 对话：内存表，落盘时机各自不同。 */
  let providers = [];
  let library = [];
  let notes = [];
  let presets = [];
  let jobs = [];
  let conversations = [];
  let catalog = {};

  /** 从当前 stateDir 读回全部内存表（启动一次；换素材目录后再来一次）。 */
  async function loadState({ boot = false } = {}) {
    const storedConfig = await readJson(configPath, null);
    if (storedConfig && typeof storedConfig === "object") {
      runtime = { ...runtime, ...storedConfig, apiKeyEnv: runtime.apiKeyEnv, stateDir };
    }
    const storedProviders = await readJson(providersPath, null);
    providers = Array.isArray(storedProviders) ? storedProviders : [];
    if (providers.length === 0 && boot) {
      // 首次启动种一条「当前生效配置」的供应商，界面不至于空着。
      providers = [
        {
          id: "default",
          name: "velapi · 默认",
          baseUrl: runtime.baseUrl,
          apiKey: "",
          useRuntimeKey: true,
          models: runtime.defaultModel ? [runtime.defaultModel] : [],
          enabled: true,
          note: "由 cordis.patch.yml 的 baseUrl / apiKeyEnv 驱动",
          createdAt: new Date().toISOString()
        }
      ];
      await writeJsonAtomic(providersPath, providers);
    }
    const storedLibrary = await readJson(indexPath, null);
    library = Array.isArray(storedLibrary) ? storedLibrary : [];
    notes = (await readJson(notesPath, [])) || [];
    const storedPresets = await readJson(presetsPath, null);
    // 首次启动种一批趣味预设卡；之后以 stateDir/presets.json 为准（用户能改能删）。
    presets = Array.isArray(storedPresets) ? storedPresets : seedPresets();
    if (!Array.isArray(storedPresets)) await writeJsonAtomic(presetsPath, presets);
    const storedJobs = await readJson(jobsPath, []);
    jobs = Array.isArray(storedJobs) ? storedJobs.slice(-MAX_JOBS) : [];
    /* 对话（会话）：老数据没有 conversations.json 就种一个默认对话，
       并把没有 conversationId 的老任务都归到它下面（迁移一次就落盘）。 */
    const storedConversations = await readJson(conversationsPath, null);
    conversations = Array.isArray(storedConversations) ? storedConversations : [];
    let conversationsDirty = !Array.isArray(storedConversations);
    if (conversations.length === 0) {
      conversations = [{ id: DEFAULT_CONVERSATION_ID, title: "默认对话", createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() }];
      conversationsDirty = true;
    }
    const conversationIds = new Set(conversations.map((item) => item.id));
    let jobsMigrated = false;
    for (const job of jobs) {
      if (!job.conversationId || !conversationIds.has(job.conversationId)) {
        job.conversationId = DEFAULT_CONVERSATION_ID;
        jobsMigrated = true;
      }
    }
    if (conversationsDirty) await writeJsonAtomic(conversationsPath, conversations);
    catalog = (await readJson(catalogPath, {})) || {};
    if (boot) {
      // 上次进程留下的 running 任务已经没有执行者了，标记成中断而不是永远转圈。
      let dirty = jobsMigrated;
      for (const job of jobs) {
        if (job.status === "running" || job.status === "queued") {
          job.status = "interrupted";
          job.finishedAt = new Date().toISOString();
          job.error = "宿主重启，任务已中断";
          dirty = true;
        }
      }
      if (dirty) await writeJsonAtomic(jobsPath, jobs);
    }
  }

  const ready = (async () => {
    await loadState({ boot: true });
    // 工具注册：失败不影响 HTTP 面，原因写进 /status
    await registerGenerationTool();
  })();

  const persistConfig = () => writeJsonAtomic(configPath, runtime);
  const persistProviders = () => writeJsonAtomic(providersPath, providers);
  const persistLibrary = () => writeJsonAtomic(indexPath, library);
  const persistNotes = () => writeJsonAtomic(notesPath, notes);
  const persistPresets = () => writeJsonAtomic(presetsPath, presets);
  const persistJobs = () => writeJsonAtomic(jobsPath, jobs.slice(-MAX_JOBS));
  const persistConversations = () => writeJsonAtomic(conversationsPath, conversations);
  const persistCatalog = () => writeJsonAtomic(catalogPath, catalog);

  /** 复制一个文件；目标已存在就跳过（不覆盖用户新目录里的东西），源不存在也跳过。 */
  async function copyIfMissing(from, to) {
    try {
      await fsp.mkdir(path.dirname(to), { recursive: true });
      await fsp.copyFile(from, to, fs.constants.COPYFILE_EXCL);
      return 1;
    } catch (error) {
      if (error?.code === "EEXIST" || error?.code === "ENOENT") return 0;
      throw error;
    }
  }

  /**
   * 换素材目录：校验可写 → 把现有素材**复制**过去（旧目录原样保留）→ 换整套路径 → 重新加载。
   * 只在没有在飞任务时允许，避免任务还在写旧目录、界面却已经指向新目录。
   */
  async function switchStateDir(rawNext) {
    const requested = String(rawNext ?? "").trim();
    const next = path.resolve(expandHome(requested));
    if (!requested) throw new Error("素材目录不能为空");
    if (next === stateDir) return { changed: false, copied: { files: 0, indexes: 0 }, stateDir };
    if (queue.length > 0 || inflight > 0) throw new Error("还有任务在跑，等它们结束再换目录");
    const layout = stateLayout(next);
    await fsp.mkdir(layout.filesDir, { recursive: true });
    await fsp.mkdir(layout.uploadsDir, { recursive: true });
    // 真写一下：只读目录 / 不存在的盘符要在这里就拦住，不能等生成完才发现存不进去
    const probe = path.join(next, `.write-test-${process.pid}.tmp`);
    await fsp.writeFile(probe, "ok");
    await fsp.rm(probe, { force: true });
    const copied = { files: 0, indexes: 0 };
    for (const [from, to] of [
      [filesDir, layout.filesDir],
      [uploadsDir, layout.uploadsDir]
    ]) {
      for (const name of await fsp.readdir(from).catch(() => [])) {
        const source = path.join(from, name);
        const stat = fs.statSync(source, { throwIfNoEntry: false });
        if (!stat?.isFile()) continue;
        copied.files += await copyIfMissing(source, path.join(to, name));
      }
    }
    for (const [from, to] of [
      [indexPath, layout.indexPath],
      [providersPath, layout.providersPath],
      [jobsPath, layout.jobsPath],
      [notesPath, layout.notesPath],
      [presetsPath, layout.presetsPath],
      [conversationsPath, layout.conversationsPath],
      [catalogPath, layout.catalogPath],
      [clientReportPath, layout.clientReportPath]
    ]) {
      if (fs.existsSync(from)) copied.indexes += await copyIfMissing(from, to);
    }
    // 换路径 → 配置写进新目录 → 指针文件写进默认目录 → 重新加载内存表
    stateDir = next;
    ({ filesDir, uploadsDir, indexPath, providersPath, notesPath, presetsPath, jobsPath, catalogPath, configPath, clientReportPath } = layout);
    runtime = { ...runtime, stateDir };
    await persistConfig();
    await writeStateRoot(fallbackStateDir, next);
    await loadState({ boot: false });
    return { changed: true, copied, stateDir };
  }

  /** 在系统文件管理器里打开素材目录（宿主跑在 Electron 主进程，能直接开）。 */
  function revealStateDir(rawDir) {
    const target = path.resolve(expandHome(String(rawDir || stateDir)));
    if (!fs.existsSync(target)) throw new Error(`目录不存在：${target}`);
    const command = process.platform === "win32" ? "explorer.exe" : process.platform === "darwin" ? "open" : "xdg-open";
    const child = spawn(command, [target], { detached: true, stdio: "ignore" });
    child.unref();
    return target;
  }

  /** 「保存到本地」落在哪个目录：配置的 saveDir > 系统下载目录/velapi-image-go。 */
  function resolveSaveDir() {
    const raw = String(runtime.saveDir || "").trim();
    if (raw) return path.resolve(expandHome(raw));
    return path.join(os.homedir(), "Downloads", "velapi-image-go");
  }

  /** 把图库里的原图复制一份到保存目录；同名不覆盖，加 -1/-2 后缀。 */
  async function exportAssets(names) {
    const dir = resolveSaveDir();
    await fsp.mkdir(dir, { recursive: true });
    const items = [];
    for (const raw of names) {
      const name = path.basename(String(raw || ""));
      if (!/^[A-Za-z0-9._-]+$/.test(name)) continue;
      const from = path.join(filesDir, name);
      if (!fs.existsSync(from)) continue;
      const parsed = path.parse(name);
      let target = path.join(dir, name);
      for (let index = 1; fs.existsSync(target) && index < 1000; index += 1) {
        target = path.join(dir, `${parsed.name}-${index}${parsed.ext}`);
      }
      await fsp.copyFile(from, target);
      items.push({ name, path: target });
    }
    return { dir, items };
  }

  /** Electron 主进程能力（原生拖拽 / 系统剪贴板）；不是 Electron 宿主时返回 null。 */
  async function loadElectron() {
    try {
      const module = await import("electron");
      return module?.default ?? module ?? null;
    } catch {
      return null;
    }
  }

  /** 校验并返回图库里的一个文件；名字必须是白名单 + 真实存在。 */
  function galleryFile(rawName) {
    const name = path.basename(String(rawName || ""));
    if (!/^[A-Za-z0-9._-]+$/.test(name)) return null;
    const target = path.join(filesDir, name);
    return fs.existsSync(target) ? { name, target } : null;
  }

  /** 宿主能力探测（懒计算一次）：前端靠它决定复制图片 / 拖拽走哪条路。 */
  let capabilityCache = null;
  async function hostCapabilities() {
    if (capabilityCache) return capabilityCache;
    const electron = await loadElectron();
    const hasImage = typeof electron?.nativeImage?.createFromPath === "function";
    const electronClipboard = Boolean(electron?.clipboard?.writeImage && hasImage);
    // DSH 的插件宿主未必拿得到 Electron 的 clipboard（实测 electron 模块在、API 不在）；
    // Windows 上还有一条永远可用的路：PowerShell 的 System.Windows.Forms.Clipboard。
    const powershellClipboard = process.platform === "win32" && process.env.VIG_NO_CLIPBOARD !== "1";
    capabilityCache = {
      electron: Boolean(electron),
      nativeDrag: Boolean(electron?.BrowserWindow && hasImage),
      clipboard: electronClipboard || powershellClipboard,
      clipboardVia: electronClipboard ? "electron" : powershellClipboard ? "powershell" : ""
    };
    return capabilityCache;
  }

  /**
   * 把图库原图写进系统剪贴板（真图片，不是路径文本）。
   * 优先 Electron clipboard.writeImage；拿不到就用 Windows PowerShell 的 Clipboard.SetImage。
   */
  async function writeClipboardImage(filePath) {
    const electron = await loadElectron();
    if (electron?.clipboard?.writeImage && typeof electron.nativeImage?.createFromPath === "function") {
      try {
        electron.clipboard.writeImage(electron.nativeImage.createFromPath(filePath));
        return "electron";
      } catch {
        /* 退化到 PowerShell */
      }
    }
    if (process.env.VIG_NO_CLIPBOARD === "1" || process.platform !== "win32") return "";
    const escaped = String(filePath).replace(/'/g, "''");
    const script = [
      "Add-Type -AssemblyName System.Windows.Forms",
      "Add-Type -AssemblyName System.Drawing",
      `$img = [System.Drawing.Image]::FromFile('${escaped}')`,
      "[System.Windows.Forms.Clipboard]::SetImage($img)",
      "$img.Dispose()"
    ].join("\r\n");
    const scriptPath = path.join(os.tmpdir(), `vig-clip-${process.pid}-${Date.now()}.ps1`);
    await fsp.writeFile(scriptPath, script, "utf8");
    try {
      await new Promise((resolve, reject) => {
        execFile(
          "powershell.exe",
          ["-NoProfile", "-STA", "-ExecutionPolicy", "Bypass", "-File", scriptPath],
          { timeout: 20000, windowsHide: true },
          (error) => (error ? reject(error) : resolve())
        );
      });
      return "powershell";
    } finally {
      await fsp.rm(scriptPath, { force: true }).catch(() => {});
    }
  }

  /** 生效密钥：运行期密钥优先，其次环境变量；两者都没有就是未配置。 */
  function activeKey() {
    if (runtime.apiKey) return runtime.apiKey;
    const envName = runtime.apiKeyEnv || "VELAPI_API_KEY";
    const fromEnv = process.env[envName];
    return typeof fromEnv === "string" ? fromEnv.trim() : "";
  }

  function providerById(id) {
    if (!id) return null;
    return providers.find((item) => item.id === id) ?? null;
  }

  /**
   * 这个模型该由哪条供应商链去跑。以前只看「请求里指定了谁 / 谁是当前供应商」，
   * 于是「选了 GPT 的模型但没点设为当前」会被送到列表里第一个供应商（踩过：
   * gpt-image-2.5-c 被打到 grok 那条链，503 No available channel）。
   * 规则：
   *   1) 指定/当前供应商的模型目录里就有它（或它还没拉过目录）→ 就是它；
   *   2) 否则找模型目录里**有它**的供应商 —— 模型属于谁就打到谁那儿；
   *   3) 都没有才回落到指定/当前/第一个启用的供应商。
   */
  function providerForModel(model, providerId) {
    const wanted = trimText(model, 120);
    const preferred = providerById(providerId) ?? providerById(runtime.activeProviderId);
    const modelsOf = (provider) => (Array.isArray(provider?.models) ? provider.models : []);
    const owns = (provider) => wanted !== "" && modelsOf(provider).includes(wanted);
    const hasCatalog = (provider) => modelsOf(provider).length > 0;
    if (preferred && preferred.enabled !== false && (wanted === "" || !hasCatalog(preferred) || owns(preferred))) return preferred;
    if (wanted !== "") {
      const owner = providers.find((item) => item.enabled !== false && owns(item)) ?? providers.find((item) => owns(item));
      if (owner) return owner;
    }
    return preferred ?? providers.find((item) => item.enabled !== false) ?? null;
  }

  /** 一次生成用哪套凭据：模型属于谁就用谁，供应商自带密钥优先，否则回落到运行期配置。 */
  function resolveTarget(providerId, model = "") {
    const provider = providerForModel(model, providerId);
    const baseUrl = String(provider?.baseUrl || runtime.baseUrl).replace(/\/+$/, "");
    const apiKey = provider?.apiKey ? String(provider.apiKey) : activeKey();
    return { provider, baseUrl, apiKey };
  }

  /* ---- 对话模型（上下文管理用）：从供应商目录里挑 chat 模型 ---- */

  const CHAT_MODEL_RE = /(gpt-4|gpt-5|gpt-6|claude|gemini|deepseek|glm|qwen|grok-3|grok-4|llama|mistral|kimi|chat)/i;
  const NON_CHAT_MODEL_RE =
    /(image|dall|banana|imagen|flux|seedream|kolors|ideogram|midjourney|stable-diffusion|sd[-_]?xl|tts|whisper|audio|video|veo|sora|kling|wan|hunyuan|minimax-video)/i;

  /** 所有供应商目录里能用 chat/completions 的模型（kind 优先，其次按名字猜）。 */
  function chatModelCandidates() {
    const out = [];
    const seen = new Set();
    for (const provider of providers) {
      if (provider.enabled === false) continue;
      for (const model of provider.models || []) {
        if (!model || seen.has(model)) continue;
        const meta = provider.modelMeta?.[model] ?? {};
        const kind = String(meta.kind || "").toLowerCase();
        const isChat = kind ? kind === "chat" : CHAT_MODEL_RE.test(model) && !NON_CHAT_MODEL_RE.test(model);
        if (!isChat) continue;
        seen.add(model);
        out.push({
          id: model,
          providerId: provider.id,
          providerName: provider.name || provider.id,
          label: meta.label || model
        });
      }
    }
    return out;
  }

  /** 用哪个对话模型：请求指定 > 配置指定 > 目录里第一个；都没有就 null。 */
  function pickChatModel(requested) {
    const wanted = trimText(requested, 120) || runtime.chatModel;
    const list = chatModelCandidates();
    if (wanted) return list.find((item) => item.id === wanted) ?? { id: wanted, providerId: "", providerName: "", label: wanted };
    return list[0] ?? null;
  }

  /** 聊天一句话的候选顺序：指定了就用指定；否则按目录顺序试前 3 个（上游偶尔某个模型没渠道）。 */
  function chatSayCandidates(requested) {
    const wanted = trimText(requested, 120);
    const list = chatModelCandidates();
    if (wanted) {
      const hit = list.find((item) => item.id === wanted);
      return hit ? [hit] : [{ id: wanted, providerId: "", providerName: "", label: wanted }];
    }
    return list.slice(0, 3);
  }

  /**
   * 「key 填得没错，但接口地址不是这家」的现场解释：
   * 上游 401/403 时，拿这把 key 去问**本地已经配置过的**其它 baseUrl（不碰没配过的站），
   * 谁认它就把它说出来 —— 否则用户只能看到一句 invalid access key 干瞪眼。
   * 只读、最多问几家常量级、每个 20s 封顶；任何异常都吞掉，解释不了就算了。
   */
  async function explainKeyMismatch({ baseUrl, apiKey, error, timeoutMs }) {
    const status = Number(error?.status ?? 0);
    if (status !== 401 && status !== 403) return "";
    const failing = String(baseUrl || "").replace(/\/+$/, "");
    const candidates = [...new Set([runtime.baseUrl, ...providers.map((item) => item.baseUrl)].map((url) => String(url || "").replace(/\/+$/, "")).filter(Boolean))].filter(
      (url) => url !== failing
    );
    for (const candidate of candidates) {
      try {
        const models = await fetchModels({ baseUrl: candidate, apiKey, timeoutMs: Math.min(Number(timeoutMs) || 20000, 20000) });
        if (models.length > 0) {
          return `密钥和接口地址不是一家的：这把 key 在 ${candidate} 上可用（${models.length} 个模型），在 ${failing} 上被拒（HTTP ${status} ${String(error?.message ?? "").slice(0, 80)}）。改供应商的接口地址，或换这家站的 key。`;
        }
      } catch {
        /* 这家也不认，换下一家 */
      }
    }
    return "";
  }

  /* ---------------- 图库落盘 ---------------- */

  async function saveAsset({ buffer, mime, ext, meta }) {
    const sniffed = sniffImage(buffer);
    const suffix = ext || MIME_EXT[mime] || sniffed.format || "png";
    const id = newId("img");
    const fileName = `${id}.${suffix}`;
    await fsp.writeFile(path.join(filesDir, fileName), buffer);
    const asset = {
      id,
      name: meta?.name || `${(meta?.prompt || "image").slice(0, 24)}.${suffix}`,
      file: fileName,
      url: `${ROUTE_PREFIX}/asset/${fileName}`,
      bytes: buffer.length,
      sha256: crypto.createHash("sha256").update(buffer).digest("hex"),
      format: sniffed.format,
      mime: sniffed.mime,
      width: sniffed.width,
      height: sniffed.height,
      remoteUrl: meta?.remoteUrl || "",
      model: meta?.model || "",
      providerId: meta?.providerId || "",
      prompt: meta?.prompt || "",
      size: meta?.size || "",
      quality: meta?.quality || "",
      jobId: meta?.jobId || "",
      // 过程留痕：这张素材是谁要的（界面 / 工具 / 外部 API）、属于哪个会话。
      source: meta?.source || "",
      sessionId: meta?.sessionId || "",
      createdAt: new Date().toISOString()
    };
    library.unshift(asset);
    if (library.length > 800) library = library.slice(0, 800);
    await persistLibrary();
    return asset;
  }

  /* ---------------- 任务队列 ---------------- */

  const queue = [];
  let inflight = 0;
  const controllers = new Map();

  function schedule() {
    while (inflight < runtime.concurrency && queue.length > 0) {
      const job = queue.shift();
      inflight += 1;
      runJob(job)
        .catch((error) => {
          logger?.warn?.(`velapi-image-go: job ${job.id} crashed: ${String(error?.message ?? error)}`);
        })
        .finally(() => {
          inflight -= 1;
          controllers.delete(job.id);
          schedule();
        });
    }
  }

  function enqueue(job) {
    jobs.unshift(job);
    if (jobs.length > MAX_JOBS) jobs = jobs.slice(0, MAX_JOBS);
    queue.push(job);
    // 入队时先落一次盘：这里不能 await（入队要立刻返回 task id），
    // 但也绝不能让它变成未处理的 rejection —— 落盘抖一下不该把宿主带崩（踩过：Windows rename 被占）。
    void persistJobs().catch((error) => {
      logger?.warn?.(`velapi-image-go: 入队落盘失败：${String(error?.message ?? error)}`);
    });
    schedule();
    return job;
  }

  async function runJob(job) {
    const controller = new AbortController();
    controllers.set(job.id, controller);
    job.status = "running";
    job.startedAt = new Date().toISOString();
    await persistJobs();
    const { provider, baseUrl, apiKey } = resolveTarget(job.providerId, job.model);
    if (!apiKey) {
      job.status = "failed";
      job.error = `未配置密钥：在「供应商管理」里填 API Key，或设置环境变量 ${runtime.apiKeyEnv || "VELAPI_API_KEY"}`;
      job.errorCode = "missing_api_key";
      job.finishedAt = new Date().toISOString();
      await persistJobs();
      return;
    }
    const startedAt = Date.now();
    try {
      /* 走哪条路由由这次任务的协议说了算（入队时定下来的，见 /generate）；协议是「自动检测」时
         按老规矩：带参考图就是编辑、不然就是生成。这样换了别的中转站也不用改代码。 */
      const protocol = protocolById(job.protocol || provider?.endpoint);
      const isVideo = protocol.id === "videos_generations";
      // 编辑路由要有参考图才有意义：只选了「图片编辑」但没带参考图时回落到生成，
      // 别把一条注定 400（image file or image_url is required）的请求发出去。
      const wantsEdits = protocol.id === "images_edits" || (protocol.id === "auto" && job.mode === "edit");
      const requestImages = (Array.isArray(job.requestImages) && job.requestImages.length > 0 ? job.requestImages : job.requestImage ? [job.requestImage] : []).slice(0, 4);
      const useEdits = wantsEdits && requestImages.length > 0;
      const route = isVideo ? protocol.route : useEdits ? "/images/edits" : "/images/generations";
      job.protocol = useEdits ? "images_edits" : wantsEdits ? "images_generations" : protocol.id;
      job.endpoint = route;
      /* /images/edits 是 OpenAI 那套「文件上传」接口：只能 multipart/form-data。
         以前跟生成一样塞 JSON + base64，GPT 系模型直接回 400
         `image file or image_url is required`（踩过，用户截图就是这条）。 */
      const body = isVideo
        ? cleanBody({
            model: job.model,
            prompt: job.prompt,
            n: job.count,
            size: job.size,
            // 时长：视频协议才带（OpenAI 视频接口用 seconds 字符串）
            ...(job.seconds ? { seconds: job.seconds } : {}),
            /* 比例 / 分辨率同时按原生字段带一份（Kling / Seedance / Veo 系上游认 aspect_ratio +
               resolution；OpenAI 风格上游用上面的 size 像素，多余字段一般忽略）。 */
            ...(runtime.videoRatio ? { aspect_ratio: runtime.videoRatio } : {}),
            ...(runtime.videoResolution ? { resolution: runtime.videoResolution } : {}),
            ...(job.requestImage ? { image: job.requestImage } : {})
          })
        : useEdits
          ? null
          : buildGenerationBody(job, job.model, job.size, job.quality, job.count);
      let form = null;
      if (useEdits) {
        const decodedList = requestImages.map((item) => decodeBase64Image(item)).filter(Boolean);
        if (decodedList.length === 0) {
          const error = new Error("图生图缺少可用的参考图字节");
          error.code = "missing_reference";
          throw error;
        }
        form = new FormData();
        form.append("model", job.model);
        form.append("prompt", job.prompt);
        /* 多参考图：每张一个 image 字段（上游按「第 N 张参考图」校验，repeated image 兼容面最广） */
        decodedList.forEach((reference, index) => {
          form.append("image", new Blob([reference.buffer], { type: reference.mime }), `reference_${index + 1}.${MIME_EXT[reference.mime] || "png"}`);
        });
        if (job.requestMask) {
          const mask = decodeBase64Image(job.requestMask);
          if (mask) form.append("mask", new Blob([mask.buffer], { type: mask.mime }), `mask.${MIME_EXT[mask.mime] || "png"}`);
        }
        form.append("n", String(job.count));
        form.append("size", job.size);
      }
      const { payload, elapsedMs } = await callUpstream({
        baseUrl,
        apiKey,
        route,
        body,
        form,
        timeoutMs: runtime.timeoutMs,
        signal: controller.signal
      });
      if (isVideo) {
        // 视频这条链上游返回的是任务体（id / status / url 不定），原样收下来展示，
        // 不假装已经出片：界面按 payload 里能认出来的字段给，认不出来就摆原始响应。
        job.status = "succeeded";
        job.finishedAt = new Date().toISOString();
        job.elapsedMs = Date.now() - startedAt;
        job.upstreamMs = elapsedMs;
        job.images = [];
        job.video = {
          model: job.model,
          prompt: job.prompt,
          url: findFirstUrl(payload) ?? "",
          payload: JSON.parse(JSON.stringify(payload ?? null))
        };
        job.usage = payload?.usage ?? null;
        return;
      }
      const items = Array.isArray(payload?.data) ? payload.data : [];
      if (items.length === 0) {
        const error = new Error("上游没有返回任何图片");
        error.code = "upstream_empty";
        error.detail = {
          kind: "upstream_empty",
          method: "POST",
          url: `${baseUrl.replace(/\/+$/, "")}${route}`,
          model: job.model,
          body: JSON.stringify(payload ?? null, null, 2).slice(0, MAX_ERROR_BODY)
        };
        throw error;
      }
      const produced = [];
      for (const item of items) {
        const picked = pickImagePayload({ data: [item] });
        if (!picked) continue;
        let buffer;
        let mime = "image/png";
        if (picked.kind === "b64") {
          buffer = picked.buffer;
          mime = picked.mime;
        } else {
          buffer = await downloadImage(picked.url, runtime.timeoutMs);
          const sniffed = sniffImage(buffer);
          mime = sniffed.mime;
        }
        const asset = await saveAsset({
          buffer,
          mime,
          meta: {
            name: `${job.prompt.slice(0, 24)}.${MIME_EXT[mime] || "png"}`,
            remoteUrl: picked.kind === "url" ? picked.url : "",
            model: job.model,
            providerId: provider?.id ?? "",
            prompt: job.prompt,
            size: job.size,
            quality: job.quality,
            jobId: job.id,
            source: job.source || "",
            sessionId: job.sessionId || ""
          }
        });
        produced.push({
          assetId: asset.id,
          name: asset.name,
          url: asset.url,
          bytes: asset.bytes,
          width: asset.width,
          height: asset.height,
          format: asset.format,
          remoteUrl: asset.remoteUrl
        });
      }
      if (produced.length === 0) {
        const error = new Error("上游返回的字段里没有可用的 url / b64_json");
        error.code = "upstream_no_image_field";
        error.detail = {
          kind: "upstream_no_image_field",
          method: "POST",
          url: `${baseUrl.replace(/\/+$/, "")}${route}`,
          model: job.model,
          body: JSON.stringify(payload ?? null, null, 2).slice(0, MAX_ERROR_BODY)
        };
        throw error;
      }
      job.status = "succeeded";
      job.images = produced;
      job.elapsedMs = Date.now() - startedAt;
      job.upstreamMs = elapsedMs;
      job.finishedAt = new Date().toISOString();
      job.usage = payload?.usage ?? null;
      job.revisedPrompt = payload?.data?.[0]?.revised_prompt ?? "";
    } catch (error) {
      if (controller.signal.aborted) {
        job.status = "canceled";
        job.error = "已取消";
      } else {
        job.status = "failed";
        job.error = String(error?.message ?? error);
        job.errorCode = error?.code ?? "generation_failed";
        // 原始证据一起落盘：界面上直接摆出来，不用再去翻日志。
        job.errorDetail = error?.detail ?? null;
        // 401/403 多半是「key 是 A 家的、地址填的是 B 家」：给一句人话，别让人对着
        // invalid access key 猜。解释不出来就不写。
        const hint = await explainKeyMismatch({ baseUrl, apiKey, error, timeoutMs: runtime.timeoutMs });
        if (hint) {
          job.errorDetail = { ...(job.errorDetail ?? { kind: "upstream" }), hint };
        }
      }
      job.finishedAt = new Date().toISOString();
      job.elapsedMs = Date.now() - startedAt;
    } finally {
      // 参考图只活在这一次请求里，别把 base64 留在历史记录中。
      delete job.requestImage;
      delete job.requestImages;
      delete job.requestMask;
      await persistJobs();
    }
  }

  /* ---------------- HTTP ---------------- */

  function sendJson(response, status, body) {
    const payload = JSON.stringify(body);
    response.writeHead(status, {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store",
      "content-length": Buffer.byteLength(payload)
    });
    response.end(payload);
  }

  function fail(response, status, error, code) {
    sendJson(response, status, {
      ok: false,
      error: String(error?.message ?? error),
      code: code ?? error?.code ?? "error",
      // 有原始证据就一起给（界面直接摆出来，不用让用户去看日志）。
      ...(error?.detail ? { detail: error.detail } : {})
    });
  }

  async function readBody(request) {
    const chunks = [];
    let total = 0;
    for await (const chunk of request) {
      total += chunk.length;
      if (total > MAX_BODY_BYTES) throw new Error("请求体过大");
      chunks.push(chunk);
    }
    if (total === 0) return {};
    const text = Buffer.concat(chunks).toString("utf8");
    try {
      return JSON.parse(text);
    } catch {
      throw new Error("请求体不是合法 JSON");
    }
  }

  function publicConfig() {
    return {
      baseUrl: runtime.baseUrl,
      apiKeyEnv: runtime.apiKeyEnv,
      keyMask: maskKey(activeKey()),
      hasKey: activeKey().length > 0,
      defaultModel: runtime.defaultModel,
      defaultSize: runtime.defaultSize,
      videoSize: runtime.videoSize,
      videoRatio: runtime.videoRatio,
      videoResolution: runtime.videoResolution,
      videoSeconds: runtime.videoSeconds,
      defaultQuality: runtime.defaultQuality,
      defaultCount: runtime.defaultCount,
      // 端点协议：输入框那一行的选择，生成时按它决定打哪条路由。
      defaultEndpoint: protocolById(runtime.defaultEndpoint).id,
      concurrency: runtime.concurrency,
      timeoutMs: runtime.timeoutMs,
      activeProviderId: runtime.activeProviderId,
      // 对话上下文管理模型：用哪个对话模型接消息、喂它最近几轮
      chatModel: runtime.chatModel,
      contextTurns: runtime.contextTurns,
      shortcuts: typeof runtime.shortcuts === "string" ? runtime.shortcuts : "",
      // 素材目录：默认就在本地，界面上能看能改（改的时候现有素材会复制过去）
      stateDir,
      // 「保存到本地」的目录（默认 系统下载/velapi-image-go）
      saveDir: resolveSaveDir()
    };
  }

  /** 对话在界面上的样子：标题 + 条数 + 最后一句（列表里一眼认出是哪段对话）。 */
  function publicConversation(record) {
    const list = jobs.filter((job) => job.conversationId === record.id);
    const last = list[0];
    return {
      id: record.id,
      title: record.title || "未命名对话",
      createdAt: record.createdAt || "",
      updatedAt: record.updatedAt || record.createdAt || "",
      count: list.length,
      lastPrompt: last?.prompt ? String(last.prompt).slice(0, 40) : ""
    };
  }

  /** 目录元数据规范化：只留 kind / label / enabled / modes。
   *  kind 来自中转站的 image_family / video_family，前端按它分组，不靠名字猜。 */
  function normalizeModelMeta(input) {
    const modes = Array.isArray(input?.modes)
      ? [...new Set(input.modes.map((mode) => trimText(String(mode), 16)).filter(Boolean))].slice(0, 8)
      : [];
    return {
      kind: trimText(input?.kind, 24),
      label: trimText(input?.label, 60),
      enabled: input?.enabled !== false,
      modes
    };
  }

  function publicProvider(provider) {
    const protocol = protocolById(provider.endpoint);
    return {
      id: provider.id,
      name: provider.name,
      baseUrl: provider.baseUrl,
      enabled: provider.enabled !== false,
      keyMask: provider.apiKey ? maskKey(provider.apiKey) : provider.useRuntimeKey ? maskKey(activeKey()) : "",
      usesRuntimeKey: Boolean(provider.useRuntimeKey) || !provider.apiKey,
      models: Array.isArray(provider.models) ? provider.models : [],
      // 端点协议：生成时按它决定打 /images/generations 还是 /images/edits、/videos/generations。
      endpoint: protocol.id,
      endpointLabel: protocol.label,
      endpointRoute: protocol.route,
      // 模型目录的元数据（kind / label / enabled）跟着供应商一起给前端，
      // 前端的分组按 kind 走，不再靠名字前缀猜。
      modelMeta: provider.modelMeta && typeof provider.modelMeta === "object" ? provider.modelMeta : {},
      note: provider.note || "",
      createdAt: provider.createdAt || ""
    };
  }

  /** 图库里的一条记录在界面上的样子。 */
  function publicAsset(asset) {
    return {
      id: asset.id,
      name: asset.name,
      url: asset.url,
      bytes: asset.bytes,
      format: asset.format,
      width: asset.width,
      height: asset.height,
      model: asset.model,
      prompt: asset.prompt,
      size: asset.size,
      quality: asset.quality,
      jobId: asset.jobId,
      // 过程留痕：这张图是界面点的、对话里工具调的，还是外部程序打进来的
      source: asset.source || "",
      sessionId: asset.sessionId || "",
      sha256: asset.sha256,
      createdAt: asset.createdAt
    };
  }

  /** 命中的静态文件必须在图库 / 上传 / 内置预设目录内，且必须是规则内的文件名。 */
  function resolveStatic(name, kind) {
    const safe = path.basename(String(name || ""));
    if (!/^[A-Za-z0-9._-]+$/.test(safe)) return null;
    const root = kind === "upload" ? uploadsDir : kind === "preset" ? PRESET_ROOT : filesDir;
    const target = path.join(root, safe);
    if (!target.startsWith(root)) return null;
    return fs.existsSync(target) ? target : null;
  }

  /**
   * 工具调用的执行体：和 /generate 用同一套任务队列，等它跑到终态再回结果。
   * 返回值里带「过程」：提示词、模型、尺寸、协议、耗时、sessionId —— 素材和过程一起留痕。
   */
  async function runToolGeneration(args, exec) {
    const prompt = trimText(args?.prompt, 4000);
    if (prompt.length === 0) throw new Error("prompt 不能为空");
    const providerId = trimText(args?.providerId, 64);
    const model = trimText(args?.model, 120) || runtime.defaultModel;
    const target = resolveTarget(providerId, model);
    const size = trimText(args?.size, 32) || runtime.defaultSize;
    const quality = oneOf(String(args?.quality || runtime.defaultQuality).toUpperCase(), ["LOW", "MEDIUM", "HIGH"], runtime.defaultQuality);
    const count = clampInt(args?.n ?? runtime.defaultCount, 1, MAX_N, runtime.defaultCount);
    const protocol = resolveProtocol({ requested: args?.protocol, preferred: runtime.defaultEndpoint, fallback: target.provider?.endpoint });
    const referenceUrl = /^\/api\/velapi-image-go\/(upload|asset)\/[A-Za-z0-9._-]+$/.test(String(args?.referenceUrl ?? "")) ? String(args.referenceUrl) : "";
    const job = {
      id: newId("job"),
      status: "queued",
      mode: "generate",
      prompt,
      model,
      providerId: target.provider?.id ?? "",
      size,
      quality,
      count,
      protocol,
      referenceUrl,
      // 过程留痕：谁发起的、属于哪个会话
      source: "tool",
      sessionId: trimText(exec?.sessionId ?? exec?.agent?.sessionId ?? exec?.agent?.id ?? "", 120),
      createdAt: new Date().toISOString(),
      images: [],
      requestImage: "",
      error: "",
      errorCode: ""
    };
    enqueue(job);
    const deadline = Date.now() + Math.max(30000, runtime.timeoutMs + 15000);
    let current = job;
    while (Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, Math.min(250, Math.max(100, runtime.timeoutMs / 1200))));
      current = jobs.find((item) => item.id === job.id) ?? current;
      if (current.status !== "queued" && current.status !== "running") break;
    }
    const assets = (current.images ?? []).map((image) => ({
      assetId: image.assetId,
      url: image.url,
      width: image.width,
      height: image.height,
      bytes: image.bytes,
      remoteUrl: image.remoteUrl
    }));
    return {
      ok: current.status === "succeeded" && assets.length > 0,
      jobId: current.id,
      status: current.status,
      prompt: current.prompt,
      model: current.model,
      size: current.size,
      protocol: current.protocol || protocol,
      sessionId: current.sessionId || "",
      elapsedMs: current.elapsedMs ?? 0,
      assets,
      error: current.status === "succeeded" ? "" : String(current.error || "生成失败"),
      errorCode: current.status === "succeeded" ? "" : String(current.errorCode || "")
    };
  }

  /** 工具状态：注册成功没有、失败原因是什么（/status 里对外暴露，排障用）。 */
  let toolState = { name: "generate_image", registered: false, reason: "尚未尝试注册" };

  async function registerGenerationTool() {
    if (!ctx.tools || typeof ctx.tools.register !== "function") {
      toolState = { name: "generate_image", registered: false, reason: "宿主没有 tools 服务" };
      return;
    }
    const defineTool = await loadDefineTool();
    if (!defineTool) {
      toolState = { name: "generate_image", registered: false, reason: "解析不到 @deepseek-ai/dsh-tools 的 defineTool" };
      return;
    }
    try {
      ctx.tools.register(
        defineTool({
          name: "generate_image",
          description:
            "Generate one or more images through the configured velapi relay and store them in the workbench library. Returns asset URLs plus the prompt/model/size/protocol that produced them (the prompt is kept with the asset, so it can be traced later).",
          parameters: {
            prompt: { type: "string", description: "What to draw. Kept verbatim with the generated assets." },
            model: { type: "string", description: "Model id, defaults to the configured default model." },
            size: { type: "string", description: 'Image size such as "1024x1024", defaults to the configured size.' },
            quality: { type: "string", description: "LOW / MEDIUM / HIGH." },
            n: { type: "number", description: "How many images (1-8)." },
            providerId: { type: "string", description: "Provider id; omit to use the active provider." },
            protocol: {
              type: "string",
              description: "Endpoint protocol: auto / images_generations / images_edits / videos_generations …"
            },
            referenceUrl: {
              type: "string",
              description: "Same-site reference image URL (/api/velapi-image-go/upload/… or /asset/…), used for edits."
            }
          },
          output: {
            schema: {
              type: "object",
              additionalProperties: true,
              properties: {
                ok: { type: "boolean", required: true },
                jobId: { type: "string", required: true },
                status: { type: "string", required: true },
                prompt: { type: "string", required: true },
                model: { type: "string", required: true },
                size: { type: "string", required: true },
                assets: { type: "array", required: true }
              }
            },
            render: (_args, value) => [
              {
                type: "text",
                text: JSON.stringify(value)
              }
            ]
          },
          async execute(args, exec) {
            return runToolGeneration(args, exec);
          },
          presentCall: (args) => ({ card: "generic", title: "generate_image", rawInput: args })
        })
      );
      toolState = { name: "generate_image", registered: true, reason: "" };
    } catch (error) {
      toolState = { name: "generate_image", registered: false, reason: String(error?.message ?? error).slice(0, 200) };
    }
  }

  async function handle(request, response) {
    await ready;
    const url = new URL(request.url ?? "/", "http://127.0.0.1");
    const route = url.pathname.slice(ROUTE_PREFIX.length) || "/";
    const method = (request.method ?? "GET").toUpperCase();
    const query = url.searchParams;

    try {
      /* 状态：界面首屏一次拿全 */
      if (method === "GET" && (route === "/status" || route === "/")) {
        return sendJson(response, 200, {
          ok: true,
          version: "0.1.0",
          plugin: name,
          config: publicConfig(),
          stateDir,
          presets,
          tool: toolState,
          // 端点协议表由宿主给（界面照它渲染下拉，不各写一份）：
          // 供应商那个「端点类型」选项，生成时按它选路由。
          protocols: PROTOCOLS,
          // 对话上下文管理可用的模型（供应商目录里的 chat 模型）
          chatModels: chatModelCandidates(),
          counts: {
            providers: providers.length,
            images: library.length,
            notes: notes.length,
            presets: presets.length,
            jobs: jobs.length,
            conversations: conversations.length,
            queued: queue.length + inflight
          }
        });
      }

      /* 更新通道：检查远端仓库有没有比本地新的提交（界面「更新」入口点的就是它）。 */
      if ((method === "POST" || method === "GET") && route === "/update/check") {
        const body = method === "POST" ? await readBody(request) : {};
        const remoteUrl = trimText(body.remote || UPDATE_REPO_DEFAULT, 300) || UPDATE_REPO_DEFAULT;
        const branch = trimText(body.branch || UPDATE_BRANCH, 60) || UPDATE_BRANCH;
        const local = await runGit(["rev-parse", "HEAD"]);
        if (!local.ok) {
          return sendJson(response, 200, {
            ok: true,
            latest: null,
            available: false,
            code: "not_a_repo",
            version: PLUGIN_VERSION,
            localSha: "",
            remoteSha: "",
            hint: "插件目录不是 git 仓库（源码安装方式），更新要重新拉源码",
            error: local.stderr.slice(0, 300)
          });
        }
        const remote = await runGit(["ls-remote", remoteUrl, `refs/heads/${branch}`], { timeout: 25000 });
        if (!remote.ok) {
          return sendJson(response, 200, {
            ok: true,
            latest: null,
            available: false,
            code: "remote_unreachable",
            version: PLUGIN_VERSION,
            localSha: local.stdout,
            remoteSha: "",
            remoteUrl,
            branch,
            hint: `拿不到远端（${remoteUrl}）：网络不通或 Git 凭据缺失`,
            error: remote.stderr.slice(0, 300)
          });
        }
        const remoteSha = (remote.stdout.split(/\s+/)[0] || "").trim();
        const latest = Boolean(remoteSha) && remoteSha === local.stdout;
        return sendJson(response, 200, {
          ok: true,
          latest,
          available: !latest,
          code: latest ? "latest" : "behind",
          version: PLUGIN_VERSION,
          localSha: local.stdout,
          remoteSha,
          remoteUrl,
          branch,
          short: { local: local.stdout.slice(0, 7), remote: remoteSha.slice(0, 7) },
          hint: latest ? `已是最新（${local.stdout.slice(0, 7)}）` : `远端有更新：${remoteSha.slice(0, 7)}（更新后需重启 DSH）`
        });
      }

      /* 更新通道：拉取远端（只做 fast-forward，不覆盖本地改动）。成功了界面再调 /update/restart。 */
      if (method === "POST" && route === "/update/apply") {
        const body = await readBody(request);
        const remoteUrl = trimText(body.remote || UPDATE_REPO_DEFAULT, 300) || UPDATE_REPO_DEFAULT;
        const branch = trimText(body.branch || UPDATE_BRANCH, 60) || UPDATE_BRANCH;
        const local = await runGit(["rev-parse", "HEAD"]);
        if (!local.ok) {
          return sendJson(response, 200, {
            ok: false,
            code: "not_a_repo",
            hint: "插件目录不是 git 仓库（源码安装方式），更新要重新拉源码",
            error: local.stderr.slice(0, 300)
          });
        }
        const remote = await runGit(["ls-remote", remoteUrl, `refs/heads/${branch}`], { timeout: 25000 });
        if (!remote.ok) {
          return sendJson(response, 200, {
            ok: false,
            code: "remote_unreachable",
            hint: `拿不到远端（${remoteUrl}）：网络不通或 Git 凭据缺失`,
            error: remote.stderr.slice(0, 300)
          });
        }
        const remoteSha = (remote.stdout.split(/\s+/)[0] || "").trim();
        if (remoteSha === local.stdout) {
          return sendJson(response, 200, {
            ok: true,
            pulled: false,
            code: "latest",
            from: local.stdout,
            to: local.stdout,
            short: { from: local.stdout.slice(0, 7), to: local.stdout.slice(0, 7) },
            hint: `已是最新（${local.stdout.slice(0, 7)}）`
          });
        }
        // 本地有未提交改动时 git pull 会拒绝：把状态一起带回去，界面能说清楚
        const dirty = await runGit(["status", "--porcelain"]);
        const pull = await runGit(["pull", "--ff-only", remoteUrl, branch], { timeout: 90000 });
        if (!pull.ok) {
          return sendJson(response, 200, {
            ok: false,
            code: "pull_failed",
            from: local.stdout,
            to: "",
            short: { from: local.stdout.slice(0, 7), to: remoteSha.slice(0, 7) },
            dirty: dirty.stdout.slice(0, 500),
            hint: dirty.stdout
              ? "本地有未提交改动，先提交或撤销再更新"
              : `拉取失败：${pull.stderr.slice(0, 200)}`,
            error: pull.stderr.slice(0, 500),
            output: pull.stdout.slice(0, 500)
          });
        }
        const after = await runGit(["rev-parse", "HEAD"]);
        return sendJson(response, 200, {
          ok: true,
          pulled: true,
          code: "applied",
          needsRestart: true,
          from: local.stdout,
          to: after.ok ? after.stdout : remoteSha,
          short: { from: local.stdout.slice(0, 7), to: (after.ok ? after.stdout : remoteSha).slice(0, 7) },
          hint: `已更新到 ${(after.ok ? after.stdout : remoteSha).slice(0, 7)}，重启 DSH 生效`
        });
      }

      /* 更新通道：重启宿主（apply 之后调；用半脱离的 cmd 脚本，15 秒后重启） */
      if (method === "POST" && route === "/update/restart") {
        const scriptPath = path.join(os.homedir(), ".dsh", "restart-dsh.cmd");
        if (!fs.existsSync(scriptPath)) {
          return fail(response, 400, new Error(`找不到重启脚本：${scriptPath}`), "restart_script_missing");
        }
        try {
          const child = spawn("cmd.exe", ["/c", scriptPath], { detached: true, stdio: "ignore", windowsHide: true });
          child.unref();
        } catch (error) {
          return fail(response, 500, error, "restart_failed");
        }
        return sendJson(response, 200, {
          ok: true,
          restarting: true,
          script: scriptPath,
          delaySeconds: 15,
          hint: "15 秒后重启 DSH，页面会短暂断开，重连后即新版本"
        });
      }

      /* 配置 */
      if (method === "GET" && route === "/config") {
        return sendJson(response, 200, { ok: true, config: publicConfig() });
      }
      if (method === "POST" && route === "/config") {
        const body = await readBody(request);
        // 素材目录单独处理：要建目录、校验可写、把现有素材复制过去、再换整套路径。
        if (typeof body.stateDir === "string") {
          try {
            const moved = await switchStateDir(body.stateDir);
            return sendJson(response, 200, { ok: true, config: publicConfig(), stateDir, moved });
          } catch (error) {
            return fail(response, 400, error, "state_dir_failed");
          }
        }
        const patch = {};
        if (typeof body.baseUrl === "string" && body.baseUrl.trim()) patch.baseUrl = body.baseUrl.trim().replace(/\/+$/, "");
        // 「保存到本地」目录：空串 = 回到默认（系统下载目录/velapi-image-go）
        if (typeof body.saveDir === "string") patch.saveDir = body.saveDir.trim();
        if (typeof body.apiKey === "string") patch.apiKey = body.apiKey.trim();
        if (typeof body.apiKeyEnv === "string" && body.apiKeyEnv.trim()) patch.apiKeyEnv = body.apiKeyEnv.trim();
        if (typeof body.defaultModel === "string" && body.defaultModel.trim()) patch.defaultModel = body.defaultModel.trim();
        if (typeof body.defaultSize === "string" && body.defaultSize.trim()) patch.defaultSize = body.defaultSize.trim();
        // 视频尺寸单独一份：切协议时不会把图片尺寸写坏
        if (typeof body.videoSize === "string" && /^\d{2,5}x\d{2,5}$/.test(body.videoSize.trim())) patch.videoSize = body.videoSize.trim();
        // 视频比例 / 分辨率：分开存，像素 size 由界面组合后一起写回
        if (typeof body.videoRatio === "string" && VIDEO_RATIOS.includes(body.videoRatio)) patch.videoRatio = body.videoRatio;
        if (typeof body.videoResolution === "string" && VIDEO_RESOLUTIONS.includes(body.videoResolution)) patch.videoResolution = body.videoResolution;
        if (typeof body.videoSeconds === "string" && VIDEO_SECONDS.includes(body.videoSeconds)) patch.videoSeconds = body.videoSeconds;
        if (typeof body.defaultQuality === "string") {
          patch.defaultQuality = oneOf(body.defaultQuality.toUpperCase(), ["LOW", "MEDIUM", "HIGH"], runtime.defaultQuality);
        }
        if (body.defaultCount !== undefined) patch.defaultCount = clampInt(body.defaultCount, 1, MAX_N, runtime.defaultCount);
        // 端点协议：认不出的值回落成自动检测，不因为手滑的字符串把生成打死
        if (typeof body.defaultEndpoint === "string") patch.defaultEndpoint = normalizeProtocolId(body.defaultEndpoint);
        if (body.concurrency !== undefined) patch.concurrency = clampInt(body.concurrency, 1, 20, runtime.concurrency);
        if (body.timeoutMs !== undefined) patch.timeoutMs = clampInt(body.timeoutMs, 5000, 900000, runtime.timeoutMs);
        if (typeof body.activeProviderId === "string") patch.activeProviderId = body.activeProviderId.trim();
        // 对话上下文管理：用哪个对话模型、喂最近几轮
        if (typeof body.chatModel === "string") patch.chatModel = body.chatModel.trim().slice(0, 120);
        if (body.contextTurns !== undefined) patch.contextTurns = clampInt(body.contextTurns, 0, 12, runtime.contextTurns);
        // 自定义快捷键：客户端存一份 JSON 串，跟着 config.json 跨更新活着
        if (typeof body.shortcuts === "string" && body.shortcuts.length <= 4096) patch.shortcuts = body.shortcuts.trim();
        runtime = { ...runtime, ...patch };
        await persistConfig();
        return sendJson(response, 200, { ok: true, config: publicConfig() });
      }

      /* 供应商 */
      if (method === "GET" && route === "/providers") {
        return sendJson(response, 200, { ok: true, items: providers.map(publicProvider) });
      }
      if (method === "POST" && route === "/providers") {
        const body = await readBody(request);
        const id = trimText(body.id, 64) || newId("pv");
        const existing = providerById(id);
        const models = Array.isArray(body.models)
          ? body.models.map((item) => trimText(String(item), 120)).filter(Boolean)
          : existing?.models ?? [];
        // 手改模型列表后，元数据只保留仍然存在的 id
        const metaSource = body.modelMeta && typeof body.modelMeta === "object" ? body.modelMeta : existing?.modelMeta ?? {};
        const modelMeta = {};
        for (const modelId of models) if (metaSource[modelId]) modelMeta[modelId] = normalizeModelMeta(metaSource[modelId]);
        // 密钥：界面上编辑供应商时密钥框是空的（不回显明文），空串的意思是「不改」，
        // 不是「清空」。以前这里把空串当新值写进去 —— 改个接口地址就顺手把 key 抹了，
        // 之后测试连接回「invalid access key」，查半天才发现 key 没了。
        const providedKey = typeof body.apiKey === "string" ? body.apiKey.trim() : null;
        const wantRuntimeKey = body.useRuntimeKey === undefined ? existing?.useRuntimeKey ?? false : Boolean(body.useRuntimeKey);
        const apiKey = providedKey !== null && providedKey !== "" ? providedKey : wantRuntimeKey ? "" : existing?.apiKey ?? "";
        // 手里有真 key 就不该再标「用运行期密钥」（两者同时为真会让界面显示自相矛盾）
        const useRuntimeKey = apiKey ? false : wantRuntimeKey;
        const record = {
          id,
          name: trimText(body.name, 80) || existing?.name || "未命名供应商",
          baseUrl: trimText(body.baseUrl, 300).replace(/\/+$/, "") || existing?.baseUrl || runtime.baseUrl,
          apiKey,
          useRuntimeKey,
          models,
          modelMeta,
          endpoint: normalizeProtocolId(body.endpoint ?? existing?.endpoint),
          enabled: body.enabled === undefined ? existing?.enabled !== false : Boolean(body.enabled),
          note: trimText(body.note, 400) || existing?.note || "",
          createdAt: existing?.createdAt || new Date().toISOString()
        };
        if (existing) {
          providers = providers.map((item) => (item.id === id ? record : item));
        } else {
          providers.push(record);
        }
        await persistProviders();
        return sendJson(response, 200, { ok: true, item: publicProvider(record), items: providers.map(publicProvider) });
      }
      if (method === "POST" && route === "/providers/delete") {
        const body = await readBody(request);
        const id = trimText(body.id, 64);
        const before = providers.length;
        providers = providers.filter((item) => item.id !== id);
        if (providers.length === before) return fail(response, 404, new Error("供应商不存在"), "not_found");
        if (runtime.activeProviderId === id) {
          runtime = { ...runtime, activeProviderId: "" };
          await persistConfig();
        }
        await persistProviders();
        return sendJson(response, 200, { ok: true, items: providers.map(publicProvider) });
      }
      if (method === "POST" && route === "/providers/test") {
        const body = await readBody(request);
        const provider = providerById(trimText(body.id, 64));
        const baseUrl = String(body.baseUrl || provider?.baseUrl || runtime.baseUrl).replace(/\/+$/, "");
        const apiKey = typeof body.apiKey === "string" && body.apiKey.trim() ? body.apiKey.trim() : provider?.apiKey || activeKey();
        if (!apiKey) return fail(response, 400, new Error(`没有可用密钥：填 API Key 或设置环境变量 ${runtime.apiKeyEnv}`), "missing_api_key");
        const startedAt = Date.now();
        try {
          const models = await fetchModels({ baseUrl, apiKey, timeoutMs: runtime.timeoutMs });
          return sendJson(response, 200, { ok: true, models, elapsedMs: Date.now() - startedAt });
        } catch (error) {
          // 401/403 时顺手解释「是不是 key 和接口地址不是一家的」，解释不出来就不写这条
          const hint = await explainKeyMismatch({ baseUrl, apiKey, error, timeoutMs: runtime.timeoutMs });
          return sendJson(response, 200, {
            ok: false,
            error: String(error?.message ?? error),
            code: error?.code ?? "provider_test_failed",
            ...(error?.detail ? { detail: error.detail } : {}),
            ...(hint ? { hint } : {}),
            elapsedMs: Date.now() - startedAt
          });
        }
      }

      /* 模型目录 */
      if (method === "GET" && route === "/models") {
        const providerId = query.get("providerId") ?? "";
        const cached = (providerId && catalog[providerId]) || catalog.__default || null;
        const items = cached?.items ?? [];
        return sendJson(response, 200, {
          ok: true,
          items,
          models: items.map((item) => item.id),
          fetchedAt: cached?.fetchedAt ?? ""
        });
      }
      if (method === "POST" && route === "/models/refresh") {
        const body = await readBody(request);
        const providerId = trimText(body.providerId, 64);
        const { baseUrl, apiKey } = resolveTarget(providerId);
        if (!apiKey) return fail(response, 400, new Error(`没有可用密钥：填 API Key 或设置环境变量 ${runtime.apiKeyEnv}`), "missing_api_key");
        const items = await fetchModels({ baseUrl, apiKey, timeoutMs: runtime.timeoutMs });
        const modelMeta = {};
        for (const item of items) modelMeta[item.id] = normalizeModelMeta(item);
        const record = { items, fetchedAt: new Date().toISOString(), baseUrl };
        catalog = { ...catalog, [providerId || "__default"]: record };
        await persistCatalog();
        if (providerId) {
          providers = providers.map((item) =>
            item.id === providerId
              ? { ...item, models: items.slice(0, 200).map((entry) => entry.id), modelMeta }
              : item
          );
          await persistProviders();
        }
        return sendJson(response, 200, {
          ok: true,
          items,
          models: items.map((item) => item.id),
          fetchedAt: record.fetchedAt
        });
      }

      /* 对话上下文管理：把「最近几轮 + 这次这句话」交给对话模型，整理成本轮要用的提示词 */
      if (method === "POST" && route === "/chat/plan") {
        const body = await readBody(request);
        const message = trimText(body.message, 2000);
        const draft = trimText(body.draft, 4000);
        if (message.length === 0 && draft.length === 0) return fail(response, 400, new Error("既没有新消息也没有草稿"), "empty_message");
        const candidate = pickChatModel(trimText(body.chatModel, 120));
        if (!candidate) {
          return fail(response, 400, new Error("没有可用的对话模型：先在「供应商管理」里拉取模型，或在运行期配置里指定对话模型"), "no_chat_model");
        }
        const starter = Date.now();
        const imageModel = trimText(body.model, 120) || runtime.defaultModel;
        const size = trimText(body.size, 32) || runtime.defaultSize;
        const referenceUrl = /^\/api\/velapi-image-go\/(upload|asset)\/[A-Za-z0-9._-]+$/.test(String(body.referenceUrl ?? ""))
          ? String(body.referenceUrl)
          : "";
        /* 多参考图：列表都交给对话模型，它才能判断「在哪张上改 / 别把 S2 当 S3」 */
        const planReferenceUrls = (Array.isArray(body.referenceUrls) ? body.referenceUrls : [body.referenceUrl])
          .filter((item) => /^\/api\/velapi-image-go\/(upload|asset)\/[A-Za-z0-9._-]+$/.test(String(item ?? "")))
          .map((item) => String(item))
          .slice(0, 4);
        const turns = clampInt(body.turns ?? runtime.contextTurns, 0, 12, runtime.contextTurns);
        const history = Array.isArray(body.history) ? body.history.slice(-12) : [];
        /* 客户端「限制上下文模型直接调供应商出图」开着时：只许整理提示词与分类，
           不许自作主张切编辑/决定参考图 —— 出图只由用户原话与已挂参考图决定。 */
        const noAutoImage = body.noAutoImage !== false;
        const instruction = [
          `接下来这张图用的模型：${imageModel}`,
          `目标尺寸：${size}`,
          `当前挂着的参考图（最多 4 张，按顺序是第 1…N 张）：${planReferenceUrls.length > 0 ? planReferenceUrls.join("、") : "(没有)"}`,
          history.length > 0 ? `最近几轮（旧 → 新）：\n${planHistoryText(history, turns)}` : "最近几轮：(没有历史，这是第一轮)",
          `这次用户说：${message || "(没有新文字，只改了草稿)"}`,
          draft && draft !== message ? `输入框草稿：${draft}` : "",
          noAutoImage ? "限制：不要自行决定编辑或决定参考图（referenceUrl 一律给空串）；只整理提示词与 action 分类。" : ""
        ]
          .filter(Boolean)
          .join("\n\n");
        try {
          const target = resolveTarget(candidate.providerId, candidate.id);
          if (!target.apiKey) {
            return fail(response, 400, new Error(`没有可用密钥：在「供应商管理」里填 API Key，或设置环境变量 ${runtime.apiKeyEnv}`), "missing_api_key");
          }
          const { payload, elapsedMs } = await callUpstream({
            baseUrl: target.baseUrl,
            apiKey: target.apiKey,
            route: "/chat/completions",
            body: {
              model: candidate.id,
              messages: [
                { role: "system", content: PLAN_SYSTEM_PROMPT },
                { role: "user", content: instruction }
              ],
              temperature: 0.3,
              max_tokens: 900
            },
            timeoutMs: Math.min(runtime.timeoutMs, 120000)
          });
          const raw = extractChatText(payload);
          const plan = parsePlanJson(raw);
          if (!plan) {
            return sendJson(response, 200, {
              ok: false,
              code: "plan_parse_failed",
              error: "对话模型没有给出可解析的 JSON（原文见 raw）",
              raw: String(raw || "").slice(0, 2000),
              chatModel: candidate.id,
              elapsedMs
            });
          }
          const safeReference = /^\/api\/velapi-image-go\/(upload|asset)\/[A-Za-z0-9._-]+$/.test(plan.referenceUrl) ? plan.referenceUrl : "";
          return sendJson(response, 200, {
            ok: true,
            chatModel: candidate.id,
            elapsedMs,
            action: plan.action,
            prompt: plan.prompt,
            reply: plan.reply,
            mode: plan.mode,
            referenceUrl: safeReference,
            reason: plan.reason
          });
        } catch (error) {
          return sendJson(response, 200, {
            ok: false,
            code: error?.code ?? "plan_failed",
            error: String(error?.message ?? error),
            ...(error?.detail ? { detail: error.detail } : {}),
            chatModel: candidate.id,
            elapsedMs: Date.now() - starter
          });
        }
      }

      /* 纯对话：用户是在纠正 / 讨论，只回一句话、不出图；但这条往来要留在会话历史里 */
      if (method === "POST" && route === "/chat/message") {
        const body = await readBody(request);
        const message = trimText(body.message, 2000);
        const reply = trimText(body.reply, 2000);
        if (message.length === 0 || reply.length === 0) return fail(response, 400, new Error("需要 message 和 reply"), "empty_message");
        const requestedConversationId = trimText(body.conversationId, 64);
        const conversationId = conversations.some((item) => item.id === requestedConversationId)
          ? requestedConversationId
          : conversations.some((item) => item.id === DEFAULT_CONVERSATION_ID)
            ? DEFAULT_CONVERSATION_ID
            : conversations[0]?.id ?? DEFAULT_CONVERSATION_ID;
        const job = {
          id: newId("msg"),
          kind: "reply",
          status: "succeeded",
          mode: "chat",
          prompt: message,
          userText: message,
          reply,
          model: trimText(body.chatModel, 120),
          providerId: "",
          size: "",
          quality: "",
          count: 0,
          protocol: "chat",
          referenceUrl: "",
          source: "ui",
          sessionId: "",
          conversationId,
          createdAt: new Date().toISOString(),
          images: [],
          error: "",
          errorCode: ""
        };
        jobs.unshift(job);
        if (jobs.length > MAX_JOBS) jobs = jobs.slice(0, MAX_JOBS);
        const conversation = conversations.find((item) => item.id === conversationId);
        if (conversation) {
          conversation.updatedAt = new Date().toISOString();
          if (/^(新对话|默认对话)/.test(conversation.title || "")) conversation.title = message.slice(0, 24);
          await persistConversations();
        }
        await persistJobs();
        return sendJson(response, 200, { ok: true, job });
      }

      /* 聊天：把这句话直接交给对话模型回答（聊天模式用，不触发生图）。
         和 /chat/message 的区别：那个只记录一条已生成好的回复，这个真的去问模型。
         上游偶尔某个模型「无可用渠道」：没指定模型时按目录顺序试前 3 个（指定了就只试它）。 */
      if (method === "POST" && route === "/chat/say") {
        const body = await readBody(request);
        const message = trimText(body.message, 4000);
        if (message.length === 0) return fail(response, 400, new Error("消息不能为空"), "empty_message");
        const candidates = chatSayCandidates(trimText(body.chatModel, 120));
        if (candidates.length === 0) {
          return fail(response, 400, new Error("没有可用的对话模型：先在「供应商管理」里拉取模型，或在运行期配置里指定对话模型"), "no_chat_model");
        }
        const requestedConversationId = trimText(body.conversationId, 64);
        const conversationId = conversations.some((item) => item.id === requestedConversationId)
          ? requestedConversationId
          : conversations.some((item) => item.id === DEFAULT_CONVERSATION_ID)
            ? DEFAULT_CONVERSATION_ID
            : conversations[0]?.id ?? DEFAULT_CONVERSATION_ID;
        let lastError = null;
        for (let attempt = 0; attempt < candidates.length; attempt += 1) {
          const candidate = candidates[attempt];
          try {
            const target = resolveTarget(candidate.providerId, candidate.id);
            if (!target.apiKey) {
              lastError = new Error(`没有可用密钥：在「供应商管理」里填 API Key，或设置环境变量 ${runtime.apiKeyEnv}`);
              continue;
            }
            const { payload, elapsedMs } = await callUpstream({
              baseUrl: target.baseUrl,
              apiKey: target.apiKey,
              route: "/chat/completions",
              body: {
                model: candidate.id,
                messages: [
                  { role: "system", content: "你是对话助手：用简洁中文直接回答用户，不要输出 JSON 或 Markdown 代码块。" },
                  { role: "user", content: message }
                ],
                temperature: 0.7,
                max_tokens: 1500
              },
              timeoutMs: Math.min(runtime.timeoutMs, 120000)
            });
            const reply = String(extractChatText(payload) || "").trim();
            if (!reply) {
              lastError = new Error("对话模型返回了空内容");
              continue;
            }
            const job = {
              id: newId("msg"),
              kind: "reply",
              status: "succeeded",
              mode: "chat",
              prompt: message,
              userText: message,
              reply,
              model: candidate.id,
              providerId: candidate.providerId,
              size: "",
              quality: "",
              count: 0,
              protocol: "chat",
              referenceUrl: "",
              source: "ui",
              sessionId: "",
              conversationId,
              createdAt: new Date().toISOString(),
              images: [],
              error: "",
              errorCode: ""
            };
            jobs.unshift(job);
            if (jobs.length > MAX_JOBS) jobs = jobs.slice(0, MAX_JOBS);
            const conversation = conversations.find((item) => item.id === conversationId);
            if (conversation) {
              conversation.updatedAt = new Date().toISOString();
              if (/^(新对话|默认对话)/.test(conversation.title || "")) conversation.title = message.slice(0, 24);
              await persistConversations();
            }
            await persistJobs();
            return sendJson(response, 200, {
              ok: true,
              job,
              chatModel: candidate.id,
              elapsedMs,
              attempted: attempt + 1
            });
          } catch (error) {
            lastError = error;
          }
        }
        return fail(response, 502, lastError ?? new Error("所有对话模型都不可用"), "chat_failed");
      }

      /* 生图 */
      if (method === "POST" && route === "/generate") {
        const body = await readBody(request);
        const prompt = trimText(body.prompt, 4000);
        if (prompt.length === 0) return fail(response, 400, new Error("提示词不能为空"), "empty_prompt");
        const providerId = trimText(body.providerId, 64);
        const model = trimText(body.model, 120) || runtime.defaultModel;
        const target = resolveTarget(providerId, model);
        const size = trimText(body.size, 32) || runtime.defaultSize;
        const quality = oneOf(String(body.quality || runtime.defaultQuality).toUpperCase(), ["LOW", "MEDIUM", "HIGH"], runtime.defaultQuality);
        const count = clampInt(body.n ?? runtime.defaultCount, 1, MAX_N, runtime.defaultCount);
        // 视频时长（秒）：只有视频协议会用到，图片请求忽略
        const seconds = VIDEO_SECONDS.includes(String(body.seconds || "")) ? String(body.seconds) : runtime.videoSeconds;
        let mode = body.mode === "edit" ? "edit" : "generate";
        /* 参考图的缩略图地址：只收本站自己的 upload / asset 路径。
           它只是给「我发出去的那条消息」配一张缩略图用 —— 原始 base64 照旧不留在历史里。 */
        const referenceUrl = /^\/api\/velapi-image-go\/(upload|asset)\/[A-Za-z0-9._-]+$/.test(String(body.referenceUrl ?? ""))
          ? String(body.referenceUrl)
          : "";
        /* 多参考图：referenceUrls 数组（老的单数 referenceUrl 并进第一条），最多 4 张。
           它只是给「我发出去的那条消息」配缩略图 / 重试回填用 —— 原始 base64 照旧不留在历史里。 */
        const collectUrls = (input) => (Array.isArray(input) ? input : [input]).filter((item) => /^\/api\/velapi-image-go\/(upload|asset)\/[A-Za-z0-9._-]+$/.test(String(item ?? ""))).map((item) => String(item));
        const referenceUrls = [...new Set([...collectUrls(body.referenceUrls), ...(referenceUrl ? [referenceUrl] : [])])].slice(0, 4);
        // 过程留痕：界面 / 工具 / 外部 API，各自标清楚
        const source = oneOf(trimText(body.source, 16), ["ui", "tool", "api"], "api");
        const sessionId = trimText(body.sessionId, 120);
        // 归到哪个对话：点名的对话不存在就落默认（没有默认就第一条）；老客户端不带就是默认对话
        const requestedConversationId = trimText(body.conversationId, 64);
        const conversationId = conversations.some((item) => item.id === requestedConversationId)
          ? requestedConversationId
          : conversations.some((item) => item.id === DEFAULT_CONVERSATION_ID)
            ? DEFAULT_CONVERSATION_ID
            : conversations[0]?.id ?? DEFAULT_CONVERSATION_ID;
        /* 协议取舍：这次请求里写的 > 输入框那一行选的（config.defaultEndpoint）> 供应商记录 > 自动检测。
           「自动检测」是所有人的缺省值，所以它不该压过上层更明确的选择。 */
        const protocol = resolveProtocol({
          requested: body.endpoint,
          preferred: runtime.defaultEndpoint,
          fallback: target.provider?.endpoint
        });
        let requestImages = [];
        /* 图生图素材：优先用直接给的字节（images 数组，兼容老的单数 image）；只给了本站
           referenceUrl / referenceUrls（比如失败任务「重试」时历史里只留了缩略图 URL）
           就从 uploads / 图库里把字节读回来。最多 4 张，上游 gpt-image 系够用。 */
        const wantsEdit = mode === "edit" || protocol === "images_edits";
        if (wantsEdit) {
          const inlineImages = (Array.isArray(body.images) ? body.images : [body.image]).slice(0, 4);
          for (const raw of inlineImages) {
            if (requestImages.length >= 4) break;
            const parsed = decodeBase64Image(raw);
            if (parsed) requestImages.push(`data:${parsed.mime};base64,${parsed.buffer.toString("base64")}`);
          }
          for (const refUrl of referenceUrls) {
            if (requestImages.length >= 4) break;
            const kind = refUrl.includes("/upload/") ? "upload" : "library";
            const fileName = refUrl.split("/").pop();
            const localFile = resolveStatic(fileName, kind);
            if (!localFile) continue;
            const buffer = fs.readFileSync(localFile);
            const sniffed = sniffImage(buffer);
            // 文件在但不是图（被挪坏 / 写入了别的东西）：跳过这张，不让上游吃 400
            if (sniffed.format === "bin") continue;
            requestImages.push(`data:${sniffed.mime};base64,${buffer.toString("base64")}`);
          }
          if (requestImages.length > 0) mode = "edit";
          else if (mode === "edit") return fail(response, 400, new Error("图生图需要至少一张可解码的参考图（image / images，或本站 referenceUrl / referenceUrls）"), "missing_reference");
        }
        /* 局部改图：mask 是「哪些区域要重画」的黑白图（白=改），和第一张参考图同尺寸。
           上游 /images/edits 的 mask 字段；只有带参考图的编辑才收，普通生成忽略。 */
        let requestMask = "";
        if (wantsEdit && requestImages.length > 0) {
          const parsedMask = decodeBase64Image(body.mask);
          if (parsedMask) requestMask = `data:${parsedMask.mime};base64,${parsedMask.buffer.toString("base64")}`;
        }
        const job = {
          id: newId("job"),
          status: "queued",
          mode,
          prompt,
          model,
          providerId: target.provider?.id ?? "",
          size,
          quality,
          count,
          seconds,
          protocol,
          referenceUrl: referenceUrls[0] || "",
          referenceUrls,
          source,
          sessionId,
          // 对话上下文管理的留痕：用户原话（气泡里显示这句）+ 对话模型给出的理由 / 改写后的提示词
          userText: trimText(body.userText, 500),
          planNote: trimText(body.planNote, 600),
          conversationId,
          createdAt: new Date().toISOString(),
          images: [],
          requestImage: requestImages[0] || "",
          requestImages,
          requestMask,
          error: "",
          errorCode: ""
        };
        enqueue(job);
        // 对话列表要能认出这段对话：更新 updatedAt；还是「新对话 N / 默认对话」就拿第一句提示词当名字
        const conversation = conversations.find((item) => item.id === conversationId);
        if (conversation) {
          conversation.updatedAt = new Date().toISOString();
          if (/^(新对话|默认对话)/.test(conversation.title || "")) conversation.title = prompt.slice(0, 24);
          await persistConversations();
        }
        return sendJson(response, 200, {
          ok: true,
          job: {
            id: job.id,
            status: job.status,
            prompt: job.prompt,
            model: job.model,
            size: job.size,
            quality: job.quality,
            count: job.count,
            mode: job.mode,
            protocol: job.protocol,
            referenceUrl: job.referenceUrl,
            referenceUrls: job.referenceUrls,
            conversationId,
            createdAt: job.createdAt
          },
          queue: queue.length + inflight
        });
      }

      /* 任务 */
      /* 对话（会话）：可新建 / 重命名 / 删除；任务按 conversationId 归档，删对话连带删它的任务 */
      if (method === "GET" && route === "/conversations") {
        return sendJson(response, 200, { ok: true, items: conversations.map(publicConversation), defaultId: DEFAULT_CONVERSATION_ID });
      }
      if (method === "POST" && route === "/conversations") {
        const body = await readBody(request);
        const title = trimText(body.title, 80);
        const record = {
          id: newId("conv"),
          title: title || `新对话 ${conversations.length + 1}`,
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString()
        };
        conversations = [record, ...conversations];
        await persistConversations();
        return sendJson(response, 200, { ok: true, item: publicConversation(record), items: conversations.map(publicConversation) });
      }
      if (method === "POST" && route === "/conversations/rename") {
        const body = await readBody(request);
        const id = trimText(body.id, 64);
        const title = trimText(body.title, 80);
        const record = conversations.find((item) => item.id === id);
        if (!record) return fail(response, 404, new Error("对话不存在"), "not_found");
        if (title) record.title = title;
        record.updatedAt = new Date().toISOString();
        await persistConversations();
        return sendJson(response, 200, { ok: true, item: publicConversation(record), items: conversations.map(publicConversation) });
      }
      if (method === "POST" && route === "/conversations/delete") {
        const body = await readBody(request);
        const id = trimText(body.id, 64);
        if (!conversations.some((item) => item.id === id)) return fail(response, 404, new Error("对话不存在"), "not_found");
        const before = jobs.length;
        // 在队列 / 在飞的任务先取消，再连同这个对话一起摘掉
        for (const job of jobs.filter((item) => item.conversationId === id)) {
          const at = queue.findIndex((item) => item.id === job.id);
          if (at >= 0) queue.splice(at, 1);
          const controller = controllers.get(job.id);
          if (controller) controller.abort();
        }
        jobs = jobs.filter((item) => item.conversationId !== id);
        conversations = conversations.filter((item) => item.id !== id);
        await persistJobs();
        await persistConversations();
        return sendJson(response, 200, { ok: true, removedJobs: before - jobs.length, items: conversations.map(publicConversation) });
      }

      if (method === "GET" && route === "/jobs") {
        const limit = clampInt(query.get("limit"), 1, MAX_JOBS, 30);
        const conversationId = trimText(query.get("conversationId"), 64);
        const list = conversationId ? jobs.filter((job) => job.conversationId === conversationId) : jobs;
        return sendJson(response, 200, {
          ok: true,
          items: list.slice(0, limit),
          pending: queue.length + inflight
        });
      }
      if (method === "GET" && route === "/job") {
        const id = query.get("id") ?? "";
        const job = jobs.find((item) => item.id === id);
        if (!job) return fail(response, 404, new Error("任务不存在"), "not_found");
        const { requestImage, requestMask, ...rest } = job;
        return sendJson(response, 200, { ok: true, job: rest });
      }
      if (method === "POST" && route === "/job/cancel") {
        const body = await readBody(request);
        const id = trimText(body.id, 64);
        const job = jobs.find((item) => item.id === id);
        if (!job) return fail(response, 404, new Error("任务不存在"), "not_found");
        const controller = controllers.get(id);
        if (controller) controller.abort();
        else if (job.status === "queued") {
          const at = queue.findIndex((item) => item.id === id);
          if (at >= 0) queue.splice(at, 1);
          job.status = "canceled";
          job.finishedAt = new Date().toISOString();
          await persistJobs();
        }
        return sendJson(response, 200, { ok: true });
      }

      /* 删除任务记录（界面上的「删除」那颗按钮）：不影响图库里的素材 */
      if (method === "POST" && route === "/job/delete") {
        const body = await readBody(request);
        const ids = Array.isArray(body.ids) ? body.ids.map((id) => trimText(String(id || ""), 64)).filter(Boolean) : [];
        if (ids.length === 0) return fail(response, 400, new Error("要删哪些任务（ids: []）"), "empty_ids");
        const before = jobs.length;
        // 还在队列 / 在飞的任务：先取消再摘掉，别留一个没人管的控制器
        for (const id of ids) {
          const at = queue.findIndex((item) => item.id === id);
          if (at >= 0) queue.splice(at, 1);
          const controller = controllers.get(id);
          if (controller) controller.abort();
        }
        jobs = jobs.filter((job) => !ids.includes(job.id));
        await persistJobs();
        return sendJson(response, 200, { ok: true, removed: before - jobs.length, items: jobs });
      }

      /* 图库 */
      if (method === "GET" && route === "/library") {
        const text = trimText(query.get("q"), 120).toLowerCase();
        const model = trimText(query.get("model"), 120);
        const limit = clampInt(query.get("limit"), 1, 400, 120);
        const offset = clampInt(query.get("offset"), 0, 100000, 0);
        const filtered = library.filter((asset) => {
          if (model && asset.model !== model) return false;
          if (!text) return true;
          return `${asset.name} ${asset.prompt} ${asset.model}`.toLowerCase().includes(text);
        });
        return sendJson(response, 200, {
          ok: true,
          total: filtered.length,
          items: filtered.slice(offset, offset + limit).map(publicAsset),
          models: [...new Set(library.map((asset) => asset.model).filter(Boolean))].sort()
        });
      }
      if (method === "POST" && route === "/library/rename") {
        const body = await readBody(request);
        const id = trimText(body.id, 64);
        const nextName = trimText(body.name, 160);
        if (!nextName) return fail(response, 400, new Error("名称不能为空"), "empty_name");
        let hit = null;
        library = library.map((asset) => {
          if (asset.id !== id) return asset;
          hit = { ...asset, name: nextName };
          return hit;
        });
        if (!hit) return fail(response, 404, new Error("图片不存在"), "not_found");
        await persistLibrary();
        return sendJson(response, 200, { ok: true, item: publicAsset(hit) });
      }
      if (method === "POST" && route === "/library/delete") {
        const body = await readBody(request);
        const ids = Array.isArray(body.ids) ? body.ids.map((item) => trimText(String(item), 64)) : [];
        if (ids.length === 0) return fail(response, 400, new Error("没有指定要删除的图片"), "empty_ids");
        const removed = [];
        const kept = [];
        for (const asset of library) {
          if (ids.includes(asset.id)) removed.push(asset);
          else kept.push(asset);
        }
        library = kept;
        for (const asset of removed) {
          try {
            await fsp.rm(path.join(filesDir, asset.file), { force: true });
          } catch {
            /* 文件已经不在就算了，索引才是真相 */
          }
        }
        await persistLibrary();
        return sendJson(response, 200, { ok: true, removed: removed.length, items: library.slice(0, 200).map(publicAsset) });
      }

      /* 上传参考图 */
      if (method === "POST" && route === "/upload") {
        const body = await readBody(request);
        const decoded = decodeBase64Image(body.data ?? body.dataBase64 ?? body.image);
        if (!decoded) return fail(response, 400, new Error("上传内容不是可解码的图片"), "bad_upload");
        const sniffed = sniffImage(decoded.buffer);
        const suffix = MIME_EXT[decoded.mime] || sniffed.format || "png";
        const id = newId("up");
        const fileName = `${id}.${suffix}`;
        await fsp.writeFile(path.join(uploadsDir, fileName), decoded.buffer);
        return sendJson(response, 200, {
          ok: true,
          item: {
            id,
            name: trimText(body.name, 160) || fileName,
            url: `${ROUTE_PREFIX}/upload/${fileName}`,
            bytes: decoded.buffer.length,
            width: sniffed.width,
            height: sniffed.height,
            format: sniffed.format,
            dataUrl: `data:${decoded.mime};base64,${decoded.buffer.toString("base64")}`
          }
        });
      }

      /* 信息管理 */
      if (method === "GET" && route === "/notes") {
        return sendJson(response, 200, { ok: true, items: notes });
      }
      if (method === "POST" && route === "/notes") {
        const body = await readBody(request);
        const id = trimText(body.id, 64) || newId("note");
        const existing = notes.find((item) => item.id === id);
        const record = {
          id,
          title: trimText(body.title, 120) || existing?.title || "未命名信息",
          prompt: trimText(body.prompt, 4000),
          meta: trimText(body.meta, 1000),
          tags: Array.isArray(body.tags) ? body.tags.map((item) => trimText(String(item), 32)).filter(Boolean).slice(0, 12) : existing?.tags ?? [],
          createdAt: existing?.createdAt || new Date().toISOString(),
          updatedAt: new Date().toISOString()
        };
        if (record.prompt.length === 0 && record.meta.length === 0) {
          return fail(response, 400, new Error("提示词与元信息至少要填一项"), "empty_note");
        }
        if (existing) notes = notes.map((item) => (item.id === id ? record : item));
        else notes.unshift(record);
        await persistNotes();
        return sendJson(response, 200, { ok: true, item: record, items: notes });
      }
      if (method === "POST" && route === "/notes/delete") {
        const body = await readBody(request);
        const id = trimText(body.id, 64);
        notes = notes.filter((item) => item.id !== id);
        await persistNotes();
        return sendJson(response, 200, { ok: true, items: notes });
      }

      /* 预设卡：标题 + 提示词 + 参考图，支持增删改 */
      if (method === "GET" && route === "/presets") {
        return sendJson(response, 200, { ok: true, items: presets });
      }
      if (method === "POST" && route === "/presets") {
        const body = await readBody(request);
        const id = trimText(body.id, 64) || newId("preset");
        const existing = presets.find((item) => item.id === id) ?? null;
        const record = { ...normalizePreset(body, existing), id };
        if (record.prompt.length === 0 && !record.image) {
          return fail(response, 400, new Error("提示词与参考图至少要有一项"), "empty_preset");
        }
        if (existing) presets = presets.map((item) => (item.id === id ? record : item));
        else presets = [record, ...presets];
        await persistPresets();
        return sendJson(response, 200, { ok: true, item: record, items: presets });
      }
      if (method === "POST" && route === "/presets/delete") {
        const body = await readBody(request);
        const id = trimText(body.id, 64);
        presets = presets.filter((item) => item.id !== id);
        await persistPresets();
        return sendJson(response, 200, { ok: true, items: presets });
      }
      if (method === "POST" && route === "/presets/reset") {
        // 内置卡被删了想找回：把缺的补回来，用户自己建的照旧留着。
        const missing = seedPresets().filter((item) => !presets.some((kept) => kept.id === item.id));
        presets = [...presets, ...missing];
        await persistPresets();
        return sendJson(response, 200, { ok: true, items: presets, restored: missing.length });
      }

      /* 保存到本地：把图库原图复制到「保存目录」（拖到资源管理器不稳定时的可靠出口） */
      if (method === "POST" && route === "/asset/export") {
        const body = await readBody(request);
        const names = Array.isArray(body.files) ? body.files.slice(0, 50).map((item) => path.basename(String(item || ""))) : [];
        if (names.length === 0) return fail(response, 400, new Error("要保存哪些文件（files: [文件名]）"), "empty_files");
        try {
          const result = await exportAssets(names);
          return sendJson(response, 200, { ok: true, ...result });
        } catch (error) {
          return fail(response, 500, error, "export_failed");
        }
      }
      /* 图库原图的本地绝对路径 / file:// URL：拖出到资源管理器时尽量给真文件。
         必须排在下面 /asset/* 静态路由**之前**，否则会被当成文件 "local" 去查、直接 404。 */
      if (method === "GET" && route === "/asset/local") {
        const name = path.basename(String(query.get("file") || ""));
        if (!/^[A-Za-z0-9._-]+$/.test(name)) return fail(response, 404, new Error("文件不存在"), "not_found");
        const target = path.join(filesDir, name);
        if (!fs.existsSync(target)) return fail(response, 404, new Error("文件不存在"), "not_found");
        return sendJson(response, 200, { ok: true, path: target, fileUrl: pathToFileURL(target).href });
      }

      /* 宿主能力：前端据此决定 Shift+拖 要不要同步打原生拖拽、复制图片按钮是否可用 */
      if (method === "GET" && route === "/capabilities") {
        return sendJson(response, 200, { ok: true, version: "0.1.0", ...(await hostCapabilities()) });
      }

      /* 原生拖出：网页侧给不了 OS 真文件，只有 Electron 主进程的 startDrag 能做到。
         客户端在 Shift+拖 时同步调这里（必须在 dragstart 当场把原生拖拽拉起来）。 */
      if (method === "POST" && route === "/drag/native") {
        const body = await readBody(request);
        const found = galleryFile(body.file);
        if (!found) return fail(response, 404, new Error("文件不存在"), "not_found");
        const electron = await loadElectron();
        if (!electron?.BrowserWindow || typeof electron.nativeImage?.createFromPath !== "function") {
          return fail(response, 501, new Error("当前宿主不是 Electron，无法原生拖出：用「保存到本地」或「复制图片」"), "no_electron");
        }
        const windows = typeof electron.BrowserWindow.getAllWindows === "function" ? electron.BrowserWindow.getAllWindows() : [];
        const focused = typeof electron.BrowserWindow.getFocusedWindow === "function" ? electron.BrowserWindow.getFocusedWindow() : null;
        const win = focused ?? windows[0] ?? null;
        if (!win?.webContents?.startDrag) return fail(response, 501, new Error("没有可用的窗口"), "no_window");
        try {
          const source = electron.nativeImage.createFromPath(found.target);
          const icon = typeof source?.resize === "function" ? source.resize({ width: 64 }) : source;
          win.webContents.startDrag({ file: found.target, icon });
          return sendJson(response, 200, { ok: true, name: found.name });
        } catch (error) {
          return fail(response, 500, error, "drag_failed");
        }
      }
      /* 复制图片到系统剪贴板：写的是**真图片**（Electron clipboard 或 PowerShell SetImage），
         不是路径文本；剪贴板管理器 / PPT 里 Ctrl+V 出来的都是图。 */
      if (method === "POST" && route === "/clipboard/image") {
        const body = await readBody(request);
        const found = galleryFile(body.file);
        if (!found) return fail(response, 404, new Error("文件不存在"), "not_found");
        try {
          const via = await writeClipboardImage(found.target);
          if (!via) return fail(response, 501, new Error("当前环境写不了系统剪贴板（需要 Electron 或 Windows PowerShell）"), "no_clipboard");
          return sendJson(response, 200, { ok: true, name: found.name, via });
        } catch (error) {
          return fail(response, 500, error, "clipboard_failed");
        }
      }

      /* 静态：图库原图与上传图 */
      if (method === "GET" && (route.startsWith("/asset/") || route.startsWith("/upload/") || route.startsWith("/preset/"))) {
        const kind = route.startsWith("/upload/") ? "upload" : route.startsWith("/preset/") ? "preset" : "library";
        const prefix = `/${kind === "upload" ? "upload" : kind === "preset" ? "preset" : "asset"}/`;
        const name = route.slice(prefix.length);
        const target = resolveStatic(name, kind);
        if (!target) {
          return sendJson(response, 404, { ok: false, error: "文件不存在", code: "not_found" });
        }
        const sniffed = sniffImage(await fsp.readFile(target));
        const stat = await fsp.stat(target);
        response.writeHead(200, {
          "content-type": sniffed.mime === "application/octet-stream" ? "application/octet-stream" : sniffed.mime,
          "content-length": stat.size,
          "cache-control": "no-store"
        });
        fs.createReadStream(target).pipe(response);
        return undefined;
      }

      /* 素材目录：在系统文件管理器里打开（宿主跑在 Electron 主进程，能直接开） */
      if (method === "POST" && route === "/state/reveal") {
        const body = await readBody(request);
        try {
          return sendJson(response, 200, { ok: true, dir: revealStateDir(body.dir) });
        } catch (error) {
          return fail(response, 400, error, "reveal_failed");
        }
      }

      /* 客户端自检回执：POST 一份新的（保留最近 MAX_CLIENT_REPORTS 条），GET 取回来。
         这是「页面里到底发生了什么」在宿主侧唯一能落盘的地方。 */
      if (route === "/client-report") {
        if (method === "POST") {
          const body = await readBody(request);
          const entry = {
            at: typeof body.at === "string" ? body.at : new Date().toISOString(),
            phase: typeof body.phase === "string" ? body.phase : "unknown",
            detail: body.detail ?? null,
            receivedAt: new Date().toISOString()
          };
          const stored = (await readJson(clientReportPath, [])) || [];
          const rows = [entry, ...(Array.isArray(stored) ? stored : [])].slice(0, MAX_CLIENT_REPORTS);
          await writeJsonAtomic(clientReportPath, rows);
          return sendJson(response, 200, { ok: true, kept: rows.length, file: clientReportPath });
        }
        if (method === "GET") {
          const rows = (await readJson(clientReportPath, [])) || [];
          return sendJson(response, 200, { ok: true, file: clientReportPath, items: rows });
        }
      }

      return sendJson(response, 404, { ok: false, error: `未知端点 ${method} ${route}`, code: "no_route" });
    } catch (error) {
      logger?.warn?.(`velapi-image-go: ${method} ${route} failed: ${String(error?.message ?? error)}`);
      return fail(response, 500, error);
    }
  }

  ctx.effect(
    () =>
      ctx.webServer.register(
        {
          kind: "prefix",
          path: ROUTE_PREFIX,
          handler: (request, response) => handle(request, response)
        },
        "velapi-image-go: workbench api"
      ),
    "velapi-image-go: workbench api route"
  );

  void ready.then(() => {
    logger?.info?.(`velapi-image-go: 工作台服务已挂载 ${ROUTE_PREFIX}（state=${stateDir}）`);
  });

  return {
    // 供 smoke test / 其它插件复用：不放路由，只放这次 apply 的只读视图。
    get state() {
      return {
        stateDir,
        providers: providers.map(publicProvider),
        config: publicConfig(),
        counts: { images: library.length, notes: notes.length, jobs: jobs.length }
      };
    }
  };
}



export default { name, inject, apply };
