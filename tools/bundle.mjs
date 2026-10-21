// 把 client.js 当 dsh 的 __ModuleLoader__ bundle 装进一个隔离上下文，取出模块。
// 预览生成器与适配性检查都用它，保证两边跑的是同一份代码。

import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import vm from "node:vm";

const REACT_ROOT = process.env.VIG_REACT_ROOT || "G:/Gg-gank/frontend/deeix-chat/frontend/node_modules";
export const reactRequire = createRequire(path.join(REACT_ROOT, "anchor.cjs"));
export const React = reactRequire("react");
export const { renderToStaticMarkup } = reactRequire("react-dom/server");

/** 载入 client.js，返回 { record, module }。store 用来喂 localStorage 的初值。 */
export function loadClientBundle(store = {}) {
  const captured = [];
  const sandbox = {
    console,
    setTimeout,
    clearTimeout,
    clearInterval,
    URL,
    fetch: async () => ({ ok: true, status: 200, text: async () => "{}" }),
    navigator: { clipboard: { writeText: async () => {} } }
  };
  sandbox.window = {
    location: { origin: "http://127.0.0.1:19387" },
    localStorage: { getItem: (key) => (key in store ? store[key] : null), setItem: () => {} },
    addEventListener: () => {},
    removeEventListener: () => {},
    __ModuleLoader__: { load: (record) => captured.push(record) }
  };
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(readFileSync(new URL("../client.js", import.meta.url), "utf8"), sandbox, { filename: "client.js" });
  const record = captured[0];
  if (!record) throw new Error("client.js 没有调用 __ModuleLoader__.load");
  const module = record.factory((request) => {
    if (request === "react") return React;
    throw new Error(`client.js 只应该 require("react")，实际请求了 ${request}`);
  });
  return { record, module, sandbox };
}
