#!/usr/bin/env node
/**
 * 插件接壤自检：确认「本地插件目录 → profile link → cordis patch → 运行中的宿主」四段都通。
 *
 *   node tools/verify-wiring.mjs            # 自检并打印结论（退出码 0 = 接壤完整）
 *   node tools/verify-wiring.mjs --json     # 机器可读
 *
 * 判定项：
 *   1. profile package.json 里有 `link:` 依赖，且指向本插件目录
 *   2. profile node_modules 里是 junction/symlink → 本插件目录
 *   3. profile cordis.patch.yml 里有 `id: velapi-image-go` 的 insert 条目（id / name 对得上）
 *   4. 宿主 API 可达（GET /api/velapi-image-go/status 返回 ok）
 *   5. 宿主加载的代码是不是当前这份（/status 里应出现 videoSize / videoRatio / videoSeconds）
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const PLUGIN_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const PLUGIN_NAME = "dsh-plugin-velapi-image-go";
const LOADER_ID = "velapi-image-go";
const DSH_HOME = process.env.DSH_HOME || path.join(os.homedir(), ".dsh");
const PROFILE_DIR = path.join(DSH_HOME, "profiles", "desktop");
const API = process.env.DSH_API || "http://127.0.0.1:60898/api/velapi-image-go";

const results = [];
const add = (id, ok, detail) => results.push({ id, ok, detail });

/* 1. profile package.json 的 link 依赖 */
let profilePkg = null;
try {
  profilePkg = JSON.parse(fs.readFileSync(path.join(PROFILE_DIR, "package.json"), "utf8"));
} catch (error) {
  add("profile-package", false, `读不到 ${path.join(PROFILE_DIR, "package.json")}：${error.message}`);
}
if (profilePkg) {
  const dep = profilePkg.dependencies?.[PLUGIN_NAME] || "";
  const linked = dep.startsWith("link:") && path.resolve(dep.slice(5).replace(/\//g, path.sep)) === PLUGIN_DIR;
  add("profile-link", linked, dep || "(依赖里没有这条)");
  const inBundles = (profilePkg.dsh?.profile?.bundles || []).includes(PLUGIN_NAME);
  add("profile-bundles", !inBundles, inBundles ? "又被列进 bundles（会和 insert 撞 assertUniqueEntryIds）" : "只走 insert，未列 bundles");
}

/* 2. node_modules 里的 junction / symlink */
try {
  const linkPath = path.join(PROFILE_DIR, "node_modules", PLUGIN_NAME);
  const stat = fs.lstatSync(linkPath);
  const real = fs.realpathSync(linkPath);
  add("node-modules-link", fs.existsSync(linkPath) && path.resolve(real) === PLUGIN_DIR, `${stat.isSymbolicLink() || stat.isJunction ? "junction" : "普通目录"} → ${real}`);
} catch (error) {
  add("node-modules-link", false, `node_modules 里没有 ${PLUGIN_NAME}：${error.message}`);
}

/* 3. cordis.patch.yml 的 insert 条目 */
try {
  const patch = fs.readFileSync(path.join(PROFILE_DIR, "cordis.patch.yml"), "utf8");
  const hasId = new RegExp(`id:\\s*${LOADER_ID}\\b`).test(patch);
  const hasName = new RegExp(`name:\\s*${PLUGIN_NAME}\\b`).test(patch);
  add("cordis-patch", hasId && hasName, hasId && hasName ? `insert 里有 ${LOADER_ID} / ${PLUGIN_NAME}` : `patch 里缺 id 或 name（id=${hasId} name=${hasName}）`);
} catch (error) {
  add("cordis-patch", false, `读不到 cordis.patch.yml：${error.message}`);
}

/* 4 + 5. 运行中的宿主：API 是否可达、加载的是不是当前代码 */
let status = null;
try {
  const response = await fetch(`${API}/status`, { signal: AbortSignal.timeout(8000) });
  status = await response.json();
  add("host-api", response.ok && status?.ok === true, `GET ${API}/status → HTTP ${response.status}`);
} catch (error) {
  add("host-api", false, `连不上宿主（DSH 没启动？）：${error.message}`);
}
if (status?.ok) {
  const cfg = status.config || {};
  const fresh = ["videoSize", "videoRatio", "videoResolution", "videoSeconds"].every((key) => key in cfg);
  add(
    "host-fresh-code",
    fresh,
    fresh ? "宿主已加载当前代码（视频参数已出现在 /status）" : "宿主还在跑旧代码：重启 DSH 后才会加载本次改动"
  );
  add("host-tool", Boolean(status.tool?.registered), `工具 ${status.tool?.name || "?"} registered=${status.tool?.registered}`);
  add("host-state-dir", Boolean(status.stateDir), status.stateDir || "(空)");
}

const ok = results.every((item) => item.ok);
if (process.argv.includes("--json")) {
  console.log(JSON.stringify({ ok, pluginDir: PLUGIN_DIR, profileDir: PROFILE_DIR, results }, null, 2));
} else {
  console.log(`插件接壤自检：${PLUGIN_DIR}`);
  console.log(`profile：${PROFILE_DIR}`);
  console.log("");
  for (const item of results) {
    console.log(`${item.ok ? "PASS" : "FAIL"}  ${item.id.padEnd(18)} ${item.detail}`);
  }
  console.log("");
  console.log(ok ? "结论：接壤完整" : "结论：有环节没通（见上面 FAIL）");
}
process.exit(ok ? 0 : 1);
