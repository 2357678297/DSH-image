// 预览与适配性检查共用的样例数据与页面骨架。
// 这里的 markup 刻意手工拼「导航 + 工作区 + 检查器」的 DOM 顺序，与 Workbench 内部一致：
//   data-compact="0" → 三段并排；data-compact="1" → 导航折成顶部段控件、检查器沉到下方。
// 好处是两条路（宽 / 窄）能被同一套测量脚本量到，不需要在浏览器里跑 React。

import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { React, renderToStaticMarkup } from "./bundle.mjs";

const html = (element) => renderToStaticMarkup(element);
const IMAGE = process.env.VIG_SAMPLE_IMAGE || "G:/Gg-gank/artifacts/velapi-image-go/live-generation-sample.jpg";

/** 内置预设卡的参考图：离线预览时内联成 dataURL，浏览器里能真渲染出来。 */
const PRESET_DIR = join(dirname(dirname(fileURLToPath(import.meta.url))), "assets", "presets");
const presetShot = (name) => {
  const file = join(PRESET_DIR, `${name}.png`);
  return existsSync(file) ? `data:image/png;base64,${readFileSync(file).toString("base64")}` : "";
};

const preview = existsSync(IMAGE) ? `data:image/jpeg;base64,${readFileSync(IMAGE).toString("base64")}` : "";
const shot = (id, name, w, h, prompt) => ({ assetId: id, name, url: preview, bytes: 274044, width: w, height: h, format: "jpg", prompt });
const asset = (id, name, w, h, prompt, model, when) => ({
  id,
  name,
  url: preview,
  bytes: 274044,
  format: "jpg",
  width: w,
  height: h,
  model,
  prompt,
  size: `${w}x${h}`,
  quality: "LOW",
  createdAt: when
});

const now = Date.now();

export const sampleImages = [
  shot("a1", "工作台线稿.jpg", 1024, 1024, "极简工作台 UI 线稿"),
  shot("a2", "产品主图.jpg", 1024, 1024, "极简白色产品主图，柔和阴影"),
  shot("a3", "场景图.jpg", 1024, 1024, "窗边木质桌面上的产品场景图")
];

/* 真实目录：`GET /v1/models` 的 22 条 + 中转站自己给的 family 分类。
 * kind 是权威值（omni-flash 是 video，不是对话）；enabled:false = 该账号未开通。 */
const CATALOG = [
  ["imagen-4", "image", false],
  ["imagen-4.0-generate-preview-landscape", "image", false],
  ["imagen-4.0-generate-preview-portrait", "image", false],
  ["nano-banana-2", "image", true],
  ["nano-banana-2.1", "image", true],
  ["nano-banana-pro", "image", true],
  ["omni-flash", "video", true],
  ...["veo-3.1-flash", "veo-3.1-lite", "veo-3.1-pro", "veo_3_1_extend", "veo_3_1_extend_portrait"].map((id) => [id, "video", true]),
  ...[
    "veo_3_1_i2v_s_fast_portrait_ultra_relaxed",
    "veo_3_1_i2v_s_fast_ultra_relaxed",
    "veo_3_1_r2v_fast_landscape_ultra_relaxed",
    "veo_3_1_r2v_fast_landscape_ultra_relaxed_8s",
    "veo_3_1_r2v_fast_portrait_ultra_relaxed",
    "veo_3_1_r2v_fast_portrait_ultra_relaxed_8s",
    "veo_3_1_r2v_fast_ultra_relaxed",
    "veo_3_1_r2v_fast_ultra_relaxed_8s",
    "veo_3_1_t2v_fast_portrait_ultra_relaxed",
    "veo_3_1_t2v_fast_ultra_relaxed"
  ].map((id) => [id, "video", true])
];

export const CATALOG_IDS = CATALOG.map(([id]) => id).sort();
export const CATALOG_META = Object.fromEntries(CATALOG.map(([id, kind, enabled]) => [id, { kind, label: "", enabled }]));

export const state = {  config: {
    baseUrl: "https://gank.velapi.cc/v1",
    apiKeyEnv: "VELAPI_API_KEY",
    keyMask: "63a••••4008",
    hasKey: true,
    defaultModel: "nano-banana-2.1",
    defaultSize: "1024x1024",
    defaultQuality: "LOW",
    defaultCount: 1,
    activeProviderId: "default"
  },
  providers: [
    {
      id: "default",
      name: "velapi · 默认",
      baseUrl: "https://gank.velapi.cc/v1",
      enabled: true,
      keyMask: "63a••••4008",
      usesRuntimeKey: true,
      models: CATALOG_IDS,
      modelMeta: CATALOG_META,
      note: "由 cordis.patch.yml 的 baseUrl / apiKeyEnv 驱动"
    },
    {
      id: "backup",
      name: "备用网关",
      baseUrl: "https://api.velapi.cc/v1",
      enabled: true,
      keyMask: "63a••••4008",
      usesRuntimeKey: false,
      models: ["nano-banana-2"],
      note: "限流时切换"
    }
  ],
  library: [
    asset("a1", "工作台线稿.jpg", 1024, 1024, "极简工作台 UI 线稿", "nano-banana-2.1", new Date(now - 6e5).toISOString()),
    asset("a2", "产品主图.jpg", 1024, 1024, "极简白色产品主图，柔和阴影", "nano-banana-pro", new Date(now - 3.6e6).toISOString()),
    asset("a3", "场景图.jpg", 1024, 1024, "窗边木质桌面上的产品场景图", "nano-banana-2.1", new Date(now - 7.2e6).toISOString()),
    asset("a4", "风格参考.jpg", 1024, 1024, "品牌风格参考，低饱和", "nano-banana-2", new Date(now - 1.1e7).toISOString()),
    asset("a5", "包装渲染.jpg", 1024, 1024, "包装盒 3D 渲染", "nano-banana-2.1", new Date(now - 1.5e7).toISOString()),
    asset("a6", "海报稿.jpg", 1024, 1024, "促销海报构图稿", "nano-banana-pro", new Date(now - 2.0e7).toISOString())
  ],
  notes: [
    {
      id: "n1",
      title: "产品主图规范",
      prompt: "纯白背景，中心构图，柔和顶光，产品占画面 70%，不要多余道具，4K 质感",
      meta: "尺寸 1024x1024 · 风格：简洁电商 · 场景：白底棚拍",
      tags: ["电商", "主图"],
      createdAt: new Date(now - 8.6e6).toISOString(),
      updatedAt: new Date(now - 8.6e6).toISOString()
    },
    {
      id: "n2",
      title: "工作台 UI 线稿",
      prompt: "极简工作台界面线稿：左侧竖排导航、中部对话与输入框、右侧三张信息卡片，圆角大、留白足、浅灰分割线",
      meta: "尺寸 1024x1024 · 风格：线框稿 · 场景：产品设计",
      tags: ["UI", "线稿"],
      createdAt: new Date(now - 5.2e6).toISOString(),
      updatedAt: new Date(now - 5.2e6).toISOString()
    }
  ],
  presets: [
    { id: "seed-product", title: "产品主图", prompt: "一张极简产品主图：纯白影棚背景，柔和顶光与淡淡投影，产品居中 45° 俯拍，杂志级商业摄影", image: presetShot("product-stand"), tags: ["电商", "白底", "商业"], builtin: true },
    { id: "seed-sticker", title: "爆炸贴纸", prompt: "一枚夸张的爆炸形贴纸：粗黑描边、高饱和撞色、卡通漫画风，白底居中，适合做表情包", image: presetShot("sticker-burst"), tags: ["贴纸", "趣味"], builtin: true },
    { id: "seed-pixel", title: "像素冒险", prompt: "16bit 像素风游戏画面：等距视角的小场景，复古色板、硬边像素、无抗锯齿", image: presetShot("pixel-quest"), tags: ["像素", "游戏"], builtin: true },
    { id: "seed-ink", title: "国风工笔", prompt: "国风工笔山水：宣纸暖底，淡墨远山与朱红落日，留白讲究，笔触细腻", image: presetShot("ink-landscape"), tags: ["国风", "插画"], builtin: true },
    { id: "seed-lineart", title: "工作台线稿", prompt: "极简工作台 UI 线稿：左侧导航、中间对话区、右侧信息卡片，细线条、无阴影、白底", image: "", tags: ["UI", "线稿"], builtin: true },
    { id: "p-custom", title: "我的像素头像", prompt: "把参考图变成 16bit 像素头像，保留原配色，硬边像素，正方形构图", image: preview, tags: ["头像", "像素"], builtin: false }
  ],
  jobs: [
    {
      id: "job_demo_1",
      status: "succeeded",
      mode: "generate",
      prompt: "极简工作台 UI 线稿：左侧导航、中间对话、右侧卡片，大圆角、浅灰分割线",
      model: "nano-banana-2.1",
      size: "1024x1024",
      quality: "LOW",
      count: 3,
      createdAt: new Date(now - 6e5).toISOString(),
      finishedAt: new Date(now - 5.6e5).toISOString(),
      images: sampleImages
    },
    {
      id: "job_demo_2",
      status: "running",
      mode: "generate",
      prompt: "把上一张改成夜晚灯光版本，保持构图",
      model: "nano-banana-pro",
      size: "1024x1024",
      quality: "HIGH",
      count: 1,
      createdAt: new Date(now - 9e4).toISOString(),
      images: []
    }
  ],
  pending: 1,
  draft: "再来一张同风格的产品场景图，背景换成浅灰",
  reference: preview ? { name: "工作台线稿.jpg", dataUrl: preview } : null,
  editMode: false,
  generating: true,
  pickOpen: false,
  ready: true
};

/** 预览里点任何东西都只打日志，不真的发请求。 */
export const actions = new Proxy(
  {},
  {
    get: (_target, key) => (...callArgs) => {
      if (process.env.VIG_QUIET !== "1") console.log(`  [preview] action.${String(key)}(${callArgs.length} args)`);
      return Promise.resolve({});
    }
  }
);

/* 上游报错的样例：照着真机上那次 502 抄下来的字段（中转站自己那句话 + 原始响应体）。
   界面上要摆的就是这些字段，预览和实跑必须同一套。 */
export const failedJob = {
  id: "job_demo_failed",
  status: "failed",
  mode: "generate",
  prompt: "生成一个小恐龙",
  model: "grok-imagen-image-2.0",
  size: "1024x1024",
  quality: "LOW",
  count: 1,
  createdAt: new Date(now - 4e5).toISOString(),
  finishedAt: new Date(now - 3.8e5).toISOString(),
  endpoint: "/images/generations",
  // 这次发出去时带着的参考图（真机上就是 /api/velapi-image-go/upload/<file>，预览里内联成 dataURL）
  referenceUrl: preview,
  images: [],
  error: "生成请求失败，请查看具体上游错误",
  errorCode: "upstream_502",
  errorDetail: {
    kind: "upstream",
    method: "POST",
    url: "https://gank.velapi.cc/v1/images/generations",
    status: 502,
    statusText: "Bad Gateway",
    code: "upstream_502",
    model: "grok-imagen-image-2.0",
    route: "/images/generations",
    body: JSON.stringify(
      {
        error: {
          message: "生成请求失败，请查看具体上游错误",
          type: "upstream_error",
          code: "bad_gateway",
          upstream: { status: 503, body: "model grok-imagen-image-2.0 is not available for this account" }
        }
      },
      null,
      2
    )
  }
};

/** 老任务：改动之前落盘的那种（只有一句话，没有原始证据）——界面上必须只占一行。 */
export const legacyFailedJob = {
  id: "job_demo_legacy",
  status: "failed",
  mode: "generate",
  prompt: "生成一个美女",
  model: "grok-imagen-image-2.0",
  size: "1024x1024",
  quality: "LOW",
  count: 1,
  createdAt: new Date(now - 6e5).toISOString(),
  finishedAt: new Date(now - 5.8e5).toISOString(),
  images: [],
  error: "生成请求失败，请查看具体上游错误",
  errorCode: "502"
};

/** 视频协议的样例：上游返回任务体（有 id 有 status，地址不一定有）。 */
export const videoJob = {
  id: "job_demo_video",
  status: "succeeded",
  mode: "generate",
  prompt: "一只在草地上奔跑的小恐龙，跟着镜头",
  model: "veo-3.1-flash",
  size: "1280x720",
  quality: "LOW",
  count: 1,
  createdAt: new Date(now - 2e5).toISOString(),
  finishedAt: new Date(now - 1.6e5).toISOString(),
  endpoint: "/videos/generations",
  images: [],
  error: "",
  video: {
    model: "veo-3.1-flash",
    prompt: "一只在草地上奔跑的小恐龙，跟着镜头",
    url: "https://cdn.example.com/velapi/demo-video.mp4",
    payload: { id: "vid_9f2c41", status: "processing", progress: 0.35, data: [{ url: "https://cdn.example.com/velapi/demo-video.mp4" }] }
  }
};

const NAV = [
  ["chat", "chat", "对话生图"],
  ["library", "grid", "图片管理"],
  ["notes", "note", "信息管理"],
  ["providers", "provider", "供应商管理"]
];

function nav(ui, active, compact) {
  return html(
    React.createElement(
      "nav",
      { className: "vig-nav vig-card" },
      NAV.map(([id, icon, label]) =>
        React.createElement(
          "button",
          { key: id, className: `vig-nav-item${id === active ? " is-on" : ""}` },
          React.createElement(ui.Icon, { name: icon, size: compact ? 14 : 16 }),
          label
        )
      ),
      // 竖栏在宽容器里会被拉满高度，底部这块填住空白（窄形态里藏起来）
      compact
        ? null
        : React.createElement(
            "div",
            { className: "vig-nav-foot" },
            [
              ["图库", "6"],
              ["信息", "2"],
              ["任务", "1"]
            ].map(([label, value]) =>
              React.createElement(
                "div",
                { key: label, className: "vig-nav-foot-row" },
                React.createElement("span", { className: "vig-label" }, label),
                React.createElement("span", { className: "vig-nav-foot-val" }, value)
              )
            )
          )
    )
  );
}

function head(ui, compact) {
  return html(
    React.createElement(
      "header",
      { className: "vig-head" },
      React.createElement(
        "span",
        { className: "vig-mark", style: compact ? { width: 26, height: 26, borderRadius: 9 } : undefined },
        React.createElement(ui.Icon, { name: "spark", size: compact ? 15 : 17 })
      ),
      React.createElement("span", { className: "vig-title" }, compact ? "生图工作台" : "API 对话生图工作台"),
      React.createElement("div", { className: "vig-spacer" })
      // 头部不放状态胶囊：状态各自只有一个归属地（密钥在工作区头部、
      // 供应商在检查器、模型在输入区、计数在侧栏底部）
    )
  );
}

export function viewMarkup(ui, view) {
  if (view === "chat") return html(React.createElement(ui.ChatView, { state, actions }));
  if (view === "library") return html(React.createElement(ui.LibraryView, { state, actions }));
  if (view === "notes") return html(React.createElement(ui.NotesView, { state, actions }));
  if (view === "providers") return html(React.createElement(ui.ProvidersView, { state, actions }));
  throw new Error(`unknown view ${view}`);
}

/**
 * 固定入口预览：宿主公开落点上的那颗按钮（左侧栏底部 / 输入框 dock）。
 * 按宿主自己那一列的排版摆出来 —— 看它是不是跟宿主的控件一家人（不用我们的 token）。
 */
export function launcherMarkup(ui) {
  const hostRow = (label) =>
    React.createElement(
      "div",
      { key: label, style: { display: "flex", alignItems: "center", gap: 8, padding: "2px 0" } },
      React.createElement(
        "button",
        {
          style: {
            display: "inline-flex",
            alignItems: "center",
            height: 28,
            padding: "0 8px",
            border: "1px solid transparent",
            borderRadius: 8,
            background: "transparent",
            color: "inherit",
            font: "inherit",
            fontSize: 12.5,
            cursor: "pointer"
          }
        },
        label
      )
    );
  return html(
    React.createElement(
      "div",
      { style: { display: "flex", gap: 16, padding: 16, alignItems: "flex-start" } },
      React.createElement(
        "div",
        {
          style: {
            width: 250,
            border: "1px solid #e5e7eb",
            borderRadius: 12,
            padding: 12,
            background: "#fff",
            display: "flex",
            flexDirection: "column",
            gap: 4
          }
        },
        React.createElement("div", { style: { fontSize: 12, opacity: 0.55, padding: "4px 0" } }, "宿主侧栏 · 底部（sidebar.footer.action）"),
        hostRow("设置"),
        hostRow("插件"),
        React.createElement("div", { style: { display: "flex", alignItems: "center", gap: 8, padding: "2px 0" } }, React.createElement(ui.WorkbenchLauncher, null))
      ),
      React.createElement(
        "div",
        {
          style: {
            flex: 1,
            minWidth: 300,
            border: "1px solid #e5e7eb",
            borderRadius: 12,
            padding: 12,
            background: "#fff",
            display: "flex",
            flexDirection: "column",
            gap: 10
          }
        },
        React.createElement("div", { style: { fontSize: 12, opacity: 0.55 } }, "宿主输入框 · dock（conversation.composer.dock）"),
        React.createElement(
          "div",
          { style: { border: "1px solid #e5e7eb", borderRadius: 12, padding: 10, minHeight: 60, color: "#9aa3af", fontSize: 13 } },
          "描述你想要生成的图片内容…"
        ),
        React.createElement("div", { style: { display: "flex", alignItems: "center", gap: 8 } }, React.createElement(ui.WorkbenchLauncher, null))
      )
    )
  );
}

/** 上游报错这条链的预览：有证据的失败（整张卡）与老任务（只一行），外加视频任务体。
 *  协议选择就在输入框那一行，所以这张图同时能看到它。 */
export function failedMarkup(ui, { video = false } = {}) {
  const jobs = video ? [videoJob, failedJob, legacyFailedJob] : [failedJob, legacyFailedJob];
  return html(React.createElement(ui.ChatView, { state: { ...state, jobs, pending: 0, generating: false, draft: "" }, actions }));
}

/** 提示条预览：窗口额头居中悬浮（一条成功 + 一条失败），下面摆参考图小卡与输入框。 */
export function toastMarkup(ui) {
  const chat = React.createElement(ui.ChatView, {
    state: {
      ...state,
      jobs: [],
      pending: 0,
      generating: false,
      draft: "",
      reference: { name: "粘贴的图片-2026-10-18T16-47-17.png", dataUrl: preview }
    },
    actions
  });
  return html(
    React.createElement(
      "div",
      { style: { position: "relative", minHeight: 460 } },
      chat,
      React.createElement(ui.ToastHost, {
        items: [
          { id: "t1", message: "已粘贴为参考图" },
          { id: "t2", message: "上游请求失败，请查看具体上游错误", tone: "err" }
        ]
      })
    )
  );
}

/** 模型选择器单独摆出来：默认态一个按钮，展开态按 图片/视频/对话 分组。
 * 卡片要给足高度——弹层是卡片内部的绝对定位元素，会被卡片的 overflow:hidden 裁掉。 */
export function pickerMarkup(ui, { open = false, value = "nano-banana-2.1", width = 0, all = false, height = 620 } = {}) {
  return html(
    React.createElement(
      "div",
      { className: "vig-main", style: { minHeight: height, ...(width ? { width } : {}) } },
      React.createElement(
        "div",
        { className: "vig-toolbar" },
        React.createElement(ui.Icon, { name: "chat" }),
        React.createElement("span", { className: "vig-item-title" }, "生成模型"),
        React.createElement(ui.ModelPicker, {
          value,
          models: CATALOG_IDS,
          meta: CATALOG_META,
          onChange: () => {},
          drop: "down",
          defaultOpen: open,
          allLabel: all ? "全部模型" : null
        })
      )
    )
  );
}

/** 预设卡单独摆出来：卡片墙，或叠上编辑器。宽度给足，卡片墙就是多列。 */
export function presetMarkup(ui, { dialog = false, width = 0, padding = 18 } = {}) {
  const board = React.createElement(
    "div",
    { className: "vig-main", style: { padding, ...(width ? { width } : {}) } },
    React.createElement(
      "div",
      { className: "vig-row" },
      React.createElement("span", { className: "vig-item-title" }, "预设卡"),
      React.createElement("div", { className: "vig-spacer" }),
      React.createElement("button", { className: "vig-btn is-primary" }, React.createElement(ui.Icon, { name: "plus" }), "新建预设")
    ),
    React.createElement(ui.PresetBoard, { presets: state.presets, onUse: () => {}, onEdit: () => {}, onDelete: () => {} })
  );
  const overlay = dialog
    ? React.createElement(ui.PresetDialog, {
        preset: state.presets[0],
        library: state.library,
        onClose: () => {},
        onSave: async () => true,
        onUpload: async () => ""
      })
    : null;
  return html(React.createElement("div", { style: { position: "relative", minHeight: dialog ? 620 : 420 } }, board, overlay));
}

/** 图片处理工具箱：喂一张静态图（真跑起来是 canvas），把选框画成 DOM 方便预览。 */
export function psMarkup(ui, { tool = "select", selection = null, scale = 1, dpi = 72, name = "ink-landscape.png", collapsed = false, keys = false, empty = false, ruler = null, warp = null, warpMode = "flat" } = {}) {
  const inner = React.createElement(ui.PsView, {
    state: { ...state, library: state.library.slice(0, 8) },
    actions: { attachReference: async () => {} },
    initial: empty ? null : { name, width: 256, height: 256, preview: presetShot("ink-landscape"), selection, tool, scale, dpi, collapsed, keys, ruler, warp, warpMode }
  });
  return html(inner);
}

export function wideMarkup(ui, mainView, withInspector = true) {
  const inspector = withInspector ? html(React.createElement(ui.Inspector, { state, actions })) : "";
  return `${head(ui, false)}<div class="vig-shell" style="min-height:0">${nav(ui, mainView, false)}<div class="vig-col" style="flex:1">${viewMarkup(
    ui,
    mainView
  )}</div>${inspector}</div>`;
}

export function narrowMarkup(ui, mainView) {
  return `${head(ui, true)}<div class="vig-shell">${nav(ui, mainView, true)}<div class="vig-col">${viewMarkup(ui, mainView)}</div>${html(
    React.createElement(ui.Inspector, { state, actions })
  )}</div>`;
}

/** 独立页面骨架：把工作台放进一个固定宽度的框里，方便截图与量尺寸。 */
export function page(title, inner, { width, compact = false, css = "", frame = {} } = {}) {
  const { padding = compact ? 10 : 14, minHeight = 820 } = frame;
  return `<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8"><title>${title}</title>
<style>
	html,body{margin:0;padding:0;background:#f3f4f6;font-family:"Segoe UI","Microsoft YaHei",system-ui,sans-serif;color:#1b1f27}
	.frame{width:${width}px;min-height:${minHeight}px;padding:${padding}px;box-sizing:border-box;display:flex}
	.frame>.vig-root{flex:1;min-height:0}
</style>
<style>${css}</style>
</head>
<body><div class="frame"><div class="vig-root"${compact ? ' data-compact="1"' : ""}>${inner}</div></div></body></html>`;
}
