// dsh-plugin-velapi-image-go —— 重启后「还在不在」的自动判定
//
// 只读一个文件，不碰端口（重启后 GUI 端口会变，但回执文件的位置不变）：
//   %USERPROFILE%\.dsh\state\velapi-image-go\client-report.json
// 页面每次加载都会往里写一条 apply + 一条 settled。所以：
//
//   1. 先记下当前最新的 apply 条数；
//   2. 你去重启 DSH（或刷新界面），脚本开始等；
//   3. 一旦出现**新的** apply，就读同一批里的 settled 并给结论。
//
//   node tools/restart-watch.mjs [--timeout 600] [--state DIR]

import { existsSync, readFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

const args = process.argv.slice(2);
const flag = (name, fallback) => {
  const index = args.indexOf(name);
  return index >= 0 && args[index + 1] ? args[index + 1] : fallback;
};
const TIMEOUT = Number.parseInt(flag("--timeout", "600"), 10) * 1000;
const stateDir = flag("--state", path.join(os.homedir(), ".dsh", "state", "velapi-image-go"));
const file = path.join(stateDir, "client-report.json");

function readItems() {
  try {
    if (!existsSync(file)) return [];
    const parsed = JSON.parse(readFileSync(file, "utf8"));
    return Array.isArray(parsed) ? parsed : (parsed.items ?? []);
  } catch {
    return [];
  }
}

const countApplies = (items) => items.filter((item) => item.phase === "apply").length;

const before = readItems();
const baseline = countApplies(before);
console.log(`回执文件：${file}`);
console.log(`现在有 ${before.length} 条回执（apply ${baseline} 次）。`);
console.log("现在去重启 DSH（或刷新界面）—— 我在等新的 apply 记录…\n");

const startedAt = Date.now();
let last = baseline;
while (Date.now() - startedAt < TIMEOUT) {
  await new Promise((resolve) => setTimeout(resolve, 2000));
  const items = readItems();
  const applies = countApplies(items);
  if (applies <= baseline) continue;
  if (applies !== last) {
    last = applies;
    // 等 settled 落盘（它在 apply 之后约 1.5s 才发）
    await new Promise((resolve) => setTimeout(resolve, 3000));
    const fresh = readItems();
    const newest = fresh.find((item) => item.phase === "settled" && item.at === fresh.find((entry) => entry.phase === "settled")?.at);
    const settled = fresh.filter((item) => item.phase === "settled")[0];
    const detail = settled?.detail ?? {};
    const launchers = detail.launchers ?? {};
    const guide = Array.isArray(detail.guide) ? detail.guide : [];
    const hasGuide = guide.some((row) => String(row).startsWith("velapi-image-go/"));
    const panel = detail.rightbarReady === true;
    const dom = detail.dom ?? {};

    console.log(`新的 apply 到了（第 ${applies} 次）。settled：`);
    console.log(`  右侧栏 tab 登记   rightbarReady = ${detail.rightbarReady}`);
    console.log(`  开始页那张卡      ${hasGuide ? "在" : "不在"}（${guide.join(" | ") || "空"}）`);
    console.log(`  设置分区          settingsReady = ${detail.settingsReady}`);
    console.log(`  浮层面板          overlay = ${detail.overlayReady}`);
    console.log(`  入口按钮          launchers = ${JSON.stringify(launchers)}`);
    console.log(`  页面实况          dom = ${JSON.stringify(dom)}`);
    if (detail.rightbarProbeError) console.log(`  守卫原文          ${detail.rightbarProbeError}`);
    if (detail.rightbarAttempts !== undefined) console.log(`  登记尝试次数      ${detail.rightbarAttempts}`);

    const ok = panel && hasGuide && launchers?.sidebarFooter === true;
    console.log("");
    console.log(ok ? "结论：没丢 —— 右侧栏 tab + 开始页卡片 + 唯一入口都在。" : "结论：有东西没登记上，看上面几行定位（右侧栏 tab / 卡片 / 入口按钮）。");
    void newest;
    process.exitCode = ok ? 0 : 1;
    process.exit();
  }
}

console.log(`${TIMEOUT / 1000}s 内没等到新的 apply —— 还没重启，或者宿主那半边没起来。`);
process.exitCode = 2;
