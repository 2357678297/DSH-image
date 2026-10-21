// dsh-plugin-velapi-image-go —— 活着的 GUI 体检（不改任何东西，只读）
//
// 「重启后入口不见了」这类故障只发生在页面里，宿主看不到。这个脚本从外面把能看的都看了：
//   1. 构图（/plugins/events 的 graph 帧）里本插件的 rev / inject，以及三个席位作者的条目在不在；
//   2. 当前真正被服务的 client.js 里有没有那几段关键逻辑（等 sidebarRightTabs、onScreen 判据、
//      回执上报）—— 用来确认页面跑的是不是最新那版；
//   3. 宿主 API 的落点（/status、/client-report）。
//
//   node tools/live-check.mjs [端口]        # 端口缺省读 DSH GUI 的 64859
//
// 端口每次重启都会变，看一眼 GUI 地址栏即可；这个脚本只做只读探测。

import http from "node:http";

const PORT = Number(process.argv[2] || process.env.VIG_PORT || 64859);
const ENTRY = "dsh-plugin-velapi-image-go";
const SEATS = ["@deepseek-ai/dsh-client-ui-layout", "@deepseek-ai/dsh-client-ui-sidebar-right", "@deepseek-ai/dsh-client-ui-settings"];

const request = (path, method = "GET", body) =>
  new Promise((resolve) => {
    const payload = body === undefined ? null : JSON.stringify(body);
    const req = http.request(
      { host: "127.0.0.1", port: PORT, path, method, headers: payload ? { "content-type": "application/json", "content-length": Buffer.byteLength(payload) } : {} },
      (res) => {
        const chunks = [];
        res.on("data", (chunk) => chunks.push(chunk));
        res.on("end", () => resolve({ status: res.statusCode, body: Buffer.concat(chunks).toString("utf8") }));
      }
    );
    req.on("error", (error) => resolve({ status: 0, body: String(error.message) }));
    if (payload) req.write(payload);
    req.end();
  });

/* 1) 构图帧 */
const frames = await new Promise((resolve) => {
  let buffer = "";
  const req = http.request({ host: "127.0.0.1", port: PORT, path: "/plugins/events", headers: { accept: "text/event-stream" } }, (res) => {
    res.on("data", (chunk) => (buffer += chunk.toString("utf8")));
  });
  req.on("error", () => resolve(""));
  req.end();
  setTimeout(() => {
    req.destroy();
    resolve(buffer);
  }, 4000);
});
const graphFrame = frames.split(/\n\n+/).find((frame) => frame.includes('"type":"graph"'));
if (!graphFrame) {
  console.log(`连不上 127.0.0.1:${PORT} 或者没收到构图帧 —— 端口每次重启都会变，确认一下 GUI 地址。`);
  process.exitCode = 1;
} else {
  const graph = JSON.parse(graphFrame.replace(/^data:\s*/, "")).graph;
  const mine = graph.entries.find((entry) => entry.id === ENTRY);
  console.log(`构图 rev ${graph.rev}｜条目 ${graph.entries.length} 个`);
  if (!mine) {
    console.log(`构图里没有 ${ENTRY} —— 插件没被加载（先看 profiles/desktop/cordis.patch.yml 那条 insert）。`);
  } else {
    console.log(`本插件：rev ${mine.rev}｜immediately ${mine.immediately ?? "(未声明)"}｜url ${mine.url ? "有" : "无"}`);
    console.log(`   inject ${JSON.stringify(mine.inject ?? [])}`);
    for (const seat of SEATS) {
      const entry = graph.entries.find((row) => row.id === seat);
      console.log(`   席位 ${seat} → ${entry ? `第 ${graph.entries.indexOf(entry)} 位，rev ${entry.rev}` : "构图里没有（写进 inject 只会被跳过）"}`);
    }
    /* 2) 真正被服务的那份 client.js */
    const servePath = (() => {
      const raw = mine.url ?? `/plugins/??${ENTRY}/client.js&rev=${mine.rev}`;
      if (/^https?:\/\//i.test(raw)) {
        const parsed = new URL(raw);
        return `${parsed.pathname}${parsed.search}`;
      }
      return raw.startsWith("/") ? raw : `/plugins/??${ENTRY}/client.js&rev=${mine.rev}`;
    })();
    const bundle = await request(servePath);
    const needles = [
      ['ctx.inject(["sidebarRightTabs"]', "等右侧栏席位（冷启动竞态）"],
      ["const registerRightbar = (scope) =>", "席位登记收在一处，早到/晚到都走它"],
      ["dockFace({ paneMounted, paneVisible, paneOnScreen })", "入口判据带 onScreen"],
      ["return onScreen ? null : \"dock\";", "面板常驻（没有收起这一档）"],
      ["Date.now() - mountedAt < 800", "观察者首次投递前的宽限期"],
      ["/client-report", "自检回执上报"],
      ['const PROTOCOL_IDS = [', "端点协议表（界面那份，和宿主同一套 id）"],
      ['"images_edits"', "图片编辑协议 POST /v1/images/edits"],
      ['"videos_generations"', "视频生成协议 POST /v1/videos/generations"],
      ['vig-sel vig-endpoint', "协议选择在输入框那一行"],
      ["defaultEndpoint", "协议跟着每次生成走（写进 config）"],
      ["...previous, ...patch", "保存配置乐观更新（宿主吞字段也不冲掉选择）"],
      ["errorDetail", "上游原始报错（状态 / 响应体 / 请求地址）"],
      ["vig-fail", "失败卡：一处说完（老任务只一行）"],
      ["pickClipboardImage", "Ctrl+V 粘图（从剪贴板挑图）"],
      ["function ToastHost", "提示条贴窗口额头居中"],
      ["vig-ref-x", "参考图小矩形卡"],
      ["vig-turn is-user", "我发出去的那句话靠右"],
      ["vig-me-ref", "我那条消息里的参考图缩略图"],
      ["STALE_MS", "轮询停了不一直转圈"],
      ['className: "vig-me"', "右侧气泡本体"],
      ["onPasteImage", "粘贴后挂成参考图并给回执"],
      ["vig-fail-pre", "原始响应体原样摆出来"]
    ];
    console.log(`bundle HTTP ${bundle.status}｜${bundle.body.length} 字节`);
    for (const [needle, why] of needles) console.log(`   ${bundle.body.includes(needle) ? "有  " : "没有"} ${why}`);
  }
}

/* 3) 宿主 API 落点 */
for (const path of ["/api/velapi-image-go/status", "/api/velapi-image-go/client-report"]) {
  const res = await request(path);
  const snippet = res.body.slice(0, 120).replace(/\s+/g, " ");
  console.log(`${path} → ${res.status} ${snippet}`);
}
console.log("\n回执文件：$DSH_HOME/state/velapi-image-go/client-report.json（宿主重启后才有；里面是页面侧的落点结果与 DOM 实况）");
