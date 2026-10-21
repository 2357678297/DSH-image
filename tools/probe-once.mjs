// 一次性几何探针：把某个视图渲染出来，用真 Chrome 量盒模型。
//   node tools/probe-once.mjs [view] [width]
// 只用来定位重叠/错位，不作为常驻验收（验收在 fit-check.mjs）。
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { loadClientBundle } from "./bundle.mjs";
import { page, viewMarkup, wideMarkup, narrowMarkup } from "./markup.mjs";

const view = process.argv[2] || "library";
const width = Number(process.argv[3] || 1280);
const compact = width < 660;

const { module } = loadClientBundle();
const ui = module.__internals;
const inner = view === "chat" ? (compact ? narrowMarkup : wideMarkup)(ui, "chat") : viewMarkup(ui, view);
const dir = mkdtempSync(path.join(tmpdir(), "vig-probe-"));
const cleanup = () => rmSync(dir, { recursive: true, force: true });
process.on("exit", cleanup);

const PROBE = `<pre id="PROBE"></pre><script>
const box=(s)=>{const e=document.querySelector(s);if(!e)return null;const r=e.getBoundingClientRect();
return {x:Math.round(r.x),y:Math.round(r.y),w:Math.round(r.width),h:Math.round(r.height),
pad:getComputedStyle(e).padding,font:getComputedStyle(e).fontSize};};
const out={toolbar:box(".vig-toolbar"),input:box(".vig-toolbar input"),select:box(".vig-toolbar select"),
title:box(".vig-toolbar .vig-item-title"),btn:box(".vig-toolbar .vig-btn"),tag:box(".vig-tag"),
prov:box(".vig-prov"),provActs:box(".vig-prov-acts"),page:box(".vig-page"),grid:box(".vig-form-grid")};
document.getElementById("PROBE").textContent="PROBE_JSON="+JSON.stringify(out);
</script>`;

const html = page(`probe ${view}`, inner, { width, compact, css: ui.CSS, frame: { padding: 0, minHeight: 700 } }).replace("</body>", `${PROBE}</body>`);
const file = path.join(dir, "probe.html");
writeFileSync(file, html, "utf8");
const dom = execFileSync("C:/Program Files/Google/Chrome/Application/chrome.exe", [
  "--headless=new", "--disable-gpu", "--virtual-time-budget=2500", "--window-size=1600,900", "--dump-dom",
  `file:///${file.replace(/\\/g, "/")}`
], { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });

const match = dom.match(/PROBE_JSON=(\{.*?\})<\/pre>/s);
if (!match) {
  console.log("拿不到测量结果");
  process.exitCode = 1;
} else {
  console.log(`${view} @ ${width}px`);
  console.log(JSON.stringify(JSON.parse(match[1].replace(/&quot;/g, '"')), null, 2));
}
cleanup();
