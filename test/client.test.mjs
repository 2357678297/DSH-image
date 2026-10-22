// dsh-plugin-velapi-image-go —— 浏览器半边渲染测试
//
// client.js 是给 dsh 的 __ModuleLoader__ 用的自注册 bundle，不能直接 import。
// 这里把它放进 vm 上下文跑一遍，喂一个假的 window.__ModuleLoader__ 抓出
// factory，再用真的 React + renderToStaticMarkup 把工作台渲染成 HTML：
// 断言不是「文件里有这段字」而是「组件真的渲染出了这些节点」。
//
//   node test/client.test.mjs
//
// 环境变量：
//   VIG_REACT_ROOT  含 react / react-dom 的 node_modules（默认指向本机那套 19.2.8）

import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import vm from "node:vm";

const REACT_ROOT = process.env.VIG_REACT_ROOT || "G:/Gg-gank/frontend/deeix-chat/frontend/node_modules";
const nodeRequire = createRequire(path.join(REACT_ROOT, "anchor.cjs"));
const React = nodeRequire("react");
const { renderToStaticMarkup } = nodeRequire("react-dom/server");

const SOURCE = readFileSync(new URL("../client.js", import.meta.url), "utf8");

let failures = 0;
function check(name, ok, extra = "") {
  console.log(`${ok ? "  PASS" : "  FAIL"}  ${name}${extra ? ` — ${extra}` : ""}`);
  if (!ok) failures += 1;
}

/** 跑一遍 bundle，返回自注册记录与解析后的模块。 */
function boot(store = {}, env = {}) {
  const loaded = [];
  const fetchCalls = [];
  const sandbox = {
    console,
    setTimeout,
    clearTimeout,
    clearInterval,
    URL,
    fetch: async (url, init) => {
      fetchCalls.push({ url: String(url), init });
      return { ok: true, status: 200, text: async () => "{}" };
    },
    navigator: { clipboard: { writeText: async () => {} } },
    ...env
  };
  sandbox.window = {
    location: { origin: "http://127.0.0.1:19387" },
    localStorage: {
      getItem: (key) => (key in store ? store[key] : null),
      setItem: () => {}
    },
    __ModuleLoader__: { load: (record) => loaded.push(record) }
  };
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(SOURCE, sandbox, { filename: "client.js" });
  const record = loaded[0];
  if (!record) return { record: null };
  const module = record.factory((request) => {
    if (request === "react") return React;
    throw new Error(`client.js 只应该 require("react")，实际请求了 ${request}`);
  });
  return { record, module, sandbox, fetchCalls };
}

/**
 * 假画布：Node 里没有 document，图层 / 蒙版的合成（psMaskCanvas / psMaskedCanvas /
 * psLayerExport）全部要先 createElement("canvas")。这里给一张**会记账**的画布：
 * 每次 drawImage / putImageData 都按当时的 globalAlpha / globalCompositeOperation 记下来，
 * 断言就能直接问「谁在什么透明度、什么算子、铺到多大的框上」。
 */
function fakeCanvas(width = 300, height = 150) {
  const canvas = { width, height, __ctx: null };
  canvas.getContext = (kind) => {
    if (kind !== "2d") return null;
    if (canvas.__ctx) return canvas.__ctx;
    const stack = [];
    const ctx = {
      canvas,
      globalAlpha: 1,
      globalCompositeOperation: "source-over",
      imageSmoothingQuality: "low",
      // 几何算子（psRotate / psFlip / psStraighten）会调这些变换：假画布只需要记账，
      // 所以给空实现，让几何路径在 Node 里也能跑通
      translate() {},
      rotate() {},
      scale() {},
      setTransform() {},
      log: [],
      save() {
        stack.push({ alpha: ctx.globalAlpha, op: ctx.globalCompositeOperation });
        ctx.log.push({ kind: "save" });
      },
      restore() {
        const prev = stack.pop();
        if (prev) {
          ctx.globalAlpha = prev.alpha;
          ctx.globalCompositeOperation = prev.op;
        }
        ctx.log.push({ kind: "restore" });
      },
      drawImage(bitmap, x, y, w, h) {
        ctx.log.push({ kind: "draw", bitmap, box: [x, y, w, h].map((value) => (value === undefined ? null : value)), alpha: ctx.globalAlpha, op: ctx.globalCompositeOperation });
      },
      createImageData(dataWidth, dataHeight) {
        return { width: dataWidth, height: dataHeight, data: new Uint8ClampedArray(dataWidth * dataHeight * 4) };
      },
      // 逐像素变形（psWarpCanvas）要反查源图：假画布给一张全零的 ImageData 就够，
      // 断言看的是尺寸 / 记账 / 纯数组的蒙版覆盖率，不看底图像素。
      getImageData(x, y, dataWidth, dataHeight) {
        ctx.log.push({ kind: "get", box: [x, y, dataWidth, dataHeight], data: null });
        return { width: dataWidth, height: dataHeight, data: new Uint8ClampedArray(dataWidth * dataHeight * 4) };
      },
      putImageData(imageData, x, y) {
        ctx.log.push({ kind: "put", imageData, x, y });
      },
      clearRect() {},
      fillRect() {},
      beginPath() {},
      moveTo() {},
      lineTo() {},
      closePath() {},
      clip() {},
      rect() {},
      fill() {},
      stroke() {},
      setLineDash() {}
    };
    canvas.__ctx = ctx;
    return ctx;
  };
  canvas.toDataURL = (type) => `data:${type || "image/png"};base64,FAKE`;
  return canvas;
}

/** 只认 canvas 的假 document（给 boot 的 env 用，不影响其他测试）。 */
function fakeDocument() {
  return {
    createElement(tag) {
      if (String(tag) !== "canvas") throw new Error(`测试里的假 document 只支持 canvas，收到 ${tag}`);
      return fakeCanvas();
    }
  };
}

/** 画布上记到的 drawImage 记录。 */
function fakeDraws(canvas) {
  return (canvas?.__ctx?.log ?? []).filter((entry) => entry.kind === "draw");
}

/** psMaskCanvas 铺出来的 alpha 覆盖率（按像素顺序取 alpha 通道）。 */
function fakeMaskAlpha(canvas) {
  const put = (canvas?.__ctx?.log ?? []).find((entry) => entry.kind === "put");
  if (!put) return [];
  const data = put.imageData.data;
  const pixels = [];
  for (let index = 0; index < data.length; index += 4) pixels.push(data[index + 3]);
  return pixels;
}

/** 挂到假 ctx 上，按 surface 收回注册结果。 */
function mount(surfaces, store) {
  const { record, module, sandbox, fetchCalls } = boot(store);
  const slots = new Map();
  const effects = [];
  const tabDefs = [];
  const ctx = {
    effect: (fn) => {
      const disposer = fn();
      effects.push(disposer);
      return () => {
        if (typeof disposer === "function") disposer();
      };
    },
    get: (name) => {
      if (name === "sidebarRightTabs") {
        return {
          register: (definition) => {
            tabDefs.push(definition);
            return () => {};
          }
        };
      }
      if (name === "sidebarRight") return { openTab: () => {} };
      return null;
    },
    slots: {
      inject(name, registrar) {
        const registration = registrar();
        if (registration !== undefined) slots.set(name, registration);
      },
      register(options, component) {
        return { options, component };
      }
    }
  };
  module.apply(ctx, { surfaces });
  return { record, module, sandbox, slots, effects, tabDefs, fetchCalls };
}

/**
 * 冷启动竞态复现台：sidebarRightTabs 一开始还没有（ui-sidebar-right 要等
 * sessions/uiSession/locale/layout/resources/shortcuts 六个服务，比我们晚激活），
 * 只有 ctx.inject 能在它出现后回调。
 *
 * `guarded: true` 复现**新版 DSH** 的行为：cordis 的 ctx.get 在服务还没注册时不是返回
 * undefined，而是**抛**「cannot get property "xxx" without inject」。旧代码没接这个异常，
 * 整条 rightbar 登记就此中断 —— 重启后入口又不见了。这一档必须也走通。
 */
function mountWithoutTabs(surfaces = ["rightbar", "overlay", "settings"], options = {}) {
  const guarded = options.guarded === true;
  const { record, module, sandbox, fetchCalls } = boot();
  const slots = new Map();
  const tabDefs = [];
  const waiters = [];
  const service = {
    register: (definition) => {
      tabDefs.push(definition);
      return () => {};
    },
    guide: () => tabDefs.flatMap((definition) => (definition.guide ?? []).map((entry) => ({ ...entry, kind: definition.kind }))),
    get: (kind) => tabDefs.find((definition) => definition.kind === kind)
  };
  const makeScope = (hasTabs) => ({
    effect: (fn) => {
      const disposer = fn();
      return () => {
        if (typeof disposer === "function") disposer();
      };
    },
    get: (name) => {
      if (hasTabs && name === "sidebarRightTabs") return service;
      if (guarded) throw new Error(`cannot get property "${name}" without inject`);
      return null;
    },
    slots: {
      inject(name, registrar) {
        const registration = registrar();
        if (registration !== undefined) slots.set(name, registration);
      },
      register: (options, component) => ({ options, component })
    }
  });
  const ctx = {
    ...makeScope(false),
    inject(deps, callback) {
      waiters.push({ deps, callback });
      return () => {};
    }
  };
  module.apply(ctx, { surfaces });
  return { module, sandbox, slots, tabDefs, waiters, service, makeScope, fetchCalls, record };
}

function htmlFor(slots, name, view) {
  const registration = slots.get(name);
  if (!registration) return "";
  const element =
    view === undefined
      ? React.createElement(registration.component)
      : React.createElement(registration.component);
  return renderToStaticMarkup(element);
}

/* ---- 1. bundle 自注册形态 ---------------------------------------- */

const first = boot();
check("bundle 自注册到 __ModuleLoader__", first.record !== null);
check("注册 id 是包名", first.record?.id === "dsh-plugin-velapi-image-go", first.record?.id);
check("模块导出 name/inject/apply", first.module?.name === "velapi-image-go" && Array.isArray(first.module?.inject) && typeof first.module?.apply === "function", JSON.stringify(first.module?.inject));
check(
  "inject 静态声明右侧栏两个服务（和官方 ui-sidebar-browser 同一写法）",
  JSON.stringify(first.module?.inject) === '["slots","sidebarRightTabs","sidebarRight"]',
  JSON.stringify(first.module?.inject)
);
check("factory 只 require react", typeof first.record?.factory === "function");

/* ---- 2. 三个落点都注册 ------------------------------------------- */

const mounted = mount(["rightbar", "overlay", "settings"]);
check("注册了 sidebar.right.pane.tab", mounted.slots.has("sidebar.right.pane.tab"));
check("注册了 shell.overlay", mounted.slots.has("shell.overlay"));
check("注册了 settings.section", mounted.slots.has("settings.section"));
check("settings.section 的 id/order 合法", mounted.slots.get("settings.section")?.options?.id === "velapi-image-go" && mounted.slots.get("settings.section")?.options?.order === 30);
check("对外留了 window.__velapiImageGo 入口", typeof mounted.sandbox.window.__velapiImageGo?.openInRightbar === "function");
check(
  "落点注册结果挂在 window.__velapiImageGo 上（界面不见了能一行查出来）",
  mounted.sandbox.window.__velapiImageGo?.rightbarReady === true &&
    mounted.sandbox.window.__velapiImageGo?.overlayReady === true &&
    mounted.sandbox.window.__velapiImageGo?.settingsReady === true &&
    Array.isArray(mounted.sandbox.window.__velapiImageGo?.errors) &&
    mounted.sandbox.window.__velapiImageGo.errors.length === 0 &&
    typeof mounted.sandbox.window.__velapiImageGo?.paneState === "function"
);
check(
  "surfaces 可裁剪：只给 settings 时不碰侧栏",
  mount(["settings"], {}).slots.has("shell.overlay") === false
);

/* ---- 2b. 右侧栏 tab 类型的内部契约 -------------------------------- *
 * ui-sidebar-right 的 SidebarRightTabRegistry：register 要唯一 id，
 * priority 是档位字符串，面板/标题席位按 id 找，guide[] 才是「开始页」的卡片 */
const tabDef = mounted.tabDefs[0];
check("向 sidebarRightTabs 注册了类型", mounted.tabDefs.length === 1 && tabDef.kind === "velapi-image-go");
check("注册带唯一 id", tabDef?.id === "dsh-plugin-velapi-image-go", String(tabDef?.id));
check("priority 是档位字符串而非数字", tabDef?.priority === "extension", String(tabDef?.priority));
check("面板席位用注册 id 当 key", mounted.slots.get("sidebar.right.pane.tab")?.options?.key === "dsh-plugin-velapi-image-go");
check(
  "不重复注册标题席（宿主自己会渲染 tab 标题，重复注册会在右上角多出一个标题）",
  mounted.slots.has("sidebar.right.pane.tab.title") === false
);
check(
  "贡献「开始页」条目（右侧栏空白处的那个按钮）",
  Array.isArray(tabDef?.guide) &&
    tabDef.guide.length === 1 &&
    Number.isFinite(tabDef.guide[0].order) &&
    typeof tabDef.guide[0].icon === "function",
  JSON.stringify(tabDef?.guide?.map((entry) => ({ id: entry.id, order: entry.order })))
);
check(
  "条目的标题/描述是惰性文案且能取值",
  tabDef.guide[0].title() === "生图工作台" && tabDef.guide[0].description() === "对话生图 · 图库 · 供应商",
  `${tabDef.guide[0].title()} / ${tabDef.guide[0].description()}`
);
const guideIconMarkup = renderToStaticMarkup(React.createElement(tabDef.guide[0].icon, { size: 26 }));
check("条目图标能渲染成 svg（宿主的 EntryBox 会这么调）", guideIconMarkup.startsWith("<svg"), guideIconMarkup.slice(0, 40));
check("条目标题可渲染", tabDef.guide[0].title() === "生图工作台");

/* ---- 3. 真的渲染出界面 ------------------------------------------- */

const chat = htmlFor(mounted.slots, "settings.section");
check("渲染出工作台标题", chat.includes("API 对话生图工作台"));
for (const label of ["对话生图", "图片管理", "信息管理", "供应商管理"]) {
  check(`导航含「${label}」`, chat.includes(label));
}
check("渲染出空态提示", chat.includes("你可以通过对话描述需求，生成图片"));
check("渲染出输入占位符", chat.includes("描述你想要生成的图片内容"));
check(
  "渲染出右栏三张卡（图片 / 预设卡 / 供应商）",
  ["图片", "预设卡", "供应商"].every((title) => chat.includes(`vig-block-title">${title}<`)) && chat.includes("上传图片"),
  `blocks=${(chat.match(/vig-block-title">([^<]+)</g) ?? []).join(" ")}`
);
check("渲染出 0/500 计数器", chat.includes("0/500"));
check("渲染出发送按钮", chat.includes('class="vig-send"'));
check("注入样式表", chat.includes("--vig-r-card:18px") && chat.includes(".vig-root"));
check("没有渲染出 undefined", !/undefined/.test(chat), chat.match(/undefined/g)?.length + " 处");

const pane = htmlFor(mounted.slots, "sidebar.right.pane.tab");
check("右侧栏 tab 也能渲染", pane.includes("API 对话生图工作台") && pane.length > 500, `${pane.length} bytes`);

// 停靠面板默认展开：DSH 自更新会换端口 → origin 变 → localStorage 清空，
// 默认收起就等于「更新完插件不见了」。只有用户亲手存过 "0" 才收起。
const overlayDefault = mount(["overlay"], {});
const freshHtml = htmlFor(overlayDefault.slots, "shell.overlay");
check("新 origin 上停靠面板直接展开（更新后不会人间蒸发）", freshHtml.includes("vig-dock-body") && freshHtml.includes("vig-dock-grip"));

const overlayClosed = mount(["overlay"], { "dsh.velapi-image-go.dock.v2": "0" });
const closedHtml = htmlFor(overlayClosed.slots, "shell.overlay");
check("面板常驻：没有「收起」这一档，任何时候都在（用户要的就是固定）", closedHtml.includes("vig-dock-body") && closedHtml.includes("--vig-dock-w") && !closedHtml.includes("vig-dock-tab"));

const overlayOpen = mount(["overlay"], { "dsh.velapi-image-go.dock.v2": "1" });
const openHtml = htmlFor(overlayOpen.slots, "shell.overlay");
check(
  "面板带宽度拖拽把手（宽度记在 localStorage）",
  openHtml.includes("vig-dock-body") && openHtml.includes("vig-dock-grip") && openHtml.includes("--vig-dock-w"),
  `dock ${openHtml.length} bytes`
);

/* ---- 4. 其余三个视图都能渲染（初始 view 由 localStorage 决定）---- */

for (const [view, needle] of [
  ["library", "图库还是空的"],
  ["notes", "还没有信息记录"],
  ["providers", "运行期配置"]
]) {
  const viewMount = mount(["settings"], { "dsh.velapi-image-go.view": view });
  const html = htmlFor(viewMount.slots, "settings.section");
  check(`view=${view} 渲染成功`, html.includes(needle), `${html.length} bytes`);
}

{
  const viewMount = mount(["settings"], { "dsh.velapi-image-go.view": "providers" });
  const html = htmlFor(viewMount.slots, "settings.section");
  check("供应商页空态有话说", html.includes("还没有供应商"), `${html.length} bytes`);
  check("供应商页不再是 <table>", !html.includes("vig-table") && !html.includes("<table"));
  check(
    "运行期配置初值直接取配置（靠 effect 回填的话首帧是空输入框）",
    /useState\(\(\) => \(\{ baseUrl: state\.config\.baseUrl, apiKeyEnv: state\.config\.apiKeyEnv, dir: state\.config\.stateDir \|\| "", chatModel: state\.config\.chatModel \|\| "", contextTurns: state\.config\.contextTurns \?\? 6 \}\)\)/.test(SOURCE)
  );
}

/* ---- 4b. 模型列表：按前缀分类 + 按需展开 ------------------------- */
{
  const { module } = boot();
  const ui = module.__internals;  const MODEL_IDS = [
    "imagen-4.0-generate-preview-landscape",
    "imagen-4.0-generate-preview-portrait",
    "nano-banana-2",
    "nano-banana-2.1",
    "nano-banana-pro",
    "omni-flash",
    "veo-3.1-flash",
    "veo-3.1-lite",
    "veo-3.1-pro",
    "veo_3_1_extend",
    "veo_3_1_i2v_fast_landscape_ultra_relaxed",
    "veo_3_1_t2v_fast_ultra_relaxed_8s"
  ];

  const META = {
    // 中转站 `GET /v1/models` 里 image_family / video_family 的 kind —— 分类的权威来源
    "omni-flash": { kind: "video", enabled: true },
    "nano-banana-2.1": { kind: "image", enabled: true },
    "imagen-4.0-generate-preview-portrait": { kind: "image", enabled: false }
  };

  check("前缀归类：版本号/变体后缀都去掉", [
    ["nano-banana-2.1", "nano-banana"],
    ["nano-banana-pro", "nano-banana"],
    ["imagen-4.0-generate-preview-landscape", "imagen"],
    ["veo_3_1_i2v_fast_landscape_ultra_relaxed", "veo"],
    ["veo-3.1-flash", "veo"],
    ["omni-flash", "omni"]
  ].every(([id, family]) => ui.modelFamily(id) === family), ui.modelFamily("veo_3_1_t2v_fast_ultra_relaxed_8s"));

  check("能力归类跟着目录元数据走（omni-flash 是 video，不是对话）", ui.modelKind("omni-flash", META["omni-flash"]) === "video");
  check("元数据缺失时才靠名字兜底", ui.modelKind("omni-flash") === "video" && ui.modelKind("nano-banana-2") === "image" && ui.modelKind("whatever-9000") === "other");
  check("不再把不认识的模型硬说成对话", ui.modelKind("whatever-9000", { kind: "" }) === "other");
  check("能力归类：图片 / 视频 / 其它", [
    ["nano-banana-2.1", "image"],
    ["imagen-4.0-generate-preview-portrait", "image"],
    ["veo_3_1_extend", "video"],
    ["veo-3.1-pro", "video"],
    ["omni-flash", "video"]
  ].every(([id, kind]) => ui.modelKind(id, META[id]) === kind));

  const groups = ui.groupModels(MODEL_IDS, META);
  check("分组顺序是 图片 → 视频（没有凭空造出「对话」组）", groups.map((group) => group.kind).join(",") === "image,video", groups.map((g) => `${g.title}${g.count}`).join(" "));
  check("同能力内按前缀族聚合", groups[0].families.map((f) => f.family).join(",") === "nano-banana,imagen", groups[0].families.map((f) => `${f.family}(${f.models.length})`).join(" "));
  check(
    "族按条数多的排前面（veo 6 条在前，omni 单条在后）",
    groups[1].families.map((item) => `${item.family}(${item.models.length})`).join(",") === "veo(6),omni(1)",
    groups[1].families.map((item) => item.family).join(",")
  );
  check("未开通的排到族尾并带标记", (() => {
    const family = groups[0].families.find((item) => item.family === "imagen");
    return family.models[family.models.length - 1].enabled === false;
  })());

  const collapsed = renderToStaticMarkup(React.createElement(ui.ModelPicker, { value: "nano-banana-2.1", models: MODEL_IDS, meta: META, onChange: () => {} }));
  check("默认只渲染一个按钮，不预先铺开选项", collapsed.includes('class="vig-pick"') && !collapsed.includes("vig-pop") && !collapsed.includes("<option"), `${collapsed.length} bytes`);
  check("按钮上就是当前模型", /class="vig-pick-text">nano-banana-2\.1</.test(collapsed));

  const expanded = renderToStaticMarkup(React.createElement(ui.ModelPicker, { value: "nano-banana-2.1", models: MODEL_IDS, meta: META, onChange: () => {}, defaultOpen: true }));
  check("展开后有搜索框和总数", expanded.includes('class="vig-pop-search"') && expanded.includes(`class="vig-pop-count">${MODEL_IDS.length} 个`));
  for (const title of ["图片", "视频"]) check(`展开后有「${title}」分组`, expanded.includes(`class="vig-pop-group-head">${title}`));
  check("「对话」分组不会凭空出现", !expanded.includes('class="vig-pop-group-head">对话'));
  check("未开通的模型有 未开通 标记", expanded.includes('class="vig-tag">未开通'));
  check("展开后族头 + 模型项都在", expanded.includes("vig-pop-family-head") && expanded.includes('class="vig-pop-item is-on"'));
  check("展开态也只套在自己卡片里（不 portal 到 body）", !expanded.includes("createPortal") && expanded.includes('class="vig-pop is-up"'));

  const catalog = ui.modelCatalogFor([{ models: ["m1"], modelMeta: { m1: { kind: "image" } } }, { models: ["m2"], modelMeta: { m2: { kind: "video", enabled: false } } }], { defaultModel: "m3" });
  check("目录合并出模型 id 与元数据", catalog.models.join(",") === "m1,m2,m3" && catalog.meta.m2.enabled === false);

  /* 模型 → 供应商选路（踩过：gpt-image-2.5-c 被送到 grok 那条链，503 No available channel） */
  const PROVIDERS = [
    { id: "pv_grok", name: "grok", enabled: true, baseUrl: "https://api.velapi.cc/v1", models: ["grok-4.6", "grok-imagine-image"] },
    { id: "pv_gpt", name: "GPT", enabled: true, baseUrl: "https://gank.velapi.cc/v1", models: ["gpt-image-2.5-c"] }
  ];
  {
    const choose = ui.providerIdForModel;
    const CFG = { activeProviderId: "", defaultModel: "gpt-image-2.5-c" };
    check(
      "选路：模型属于 GPT 就算「当前供应商」还空着，也发给 GPT（不是列表里第一条）",
      choose(PROVIDERS, CFG) === "pv_gpt",
      choose(PROVIDERS, CFG)
    );
    check(
      "选路：当前供应商停在 grok，模型是 GPT 的 → 仍按模型发给 GPT",
      choose(PROVIDERS, { ...CFG, activeProviderId: "pv_grok" }) === "pv_gpt"
    );
    check(
      "选路：当前供应商停在 grok，模型是 grok 的 → 尊重当前供应商",
      choose(PROVIDERS, { ...CFG, activeProviderId: "pv_grok" }, "grok-4.6") === "pv_grok"
    );
    check(
      "选路：显式点名的供应商目录里没这个模型 → 换到有它的那条（老任务重试也走这条）",
      choose(PROVIDERS, { activeProviderId: "pv_gpt" }, "grok-imagine-image") === "pv_grok"
    );
    check(
      "选路：供应商还没拉过模型目录 → 不抢，仍用它的（空目录不该导致乱切）",
      choose([{ id: "pv_only", name: "only", enabled: true, models: [] }], { activeProviderId: "pv_only", defaultModel: "whatever" }) === "pv_only"
    );
    check("选路：一条供应商都没有 → 空串（请求回落运行期配置）", choose([], CFG) === "");
    check(
      "目录里带出模型归哪条供应商（下拉上标出来，选的时候就知道请求会打哪条链）",
      (() => {
        const merged = ui.modelCatalogFor(PROVIDERS, { defaultModel: "gpt-image-2.5-c" });
        return merged.owners["gpt-image-2.5-c"] === "GPT" && merged.owners["grok-4.6"] === "grok";
      })()
    );

    const hinted = renderToStaticMarkup(
      React.createElement(ui.ModelPicker, {
        value: "gpt-image-2.5-c",
        models: ["grok-4.6", "gpt-image-2.5-c"],
        hints: { "gpt-image-2.5-c": "GPT", "grok-4.6": "grok" },
        onChange: () => {},
        defaultOpen: true
      })
    );
    check(
      "模型下拉每条都标出所属供应商（GPT / grok）",
      hinted.includes('class="vig-tag">GPT<') && hinted.includes('class="vig-tag">grok<') && hinted.includes('title="gpt-image-2.5-c · GPT"'),
      hinted.slice(0, 200)
    );
  }
}

/* ---- 4c. 预设卡：标题 + 提示词 + 参考图，可编辑 -------------------- */

const ui = boot().module.__internals;

const PRESETS = [
  { id: "p1", title: "产品主图", prompt: "纯白影棚背景，产品居中 45° 俯拍，柔和顶光", image: "data:image/png;base64,AAAA", tags: ["电商", "白底"], builtin: true },
  { id: "p2", title: "爆炸贴纸", prompt: "粗黑描边、高饱和撞色、卡通漫画风", image: "/api/velapi-image-go/preset/sticker-burst.png", tags: ["趣味"], builtin: false },
  { id: "p3", title: "只有提示词", prompt: "极简工作台 UI 线稿", image: "", tags: [], builtin: false }
];

{
  const board = renderToStaticMarkup(React.createElement(ui.PresetBoard, { presets: PRESETS, onUse: () => {}, onEdit: () => {}, onDelete: () => {} }));
  check("预设卡一张一卡，参考图铺满封面", (board.match(/class="vig-preset-card"/g) || []).length === 3 && (board.match(/class="vig-preset-cover"/g) || []).length === 3);
  check("有参考图的渲染成 img", board.includes('src="data:image/png;base64,AAAA"') && board.includes('src="/api/velapi-image-go/preset/sticker-burst.png"'));
  check("没参考图的给占位而不是破图", (board.match(/vig-preset-blank/g) || []).length === 1 && !board.includes('src=""'));
  check("卡上有标题与提示词摘要", board.includes("产品主图") && board.includes("纯白影棚背景"));
  check("卡上有标签与内置标记", board.includes('class="vig-tag"') && board.includes(">内置<"));
  check(
    "卡上三个动作：用这张 / 编辑 / 删除",
    board.includes(">用这张<") && board.includes('aria-label="编辑"') && board.includes('aria-label="删除"')
  );
  check("动作按钮不会把文字挤成竖排", board.includes('class="vig-preset-foot"') && board.includes('class="vig-mini is-primary"'));
  check("删除按钮只放图标不放字", /aria-label="删除"><svg/.test(board));

  const empty = renderToStaticMarkup(React.createElement(ui.PresetBoard, { presets: [], onUse: () => {}, onEdit: () => {}, onDelete: () => {} }));
  check("空墙给引导文案", empty.includes("还没有预设卡") && empty.includes("vig-empty"));

  const dialog = renderToStaticMarkup(
    React.createElement(ui.PresetDialog, {
      preset: { id: "", title: "", prompt: "", image: "", tags: [] },
      library: [{ id: "a1", name: "工作台线稿.jpg", url: "data:image/png;base64,BBBB" }],
      onClose: () => {},
      onSave: async () => true,
      onUpload: async () => ""
    })
  );
  check("编辑器四个字段：参考图 / 标题 / 提示词 / 标签", (dialog.match(/class="vig-field"/g) || []).length === 4);
  check("参考图能上传、能从图库选、能移除", dialog.includes("上传参考图") && dialog.includes("从图库选") && dialog.includes("vig-preset-ref"));
  check("编辑器是模态且不 portal", dialog.includes("vig-modal-mask") && dialog.includes("vig-modal") && !dialog.includes("createPortal"));
  check("编辑器里没有裸的 undefined", !dialog.includes("undefined"));

  // 右侧栏的「信息」卡换成了预设卡：旧的信息 textarea 与「插入输入框」按钮都不该再出现
  const inspector = renderToStaticMarkup(React.createElement(ui.Inspector, { state: { config: { baseUrl: "https://gank.velapi.cc/v1" }, providers: [], library: [], presets: PRESETS, reference: null, references: [] }, actions: {} }));
  check("右侧栏有「预设卡」分组", inspector.includes(">预设卡<"));
  check("预设卡墙出现在右侧栏里", inspector.includes("vig-preset-grid"));
  check("旧的「信息」输入框与插入按钮已撤掉", !inspector.includes("请输入图片相关信息") && !inspector.includes(">插入输入框<"));
  check("有新建按钮和找回内置卡的按钮", inspector.includes(">新建预设<") && inspector.includes("vig-icon-btn"));

  /* 右侧检查器折叠：展开态右上角有「收起」，收起态只剩一条窄签「展开」 */
  {
    const inspectorState = { config: { baseUrl: "https://gank.velapi.cc/v1" }, providers: [], library: [], presets: PRESETS, reference: null, references: [] };
    const expanded = renderToStaticMarkup(
      React.createElement(ui.Inspector, { state: inspectorState, actions: {}, open: true, onToggle: () => {} })
    );
    const collapsed = renderToStaticMarkup(
      React.createElement(ui.Inspector, { state: inspectorState, actions: {}, open: false, onToggle: () => {} })
    );
    const plain = renderToStaticMarkup(React.createElement(ui.Inspector, { state: inspectorState, actions: {} }));
    check(
      "右侧检查器可折叠：展开态有「收起」按钮，收起态只剩一条窄签（点它展开）",
      expanded.includes('class="vig-side-head"') &&
        expanded.includes('title="收起右侧栏"') &&
        collapsed.includes('class="vig-side is-collapsed"') &&
        collapsed.includes('class="vig-side-open"') &&
        collapsed.includes('title="展开右侧栏"') &&
        collapsed.includes("图片 · 预设 · 供应商") &&
        !collapsed.includes("vig-preset-grid") &&
        !plain.includes("vig-side-head") &&
        /\.vig-side\.is-collapsed\{[^}]*width:34px/.test(SOURCE) &&
        /\.vig-side-open-label\{writing-mode:vertical-rl/.test(SOURCE)
    );
  }
}

/* ---- 4d. 图片处理工具箱：框选 / 裁切 / 切割 / 旋转 / 矫正 / 画布 / 羽化 ---- */

{
  const text = (key) => ui.text(key);
  const ids = ui.PS_TOOLS.map((item) => item.id);
  check(
    "工具箱动作齐全（框选 裁切 切割 旋转 矫正 透视矫正 画布 羽化 缩放 翻转 调整）",
    ids.length === 11 && ["select", "crop", "split", "rotate", "straighten", "warp", "canvasSize", "feather", "resize", "flip", "adjust"].every((id) => ids.includes(id)),
    ids.join(" ")
  );
  check("每个动作都有图标和中英文案", ui.PS_TOOLS.every((item) => item.icon && text(`ps.tool.${item.id}`) && text(`ps.tool.${item.id}`) !== `ps.tool.${item.id}`));
  check("左侧导航里有「图片处理」这一项", ["对话生图", "图片管理", "信息管理", "图片处理", "供应商管理"].every((label) => chat.includes(label)));
  // 只数 DOM 里的 class（CSS 里同名字符串也算「出现」，会把计数搅乱）
  check("导航项是五的倍数（每个落点各渲染一份）", (chat.match(/class="vig-nav-item/g) || []).length % 5 === 0, String((chat.match(/class="vig-nav-item/g) || []).length));

  const tiles = ui.psSplitTiles(120, 80, 3, 2);
  check("切割 3×2 = 6 块且面积铺满", tiles.length === 6 && tiles.reduce((sum, item) => sum + item.w * item.h, 0) === 120 * 80);
  check("非整除的边也铺满", (() => {
    const odd = ui.psSplitTiles(100, 70, 3, 2);
    const last = odd[odd.length - 1];
    return last.x + last.w === 100 && last.y + last.h === 70;
  })());
  check("画布锚点：se 对齐右下角", (() => {
    const at = ui.psAnchorOffset(120, 80, 200, 150, "se");
    return at.x === 80 && at.y === 70;
  })());
  check("选框反向拖也得到正矩形", ui.psRectFrom({ x: 90, y: 70 }, { x: 20, y: 10 }, 120, 80).w === 70);
  check("拖手柄 se 改右下角", (() => {
    const next = ui.psResizeRect({ x: 20, y: 20, w: 40, h: 40 }, "se", { x: 90, y: 90 }, 120, 80);
    return next.x === 20 && next.w === 70 && next.h === 60;
  })());
  check("手柄拖到退化也留 1px，不会把选区弄没", ui.psResizeRect({ x: 20, y: 20, w: 40, h: 40 }, "nw", { x: 60, y: 50 }, 120, 80).w === 1);
  check("矫正裁边保住取景比例", (() => {
    const fit = ui.psInscribedSize(200, 120, 5);
    return fit.w < 200 && Math.abs(fit.w / fit.h - 200 / 120) < 0.03;
  })());
  check("0° 矫正不裁", (() => {
    const fit = ui.psInscribedSize(200, 120, 0);
    return fit.w === 200 && fit.h === 120;
  })());
  check("八个手柄都在边框上（命中取最近的一个）", ui.psHandles({ x: 20, y: 20, w: 40, h: 60 }).length === 8 && ui.psHitHandle({ x: 20, y: 20, w: 40, h: 60 }, { x: 61, y: 81 }, 12) === "se");

  const emptyTool = renderToStaticMarkup(React.createElement(ui.PsView, { state: { library: [] }, actions: {} }));
  check("没图时给上传与图库两个入口", emptyTool.includes("先给一张图") && emptyTool.includes("上传本地图") && emptyTool.includes(">上传参考图<") && emptyTool.includes(">从图库选<"));
  check("没图时不渲染画布、也没有裸的 undefined", !emptyTool.includes("<canvas") && !emptyTool.includes("undefined"));
  check("空态里不出现 NaN 或空 src", !emptyTool.includes("NaN") && !emptyTool.includes('src=""'));

  const shot = renderToStaticMarkup(
    React.createElement(ui.PsView, {
      state: { library: [] },
      actions: {},
      initial: { name: "工作台线稿.png", width: 256, height: 256, preview: "data:image/png;base64,AAAA", selection: { x: 40, y: 52, w: 150, h: 112 }, tool: "select" }
    })
  );
  check(
    "左工具条十一个动作、右参数栏都在",
    (shot.match(/class="vig-ps-tool[" ]/g) || []).length === 11 && shot.includes("vig-ps-params") && shot.includes("vig-ps-stage"),
    `${(shot.match(/class="vig-ps-tool[" ]/g) || []).length} 个动作 / params:${shot.includes("vig-ps-params")} / stage:${shot.includes("vig-ps-stage")}`
  );
  check("参数栏显示当前动作与选区读数", shot.includes(">框选<") && shot.includes("40, 52 · 150 × 112"));
  check("带图时工具栏给出尺寸与出口", shot.includes("工作台线稿.png · 256×256") && shot.includes(">设为参考图<") && shot.includes(">下载<"));
  check("撤销 / 重做按钮存在且初始禁用", shot.includes('title="撤销"') && shot.includes('title="重做"') && (shot.match(/disabled=""/g) || []).length >= 2, String((shot.match(/disabled=""/g) || []).length));
  check("选框画出四边八手柄", shot.includes("vig-ps-marquee") && (shot.match(/<i style="left:/g) || []).length === 8);
  check("全选 / 取消选区 / 裁切都在参数栏", shot.includes(">全选<") && shot.includes(">取消选区<") && shot.includes(">裁切<"));

  const canvasPanel = renderToStaticMarkup(
    React.createElement(ui.PsView, {
      state: { library: [] },
      actions: {},
      initial: { name: "工作台线稿.png", width: 256, height: 256, preview: "data:image/png;base64,AAAA", tool: "canvasSize" }
    })
  );
  check("画布面板：宽高 + 九宫格锚点 + 空白色", canvasPanel.includes(">宽<") && canvasPanel.includes(">高<") && (canvasPanel.match(/class="vig-ps-anchor-btn/g) || []).length === 9 && canvasPanel.includes(">透明<"));
  check("画布面板没有裸的 NaN（初始宽高来自当前图）", !canvasPanel.includes("NaN") && canvasPanel.includes('value="256"'));

  const splitPanel = renderToStaticMarkup(
    React.createElement(ui.PsView, {
      state: { library: [] },
      actions: {},
      initial: { name: "图.png", width: 128, height: 128, preview: "data:image/png;base64,AAAA", tool: "split" }
    })
  );
  check("切割面板：列数 / 行数 / 切块", splitPanel.includes(">列数<") && splitPanel.includes(">行数<") && splitPanel.includes(">切块<"));

  const featherPanel = renderToStaticMarkup(
    React.createElement(ui.PsView, {
      state: { library: [] },
      actions: {},
      initial: { name: "图.png", width: 128, height: 128, preview: "data:image/png;base64,AAAA", tool: "feather" }
    })
  );
  check("羽化面板：半径滑杆 + 整张/选区两种目标", featherPanel.includes('class="vig-range"') && featherPanel.includes(">整张边缘<") && featherPanel.includes(">选区边缘<") && featherPanel.includes("12px"));

  const straightPanel = renderToStaticMarkup(
    React.createElement(ui.PsView, {
      state: { library: [] },
      actions: {},
      initial: { name: "图.png", width: 128, height: 128, preview: "data:image/png;base64,AAAA", tool: "straighten" }
    })
  );
  check("矫正面板：自动矫正 + 拖线引导（PS 的标尺那套，不再有滑杆）", straightPanel.includes(">自动矫正<") && straightPanel.includes("拖一条线") && !straightPanel.includes(">手动角度<"));

  /* 画布面板新增：单位口径 + 常用尺寸 + 分辨率 */
  check(
    "画布面板给出单位（像素 / 百分比）",
    canvasPanel.includes(">单位<") && canvasPanel.includes(">像素<") && canvasPanel.includes(">百分比<") && (canvasPanel.match(/vig-ps-seg-btn/g) || []).length === 2
  );
  check("画布面板给出常用尺寸五档", [">1:1<", ">4:3<", ">3:4<", ">16:9<", ">9:16<"].every((label) => canvasPanel.includes(label)));
  check(
    "画布面板给出分辨率：输入框 + 四档预设",
    canvasPanel.includes(">分辨率<") && (canvasPanel.match(/vig-ps-dpi-btn/g) || []).length === 4 && [">72<", ">96<", ">150<", ">300<"].every((preset) => canvasPanel.includes(preset))
  );
  check("分辨率默认 72 且写明写进导出头", canvasPanel.includes('value="72"') && canvasPanel.includes("写进导出的 PNG / JFIF 头"));
  check("工具栏显示当前分辨率", shot.includes("256×256 · 72 DPI"));

  /* 缩放条：比例读数 + 适应窗口 / 1:1 */
  check(
    "画布右下角有比例条（− 100% + 适应窗口 1:1）",
    shot.includes('class="vig-ps-zoom"') && shot.includes("vig-ps-zoom-val") && shot.includes(">100%<") && shot.includes(">适应窗口<") && shot.includes(">1:1<")
  );
  check("默认「适应窗口」是高亮态", /class="vig-ps-zoom-btn is-on">适应窗口</.test(shot));
  check("画布内容放在可滚动的框里（放大后能拖）", shot.includes("vig-ps-scroll") && shot.includes("vig-ps-marquee") && /class="vig-ps-shot" style="width:\d+px;height:\d+px"/.test(shot));

  const zoomed = renderToStaticMarkup(
    React.createElement(ui.PsView, {
      state: { library: [] },
      actions: {},
      initial: { name: "图.png", width: 128, height: 128, preview: "data:image/png;base64,AAAA", tool: "rotate", scale: 2 }
    })
  );
  check("放大到 200% 时比例条读数与画布尺寸都跟着变", zoomed.includes(">200%<") && /width:256px;height:256px/.test(zoomed), zoomed.match(/width:(\d+)px;height:(\d+)px/)?.[0] ?? "");
  check("放大后不再高亮「适应窗口」", !/class="vig-ps-zoom-btn is-on">适应窗口</.test(zoomed));
}

/* ---- 4e. 滚轮缩放 + 分辨率写出：纯函数先量准 --------------------- */

{
  const ui2 = boot().module.__internals;

  check(
    "叠加算法：7 种模式映射到画布原生的合成算子",
    ui2.PS_BLEND_MODES.map((mode) => mode.id).join(",") === "normal,multiply,screen,overlay,darken,lighten,add" &&
      ui2.psBlendOp("normal") === "source-over" &&
      ui2.psBlendOp("multiply") === "multiply" &&
      ui2.psBlendOp("add") === "lighter" &&
      ui2.psBlendOp("nope") === "source-over",
    ui2.PS_BLEND_MODES.map((mode) => `${mode.id}:${mode.op}`).join(" ")
  );
  check(
    "叠图：只画可见层，按各自的不透明度与算子（隐藏层跳过，不透明度夹在 0..1）",
    (() => {
      const calls = [];
      const ctx = {
        save: () => calls.push(["save"]),
        restore: () => calls.push(["restore"]),
        drawImage: (canvas) => calls.push(["draw", canvas.id, ctx.globalAlpha, ctx.globalCompositeOperation]),
        globalAlpha: 1,
        globalCompositeOperation: "source-over"
      };
      const drawn = ui2.psDrawLayers(
        ctx,
        [
          { id: "a", canvas: { id: "A" }, visible: true, mode: "multiply", opacity: 0.5 },
          { id: "b", canvas: { id: "B" }, visible: false, mode: "screen", opacity: 1 },
          { id: "c", canvas: { id: "C" }, mode: "add", opacity: 2 }
        ],
        100,
        100
      );
      const draws = calls.filter((call) => call[0] === "draw").map((call) => call.slice(1));
      return drawn === 2 && JSON.stringify(draws) === JSON.stringify([["A", 0.5, "multiply"], ["C", 1, "lighter"]]);
    })()
  );
  check(
    "图层上下移：越界不动，相邻真的换位置（不改原数组）",
    (() => {
      const list = [{ id: "a" }, { id: "b" }, { id: "c" }];
      return (
        ui2.psMoveLayer(list, 0, 1).map((item) => item.id).join("") === "bac" &&
        ui2.psMoveLayer(list, 0, -1).map((item) => item.id).join("") === "abc" &&
        ui2.psMoveLayer(list, 2, 1).map((item) => item.id).join("") === "abc" &&
        list.map((item) => item.id).join("") === "abc"
      );
    })()
  );

  /* ---- 曲线 / 色阶 / 自然饱和度 / 滤镜 ---------------------------- */
  check(
    "曲线：两点直线 + 端点拉到端点，恒等曲线不改任何值",
    (() => {
      const identity = ui2.psCurveLut([[0, 0], [255, 255]]);
      const dark = ui2.psCurveLut([[0, 0], [128, 64], [255, 255]]);
      return (
        identity[0] === 0 &&
        identity[128] === 128 &&
        identity[255] === 255 &&
        dark[128] === 64 &&
        dark[64] === 32 &&
        dark[192] === 160 &&
        // 少于两个点 / 空输入 → 恒等（宁可不改也不乱改）
        ui2.psCurveLut([])[200] === 200 &&
        ui2.psCurveLut([[10, 10]])[200] === 200
      );
    })()
  );
  check(
    "曲线预设：提亮抬中间调、压暗压中间调、S 曲线压暗部提亮部",
    (() => {
      const brighten = ui2.psCurveLut(ui2.psCurvePreset("brighten"));
      const darken = ui2.psCurveLut(ui2.psCurvePreset("darken"));
      const contrast = ui2.psCurveLut(ui2.psCurvePreset("contrast"));
      const invert = ui2.psCurveLut(ui2.psCurvePreset("invert"));
      return (
        brighten[128] > 128 &&
        darken[128] < 128 &&
        contrast[64] < 64 &&
        contrast[192] > 192 &&
        invert[0] === 255 &&
        invert[255] === 0 &&
        // 未知 id 回落恒等
        ui2.psCurveLut(ui2.psCurvePreset("whatever"))[128] === 128
      );
    })()
  );
  /* ---- 单层编辑会话：按 id 找层 / 把改完的画布写回这一层 ---- */
  check(
    "按 id 找图层：找到就返回，找不到/junk 输入都返回 null",
    (() => {
      const layers = [{ id: "a", canvas: { id: "A" } }, { id: "b", canvas: { id: "B" } }];
      return (
        ui2.psLayerById(layers, "b")?.canvas?.id === "B" &&
        ui2.psLayerById(layers, "zzz") === null &&
        ui2.psLayerById(null, "a") === null &&
        ui2.psLayerById([null, { id: "c" }], "c")?.id === "c"
      );
    })()
  );
  check(
    "写回图层：只换画布，蒙版/混合模式/不透明度/名字都保留（不动物件）",
    (() => {
      const mask = { canvas: { id: "M" }, alpha: new Uint8ClampedArray([255]) };
      const layers = [
        { id: "a", name: "底", canvas: { id: "A" }, mode: "multiply", opacity: 0.5, mask },
        { id: "b", name: "b", canvas: { id: "B" } }
      ];
      const next = ui2.psLayerCommit(layers, "a", { id: "A2", width: 40, height: 30 });
      const target = next.find((layer) => layer.id === "a");
      return (
        target.canvas.id === "A2" &&
        target.width === 40 &&
        target.height === 30 &&
        target.mask === mask &&
        target.mode === "multiply" &&
        target.opacity === 0.5 &&
        target.name === "底" &&
        next.find((layer) => layer.id === "b").canvas.id === "B" &&
        // 原数组不被改
        layers[0].canvas.id === "A"
      );
    })()
  );
  check(
    "变形模式的取图四点 = 原图四角（之前拖过别的也不认）；畸变/自由拉伸照用户框的来",
    (() => {
      const rotated = [{ x: 10, y: 12 }, { x: 150, y: 4 }, { x: 190, y: 90 }, { x: 6, y: 78 }];
      const distort = ui2.warpSrcQuad("distort", rotated, 200, 100);
      const flat = ui2.warpSrcQuad("flat", rotated, 200, 100);
      return (
        distort.map((p) => `${p.x},${p.y}`).join(" ") === "0,0 200,0 200,100 0,100" &&
        flat === rotated &&
        ui2.warpSrcQuad("distort", null, 200, 100).length === 4
      );
    })()
  );

  check(
    "历史条：过去的步骤 + 当前 + 未来的步骤，标签缺了就退回「第 N 步」",
    (() => {
      const history = {
        past: [{ label: "旋转" }, { label: "" }],
        future: [{ label: "裁切" }]
      };
      const rows = ui2.psHistorySteps(history, "当前");
      return (
        rows.length === 4 &&
        rows[0].kind === "past" && rows[0].label === "旋转" && rows[0].index === 0 &&
        rows[1].label === "第 2 步" &&
        rows[2].kind === "current" && rows[2].label === "当前" &&
        rows[3].kind === "future" && rows[3].label === "裁切"
      );
    })()
  );
  check(
    "历史条：空历史只有「当前」一步；currentLabel 缺省也不空",
    (() => {
      const empty = ui2.psHistorySteps({ past: [], future: [] }, "");
      const junk = ui2.psHistorySteps(null, "");
      return empty.length === 1 && empty[0].kind === "current" && empty[0].label === "当前" && junk.length === 1;
    })()
  );

  check(
    "写回的边界：id 不存在、画布为空都原样返回",
    (() => {
      const layers = [{ id: "a", canvas: { id: "A" } }];
      return (
        ui2.psLayerCommit(layers, "zzz", { id: "X" })[0].canvas.id === "A" &&
        ui2.psLayerCommit(layers, "a", null)[0].canvas.id === "A" &&
        ui2.psLayerCommit(null, "a", { id: "X" }).length === 0
      );
    })()
  );

  /* ---- 图层蒙版（alpha 覆盖率 + destination-in 合成） ---- */
  check(
    "蒙版覆盖率：没有选区整张可见，有选区只有框里可见，并且夹在图内",
    (() => {
      const full = ui2.psMaskAlpha(4, 3, null);
      const hit = ui2.psMaskAlpha(4, 3, { x: 1, y: 1, w: 2, h: 1 });
      const outside = ui2.psMaskAlpha(4, 3, { x: 10, y: 10, w: 5, h: 5 });
      const index = (x, y, width = 4) => y * width + x;
      return (
        full.length === 12 &&
        full.every((value) => value === 255) &&
        hit[index(0, 0)] === 0 &&
        hit[index(1, 1)] === 255 &&
        hit[index(2, 1)] === 255 &&
        hit[index(3, 1)] === 0 &&
        hit[index(1, 0)] === 0 &&
        outside.every((value) => value === 0)
      );
    })()
  );
  check(
    "蒙版反相：黑白互换，长度不变",
    (() => {
      const alpha = ui2.psMaskAlpha(3, 2, { x: 0, y: 0, w: 1, h: 1 });
      const inverted = ui2.psInvertAlpha(alpha);
      return (
        inverted.length === 6 &&
        inverted[0] === 0 &&
        inverted[1] === 255 &&
        inverted.every((value, index) => value === 255 - alpha[index])
      );
    })()
  );
  check(
    "叠图：有蒙版的层走 prepare（先裁再叠），没蒙版的直接画",
    (() => {
      const drawn = [];
      const ctx = {
        save() {},
        restore() {},
        drawImage: (bitmap) => drawn.push(bitmap.id),
        globalAlpha: 1,
        globalCompositeOperation: ""
      };
      const prepared = [];
      const count = ui2.psDrawLayers(
        ctx,
        [
          { id: "a", canvas: { id: "A" }, visible: true },
          { id: "b", canvas: { id: "B" }, visible: true, mask: { canvas: { id: "M" } } }
        ],
        10,
        10,
        (layer) => {
          prepared.push(layer.id);
          return { id: "masked-" + layer.id };
        }
      );
      return (
        count === 2 &&
        drawn.join(",") === "A,masked-b" &&
        prepared.join(",") === "b"
      );
    })()
  );

  /* ---- 图层 / 蒙版 / 单层编辑会话的边界 ----
   * 底图被裁过（图层尺寸和底图不一致）、蒙版空了 / alpha 长度对不上、没底图就点编辑、
   * 会话里导出……这些以前都不报错，只是默默画错。下面逐条钉死。 */
  {
    const ui3 = boot({}, { document: fakeDocument() }).module.__internals;

    check(
      "蒙版画布：空蒙版 / alpha 长度对不上一律按 0（藏起来）补，绝不补 255 把画布画白",
      (() => {
        const blank = ui3.psMaskCanvas(2, 2, new Uint8ClampedArray(0));
        const short = ui3.psMaskCanvas(2, 2, [255]);
        const junk = ui3.psMaskCanvas(2, 2, null);
        const normal = ui3.psMaskCanvas(2, 2, new Uint8ClampedArray([255, 0, 255, 0]));
        return (
          JSON.stringify(fakeMaskAlpha(blank)) === "[0,0,0,0]" &&
          JSON.stringify(fakeMaskAlpha(short)) === "[255,0,0,0]" &&
          JSON.stringify(fakeMaskAlpha(junk)) === "[0,0,0,0]" &&
          JSON.stringify(fakeMaskAlpha(normal)) === "[255,0,255,0]" &&
          blank.width === 2 && blank.height === 2 &&
          // 尺寸乱写（NaN / 负数）也不炸：至少 1×1
          ui3.psMaskCanvas(NaN, -3, null).width === 1
        );
      })()
    );

    check(
      "蒙版覆盖率：选区字段坏了（NaN / 缺字段）就一个像素都不放，宁可全藏也不写 255",
      (() => {
        const broken = ui3.psMaskAlpha(2, 2, { x: NaN, y: 0, w: 2, h: 2 });
        const missing = ui3.psMaskAlpha(2, 2, { w: 2, h: 2 });
        const full = ui3.psMaskAlpha(2, 1, null);
        const weirdSize = ui3.psMaskAlpha(NaN, 0, null);
        return (
          broken.every((value) => value === 0) &&
          missing.every((value) => value === 0) &&
          full.length === 2 && full.every((value) => value === 255) &&
          weirdSize.length === 1 && weirdSize[0] === 255
        );
      })()
    );

    check(
      "叠图对齐：图层 40×30 / 蒙版 100×100 / 底图 100×60 → 两笔都铺在同一个 0,0,100,60 框上（不各缩各的）",
      (() => {
        const layerCanvas = fakeCanvas(40, 30);
        const maskCanvas = fakeCanvas(100, 100);
        const framed = ui3.psMaskedCanvas(layerCanvas, maskCanvas, 100, 60);
        const draws = fakeDraws(framed);
        const own = ui3.psMaskedCanvas(layerCanvas, maskCanvas);
        return (
          framed.width === 100 && framed.height === 60 &&
          draws.length === 2 &&
          draws[0].bitmap === layerCanvas && draws[1].bitmap === maskCanvas &&
          draws[0].op === "source-over" && draws[1].op === "destination-in" &&
          JSON.stringify(draws[0].box) === "[0,0,100,60]" &&
          JSON.stringify(draws[1].box) === "[0,0,100,60]" &&
          // 不传目标框时退回图层自己的尺寸（老调用点行为不变）
          own.width === 40 && own.height === 30 &&
          // 蒙版没了 → null，调用方整层跳过，不能把图层原样当「没蒙版」交上去
          ui3.psMaskedCanvas(layerCanvas, null) === null
        );
      })()
    );

    check(
      "叠图组合：蒙版 + 不透明度 + 非 normal 混合模式一起生效，底图框传给合成器",
      (() => {
        const layerCanvas = fakeCanvas(20, 20);
        const maskCanvas = fakeCanvas(20, 20);
        const order = [];
        const ctx = {
          save: () => order.push(["save", ctx.globalAlpha, ctx.globalCompositeOperation]),
          restore: () => order.push(["restore"]),
          drawImage: (bitmap, x, y, w, h) => order.push(["draw", bitmap, ctx.globalAlpha, ctx.globalCompositeOperation, x, y, w, h]),
          globalAlpha: 1,
          globalCompositeOperation: "source-over"
        };
        const prepared = [];
        const count = ui3.psDrawLayers(
          ctx,
          [{ id: "m", canvas: layerCanvas, visible: true, mode: "multiply", opacity: 0.35, mask: { canvas: maskCanvas } }],
          64,
          48,
          (layer, width, height) => {
            prepared.push([layer.id, width, height]);
            return ui3.psMaskedCanvas(layer.canvas, layer.mask?.canvas, width, height);
          }
        );
        const draw = order.find((entry) => entry[0] === "draw");
        return (
          count === 1 &&
          JSON.stringify(prepared) === JSON.stringify([["m", 64, 48]]) &&
          order[0][0] === "save" &&
          order[order.length - 1][0] === "restore" &&
          Boolean(draw) &&
          draw[1] !== layerCanvas &&
          typeof draw[1]?.getContext === "function" &&
          draw[2] === 0.35 &&
          draw[3] === "multiply" &&
          JSON.stringify(draw.slice(4)) === "[0,0,64,48]"
        );
      })()
    );

    check(
      "蒙版层没有合成器就整层跳过（不拿图层的原样顶上去），合成器返回 null 也一样",
      (() => {
        const drawn = [];
        const ctx = { save() {}, restore() {}, drawImage: (bitmap) => drawn.push(bitmap), globalAlpha: 1, globalCompositeOperation: "source-over" };
        const noPrepare = ui3.psDrawLayers(ctx, [{ id: "m", canvas: fakeCanvas(10, 10), visible: true, mask: { canvas: fakeCanvas(10, 10) } }], 10, 10);
        const nullPrepare = ui3.psDrawLayers(ctx, [{ id: "m", canvas: fakeCanvas(10, 10), visible: true, mask: {} }], 10, 10, () => null);
        return noPrepare === 0 && nullPrepare === 0 && drawn.length === 0;
      })()
    );

    check(
      "导出合成图带蒙版 / 不透明度 / 混合模式（导出 = 屏幕上那张，不是「蒙版丢了」的版本）",
      (() => {
        const base = fakeCanvas(20, 20);
        const layerCanvas = fakeCanvas(20, 20);
        const maskCanvas = fakeCanvas(20, 20);
        const out = ui3.psLayerExport(base, [{ id: "a", canvas: layerCanvas, visible: true, mode: "screen", opacity: 0.6, mask: { canvas: maskCanvas } }], 20, 20);
        const draws = fakeDraws(out);
        return (
          out.width === 20 && out.height === 20 &&
          draws.length === 2 &&
          draws[0].bitmap === base &&
          draws[1].bitmap !== layerCanvas &&
          typeof draws[1].bitmap?.getContext === "function" &&
          draws[1].alpha === 0.6 &&
          draws[1].op === "screen" &&
          JSON.stringify(draws[1].box) === "[0,0,20,20]"
        );
      })()
    );

    check(
      "反转蒙版按蒙版自己的尺寸重铺（图层被裁成 40×30 后，100×60 的蒙版不会被挤错位）",
      (() => {
        const maskCanvas = fakeCanvas(100, 60);
        const layerCanvas = fakeCanvas(40, 30);
        const dims = ui3.psMaskDims({ canvas: maskCanvas }, layerCanvas);
        const fallback = ui3.psMaskDims(null, layerCanvas);
        const rebuilt = ui3.psMaskCanvas(dims.w, dims.h, ui3.psInvertAlpha(new Uint8ClampedArray(100 * 60)));
        return (
          dims.w === 100 && dims.h === 60 &&
          fallback.w === 40 && fallback.h === 30 &&
          JSON.stringify(ui3.psMaskDims({}, {})) === JSON.stringify({ w: 1, h: 1 }) &&
          rebuilt.width === 100 && rebuilt.height === 60
        );
      })()
    );

    check(
      "单层会话开不起来：没有底图 / 只有静态预览宽高 / 已经在会话里（连点两下）都返回 null",
      (() => {
        const layerCanvas = fakeCanvas(10, 10);
        const base = { name: "底图.png", canvas: fakeCanvas(20, 20) };
        const starting = ui3.psLayerSessionStart({ id: "a", name: "A", canvas: layerCanvas }, base, null);
        return (
          ui3.psLayerSessionStart({ id: "a", name: "A", canvas: layerCanvas }, null, null) === null &&
          ui3.psLayerSessionStart({ id: "a", name: "A", canvas: layerCanvas }, { name: "预览", width: 20, height: 20 }, null) === null &&
          ui3.psLayerSessionStart({ id: "a", name: "A", canvas: layerCanvas }, base, starting) === null &&
          ui3.psLayerSessionStart(null, base, null) === null &&
          ui3.psLayerSessionStart({ id: "a", name: "A" }, base, null) === null &&
          // 没 id 的层也不许进会话（不然退出时写回会落到「没 id 的层」上）
          ui3.psLayerSessionStart({ name: "A", canvas: layerCanvas }, base, null) === null &&
          ui3.psLayerSessionStart({ id: null, name: "A", canvas: layerCanvas }, base, null) === null &&
          Boolean(starting) &&
          starting.id === "a" && starting.name === "A" && starting.base === base
        );
      })()
    );

    check(
      "退出会话：只换这一层的画布（蒙版 / 混合模式 / 不透明度留着），没 stage 只还原底图",
      (() => {
        const base = { name: "底图.png", canvas: fakeCanvas(20, 20) };
        const layerCanvas = fakeCanvas(20, 20);
        const edited = fakeCanvas(20, 12);
        const mask = { canvas: fakeCanvas(20, 20), alpha: new Uint8ClampedArray(400) };
        const layers = [{ id: "a", name: "A", canvas: layerCanvas, mask, mode: "screen", opacity: 0.5 }];
        const session = { id: "a", name: "A", base };
        const kept = ui3.psLayerSessionExit(session, layers, edited);
        const dropped = ui3.psLayerSessionExit(session, layers, null);
        const deleted = ui3.psLayerSessionExit(session, [], edited);
        return (
          ui3.psLayerSessionExit(null, layers, edited) === null &&
          kept.committed === true &&
          kept.base === base &&
          kept.layers[0].canvas === edited &&
          kept.layers[0].width === 20 && kept.layers[0].height === 12 &&
          kept.layers[0].mask === mask &&
          kept.layers[0].mode === "screen" &&
          kept.layers[0].opacity === 0.5 &&
          kept.layers[0].name === "A" &&
          // 原数组不被改
          layers[0].canvas === layerCanvas &&
          dropped.committed === false &&
          dropped.layers[0].canvas === layerCanvas &&
          dropped.base === base &&
          deleted.committed === true && deleted.layers.length === 0 &&
          // 会话没底图（老数据）时 base 为 null，调用方就不会去「还原」一个空底图
          ui3.psLayerSessionExit({ id: "a", base: null }, layers, edited).base === null
        );
      })()
    );

    check(
      "单层会话里画布只叠这一层：其它层不上画布、这一层也不叠自己（编辑时看到的就是会话内容）",
      (() => {
        const layers = [{ id: "a", canvas: fakeCanvas(10, 10) }, { id: "b", canvas: fakeCanvas(10, 10) }];
        return (
          ui3.psCanvasLayers(layers, false) === layers &&
          JSON.stringify(ui3.psCanvasLayers(layers, true)) === "[]" &&
          JSON.stringify(ui3.psCanvasLayers(null, false)) === "[]"
        );
      })()
    );

    check(
      "单层会话里「下载 / 设为参考图」导出的是会话内容（不是底图，也不再叠一遍所有图层）",
      (() => {
        const base = fakeCanvas(20, 20);
        const sessionCanvas = fakeCanvas(40, 30);
        const layers = [{ id: "a", canvas: sessionCanvas, visible: true }];
        const inSession = ui3.psExportComposite(sessionCanvas, layers, true);
        const composited = ui3.psExportComposite(base, layers, false);
        const noLayer = ui3.psExportComposite(base, [], false);
        return (
          ui3.psExportComposite(null, layers, true) === null &&
          inSession === sessionCanvas &&
          noLayer === base &&
          composited !== base &&
          composited.width === 20 && composited.height === 20 &&
          fakeDraws(composited).length === 2
        );
      })()
    );

    check(
      "行内控件（眼睛 / 混合模式 / 不透明度 / 蒙版 / 上下移 / 删除）不会触发「编辑这一层」",
      ui3.psLayerRowActivate({ target: { tagName: "BUTTON" } }) === false &&
        ui3.psLayerRowActivate({ target: { tagName: "button" } }) === false &&
        ui3.psLayerRowActivate({ target: { tagName: "SELECT" } }) === false &&
        ui3.psLayerRowActivate({ target: { tagName: "option" } }) === false &&
        ui3.psLayerRowActivate({ target: { tagName: "INPUT" } }) === false &&
        ui3.psLayerRowActivate({ target: { tagName: "SPAN" } }) === true &&
        ui3.psLayerRowActivate({ target: { tagName: "DIV" } }) === true &&
        ui3.psLayerRowActivate(undefined) === true
    );

    check(
      "按 id 找图层：id 是 null / undefined 一律 null（不会把写回塞给没 id 的层）",
      ui3.psLayerById([{ id: null, canvas: {} }], null) === null &&
        ui3.psLayerById([{ canvas: {} }], undefined) === null &&
        ui3.psLayerById([{ id: "a", canvas: {} }], "a")?.id === "a" &&
        // 写回同理：id 不像话时原样返回，不动任何一层
        ui3.psLayerCommit([{ id: "a", canvas: { id: "A" } }], undefined, { width: 1, height: 1 })[0].canvas.id === "A" &&
        ui3.psLayerCommit([{ id: "a", canvas: { id: "A" } }], null, { width: 1, height: 1 })[0].canvas.id === "A"
    );

    /* ---- 底图几何 → 图层 / 蒙版联动（裁切 / 旋转 / 改画布 / 缩放 / 翻转 / 拉直） ---- */

    check(
      "底图裁切 → 图层画布和蒙版一起裁（尺寸不一致的图层先按底图重铺，不裁掉内容）",
      (() => {
        const maskAlpha = ui3.psMaskAlpha(100, 80, { x: 0, y: 0, w: 40, h: 80 });
        const layers = [
          { id: "a", canvas: fakeCanvas(100, 80), mask: { canvas: fakeCanvas(100, 80), alpha: maskAlpha }, mode: "screen", opacity: 0.5 },
          { id: "b", canvas: fakeCanvas(50, 40) }
        ];
        const out = ui3.psTransformLayers(layers, { kind: "crop", rect: { x: 10, y: 5, w: 40, h: 30 }, width: 100, height: 80 });
        const mask = out[0].mask;
        const pixels = fakeMaskAlpha(mask.canvas);
        return (
          out !== layers &&
          out.length === 2 &&
          out[0].canvas.width === 40 && out[0].canvas.height === 30 &&
          out[0].width === 40 && out[0].height === 30 &&
          // 蒙版换了对象、画布按选区尺寸重铺、alpha 长度跟着重算
          mask !== layers[0].mask &&
          mask.canvas.width === 40 && mask.canvas.height === 30 &&
          // mask.alpha 是 vm 里另建的一个 realm 的 Uint8ClampedArray，跨 realm 只能看内置标签
          Object.prototype.toString.call(mask.alpha) === "[object Uint8ClampedArray]" && mask.alpha.length === 40 * 30 &&
          // 原选区 x<40：裁掉左边 10px 后只剩 30 列是 255，右边 10 列变 0
          pixels.length === 40 * 30 && pixels[0] === 255 && pixels[29] === 255 && pixels[30] === 0 &&
          // 图层 50×40 和底图 100×80 不一致，也先重铺再裁，输出照样是选区大小
          out[1].canvas.width === 40 && out[1].canvas.height === 30 &&
          // 原图层一个都没被改
          layers[0].canvas.width === 100 && layers[0].mask.canvas.width === 100 && layers[1].canvas.width === 50 &&
          layers[0].mask.alpha === maskAlpha
        );
      })()
    );

    check(
      "底图旋转 → 图层画布跟着转、蒙版 alpha 跟着转（长度 = 旋转后尺寸）",
      (() => {
        const alpha = ui3.psMaskAlpha(10, 10, { x: 0, y: 0, w: 10, h: 5 }); // 上半亮
        const rotated = ui3.psTransformAlpha(alpha, 10, 10, { kind: "rotate", angle: 90 });
        const at = (list, width, x, y) => list[y * width + x];
        const layer = { id: "r", canvas: fakeCanvas(10, 10), mask: { canvas: fakeCanvas(10, 10), alpha } };
        const out = ui3.psTransformLayers([layer], { kind: "rotate", angle: 90, width: 10, height: 10 });
        const pixels = fakeMaskAlpha(out[0].mask.canvas);
        return (
          rotated.width === 10 && rotated.height === 10 && rotated.alpha.length === 100 &&
          // 顺时针 90°：上面的亮区转到右边
          at(rotated.alpha, 10, 8, 5) === 255 && at(rotated.alpha, 10, 2, 5) === 0 &&
          out[0].canvas.width === 10 && out[0].canvas.height === 10 &&
          out[0].mask.alpha.length === 100 &&
          pixels.length === 100 && pixels[5 * 10 + 8] === 255 && pixels[5 * 10 + 2] === 0 &&
          layer.mask.alpha === alpha // 入参没被改
        );
      })()
    );

    check(
      "底图改画布 → 图层按锚点重铺、蒙版新区域透明（alpha 长度重算成新尺寸）",
      (() => {
        const layers = [
          { id: "c", canvas: fakeCanvas(100, 80), mask: { canvas: fakeCanvas(100, 80), alpha: ui3.psMaskAlpha(100, 80, null) } }
        ];
        const out = ui3.psTransformLayers(layers, { kind: "canvasSize", w: 120, h: 90, anchor: "nw", width: 100, height: 80 });
        const pixels = fakeMaskAlpha(out[0].mask.canvas);
        const draws = fakeDraws(out[0].canvas);
        return (
          out[0].canvas.width === 120 && out[0].canvas.height === 90 &&
          out[0].mask.canvas.width === 120 && out[0].mask.canvas.height === 90 &&
          out[0].mask.alpha.length === 120 * 90 &&
          pixels.length === 120 * 90 &&
          // 锚点 nw：老内容留在左上，右侧 / 下方新区域是透明的
          pixels[0] === 255 && pixels[119] === 0 && pixels[89 * 120] === 0 &&
          // 图层只把老内容贴在左上角（底色不重复铺到图层上）
          draws.length === 1 && JSON.stringify(draws[0].box) === "[0,0,null,null]"
        );
      })()
    );

    check(
      "底图缩放 → 图层同比例重采样、蒙版 alpha 长度跟着变（内容不丢）",
      (() => {
        const layers = [{ id: "s", canvas: fakeCanvas(100, 80), mask: { canvas: fakeCanvas(100, 80), alpha: ui3.psMaskAlpha(100, 80, null) } }];
        const out = ui3.psTransformLayers(layers, { kind: "resize", w: 50, h: 40, width: 100, height: 80 });
        const pixels = fakeMaskAlpha(out[0].mask.canvas);
        return (
          out[0].canvas.width === 50 && out[0].canvas.height === 40 &&
          out[0].mask.canvas.width === 50 && out[0].mask.canvas.height === 40 &&
          out[0].mask.alpha.length === 50 * 40 &&
          pixels.length === 2000 && pixels.every((value) => value === 255)
        );
      })()
    );

    check(
      "底图翻转 → 图层画布同向翻转、蒙版 alpha 一起镜像（尺寸不变）",
      (() => {
        const alpha = ui3.psMaskAlpha(10, 10, { x: 0, y: 0, w: 5, h: 10 }); // 左半亮
        const layer = { id: "f", canvas: fakeCanvas(10, 10), mask: { canvas: fakeCanvas(10, 10), alpha } };
        const flipped = ui3.psTransformLayers([layer], { kind: "flip", axis: "h", width: 10, height: 10 })[0];
        const pixels = fakeMaskAlpha(flipped.mask.canvas);
        const vertical = ui3.psTransformLayers([layer], { kind: "flip", axis: "v", width: 10, height: 10 })[0];
        return (
          flipped.canvas.width === 10 && flipped.canvas.height === 10 &&
          flipped.mask.alpha.length === 100 &&
          pixels.length === 100 && pixels[0] === 0 && pixels[9] === 255 &&
          // 垂直翻转不左右翻：左半还是亮的
          vertical.mask.alpha[0] === 255 && vertical.canvas.height === 10
        );
      })()
    );

    check(
      "拉直（旋转 + 裁内接框）后图层尺寸和底图像素一致",
      (() => {
        const base = fakeCanvas(100, 80);
        const layers = [{ id: "a", canvas: fakeCanvas(100, 80), mask: { canvas: fakeCanvas(100, 80), alpha: ui3.psMaskAlpha(100, 80, null) } }];
        const geometry = ui3.psStraightenGeometry(100, 80, 7);
        const out = ui3.psTransformLayers(layers, geometry.map((step) => ({ ...step, width: 100, height: 80 })));
        const straightened = ui3.psStraighten(base, 7);
        const rotated = ui3.psRotate(base, 7);
        const rotateDims = ui3.psGeometryDims(geometry[0], 100, 80);
        return (
          geometry.length === 2 && geometry[0].kind === "rotate" && geometry[1].kind === "crop" &&
          out[0].canvas.width === straightened.width && out[0].canvas.height === straightened.height &&
          out[0].mask.alpha.length === straightened.width * straightened.height &&
          rotateDims.w === rotated.width && rotateDims.h === rotated.height
        );
      })()
    );

    /* ---- 撤销 / 重做快照带图层与会话 ---- */

    check(
      "撤销能回到变换前：快照带 layers / layerSession，裁切后撤销回到底图 + 图层原样",
      (() => {
        const base = fakeCanvas(100, 80);
        const layers = [
          { id: "a", canvas: fakeCanvas(100, 80), mask: { canvas: fakeCanvas(100, 80), alpha: ui3.psMaskAlpha(100, 80, null) } },
          { id: "b", canvas: fakeCanvas(60, 40), visible: false }
        ];
        const session = { id: "b", name: "B", base: { name: "底图.png", canvas: base } };
        const before = ui3.psHistorySnapshot({ name: "底图.png", canvas: base }, layers, session);
        const cropped = ui3.psTransformLayers(layers, { kind: "crop", rect: { x: 5, y: 5, w: 50, h: 40 }, width: 100, height: 80 });
        const nextBase = fakeCanvas(50, 40);
        const after = ui3.psHistorySnapshot({ name: "底图.png", canvas: nextBase }, cropped, null);
        const undone = ui3.psHistoryRestore(before, { layers: cropped, layerSession: null });
        const redone = ui3.psHistoryRestore(after, { layers, layerSession: session });
        return (
          before.canvas === base && before.layers.length === 2 && before.layerSession === session &&
          after.canvas === nextBase && after.layers[0].canvas.width === 50 &&
          undone !== null &&
          undone.canvas === base && undone.width === 100 && undone.height === 80 &&
          undone.layers.length === 2 &&
          undone.layers[0].canvas === layers[0].canvas &&
          undone.layers[0].mask === layers[0].mask &&
          undone.layerSession === session &&
          redone.canvas === nextBase && redone.layers[0].canvas === cropped[0].canvas && redone.layerSession === null
        );
      })()
    );

    check(
      "旧快照（上一版只存过 canvas）容错：撤销不清空图层、也不丢当前会话",
      (() => {
        const old = { name: "老图.png", canvas: fakeCanvas(20, 10) };
        const layers = [{ id: "a", canvas: fakeCanvas(20, 10) }];
        const session = { id: "a", name: "A", base: { name: "底图.png", canvas: fakeCanvas(20, 10) } };
        const restored = ui3.psHistoryRestore(old, { layers, layerSession: session });
        return (
          restored.name === "老图.png" && restored.canvas === old.canvas &&
          restored.width === 20 && restored.height === 10 &&
          restored.layers === layers && restored.layerSession === session &&
          ui3.psHistoryRestore(null, { layers }) === null &&
          ui3.psHistoryRestore({ name: "没有画布" }, { layers }) === null &&
          // 当前状态也没有图层时不炸：给空数组
          JSON.stringify(ui3.psHistoryRestore(old, null).layers) === "[]"
        );
      })()
    );

    check(
      "没有图层时几何变换保持原行为：图层函数原样返回、快照只多两个空字段",
      (() => {
        const empty = [];
        const untouched = ui3.psTransformLayers(empty, { kind: "crop", rect: { x: 0, y: 0, w: 5, h: 5 }, width: 10, height: 10 });
        const snapshot = ui3.psHistorySnapshot({ name: "图.png", canvas: fakeCanvas(10, 10) }, empty, null);
        return (
          untouched === empty &&
          ui3.psTransformLayers(null, { kind: "rotate", angle: 90 }).length === 0 &&
          // 不认识的 kind / 没 op 不动图层
          ui3.psTransformLayers([{ id: "a", canvas: fakeCanvas(5, 5) }], { kind: "feather" })[0].canvas.width === 5 &&
          ui3.psTransformLayers([{ id: "a", canvas: fakeCanvas(5, 5) }], null)[0].canvas.width === 5 &&
          snapshot.layers.length === 0 && snapshot.layerSession === null &&
          snapshot.canvas.width === 10
        );
      })()
    );

    /* ---- 四点透视（warp）也接进几何联动 ---- */

    const warpQuad = (pad) => [{ x: pad, y: pad }, { x: 256 - pad, y: pad }, { x: 256 - pad, y: 256 - pad }, { x: pad, y: 256 - pad }];
    const warpPlanFlat = () => ui3.psWarpPlan({ mode: "flat", src: warpQuad(16), width: 256, height: 256 });

    check(
      "透视落定 → 图层画布和蒙版按同一份 plan 变形（尺寸 = plan 输出、alpha 长度对、亮区跟着走）",
      (() => {
        const plan = warpPlanFlat();
        const alpha = ui3.psMaskAlpha(256, 256, { x: 0, y: 0, w: 128, h: 256 }); // 左半亮
        const layers = [
          { id: "w", canvas: fakeCanvas(256, 256), mask: { canvas: fakeCanvas(256, 256), alpha }, mode: "screen", opacity: 0.5 },
          { id: "plain", canvas: fakeCanvas(256, 256) }
        ];
        const out = ui3.psTransformLayers(layers, { kind: "warp", plan, width: 256, height: 256 });
        const mask = out[0].mask;
        const pixels = fakeMaskAlpha(mask.canvas);
        const size = plan?.size ?? { w: 0, h: 0 };
        const at = (list, width, x, y) => list[y * width + x];
        return (
          // 取图四点内缩 16、flat 输出就是 224 × 224
          plan !== null && size.w === 224 && size.h === 224 &&
          out !== layers && out.length === 2 &&
          // 图层画布 = plan 的输出尺寸
          out[0].canvas.width === size.w && out[0].canvas.height === size.h &&
          out[0].width === size.w && out[0].height === size.h &&
          // 蒙版画布 / alpha 一起换尺寸，长度 = 新尺寸
          mask !== layers[0].mask &&
          mask.canvas.width === size.w && mask.canvas.height === size.h &&
          Object.prototype.toString.call(mask.alpha) === "[object Uint8ClampedArray]" &&
          mask.alpha.length === size.w * size.h &&
          pixels.length === size.w * size.h &&
          // 输出 (x,y) 反查到源 (x+16,y+16)：左半亮区跟着过去，右半还是 0
          at(mask.alpha, size.w, 100, 100) === 255 && at(mask.alpha, size.w, 200, 100) === 0 &&
          pixels[100 * size.w + 100] === 255 && pixels[100 * size.w + 200] === 0 &&
          // 没蒙版的图层也照样变形；原图层一个都没被改
          out[1].canvas.width === size.w && out[1].canvas.height === size.h &&
          layers[0].canvas.width === 256 && layers[0].mask.canvas.width === 256 &&
          layers[0].mask.alpha === alpha
        );
      })()
    );

    check(
      "透视前先把尺寸不一致的图层按底图重铺再变形（内容不裁、输出仍是 plan 尺寸）",
      (() => {
        const plan = warpPlanFlat();
        const layers = [{ id: "small", canvas: fakeCanvas(128, 128), mask: { canvas: fakeCanvas(128, 128), alpha: ui3.psMaskAlpha(128, 128, null) } }];
        const out = ui3.psTransformLayers(layers, { kind: "warp", plan, width: 256, height: 256 });
        const pixels = fakeMaskAlpha(out[0].mask.canvas);
        return (
          out[0].canvas.width === 224 && out[0].canvas.height === 224 &&
          out[0].mask.canvas.width === 224 && out[0].mask.canvas.height === 224 &&
          out[0].mask.alpha.length === 224 * 224 &&
          pixels.length === 224 * 224 &&
          // 128×128 全可见蒙版先重铺成 256×256 再透视：结果仍然全亮（没有被裁掉）
          pixels.every((value) => value === 255)
        );
      })()
    );

    check(
      "透视进历史快照：撤销回到透视前（底图 + 图层一起回），重做再回透视后",
      (() => {
        const plan = warpPlanFlat();
        const base = fakeCanvas(256, 256);
        const layers = [{ id: "w", canvas: fakeCanvas(256, 256), mask: { canvas: fakeCanvas(256, 256), alpha: ui3.psMaskAlpha(256, 256, null) } }];
        const before = ui3.psHistorySnapshot({ name: "歪图.png", canvas: base }, layers, null);
        const warped = ui3.psTransformLayers(layers, { kind: "warp", plan, width: 256, height: 256 });
        const baked = ui3.psWarpCanvas(base, plan.inverse, plan.size.w, plan.size.h);
        const after = ui3.psHistorySnapshot({ name: "歪图.png", canvas: baked }, warped, null);
        const undone = ui3.psHistoryRestore(before, { layers: warped, layerSession: null });
        const redone = ui3.psHistoryRestore(after, { layers, layerSession: null });
        return (
          before.layers[0].canvas.width === 256 &&
          baked.width === plan.size.w && baked.height === plan.size.h &&
          // 撤销：底图 + 图层都回到透视前（同一份对象，不是复制出来的）
          undone !== null && undone.canvas === base && undone.width === 256 && undone.height === 256 &&
          undone.layers[0].canvas === layers[0].canvas && undone.layers[0].mask === layers[0].mask &&
          // 重做：回到透视后的底图和变形过的图层
          redone.canvas === baked && redone.width === 224 && redone.height === 224 &&
          redone.layers[0].canvas === warped[0].canvas && redone.layers[0].canvas.width === 224
        );
      })()
    );

    check(
      "透视的边界：没图层不抛，plan 为 null / 四点退化时按原路走（尺寸不变、不报错）",
      (() => {
        const empty = [];
        const goodPlan = ui3.psWarpPlan({ mode: "flat", src: ui3.psQuadCorners(20, 10), width: 20, height: 10 });
        const noLayers = ui3.psTransformLayers(empty, { kind: "warp", plan: goodPlan });
        const degenerate = ui3.psWarpPlan({ mode: "flat", src: [{ x: 0, y: 0 }, { x: 5, y: 5 }, { x: 9, y: 9 }, { x: 0, y: 10 }], width: 10, height: 10 });
        const layer = { id: "a", canvas: fakeCanvas(10, 10), mask: { canvas: fakeCanvas(10, 10), alpha: ui3.psMaskAlpha(10, 10, null) } };
        const nullPlan = ui3.psTransformLayers([layer], { kind: "warp", plan: null, width: 10, height: 10 })[0];
        const badPlan = ui3.psTransformLayers([layer], { kind: "warp", plan: degenerate, width: 10, height: 10 })[0];
        const nullAlpha = ui3.psTransformAlpha(ui3.psMaskAlpha(10, 10, null), 10, 10, { kind: "warp", plan: null });
        const badDims = ui3.psGeometryDims({ kind: "warp", plan: degenerate }, 10, 10);
        const nullDims = ui3.psGeometryDims({ kind: "warp", plan: null }, 10, 10);
        return (
          degenerate === null && ui3.psWarpGeometrySize(null) === null && ui3.psWarpGeometrySize(degenerate) === null &&
          // 没图层：原样返回，不抛
          noLayers === empty && ui3.psTransformLayers(null, { kind: "warp", plan: null }).length === 0 &&
          // plan 退化：图层画布 / 蒙版尺寸原样，蒙版 alpha 长度还是 10×10，不抛
          nullPlan.canvas === layer.canvas && nullPlan.mask.canvas.width === 10 && nullPlan.mask.alpha.length === 100 &&
          badPlan.canvas === layer.canvas && badPlan.mask.alpha.length === 100 &&
          nullAlpha.alpha.length === 100 && nullAlpha.width === 10 &&
          // 输出尺寸退化成「进来时多大就多大」
          nullDims.w === 10 && nullDims.h === 10 && badDims.w === 10 && badDims.h === 10
        );
      })()
    );

    check(
      "透视接进几何联动：warp 是一种几何 kind，落定提交带 plan，导出实时结果时图层也按 plan 变形",
      (() => {
        const body = SOURCE.slice(SOURCE.indexOf("function PsView("), SOURCE.indexOf("function psHandles("));
        const exportBody = body.slice(body.indexOf("const toDataUrl"), body.indexOf("const applySnapshot"));
        return (
          ui3.PS_GEOMETRY_KINDS.includes("warp") &&
          ui3.psGeometryKind("warp") === "warp" &&
          /commit\(baked, null, \{ kind: "warp", plan \}\)/.test(body) &&
          /psTransformLayers\(layers, \{ kind: "warp", plan, width: stage\.width, height: stage\.height \}\)/.test(exportBody)
        );
      })()
    );

    /* ---- PsView 接线：几何提交点 / undo / redo 真的用了上面这些纯函数 ---- */
    const psViewBody = SOURCE.slice(SOURCE.indexOf("function PsView("), SOURCE.indexOf("function psHandles("));
    const commitBody = psViewBody.slice(psViewBody.indexOf("const commit ="), psViewBody.indexOf("const loadImage"));

    check(
      "几何提交点都带几何描述（裁切/旋转/拉直/改画布/缩放/翻转），而且单层会话里不搬图层",
      /psTransformLayers\(layers, steps\)/.test(commitBody) &&
        /if \(steps\.length && !layerSessionRef\.current\)/.test(commitBody) &&
        /commit\(psCrop\(stage, selection\), null, \{ kind: "crop", rect: selection \}\)/.test(psViewBody) &&
        /commit\(psRotate\(stage, deg\), null, \{ kind: "rotate", angle: deg \}\)/.test(psViewBody) &&
        /psStraightenGeometry\(stage\.width, stage\.height, deg\)/.test(psViewBody) &&
        /commit\(psResize\(stage, w, h\), null, \{ kind: "resize", w, h \}\)/.test(psViewBody) &&
        /kind: "canvasSize", w, h, anchor: canvasSize\.anchor/.test(psViewBody) &&
        /commit\(psFlip\(stage, flipAxis\), null, \{ kind: "flip", axis: flipAxis \}\)/.test(psViewBody)
    );

    check(
      "undo/redo 走 psHistoryRestore：底图、图层、单层会话一起回退",
      (() => {
        const undoBody = psViewBody.slice(psViewBody.indexOf("const applySnapshot"), psViewBody.indexOf("/* ---- 画布上的指针交互"));
        return (
          /psHistoryRestore\(snapshot, \{ layers, layerSession \}\)/.test(undoBody) &&
          /setLayers\(restored\.layers\)/.test(undoBody) &&
          /setLayerSession\(restored\.layerSession\)/.test(undoBody) &&
          /layerSessionRef\.current = restored\.layerSession/.test(undoBody) &&
          /psHistorySnapshot\(source, layers, layerSession\)/.test(undoBody)
        );
      })()
    );

    const seededPanel = renderToStaticMarkup(
      React.createElement(ui3.PsView, {
        state: { library: [] },
        actions: {},
        initial: {
          name: "图.png",
          width: 128,
          height: 128,
          preview: "data:image/png;base64,AAAA",
          tool: "select",
          layers: [
            { id: "l1", name: "暗部", canvas: fakeCanvas(128, 128), visible: true, mode: "multiply", opacity: 0.65, mask: { canvas: fakeCanvas(128, 128), alpha: new Uint8ClampedArray(128 * 128) } },
            { id: "l2", name: "高光", canvas: fakeCanvas(128, 128), visible: false, mode: "screen", opacity: 1 }
          ],
          layerSession: { id: "l2", name: "高光", base: { name: "底图.png", canvas: fakeCanvas(128, 128) } }
        }
      })
    );
    check(
      "图层面板：隐藏层 is-hidden、编辑中的层 is-editing、蒙版按钮是已加状态、底图行显示真正的底图名",
      seededPanel.includes("暗部") &&
        seededPanel.includes("高光") &&
        (seededPanel.match(/class="vig-ps-layer-row is-hidden is-editing"/g) || []).length === 1 &&
        (seededPanel.match(/class="vig-ps-layer-row"/g) || []).length === 1 &&
        seededPanel.includes("vig-ps-layer-mini is-on") &&
        seededPanel.includes('value="65"') &&
        seededPanel.includes("底图 · 底图.png") &&
        !seededPanel.includes("底图 · 高光") &&
        seededPanel.includes("正在编辑图层「高光」") &&
        seededPanel.includes("回到合成"),
      seededPanel.slice(0, 160)
    );
  }

  /* ---- 曲线控制点（可拖的曲线编辑器背后的纯模型） ---- */
  check(
    "曲线控制点规范化：排序、去重、首尾钉在 0/255",
    (() => {
      const messy = ui2.psCurveNormalize([[200, 220], [0, 10], [200, 200], [90, 300], [-20, 5]]);
      const empty = ui2.psCurveNormalize([]);
      return (
        messy.map((point) => point[0]).join(",") === "0,90,200,255" &&
        messy[0][1] === 10 &&
        messy[1][1] === 255 &&
        messy[2][1] === 220 &&
        messy[3][0] === 255 &&
        empty.length === 2 &&
        empty[0].join(",") === "0,0" &&
        empty[1].join(",") === "255,255"
      );
    })()
  );
  check(
    "拖动控制点：两端只上下动，中间点夹在邻居之间（x 保持递增）",
    (() => {
      const base = [[0, 0], [100, 120], [255, 255]];
      const endpoint = ui2.psCurveMove(base, 0, 80, 40);
      const middle = ui2.psCurveMove(base, 1, 400, 999);
      return (
        endpoint[0][0] === 0 &&
        endpoint[0][1] === 40 &&
        middle[1][0] === 254 &&
        middle[1][1] === 255 &&
        base[1].join(",") === "100,120"
      );
    })()
  );
  check(
    "加控制点 / 删控制点：太近不加、首尾不许删、至少留两个点",
    (() => {
      const base = [[0, 0], [255, 255]];
      const added = ui2.psCurveAdd(base, 120, 200);
      const tooClose = ui2.psCurveAdd(added, 121, 10);
      const removed = ui2.psCurveRemoveAt(added, 1);
      const keepEndpoints = ui2.psCurveRemoveAt(added, 0);
      const keepTwo = ui2.psCurveRemoveAt(base, 1);
      return (
        added.length === 3 &&
        added[1].join(",") === "120,200" &&
        tooClose.length === 3 &&
        removed.length === 2 &&
        keepEndpoints.length === 3 &&
        keepEndpoints[0][0] === 0 &&
        keepTwo.length === 2
      );
    })()
  );
  check(
    "曲线编辑器：画的是真 LUT（网格 + 曲线 + 控制点都在）",
    (() => {
      const markup = renderToStaticMarkup(
        React.createElement(ui2.CurveEditor, {
          points: [[0, 0], [128, 200], [255, 255]],
          onChange: () => {},
          onApply: () => {}
        })
      );
      return (
        markup.includes("vig-curve-svg") &&
        (markup.match(/class="vig-curve-dot"/g) || []).length === 3 &&
        markup.includes('class="vig-curve-line"') &&
        (markup.match(/class="vig-curve-grid"/g) || []).length === 8 &&
        markup.includes(">应用曲线<") &&
        !markup.includes("undefined")
      );
    })()
  );

  check(
    "色阶：黑场白场拉满 + 中间调 gamma + 输出范围",
    (() => {
      const plain = ui2.psLevelsLut({});
      const clipped = ui2.psLevelsLut({ inBlack: 32, inWhite: 224 });
      const brighter = ui2.psLevelsLut({ gamma: 2 });
      const squeezed = ui2.psLevelsLut({ outBlack: 20, outWhite: 220 });
      return (
        plain[0] === 0 &&
        plain[255] === 255 &&
        clipped[32] === 0 &&
        clipped[224] === 255 &&
        brighter[128] > 128 &&
        squeezed[0] === 20 &&
        squeezed[255] === 220 &&
        // gamma 下限被夹住，不会算出 NaN
        Number.isFinite(ui2.psLevelsLut({ gamma: 0 })[128])
      );
    })()
  );
  check(
    "查找表套到像素上：三通道可以不一样（曲线就是这样用的）",
    (() => {
      const invert = ui2.psIdentityLut().map((value) => 255 - value);
      const data = new Uint8ClampedArray([10, 20, 30, 255]);
      ui2.psApplyLutPixels(data, invert);
      // 三通道各用各的表：R 提亮、G 不动、B 反相
      const split = new Uint8ClampedArray([10, 10, 10, 255]);
      ui2.psApplyLutPixels(split, ui2.psLevelsLut({ gamma: 2 }), ui2.psIdentityLut(), invert);
      return (
        data[0] === 245 &&
        data[1] === 235 &&
        data[2] === 225 &&
        data[3] === 255 &&
        split[0] > 10 &&
        split[1] === 10 &&
        split[2] === 245
      );
    })()
  );
  check(
    "自然饱和度：灰色的不动，已经饱和的少动，中间调的才被抬",
    (() => {
      const data = new Uint8ClampedArray([128, 128, 128, 255, 255, 0, 0, 255, 140, 110, 120, 255]);
      ui2.psVibrancePixels(data, 100);
      const gray = data[0];
      const pureRed = data[4];
      const muted = data[8];
      const before = 140 - 110;
      return (
        Math.abs(gray - 128) <= 1 && // 灰的还是灰的
        Math.abs(pureRed - 255) <= 1 && // 纯红几乎不动（saturation=1 → boost≈0）
        data[8] - data[9] > before // 低饱和的绿/红差被拉开
      );
    })(),
    "灰/纯红/中间调各测一遍"
  );
  check(
    "模糊：整体均值不变、边界不越界（横竖两遍盒式）",
    (() => {
      const width = 9;
      const height = 9;
      const data = new Uint8ClampedArray(width * height * 4);
      for (let index = 0; index < data.length; index += 4) {
        const at = index / 4;
        const value = at % width === 4 && Math.floor(at / width) === 4 ? 255 : 0;
        data[index] = value;
        data[index + 1] = value;
        data[index + 2] = value;
        data[index + 3] = 255;
      }
      const before = data[0];
      ui2.psBoxBlurPixels(data, width, height, 1);
      // 中心点被四周拉低、旁边的点被抬高
      const center = data[(4 * width + 4) * 4];
      const neighbor = data[(4 * width + 3) * 4];
      return center > 0 && center < 255 && neighbor > before && data[0] >= 0 && data[0] <= 255;
    })()
  );
  check(
    "锐化：边缘对比被拉大（USM：原图 + 强度 ×（原图 − 模糊））",
    (() => {
      const width = 5;
      const height = 1;
      const flat = new Uint8ClampedArray(width * height * 4);
      const edge = new Uint8ClampedArray(width * height * 4);
      for (let index = 0; index < flat.length; index += 4) {
        flat[index] = flat[index + 1] = flat[index + 2] = 120;
        flat[index + 3] = 255;
        edge[index] = edge[index + 1] = edge[index + 2] = index / 4 < 2 ? 40 : 220;
        edge[index + 3] = 255;
      }
      const flatBefore = flat[0];
      ui2.psSharpenPixels(flat, width, height, 100);
      ui2.psSharpenPixels(edge, width, height, 100);
      const left = edge[(1 * 4) + 0];
      const right = edge[(3 * 4) + 0];
      return (
        // 平坦区域基本不变（±1 的舍入）
        Math.abs(flat[0] - flatBefore) <= 1 &&
        // 边缘两侧被拉得更开：暗的更暗、亮的更亮
        left < 40 &&
        right >= 220
      );
    })()
  );
  check(
    "噪点：同一种子完全可复现，强度 0 不动",
    (() => {
      const make = () => new Uint8ClampedArray([128, 128, 128, 255, 128, 128, 128, 255]);
      const a = make();
      const b = make();
      const c = make();
      ui2.psNoisePixels(a, 40, 7);
      ui2.psNoisePixels(b, 40, 7);
      ui2.psNoisePixels(c, 0, 7);
      return (
        a.join(",") !== "128,128,128,255,128,128,128,255" &&
        a.join(",") === b.join(",") &&
        c.join(",") === "128,128,128,255,128,128,128,255" &&
        Array.from(a).every((value) => value >= 0 && value <= 255)
      );
    })()
  );

  check("缩放比例夹在 5% ~ 800%", ui2.psClampZoom(0.001) === ui2.PS_ZOOM_MIN && ui2.psClampZoom(99) === ui2.PS_ZOOM_MAX && ui2.psClampZoom("x") === 1);
  check("加减一档 25%：1 → 1.25 → 1", Math.abs(ui2.psStepZoom(1, 1) - 1.25) < 1e-9 && Math.abs(ui2.psStepZoom(1.25, -1) - 1) < 1e-9);
  check("到顶到底不再动", ui2.psStepZoom(ui2.PS_ZOOM_MAX, 1) === ui2.PS_ZOOM_MAX && ui2.psStepZoom(ui2.PS_ZOOM_MIN, -1) === ui2.PS_ZOOM_MIN);
  check(
    "滚轮：向上放大、向下缩小，触控板小步也不跳",
    ui2.psWheelZoom(1, -100) > 1 && ui2.psWheelZoom(1, 100) < 1 && Math.abs(ui2.psWheelZoom(1, -50) - 1.25 ** 0.5) < 1e-9
  );
  check("适应窗口只缩不放", ui2.psFitZoom(3072, 4096, 1200, 800) < 0.2 && ui2.psFitZoom(64, 64, 1200, 800) === 1);
  check("缩放的锚点：光标底下那点不动", (() => {
    // 1000 宽的内容、比例 0.5、滚动 200、光标在容器内 100 → 图片坐标 (200+100)/0.5 = 600
    const moved = ui2.psZoomAt(0.5, 1, { x: 100, y: 50 }, { left: 200, top: 300 });
    return moved.scale === 1 && Math.abs(moved.scrollLeft - (600 * 1 - 100)) < 1e-9 && Math.abs(moved.scrollTop - (700 - 50)) < 1e-9;
  })());

  /* --- 分辨率：真的写进 PNG 的 pHYs / JPEG 的 JFIF --- */
  const pngPath = new URL("../assets/presets/ink-landscape.png", import.meta.url);
  const pngB64 = readFileSync(pngPath).toString("base64");
  const pngUrl = `data:image/png;base64,${pngB64}`;

  check("自带 base64 编解码（浏览器与沙箱都不缺依赖）", (() => {
    const bytes = ui2.psB64Decode(pngUrl.split(",")[1]);
    return bytes.length === readFileSync(pngPath).length && bytes[0] === 0x89 && ui2.psB64Encode(bytes) === pngB64.replace(/=+$/, "");
  })());
  check("CRC32 与标准值一致", ui2.psCrc32(new TextEncoder().encode("123456789")) === 0xcbf43926);

  const before = ui2.psReadDpi(pngUrl);
  const truncated = (() => {
    // 真 PNG 的签名 + IHDR 原样切下来：够 psReadDpi / psPngWithDpi 走完整循环，而且没有 pHYs
    const bytes = readFileSync(pngPath);
    return `data:image/png;base64,${Buffer.from(bytes.subarray(0, 8 + 25)).toString("base64")}`;
  })();

  const seeded = ui2.psApplyDpi(truncated, 300);
  check("没写分辨率的 PNG 读出来是 null", ui2.psReadDpi(truncated) === null);
  check("写入 300 DPI 后读回来是 300", ui2.psReadDpi(seeded) === 300, String(ui2.psReadDpi(seeded)));
  check("pHYs 正好插在 IHDR 之后、多 21 字节", (() => {
    const bytes = ui2.psB64Decode(seeded.split(",")[1]);
    const type = String.fromCharCode(bytes[37], bytes[38], bytes[39], bytes[40]);
    return bytes.length === 8 + 25 + 21 && type === "pHYs";
  })(), String(ui2.psB64Decode(seeded.split(",")[1]).length));

  check("图上本来就写了分辨率就沿用（这张线稿是 96）", before === 96, String(before));
  const after = ui2.psApplyDpi(pngUrl, 300);
  check("改写真图的 pHYs：读回来 300", ui2.psReadDpi(after) === 300);
  check("重写是替换不是叠加（长度不变）", ui2.psB64Decode(after.split(",")[1]).length === readFileSync(pngPath).length && ui2.psReadDpi(ui2.psApplyDpi(after, 150)) === 150);
  check("全部块的 CRC 都对得上（PNG 还能打开）", (() => {
    const bytes = ui2.psB64Decode(after.split(",")[1]);
    let at = 8;
    let ok = true;
    while (at + 12 <= bytes.length) {
      const length = (bytes[at] << 24) | (bytes[at + 1] << 16) | (bytes[at + 2] << 8) | bytes[at + 3];
      const stored = ((bytes[at + 8 + length] << 24) | (bytes[at + 9 + length] << 16) | (bytes[at + 10 + length] << 8) | bytes[at + 11 + length]) >>> 0;
      if (ui2.psCrc32(bytes.subarray(at + 4, at + 8 + length)) !== stored) ok = false;
      if (String.fromCharCode(bytes[at + 4], bytes[at + 5], bytes[at + 6], bytes[at + 7]) === "IEND") break;
      at += 12 + length;
    }
    return ok;
  })());
  check("非图片 dataURL 原样返回", ui2.psApplyDpi("data:text/plain;base64,AAAA", 300) === "data:text/plain;base64,AAAA");

  /* --- 常用尺寸的比例换算：长边不动 --- */
  check("常用尺寸 16:9：长边 1000 不动，短边 563", (() => {
    const size = ui2.psRatioSize(1000, 500, 16 / 9);
    return size.w === 1000 && size.h === 563;
  })());
  check("常用尺寸 9:16：还是长边不动", (() => {
    const size = ui2.psRatioSize(1000, 500, 9 / 16);
    return size.w === 563 && size.h === 1000;
  })());
  check("常用尺寸 1:1：正方形边长取长边", (() => {
    const size = ui2.psRatioSize(1000, 500, 1);
    return size.w === 1000 && size.h === 1000;
  })());

  /* --- 快捷键：默认键位、组合键、可自定义 --- */
  check("每个工具都有字母键且互不重复", (() => {
    const map = ui2.PS_SHORTCUT_TOOLS;
    const tools = ui2.PS_TOOLS.map((item) => item.id);
    const values = Object.values(map);
    return tools.every((id) => values.includes(id)) && new Set(values).size === values.length && values.length === tools.length;
  })(), Object.values(ui2.PS_SHORTCUT_TOOLS).length + " 个");
  check("字母键切到对应工具（V/C/S/R/L/N/F/Z/M）", ["v", "c", "s", "r", "l", "n", "f", "z", "m"].every((key) => {
    const hit = ui2.psShortcut({ key });
    return hit && hit.tool === ui2.PS_SHORTCUT_TOOLS[key];
  }));
  check("大写字母同样生效", ui2.psShortcut({ key: "V" })?.tool === "select");
  check(
    "Ctrl 组合：撤销 / 重做 / 适应 / 1:1 / 全选 / 下载 / 设为参考图",
    ui2.psShortcut({ key: "z", ctrlKey: true })?.action === "undo" &&
      ui2.psShortcut({ key: "z", ctrlKey: true, shiftKey: true })?.action === "redo" &&
      ui2.psShortcut({ key: "y", ctrlKey: true })?.action === "redo" &&
      ui2.psShortcut({ key: "0", ctrlKey: true })?.action === "fit" &&
      ui2.psShortcut({ key: "1", ctrlKey: true })?.action === "actual" &&
      ui2.psShortcut({ key: "a", ctrlKey: true })?.action === "selectAll" &&
      ui2.psShortcut({ key: "s", ctrlKey: true })?.action === "download" &&
      ui2.psShortcut({ key: "d", metaKey: true })?.action === "reference"
  );
  check(
    "单键：+/- 缩放、\\ 专注、? 快捷键、Esc 取消、Enter 应用、Del 取消选区",
    ["zoomIn", "zoomOut", "focus", "help", "clearSelection", "apply"].every((action) =>
      ["+", "-", "\\", "?", "Escape", "Enter", "Delete"].some((key) => ui2.psShortcut({ key })?.action === action)
    )
  );
  check("没绑定功能键就返回 null（不抢宿主的键）", ui2.psShortcut({ key: "q" }) === null && ui2.psShortcut({ key: "F5" }) === null && ui2.psShortcut({}) === null);
  check(
    "组合串归一化：修饰键顺序固定、= 当 +、Esc/Del 归一",
    ui2.psCombo({ key: "Z", ctrlKey: true }) === "ctrl+z" &&
      ui2.psCombo({ key: "z", shiftKey: true, ctrlKey: true }) === "ctrl+shift+z" &&
      ui2.psCombo({ key: "k", altKey: true, ctrlKey: true }) === "ctrl+alt+k" &&
      ui2.psCombo({ key: "=" }) === "+" &&
      ui2.psCombo({ key: "Escape" }) === "escape" &&
      ui2.psCombo({ key: "Control" }) === ""
  );
  check(
    "组合串显示：Ctrl+Shift+Z / Esc / 一个动作多键位用 / 连起来",
    ui2.psComboLabel("ctrl+shift+z") === "Ctrl+Shift+Z" &&
      ui2.psComboLabel("escape,delete") === "Esc / Del" &&
      ui2.psComboLabel("+,=") === "+ / =" &&
      ui2.psComboLabel("") === ""
  );
  check("一整套键位：默认 + 覆盖，空串代表解绑", (() => {
    const map = ui2.psBindingMap({ "tool.select": "q", undo: "" });
    return map["tool.select"] === "q" && map.undo === undefined && map.redo.startsWith("ctrl+shift+z");
  })());
  check("自定义键位立刻改行为：改成 q 之后 v 不再切框选", (() => {
    const custom = { "tool.select": "q" };
    return ui2.psShortcut({ key: "q" }, custom)?.tool === "select" && ui2.psShortcut({ key: "v" }, custom) === null;
  })());
  check("组合键也能自定义（绑成 alt+1）", ui2.psShortcut({ key: "1", altKey: true }, { fit: "alt+1" })?.action === "fit");
  check("一个动作绑多个键位，逐个命中", (() => {
    const custom = { undo: "ctrl+z,q" };
    return ui2.psShortcut({ key: "z", ctrlKey: true }, custom)?.action === "undo" && ui2.psShortcut({ key: "q" }, custom)?.action === "undo";
  })());
  check(
    "查重：撞上别人的键位能揪出来（排除自己）",
    ui2.psConflict({}, "ctrl+z", "redo") === "undo" &&
      ui2.psConflict({}, "ctrl+z", "undo") === "" &&
      ui2.psConflict({ "tool.crop": "q" }, "q", "tool.select") === "tool.crop" &&
      ui2.psConflict({}, "ctrl+alt+j", "undo") === ""
  );

  /* --- 矫正：PS 式标尺，拖一条线就转，没有滑块 --- */
  check(
    "标尺角度：水平的线不转，歪 3° 转回 -3°，反着拖结果一样",
    ui2.psRulerAngle({ x: 0, y: 0 }, { x: 200, y: 0 }) === 0 &&
      Math.abs(ui2.psRulerAngle({ x: 0, y: 0 }, { x: 200, y: 10.4816 }) + 3) < 0.01 &&
      Math.abs(ui2.psRulerAngle({ x: 200, y: 10.4816 }, { x: 0, y: 0 }) + 3) < 0.01
  );
  check("比 45° 还陡的线按「本该竖直」算（差 1.43° 就转 1.43°）", Math.abs(ui2.psRulerAngle({ x: 0, y: 0 }, { x: 5, y: 200 }) - 1.43) < 0.02);
  check("拖太短不当真（返回 null，宿主提示重拖）", ui2.psRulerAngle({ x: 0, y: 0 }, { x: 3, y: 3 }) === null && ui2.psRulerAngle({ x: 0, y: 0 }, {}) === null);
  check("竖直的线本来就不动", ui2.psRulerAngle({ x: 0, y: 0 }, { x: 0, y: 200 }) === 0);

  const psRulerUi = renderToStaticMarkup(
    React.createElement(ui2.PsView, { state: { library: [] }, actions: {}, initial: { name: "图.png", width: 256, height: 256, preview: null, tool: "straighten" } })
  );
  check("矫正工具：画布光标变十字（挂 is-ruler）", psRulerUi.includes("vig-ps-canvas is-ruler"));
  check("取消了滑块那一套（没有 手动角度 / 应用 / range）", !psRulerUi.includes("手动角度") && !psRulerUi.includes(">应用<") && !psRulerUi.includes("vig-range"));
  check("改成拖线引导 + 保留自动矫正", psRulerUi.includes("沿") && psRulerUi.includes("拖一条线") && psRulerUi.includes("自动矫正") && psRulerUi.includes("vig-ps-ruler"));

  const psRulerPreview = renderToStaticMarkup(
    React.createElement(ui2.PsView, {
      state: { library: [] },
      actions: {},
      initial: { name: "图.png", width: 256, height: 256, preview: "data:image/png;base64,AAAA", tool: "straighten", ruler: { from: { x: 20, y: 40 }, to: { x: 220, y: 52 }, angle: -3.2 } }
    })
  );
  check("拖的那一下画面实时转（img 上带 rotate）+ 标尺线 + 角度气泡", psRulerPreview.includes("rotate(-3.2deg)") && psRulerPreview.includes("vig-ps-ruler-line") && psRulerPreview.includes("-3.2°"));
  check("拖着的时候面板显示实时角度", psRulerPreview.includes("实时预览 -3.2°") && psRulerPreview.includes("vig-ps-ruler is-live"));

  /* --- 按需展开：两侧面板可收起 --- */
  const psShot = renderToStaticMarkup(
    React.createElement(ui2.PsView, {
      state: { library: [] },
      actions: {},
      initial: { name: "图.png", width: 256, height: 256, preview: "data:image/png;base64,AAAA", tool: "select", selection: { x: 8, y: 8, w: 40, h: 40 } }
    })
  );
  check("默认两侧都展开（data-labels/data-params 都是 1）", psShot.includes('data-labels="1"') && psShot.includes('data-params="1"'));
  check("工具条有收起开关，参数栏也有", psShot.includes("vig-ps-tools-toggle") && psShot.includes('title="收起 (参数)"'));
  check("工具栏有三件套：专注画布 / 快捷键 / 撤销重做", psShot.includes("专注画布 (\\)") && psShot.includes("快捷键 (?)") && psShot.includes('title="撤销"'));
  check("工具按钮的 title 带上快捷键字母", psShot.includes("框选 · V") && psShot.includes("画布 · N"));

  const psFocus = renderToStaticMarkup(
    React.createElement(ui2.PsView, {
      state: { library: [] },
      actions: {},
      initial: { name: "图.png", width: 256, height: 256, preview: "data:image/png;base64,AAAA", tool: "select", collapsed: true }
    })
  );
  check("专注态：两侧都收起", psFocus.includes('data-labels="0"') && psFocus.includes('data-params="0"'));
  check("专注态：参数栏只剩一条竖签（点它展开；竖签也是浮窗）", psFocus.includes("vig-ps-params vig-ps-float is-collapsed") && psFocus.includes("vig-ps-params-open") && !psFocus.includes("vig-ps-foot"));
  check("专注态：画布仍然在，且没有裸的 undefined", psFocus.includes("vig-ps-scroll") && !psFocus.includes("undefined"));

  const psKeys = psShot.match(/<div class="vig-ps-keys">/g) || [];
  check("快捷键表默认不弹（避免糊在画面上）", psKeys.length === 0);

  const psKeySheet = renderToStaticMarkup(
    React.createElement(ui2.PsView, {
      state: { library: [] },
      actions: {},
      initial: { name: "图.png", width: 256, height: 256, preview: "data:image/png;base64,AAAA", tool: "select", keys: true }
    })
  );
  check("快捷键表分四组（工具 / 视图 / 编辑 / 出口）", (psKeySheet.match(/class="vig-ps-keys"/g) || []).length === 4);
  check(
    "表里每个动作都是可点的键帽",
    (psKeySheet.match(/class="vig-ps-key[" ]/g) || []).length === ui2.PS_ACTIONS.length &&
      ui2.PS_ACTIONS.length === Object.keys(ui2.PS_DEFAULT_BINDINGS).length
  );
  check("键帽上写的是当前键位（V / Ctrl+Shift+Z / Esc / Del）", psKeySheet.includes(">V</button>") && psKeySheet.includes(">Ctrl+Shift+Z / Ctrl+Y</button>") && psKeySheet.includes(">Esc / Del</button>"));
  check("未改过时不给「恢复默认」按钮，也不给顶部「全部恢复」", !psKeySheet.includes("vig-ps-key-reset") && !psKeySheet.includes("全部恢复默认"));
  check("表里写了改键说明（点键帽 / Esc 取消 / Backspace 恢复）", psKeySheet.includes("点键帽就能改") && psKeySheet.includes("Backspace 恢复这一条"));

  const psCustom = renderToStaticMarkup(
    React.createElement(ui2.PsView, {
      state: { library: [] },
      actions: {},
      initial: { name: "图.png", width: 256, height: 256, preview: "data:image/png;base64,AAAA", tool: "select", keys: true, bindings: { "tool.select": "alt+1" } }
    })
  );
  check("改过的键位在表里标成自定义，并多一个单条恢复按钮", psCustom.includes("vig-ps-key is-custom") && psCustom.includes("vig-ps-key-reset"));
  check("自定义键位立刻显示在键帽上（Alt+1）", psCustom.includes(">Alt+1</button>"));
  check("顶部出现「全部恢复默认」", psCustom.includes("全部恢复默认"));
  check("自定义键位也进工具栏提示（框选 · Alt+1）", psCustom.includes("框选 · Alt+1"));

  /* --- 空画面：别把画布那块地方空着 --- */
  const psEmpty = renderToStaticMarkup(React.createElement(ui2.PsView, { state: { library: [] }, actions: {}, initial: null }));
  check("没图时给三步说明", psEmpty.includes("vig-ps-steps") && psEmpty.includes("上传本地图，或用下面的最近生成"));

  const psRecent = renderToStaticMarkup(
    React.createElement(ui2.PsView, {
      state: { library: [{ id: "a1", name: "a.png", url: "/api/velapi-image-go/asset/a1" }, { id: "a2", name: "b.png", url: "/api/velapi-image-go/asset/a2" }] },
      actions: {},
      initial: null
    })
  );
  check("有图库时，空画面里摆「最近生成」，点一下就能进来", psRecent.includes("最近生成") && psRecent.includes("vig-ps-recent-grid") && (psRecent.match(/vig-ps-recent-tile/g) || []).length === 2);
  check("有最近生成时不再重复三步说明", !psRecent.includes("vig-ps-steps"));

  const psSamples = renderToStaticMarkup(
    React.createElement(ui2.PsView, {
      state: { library: [], presets: [{ id: "p1", title: "产品图", image: "/api/velapi-image-go/preset/product-stand.png" }] },
      actions: {},
      initial: null
    })
  );
  check("图库空但预设样张在：摆「预设样张」给一张练手", psSamples.includes("预设样张") && psSamples.includes("product-stand.png"));
  check("什么都没得点时才退化成三步说明", !psSamples.includes("vig-ps-steps"));
}

/* ---- 5. 样式质量闸门 --------------------------------------------- */

const css = (chat.match(/<style>([\s\S]*?)<\/style>/) ?? [, ""])[1];
// 重置写成 .vig-root button{...} 是 (0,1,1)，会压过 .vig-btn(0,1,0)——
// 按钮的 padding/border 会神隐（踩过：「保存」变成窄蓝块、文字顶出边框）。
// 必须用 :where() 把重置压到 0 特异性。
check("按钮重置用 :where() 压特异性", css.includes(".vig-root :where(button)") && !/^\.vig-root button\s*\{/m.test(css));
check("按钮不许被 flex 压扁", /\.vig-row>\.vig-btn,\.vig-row>button\{min-width:auto;flex:none\}/.test(css));
check("表单页有居中收窄骨架", /\.vig-page\{[^}]*max-width:760px/.test(css) && /\.vig-form-grid\{display:grid/.test(css));
check("供应商是一行一卡而不是表格", /\.vig-prov\{/.test(css) && !css.includes(".vig-table"));
check("圆角用变量且为大圆角", /--vig-r-card:18px/.test(css) && /--vig-r-pill:999px/.test(css));
check("有深色主题覆盖", css.includes("body[data-ds-dark-theme]"));
// 工具箱是「左工具条 / 中画布 / 右参数」三栏，窄容器必须折成一栏（否则 300px 卡片里塞不下）
check(
  "工具箱三栏骨架 + 窄容器折成一栏",
  /\.vig-ps\{display:grid;grid-template-columns:96px minmax\(0,1fr\) 240px/.test(css) && /\.vig-root\[data-compact="1"\] \.vig-ps\{grid-template-columns:minmax\(0,1fr\);/.test(css)
);
check("滑杆自绘了滑块（原生滑块在深色主题下几乎看不见）", css.includes(".vig-range::-webkit-slider-thumb"));
// 放大的图要能滚：滚动容器自己 flex + 内容 margin:auto，用 justify-content:center 会把左上角截掉
check(
  "画布滚动容器用 margin:auto 居中（放大后左上角滚得到）",
  /\.vig-ps-scroll\{position:absolute;inset:0;display:flex;overflow:auto/.test(css) && /\.vig-ps-shot\{position:relative;display:block;flex:none;margin:auto\}/.test(css)
);
check("比例条浮在画布右下角", /\.vig-ps-zoom\{position:absolute;right:10px;bottom:10px/.test(css));
// 按需展开：收起标签 → 52px 图标栏；收起参数 → 52px 竖签；两个都收 → 两侧 52px
check(
  "工具箱可以按需收起两侧（52px 图标栏 / 52px 竖签）",
    // 参数改成浮窗后，收起参数不再动网格；第三列是图层面板，固定 240px
    /\.vig-ps\[data-params="0"\]\{grid-template-columns:96px minmax\(0,1fr\) 240px\}/.test(css) &&
    /\.vig-ps\[data-labels="0"\]\[data-params="0"\]\{grid-template-columns:52px minmax\(0,1fr\) 240px\}/.test(css)
);
check("画布高度跟着窗口走（不再是死板的 320px）", /min-height:clamp\(320px,58vh,720px\)/.test(css));
check("空画面铺满整块画布（内容垂直居中，不再缩在顶部）", /\.vig-ps-empty\{position:absolute;inset:0;overflow:auto/.test(css));
check("键盘监听挂在捕获阶段（录制键位时才拦得住宿主自己的快捷键）", /window\.addEventListener\("keydown", onKeyDown, true\)/.test(SOURCE));
check(
  "PsView 的提示统一走 actions.toast（以前直接调全局 toast，等于每条提示都报 ReferenceError）",
  /const notify = actions\?\.toast \?\? \(\(\) => \{\}\)/.test(SOURCE) &&
    !/^\t\t\t(?!.*const notify).*?(?<![\w.])toast\(/m.test(SOURCE.slice(SOURCE.indexOf("function PsView("), SOURCE.indexOf("function psHandles(")))
);
check("指针捕获包了 try（合成 PointerEvent 里 setPointerCapture 会抛）", /function psCapturePointer\(/.test(SOURCE) && /catch \{\s*\/\* 没有真实指针，忽略 \*\/\s*\}/.test(SOURCE));
check("键帽是按钮：可点、录制态有提示、改过的用虚线框", /\.vig-ps-key\{/.test(css) && /\.vig-ps-key\.is-recording\{/.test(css) && /\.vig-ps-key\.is-custom\{/.test(css));
check(
  "改键位的四件事都在：录入 psCombo、查重 psConflict、显示 psComboLabel、解绑空串",
  /function psCombo\(/.test(SOURCE) && /function psConflict\(/.test(SOURCE) && /function psComboLabel\(/.test(SOURCE) && /psConflict\(overrides, combo, recording\)/.test(SOURCE)
);

check("收起后工具名隐藏、只留图标", /\.vig-ps\[data-labels="0"\] \.vig-ps-tool span\{display:none\}/.test(css));
// 窄容器分支必须存在：470px 面板里并排放「150 导航 + 268 检查器」会把工作区挤没。
check(
  "有窄容器堆叠分支",
  css.includes('[data-compact="1"]') &&
    /\[data-compact="1"\]\s*\.vig-shell\{[^}]*flex-direction:column/.test(css) &&
    /\[data-compact="1"\]\s*\.vig-nav\{[^}]*flex-direction:row/.test(css)
);
check("停靠面板不再铺满整侧", /\.vig-dock\{[^}]*top:46px[^}]*border-radius/.test(css));
check(
  "停靠层不再自己浮一颗胶囊（入口只有左侧栏那颗按钮，同一个名字只出现一次）",
  !/vig-dock-launch/.test(SOURCE) && !/vig-dock-launch/.test(css) && /vig-launch\{/.test(css)
);
check(
  "侧栏真正显示着工作台时停靠入口让位（同一个名字只出现一次）",
  /rightbarPaneMounted = mounted/.test(SOURCE) &&
    /rightbarPaneVisible = visible/.test(SOURCE) &&
    /rightbarPaneOnScreen = on/.test(SOURCE) &&
    /const onScreen = paneOnScreen === undefined \? Boolean\(paneMounted && paneVisible\) : paneOnScreen === true;/.test(SOURCE) &&
    /return onScreen \? null : "dock";/.test(SOURCE)
);
check(
  "侧栏 tab 挂着但被宿主藏起来时，面板本体必须在（keepMounted 的 tab 非激活时照样挂载）",
  /keepMounted: true/.test(SOURCE) &&
    /function dockFace\(\{ paneMounted, paneVisible, paneOnScreen \}\)/.test(SOURCE) &&
    /dockFace\(\{ paneMounted: pane\.mounted, paneVisible: pane\.visible, paneOnScreen: pane\.onScreen \}\)/.test(SOURCE) &&
    /function PaneHost\(\{ children \}\)/.test(SOURCE) &&
    /IntersectionObserver/.test(SOURCE) &&
    /ResizeObserver/.test(SOURCE) &&
    /getClientRects\(\)\.length === 0/.test(SOURCE) &&
    /setInterval\(decide, 1000\)/.test(SOURCE) &&
    /\.vig-pane-host\{/.test(css)
);
// 同一个事实只出现一次：供应商名在检查器、密钥在工作区头部、模型在输入区、库存计数在侧栏底部。
// 之前头部挂了一颗「velapi」胶囊、检查器里又抄了一遍密钥胶囊和「供应商管理」跳转，看着就是重复。
const renderedAll = htmlFor(mounted.slots, "settings.section");
const headerBlock = renderedAll.match(/<header class="vig-head"[\s\S]*?<\/header>/)?.[0] ?? "";
check("工作台头部不挂状态胶囊", headerBlock.length > 0 && !headerBlock.includes("vig-pill"), headerBlock.slice(0, 80));
// 桌面端没绑 Ctrl+R、菜单里没有「重新加载」，所以把重载入口做进面板头部。
check(
  "头部有「重载界面」按钮（桌面端刷新界面的唯一手边入口）",
  headerBlock.includes('title="重载界面"') && /onClick: reloadShell/.test(SOURCE) && /window\.location\.reload\(\)/.test(SOURCE),
  headerBlock.match(/<button[^>]*重载界面[^>]*>/)?.[0] ?? headerBlock.slice(0, 120)
);
{
  const start = SOURCE.indexOf('title: t("panel.provider")');
  const card = SOURCE.slice(start, SOURCE.indexOf("vig-modal-mask", start));
  check("检查器里的供应商卡不再重复密钥与「供应商管理」跳转", start > 0 && !card.includes("status.key") && !card.includes('t("nav.providers")'));
}
{
  // 数胶囊要先剥掉 <style>：CSS 里的 .vig-pill 规则会被一起数进去
  const body = renderedAll.replace(/<style>[\s\S]*?<\/style>/g, "");
  const pills = (body.match(/class="vig-pill/g) ?? []).length;
  check("整页里状态胶囊不超过两颗（密钥 + 队列各一）", pills <= 2, `实际 ${pills} 颗`);
}
/* ---- 9. 停靠入口的可见性判定 ------------------------------------- *
 * 用户报障「重启 DSH 后按键又不见了」。根因：宿主对注册时写了 keepMounted
 * 的 tab 会一直挂着，非激活时只是被 display:none 藏着。旧代码只认 mounted，
 * 于是停靠面板和入口胶囊一起收起来 —— 工作台一个入口都不剩。 */
const { dockFace, RightDock } = mounted.module.__internals;
check(
  "dockFace：侧栏正显示工作台 → 停靠层让位",
  dockFace({ paneMounted: true, paneVisible: true, open: false }) === null &&
    dockFace({ paneMounted: true, paneVisible: true, open: true }) === null
);
check(
  "dockFace：侧栏 tab 挂着但被藏着 + 面板收起 → 收起 = 不渲染（入口由左侧栏那颗按钮负责）",
  dockFace({ paneMounted: true, paneVisible: false }) === "dock"
);
check(
  "dockFace：侧栏 tab 挂着但被藏着 + 面板开着 → 停靠面板本体",
  dockFace({ paneMounted: true, paneVisible: false, paneOnScreen: false }) === "dock"
);
check(
  "dockFace：侧栏没承载 → 收起不渲染、开着给面板",
  dockFace({ paneMounted: false, paneVisible: false }) === "dock"
);
/* 「挂载了」还不够：宿主过渡动画、被别的层盖住、用位移藏面板时，几何量都会说谎。
   一旦说谎，停靠层以为自己该让位 —— 于是入口全没了。判据换成「真的在屏幕上」。 */
check(
  "dockFace：挂载着、几何量也说看得见，但没真的在屏幕上 → 收起时同样不渲染",
  dockFace({ paneMounted: true, paneVisible: true, paneOnScreen: false }) === "dock"
);
check(
  "dockFace：确实在屏幕上才让位（IntersectionObserver 认过的）",
  dockFace({ paneMounted: true, paneVisible: true, paneOnScreen: true }) === null &&
    dockFace({ paneMounted: false, paneVisible: false, paneOnScreen: true }) === null
);
check(
  "PanelHost 广播里带上 onScreen（页面侧只有它能证明「用户正看着工作台」）",
  /rightbarPaneOnScreen = on/.test(SOURCE) &&
    /detail: \{ mounted, visible, onScreen: on \}/.test(SOURCE) &&
    /isIntersecting/.test(SOURCE) &&
    /intersectionRatio/.test(SOURCE)
);

/* ---- 9b. 冷启动竞态：sidebarRightTabs 晚到也得登记上 ------------- *
 * 用户报障「DSH 重启后工作台按键不见了」，而且是刷新也回不来的那一种。
 * 根因：ui-sidebar-right 自己要等 slots/layout/locale/resources/sessions/
 * uiSession/shortcuts 七个服务才激活，比只等 slots 的我们晚；旧代码用一次性
 * ctx.get("sidebarRightTabs")，拿不到就静默跳过 —— tab 类型和「开始」页那张卡
 * 一起没登记，右侧栏重启后停在开始页，一个入口都不剩。 */
{
  const late = mountWithoutTabs();
  check(
    "sidebarRightTabs 还没出现时：不硬登记，而是挂到 ctx.inject 上等它（并且记下 waiting）",
    late.waiters.length === 1 &&
      JSON.stringify(late.waiters[0].deps) === '["sidebarRightTabs"]' &&
      late.tabDefs.length === 0 &&
      late.sandbox.window.__velapiImageGo?.rightbarReady === false &&
      late.sandbox.window.__velapiImageGo?.rightbarWaiting === true,
    `waiters=${late.waiters.length} tabDefs=${late.tabDefs.length}`
  );
  check(
    "只等 slots 的我们，激活顺序比 sidebar-right 早 —— 这就是那次报障的机制",
    /exports\.inject = \["slots", "sidebarRightTabs", "sidebarRight"\]/.test(SOURCE) &&
      late.waiters[0].deps.join() === "sidebarRightTabs" &&
      !/const tabs = ctx\.get\?\.\("sidebarRightTabs"\);/.test(SOURCE)
  );
  // 服务到货：模拟 ui-sidebar-right 激活后把服务挂上来
  const before = late.fetchCalls.length;
  late.waiters[0].callback(late.makeScope(true));
  check(
    "sidebarRightTabs 一到货：tab 类型 + 开始页那张卡 + 面板席位都补上",
    late.tabDefs.length === 1 &&
      late.tabDefs[0].kind === "velapi-image-go" &&
      late.tabDefs[0].id === "dsh-plugin-velapi-image-go" &&
      Array.isArray(late.tabDefs[0].guide) &&
      late.tabDefs[0].guide[0]?.id === "open-workbench" &&
      late.tabDefs[0].guide[0]?.order === 20 &&
      late.slots.has("sidebar.right.pane.tab") &&
      late.slots.get("sidebar.right.pane.tab")?.options?.key === "dsh-plugin-velapi-image-go" &&
      late.sandbox.window.__velapiImageGo?.rightbarReady === true &&
      late.sandbox.window.__velapiImageGo?.rightbarWaiting === false,
    `tabDefs=${late.tabDefs.length}`
  );
  check(
    "补登记之后发回执：服务面快照 + dom 实况一起写回宿主（宿主侧落盘 client-report.json）",
    late.fetchCalls.length > before &&
      late.fetchCalls.some((call) => call.url.endsWith("/api/velapi-image-go/client-report") && String(call.init?.body ?? "").includes("rightbar-registered")),
    late.fetchCalls.map((call) => call.url).join(",")
  );

  /* 新版 DSH：服务没到就 get 会**抛**（cordis 守卫原文 cannot get property "…" without inject）。
     旧代码让这个异常逃出 registerRightbar，整条 rightbar 登记当场中断 —— 重启后入口又没了。 */
  const guarded = mountWithoutTabs(["rightbar", "overlay", "settings"], { guarded: true });
  check(
    "新版守卫（get 直接抛）也拦不住我们：照样挂到 ctx.inject 上等席位，其他落点不受影响",
    guarded.waiters.length === 1 &&
      JSON.stringify(guarded.waiters[0].deps) === '["sidebarRightTabs"]' &&
      guarded.tabDefs.length === 0 &&
      guarded.slots.has("shell.overlay") === true && // 守卫只影响 rightbar，停靠落点照旧登记
      guarded.sandbox.window.__velapiImageGo?.rightbarWaiting === true &&
      guarded.sandbox.window.__velapiImageGo?.rightbarReady === false,
    `waiters=${guarded.waiters.length} ready=${guarded.sandbox.window.__velapiImageGo?.rightbarReady}`
  );
  guarded.waiters[0].callback(guarded.makeScope(true));
  check(
    "守卫那一档：席位到货后照样把 tab 类型 + 开始页卡片补上",
    guarded.tabDefs.length === 1 &&
      guarded.tabDefs[0].guide?.[0]?.id === "open-workbench" &&
      guarded.sandbox.window.__velapiImageGo?.rightbarReady === true,
    `tabDefs=${guarded.tabDefs.length}`
  );
  check(
    "登记过程留痕：探针被守卫拒绝的原文 + 尝试次数都会发回宿主",
    /let rightbarProbeError = "";/.test(SOURCE) &&
      /let rightbarAttempts = 0;/.test(SOURCE) &&
      /rightbarProbeError = String\(error\?\.message \?\? error\);/.test(SOURCE) &&
      /rightbarProbeError,\s*rightbarAttempts,/.test(SOURCE)
  );

  /* 固定入口：挂宿主自己的公开 slot（左侧栏底部 + 输入框 dock），
     跟任何别的插件的内部服务无关 —— 席位等不到也照挂在。 */
  check(
    "固定入口只有一处：左侧栏底部那颗按钮（宿主公开 slot，不看别人的内部服务）",
    guarded.slots.has("sidebar.footer.action") &&
      guarded.slots.get("sidebar.footer.action")?.options?.id === "velapi-image-go-launcher" &&
      // 只此一处：输入框 dock 不再挂第二颗，停靠层也不再自己浮胶囊
      !guarded.slots.has("conversation.composer.dock") &&
      /mountLauncher\("sidebar\.footer\.action", "sidebarFooter"\)/.test(SOURCE) &&
      !/composerDock/.test(SOURCE) &&
      !/vig-dock-launch/.test(SOURCE),
    [
      `has=${guarded.slots.has("sidebar.footer.action")}`,
      `id=${guarded.slots.get("sidebar.footer.action")?.options?.id}`,
      `dock=${guarded.slots.has("conversation.composer.dock")}`,
      `call=${/mountLauncher\("sidebar\.footer\.action", "sidebarFooter"\)/.test(SOURCE)}`,
      `composerDock=${/composerDock/.test(SOURCE)}`,
      `pill=${/vig-dock-launch/.test(SOURCE)}`
    ].join(" ")
  );
  check(
    "入口按钮只做一件事：把常驻面板滚到眼前（面板固定，不需要手动展开）",
    /function openWorkbench\(\)/.test(SOURCE) &&
      /sidebarRight\.openTab\(KIND\)/.test(SOURCE) &&
      (() => {
        const markup = renderToStaticMarkup(React.createElement(guarded.module.__internals.WorkbenchLauncher, null));
        return markup.includes('class="vig-launch"') && markup.includes(">生图工作台<") && /\.vig-launch\{/.test(css);
      })()
  );
  check(
    "入口按钮在宿主侧栏里不靠我们的 token 活着（那边没有 --vig-*，全部要有兜底）",
    (() => {
      const block = css.slice(css.indexOf(".vig-launch{"), css.indexOf(".vig-launch-text{"));
      const vars = [...block.matchAll(/var\((--vig-[a-z-]+)([^)]*)\)/g)];
      // 每一处 var(--vig-*) 都必须带兜底值（第二个参数）
      return vars.length > 0 && vars.every((match) => match[2].trim().startsWith(",")) && block.includes("color:inherit") && block.includes("font:inherit");
    })()
  );
  check(
    "默认落点不再押右侧栏席位（rightbar 变成可选项）",
    /: \["rightbar", "settings"\];/.test(SOURCE) &&
      /rightbar"\]/.test(SOURCE) === false &&
      /launchers,/.test(SOURCE)
  );
}
check(
  "自检回执：apply / 落定两次上报，带服务面与页面实况（下次入口再丢就不用猜了）",
  /function reportClient\(phase, detail\)/.test(SOURCE) &&
    /`\$\{API\}\/client-report`/.test(SOURCE) &&
    /reportClient\("apply", serviceSnapshot\(ctx\)\)/.test(SOURCE) &&
    /reportClient\("settled"/.test(SOURCE) &&
    /function serviceSnapshot\(scope\)/.test(SOURCE) &&
    /hasKind/.test(SOURCE) &&
    /guide:/.test(SOURCE) &&
    /function domSnapshot\(\)/.test(SOURCE) &&
    /guideHost: document\.querySelectorAll\("\[data-sidebar-right-guide\]"\)\.length/.test(SOURCE) &&
    /launcher: Boolean\(document\.querySelector\("\.vig-launch"\)\)/.test(SOURCE)
);

const dockHtml = (pane, open) =>
  renderToStaticMarkup(React.createElement(RightDock, { initialPane: pane, initialOpen: open, initialWidth: 420 }));
const hiddenPaneHtml = dockHtml({ mounted: true, visible: false }, false);
check(
  "渲染层：宿主把 tab 藏着 + 面板常驻 → 照旧渲染面板本体（没有收起这一档）",
  hiddenPaneHtml.includes("vig-dock-body") && !/<button class="vig-dock-launch"/.test(hiddenPaneHtml),
  hiddenPaneHtml.slice(0, 96)
);
check(
  "渲染层：侧栏正显示工作台 → 渲染为空，不重复占位",
  dockHtml({ mounted: true, visible: true }, true) === "" && dockHtml({ mounted: true, visible: true }, false) === ""
);
const openDockHtml = dockHtml({ mounted: true, visible: false }, true);
check(
  "渲染层：面板开着时是停靠面板本体而不是胶囊",
  openDockHtml.includes('class="vig-dock"') && !/<button class="vig-dock-launch"/.test(openDockHtml),
  openDockHtml.slice(0, 120)
);
check(
  "内部把手 setPaneState/paneState 能读回侧栏状态（给真浏览器测试用）",
  typeof mounted.module.__internals.setPaneState === "function" &&
    mounted.module.__internals.paneState().mounted === false
);

/* ---- 10. 四点透视矫正（变形 / 四点畸变 / 自由拉伸） -------------------- *
 * 三种方式共用一套投影变换，所以纯函数这边先钉死：矩阵解对、逆矩阵回得来、
 * 拉平尺寸按对边平均、退化（三点共线）必须判死、拖角夹在图里。 */
{
  const w = mounted.module.__internals;
  const src = w.psQuadInset(200, 100, 0.08);
  check(
    "四点初值：内缩之后留出抓手余量，顺序是 左上→右上→右下→左下",
    JSON.stringify(src) === JSON.stringify([{ x: 16, y: 8 }, { x: 184, y: 8 }, { x: 184, y: 92 }, { x: 16, y: 92 }]),
    JSON.stringify(src)
  );
  const rect = w.psQuadCorners(168, 84);
  const H = w.psHomography(src, rect);
  const corners = src.map((point) => w.psApplyH(H, point));
  check(
    "单应矩阵把源四点逐个打在目标四点上",
    corners.every((point, index) => Math.abs(point.x - rect[index].x) < 1e-6 && Math.abs(point.y - rect[index].y) < 1e-6),
    JSON.stringify(corners.map((p) => ({ x: Math.round(p.x * 100) / 100, y: Math.round(p.y * 100) / 100 })))
  );
  const back = w.psApplyH(w.psInvertH(H), { x: 0, y: 0 });
  check("逆矩阵把目标左上角送回源左上角", Math.abs(back.x - 16) < 1e-6 && Math.abs(back.y - 8) < 1e-6, JSON.stringify(back));
  check("拉平尺寸按对边平均：168 × 84", JSON.stringify(w.psQuadFlatSize(src)) === JSON.stringify({ w: 168, h: 84 }));
  check(
    "三点共线 / 重合判死，不给矩阵",
    w.psHomography([{ x: 0, y: 0 }, { x: 1, y: 1 }, { x: 2, y: 2 }, { x: 3, y: 1 }], rect) === null &&
      w.psHomography([{ x: 5, y: 5 }, { x: 5, y: 5 }, { x: 5, y: 5 }, { x: 5, y: 5 }], rect) === null
  );
  const freePlan = w.psWarpPlan({ mode: "free", src, dst: [{ x: 10, y: 20 }, { x: 120, y: 5 }, { x: 150, y: 90 }, { x: 20, y: 70 }], width: 200, height: 100 });
  check(
    "自由拉伸：输出画布贴目标四点的外接矩形，目标点平移到原点",
    freePlan.size.w === 140 && freePlan.size.h === 85 && freePlan.bounds.x === 10 && freePlan.bounds.y === 5 && freePlan.to[0].x === 0 && freePlan.to[0].y === 15,
    JSON.stringify({ size: freePlan.size, bounds: freePlan.bounds, to: freePlan.to })
  );
  check(
    "变形方式：取图四点固定是整图四角（跟 free 的取图四点不是一回事）",
    JSON.stringify(w.psWarpPlan({ mode: "distort", src: w.psQuadCorners(200, 100), dst: freePlan ? [{ x: 10, y: 20 }, { x: 120, y: 5 }, { x: 150, y: 90 }, { x: 20, y: 70 }] : null, width: 200, height: 100 }).from) ===
      JSON.stringify(w.psQuadCorners(200, 100))
  );
  check(
    "拖角夹在图内（-50 / 9999 这种拖出去的值收回来）",
    JSON.stringify(w.psMoveQuadPoint(src, 0, { x: -50, y: 9999 }, 200, 100)[0]) === JSON.stringify({ x: 0, y: 100 })
  );
  check(
    "命中判定：取最近的角，超出半径不算命中",
    w.psHitQuad(src, { x: src[1].x + 3, y: src[1].y }, 10)?.index === 1 && w.psHitQuad(src, { x: 100, y: 50 }, 10) === null
  );
  check(
    "样式闸门：十字光标 + 三段方式切换（三列）",
    /\.vig-ps-canvas\.is-warp\{cursor:crosshair/.test(css) && /\.vig-ps-seg\.is-3\{grid-template-columns:repeat\(3,1fr\)\}/.test(css)
  );
  check(
    "接线：原图侧拖的是图片坐标，结果侧按按下去那刻的比例折回图片坐标（中途不跟指针打架）",
    /drag\.which === "src" \? \{ \.\.\.value, src: moved \} : \{ \.\.\.value, dst: moved \}/.test(SOURCE) &&
      /const at = drag\.which === "dst" && drag\.k \? \{ x: point\.x \/ drag\.k \+ drag\.bounds\.x, y: point\.y \/ drag\.k \+ drag\.bounds\.y \} : point;/.test(SOURCE) &&
      /setDrag\(\{ mode: "warp", which: "dst", index: hit\.index, origin: warp\.dst, k, bounds: \{ x: plan\.bounds\.x, y: plan\.bounds\.y \} \}\)/.test(SOURCE)
  );
  check(
    "不用点应用：拖的过程就是结果，落定走 bakeWarp（换工具/回车收口，导出按全分辨率现算）",
    /const baked = warpFullCanvas\(\);/.test(SOURCE) &&
      // 透视落定时把同一份 plan 一起提交：图层 / 蒙版跟着底图一起变形（不再是 commit(baked, null)）
      /commit\(baked, null, \{ kind: "warp", plan \}\)/.test(SOURCE) &&
      /if \(previous === "warp" && tool !== "warp"\) bakeWarp\(true\);/.test(SOURCE) &&
      /const live = stage && plan && !psQuadsEqual\(plan\.from, plan\.to\) \? warpFullCanvas\(\) : null;/.test(SOURCE) &&
      /case "warp":\s*\n\s*applyWarp\(\);/.test(SOURCE) &&
      // 面板里不能再出现「应用」那个按钮
      !/is-primary", disabled: !plan, onClick: applyWarp/.test(SOURCE)
  );
  check(
    "实时：四点一动就重算结果（拖动中降采样、松手按屏幕比例补一张），结果侧主画布直接贴结果",
    /setWarpView\(renderWarpView\(Boolean\(drag && drag\.mode === "warp"\)\)\);/.test(SOURCE) &&
      /const outScale = warpOnDst \? \(fast \? Math\.min\(scale, 720 \/ span\) : scale\) : Math\.min\(1, 640 \/ span\);/.test(SOURCE) &&
      /const srcMax = warpOnDst && !fast \? 0 : 1024;/.test(SOURCE) &&
      /const shown = warpStageView \|\| stage;/.test(SOURCE) &&
      /ctx\.drawImage\(shown, 0, 0\);/.test(SOURCE)
  );
  const warpShot = renderToStaticMarkup(
    React.createElement(w.PsView, {
      state: { library: [] },
      actions: {},
      initial: { name: "歪图.png", width: 400, height: 300, preview: "data:image/png;base64,AAAA", tool: "warp" }
    })
  );
  check(
    "参数栏：三种方式 + 视图切换 + 读数位，工具条里这颗按钮也在，没有「应用」（也没有实时小窗口）",
    warpShot.includes(">四点畸变<") &&
      warpShot.includes(">自由拉伸<") &&
      warpShot.includes(">变形<") &&
      warpShot.includes(">重置四点<") &&
      warpShot.includes(">原图<") &&
      warpShot.includes(">结果<") &&
      // SSR 不跑 effect，四点还是 null，所以这里读的是「还没摆点」的提示；
      // 摆好之后的那行读数由 ps.warp.out 的文案单独钉（下面那一条）
      warpShot.includes('class="vig-ps-readout"') &&
      warpShot.includes("拖角点定位置") &&
      warpShot.includes("边拖边出结果") &&
      !warpShot.includes(">应用<") &&
      !/vig-ps-live/.test(warpShot) &&
      /class="vig-ps-tool[^"]*" title="透视矫正/.test(warpShot),
    (warpShot.match(/class="vig-ps-readout"[^>]*>[^<]*</) || [])[0]
  );
  check(
    "输出尺寸那行文案带得上宽高",
    w.text("ps.warp.out", { w: "168", h: "84" }) === "输出 168 × 84",
    w.text("ps.warp.out", { w: "168", h: "84" })
  );
  check(
    "三种方式各有自己的说明，切方式换的是做法不是文案重复",
    new Set(["flat", "free", "distort"].map((id) => w.text(`ps.warp.hint.${id}`))).size === 3
  );
  const quad = (pad) => [{ x: pad, y: pad }, { x: 256 - pad, y: pad }, { x: 256 - pad, y: 256 - pad }, { x: pad, y: 256 - pad }];
  const seeded = (warpMode, warp) =>
    renderToStaticMarkup(
      React.createElement(w.PsView, {
        state: { library: [] },
        actions: {},
        initial: { name: "歪图.png", width: 256, height: 256, preview: "data:image/png;base64,AAAA", tool: "warp", warpMode, warp }
      })
    );
  const flatShot = seeded("flat", { src: quad(16) });
  check(
    "静态预览（没有真 canvas）也画得出取图四点：多边形 + 四个编号手柄 + 读数",
    (flatShot.match(/<polygon points="16,16 240,16 240,240 16,240"/g) || []).length === 1 &&
      (flatShot.match(/<rect /g) || []).length === 4 &&
      (flatShot.match(/<text /g) || []).length === 4 &&
      (flatShot.match(/class="vig-ps-warp-shot"/g) || []).length === 1 &&
      flatShot.includes("输出 224 × 224"),
    (flatShot.match(/class="vig-ps-readout"[^>]*>[^<]*</) || [])[0]
  );
  const freeShot = seeded("free", { src: quad(16), dst: [{ x: 20, y: 40 }, { x: 240, y: 10 }, { x: 230, y: 250 }, { x: 10, y: 200 }] });
  check(
    "自由拉伸：墨黑与橙色两块四边形都画出来（两个多边形、两种颜色）",
    (freeShot.match(/<polygon /g) || []).length === 2 && freeShot.includes('stroke="#0b0b0c"') && freeShot.includes('stroke="#f08a24"')
  );
  check(
    "读数不再依赖真 canvas：只给宽高也能算出输出尺寸（预览/SSR 同一套）",
    seeded("flat", { src: quad(16) }).includes("输出 224 × 224") && !/拖角点定位置/.test(seeded("flat", { src: quad(16) }))
  );
  /* ---- 这一轮的两处返工：四点贴最外圈 + 移动实时（不用按应用） ---- */
  check(
    "四点初值贴着图片最外圈（不再内缩一圈），三种方式都从四角起手",
    JSON.stringify(w.psQuadCorners(200, 100)) === JSON.stringify([{ x: 0, y: 0 }, { x: 200, y: 0 }, { x: 200, y: 100 }, { x: 0, y: 100 }]) &&
      /const corners = psQuadCorners\(width, height\);/.test(SOURCE) &&
      /return mode === "distort" \? \{ src: corners, dst: corners \} : mode === "free" \? \{ src: corners, dst: corners \} : \{ src: corners, dst: null \};/.test(SOURCE) &&
      // 初值贴边 ⇒ flat 一进来输出就是整张图那么大
      (() => {
        const plan = w.psWarpPlan({ mode: "flat", src: w.psQuadCorners(200, 100), width: 200, height: 100 });
        return plan.size.w === 200 && plan.size.h === 100;
      })()
  );
  check(
    "矩阵相乘 / 缩放矩阵：作用顺序是「先右后左」，拼出来的结果能对得上单点手算",
    JSON.stringify(w.psMatMul(w.psScaleH(2, 3), w.psScaleH(5, 7))) === JSON.stringify(w.psScaleH(10, 21)) &&
      JSON.stringify(w.psMatMul(w.psScaleH(2, 2), [1, 0, 4, 0, 1, 6, 0, 0, 1])) === JSON.stringify([2, 0, 8, 0, 2, 12, 0, 0, 1]) &&
      JSON.stringify(w.psMatMul([1, 0, 0, 0, 1, 0, 0, 0, 1], w.psScaleH(3, 4))) === JSON.stringify(w.psScaleH(3, 4))
  );
  {
    const plan = w.psWarpPlan({ mode: "flat", src: quad(16), width: 256, height: 256 });
    const prep = w.psWarpPreview(plan, { outScale: 0.5, srcW: 256, srcH: 256, srcMax: 128 });
    const origin = w.psApplyH(prep.H, { x: 0, y: 0 });
    const far = w.psApplyH(prep.H, { x: prep.w, y: prep.h });
    check(
      "预览计划：输出和源各降一档，缩放并进矩阵 —— 预览左上角仍对着源图四点的左上角",
      prep.w === 112 && prep.h === 112 &&
        prep.outScale === 0.5 && Math.abs(prep.srcScale - 0.5) < 1e-9 &&
        Math.abs(origin.x - 16 * 0.5) < 1e-6 && Math.abs(origin.y - 16 * 0.5) < 1e-6 &&
        // 右下角同理落在源图四点的右下角（缩过之后）
        Math.abs(far.x - 240 * 0.5) < 1e-4 && Math.abs(far.y - 240 * 0.5) < 1e-4,
      JSON.stringify({ prep: { w: prep.w, h: prep.h, outScale: prep.outScale, srcScale: prep.srcScale }, origin, far })
    );
    check(
      "预览计划不缩放时就是原样（k = q = 1，矩阵等于逆矩阵）",
      (() => {
        const raw = w.psWarpPreview(plan, { outScale: 1, srcW: 256, srcH: 256, srcMax: 0 });
        return raw.outScale === 1 && raw.srcScale === 1 && raw.w === plan.size.w && raw.h === plan.size.h && JSON.stringify(raw.H) === JSON.stringify(plan.inverse);
      })()
    );
    check(
      "预览计划也扛得住放大（缩放比 > 1 时输出跟着放大，坐标关系不变）",
      (() => {
        const zoomed = w.psWarpPreview(plan, { outScale: 2, srcW: 256, srcH: 256, srcMax: 0 });
        const mid = w.psApplyH(zoomed.H, { x: zoomed.w / 2, y: zoomed.h / 2 });
        const ref = w.psApplyH(plan.inverse, { x: plan.size.w / 2, y: plan.size.h / 2 });
        return zoomed.w === 448 && zoomed.h === 448 && Math.abs(mid.x - ref.x) < 1e-6 && Math.abs(mid.y - ref.y) < 1e-6;
      })()
    );
  }
  check(
    "动没动过用 psQuadsEqual 判：贴边初值 == 自动矩形，所以一进一出不会往历史里塞多余的图",
    w.psQuadsEqual(w.psQuadCorners(200, 100), w.psQuadCorners(200, 100)) === true &&
      w.psQuadsEqual(w.psQuadCorners(200, 100), w.psQuadInset(200, 100, 0.08)) === false &&
      w.psQuadsEqual(null, w.psQuadCorners(200, 100)) === false &&
      (() => {
        // flat 初值：from 就是四角，to 是自动矩形（同一个位置）⇒ 判定为「没动过」
        const plan = w.psWarpPlan({ mode: "flat", src: w.psQuadCorners(200, 100), width: 200, height: 100 });
        return w.psQuadsEqual(plan.from, plan.to) === true;
      })()
  );
  check(
    "凹进去 / 自交的四点判死：单应矩阵会把画面翻到四边形外面，宁可不给计划",
    w.psQuadConvex(w.psQuadCorners(200, 100)) === true &&
      w.psQuadConvex([{ x: 10, y: 10 }, { x: 190, y: 10 }, { x: 190, y: 90 }, { x: 100, y: 50 }]) === false &&
      w.psQuadConvex([{ x: 0, y: 0 }, { x: 100, y: 100 }, { x: 100, y: 0 }, { x: 0, y: 100 }]) === false &&
      w.psQuadConvex([{ x: 0, y: 0 }, { x: 10, y: 0 }, { x: 20, y: 0 }, { x: 0, y: 10 }]) === false &&
      w.psWarpPlan({ mode: "distort", src: w.psQuadCorners(200, 100), dst: [{ x: 10, y: 10 }, { x: 190, y: 10 }, { x: 190, y: 90 }, { x: 100, y: 50 }], width: 200, height: 100 }) === null &&
      w.psWarpPlan({ mode: "flat", src: [{ x: 10, y: 10 }, { x: 190, y: 10 }, { x: 190, y: 90 }, { x: 100, y: 50 }], width: 200, height: 100 }) === null
  );
  check(
    "样式闸门：没有面板小窗口（实时就在画布上）+ 结果侧画布不吃缩放（1:1 摆）",
    !/vig-ps-live/.test(css) && !/vig-ps-live/.test(SOURCE) && !/warpLiveRef/.test(SOURCE) &&
      /const cssPerPx = warpStageView \? 1 : scale;/.test(SOURCE) &&
      /const canvasW = Math\.max\(1, Math\.round\(shownW \* cssPerPx\)\);/.test(SOURCE)
  );
  check(
    "实时在原图这一侧的画布上：结果裁进蓝四点围出的框里贴回去，框外还是原图",
    /const quad = psQuadPoints\(plan\.from\);/.test(SOURCE) &&
      /const box = psQuadBounds\(plan\.from\);/.test(SOURCE) &&
      /ctx\.clip\(\);/.test(SOURCE) &&
      /ctx\.drawImage\(warpView, box\.x, box\.y, box\.w, box\.h\);/.test(SOURCE) &&
      /if \(warpStageView \|\| !plan \|\| !warpView\) return;/.test(SOURCE)
  );
}

/* ---- 4e. 上游报错摆出来 + 供应商端点协议 --------------------------- */

{
  const w = boot().module.__internals;
  const noop = new Proxy({}, { get: () => () => {} });
  const FAILED = {
    id: "job_1",
    status: "failed",
    prompt: "生成一个小恐龙",
    model: "grok-imagen-image-2.0",
    size: "1024x1024",
    endpoint: "/images/generations",
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
      body: '{"error":{"message":"生成请求失败，请查看具体上游错误"}}'
    }
  };

  check(
    "协议表：11 条，含图片编辑与视频生成这两条新链",
    w.PROTOCOL_IDS.length === 11 && w.PROTOCOL_IDS.includes("images_edits") && w.PROTOCOL_IDS.includes("videos_generations"),
    w.PROTOCOL_IDS.join(",")
  );
  check(
    "协议下拉是人话而不是裸 id",
    (() => {
      const options = w.protocolOptions([]);
      return (
        options.length === 11 &&
        options[0].label === "自动检测（默认）" &&
        options.find((item) => item.id === "images_edits").label === "图片编辑（/v1/images/edits）" &&
        options.find((item) => item.id === "videos_generations").label === "视频生成（/v1/videos/generations）"
      );
    })()
  );
  check(
    "宿主给了整表就以宿主那份为准（label 不各写一套）",
    (() => {
      const options = w.protocolOptions([{ id: "auto", label: "宿主说的自动" }, { id: "images_edits", label: "宿主说的编辑" }]);
      return options.length === 2 && options[0].label === "宿主说的自动" && options[1].label === "宿主说的编辑";
    })()
  );
  check(
    "协议短名：输入框那一行放得下的那种（长名留给 title）",
    w.protocolShortLabel("auto") === "自动检测" &&
      w.protocolShortLabel("images_edits") === "图片编辑" &&
      w.protocolShortLabel("videos_generations") === "视频生成" &&
      w.protocolShortLabel("whatever") === "自动检测" &&
      w.protocolLabel([], "images_edits").includes("/v1/images/edits")
  );

  const block = renderToStaticMarkup(React.createElement(w.JobError, { job: FAILED, onToast: () => {} }));
  check(
    "失败卡：状态 chip + 上游那句话 + 实际请求 + 响应体原文（一张卡说完，不叠三层红框）",
    block.includes("vig-fail") &&
      block.includes("HTTP 502 Bad Gateway") &&
      block.includes("POST https://gank.velapi.cc/v1/images/generations") &&
      block.includes("vig-fail-pre") &&
      block.includes("生成请求失败，请查看具体上游错误") &&
      (block.match(/class="vig-fail"/g) || []).length === 1 &&
      !block.includes("vig-error"),
    block.slice(0, 170)
  );
  check(
    "失败卡带复制按钮，复制的内容与屏幕上一致",
    block.includes("复制报错") &&
      (() => {
        const text = w.upstreamText(FAILED);
        return (
          text.includes("POST https://gank.velapi.cc/v1/images/generations") &&
          text.includes("HTTP 502 Bad Gateway") &&
          text.includes("code: upstream_502") &&
          text.includes('"message":"生成请求失败，请查看具体上游错误"')
        );
      })()
  );
  check(
    "老任务（没有原始证据）只摆一行：不摆空的请求行、也不说「上游没给响应体」",
    (() => {
      const plain = renderToStaticMarkup(React.createElement(w.JobError, { job: { error: "上游请求超时（300s）" }, onToast: () => {} }));
      return (
        plain.includes("失败") &&
        plain.includes("上游请求超时（300s）") &&
        !plain.includes("vig-fail-meta") &&
        !plain.includes("vig-fail-pre") &&
        !plain.includes("上游没给响应体") &&
        !plain.includes("undefined") &&
        !plain.includes("请求 —")
      );
    })()
  );
  check(
    "有证据但上游没给响应体时才明说一句",
    (() => {
      const empty = renderToStaticMarkup(
        React.createElement(w.JobError, {
          job: { error: "下载图片得到空响应", errorDetail: { kind: "download", url: "https://cdn/a.png", status: 200, body: "" } },
          onToast: () => {}
        })
      );
      return empty.includes("vig-fail-meta") && empty.includes("https://cdn/a.png") && empty.includes("上游没给响应体");
    })()
  );

  const bubble = renderToStaticMarkup(React.createElement(w.JobTurn, { job: FAILED, onReuseImage: () => {}, onToast: () => {}, onRetry: () => {} }));
  check(
    "一轮对话两条：我发的那句话靠右，工作台的回复靠左",
    (() => {
      const user = bubble.slice(bubble.indexOf("vig-turn is-user"), bubble.indexOf('class="vig-turn"'));
      return (
        bubble.indexOf("vig-turn is-user") >= 0 &&
        bubble.indexOf("vig-turn is-user") < bubble.indexOf('class="vig-turn"') &&
        user.includes("vig-me") &&
        user.includes("生成一个小恐龙") &&
        user.includes('title="我"') &&
        /\.vig-turn\.is-user\{justify-content:flex-end\}/.test(css) &&
        /\.vig-me\{[^}]*border-radius:14px 14px 4px 14px/.test(css)
      );
    })(),
    bubble.slice(0, 200)
  );
  check(
    "没有提示词的任务不摆空气泡（老记录 / 异常数据）",
    (() => {
      const bare = renderToStaticMarkup(React.createElement(w.JobTurn, { job: { id: "j", status: "succeeded", model: "m", size: "1024x1024", images: [] }, onToast: () => {} }));
      return !bare.includes("vig-turn is-user") && bare.includes('class="vig-turn"');
    })()
  );
  /* 过程留痕：这条任务是谁发起的，界面上要能看出来（老记录没有 source 就不显示） */
  check(
    "过程留痕：对话里标出这次是谁发起的（工作台 / 工具调用 / 外部接口），老记录不乱猜",
    (() => {
      const job = (patch) => renderToStaticMarkup(React.createElement(w.JobTurn, { job: { ...FAILED, ...patch }, onToast: () => {} }));
      const tool = job({ source: "tool", sessionId: "sess-abc" });
      const api = job({ source: "api" });
      const ui = job({ source: "ui" });
      const old = job({});
      return (
        tool.includes("来源 · 工具调用") &&
        tool.includes("会话 sess-abc") &&
        api.includes("来源 · 外部接口") &&
        ui.includes("来源 · 工作台") &&
        !old.includes("来源 ·")
      );
    })(),
    renderToStaticMarkup(React.createElement(w.JobTurn, { job: { ...FAILED, source: "tool", sessionId: "sess-abc" }, onToast: () => {} })).slice(0, 240)
  );

  /* 结果卡：图片自己一张卡，下面三个动作是纯文字按键（以前那块白底面板+分隔线像又一张卡） */
  check(
    "结果卡：图片单独一个圆角框，四个动作无底色、无分隔线、排一行（短名字 + title 全称）",
    (() => {
      const shot = renderToStaticMarkup(
        React.createElement(w.Shot, {
          image: { assetId: "a1", name: "cat.png", url: "/api/velapi-image-go/asset/a1.png", width: 10, height: 10 },
          onReuse: async () => {},
          onToast: () => {},
          onSave: () => {}
        })
      );
      return (
        shot.includes('class="vig-shot-img"') &&
        shot.includes('class="vig-shot"') &&
        (shot.match(/class="vig-mini vig-shot-act"/g) || []).length === 4 &&
        shot.includes('title="用这张重绘"') &&
        shot.includes('title="复制链接"') &&
        shot.includes('title="保存一份到本地文件夹') &&
        shot.includes('title="打开原图"') &&
        shot.includes('aria-label="用这张重绘"') &&
        /\.vig-shot-bar\{[^}]*justify-content:flex-end/.test(SOURCE) &&
        /\.vig-shot-bar \.vig-shot-act\{[^}]*border-radius:var\(--vig-r-pill\)/.test(SOURCE)
      );
    })(),
    "vig-shot-img / 4 个 vig-shot-act 图标"
  );
  /* 结果图按张数给画面占比：单图最大一半宽，多图收敛，四张起回到小格 */
  check(
    "结果图尺寸按张数自适应：单图最多占一半宽，两张/三张收敛，四张起回到小格",
    (() => {
      const images = (count) => Array.from({ length: count }, (_, index) => ({ assetId: `a${index}`, name: `p${index}.png`, url: `/api/velapi-image-go/asset/a${index}.png`, width: 512, height: 512 }));
      const turn = (count) =>
        renderToStaticMarkup(React.createElement(w.JobTurn, { job: { id: "j", status: "succeeded", prompt: "p", model: "m", size: "512x512", images: images(count) }, onToast: () => {}, onPreview: () => {} }));
      const one = turn(1);
      const two = turn(2);
      const three = turn(3);
      const four = turn(4);
      return (
        one.includes('class="vig-grid is-single"') &&
        one.includes('data-count="1"') &&
        two.includes('class="vig-grid is-duo"') &&
        two.includes('data-count="2"') &&
        three.includes('class="vig-grid is-trio"') &&
        three.includes('data-count="3"') &&
        four.includes('class="vig-grid"') &&
        !four.includes("is-single") &&
        /\.vig-grid\.is-single\{grid-template-columns:minmax\(0,50%\)\}/.test(SOURCE) &&
        /\.vig-grid\.is-duo\{grid-template-columns:repeat\(2,minmax\(0,36%\)\)\}/.test(SOURCE) &&
        /\.vig-grid\.is-trio\{grid-template-columns:repeat\(3,minmax\(0,30%\)\)\}/.test(SOURCE) &&
        /\.vig-root\[data-compact="1"\] \.vig-grid\.is-single\{grid-template-columns:minmax\(0,62%\)\}/.test(SOURCE)
      );
    })(),
    "1/2/3/4 张的 class 与 CSS"
  );
  /* 图片查看器：大图 + 翻页 + 缩放 + 动作；快捷拖拽：一张图能被拖到哪儿去 */
  {
    const ITEMS = [
      { assetId: "a1", name: "cat.png", url: "/api/velapi-image-go/asset/a1.png", width: 1024, height: 1024, model: "gpt-image-2.5-c", size: "1024x1024", prompt: "一只戴眼镜的橘猫" },
      { assetId: "a2", name: "dog.png", url: "/api/velapi-image-go/asset/a2.png", width: 512, height: 512, model: "nano-banana-2.1", size: "512x512", prompt: "一只柴犬" }
    ];
    const viewer = renderToStaticMarkup(
      React.createElement(ui.ImageViewer, { items: ITEMS, index: 0, onClose: () => {}, onIndex: () => {}, onToast: () => {}, onUseReference: () => {}, onEdit: () => {}, onDelete: () => {}, onSave: () => {}, onCopy: () => {} })
    );
    check(
      "查看器：标题 / 计数 / 提示词 / 元信息都在，大图铺在舞台里",
      viewer.includes('class="vig-viewer"') &&
        viewer.includes("cat.png") &&
        viewer.includes("1 / 2") &&
        viewer.includes("一只戴眼镜的橘猫") &&
        viewer.includes("gpt-image-2.5-c · 1024x1024 · 1024×1024") &&
        viewer.includes('class="vig-viewer-img"') &&
        viewer.includes('src="/api/velapi-image-go/asset/a1.png"')
    );
    check(
      "查看器：上一张 / 下一张 + 用作参考图 / 图片处理 / 保存到本地 / 复制图片 / 删除 都在（有回调才给）",
      viewer.includes("vig-viewer-nav is-prev") &&
        viewer.includes("vig-viewer-nav is-next") &&
        viewer.includes("用作参考图") &&
        viewer.includes("图片处理") &&
        viewer.includes("保存到本地") &&
        viewer.includes("复制图片") &&
        viewer.includes("删除") &&
        (() => {
          const bare = renderToStaticMarkup(React.createElement(ui.ImageViewer, { items: ITEMS, index: 0, onClose: () => {}, onIndex: () => {} }));
          return bare.includes("vig-viewer-nav is-prev") && !bare.includes("用作参考图") && !bare.includes("图片处理") && !bare.includes("删除") && !bare.includes("复制图片");
        })()
    );
    check(
      "复制图片：宿主剪贴板优先（写进去是真图片位图），网页剪贴板只当兜底",
      /if \(name && HOST_CAPS\?\.clipboard === true\)/.test(SOURCE) &&
        /async function copyImageToClipboard\(image\) \{/.test(SOURCE) &&
        /navigator\.clipboard\.write\(\[new ClipboardItem\(\{ "image\/png": blob \}\)\]\)/.test(SOURCE) &&
        /await call\("\/clipboard\/image", \{ method: "POST", body: \{ file: name \} \}\)/.test(SOURCE)
    );
    /* 纯网页剪贴板：不需要宿主重启也能把「图片本身」放进剪贴板 */
    {
      const written = [];
      const clipboardHost = boot(
        {},
        {
          ClipboardItem: class ClipboardItem {
            constructor(items) {
              this.items = items;
            }
          },
          navigator: {
            clipboard: {
              writeText: async () => {},
              write: async (items) => {
                written.push(items);
              }
            }
          },
          fetch: async () => ({ ok: true, status: 200, blob: async () => new Blob(["png-bytes"], { type: "image/png" }) })
        }
      );
      const w4 = clipboardHost.module.__internals;
      const ok = await w4.copyImageToClipboard({ url: "/api/velapi-image-go/asset/img_1.png", name: "cat.png" });
      check(
        "copyImageToClipboard：把 PNG blob 写进系统剪贴板",
        ok === true && written.length === 1 && written[0][0]?.items?.["image/png"] instanceof Object,
        JSON.stringify({ ok, written: written.length })
      );
      check(
        "下载文件：blob + <a download>（旧宿主也能用），不依赖宿主端点",
        /async function downloadImageFile\(image\) \{/.test(SOURCE) &&
          /URL\.createObjectURL\(blob\)/.test(SOURCE) &&
          /link\.download = assetFileName\(image\)/.test(SOURCE) &&
          /onDownload: actions\.downloadAsset/.test(SOURCE)
      );
    }
    check(
      "复制链接与复制图片分开：链接按钮标的是「复制的是链接文本」",
      /chat\.copyTitle/.test(SOURCE) && /"chat\.copyTitle": "复制的是链接文本/.test(SOURCE) && /chat\.copyImageTitle/.test(SOURCE)
    );
    check(
      "拖到别的程序 = 原生拖出：dragstart 里同步 POST /drag/native（不用按 Shift），成功后压掉 HTML5 拖拽",
      (() => {
        const calls = [];
        class FakeXhr {
          open(method, url, async) {
            this.method = method;
            this.url = url;
            this.async = async;
          }
          setRequestHeader() {}
          send(body) {
            calls.push({ method: this.method, url: this.url, async: this.async, body: JSON.parse(body || "{}") });
            this.status = 200;
          }
        }
        const nativeHost = boot({}, { XMLHttpRequest: FakeXhr });
        const w3 = nativeHost.module.__internals;
        // 能力表确认宿主支持原生拖拽（真机由 reload() 从 /capabilities 取）
        w3.setHostCapabilities({ electron: true, nativeDrag: true, clipboard: true });
        let prevented = false;
        w3.imageDragProps({ url: "/api/velapi-image-go/asset/img_9.png", name: "x.png" }).onDragStart({
          dataTransfer: { setData: () => {}, effectAllowed: "" },
          preventDefault: () => {
            prevented = true;
          }
        });
        const nativeCall = calls[0] ?? null;
        // 宿主不认原生拖拽（老宿主 / 非 Electron）时不许发同步请求，免得界面卡住
        w3.setHostCapabilities(null);
        const before = calls.length;
        w3.imageDragProps({ url: "/api/velapi-image-go/asset/img_9.png", name: "x.png" }).onDragStart({
          dataTransfer: { setData: () => {}, effectAllowed: "" },
          preventDefault: () => {}
        });
        return (
          nativeCall &&
          nativeCall.async === false &&
          /\/drag\/native$/.test(nativeCall.url) &&
          nativeCall.body.file === "img_9.png" &&
          prevented === true &&
          calls.length === before
        );
      })(),
      "sync XHR"
    );
    check(
      "查看器：缩放 / 翻页 / 关闭的键位与滚轮、拖拽平移都接了（原生 wheel 设 passive:false）",
      /event\.key === "Escape"/.test(SOURCE) &&
        /event\.key === "ArrowLeft"/.test(SOURCE) &&
        /event\.key === "ArrowRight"/.test(SOURCE) &&
        /addEventListener\("wheel", onWheel, \{ passive: false \}\)/.test(SOURCE) &&
        /onPointerDown: \(event\) => \{/.test(SOURCE) &&
        /translate\(\$\{pan\.x\}px, \$\{pan\.y\}px\) scale\(\$\{zoom\}\)/.test(SOURCE) &&
        /VIEWER_ZOOM_MAX = 8/.test(SOURCE)
    );

    /* 拖拽：自定义类型带 URL / 名称，uri-list 给浏览器，DownloadURL 给资源管理器 */
    const stored = {};
    const dataTransfer = {
      setData: (type, value) => {
        stored[type] = value;
      },
      effectAllowed: ""
    };
    const dragProps = ui.imageDragProps(ITEMS[0]);
    dragProps.onDragStart({ dataTransfer });
    check(
      "拖拽：拖起一张图会写自定义类型 + uri-list + DownloadURL（资源管理器可直接落文件）",
      dragProps.draggable === true &&
        JSON.parse(stored[ui.IMAGE_DRAG_TYPE] ?? "{}").url === "http://127.0.0.1:19387/api/velapi-image-go/asset/a1.png" &&
        stored["text/uri-list"] === "http://127.0.0.1:19387/api/velapi-image-go/asset/a1.png" &&
        String(stored.DownloadURL || "").startsWith("image/png:cat.png:http") &&
        stored["text/plain"] === stored["text/uri-list"]
    );
    check(
      "拖拽：接收端能从自定义类型 / uri-list 认出这张图（坏数据不炸）",
      (() => {
        const custom = ui.readImageDrag({ getData: (type) => (type === ui.IMAGE_DRAG_TYPE ? JSON.stringify({ url: "http://a/x.png", name: "x.png" }) : "") });
        const uri = ui.readImageDrag({ getData: (type) => (type === "text/uri-list" ? "http://a/y.png\r\n" : "") });
        const broken = ui.readImageDrag({ getData: () => "{not json" });
        const empty = ui.readImageDrag(null);
        return custom?.name === "x.png" && uri?.url === "http://a/y.png" && broken === null && empty === null;
      })()
    );
    check(
      "拖拽接进对话：输入区 drop 先看是不是本插件的图，是就读回字节挂成参考图",
      /const dragged = readImageDrag\(event\.dataTransfer\);/.test(SOURCE) &&
        /if \(actions\.attachImageUrl\) await actions\.attachImageUrl\(dragged\);/.test(SOURCE) &&
        /attachImageUrl: async \(image\) => \{/.test(SOURCE) &&
        /await actions\.attachReference\(\{ name: image\.name \|\| "image\.png", dataUrl \}\);/.test(SOURCE)
    );
    check(
      "结果卡与图库都能拖 / 都能开查看器（结果卡点击开 / 图库图片点击开 + 一个「图片查看器」按钮）",
      /onClick: \(\) => onPreview\?\.\(image\)/.test(SOURCE) &&
        /\.\.\.imageDragProps\(image\)/.test(SOURCE) &&
        /actions\.openViewer\(items, position, "library"\)/.test(SOURCE) &&
        /onPreview: actions\.openViewer/.test(SOURCE) &&
        /t\("viewer\.title"\)/.test(SOURCE)
    );
    check(
      "拖拽还带 text/html（富文本目标直接嵌图，不是贴一串 URL）",
      /transfer\.setData\("text\/html"/.test(SOURCE) && /<img src="\$\{absolute/.test(SOURCE) && String(stored["text/html"] || "").includes("<img src=\"http")
    );
    /* dsh-app:// 页面 URL 资源管理器取不回来，只会显示成文本：拿到本地 file:// 地址时优先用它 */
    {
      const fileHost = boot(
        {},
        {
          fetch: async (url) => ({
            ok: true,
            status: 200,
            text: async () =>
              String(url).includes("/asset/local")
                ? JSON.stringify({ ok: true, path: "C:\\x\\cat.png", fileUrl: "file:///C:/x/cat.png" })
                : "{}"
          })
        }
      );
      const w2 = fileHost.module.__internals;
      const got = {};
      const props2 = w2.imageDragProps(ITEMS[0]);
      props2.onPointerDown();
      await new Promise((resolve) => setTimeout(resolve, 20));
      props2.onDragStart({ dataTransfer: { setData: (key, value) => { got[key] = value; }, effectAllowed: "" } });
      check(
        "拖拽：pointerdown 先问本地路径，dragstart 时 DownloadURL 用 file:// 真文件",
        got.DownloadURL === "image/png:cat.png:file:///C:/x/cat.png",
        String(got.DownloadURL || "")
      );
    }
    check(
      "保存到本地：查看器 / 结果卡 / 图库都接 /asset/export，成功提示给出落盘路径",
      /exportAsset: async \(image\) => \{/.test(SOURCE) &&
        /call\("\/asset\/export", \{ method: "POST", body: \{ files: \[name\] \} \}\)/.test(SOURCE) &&
        /t\("common\.savedTo", \{ path: saved \}\)/.test(SOURCE) &&
        /onSave: actions\.exportAsset/.test(SOURCE) &&
        /onSave \? h\("button", \{ className: "vig-btn is-ghost is-sm", title: t\("chat\.saveTitle"\)/.test(SOURCE) &&
        /onClick: \(\) => void actions\.exportAsset\(asset\)/.test(SOURCE)
    );
  }

  /* 素材目录设置：默认本地，能改、能打开；换目录由宿主把素材复制过去 */
  check(
    "素材目录：设置块接到 /config(stateDir) 与 /state/reveal，并提示默认目录",
    /title: t\("prov\.storage"\), icon: "folder"/.test(SOURCE) &&
      /saveStateDir: async \(dir\) => \{/.test(SOURCE) &&
      /await call\("\/config", \{ method: "POST", body: \{ stateDir: dir \} \}\);/.test(SOURCE) &&
      /revealDir: async \(\) => \{/.test(SOURCE) &&
      /await call\("\/state\/reveal", \{ method: "POST", body: \{\} \}\);/.test(SOURCE) &&
      /t\("prov\.storageDefault"\)/.test(SOURCE)
  );
  check(
    "图片处理能接收「查看器 → 图片处理」带进来的图（initialUrl 载入一次就清）",
    /function PsView\(\{ state, actions, initial, initialUrl, onConsumeInitialUrl \}\)/.test(SOURCE) &&
      /if \(!initialUrl\?\.dataUrl\) return undefined;/.test(SOURCE) &&
      /await loadImage\(\{ name: initialUrl\.name, dataUrl: initialUrl\.dataUrl \}\);/.test(SOURCE) &&
      /initialUrl: psImage, onConsumeInitialUrl: actions\.clearPsImage/.test(SOURCE) &&
      /setPsImage\(\{ name: image\.name/.test(SOURCE)
  );

  check(
    "挂了参考图 + 选「图片编辑」协议：生成请求带 mode:edit 和参考图字节（别只发文字被 400）",
    /const wantsEdit = readyRefs\.length > 0 && \(editMode \|\| \(config\.defaultEndpoint \|\| "auto"\) === "images_edits"\)/.test(SOURCE) &&
      /let effectiveMode = wantsEdit \? "edit" : "generate"/.test(SOURCE) &&
      /image: sendImages\[0\]/.test(SOURCE) &&
      /images: sendImages/.test(SOURCE) &&
      /referenceUrls: effectiveReferenceUrls/.test(SOURCE)
  );
  check(
    "发送前把没有本站 URL 的参考图补传留档（两张变一张的根因）",
    /发送前把「还没有本站 URL」的参考图补一份留档/.test(SOURCE) &&
      /if \(!item\.url && typeof item\.dataUrl === "string" && item\.dataUrl\.startsWith\("data:"\)\) \{[\s\S]{0,220}await uploadRefData\(item\.name, item\.dataUrl\)/.test(SOURCE) &&
      /let effectiveReferenceUrls = readyRefs\.map\(\(item\) => item\.url \|\| ""\)\.filter\(Boolean\)/.test(SOURCE)
  );
  check(
    "对话上下文管理：生成前先 POST /chat/plan，把本会话历史交出去，改写结果进 planNote（userText 保留原话）",
    /await call\("\/chat\/plan", \{/.test(SOURCE) &&
      /const history = jobs[\s\S]{0,240}\.reverse\(\)/.test(SOURCE) &&
      /if \(plan\?\.ok && plan\.prompt\)/.test(SOURCE) &&
      /planNote = plan\.prompt/.test(SOURCE) &&
      /plan\.mode === "edit" && plan\.referenceUrl/.test(SOURCE) &&
      /userText: rawPrompt/.test(SOURCE) &&
      /planNote,/.test(SOURCE) &&
      /if \(contextOn\) \{/.test(SOURCE) &&
      /contextOn \? " is-on" : ""/.test(SOURCE) &&
      /"data-context-toggle": "1"/.test(SOURCE) && /contextPanelOpen \? "true" : "false"/.test(SOURCE)
  );
  check(
    "上下文管理改成对话式：点 ✨ 打开设置浮层（自动整理 / 轮数 / 限制直接出图 / 已读配置）",
    /className: "vig-ctx-pop"/.test(SOURCE) &&
      /"data-context-toggle": "1"/.test(SOURCE) &&
      /actions\.toggleContext\(\)/.test(SOURCE) &&
      /contextNoAutoImage/.test(SOURCE) &&
      /noAutoImage: contextNoAutoImage/.test(SOURCE) &&
      /chat\.contextWired/.test(SOURCE) &&
      /!contextNoAutoImage && plan\.mode === "edit"/.test(SOURCE)
  );
  check(
    "对话（会话）：新建 / 切换 / 重命名 / 删除都接宿主 /conversations，生成与重试带 conversationId",
    /switchConversation: async \(id\) => \{/.test(SOURCE) &&
      /call\("\/conversations", \{ method: "POST", body: \{\} \}\)/.test(SOURCE) &&
      /call\("\/conversations\/rename", \{ method: "POST", body: \{ id, title \} \}\)/.test(SOURCE) &&
      /call\("\/conversations\/delete", \{ method: "POST", body: \{ id \} \}\)/.test(SOURCE) &&
      /conversationId,$/m.test(SOURCE) &&
      /conversationId: job\.conversationId \|\| conversationId/.test(SOURCE) &&
      /className: "vig-conv", title: t\("chat\.convMemory"\)/.test(SOURCE) &&
      /!window\.confirm\(t\("chat\.confirmDeleteConv"\)\)/.test(SOURCE)
  );
  check(
    "会话记忆隔离：计划历史只取当前会话的 jobs（新对话 history 为空），气泡显示原话、改写单独一行",
    /const history = jobs\s*\n?\s*\.slice\(0, turns\)/.test(SOURCE) &&
      /job\.userText \|\| job\.prompt \|\| ""/.test(SOURCE) &&
      /job\.planNote && job\.planNote !== displayPrompt/.test(SOURCE) &&
      /t\("chat\.planRewrite"\)/.test(SOURCE)
  );
  check(
    "带着参考图发出去的消息：缩略图跟着我那条走（宿主只存 URL）",
    (() => {
      const withRef = renderToStaticMarkup(
        React.createElement(w.JobTurn, {
          job: { ...FAILED, referenceUrl: "/api/velapi-image-go/upload/up_1.png" },
          onToast: () => {}
        })
      );
      const without = renderToStaticMarkup(React.createElement(w.JobTurn, { job: FAILED, onToast: () => {} }));
      return (
        withRef.includes('class="vig-me-ref"') &&
        withRef.includes('src="/api/velapi-image-go/upload/up_1.png"') &&
        /\.vig-me-ref\{[^}]*object-fit:cover/.test(css) &&
        !without.includes("vig-me-ref")
      );
    })()
  );
  check(
    "轮询停了还挂着的任务不一直转圈：标 stale 并给「刷新」",
    (() => {
      const stale = renderToStaticMarkup(
        React.createElement(w.JobTurn, { job: { id: "j", status: "running", prompt: "跑着", model: "m", size: "1024x1024", stale: true }, onToast: () => {}, onRefresh: () => {} })
      );
      const fresh = renderToStaticMarkup(
        React.createElement(w.JobTurn, { job: { id: "j", status: "running", prompt: "跑着", model: "m", size: "1024x1024" }, onToast: () => {} })
      );
      return (
        stale.includes("状态未更新") &&
        stale.includes("宿主可能重启过") &&
        stale.includes(">刷新<") &&
        !stale.includes("vig-spin") &&
        fresh.includes("vig-spin") &&
        !fresh.includes("状态未更新")
      );
    })()
  );
  check(
    "刷新页面后接着轮询还挂着的任务（否则宿主跑完了界面还停在「生成中…」）",
    /const items = jobList\.items \|\| \[\];/.test(SOURCE) &&
      /if \(job\.status === "queued" \|\| job\.status === "running"\) watchRef\.current\?\.\(job\.id\);/.test(SOURCE) &&
      /const watchRef = useRef\(null\);\s*watchRef\.current = watchJob;/.test(SOURCE) &&
      /const STALE_MS = 6 \* 60 \* 1000;/.test(SOURCE) &&
      /if \(Date\.now\(\) - startedAt > STALE_MS\)/.test(SOURCE) &&
      /const actions = \{\r?\n\t+toast,\r?\n\t+reload,/.test(SOURCE)
  );
  check(
    "参考图上传拿回本站 URL，并随生成请求带出去（任务里只存 URL，不存 base64）",
    /const uploadRefData = async \(name, dataUrl\) => \{[\s\S]{0,300}call\("\/upload", \{ method: "POST", body: \{ name: name \|\| "reference\.png", data: dataUrl \} \}\)/.test(SOURCE) &&
      /setReferences\(\(current\) => current\.map\(\(item\) => \(item\.dataUrl === dataUrl && !item\.url \? \{ \.\.\.item, url \} : item\)\)\)/.test(SOURCE) &&
      /referenceUrl: effectiveReferenceUrls\[0\] \|\| ""/.test(SOURCE) &&
      /referenceUrls: effectiveReferenceUrls/.test(SOURCE) &&
      /referenceUrl: job\.referenceUrl \|\| ""/.test(SOURCE)
  );
  check(
    "选模型就把「当前供应商」切到模型所属那条（不切 => 界面显示上一条、请求也跟上一条跑）",
    /onChange: \(id\) => \{\s*const ownerId = providerIdForModel\(providers, config, id\);/.test(SOURCE) &&
      /activeProviderId: ownerId/.test(SOURCE) &&
      /h\(ModelPicker, \{\s*value: config\.defaultModel,/.test(SOURCE) &&
      /hints: catalog\.owners,/.test(SOURCE)
  );
  check(
    "生成 / 重试都按模型挑供应商（重试不照抄老任务里那条错的 providerId）",
    /providerId: providerIdForModel\(providers, config\),/.test(SOURCE) &&
      /providerId: providerIdForModel\(providers, config, retryModel\) \|\| job\.providerId \|\| config\.activeProviderId,/.test(SOURCE) &&
      // 检查器里那个「当前供应商」下拉也跟模型走，不然选完模型它还显示上一条
      /value: config\.activeProviderId \|\| providerIdForModel\(providers, config\) \|\| "",/.test(SOURCE)
  );
  check(
    "失败气泡里就这一张卡：原始报错 + 用这条提示词重试",
    bubble.includes("vig-fail") &&
      bubble.includes("HTTP 502") &&
      bubble.includes("vig-fail-pre") &&
      bubble.includes("/images/generations") &&
      bubble.includes("用这条提示词重试") &&
      !bubble.includes("vig-error") &&
      (bubble.match(/vig-fail-chip/g) || []).length === 1,
    bubble.slice(0, 170)
  );
  /* 「key 填得没错、地址不是这家」：宿主带回来的那句话要摆出来，别让人对着 401 干瞪眼 */
  check(
    "失败卡带上「key 和接口地址不是一家的」那句人话",
    (() => {
      const hinted = renderToStaticMarkup(
        React.createElement(w.JobTurn, {
          job: {
            ...FAILED,
            error: "invalid access key",
            errorDetail: {
              kind: "upstream",
              status: 401,
              method: "POST",
              url: "https://gank.velapi.cc/v1/images/generations",
              body: '{"error":{"message":"invalid access key"}}',
              hint: "密钥和接口地址不是一家的：这把 key 在 https://api.velapi.cc/v1 上可用（61 个模型），在 https://gank.velapi.cc/v1 上被拒（HTTP 401 invalid access key）。"
            }
          },
          onReuseImage: () => {},
          onToast: () => {},
          onRetry: () => {}
        })
      );
      return (
        hinted.includes('class="vig-fail-hint"') &&
        hinted.includes("不是一家的") &&
        hinted.includes("api.velapi.cc") &&
        /\.vig-fail-hint\{[^}]*white-space:pre-wrap/.test(SOURCE)
      );
    })(),
    "vig-fail-hint"
  );
  check(
    "测试连接失败时把结果留在弹窗里（成功/失败 + 证据 + 那句人话），不是一闪而过的提示条",
    /const \[testInfo, setTestInfo\] = useState\(null\)/.test(SOURCE) &&
      /const payload = await actions\.testProvider\(\{ id: dialog\.id, baseUrl: dialog\.baseUrl, apiKey: dialog\.apiKey \}\);[\s\S]{0,80}setTestInfo\(payload \?\? null\);/.test(SOURCE) &&
      /className: `vig-prov-test\$\{testInfo\.ok \? " is-ok" : " is-bad"\}`/.test(SOURCE) &&
      /testInfo\.hint \? h\("div", \{ className: "vig-prov-test-hint" \}, testInfo\.hint\) : null/.test(SOURCE) &&
      /provider\.keyMask|testInfo\.error \|\| t\("common\.failed"\)/.test(SOURCE)
  );
  check(
    "没有原始证据的失败气泡也只是一行（截图里那种三层红框不再出现）",
    (() => {
      const old = renderToStaticMarkup(
        React.createElement(w.JobTurn, { job: { id: "j", status: "failed", prompt: "x", model: "m", size: "1024x1024", error: "生成请求失败，请查看具体上游错误", errorCode: "502" }, onReuseImage: () => {}, onToast: () => {}, onRetry: () => {} })
      );
      return (old.match(/class="vig-fail"/g) || []).length === 1 && !old.includes("vig-fail-meta") && !old.includes("上游报错");
    })()
  );

  const video = renderToStaticMarkup(
    React.createElement(w.VideoResult, {
      job: { model: "veo_3_1", video: { model: "veo_3_1", url: "https://cdn.example.com/v.mp4", payload: { id: "vid_1", status: "processing" } } },
      onToast: () => {}
    })
  );
  check("视频任务：有地址给链接，原始任务体照样摆出来", video.includes("https://cdn.example.com/v.mp4") && video.includes("vid_1") && video.includes("vig-video"));
  const videoNoUrl = renderToStaticMarkup(
    React.createElement(w.VideoResult, { job: { model: "veo_3_1", video: { payload: { id: "vid_2" } } }, onToast: () => {} })
  );
  check("视频任务没给现成地址就直说，不假装出片", videoNoUrl.includes("上游返回的是任务体") && !videoNoUrl.includes("<video"));

  const chatView = renderToStaticMarkup(
    React.createElement(w.ChatView, {
      state: {
        config: { baseUrl: "", apiKeyEnv: "", keyMask: "••••", hasKey: true, defaultModel: "grok-imagen-image-2.0", defaultSize: "1024x1024", defaultQuality: "LOW", defaultCount: 1, defaultEndpoint: "images_edits", activeProviderId: "", _: 0 },
        providers: [],
        notes: [],
        protocols: [],
        jobs: [FAILED],
        pending: 0,
        draft: "",
        reference: null, references: [],
        editMode: false,
        generating: false,
        pickOpen: false,
        ready: true
      },
      actions: noop
    })
  );
  check(
    "信息流从上往下：老的在上、新的在下（宿主 /jobs 新的在前，界面反过来）",
    (() => {
      const base = {
        config: { baseUrl: "", apiKeyEnv: "", keyMask: "••••", hasKey: true, defaultModel: "m", defaultSize: "1024x1024", defaultQuality: "LOW", defaultCount: 1, defaultEndpoint: "auto", activeProviderId: "" },
        providers: [],
        notes: [],
        protocols: [],
        pending: 0,
        draft: "",
        reference: null, references: [],
        editMode: false,
        generating: false,
        pickOpen: false,
        ready: true
      };
      const makeJob = (id, prompt) => ({ id, status: "succeeded", prompt, model: "m", size: "1024x1024", images: [] });
      const html = renderToStaticMarkup(
        React.createElement(w.ChatView, { state: { ...base, jobs: [makeJob("job_new", "后说的那句"), makeJob("job_old", "先说的那句")] }, actions: noop })
      );
      const oldAt = html.indexOf("先说的那句");
      const newAt = html.indexOf("后说的那句");
      return oldAt >= 0 && newAt >= 0 && oldAt < newAt;
    })()
  );
  check(
    "我那条消息下面三个无底色 SVG 动作：重试 / 删除 / 编辑",
    (() => {
      const job = { id: "j1", status: "succeeded", prompt: "改一下这句", userText: "改一下这句", model: "m", size: "1024x1024", images: [] };
      const withActions = renderToStaticMarkup(
        React.createElement(w.JobTurn, { job, onToast: () => {}, onRetry: () => {}, onDelete: () => {}, onEdit: () => {} })
      );
      const bare = renderToStaticMarkup(React.createElement(w.JobTurn, { job, onToast: () => {} }));
      const row = withActions.slice(withActions.indexOf('class="vig-turn-acts"'));
      const rowHtml = row.slice(0, row.indexOf("</div>") + 6);
      const buttons = [...rowHtml.matchAll(/<button[^>]*title="([^"]*)"/g)].map((match) => match[1]);
      return (
        (rowHtml.match(/<button/g) || []).length === 3 &&
        buttons.length === 3 &&
        buttons[0] === "重试" &&
        buttons[1] === "删除" &&
        buttons[2].startsWith("编辑提示词") &&
        (rowHtml.match(/<svg/g) || []).length === 3 &&
        !bare.includes("vig-turn-acts") &&
        /\.vig-turn-acts \.vig-mini\{[^}]*background:none/.test(SOURCE) &&
        /\.vig-turn-acts \.vig-mini\{[^}]*border:0/.test(SOURCE)
      );
    })()
  );
  check(
    "重试 / 删除 / 编辑接的是 retryJob、/job/delete、填回输入框",
    /deleteJob: async \(job\) => \{/.test(SOURCE) &&
      /call\("\/job\/delete", \{ method: "POST", body: \{ ids: \[id\] \} \}\)/.test(SOURCE) &&
      /editJob: \(job\) => \{[\s\S]{0,220}setDraft\(prompt\.slice\(0, 500\)\)/.test(SOURCE) &&
      /onDelete: actions\.deleteJob/.test(SOURCE) &&
      /onEdit: actions\.editJob/.test(SOURCE)
  );
  check(
    "上下文模型判「纠正」：不出图，一句话回进会话历史（根治「越改越错」）",
    /if \(plan\?\.ok && plan\.action === "reply" && plan\.reply\)/.test(SOURCE) &&
      /call\("\/chat\/message", \{[\s\S]{0,80}reply: plan\.reply, conversationId,/.test(SOURCE) &&
      /setGenerating\(false\);[\s\S]{0,40}return;/.test(SOURCE)
  );
  check(
    "参考图字节只认真 data URI：URL 字符串不再当 image 发（37 字节假图根治），多张一起发",
    /typeof item\.dataUrl === "string" && item\.dataUrl\.startsWith\("data:"\) \? item\.dataUrl : null/.test(SOURCE) &&
      /images: sendImages/.test(SOURCE) &&
      /editJob: \(job\) => \{[\s\S]{0,900}urlToDataUrl\(url\)/.test(SOURCE) &&
      /!blob\.type\.startsWith\("image\/"\)\) return ""/.test(SOURCE)
  );
  check(
    "更新入口：先设计（检查 /update/check）+ 按需进度条（role=progressbar）",
    /call\("\/update\/check", \{ method: "POST", body: \{\} \}\)/.test(SOURCE) &&
      /updateState\.phase === "running"/.test(SOURCE) &&
      /role: "progressbar"/.test(SOURCE) &&
      /className: `vig-update-bar\$\{updateState\.phase === "unwired"/.test(SOURCE) &&
      /const PLUGIN_VERSION = "/.test(SOURCE) &&
      /updateState\.phase === "done"/.test(SOURCE)
  );
  check(
    "更新通道两段式：检查到 behind 后再点一次 → 拉取（/update/apply）并重启（/update/restart）",
    /call\("\/update\/apply", \{ method: "POST", body: \{\} \}\)/.test(SOURCE) &&
      /call\("\/update\/restart", \{ method: "POST", body: \{\} \}\)/.test(SOURCE) &&
      /updateInfoRef/.test(SOURCE) &&
      /update\.clickAgain/.test(SOURCE)
  );
  check(
    "显式模式切换：图片 / 对话（持久化，对话模式直接走 /chat/say 不生图）",
    /data-mode": "image"/.test(SOURCE) &&
      /data-mode": "dialog"/.test(SOURCE) &&
      /const MODE_KEY = "dsh\.velapi-image-go\.mode"/.test(SOURCE) &&
      /if \(sendMode === "dialog"\) \{/.test(SOURCE) &&
      /await replyWithChat\(rawPrompt\)/.test(SOURCE) &&
      /chat\.dialogNotReady/.test(SOURCE)
  );
  check(
    "上下文管理接聊天：plan 判不出且像聊天时走 /chat/say（不硬生图，也没单独的聊天模式开关）",
    /function looksLikeChat\(text\)/.test(SOURCE) &&
      /const replyWithChat = async \(text\) => \{/.test(SOURCE) &&
      /if \(!plan\?\.ok && looksLikeChat\(rawPrompt\)\)/.test(SOURCE) &&
      /await call\("\/chat\/agent", \{/.test(SOURCE) &&
      !/data-chat-mode/.test(SOURCE)
  );
  check(
    "模型 kind 只认目录元数据（不再按名字猜视频：wan3.0-video-1080p 不会被误切视频协议）",
    /function modelKindOf\(id, providers\)/.test(SOURCE) &&
      !/VIDEO_NAME_HINT/.test(SOURCE) &&
      /const selectedModelKind = modelKindOf\(config\.defaultModel, providers\)/.test(SOURCE)
  );
  check(
    "视频参数与图片配置分开：模型按 kind 过滤 + 比例/分辨率两段 + 视频张数固定 1",
    /const endpointKind = \(\(\) => \{/.test(SOURCE) &&
      /const pickerModels = usableModelsFor\(catalog\)/.test(SOURCE) &&
      /function videoSizeFor\(ratio, resolution\)/.test(SOURCE) &&
      /videoRatio: ratio, videoSize: videoSizeFor/.test(SOURCE) &&
      /videoResolution: resolution, videoSize: videoSizeFor/.test(SOURCE) &&
      /isVideoEndpoint \? config\.videoSize \|\| "1280x720" : config\.defaultSize/.test(SOURCE) &&
      /n: isVideoEndpoint \? 1 : config\.defaultCount/.test(SOURCE) &&
      /const VIDEO_SECONDS = \[/.test(SOURCE) &&
      /actions\.saveConfig\(\{ videoSeconds: event\.target\.value \}\)/.test(SOURCE) &&
      /seconds: isVideoEndpoint \? config\.videoSeconds \|\| "4" : ""/.test(SOURCE)
  );
  check(
    "查看器四点变形：角点可拖出图外，应用走单应逆变换 + 上传成新库图",
    /viewerQuadApply: async \(\{ name, data \}\) => \{/.test(SOURCE) &&
      /call\("\/upload", \{ method: "POST", body: \{ name, data \} \}\)/.test(SOURCE) &&
      /psWarpPlan\(\{ mode: "distort", src: psQuadCorners\(natural\.w, natural\.h\), dst: quad, width: natural\.w, height: natural\.h \}\)/.test(SOURCE) &&
      /psWarpCanvas\(srcCanvas, plan\.inverse, plan\.size\.w, plan\.size\.h\)/.test(SOURCE) &&
      /className: "vig-viewer-quad"/.test(SOURCE) &&
      /setQuadDrag\(handle\)/.test(SOURCE) &&
      /onQuadApply: actions\.viewerQuadApply/.test(SOURCE)
  );
  check(
    "reply 轮的气泡：原话 + 助手文字回复（不出图）",
    (() => {
      const html = renderToStaticMarkup(
        React.createElement(w.JobTurn, {
          job: {
            id: "m1",
            kind: "reply",
            status: "succeeded",
            prompt: "乱搞，S3 就是我发的参考图机器人",
            userText: "乱搞，S3 就是我发的参考图机器人",
            reply: "抱歉，S3 指的是你参考图里那台扫地机器人",
            model: "mock-chat",
            images: []
          },
          onToast: () => {}
        })
      );
      return (
        html.includes("乱搞，S3 就是我发的参考图机器人") &&
        html.includes("抱歉，S3 指的是你参考图里那台扫地机器人") &&
        !html.includes("vig-shot") &&
        (html.match(/class="vig-bubble"/g) || []).length === 2
      );
    })()
  );
  check(
    "发送串行化：对话端口与生图端口不并发（sendChain 队列 + clientSeq 排序）",
    /const sendChainRef = useRef\(Promise\.resolve\(\)\)/.test(SOURCE) &&
      /const runGenerateFlow = async \(rawPrompt, seq\) => \{/.test(SOURCE) &&
      /pendingSendsRef\.current >= 6/.test(SOURCE) &&
      /clientSeq: seq/.test(SOURCE) &&
      /Number\.isFinite\(Number\(job\.clientSeq\)\)/.test(SOURCE)
  );
  check(
    "刷新/切会话停在最新一条：贴底跟随（stickRef）+ 图片撑高补滚 + 上翻历史不抢滚动",
    /const list = jobs\.slice\(\);/.test(SOURCE) &&
      /Number\.isFinite\(Number\(job\.clientSeq\)\)/.test(SOURCE) &&
      /box\.scrollTop = box\.scrollHeight/.test(SOURCE) &&
      /const stickRef = useRef\(true\)/.test(SOURCE) &&
      /const nearBottom = box\.scrollHeight - box\.scrollTop - box\.clientHeight < 160/.test(SOURCE) &&
      /stickRef\.current = nearBottom/.test(SOURCE) &&
      /const jumpToBottom = \(\) => \{/.test(SOURCE) &&
      /className: "vig-bottom-jump"/.test(SOURCE) &&
      /box\.scrollTo\(\{ top: box\.scrollHeight, behavior: "smooth" \}\)/.test(SOURCE) &&
      /onScroll: trackStick/.test(SOURCE) &&
      /addEventListener\("load", onLoad, true\)/.test(SOURCE) &&
      /\}, \[conversationId\]\)/.test(SOURCE)
  );
  check(
    "信息卡：点开先快速选择（点一张插进输入框），二级「管理」才跳信息管理页",
    /className: "vig-note-pick", ref: noteBoxRef/.test(SOURCE) &&
      /className: `vig-tool\$\{noteOpen \? " is-on" : ""\}`/.test(SOURCE) &&
      /className: "vig-note-pop"/.test(SOURCE) &&
      /actions\.insertNote\(note\)/.test(SOURCE) &&
      /t\("notes\.pickManage"\)/.test(SOURCE) &&
      /setNoteOpen\(false\);[\s\S]{0,80}actions\.setView\("notes"\);/.test(SOURCE) &&
      /state\.notes\.length === 0[\s\S]{0,120}t\("notes\.pickEmpty"\)/.test(SOURCE)
  );
  check(
    "协议选择就在输入框那一行（模型 / 尺寸 / 张数后面），11 个选项、短名显示",
    (() => {
      const row = chatView.slice(chatView.indexOf('class="vig-tools"'));
      const start = row.indexOf('class="vig-sel vig-endpoint"');
      const select = row.slice(start, row.indexOf("</select>", start));
      const options = [...select.matchAll(/<option[^>]*value="([a-z_]+)"/g)].map((match) => match[1]);
      return (
        start >= 0 &&
        options.length === 11 &&
        options.includes("images_edits") &&
        options.includes("videos_generations") &&
        select.includes(">图片编辑<") &&
        !select.includes(">/v1/images/edits<")
      );
    })(),
    chatView.slice(chatView.indexOf("vig-endpoint"), chatView.indexOf("vig-endpoint") + 200)
  );
  check(
    "尺寸下拉同时给比例与分辨率（1:1 · 1024×1024 / 16:9 · 1536×864 …），老尺寸补「自定义」",
    (() => {
      const options = ui.SIZE_OPTIONS;
      const labels = options.map((option) => ui.sizeOptionLabel(option));
      const custom = ui.sizeOptionsFor("512x512");
      return (
        options.length >= 8 &&
        labels.includes("1:1 · 1024×1024") &&
        labels.includes("16:9 · 1536×864") &&
        labels.includes("9:16 · 864×1536") &&
        labels.includes("16:9 · 2K · 2048×1152") &&
        ui.sizeOptionTitle(options[0]) === "1:1 · 1024×1024" &&
        custom[0]?.value === "512x512" &&
        ui.sizeOptionLabel(custom[0]) === "自定义 · 512×512" &&
        chatView.includes(">1:1 · 1024×1024</option>")
      );
    })(),
    (ui.SIZE_OPTIONS || []).map((option) => ui.sizeOptionLabel(option)).join(" | ")
  );
  check(
    "对话输入下面不再有报错 UI（报错只在气泡里）",
    (() => {
      const row = chatView.slice(chatView.indexOf('class="vig-tools"'));
      const tools = row.slice(0, row.indexOf("vig-count"));
      return !tools.includes("vig-fail") && !tools.includes("看原始报错") && tools.includes("vig-endpoint");
    })(),
    `${chatView.length} bytes`
  );
  const chatClean = renderToStaticMarkup(
    React.createElement(w.ChatView, {
      state: {
        config: { baseUrl: "", apiKeyEnv: "", keyMask: "••••", hasKey: true, defaultModel: "m", defaultSize: "1024x1024", defaultQuality: "LOW", defaultCount: 1, defaultEndpoint: "auto", activeProviderId: "" },
        providers: [],
        notes: [],
        protocols: [],
        jobs: [{ id: "job_ok", status: "succeeded", prompt: "ok", model: "m", size: "1024x1024", images: [] }],
        pending: 0,
        draft: "",
        reference: null, references: [],
        editMode: false,
        generating: false,
        pickOpen: false,
        ready: true
      },
      actions: noop
    })
  );
  check("没失败时气泡里也不摆报错（不占位、不吓人）", !chatClean.includes("vig-fail"));

  check(
    "协议选择本地也存一份（宿主老版本还没有 config.defaultEndpoint，刷新别把选择弄丢）",
    /const ENDPOINT_KEY = "dsh\.velapi-image-go\.endpoint"/.test(SOURCE) &&
      /window\.localStorage\.getItem\(ENDPOINT_KEY\) \|\| "auto"/.test(SOURCE) &&
      /window\.localStorage\.setItem\(ENDPOINT_KEY, config\.defaultEndpoint/.test(SOURCE) &&
      /defaultEndpoint: status\.config\?\.defaultEndpoint \|\| previous\.defaultEndpoint \|\| "auto"/.test(SOURCE)
  );
  check(
    "保存配置是乐观更新 + 合并回包：宿主吞掉字段也不许把刚选的值冲回默认（协议选不动那个 bug）",
    /setConfig\(\(previous\) => \(\{ \.\.\.previous, \.\.\.patch \}\)\)/.test(SOURCE) &&
      /setConfig\(\(previous\) => \(\{\s*\.\.\.previous,\s*\.\.\.payload\.config,/.test(SOURCE) &&
      /defaultEndpoint: payload\.config\?\.defaultEndpoint \|\| previous\.defaultEndpoint \|\| "auto"/.test(SOURCE) &&
      // 老写法是直接覆盖：宿主回包里没有这一项，用户的选择就没了
      !/setConfig\(payload\.config\);/.test(SOURCE)
  );

  /* 粘贴图片：截图工具 / 网页图片 / 文件管理器复制过来的都该认，纯文字粘贴不许拦。 */
  const imageItem = { kind: "file", type: "image/png", getAsFile: () => ({ name: "image.png", type: "image/png" }) };
  const textItem = { kind: "string", type: "text/plain", getAsFile: () => null };
  check(
    "从剪贴板挑图：items 里的图片认，纯文字不认",
    w.pickClipboardImage({ items: [textItem, imageItem] })?.name === "image.png" &&
      w.pickClipboardImage({ items: [textItem] }) === null &&
      w.pickClipboardImage({ items: [] }) === null &&
      w.pickClipboardImage(undefined) === null &&
      w.pickClipboardImage({}) === null
  );
  check(
    "老浏览器只看 files；非图片的 file 一律不认",
    w.pickClipboardImage({ files: [{ name: "a.png", type: "image/png" }] })?.name === "a.png" &&
      w.pickClipboardImage({ files: [{ name: "a.pdf", type: "application/pdf" }] }) === null &&
      w.pickClipboardImage({ items: [{ kind: "file", type: "application/pdf", getAsFile: () => ({ type: "application/pdf" }) }] }) === null
  );
  check(
    "粘贴的图有像样的名字（image.png / blob 这种通用名换成带时间的）",
    w.pastedImageName({ name: "截图 2026-10-19.png", type: "image/png" }) === "截图 2026-10-19.png" &&
      w.pastedImageName({ name: "产品图.png", type: "image/png" }) === "产品图.png" &&
      /^粘贴的图片-\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}\.png$/.test(w.pastedImageName({ name: "image.png", type: "image/png" })) &&
      /^粘贴的图片-[\dT-]+\.jpg$/.test(w.pastedImageName({ name: "blob", type: "image/jpeg" })) &&
      /^粘贴的图片-[\dT-]+\.png$/.test(w.pastedImageName({}))
  );
  check(
    "粘贴挂在工作区根上（焦点在下拉里也粘得上），且拿不到图片时不 preventDefault",
    /className: "vig-main",[\s\S]{0,400}onPaste: \(event\) => \{[\s\S]{0,200}const file = pickClipboardImage\(event\.clipboardData\);[\s\S]{0,80}if \(!file\) return;[\s\S]{0,80}event\.preventDefault\(\);/.test(SOURCE) &&
      /const onPasteImage = async \(file\) => \{/.test(SOURCE) &&
      /actions\.attachReference\(\{ name: pastedImageName\(file\), dataUrl \}\)/.test(SOURCE) &&
      // 输入框那个容器上不再单独挂一份（会跟根上的双触发）
      !/onDrop,\s*\/\/[^\n]*粘图/.test(SOURCE)
  );
  check(
    "界面上写明可以粘贴（占位符 + 上传按钮的提示）",
    w.text("chat.placeholder").includes("Ctrl+V") && w.text("panel.upload").includes("Ctrl+V") && w.text("chat.pasted").length > 0
  );

  /* 参考图卡 + 提示条：两处都按「不写多余信息」重做过。
     参考图 = 小矩形卡（只有缩略图和右上角 ×，名字进 title）；
     提示条 = 窗口额头居中悬浮，内容两侧各留三字白。 */
  const refChat = renderToStaticMarkup(
    React.createElement(w.ChatView, {
      state: {
        config: { baseUrl: "", apiKeyEnv: "", keyMask: "••••", hasKey: true, defaultModel: "m", defaultSize: "1024x1024", defaultQuality: "LOW", defaultCount: 1, defaultEndpoint: "auto", activeProviderId: "" },
        providers: [],
        notes: [],
        protocols: [],
        jobs: [],
        pending: 0,
        draft: "",
        reference: { name: "x", dataUrl: "data:image/png;base64,AAAA" }, references: [{ name: "粘贴的图片-2026-10-18T16-47-17.png", dataUrl: "data:image/png;base64,AAAA" }],
        editMode: false,
        generating: false,
        pickOpen: false,
        ready: true
      },
      actions: noop
    })
  );
  check(
    "参考图是小矩形卡：只有缩略图 + 右上角 ×，不写文件名也不写「参考图」",
    (() => {
      const start = refChat.indexOf('class="vig-ref"');
      // 从开标签的「>」之后取到闭合标签之前，才是卡片的真正内容
      const card = refChat.slice(refChat.indexOf(">", start) + 1, refChat.indexOf("</div>", start));
      const visibleText = card.replace(/<[^>]*>/g, "").trim();
      return (
        start >= 0 &&
        card.includes("<img") &&
        card.includes('class="vig-ref-x"') &&
        card.includes('src="data:image/png;base64,AAAA"') &&
        // 卡上没有任何可见文字：名字只在 title 里
        visibleText === "" &&
        card.includes('title="粘贴的图片-2026-10-18T16-47-17.png')
      );
    })(),
    (() => {
      const start = refChat.indexOf('class="vig-ref"');
      const card = refChat.slice(refChat.indexOf(">", start) + 1, refChat.indexOf("</div>", start));
      return `可见文字=${JSON.stringify(card.replace(/<[^>]*>/g, "").trim())} 片段=${card.slice(0, 120)}`;
    })()
  );

  const toasts = renderToStaticMarkup(React.createElement(w.ToastHost, { items: [{ id: "a", message: "已粘贴为参考图" }, { id: "b", message: "上游请求失败", tone: "err" }] }));
  check(
    "提示条：窗口额头居中悬浮，内容两侧各留三字白",
    /\.vig-toasts\{position:fixed;top:10px;left:50%;transform:translateX\(-50%\)/.test(css) &&
      /\.vig-toast\{[^}]*padding:0 3em/.test(css) &&
      /\.vig-toast\{[^}]*border-radius:999px/.test(css) &&
      !/\.vig-toasts\{position:absolute/.test(css)
  );
  check(
    "提示条只有那一句话（成功/失败靠边框着色区分，不再是一条通栏）",
    (toasts.match(/class="vig-toast"/g) || []).length === 1 &&
      (toasts.match(/class="vig-toast is-err"/g) || []).length === 1 &&
      toasts.includes("已粘贴为参考图") &&
      toasts.includes("上游请求失败") &&
      !toasts.includes("is-ok") &&
      !toasts.includes("<span")
  );

  const providers = renderToStaticMarkup(
    React.createElement(w.ProvidersView, {
      state: {
        config: { activeProviderId: "", baseUrl: "", keyMask: "", hasKey: true, defaultModel: "m", defaultSize: "1024x1024", defaultQuality: "LOW", defaultCount: 1, defaultEndpoint: "auto" },
        providers: [
          {
            id: "p1",
            name: "grok",
            baseUrl: "https://api.velapi.cc/v1",
            keyMask: "••••4008",
            models: ["grok-imagen-image-2.0"],
            modelMeta: {},
            endpoint: "images_edits",
            note: ""
          }
        ],
        protocols: []
      },
      actions: noop
    })
  );
  check(
    "供应商里不再出现协议选择（同一件事只有一个家：输入框那一行）",
    !providers.includes("端点类型") && !providers.includes("自动检测（默认）") && providers.includes("grok-imagen-image-2.0"),
    providers.slice(0, 160)
  );
}


// 其余样式全部自持，宿主改内部 class 名不会把工作台打散。
check("不依赖宿主私有样式变量或 class", !/--dsw-/.test(css) && !/\.(?:ds|dsw)-[a-z]/.test(css));
check("复用宿主的深色模式开关", css.includes("body[data-ds-dark-theme]"));

console.log(failures === 0 ? "\n全部通过" : `\n${failures} 项失败`);
process.exitCode = failures === 0 ? 0 : 1;
