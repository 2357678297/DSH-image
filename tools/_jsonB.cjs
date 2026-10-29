/* B. JSON 请求体：Composer 按钮 + state 暴露 + ChatView 弹层 + i18n */
const fs = require("fs");
const f = "client.js";
const lines = fs.readFileSync(f, "utf8").split(/\r?\n/);

// 1) 按钮（force 按钮闭合后）
const forceIdx = lines.findIndex((line) => line.includes("onClick: () => submit(true)"));
if (forceIdx < 0) throw new Error("force button not found");
let close = forceIdx;
while (close < lines.length && lines[close].trim() !== "),") close += 1;
if (close >= lines.length) throw new Error("force close not found");
lines.splice(close + 1, 0,
  "\t\t\t\t\t\t// JSON 请求体：查看 / 编辑这次发送给宿主的 /generate body",
  "\t\t\t\t\t\th(",
  '\t\t\t\t\t\t\t"button",',
  "\t\t\t\t\t\t\t{",
  '\t\t\t\t\t\t\t\tclassName: "vig-tool",',
  '\t\t\t\t\t\t\t\t"data-json-body": "1",',
  '\t\t\t\t\t\t\t\ttitle: t("chat.jsonBody"),',
  '\t\t\t\t\t\t\t\t"aria-label": t("chat.jsonBody"),',
  "\t\t\t\t\t\t\t\tonClick: () => actions.openJsonBody()",
  "\t\t\t\t\t\t\t},",
  '\t\t\t\t\t\t\th(Icon, { name: "note", size: 14 })',
  "\t\t\t\t\t\t),"
);

// 2) state 暴露
const exposeIdx = lines.findIndex((line) => line.trim() === "isVideoEndpoint,");
if (exposeIdx < 0) throw new Error("state expose not found");
lines.splice(exposeIdx + 1, 0,
  "				jsonOpen,",
  "				jsonDraft,",
  "				setJsonOpen,",
  "				setJsonDraft,"
);

// 3) ChatView 解构
const destIdx = lines.findIndex((line) => line.includes("const { config, providers, notes, jobs, busyJobIds, references, draft, conversations, conversationId"));
if (destIdx < 0) throw new Error("ChatView destructure not found");
lines[destIdx] = lines[destIdx].replace(
  "chatModels, dialogFirst",
  "chatModels, jsonOpen, jsonDraft, setJsonOpen, setJsonDraft"
);

// 4) ChatView 根 children 开头插 modal
const chatRoot = lines.findIndex((line, i) => line.includes('className: "vig-main",') && i > 3800 && i < 4000);
if (chatRoot < 0) throw new Error("chat root not found");
// 根 h( 起始：chatRoot 行是 { className... }, 的上一行是 "div"，再上一行是 h(
// children 从 chatRoot + 2 开始（跳过 `},`）
let insertAt = chatRoot + 1;
while (insertAt < lines.length && lines[insertAt].trim() !== "},") insertAt += 1;
insertAt += 1;
lines.splice(insertAt, 0,
  "\t\t\t\t/* JSON 请求体弹层（编辑这次 /generate 的 body，应用后整包覆盖） */",
  "\t\t\t\tjsonOpen ? h(",
  '\t\t\t\t\t"div",',
  '\t\t\t\t\t{ className: "vig-modal-mask", onClick: () => setJsonOpen(false) },',
  "\t\t\t\t\th(",
  '\t\t\t\t\t\t"div",',
  '\t\t\t\t\t\t{ className: "vig-modal", style: { width: 560, maxWidth: "92vw" }, onClick: (event) => event.stopPropagation() },',
  '\t\t\t\t\t\th("span", { className: "vig-modal-title" }, t("chat.jsonBody")),',
  '\t\t\t\t\t\th("p", { className: "vig-muted", style: { fontSize: 12, margin: "4px 0 10px" } }, t("chat.jsonHint")),',
  '\t\t\t\t\t\th("textarea", {',
  '\t\t\t\t\t\t\tclassName: "vig-input",',
  '\t\t\t\t\t\t\t"data-json-editor": "1",',
  '\t\t\t\t\t\t\tstyle: { width: "100%", height: 320, fontFamily: "ui-monospace, monospace", fontSize: 12, resize: "vertical" },',
  "\t\t\t\t\t\t\tvalue: jsonDraft,",
  "\t\t\t\t\t\t\tonChange: (event) => setJsonDraft(event.target.value)",
  "\t\t\t\t\t\t}),",
  "\t\t\t\t\t\th(",
  '\t\t\t\t\t\t\t"div",',
  '\t\t\t\t\t\t\t{ style: { display: "flex", gap: 8, justifyContent: "flex-end", marginTop: 12 } },',
  '\t\t\t\t\t\t\th("button", { className: "vig-btn", onClick: () => { actions.resetJsonBody(); } }, t("chat.jsonReset")),',
  '\t\t\t\t\t\t\th("button", { className: "vig-btn", onClick: () => setJsonOpen(false) }, "关闭"),',
  '\t\t\t\t\t\t\th("button", { className: "vig-btn is-primary", "data-json-apply": "1", onClick: () => actions.applyJsonBody() }, t("chat.jsonApply"))',
  "\t\t\t\t\t\t)",
  "\t\t\t\t\t)",
  "\t\t\t\t) : null,"
);

// 5) actions 增加 resetJsonBody
const actIdx = lines.findIndex((line) => line.trim() === "const actions = {");
lines.splice(actIdx + 1, 0,
  '				resetJsonBody: () => { jsonOverrideRef.current = null; setJsonDraft(JSON.stringify(buildRequestPreview(draft), null, 2)); toast(t("chat.jsonReset")); },'
);

fs.writeFileSync(f, lines.join("\n"), "utf8");
console.log("B done");
