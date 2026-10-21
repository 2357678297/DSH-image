// 一次性探针：离线渲染检查器，数一数预设卡墙有没有真的出来。
import { loadClientBundle } from "./bundle.mjs";
import { React, renderToStaticMarkup } from "./bundle.mjs";
import { wideMarkup, narrowMarkup } from "./markup.mjs";

const html = (element) => renderToStaticMarkup(element);

const ui = loadClientBundle().module.__internals;

for (const [label, markup] of [
  ["宽栏", wideMarkup(ui, "chat", true)],
  ["窄栏", narrowMarkup(ui, "chat")]
]) {
  console.log(
    `${label}：卡片 ${(markup.match(/vig-preset-card/g) || []).length} 张，` +
      `参考图 ${(markup.match(/vig-preset-cover/g) || []).length} 张，` +
      `空态占位 ${(markup.match(/vig-preset-blank/g) || []).length} 个，` +
      `内置标签 ${(markup.match(/vig-tag">内置/g) || []).length} 个`
  );
}

const board = ui.PresetBoard({ presets: [], onUse() {}, onEdit() {}, onDelete() {} });
console.log("空墙文案:", board.props.children);
const dialog = html(
  React.createElement(ui.PresetDialog, {
    preset: { id: "", title: "", prompt: "", image: "", tags: [] },
    library: [],
    onClose() {},
    onSave: async () => true,
    onUpload: async () => ""
  })
);
console.log("编辑器里有上传/图库按钮:", dialog.includes("上传参考图"), dialog.includes("从图库选"), "字段数:", (dialog.match(/vig-field/g) || []).length);
console.log("编辑器带参考图槽:", dialog.includes("vig-preset-ref"));
