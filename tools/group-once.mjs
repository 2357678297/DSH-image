// 一次性核对：拿真实目录（`GET /api/velapi-image-go/models`）跑一遍分组，
// 再看「没有元数据时靠名字兜底」和「有元数据时按 family 分类」是不是一致。
//
//   node tools/group-once.mjs [--url URL]

import { loadClientBundle } from "./bundle.mjs";

const args = process.argv.slice(2);
const flag = (name, fallback) => {
  const index = args.indexOf(name);
  return index >= 0 && args[index + 1] ? args[index + 1] : fallback;
};
const URL_BASE = flag("--url", "http://127.0.0.1:19387/api/velapi-image-go/models");

const { module } = loadClientBundle();
const ui = module.__internals;

const payload = await (await fetch(URL_BASE)).json();
const raw = Array.isArray(payload?.items) ? payload.items : [];
const entries = raw.map((item) => (typeof item === "string" ? { id: item } : item));
const meta = {};
for (const entry of entries) if (entry.kind || entry.enabled === false) meta[entry.id] = { kind: entry.kind, enabled: entry.enabled };

console.log(`目录 ${entries.length} 条；带 kind 元数据 ${Object.keys(meta).length} 条`);

for (const [label, table] of [["名字兜底", {}], ["目录元数据", meta]]) {
  const groups = ui.groupModels(entries, table);
  console.log(`\n[${label}]`);
  for (const group of groups) {
    console.log(`  ${group.title} (${group.count})  ${group.families.map((f) => `${f.family}×${f.models.length}`).join("  ")}`);
  }
}

const sample = "omni-flash";
console.log(`\nomni-flash：兜底=${ui.modelKind(sample)}  元数据=${ui.modelKind(sample, meta[sample] ?? { kind: "video" })}`);
const off = entries.filter((entry) => entry.enabled === false).map((entry) => entry.id);
if (off.length > 0) console.log(`未开通：${off.join("、")}`);
