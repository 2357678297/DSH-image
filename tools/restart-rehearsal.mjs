// dsh-plugin-velapi-image-go —— 「重启后会丢吗」的复演
//
// 入口丢失本质是**冷启动那一刻的时序**。在你的窗口里真按重启会断掉这一场会话，所以这里
// 把重启那一刻拆成三步、对着**同一份 bundle**（优先当前被服务的那份）复演：
//
//   1. 加载契约：模块导出里静态声明了 `sidebarRightTabs` / `sidebarRight`
//      —— DSH 的 loader 就是靠它「等服务到货再激活」，官方 ui-sidebar-browser 同一写法；
//   2. 服务到货后 apply：tab 类型 + 开始页那张卡 + 面板席位 + 唯一的入口按钮都登记上；
//   3. 服务没到（最坏情况）：apply 不许抛 —— 不能因为别人晚到就整片死掉。
//
//   node tools/restart-rehearsal.mjs [--port 59047] [--file ./client.js]

import { readFileSync } from "node:fs";
import path from "node:path";
import vm from "node:vm";
import { fileURLToPath } from "node:url";

const args = process.argv.slice(2);
const flag = (name, fallback) => {
  const index = args.indexOf(name);
  return index >= 0 && args[index + 1] ? args[index + 1] : fallback;
};
const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, "..");
const PORT = flag("--port", "59047");
const LOCAL_FILE = path.resolve(ROOT, flag("--file", "client.js"));

let failures = 0;
function check(name, ok, extra = "") {
  console.log(`${ok ? "  PASS" : "  FAIL"}  ${name}${extra ? ` — ${extra}` : ""}`);
  if (!ok) failures += 1;
}

/** 最小的假 React：工厂体只 require react，够它把 exports 填好就行。 */
function fakeReact() {
  const element = (type, props, ...children) => ({ type, props: { ...(props ?? {}), children } });
  return {
    createElement: element,
    Fragment: Symbol.for("react.fragment"),
    useRef: (value) => ({ current: value ?? null }),
    useState: (init) => [typeof init === "function" ? init() : init, () => {}],
    useEffect: () => {},
    useLayoutEffect: () => {},
    useMemo: (fn) => fn(),
    useCallback: (fn) => fn(),
    memo: (component) => component,
    forwardRef: (component) => component,
    createContext: () => ({ Provider: null, Consumer: null }),
    useContext: () => null,
    useId: () => "id",
    useReducer: (_reducer, init) => [init, () => {}],
    Children: { toArray: (value) => (Array.isArray(value) ? value : [value]) }
  };
}

/** 浏览器沙箱：只够 bundle 求值 + apply 跑完（不渲染）。 */
function makeSandbox() {
  const store = new Map();
  const document = {
    head: { appendChild: () => {}, removeChild: () => {} },
    body: { appendChild: () => {}, removeChild: () => {} },
    documentElement: { style: {}, appendChild: () => {} },
    createElement: () => ({ style: {}, dataset: {}, setAttribute: () => {}, appendChild: () => {}, remove: () => {}, textContent: "" }),
    createTextNode: (text) => ({ textContent: text }),
    querySelector: () => null,
    querySelectorAll: () => [],
    addEventListener: () => {},
    removeEventListener: () => {}
  };
  const window = {
    localStorage: {
      getItem: (key) => (store.has(key) ? store.get(key) : null),
      setItem: (key, value) => store.set(key, String(value)),
      removeItem: (key) => store.delete(key)
    },
    document,
    location: { origin: `http://127.0.0.1:${PORT}`, href: `http://127.0.0.1:${PORT}/`, pathname: "/" },
    navigator: { clipboard: { writeText: async () => {} }, language: "zh-CN", userAgent: "rehearsal" },
    setTimeout: (fn, ms) => setTimeout(fn, Math.min(ms ?? 0, 30)),
    clearTimeout,
    setInterval: () => 0,
    clearInterval: () => {},
    requestAnimationFrame: (fn) => setTimeout(() => fn(Date.now()), 0),
    cancelAnimationFrame: () => {},
    matchMedia: () => ({ matches: false, addEventListener: () => {}, removeEventListener: () => {} }),
    addEventListener: () => {},
    removeEventListener: () => {},
    dispatchEvent: () => true,
    CustomEvent: class CustomEvent {
      constructor(type, init) {
        this.type = type;
        this.detail = init?.detail;
      }
    },
    fetch: async () => ({ ok: true, status: 200, text: async () => "{}", json: async () => ({}) }),
    console: { log: () => {}, warn: () => {}, error: () => {}, info: () => {} },
    IntersectionObserver: class {
      observe() {}
      unobserve() {}
      disconnect() {}
    },
    ResizeObserver: class {
      observe() {}
      unobserve() {}
      disconnect() {}
    }
  };
  window.window = window;
  window.self = window;
  window.__ModuleLoader__ = { load: (record) => { window.__record = record; } };
  const sandbox = {
    window,
    document,
    console: window.console,
    setTimeout: window.setTimeout,
    clearTimeout,
    setInterval: window.setInterval,
    clearInterval: window.clearInterval,
    CustomEvent: window.CustomEvent,
    fetch: window.fetch,
    navigator: window.navigator,
    location: window.location,
    IntersectionObserver: window.IntersectionObserver,
    ResizeObserver: window.ResizeObserver
  };
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  return { sandbox, window };
}

/** 假的右侧栏两个服务 + 记账用的 ctx。 */
function makeCtx({ withServices }) {
  const tabDefs = [];
  const tabs = {
    register: (definition) => {
      tabDefs.push(definition);
      return () => {};
    },
    guide: () => tabDefs.flatMap((definition) => (definition.guide ?? []).map((entry) => ({ ...entry, kind: definition.kind }))),
    get: (kind) => tabDefs.find((definition) => definition.kind === kind)
  };
  const opened = [];
  const sidebarRight = { openTab: (kind) => opened.push(kind) };
  const slots = new Map();
  const ctx = {
    slots: {
      inject: (name, register) => {
        const registration = register();
        if (registration !== undefined) slots.set(name, registration);
      },
      register: (options, component) => ({ options, component })
    },
    effect: (fn) => {
      const disposer = fn();
      return () => {
        if (typeof disposer === "function") disposer();
      };
    },
    // 复现新版 cordis 的守卫：没声明过的服务访问会抛
    get: (name) => {
      if (withServices && name === "sidebarRightTabs") return tabs;
      if (withServices && name === "sidebarRight") return sidebarRight;
      throw new Error(`cannot get property "${name}" without inject`);
    },
    on: () => {},
    emit: () => {}
  };
  if (withServices) {
    ctx.sidebarRightTabs = tabs;
    ctx.sidebarRight = sidebarRight;
  }
  return { ctx, slots, tabDefs, opened, sidebarRight };
}

async function loadBundle() {
  const url = `http://127.0.0.1:${PORT}/plugins/??dsh-plugin-velapi-image-go/client.js`;
  try {
    const response = await fetch(url, { signal: AbortSignal.timeout(6000) });
    if (response.ok) {
      const text = await response.text();
      if (text.length > 10000) return { text, from: `served ${response.status}` };
    }
  } catch {
    /* 端口不在就退回本地 */
  }
  return { text: readFileSync(LOCAL_FILE, "utf8"), from: "local file" };
}

const bundle = await loadBundle();
console.log(`bundle：${bundle.from}｜${bundle.text.length} 字节`);

/* ---- 1. 加载契约 ------------------------------------------------- */
const { sandbox, window } = makeSandbox();
vm.runInContext(bundle.text, sandbox, { filename: "client.js" });
const record = window.__record;
check("bundle 自注册进 __ModuleLoader__（id = 包名）", Boolean(record) && record.id === "dsh-plugin-velapi-image-go", record?.id);

const injectMatch = bundle.text.match(/exports\.inject = (\[[^\]]*\]);/);
const injectList = injectMatch ? JSON.parse(injectMatch[1]) : [];
check(
  "加载契约：静态声明 slots + sidebarRightTabs + sidebarRight（loader 会等服务到货再激活）",
  injectList.includes("slots") && injectList.includes("sidebarRightTabs") && injectList.includes("sidebarRight"),
  JSON.stringify(injectList)
);

/* ---- 2. 服务到货后 apply --------------------------------------- */
const plugin = record.factory((name) => fakeReact());
check("模块导出 name / apply", plugin?.name === "velapi-image-go" && typeof plugin?.apply === "function", String(plugin?.name));

const ready = makeCtx({ withServices: true });
let threw = null;
try {
  plugin.apply(ready.ctx, { surfaces: ["rightbar", "settings"] });
} catch (error) {
  threw = error;
}
check("服务到货后 apply 不抛异常", threw === null, threw ? String(threw?.message ?? threw).slice(0, 160) : "");
check(
  "tab 类型 + 开始页那张卡登记上了（kind/id/guide 与 order）",
  ready.tabDefs.length === 1 &&
    ready.tabDefs[0].kind === "velapi-image-go" &&
    ready.tabDefs[0].id === "dsh-plugin-velapi-image-go" &&
    ready.tabDefs[0].guide?.[0]?.id === "open-workbench" &&
    ready.tabDefs[0].guide?.[0]?.order === 20,
  JSON.stringify(ready.tabDefs.map((definition) => ({ kind: definition.kind, id: definition.id })))
);
check("面板席位 + 唯一入口按钮都登记上了", ready.slots.has("sidebar.right.pane.tab") && ready.slots.has("sidebar.footer.action"), [...ready.slots.keys()].join(","));

/* ---- 3. 最坏情况：服务没到 ------------------------------------- */
const cold = makeCtx({ withServices: false });
let coldThrew = null;
try {
  plugin.apply(cold.ctx, { surfaces: ["rightbar", "settings"] });
} catch (error) {
  coldThrew = error;
}
check("服务没到也不抛（守卫异常被吞、其它落点照旧）", coldThrew === null, coldThrew ? String(coldThrew?.message ?? coldThrew).slice(0, 160) : "");

console.log(failures === 0 ? "\n重启复演 6/6 通过" : `\n${failures} 项失败`);
process.exitCode = failures === 0 ? 0 : 1;
