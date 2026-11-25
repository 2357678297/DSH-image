// dsh-plugin-velapi-image-go —— client half.
//
// 「API 对话生图工作台」的浏览器半边：左导航（对话生图 / 图片管理 / 信息管理 /
// 供应商管理）+ 中部工作区 + 右栏检查器（图片 / 信息 / 供应商），全部走宿主
// 半边挂在 /api/velapi-image-go 下的普通 HTTP 端点。
//
// 落点有两个，按可用性依次尝试，任何一个失败都不会影响另一个：
//   rightbar  —— sidebar.right.pane.tab 席位（产品右侧栏的一个 tab）
//   settings  —— settings.section 席位（设置页里的一节，永远可用）
//
// 这个文件是 dsh 外部 client bundle 的构建产物形态：自注册到
// window.__ModuleLoader__.load，factory 里只 require("react")。
window.__ModuleLoader__.load({
	id: "dsh-plugin-velapi-image-go",
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;

		let react;
		try {
			react = require("react");
		} catch (error) {
			// 没有 react 就什么都渲染不了；留一条诊断，别静默消失。
			console.error("[velapi-image-go] react is unavailable", error);
			return module.exports;
		}
		const h = react.createElement;
		const { useCallback, useEffect, useMemo, useRef, useState } = react;
		// 量尺寸用 layoutEffect：首帧就定形态。SSR（没有 document）退回 effect。
		const useMeasureEffect = typeof document === "undefined" ? useEffect : react.useLayoutEffect ?? useEffect;

		const NAME = "velapi-image-go";
		const NS = "settings.velapi-image-go";
		const API = "/api/velapi-image-go";
		const KIND = "velapi-image-go";
		// 右侧栏 tab 类型注册表里的 id，同时也是面板内容/标题两个席位的 key。
		const TAB_ID = "dsh-plugin-velapi-image-go";
		const VIEW_KEY = "dsh.velapi-image-go.view";
		// 与 package.json 的 version 对齐（界面「更新」入口显示它）
		const PLUGIN_VERSION = "0.2.100-rev.107";
		// 视频模型单独一套尺寸候选：和图片尺寸分开（用户要求「视频参数区分图片配置」）
		const VIDEO_SIZES = ["1280x720", "1920x1080", "720x1280", "1080x1920"];
		/* 视频参数按「比例 / 分辨率」分开选：像素 size 由两者组合（主流 API 里 OpenAI 用 size 像素、
		   Kling/Seedance/Veo 用 aspect_ratio + resolution，这里先归一到像素 size）。 */
		const VIDEO_RATIOS = ["16:9", "9:16", "1:1", "4:3", "3:4", "21:9"];
		const VIDEO_RESOLUTIONS = ["480p", "720p", "1080p"];
		const VIDEO_SECONDS = ["4", "6", "8", "10", "12"];
		const VIDEO_SHORT_SIDE = { "480p": 480, "720p": 720, "1080p": 1080 };
		/** 比例 × 分辨率 → 像素尺寸（短边 = 分辨率档，长边按比例四舍五入到偶数）。 */
		function videoSizeFor(ratio, resolution) {
			const side = VIDEO_SHORT_SIDE[resolution] || 720;
			const [w, h] = String(ratio || "16:9").split(":").map((part) => Number(part) || 1);
			let width;
			let height;
			if (w >= h) {
				height = side;
				width = Math.round((side * w) / h);
			} else {
				width = side;
				height = Math.round((side * h) / w);
			}
			const even = (value) => Math.max(2, Math.round(value / 2) * 2);
			return `${even(width)}x${even(height)}`;
		}
		// 右侧检查器（图片 / 预设卡 / 供应商）收没收起：默认展开，用户收起过才记住（存 "0"）
		const SIDE_KEY = "dsh.velapi-image-go.side";
		// 当前在哪个对话里（会话 id）；每个会话的历史互相隔离
		const CONV_KEY = "dsh.velapi-image-go.conv";
// 会话级生图配置：每个会话独立记住模型/尺寸/质量/数量/协议/视频参数
const CONV_SETTINGS_KEY = "dsh.velapi-image-go.conv-settings";
const CONV_CONFIG_FIELDS = [
  "defaultModel",
  "defaultSize",
  "defaultQuality",
  "defaultCount",
  "defaultEndpoint",
  "geminiSize",
  "geminiRatio",
  "videoSize",
  "videoRatio",
  "videoResolution",
  "videoSeconds"
];
function pickConfigFields(config) {
  const out = {};
  for (const key of CONV_CONFIG_FIELDS) {
    if (config && config[key] !== undefined) out[key] = config[key];
  }
  return out;
}
function readConvSettings() {
  try {
    return JSON.parse(window.localStorage.getItem(CONV_SETTINGS_KEY) || "{}") || {};
  } catch (error) {
    return {};
  }
}
function writeConvSetting(id, settings) {
  if (!id) return;
  try {
    const all = readConvSettings();
    all[id] = settings;
    window.localStorage.setItem(CONV_SETTINGS_KEY, JSON.stringify(all));
  } catch (error) {
    /* 隐私模式写不了就只活这次 */
  }
}

		// 端点协议选择：宿主老版本还没有 config.defaultEndpoint 这个字段（重启后才吃到），
		// 本地存一份，选择在刷新之间就不会丢。
		const ENDPOINT_KEY = "dsh.velapi-image-go.endpoint";

		// 侧栏面板挂载时广播：停靠面板据此让位（避免同一个入口在窗口上出现两次）
		const PANE_EVENT = "velapi-image-go:rightbar-pane";
		let rightbarPaneMounted = false;
		// 挂载 ≠ 看得见。宿主对注册时写了 keepMounted 的 tab 会一直挂着，
		// 非激活时用 display:none 藏着（这样切 tab 不丢状态）。以前只广播 mounted，
		// 停靠面板就把自己的入口胶囊收了起来 —— 用户切到别的 tab、或者重启后右侧栏
		// 停在「开始」页，整个工作台就一个入口都不剩，看起来就是「插件不见了」。
		let rightbarPaneVisible = false;
		// 再强一档：真的和视口相交（IntersectionObserver 说的），才算「用户正看着工作台」。
		// 几何量（offsetWidth/height + visibility）在过渡动画、被别的层盖住、或宿主用
		// 位移藏面板时都会说谎；一旦说谎，停靠面板会以为自己该让位，于是入口全没了。
		let rightbarPaneOnScreen = false;
		// 右侧栏席位的登记过程留痕：新版权威守卫下「服务还没到就 get」会抛异常，
		// 只有把原文和尝试次数发回宿主，下次再出问题才不用猜。
		let rightbarProbeError = "";
		let rightbarAttempts = 0;

		/* 端点协议：和宿主 lib/index.js 的 PROTOCOLS 是同一套 id（宿主测试卡着两边不许漂移）。
		   选项照中转站那张表，再补上生图这条链要用的三条：images/generations、images/edits、
		   videos/generations。宿主 /status 会把带 label 的整表发下来，这里只是老宿主/离线预览的兜底。 */
		const PROTOCOL_IDS = [
			"auto",
			"openai_chat",
			"openai_responses",
			"openai_responses_compact",
			"anthropic_messages",
			"gemini_generate",
			"jina_rerank",
			"images_generations",
			"images_edits",
			"videos_generations",
			"embeddings"
		];

		/** 协议 id → 文案 key（宿主 /status 带了 label 就用宿主那份，这里只是兜底）。 */
		const PROTOCOL_LABEL_KEYS = {
			auto: "prov.endpointAuto",
			openai_chat: "prov.endpointOpenai",
			openai_responses: "prov.endpointResponses",
			openai_responses_compact: "prov.endpointResponsesCompact",
			anthropic_messages: "prov.endpointAnthropic",
			gemini_generate: "prov.endpointGemini",
			jina_rerank: "prov.endpointRerank",
			images_generations: "prov.endpointImages",
			images_edits: "prov.endpointEdits",
			videos_generations: "prov.endpointVideos",
			embeddings: "prov.endpointEmbeddings"
		};

		/** 协议 id → 短名文案 key（输入框那一行只放得下短名）。 */
		const PROTOCOL_SHORT_KEYS = {
			auto: "prov.shortAuto",
			openai_chat: "prov.shortOpenai",
			openai_responses: "prov.shortResponses",
			openai_responses_compact: "prov.shortResponsesCompact",
			anthropic_messages: "prov.shortAnthropic",
			gemini_generate: "prov.shortGemini",
			jina_rerank: "prov.shortRerank",
			images_generations: "prov.shortImages",
			images_edits: "prov.shortEdits",
			videos_generations: "prov.shortVideos",
			embeddings: "prov.shortEmbeddings"
		};

		/** 下拉选项：宿主给了整表就用宿主那套，老宿主（还没这条字段）用本地兜底照常能选。 */
		function protocolOptions(protocols) {
			if (Array.isArray(protocols) && protocols.length > 0) {
				return protocols.map((row) => ({
					id: row.id,
					label: row.label || t(PROTOCOL_LABEL_KEYS[row.id] || row.id)
				}));
			}
			return PROTOCOL_IDS.map((id) => ({ id, label: t(PROTOCOL_LABEL_KEYS[id] || id) }));
		}

		const GEMINI_NATIVE = "gemini_generate";
		const geminiReady = protocols => (protocols || []).some(p => p.id === GEMINI_NATIVE && p.kind === "image");
		function generationProtocols(protocols) {
			const allowed = protocols?.length ? protocols.filter(p => ["auto", "image", "video"].includes(p.kind) && p.id !== GEMINI_NATIVE)
				: ["auto", "images_generations", "images_edits", "videos_generations"].map(id => ({id}));
			return [...allowed.map(p => ({id:p.id, label:p.label || t(PROTOCOL_LABEL_KEYS[p.id] || p.id)})),
				{id:GEMINI_NATIVE, label:t("prov.endpointGemini"), disabled:!geminiReady(protocols)}];
		}

		/** 长名（含路由）：当 title 用，鼠标停一下能看到完整那条。 */
		function protocolLabel(protocols, id) {
			const hit = protocolOptions(protocols).find((row) => row.id === (id || "auto"));
			return hit ? hit.label : t("prov.endpointAuto");
		}

		/** 短名：下拉里显示的就是它（宽栏窄栏都不会把这一行撑开）。 */
		function protocolShortLabel(id) {
			return t(PROTOCOL_SHORT_KEYS[id] || PROTOCOL_SHORT_KEYS.auto);
		}

		/* ------------------------------------------------------------------ *
		 * 文案
		 * ------------------------------------------------------------------ */

		const zh = {
			"grid.title": "宫格拆分",
			"grid.intro": "选中一格，可单独导出或重新生成。", "grid.overview": "宫格预览", "grid.selectHint": "点击画面中的编号选择格子。",
			"grid.editor": "编辑单格", "grid.review": "确认候选", "grid.description": "画面描述", "grid.before": "对照修改前", "grid.showingBefore": "正在查看修改前", "grid.pending": "候选预览 · 尚未填回",
			"grid.reviewNote": "确认只替换当前格；弃用可返回修改描述。", "grid.exports": "导出图片", "grid.exportPending": "先确认或弃用候选，再导出。", "grid.exportHint": "导出不会覆盖原图。",
			"grid.cell": "当前格", "grid.uploadLimit": "这格的 PNG 超出上传限制。请增加行列数，或改用纯文字生成。",
			"grid.rows": "行",
			"grid.cols": "列",
			"grid.coord": "第 {r} 行 · 第 {c} 列",
			"grid.fill": "填补方式",
			"grid.edit": "以选中格重绘",
			"grid.generate": "从文字新生一格",
			"grid.prompt": "描述这一格要生成的画面或需要改动的细节…",
			"grid.submit": "生成这一格",
			"grid.cellPNG": "导出单格 PNG",
			"grid.allZIP": "拆分全部 · ZIP",
			"grid.sheetPNG": "下载填补后的整图",
			"grid.apply": "确认填回选中格",
			"grid.discard": "弃用候选",
			"grid.preview": "候选预览 · 将居中裁切至原格比例",
			"grid.sheet": "宫格工作副本",
			"grid.safe": "生成会使用当前供应商额度。预览满意后再填回。",
			"grid.dirty": "已更新工作副本，请下载整图；原图未修改。",
			"grid.needModel": "当前不是可用的图片模型。可继续拆格导出，或先关闭并切换图片模型。",
			"grid.busy.load": "正在读取原图…",
			"grid.busy.generate": "正在生成候选，请稍候…",
			"grid.busy.export": "正在打包或导出…",
			"grid.leaveJob": "关闭预览？已提交的任务可能继续生成；不会自动填回。",
			"grid.leaveDraft": "关闭并放弃未下载的整图修改或未应用的候选？原图不会改变。",
			"grid.readError": "无法读取图片",
			"grid.unsupportedSource": "宫格不支持这个图片地址（{scheme}）。请使用当前工作台图库中的原图。",
			"grid.retryLoad": "重新加载原图", "grid.notFound": "找不到原图文件（404），请在图片管理中检查该素材是否还在。",
			"grid.localRead": "图片读取中断，未能取得完整像素。请重试读取图片。", "grid.remoteRead": "外部图片无法读取像素，请使用已保存到本站图库的原图。",
			"grid.badImage": "文件无法解码为图片，请检查原图是否完整。", "grid.readTimeout": "读取图片超时，请重试。",
			"grid.imageLimit": "图片过大：最长边须在 16,384 像素以内，总像素不超过约 5,000 万。",
			"grid.encodeError": "无法导出 PNG，请检查浏览器内存后重试。",
			"grid.waitTimeout": "等待超时。请先到原会话核对任务，不要重复提交。",
			"grid.missingResult": "任务没有返回可用图片。",
			"grid.close": "关闭宫格拆分",
			"chat.noReceipt": "未收到任务编号", "chat.noReceiptHint": "没有收到提交回执。请先查看任务记录，避免重复生图。",
			"chat.restorePrompt": "取回提示词", "chat.replaceForRecovery": "用这条提示词替换正在写的文字？参考图保持不变。", "chat.dismissRecovery": "忽略这条提示",
			"chat.requestInfo": "本次生成",
			"chat.directHint": "发送会直接生图，不会让对话模型改写提示词。可在 JSON 请求体中核对本次参数。",
			"tab.title": "生图工作台",
			"guide.desc": "对话生图 · 图库 · 供应商",
			"nav.title": "API 对话生图工作台",
			"nav.kicker": "STUDIO",
			"nav.chat": "对话生图",
			"nav.library": "图片管理",
			"nav.notes": "信息管理",
			"nav.providers": "供应商管理",
			"nav.ps": "图片处理",
			"ps.tool.transform": "自由变换",
			"ps.transform.pixels":"变换像素", "ps.transform.mask":"矩形蒙版", "ps.transform.resetMask":"移除矩形蒙版", "ps.transform.maskHint":"拖动锚点调整可见区域，不移动或拉伸图片像素。移除蒙版可恢复原图。", "ps.transform.limit":"变换后的画布超出像素或图层内存预算，请减小拖动距离。",
			"ps.transform.hint": "拖中心移动，拖边点或角点缩放。按住 Shift 等比缩放，松开提交，Esc 取消本次拖动。",
			"ps.tool.select": "框选",
			"ps.tool.crop": "裁切",
			"ps.tool.split": "切割拆分",
			"ps.tool.rotate": "旋转",
			"ps.tool.straighten": "矫正",
			"ps.tool.warp": "透视矫正",
			"ps.tool.canvasSize": "画布",
			"ps.tool.feather": "羽化",
			"ps.tool.resize": "缩放",
			"ps.tool.flip": "翻转",
			"ps.noSource": "还没有图",
			"ps.empty": "先给一张图",
			"ps.empty.hint": "上传本地图、从图库里挑一张，或直接把图片拖进来（生成结果都在图库里）",
			"ps.drop.hint": "松手载入这张图",
			"ps.tool.adjust": "调整",
			"ps.adjust.brightness": "亮度",
			"ps.adjust.contrast": "对比度",
			"ps.adjust.saturation": "饱和度",
			"ps.adjust.hue": "色相",
			"ps.adjust.grayscale": "灰度",
			"ps.adjust.invert": "反相",
			"ps.adjust.reset": "复位",
			"ps.adjust.apply": "应用",
			"ps.adjust.done": "已应用调整",
			"ps.float.drag": "按住拖动这块浮窗",
			"ps.history": "历史操作记录",
			"ps.history.now": "当前",
			"ps.adjust.tone": "色调",
			"ps.adjust.vibrance": "自然饱和度",
			"ps.adjust.curves": "曲线",
			"ps.adjust.curveBrighten": "提亮",
			"ps.adjust.curveDarken": "压暗",
			"ps.adjust.curveContrast": "S 曲线",
			"ps.adjust.curveInvert": "反相曲线",
			"ps.adjust.levels": "色阶",
			"ps.adjust.inBlack": "黑场",
			"ps.adjust.inWhite": "白场",
			"ps.adjust.gamma": "中间调",
			"ps.adjust.applyLevels": "应用色阶",
			"ps.adjust.applyCurve": "应用曲线",
			"ps.adjust.curveHint": "拖动控制点改形状，点空白处加点，右键删点",
			"ps.adjust.filters": "滤镜",
			"ps.adjust.blur": "模糊",
			"ps.adjust.sharpen": "锐化",
			"ps.adjust.noise": "噪点",
			"ps.adjust.applyFilters": "应用滤镜",
			"ps.layers": "图层",
			"ps.layers.collapse": "收纳图层面板",
			"ps.layers.expand": "展开图层面板",
			"ps.layer.addLayer": "加图层",
			"ps.layer.duplicate": "复制当前",
			"ps.layer.remove": "删除图层",
			"ps.layer.up": "上移",
			"ps.layer.down": "下移",
			"ps.layer.visible": "显示 / 隐藏",
			"ps.layer.maskAdd": "加蒙版（有选区就用选区）",
			"ps.layer.edit": "编辑这一层",
			"ps.layer.editing": "正在编辑图层「{name}」",
			"ps.layer.committed": "图层「{name}」已更新",
			"ps.layer.back": "回到合成",
			"ps.layer.sessionHint": "工具正在作用在这一层上（回到合成会写回）",
			"ps.layer.maskInvert": "反转蒙版",
			"ps.layer.maskRemove": "删掉蒙版",
			"ps.layer.opacity": "不透明度",
			"ps.layer.mode": "叠加算法",
			"ps.layer.new": "新图层",
			"ps.layer.props": "图层属性",
			"ps.layer.empty": "还没有图层。加一层就能用叠加算法（正片叠底 / 滤色 / 叠加 / 变暗 / 变亮 / 相加）。",
			"ps.layer.base": "底图",
			"ps.layer.baseHint": "合成的最底层：你正在编辑的这张图本身。畸变 / 裁切 / 旋转改的就是它，不会另存一层；落定后这里显示的就是变换后的图。",
			"ps.layer.baseTag": "基准",
			"ps.layer.normal": "正常",
			"ps.layer.multiply": "正片叠底",
			"ps.layer.screen": "滤色",
			"ps.layer.overlay": "叠加",
			"ps.layer.darken": "变暗",
			"ps.layer.lighten": "变亮",
			"ps.layer.add": "相加",
			"ps.drop.none": "拖进来的不是图片文件，也没有可用的图片地址",
			"ps.replace": "换一张",
			"ps.reload": "重置工具参数",
			"ps.apply": "应用",
			"ps.reset": "清零",
			"ps.undo": "撤销",
			"ps.redo": "重做",
			"ps.download": "下载",
			"ps.toReference": "设为参考图",
			"ps.toReferenceBusy": "上传中…",
			"ps.none": "没有选区",
			"ps.needSelection": "先在图上拖一个选区",
			"ps.toSelect": "去框选",
			"ps.select.hint": "在图上拖出选区，拖框内可移动，拖八个手柄可改大小。",
			"ps.select.all": "全选",
			"ps.select.none": "取消选区",
			"ps.crop.hint": "按当前选区裁掉四周。",
			"ps.split.cols": "列数",
			"ps.split.rows": "行数",
			"ps.split.run": "切块",
			"ps.splitDone": "切成 {n} 块",
			"ps.tileUse": "换这张",
			"ps.tileLoaded": "已载入第 {n} 块",
			"ps.rotate.ccw": "逆时针 90°",
			"ps.rotate.cw": "顺时针 90°",
			"ps.rotate.180": "旋转 180°",
			"ps.rotate.free": "任意角度",
			"ps.straighten.hint": "在图上沿着那条本该水平（或竖直）的边拖一条线 —— 拖的时候画面实时转，松手就矫正。",
			"ps.straighten.auto": "自动矫正",
			"ps.straighten.autoBusy": "估算中…",
			"ps.straighten.manual": "手动角度",
			"ps.straighten.drag": "拖一条参考线",
			"ps.straighten.dragHint": "Esc 取消这次拖拽；自动矫正不用拖，直接估。",
			"ps.straighten.live": "实时预览 {angle}°",
			"ps.straighten.last": "上次矫正 {angle}°",
			"ps.straighten.tooShort": "线太短了，拖着边拉长一点",
			"ps.straightened": "已矫正 {angle}°",
			"ps.straightAlready": "看着已经端正了，没动",
			/* 四点透视矫正：把「取图四点」映到「目标四点」 */
			"ps.warp.pick": "点选四角",
			"ps.warp.pickHint": "在画面上依次点四个角（异形四边形也行），点满 4 个再按「确认矫正」。",
			"ps.warp.confirm": "确认矫正",
			"ps.warp.flipH": "水平翻转",
			"ps.warp.flipV": "垂直翻转",
			"ps.warp.flipNone": "先点「确认矫正」生成图层，再翻转",
			"ps.warp.locked": "已锁定：四角固定，画面已矫正",
			"ps.warp.pickCount": "已选 {n} / 4",
			"ps.warp.mode": "方式",
			"ps.warp.mode.flat": "四点畸变",
			"ps.warp.mode.free": "自由拉伸",
			"ps.warp.mode.distort": "变形",
			"ps.warp.hint.flat": "在原图点选四个角。绿色点按点击顺序编号，选满后可拖动微调。",
			"ps.warp.hint.free": "切换取图点或目标点，分别拖动绿色或橙色四角。",
			"ps.warp.hint.distort": "拖动橙色目标点，取图范围固定为整张原图。",
			"ps.warp.out": "输出 {w} × {h}",
			"ps.warp.drag": "拖角点定位置",
			"ps.warp.reset": "重置四点",
			"ps.warp.view": "视图",
			"ps.warp.side.src": "取图点",
			"ps.warp.side.dst": "目标点",
						"ps.warp.liveTag": "仅确认后生效",
			"ps.warp.tip": "确认或按 Enter 新建并打开矫正图层；切换工具和导出不会应用未确认的选区。",
			"ps.warp.done": "已矫正 {w} × {h}",
			"ps.warp.degenerate": "四点不能重合、不能三点共线，也不能凹进去或交叉（那样画面会翻到四边形外面），挪一下再试。",
			"ps.width": "宽",
			"ps.height": "高",
			"ps.anchor": "原图落点",
			"ps.fill": "空白处",
			"ps.fill.none": "透明",
			"ps.fill.white": "白色",
			"ps.fill.grey": "浅灰",
			"ps.feather.radius": "羽化半径",
			"ps.feather.all": "整张边缘",
			"ps.feather.selection": "选区边缘",
			"ps.resize.keep": "保持比例",
			"ps.flip.h": "水平翻转",
			"ps.flip.v": "垂直翻转",
			"ps.zoom.fit": "适应窗口",
			"ps.zoom.actual": "1:1",
			"ps.zoom.in": "放大",
			"ps.zoom.out": "缩小",
			"ps.zoom.hint": "滚轮缩放 · 中键拖动平移",
			"ps.canvas.unit": "单位",
			"ps.canvas.unit.px": "像素",
			"ps.canvas.unit.percent": "百分比",
			"ps.canvas.preset": "常用尺寸",
			"ps.canvas.current": "当前 {w} × {h} · {dpi} DPI",
			"ps.canvas.dpi": "分辨率",
			"ps.canvas.dpi.hint": "写进导出的 PNG / JFIF 头，不重采样",
			"ps.dpi.applied": "分辨率已设为 {dpi} DPI",
			"ps.panels.tools": "工具条",
			"ps.panels.params": "参数",
			"ps.collapse": "收起",
			"ps.expand": "展开",
			"ps.focus": "专注画布",
			"ps.focus.exit": "退出专注",
			"ps.keys": "快捷键",
			"ps.keys.tools": "切换工具",
			"ps.keys.view": "画布视图",
			"ps.keys.edit": "编辑",
			"ps.keys.out": "出口",
			"ps.keys.note": "在输入框里打字时这些键不生效；画布要先有图。",
			"ps.key.selectAll": "全选选区",
			"ps.key.clearSel": "取消选区",
			"ps.key.focus": "专注画布（收起两侧）",
			"ps.key.apply": "应用当前工具",
			"ps.key.help": "打开这张表",
			"ps.keys.record": "点一下，再按新的组合键",
			"ps.keys.press": "按下组合…",
			"ps.keys.none": "未绑定",
			"ps.keys.reset": "恢复默认",
			"ps.keys.resetAll": "全部恢复默认",
			"ps.keys.taken": "{keys} 已被「{who}」占用",
			"ps.keys.hint": "点键帽就能改：按任意组合（可带 Ctrl / Shift / Alt），Esc 取消，Backspace 恢复这一条。",
			"ps.empty.recent": "最近生成",
			"ps.empty.samples": "预设样张",
			"ps.empty.more": "显示更多",
			"ps.empty.step1": "上传本地图，或用下面的最近生成",
			"ps.empty.step2": "左边选框工具，右边调参数",
			"ps.empty.step3": "「设为参考图」或「下载」拿走",
			"rail.library": "图库",
			"rail.notes": "信息",
			"rail.jobs": "任务",
			"chat.hint.title": "描述画面，或添加参考图开始创作",
			"chat.hint.sub": "例如：生成一张产品图、场景图或风格图",
			"chat.placeholder": "描述你想要生成的图片内容；Ctrl+V 粘贴参考图。Enter 生成，Shift+Enter 换行。",
			"chat.send": "生成",
			"chat.sendKeys": "Enter 生成，Shift+Enter 换行",
			"chat.replaceDraft": "用这条历史记录的提示词和参考图替换当前草稿？取消可保留现有内容。",
			"chat.sending": "生成中…",
			"chat.you": "你",
			"chat.assistant": "工作台",
			/* 过程留痕：这条任务是界面点的、对话里工具调的，还是外部程序打进来的 */
			"chat.source": "来源",
			"chat.sourceUi": "工作台",
			"chat.sourceTool": "工具调用",
			"chat.sourceApi": "外部接口",
			"chat.session": "会话",
			"chat.empty": "还没有生成记录，先写一句提示词试试。",
			"chat.retry": "重试",
			"chat.editPrompt": "编辑提示词（填回输入框）",
			"chat.edited": "已填回输入框，改完再发",
			"chat.confirmDelete": "删除这条对话记录？（图库里的图不受影响）",
			"chat.deleted": "已删除这条记录",
			/* 对话（会话）：新建不带记忆，每个会话隔离 */
			"chat.newConv": "新建对话",
			"chat.newConvHint": "已新建对话（不带上一段记忆）",
			"chat.renameConv": "重命名对话",
			"chat.deleteConv": "删除对话",
			"chat.confirmDeleteConv": "删除这个对话和它的全部记录？（图库里的图不受影响）",
			"chat.deletedConv": "已删除这个对话",
			"chat.convList": "切换对话",
			"chat.untitledConv": "未命名",
			"chat.convMemory": "每个对话的记忆互相隔离：新建对话不带上一段上下文",
			"chat.context": "上下文",
			"chat.contextOn": "上下文管理：开 —— 每轮先由对话模型把本对话的历史整理成提示词",
			"chat.contextPanel": "对话模型",
			"chat.dialogDesc": "本面板保留旧版设置。发送始终直接生图，不调用对话模型。",
			"chat.dialogNotReady": "Chat endpoint not ready: refresh the page (F5); restart DSH only if it still fails",
			"chat.contextDesc": "只负责整理提示词与读取配置，不直接调用供应商出图。",
			"chat.contextAuto": "优化提示词",
			"chat.contextTurns": "上下文轮数",
			"chat.contextNoAuto": "限制上下文模型直接调供应商出图",
			"chat.contextNoAutoHint": "开启后只按你的原话出图，它只做整理与分类。",
			"chat.contextChatModel": "对话模型",
			"chat.contextChatModelHint": "只用它把历史整理成提示词，不参与生图；生图模型在输入框那一行选。",
			"chat.contextWired": "已读取：对话 {chat} · 生图 {image} · 尺寸 {size}",
			"chat.contextAutoChat": "自动",
			"chat.contextOnShort": "已开",
			"chat.contextOffShort": "已关",
			"chat.contextOff": "上下文管理：关 —— 按原话直接生成",
			"chat.planFailed": "上下文整理失败，已按原话生成",
			"chat.planRewrite": "改写",
			"chat.sizeCustom": "自定义",
			"chat.videoSize": "视频尺寸",
			"chat.videoRatio": "比例",
			"chat.videoResolution": "分辨率",
			"chat.videoSeconds": "时长（秒）",
			"chat.cancel": "取消",
			"chat.copy": "复制链接",
			"chat.copyTitle": "复制的是链接文本（想贴图片请用「复制图片」）",
			"chat.reuse": "用这张重绘",
			"chat.open": "打开原图",
			// 窄栏里缩略图动作行放不下全称，用短文案（title 仍是全称）
			"chat.copyShort": "复制",
			"chat.reuseShort": "重绘",
			"chat.openShort": "原图",			"chat.saved": "已保存进图库",
			"chat.save": "保存到本地",
			"chat.saveShort": "保存",
			"chat.saveTitle": "保存一份到本地文件夹（拖到资源管理器不稳时用这个）",
			"chat.copyImage": "复制图片",
			"chat.copyImageTitle": "复制图片本身：PPT / 文档里 Ctrl+V 贴出来就是图",
			"chat.downloading": "开始下载图片文件…",
			"common.imageCopied": "图片已复制，直接粘贴到别的程序",
			"common.savedTo": "已保存到 {path}",
			"chat.counter": "{n}/500",
			"chat.over": "提示词过长，已截断到 500 字",
			"panel.image": "图片",
			/* 右侧检查器折叠 */
			"side.title": "面板",
			"side.collapse": "收起右侧栏",
			"side.expand": "展开右侧栏",
			"side.tab": "图片 · 预设 · 供应商",
			"panel.image.hint": "支持图片上传，或从图库选择",
			"panel.upload": "上传图片（也可以直接 Ctrl+V 粘贴）",
			"chat.pasted": "已粘贴为参考图",
			"chat.refClear": "移除参考图",
			"chat.refLimit": "参考图最多挂 4 张，先移掉一张",
			"chat.modelInvalid": "当前模型不能生图（是对话/音频模型，或不在任何供应商目录里），先选一个图片模型",
			"chat.queueFull": "发送太快了：这一句处理完再发下一句（最多排 6 条）",
			"chat.jsonBody": "JSON 请求体",
			"chat.jsonHint": "修改的字段仅用于本会话的下一次发送；会话 ID 由工作台管理。size 是档位，aspect_ratio 是宽高比。关闭原样发送则转换为像素。",
			"chat.jsonApply": "应用",
			"chat.jsonReset": "恢复默认",
			"chat.jsonApplied": "已应用 JSON 覆盖",
			"chat.jsonInvalid": "JSON 格式不对",
			"chat.sizeRaw": "尺寸原样发送（档位 + 宽高比，不转像素）",
			"chat.thinking": "等待提交…",
			"chat.emptyReply": "（对话模型没有返回内容，换个对话模型再试一次）",
			"chat.modelSwitched": "当前模型不能生图，已自动切到 {model}",
			"chat.toBottom": "回到底部",
			"chat.expandTools": "展开更多参数",
			"chat.collapseTools": "收起参数",
			"chat.me": "我",
			"chat.meRef": "这次带着的参考图",
			"chat.stale": "状态未更新",
			"chat.staleHint": "任务还停在执行中：宿主可能重启过，刷新一下看最新状态。",
			"chat.staleRefresh": "刷新",
			"chat.meShort": "我",
			"panel.pick": "从图库选择",
			"panel.info": "信息",
			"panel.info.placeholder": "请输入图片相关信息，如：尺寸、风格、场景等",
			"panel.provider": "供应商",
			"panel.provider.pick": "请选择供应商",
			"panel.params": "参数",
			"lib.search": "搜索文件名 / 提示词",
			"lib.allModels": "全部模型",
			"chat.model": "生成模型",
			"model.none": "未选择模型",
			"model.list": "模型列表",
			"model.search": "搜索模型",
			"model.empty": "没有匹配的模型",
			"model.count": "{n} 个",
			"model.kind.image": "图片",
			"model.kind.video": "视频",
			"model.kind.audio": "音频",
			"model.kind.chat": "对话",
			"model.kind.other": "其它",
			"model.disabled": "未开通",
			"lib.selected": "已选 {n} 张",
			"lib.delete": "删除",
			"lib.rename": "重命名",
			"lib.refresh": "刷新",
			"lib.pages": "图片分页", "lib.prevPage": "上一页", "lib.nextPage": "下一页",
			"lib.moreIndex": "载入更早的图片（已载入 {n}/{total}）",
			"lib.density": "布局密度",
			"lib.view": "视图",
			"lib.view.grid": "网格",
			"lib.view.stage": "大图",
			"lib.marquee": "框选",
			"lib.brush": "画笔",
			"lib.brushSize": "粗细",
			"lib.maskHint": "写下要改什么（框选/画笔区域会被重画）",
			"lib.maskSend": "发送",
			"lib.maskEmpty": "先写一句要改什么",
			"lib.maskQueued": "已提交局部改图，去对话页看结果",
			"lib.maskClear": "清空",
			"lib.density.compact": "小图",
			"lib.density.standard": "标准",
			"lib.density.large": "大图",
			"lib.empty": "图库还是空的。",
			"lib.confirmDelete": "确认删除选中的 {n} 张图片？",
			"notes.new": "新建信息",
			"notes.title": "标题",
			"notes.prompt": "提示词",
			"notes.meta": "元信息",
			"notes.tags": "标签（逗号分隔）",
			"notes.save": "保存",
			"notes.delete": "删除",
			"notes.insert": "插入输入框",
			/* 输入框旁的信息卡快捷选择：一级列卡片，二级才跳信息管理页 */
			"notes.pickTitle": "信息卡",
			"notes.pickHint": "信息卡：点开快速选一张插入输入框（管理在二级）",
			"notes.pickManage": "管理",
			"notes.pickEmpty": "还没有信息卡",
			"notes.pickCreate": "去新建",
			"notes.pickMore": "还有 {n} 张，去信息管理里看",
			"notes.empty": "还没有信息记录。把好用的提示词存下来，下次一键复用。",
			"panel.presets": "预设卡",
			"preset.new": "新建预设",
			"preset.empty": "还没有预设卡。点「新建预设」自己做一张，标题 + 提示词 + 参考图随你配。",
			"preset.use": "用这张",
			"preset.edit": "编辑",
			"preset.delete": "删除",
			"preset.title": "标题",
			"preset.prompt": "提示词",
			"preset.image": "参考图",
			"preset.tags": "标签（逗号分隔）",
			"preset.upload": "上传参考图",
			"preset.fromLibrary": "从图库选",
			"preset.clearImage": "移除参考图",
			"preset.reset": "找回内置卡",
			"preset.used": "已套用「{title}」",
			"preset.builtin": "内置",
			"preset.cover": "无参考图",
			"preset.count": "{n} 张",
			"prov.add": "新增供应商",
			"prov.name": "名称",
			"prov.baseUrl": "接口地址",
			"prov.key": "API Key",
			"prov.keyEnv": "环境变量名",
			"prov.chatModel": "对话模型",
			"prov.chatOnlyHint": "对话模型和上下文轮数仅供独立对话接口使用，工作台发送不会读取。",
			"prov.chatModelAuto": "自动（目录里第一个对话模型）",
			"prov.contextTurns": "上下文轮数（0~12）",
			"prov.keyHint": "留空表示沿用当前配置里的密钥",
			"prov.models": "模型（逗号分隔）",
			"prov.test": "测试连接",
			"prov.testOk": "已连通",
			"prov.testBad": "连不上",
			"prov.testModels": "个模型",
			"prov.refresh": "拉取模型",
			"prov.delete": "删除",
			"prov.makeActive": "设为当前",
			"prov.active": "当前",
			"prov.note": "备注",
			"prov.endpoint": "端点类型",
			"prov.endpointAuto": "自动检测（默认）",
			"prov.endpointHint": "按协议决定生成打到哪条路由；自动检测＝带参考图走编辑、不带参考图走生成",
			/* 素材目录（默认本地，可改） */
			"prov.storage": "素材目录",
			"prov.storageHint": "迁移成功后清理已核对的旧副本，其他文件保留。有任务运行时不能迁移。",
			"prov.storageOpen": "打开目录",
			"prov.storageMove": "迁移到…",
			"update.check": "检查更新",
			"update.title": "更新", "update.pulledLabel": "已拉取",
			"update.latest": "已是最新版本",
			"update.ready": "有新版本，按 PR 流程更新",
			"update.behind": "远端有更新 {sha}，拉取后需重启 DSH",
			"update.clickAgain": "再点一次拉取更新，不会重启 DSH",
			"update.applied": "已拉取到 {sha}，DSH 未重启",
			"update.restarting": "正在重启 DSH：页面会短暂断开，重连后即新版本",
			"update.pullFailed": "更新失败：{reason}",
			"update.notWired": "更新通道还没接壤（宿主未实现 /update/check）",
			"update.networkBlocked": "网络无法链接，需要特殊网络环境",
			"update.prFlow": "PR 流程",
			"prov.storageMoveTitle": "迁移素材目录",
			"prov.storageTarget": "新目录的完整路径",
			"prov.storageMovePick": "素材和供应商配置会迁到新目录。确认迁移后，已核对的旧副本将被删除。请使用自己的专用空目录。",
			"prov.storageUnconfirmed": "宿主未确认切换目录。请核对当前目录；若使用旧宿主，请更新并重新加载后再试。",
			"prov.storageAbsolute": "请输入完整路径，不要使用相对路径。",
			"prov.storageSame": "这是当前素材目录，请填写其他目录。",
			"prov.storageConfirm": "确认迁移",
			"prov.storageBusy": "正在复制素材，请稍候…",
			"prov.storageRefreshFailed": "目录已切换，但图库刷新失败，请到图片管理点击刷新。",
			"prov.storageSaved": "已切到 {dir}",
			"prov.storageMoved": "复制了 {files} 个文件、{indexes} 份索引",
			"prov.storageCleaned": "已清理 {removed} 个旧文件",
			"prov.storageRetained": "有 {retained} 项保留在旧位置，请检查旧目录",
			"prov.storageCleanupUnknown": "宿主未报告旧目录清理结果",
			"prov.storageCurrent": "当前目录",
			"prov.storageNeedRestart": "素材目录设置要重启 DSH 后才生效（宿主还是旧版本）",
			/* 图片查看器 */
			"viewer.title": "图片查看器",
			"viewer.prev": "上一张",
			"viewer.next": "下一张",
			"viewer.zoomIn": "放大",
			"viewer.zoomOut": "缩小",
			"viewer.fit": "适应窗口",
			"viewer.actual": "原始大小",
			"viewer.hint": "滚轮缩放 · 拖动平移 · ←/→ 切换 · Esc 关闭",
			"viewer.useRef": "用作参考图",
			"viewer.quad": "四点变形（角点可拖出图外）",
			"viewer.quadTip": "拖四个角，可以拖出图外；凹四边形解不出透视，Esc 退出",
			"viewer.quadApply": "应用变形",
			"viewer.quadReset": "重置角点",
			"viewer.quadDone": "变形完成，已存进图库",
			"viewer.quadBad": "四个角必须是凸四边形，解不出透视",
			"viewer.quadFail": "变形失败",
			"viewer.edit": "图片处理",
			"viewer.delete": "删除",
			"viewer.download": "下载文件",
			"viewer.counter": "{i} / {n}",
			"viewer.missing": "图片加载失败",
			/* 快捷拖拽 */
			"common.dragHint": "拖到输入框当参考图 · 拖到图片处理里编辑 · 拖到 PPT / 桌面 = 真图片文件",
			"common.restartNeed": "宿主旧版本 · 重启 DSH 生效",
			"common.restartHint": "这版界面需要新版宿主。请**关闭 DSH 再打开**（只刷新页面不够）：重启后「拖到 PPT / 桌面 = 图片文件」「图生图 multipart 修复」等宿主侧能力才会生效。",
			"common.noNativeDrag": "拖出不可用 · 用复制图片",
			"common.noNativeDragHint": "宿主没有 Electron 原生拖拽能力，拖到 PPT / 桌面拿不到文件。请在查看器里点「复制图片」再 Ctrl+V，或用「保存到本地」再从文件夹拖。",
			"prov.endpointOpenai": "OpenAI（/v1/chat/completions）",
			"prov.endpointResponses": "OpenAI Responses（/v1/responses）",
			"prov.endpointResponsesCompact": "OpenAI Response Compaction（/v1/responses/compact）",
			"prov.endpointAnthropic": "Anthropic（/v1/messages）",
			"prov.endpointGemini": "Gemini（/v1beta/models/{model}:generateContent）",
			"prov.endpointRerank": "Jina Rerank（/v1/rerank）",
			"prov.endpointImages": "图片生成（/v1/images/generations）",
			"prov.endpointEdits": "图片编辑（/v1/images/edits）",
			"prov.endpointVideos": "视频生成（/v1/videos/generations）",
			"prov.endpointEmbeddings": "向量（/v1/embeddings）",
			/* 输入框那一行只放得下短名：下拉里显示短名，title 上挂全名与路由 */
			"prov.shortAuto": "自动检测",
			"prov.shortOpenai": "OpenAI 对话",
			"prov.shortResponses": "Responses",
			"prov.shortResponsesCompact": "Responses 压缩",
			"prov.shortAnthropic": "Anthropic",
			"prov.shortGemini": "Gemini 原生",
			"chat.geminiReload": "当前宿主不支持 Gemini 原生生图。请更新插件并重启 DSH；仅刷新页面不会加载新宿主。",
			"chat.geminiParams": "Gemini 原生每次仅生成 1 张；请选择当前模型支持的分辨率和比例，不支持蒙版或视频时长。",
			"chat.geminiRatio": "图片比例", "chat.geminiSize": "图片分辨率",
			"prov.shortRerank": "重排",
			"prov.shortImages": "图片生成",
			"prov.shortEdits": "图片编辑",
			"prov.shortVideos": "视频生成",
			"prov.shortEmbeddings": "向量",
			"err.upstream": "上游报错",
			"err.upstreamShow": "看原始报错",
			"err.upstreamHide": "收起",
			"err.upstreamCopy": "复制报错",
			"err.upstreamCopied": "报错已复制",
			"err.upstreamRoute": "请求",
			"err.upstreamStatus": "状态",
			"err.upstreamBody": "上游原始响应",
			"err.upstreamNone": "上游没给响应体",
			"err.upstreamClose": "关闭",
			"err.upstreamRetry": "用这条提示词重试",
			"chat.video": "视频任务",
			"chat.videoQueued": "上游返回的是任务体，没给现成地址（原始响应见下）",
			"prov.runtime": "运行期配置",
			"prov.keyMask": "密钥",
			"prov.keyRuntime": "跟随运行期",
			"prov.modelsLabel": "模型",
			"prov.modelsNone": "未拉取",
			"prov.modelsMany": "{name} 等 {n} 个",
			"prov.listCount": "{n} 个",
			"prov.edit": "编辑",
			"prov.empty": "还没有供应商，点右上角新增一个",
			"prov.save": "保存",
			"prov.close": "关闭",
			"common.empty": "无",
			"common.ok": "完成",
			"common.failed": "失败",
			"common.loading": "加载中…",
			"common.open": "在右侧栏打开工作台",
			"common.reloadShell": "重载界面",
			"common.service": "服务端未就绪",
			"status.nokey": "未配置密钥",
			"status.key": "密钥 {mask}",
			"status.pending": "队列 {n}",
			"err.network": "无法连接工作台服务：{error}"
		};

		const en = {
			"grid.title": "Split grid",
			"grid.intro": "Select a cell to export or regenerate it.", "grid.overview": "Grid preview", "grid.selectHint": "Select a numbered cell in the image.",
			"grid.editor": "Edit cell", "grid.review": "Review candidate", "grid.description": "Image description", "grid.before": "Compare with previous", "grid.showingBefore": "Showing previous version", "grid.pending": "Candidate preview · not applied",
			"grid.reviewNote": "Apply to change only this cell, or discard to edit your prompt.", "grid.exports": "Export images", "grid.exportPending": "Apply or discard the candidate before exporting.", "grid.exportHint": "Exports leave the original unchanged.",
			"grid.cell": "Cell", "grid.uploadLimit": "This cell is too large to upload. Increase the row/column count or generate from text.",
			"grid.rows": "Rows",
			"grid.cols": "Columns",
			"grid.coord": "Row {r} · Column {c}",
			"grid.fill": "Fill mode",
			"grid.edit": "Redraw selected cell",
			"grid.generate": "New cell from text",
			"grid.prompt": "Describe the image or the changes you want in this cell…",
			"grid.submit": "Generate this cell",
			"grid.cellPNG": "Export cell PNG",
			"grid.allZIP": "Export all cells · ZIP",
			"grid.sheetPNG": "Download edited sheet",
			"grid.apply": "Apply to selected cell",
			"grid.discard": "Discard preview",
			"grid.preview": "Candidate preview · center-cropped to fit",
			"grid.sheet": "Working copy of the grid",
			"grid.safe": "Generation uses your provider quota. Apply the preview to change the sheet.",
			"grid.dirty": "Working copy updated. Download the sheet to keep it; the original is unchanged.",
			"grid.needModel": "Choose an image model in the composer to generate. Exporting cells is still available.",
			"grid.busy.load": "Reading original…",
			"grid.busy.generate": "Generating a candidate…",
			"grid.busy.export": "Preparing download…",
			"grid.leaveJob": "Close the preview? A submitted job can still finish; it will not change this sheet.",
			"grid.leaveDraft": "Close and discard unexported changes or an unapplied candidate? The original stays unchanged.",
			"grid.readError": "Cannot read image",
			"grid.unsupportedSource": "Unsupported image address ({scheme}). Use an original from this workbench’s library.",
			"grid.retryLoad": "Reload original", "grid.notFound": "Original file not found (404). Check the asset in the library.",
			"grid.localRead": "Could not read the full image. Reload the original; no generation request was sent to load it.", "grid.remoteRead": "This external image is not readable by the editor. Use a local library copy.",
			"grid.badImage": "The file could not be decoded as an image.", "grid.readTimeout": "Timed out while loading the image. Try again.",
			"grid.imageLimit": "Image exceeds canvas limits (16384px per side, 48 Mi pixels total).",
			"grid.encodeError": "Could not export PNG. Check available browser memory.",
			"grid.waitTimeout": "Timed out. Check the job in this conversation before sending again.",
			"grid.missingResult": "No usable image was returned.",
			"grid.close": "Close grid editor",
			"chat.thinking": "Awaiting submission…",
			"chat.noReceipt": "No job ID received", "chat.noReceiptHint": "No submission receipt. Check your history before sending again.",
			"chat.restorePrompt": "Restore prompt", "chat.replaceForRecovery": "Replace the current text with this prompt? Reference images will not change.", "chat.dismissRecovery": "Dismiss notice",
			"chat.requestInfo": "Generation settings",
			"chat.directHint": "Send generates directly without rewriting your prompt. Open the JSON request to review the parameters.",
			"tab.title": "Image workbench",
			"guide.desc": "Chat to image · library · providers",
			"nav.title": "API Chat-to-Image Workbench",
			"nav.kicker": "STUDIO",
			"nav.chat": "Chat",
			"nav.library": "Library",
			"nav.notes": "Notes",
			"nav.providers": "Providers",
			"nav.ps": "Image tools",
			"ps.tool.select": "Marquee",
			"ps.tool.transform": "Free transform",
			"ps.transform.pixels":"Transform pixels", "ps.transform.mask":"Rectangle mask", "ps.transform.resetMask":"Remove rectangle mask", "ps.transform.maskHint":"Drag handles to change visibility without moving or resampling pixels. Remove the mask to restore the image.", "ps.transform.limit":"The transformed canvas exceeds the pixel or layer memory limit. Try a smaller drag.",
			"ps.transform.hint": "Drag the center to move, or an edge or corner to resize. Hold Shift for proportional scaling. Release to apply; Esc cancels the drag.",
			"ps.tool.crop": "Crop",
			"ps.tool.split": "Slice",
			"ps.tool.rotate": "Rotate",
			"ps.tool.straighten": "Straighten",
			"ps.tool.warp": "Perspective",
			"ps.tool.canvasSize": "Canvas",
			"ps.tool.feather": "Feather",
			"ps.tool.resize": "Resize",
			"ps.tool.flip": "Flip",
			"ps.noSource": "No image yet",
			"ps.empty": "Load an image first",
			"ps.empty.hint": "Upload a local file, or pick one from the library (generated results live there)",
			"ps.replace": "Replace",
			"ps.reload": "Reset tool settings",
			"ps.apply": "Apply",
			"ps.reset": "Reset",
			"ps.undo": "Undo",
			"ps.redo": "Redo",
			"ps.download": "Download",
			"ps.toReference": "Use as reference",
			"ps.toReferenceBusy": "Uploading…",
			"ps.none": "No selection",
			"ps.needSelection": "Drag a selection on the image first",
			"ps.toSelect": "Marquee",
			"ps.select.hint": "Drag on the image to select; drag inside to move, drag the 8 handles to resize.",
			"ps.select.all": "All",
			"ps.select.none": "Clear",
			"ps.crop.hint": "Crop to the current selection.",
			"ps.split.cols": "Columns",
			"ps.split.rows": "Rows",
			"ps.split.run": "Split",
			"ps.splitDone": "Split into {n} pieces",
			"ps.tileUse": "Load this",
			"ps.tileLoaded": "Piece {n} loaded",
			"ps.rotate.ccw": "90° CCW",
			"ps.rotate.cw": "90° CW",
			"ps.rotate.180": "180°",
			"ps.rotate.free": "Free angle",
			"ps.straighten.hint": "Drag a line along an edge that should be level (or vertical) — the canvas turns live while you drag, and lets go straightened.",
			"ps.straighten.auto": "Auto straighten",
			"ps.straighten.autoBusy": "Estimating…",
			"ps.straighten.manual": "Manual angle",
			"ps.straighten.drag": "Drag a reference line",
			"ps.straighten.dragHint": "Esc cancels the drag; Auto needs no drag at all.",
			"ps.straighten.live": "Live {angle}°",
			"ps.straighten.last": "Last straightened {angle}°",
			"ps.straighten.tooShort": "Line too short — drag a longer one",
			"ps.straightened": "Straightened {angle}°",
			"ps.straightAlready": "Already level, nothing changed",
			"ps.warp.pick": "Pick 4 corners",
			"ps.warp.pickHint": "Click the four corners in order (any quadrilateral works), then press Confirm.",
			"ps.warp.confirm": "Confirm",
			"ps.warp.flipH": "Flip horizontal",
			"ps.warp.flipV": "Flip vertical",
			"ps.warp.flipNone": "Confirm the correction first, then flip",
			"ps.warp.locked": "Locked: corners fixed, image rectified",
			"ps.warp.pickCount": "Picked {n} / 4",
			"ps.warp.mode": "Method",
			"ps.warp.mode.flat": "4-point warp",
			"ps.warp.mode.free": "Free stretch",
			"ps.warp.mode.distort": "Distort",
			"ps.warp.hint.flat": "Pick four corners on the source. Green numbers follow your clicks; drag to refine.",
			"ps.warp.hint.free": "Choose source or destination points, then drag their corners.",
			"ps.warp.hint.distort": "Drag the orange destination points. The source is the full image.",
			"ps.warp.out": "Output {w} × {h}",
			"ps.warp.drag": "Drag a corner to place it",
			"ps.warp.reset": "Reset corners",
			"ps.warp.view": "View",
			"ps.warp.side.src": "Source points",
			"ps.warp.side.dst": "Destination points",
						"ps.warp.liveTag": "Confirm to apply",
			"ps.warp.tip": "Confirm or press Enter to open a new corrected layer. Switching tools or exporting does not apply draft points.",
			"ps.warp.done": "Warped to {w} × {h}",
			"ps.warp.degenerate": "Corners may not coincide, be collinear, or form a concave/crossed quad (that flips the picture outside the quad) — move one and retry.",
			"ps.width": "Width",
			"ps.height": "Height",
			"ps.anchor": "Anchor",
			"ps.fill": "Fill",
			"ps.fill.none": "Transparent",
			"ps.fill.white": "White",
			"ps.fill.grey": "Light grey",
			"ps.feather.radius": "Radius",
			"ps.feather.all": "Whole edge",
			"ps.feather.selection": "Selection edge",
			"ps.resize.keep": "Keep ratio",
			"ps.flip.h": "Horizontal",
			"ps.flip.v": "Vertical",
			"ps.zoom.fit": "Fit",
			"ps.zoom.actual": "1:1",
			"ps.zoom.in": "Zoom in",
			"ps.zoom.out": "Zoom out",
			"ps.zoom.hint": "Scroll to zoom · middle-drag to pan",
			"ps.canvas.unit": "Unit",
			"ps.canvas.unit.px": "Pixels",
			"ps.canvas.unit.percent": "Percent",
			"ps.canvas.preset": "Common sizes",
			"ps.canvas.current": "Now {w} × {h} · {dpi} DPI",
			"ps.canvas.dpi": "Resolution",
			"ps.canvas.dpi.hint": "Written into the exported PNG / JFIF header, no resampling",
			"ps.dpi.applied": "Resolution set to {dpi} DPI",
			"ps.panels.tools": "Tools",
			"ps.panels.params": "Options",
			"ps.collapse": "Collapse",
			"ps.expand": "Expand",
			"ps.focus": "Focus canvas",
			"ps.focus.exit": "Exit focus",
			"ps.keys": "Shortcuts",
			"ps.keys.tools": "Tools",
			"ps.keys.view": "Canvas",
			"ps.keys.edit": "Edit",
			"ps.keys.out": "Output",
			"ps.keys.note": "These keys are ignored while typing in a field; the canvas needs an image.",
			"ps.key.selectAll": "Select all",
			"ps.key.clearSel": "Clear selection",
			"ps.key.focus": "Focus canvas (hide both panels)",
			"ps.key.apply": "Apply current tool",
			"ps.key.help": "Open this list",
			"ps.keys.record": "Click, then press the new combo",
			"ps.keys.press": "Press keys…",
			"ps.keys.none": "unbound",
			"ps.keys.reset": "Reset",
			"ps.keys.resetAll": "Reset all",
			"ps.keys.taken": "{keys} is taken by {who}",
			"ps.keys.hint": "Click a key cap to rebind: press any combo (Ctrl / Shift / Alt allowed). Esc cancels, Backspace resets that one.",
			"ps.empty.recent": "Recent",
			"ps.empty.samples": "Preset samples",
			"ps.empty.more": "Show more",
			"ps.empty.step1": "Upload an image, or pick a recent one below",
			"ps.empty.step2": "Pick a tool on the left, tune it on the right",
			"ps.empty.step3": "Take it out via 设为参考图 or 下载",
			"rail.library": "Library",
			"rail.notes": "Notes",
			"rail.jobs": "Jobs",
			"chat.hint.title": "Describe what you need and generate images in chat",
			"chat.hint.sub": "For example: a product shot, a scene, or a style sheet",
			"chat.placeholder": "Describe the image or paste a reference. Enter to generate, Shift+Enter for a new line.",
			"chat.send": "Generate",
			"chat.sendKeys": "Enter to generate, Shift+Enter for a new line",
			"chat.replaceDraft": "Replace the current draft and its references with this history entry? Cancel to keep your draft.",
			"chat.sending": "Generating…",
			"chat.you": "You",
			"chat.assistant": "Workbench",
			"chat.source": "Source",
			"chat.sourceUi": "Workbench",
			"chat.sourceTool": "Tool call",
			"chat.sourceApi": "External API",
			"chat.session": "Session",
			"chat.empty": "No generations yet — write a prompt to start.",
			"chat.retry": "Retry",
			"chat.editPrompt": "Edit prompt (load it back into the composer)",
			"chat.edited": "Loaded back into the composer — tweak and send again",
			"chat.confirmDelete": "Delete this conversation entry? (Library images are untouched)",
			"chat.deleted": "Entry deleted",
			"chat.newConv": "New conversation",
			"chat.newConvHint": "New conversation started (no memory from the previous one)",
			"chat.renameConv": "Rename conversation",
			"chat.deleteConv": "Delete conversation",
			"chat.confirmDeleteConv": "Delete this conversation and all its entries? (Library images are untouched)",
			"chat.deletedConv": "Conversation deleted",
			"chat.convList": "Switch conversation",
			"chat.untitledConv": "Untitled",
			"chat.convMemory": "Each conversation keeps its own memory; a new conversation starts empty",
			"chat.context": "Context",
			"chat.contextOn": "Context manager: on — a chat model rewrites this conversation's history into the prompt each turn",
			"chat.contextPanel": "Context manager · conversational",
			"chat.contextDesc": "Only rewrites prompts and reads config — never calls a provider to draw images.",
			"chat.contextAuto": "Optimize prompt",
			"chat.contextTurns": "Context turns",
			"chat.contextNoAuto": "Stop the context model from calling a provider directly",
			"chat.contextNoAutoHint": "When on, only your own words trigger generation — it just tidies up.",
			"chat.contextWired": "Wired: chat {chat} · image {image} · size {size}",
			"chat.contextAutoChat": "auto",
			"chat.contextOnShort": "on",
			"chat.contextOffShort": "off",
			"chat.contextOff": "Context manager: off — generate from your text as-is",
			"chat.planFailed": "Context rewrite failed — generating from your text as-is",
			"chat.planRewrite": "Rewritten",
			"chat.sizeCustom": "Custom",
			"chat.videoSize": "Video size",
			"chat.videoRatio": "Ratio",
			"chat.videoResolution": "Resolution",
			"chat.videoSeconds": "Duration (s)",
			"chat.cancel": "Cancel",
			"chat.copy": "Copy link",
			"chat.copyTitle": "Copies the link text — use Copy image if you want to paste the picture",
			"chat.reuse": "Redraw from this",
			"chat.open": "Open original",
			"chat.copyShort": "Copy",
			"chat.reuseShort": "Redraw",
			"chat.openShort": "Open",
			"chat.saved": "Saved to library",
			"chat.save": "Save to disk",
			"chat.saveShort": "Save",
			"chat.saveTitle": "Save a copy into your local folder (use this when dragging to Explorer is unreliable)",
			"chat.copyImage": "Copy image",
			"chat.copyImageTitle": "Copies the picture itself — paste it into PowerPoint / docs with Ctrl+V",
			"chat.downloading": "Downloading the image file…",
			"common.imageCopied": "Image copied — just paste it into the other app",
			"common.savedTo": "Saved to {path}",
			"chat.counter": "{n}/500",
			"chat.over": "Prompt truncated to 500 characters",
			"panel.image": "Image",
			"side.title": "Panels",
			"side.collapse": "Collapse side panel",
			"side.expand": "Expand side panel",
			"side.tab": "Image · Presets · Provider",
			"panel.image.hint": "Upload an image, or pick one from the library",
			"panel.upload": "Upload image (or press Ctrl+V)",
			"chat.pasted": "Pasted as the reference image",
			"chat.refClear": "Remove reference",
			"chat.refLimit": "Up to 4 reference images — remove one first",
			"chat.modelInvalid": "Current model cannot generate images (chat/audio model or not in any provider catalog) — pick an image model first",
			"chat.modelSwitched": "Current model cannot generate images — switched to {model}",
			"chat.toBottom": "Jump to latest",
			"chat.expandTools": "More options",
			"chat.collapseTools": "Fewer options",
			"chat.me": "Me",
			"chat.meRef": "Reference sent with it",
			"chat.stale": "Status stale",
			"chat.staleHint": "Still marked running: the host may have restarted — refresh to pull the latest state.",
			"chat.staleRefresh": "Refresh",
			"chat.meShort": "Me",
			"panel.pick": "Pick from library",
			"panel.info": "Info",
			"panel.info.placeholder": "Image details such as size, style, scene…",
			"panel.provider": "Provider",
			"panel.provider.pick": "Select a provider",
			"panel.params": "Parameters",
			"lib.search": "Search name / prompt",
			"lib.allModels": "All models",
			"chat.model": "Model",
			"model.none": "No model",
			"model.list": "Model list",
			"model.search": "Search models",
			"model.empty": "No matching model",
			"model.count": "{n}",
			"model.kind.image": "Image",
			"model.kind.video": "Video",
			"model.kind.audio": "Audio",
			"model.kind.chat": "Chat",
			"model.kind.other": "Other",
			"model.disabled": "Off",
			"lib.selected": "{n} selected",
			"lib.delete": "Delete",
			"lib.rename": "Rename",
			"lib.refresh": "Refresh",
			"lib.pages": "Image pages", "lib.prevPage": "Previous page", "lib.nextPage": "Next page",
			"lib.moreIndex": "Load older images ({n}/{total} indexed)",
			"lib.density": "Grid density",
			"lib.view": "View",
			"lib.view.grid": "Grid",
			"lib.view.stage": "Large",
			"lib.marquee": "Select",
			"lib.brush": "Brush",
			"lib.brushSize": "Size",
			"lib.maskHint": "Say what to change (the selected / painted area gets repainted)",
			"lib.maskSend": "Send",
			"lib.maskEmpty": "Write what to change first",
			"lib.maskQueued": "Local edit queued — check the chat",
			"lib.maskClear": "Clear",
			"lib.density.compact": "S",
			"lib.density.standard": "M",
			"lib.density.large": "L",
			"lib.empty": "Library is empty.",
			"lib.confirmDelete": "Delete {n} selected image(s)?",
			"notes.new": "New note",
			"notes.title": "Title",
			"notes.prompt": "Prompt",
			"notes.meta": "Metadata",
			"notes.tags": "Tags (comma separated)",
			"notes.save": "Save",
			"notes.delete": "Delete",
			"notes.insert": "Insert into composer",
			"notes.pickTitle": "Prompt cards",
			"notes.pickHint": "Prompt cards: pick one to insert into the composer (manage is one level down)",
			"notes.pickManage": "Manage",
			"notes.pickEmpty": "No prompt cards yet",
			"notes.pickCreate": "Create one",
			"notes.pickMore": "{n} more — see the Notes page",
			"notes.empty": "No notes yet. Save the prompts that work.",
			"panel.presets": "Presets",
			"preset.new": "New preset",
			"preset.empty": "No presets yet. Make one — title, prompt, reference image.",
			"preset.use": "Use",
			"preset.edit": "Edit",
			"preset.delete": "Delete",
			"preset.title": "Title",
			"preset.prompt": "Prompt",
			"preset.image": "Reference",
			"preset.tags": "Tags (comma separated)",
			"preset.upload": "Upload reference",
			"preset.fromLibrary": "Pick from library",
			"preset.clearImage": "Remove reference",
			"preset.reset": "Restore built-ins",
			"preset.used": "Applied “{title}”",
			"preset.builtin": "Built-in",
			"preset.cover": "No reference",
			"preset.count": "{n}",
			"prov.add": "Add provider",
			"prov.name": "Name",
			"prov.baseUrl": "Base URL",
			"prov.key": "API key",
			"prov.keyEnv": "Env var",
			"prov.chatModel": "Chat model",
			"prov.chatOnlyHint": "The chat model and context turns apply only to standalone chat endpoints, not to workbench generation.",
			"prov.chatModelAuto": "Auto (first chat model in the catalog)",
			"prov.contextTurns": "Context turns (0–12)",
			"prov.keyHint": "Leave blank to reuse the configured key",
			"prov.models": "Models (comma separated)",
			"prov.test": "Test",
			"prov.testOk": "Connected",
			"prov.testBad": "Failed",
			"prov.testModels": "models",
			"prov.refresh": "Fetch models",
			"prov.delete": "Delete",
			"prov.makeActive": "Use",
			"prov.active": "Active",
			"prov.note": "Note",
			"prov.endpoint": "Endpoint",
			"prov.endpointAuto": "Auto detect (default)",
			"prov.endpointHint": "Picks the route per protocol; auto = edits with a reference image, generations without",
			"prov.storage": "Media folder",
			"prov.storageHint": "Verified old copies are removed after migration. Other files are kept. Migration is unavailable while jobs are running.",
			"prov.storageOpen": "Open folder",
			"prov.storageMove": "Move to…",
			"update.check": "Check for updates",
			"update.title": "Update", "update.pulledLabel": "Pulled",
			"update.latest": "You are on the latest version",
			"update.ready": "Update available — shipped via PR flow",
			"update.behind": "Remote has {sha} — pull then restart DSH",
			"update.clickAgain": "click Update again to pull without restarting",
			"update.applied": "Pulled {sha}; DSH has not restarted",
			"update.restarting": "Restarting DSH: the page will reconnect shortly",
			"update.pullFailed": "Update failed: {reason}",
			"update.notWired": "Update channel not wired yet (host has no /update/check)",
			"update.networkBlocked": "Network unreachable — a specialized network environment (proxy/VPN) is required",
			"update.prFlow": "PR flow",
			"prov.storageMoveTitle": "Move media folder",
			"prov.storageTarget": "Full path to the new folder",
			"prov.storageMovePick": "Media and provider settings will move to the new folder. Verified old copies will be deleted. Choose a private, empty folder.",
			"prov.storageUnconfirmed": "The host did not confirm the folder change. Check the current folder. If the host is outdated, update and reload it before trying again.",
			"prov.storageAbsolute": "Enter a full folder path, not a relative path.",
			"prov.storageSame": "This is the current media folder. Choose another folder.",
			"prov.storageConfirm": "Confirm move",
			"prov.storageBusy": "Copying media. Please wait…",
			"prov.storageRefreshFailed": "Folder switched, but the library did not refresh. Open the library and select Refresh.",
			"prov.storageSaved": "Switched to {dir}",
			"prov.storageMoved": "copied {files} files, {indexes} indexes",
			"prov.storageCleaned": "removed {removed} old files",
			"prov.storageRetained": "{retained} items retained; check the old folder",
			"prov.storageCleanupUnknown": "the host did not report cleanup of the old folder",
			"prov.storageCurrent": "Current folder",
			"prov.storageNeedRestart": "Saved, but the host is still the old build — restart DSH for the media folder switch to take effect",
			"viewer.title": "Image viewer",
			"viewer.prev": "Previous",
			"viewer.next": "Next",
			"viewer.zoomIn": "Zoom in",
			"viewer.zoomOut": "Zoom out",
			"viewer.fit": "Fit",
			"viewer.actual": "Actual size",
			"viewer.hint": "Wheel to zoom · drag to pan · ←/→ to switch · Esc to close",
			"viewer.useRef": "Use as reference",
			"viewer.quad": "Four-point warp (handles can leave the image)",
			"viewer.quadTip": "Drag the 4 corners — they may go outside the image; Esc to exit",
			"viewer.quadApply": "Apply warp",
			"viewer.quadReset": "Reset corners",
			"viewer.quadDone": "Warped image saved to library",
			"viewer.quadBad": "Corners must form a convex quad",
			"viewer.quadFail": "Warp failed",
			"viewer.edit": "Edit image",
			"viewer.delete": "Delete",
			"viewer.download": "Download file",
			"viewer.counter": "{i} / {n}",
			"viewer.missing": "Image failed to load",
			"common.dragHint": "Drag into the composer as a reference · into the image editor · or onto PowerPoint / the desktop for a real image file",
			"common.restartNeed": "Old host · restart DSH",
			"common.restartHint": "This UI needs the new host half. Quit DSH and start it again (a page reload is not enough): native drag-to-PowerPoint / desktop files and the multipart edit fix only land after a host restart.",
			"common.noNativeDrag": "Drag-out unavailable · use Copy image",
			"common.noNativeDragHint": "The host has no Electron native drag support, so dropping onto PowerPoint / the desktop cannot produce a file. Use Copy image in the viewer and paste with Ctrl+V, or Save to disk and drag the file from the folder.",
			"prov.endpointOpenai": "OpenAI (/v1/chat/completions)",
			"prov.endpointResponses": "OpenAI Responses (/v1/responses)",
			"prov.endpointResponsesCompact": "OpenAI Response Compaction (/v1/responses/compact)",
			"prov.endpointAnthropic": "Anthropic (/v1/messages)",
			"prov.endpointGemini": "Gemini (/v1beta/models/{model}:generateContent)",
			"prov.endpointRerank": "Jina Rerank (/v1/rerank)",
			"prov.endpointImages": "Image generation (/v1/images/generations)",
			"prov.endpointEdits": "Image edits (/v1/images/edits)",
			"prov.endpointVideos": "Video generation (/v1/videos/generations)",
			"prov.endpointEmbeddings": "Embeddings (/v1/embeddings)",
			"prov.shortAuto": "Auto",
			"prov.shortOpenai": "OpenAI chat",
			"prov.shortResponses": "Responses",
			"prov.shortResponsesCompact": "Responses compact",
			"prov.shortAnthropic": "Anthropic",
			"prov.shortGemini": "Gemini native",
			"chat.geminiReload": "This host does not support Gemini native image generation. Update the plugin and restart DSH; refreshing this page is not enough.",
			"chat.geminiParams": "Gemini native returns one image. Use a resolution and ratio supported by the selected model; masks and video duration are not supported.",
			"chat.geminiRatio": "Image aspect ratio", "chat.geminiSize": "Image resolution",
			"prov.shortRerank": "Rerank",
			"prov.shortImages": "Image gen",
			"prov.shortEdits": "Image edits",
			"prov.shortVideos": "Video gen",
			"prov.shortEmbeddings": "Embeddings",
			"err.upstream": "Upstream error",
			"err.upstreamShow": "Show raw error",
			"err.upstreamHide": "Hide",
			"err.upstreamCopy": "Copy error",
			"err.upstreamCopied": "Error copied",
			"err.upstreamRoute": "Request",
			"err.upstreamStatus": "Status",
			"err.upstreamBody": "Raw upstream response",
			"err.upstreamNone": "no response body",
			"err.upstreamClose": "Close",
			"err.upstreamRetry": "Retry this prompt",
			"chat.video": "Video task",
			"chat.videoQueued": "Upstream returned a task object without a direct URL (raw response below)",
			"prov.runtime": "Runtime config",
			"prov.keyMask": "Key",
			"prov.keyRuntime": "runtime key",
			"prov.modelsLabel": "Models",
			"prov.modelsNone": "not fetched",
			"prov.modelsMany": "{name} +{n}",
			"prov.listCount": "{n} providers",
			"prov.edit": "Edit",
			"prov.empty": "No providers yet — add one from the top right",
			"prov.save": "Save",
			"prov.close": "Close",
			"common.empty": "none",
			"common.ok": "Done",
			"common.failed": "Failed",
			"common.loading": "Loading…",
			"common.open": "Open the workbench in the right sidebar",
			"common.reloadShell": "Reload UI",
			"common.service": "host service unavailable",
			"status.nokey": "no key",
			"status.key": "key {mask}",
			"status.pending": "{n} queued",
			"err.network": "Workbench service unreachable: {error}"
		};

		// 没有任何 locale 服务时的兜底：直接用内置中文词典，并且照样做 {var} 插值，
		// 否则界面上会出现「密钥 {mask}」这种半成品文案。
		let t = (key, vars) => {
			const template = zh[key] ?? key;
			if (!vars || typeof template !== "string") return template;
			return template.replace(/\{(\w+)\}/g, (whole, name) => (Object.prototype.hasOwnProperty.call(vars, name) ? String(vars[name]) : whole));
		};

		/* ------------------------------------------------------------------ *
		 * 样式：简约规范 · 大圆角。整段自持，不依赖宿主 class 名。
		 * ------------------------------------------------------------------ */

		const CSS = `
.vig-root{
	/* 纸白 / 墨黑 / 朱红：杂志极简白的三件套（黑白承担全部层级，朱红只做点缀） */
	--vig-surface:#ffffff;--vig-surface-soft:#fafaf8;--vig-surface-sunken:#f2f2ee;
	--vig-line:#e7e7e2;--vig-line-strong:#d9d9d2;
	--vig-text:#0b0b0c;--vig-text-muted:#71717a;--vig-text-faint:#a1a1aa;
	--vig-accent:#0b0b0c;--vig-accent-soft:#f2f2ee;--vig-accent-line:#d9d9d2;
	--vig-danger:#d92121;--vig-ok:#15803d;--vig-signal:#ff3a00;
	--vig-ring:rgba(11,11,12,.14);
	--vig-r-card:18px;--vig-r-tile:12px;--vig-r-pill:999px;--vig-r-input:12px;--vig-r-sheet:20px;
	--vig-shadow:0 1px 2px rgba(11,11,12,.04);--vig-shadow-soft:none;
	--vig-sh-2:0 18px 40px -12px rgba(11,11,12,.18);
	--vig-dur:160ms;--vig-ease:cubic-bezier(.2,.7,.2,1);
	--vig-font:Inter,"Helvetica Neue",Arial,"PingFang SC","Hiragino Sans GB","Microsoft YaHei",sans-serif;
	--vig-font-display:"Libre Bodoni",Georgia,"Songti SC","SimSun",serif;
	--vig-gap:12px;--vig-gap-lg:16px;
	box-sizing:border-box;position:relative;display:flex;flex-direction:column;gap:10px;
	height:100%;min-height:0;width:100%;min-width:0;
	color:var(--vig-text);font:inherit;font-family:var(--vig-font);font-size:13px;line-height:1.6;
	font-variant-numeric:tabular-nums;-webkit-font-smoothing:antialiased;
}
body[data-ds-dark-theme] .vig-root{
	--vig-surface:#141416;--vig-surface-soft:#191a1c;--vig-surface-sunken:#202023;
	--vig-line:#2a2a2e;--vig-line-strong:#37373c;
	--vig-text:#f4f4f2;--vig-text-muted:#a1a1aa;--vig-text-faint:#71717a;
	--vig-accent:#f4f4f2;--vig-accent-soft:#232326;--vig-accent-line:#3d3d42;
	--vig-signal:#ff5a2b;--vig-ring:rgba(244,244,242,.18);
	--vig-shadow:0 1px 2px rgba(0,0,0,.4);--vig-shadow-soft:none;
	--vig-sh-2:0 18px 40px -12px rgba(0,0,0,.55);
}
.vig-root *,.vig-root *:before,.vig-root *:after{box-sizing:border-box}
/* 重置要用 :where() 把特异性压到 0：写成 .vig-root button{...} 是 (0,1,1)，
   会压过 .vig-btn / .vig-mini 这些单 class 规则——按钮的内边距和边框会神隐
   （之前「保存」就是个窄蓝块、文字顶出边框、次要按钮连框都没有）。 */
.vig-root :where(button){font:inherit;color:inherit;background:none;border:0;padding:0;cursor:pointer}
.vig-root :where(input,textarea,select){font:inherit;color:inherit}
.vig-root ::-webkit-scrollbar{width:8px;height:8px}
.vig-root ::-webkit-scrollbar-thumb{background:var(--vig-line-strong);border-radius:999px}
.vig-root ::-webkit-scrollbar-track{background:transparent}

.vig-shell{display:flex;gap:var(--vig-gap);min-height:0;flex:1}
.vig-card{background:var(--vig-surface);border:1px solid var(--vig-line);border-radius:var(--vig-r-card);box-shadow:var(--vig-shadow-soft)}
.vig-col{display:flex;flex-direction:column;gap:var(--vig-gap);min-width:0;min-height:0}

/* 顶部 */
.vig-head{
	display:flex;align-items:center;gap:10px;padding:12px 14px;
	background:var(--vig-surface);border:1px solid var(--vig-line);
	border-radius:var(--vig-r-card);box-shadow:var(--vig-shadow-soft);
}
.vig-mark{
	width:30px;height:30px;border-radius:10px;flex:none;display:flex;align-items:center;justify-content:center;
	background:var(--vig-accent);color:var(--vig-surface);
	box-shadow:none;
}
body[data-ds-dark-theme] .vig-mark{background:var(--vig-accent);color:var(--vig-surface)}
.vig-title{font-weight:600;font-size:14px;letter-spacing:.2px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.vig-spacer{flex:1;min-width:0}
.vig-pill{
	display:inline-flex;align-items:center;gap:6px;height:24px;padding:0 10px;
	border-radius:var(--vig-r-pill);border:1px solid var(--vig-line);
	background:var(--vig-surface-soft);color:var(--vig-text-muted);font-size:12px;white-space:nowrap;
}
.vig-pill.is-ok{color:var(--vig-ok);border-color:rgba(22,163,74,.25);background:rgba(22,163,74,.08)}
.vig-pill.is-warn{color:#b45309;border-color:rgba(180,83,9,.25);background:rgba(180,83,9,.08)}
.vig-dot{width:6px;height:6px;border-radius:999px;background:currentColor}
.vig-icon-btn{
	width:28px;height:28px;border-radius:9px;display:inline-flex;align-items:center;justify-content:center;
	color:var(--vig-text-muted);
}
.vig-icon-btn:hover{background:var(--vig-surface-sunken);color:var(--vig-text)}

/* 导航 */
.vig-nav{display:flex;flex-direction:column;gap:6px;padding:10px;width:168px;flex:none}
.vig-nav-item{
	display:flex;align-items:center;gap:10px;height:36px;padding:0 11px;border-radius:12px;
	color:var(--vig-text-muted);text-align:left;width:100%;flex:none;
}
.vig-nav-item:hover{background:var(--vig-surface-sunken);color:var(--vig-text)}
.vig-nav-item.is-on{background:var(--vig-accent-soft);color:var(--vig-accent);font-weight:600}
/* 竖栏会被拉满高度，底部这块贴住底边，把空出来的地方变成有用的信息 */
.vig-nav-foot{margin-top:auto;display:flex;flex-direction:column;gap:9px;padding:11px 11px 3px;border-top:1px solid var(--vig-line)}
.vig-nav-foot-row{display:flex;flex-direction:column;gap:1px;min-width:0}
.vig-nav-foot-val{font-size:12px;color:var(--vig-text);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.vig-nav-seg{display:flex;gap:4px;padding:4px;flex-wrap:wrap}
.vig-nav-seg .vig-nav-item{width:auto;padding:7px 12px}

/* 工作区 */
.vig-main{flex:1;min-width:0;min-height:0;display:flex;flex-direction:column;background:var(--vig-surface);
	border:1px solid var(--vig-line);border-radius:var(--vig-r-card);box-shadow:var(--vig-shadow-soft);overflow:hidden}
.vig-main-head{display:flex;align-items:center;gap:8px;padding:12px 14px;border-bottom:1px solid var(--vig-line)}
.vig-main-body{flex:1;min-height:0;overflow:auto;padding:14px}
.vig-hint{
	display:flex;gap:10px;align-items:flex-start;padding:12px 14px;border-radius:var(--vig-r-tile);
	background:var(--vig-accent-soft);border:1px solid var(--vig-accent-line);color:var(--vig-accent);
}
.vig-hint-title{font-weight:600;font-size:13px}
.vig-hint-sub{color:var(--vig-text-muted);font-size:12px;margin-top:2px}

/* 会话 */
.vig-thread{display:flex;flex-direction:column;gap:14px;padding:16px 16px 4px}
.vig-turn{display:flex;gap:10px;min-width:0}
.vig-avatar{width:26px;height:26px;border-radius:9px;flex:none;display:flex;align-items:center;justify-content:center;
	background:var(--vig-surface-sunken);color:var(--vig-text-muted);font-size:11px;font-weight:600}
.vig-turn.is-user .vig-avatar{background:var(--vig-accent);color:#fff}
/* 我发出去的那句话：靠右、自己一块底色，和左边的回复一眼分得开 */
.vig-turn.is-user{justify-content:flex-end}
/* 我那条消息下面的三个动作：无底色、纯 SVG、悬停才亮 */
.vig-turn-acts{display:flex;gap:2px;justify-content:flex-end;padding:0 4px;margin-top:-6px}
.vig-turn-acts .vig-mini{padding:3px;border-radius:6px;background:none;border:0;color:var(--vig-text-faint);display:inline-flex;align-items:center;justify-content:center;line-height:0}
.vig-turn-acts .vig-mini:hover{background:var(--vig-surface-sunken);color:var(--vig-text)}
.vig-turn-acts .vig-mini:active{transform:translateY(1px)}
.vig-turn.is-user .vig-bubble{flex:0 1 auto;max-width:min(78%,560px);align-items:flex-end;margin-left:auto}
.vig-me{background:var(--vig-accent-soft);border:1px solid var(--vig-accent-line);color:var(--vig-text);
	padding:8px 12px;border-radius:14px 14px 4px 14px;font-size:13px;line-height:1.65;
	white-space:pre-wrap;word-break:break-word}
/* 公开落点上的入口按钮。注意：它渲染在**宿主**的侧栏 / 输入框 dock 里，
   那里没有我们的 token（--vig-* 只定义在 .vig-root 上），所以这里只用 inherit + 兜底值，
   看起来就是宿主自己那一排控件的一家人。 */
.vig-launch{display:inline-flex;align-items:center;gap:6px;height:28px;padding:0 8px;border-radius:8px;
	border:1px solid transparent;background:transparent;color:inherit;font:inherit;font-size:12.5px;
	line-height:1;white-space:nowrap;cursor:pointer;max-width:100%;opacity:.92}
.vig-launch:hover{border-color:var(--vig-line,currentColor);background:var(--vig-surface-sunken,rgba(127,127,127,.12));opacity:1}
.vig-launch .vig-ic{color:var(--vig-accent,currentColor)}
.vig-launch-text{overflow:hidden;text-overflow:ellipsis}
/* 我那条消息里带着的参考图：小缩略图，摆在文字上面 */
.vig-me-ref{width:72px;height:72px;border-radius:10px;object-fit:cover;display:block;
	border:1px solid var(--vig-accent-line);background:var(--vig-surface-soft)}
.vig-bubble{min-width:0;flex:1;display:flex;flex-direction:column;gap:8px}
.vig-who{font-size:11px;color:var(--vig-text-faint);letter-spacing:.2px}
.vig-text{white-space:pre-wrap;word-break:break-word}
/* 结果图只做消息内的预览：单图限制尺寸，多图定宽网格；点击仍可在查看器看原图。 */
.vig-grid{display:grid;width:min(100%,640px);grid-template-columns:repeat(auto-fill,minmax(min(100%,148px),1fr));gap:8px;justify-content:start;min-width:0}
.vig-grid.is-single{width:min(100%,360px);grid-template-columns:minmax(0,1fr)}
.vig-grid.is-duo{grid-template-columns:repeat(2,minmax(0,1fr))}
.vig-grid.is-trio{grid-template-columns:repeat(3,minmax(0,1fr))}
/* 结果卡：图片自己带一个圆角边框；下面三个动作只是纯文字按键 ——
   不要白底面板、不要分隔线（以前那一整块看起来像又一张卡）。 */
.vig-shot{position:relative;margin:0;background:none;border:0;border-radius:0;overflow:visible;min-width:0}
			.vig-shot-img{display:flex;align-items:center;justify-content:center;box-sizing:border-box;width:100%;aspect-ratio:var(--vig-image-ratio,1);height:auto;max-height:none;min-width:0;align-self:start;justify-self:center;padding:0;border-radius:var(--vig-r-tile);overflow:hidden;border:1px solid var(--vig-line);background:var(--vig-surface-sunken)}
.vig-shot img{display:block;width:100%;height:100%;object-fit:contain}
			.vig-grid.is-single .vig-shot-img{width:min(100%,var(--vig-image-width,360px))}
.vig-grid.is-single .vig-shot-img{width:min(100%,360px,calc(var(--vig-image-ratio,1)*420px))}
.vig-bubble:has(>.vig-grid){container:vig-results / inline-size}
@container vig-results (max-width:450px){.vig-grid:not(.is-single){grid-template-columns:repeat(2,minmax(0,1fr))}}
@container vig-workbench (width < 660px){.vig-grid:not(.is-single){grid-template-columns:repeat(2,minmax(0,1fr))}}
.vig-shot-bar{display:flex;gap:2px;padding:2px 0 0;justify-content:space-around;background:none;border-top:0;flex-wrap:wrap}
/* 卡片本身只有 132~160px 宽：三个动作一律用短名字（重绘 / 复制 / 原图）排一行，
   完整说法进 title。没有底色、没有边框、没有分隔线，就是三个文字按键。 */
.vig-shot-bar .vig-mini{background:none;border:0;padding:3px 4px;border-radius:6px;text-align:center;font-size:0}
.vig-shot-bar .vig-mini::after{content:attr(data-short);font-size:11.5px}
.vig-shot-bar .vig-mini:hover{background:var(--vig-surface-sunken);color:var(--vig-text)}
.vig-mini{font-size:12px;padding:4px 8px;border-radius:8px;color:var(--vig-text-muted)}
.vig-mini:hover{background:var(--vig-surface-sunken);color:var(--vig-text)}
.vig-error{color:var(--vig-danger);font-size:12px;background:rgba(229,72,77,.08);border:1px solid rgba(229,72,77,.2);
	padding:8px 10px;border-radius:10px;word-break:break-word}
.vig-spin{width:14px;height:14px;border-radius:999px;border:2px solid var(--vig-accent-line);border-top-color:var(--vig-accent);
	animation:vig-rot 900ms linear infinite;display:inline-block;vertical-align:-2px}
@keyframes vig-rot{to{transform:rotate(360deg)}}

/* 输入区 */
.vig-composer{margin:0 12px 12px;border:1px solid var(--vig-line);border-radius:var(--vig-r-card);
	background:var(--vig-surface);box-shadow:var(--vig-shadow-soft);padding:10px 10px 8px;display:flex;flex-direction:column;gap:8px}
.vig-recover-list{flex:none;max-height:min(120px,18vh);overflow:auto}
.vig-recover{display:flex;flex-wrap:wrap;align-items:center;gap:6px;margin:4px 10px;padding:6px 10px;border:1px solid var(--vig-line);border-radius:10px;background:var(--vig-surface-soft)}
.vig-recover>div{flex:1 1 180px;min-width:0}.vig-recover strong,.vig-recover small,.vig-recover span{display:block;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.vig-recover strong{font-size:12px;white-space:normal}
.vig-composer.is-busy{border-color:var(--vig-accent-line)}
.vig-input{width:100%;border:0;outline:0;resize:none;background:transparent;min-height:44px;max-height:180px;line-height:1.6}
.vig-input::placeholder{color:var(--vig-text-faint)}
.vig-tools{display:flex;align-items:center;gap:6px;flex-wrap:wrap}
.vig-tool{width:28px;height:28px;border-radius:9px;display:inline-flex;align-items:center;justify-content:center;color:var(--vig-text-muted)}
.vig-tool:hover{background:var(--vig-surface-sunken);color:var(--vig-text)}
.vig-tool.is-on{background:var(--vig-accent-soft);color:var(--vig-accent)}
/* 选中对话生图时，数字会话展开在导航项下方，不占内容区标题宽度。 */
.vig-conv{display:flex;align-items:center;gap:2px;flex:none}
.vig-conv .vig-icon-btn{width:24px;height:24px}
.vig-conv-tabs{display:flex;align-content:flex-start;flex-wrap:wrap;gap:4px;flex:none;min-width:0;max-width:100%;max-height:clamp(64px,calc(var(--vig-host-height,100vh)*.24),180px);overflow:auto;overscroll-behavior:contain;scrollbar-width:thin;margin:0 0 2px 4px;padding:2px 2px 2px 6px;border-inline-start:1px solid var(--vig-line)}
.vig-conv-tab{flex:none;min-width:28px;height:28px;padding:0 5px;border-radius:999px;border:1px solid var(--vig-line);background:var(--vig-surface);color:var(--vig-text-muted);font-size:12px;font-weight:600;line-height:1;font-variant-numeric:tabular-nums;display:inline-flex;align-items:center;justify-content:center;cursor:pointer}
.vig-conv-tab:hover{color:var(--vig-text);border-color:var(--vig-line-strong)}
.vig-conv-tab.is-active{background:var(--vig-accent);color:var(--vig-surface);border-color:transparent}
.vig-conv-tab:focus-visible{outline:2px solid var(--vig-text);outline-offset:-2px}
/* 信息卡快捷选择：一级浮层列卡片，点一张直接插进输入框；二级「管理」才跳信息管理页 */
.vig-note-pick{position:relative;display:inline-flex}
.vig-note-pop{position:absolute;left:0;bottom:calc(100% + 8px);z-index:30;width:min(300px,78vw);max-height:320px;overflow:auto;
	display:flex;flex-direction:column;gap:2px;padding:6px;background:var(--vig-surface);border:1px solid var(--vig-line);
	border-radius:12px;box-shadow:var(--vig-shadow)}
.vig-note-pop-head{display:flex;align-items:center;gap:6px;padding:4px 6px 7px;border-bottom:1px solid var(--vig-line);
	position:sticky;top:0;background:var(--vig-surface);z-index:1}
.vig-note-pop-title{font-size:11.5px;color:var(--vig-text-faint);letter-spacing:.3px}
.vig-note-item{display:flex;flex-direction:column;gap:3px;padding:7px 8px;border-radius:8px;text-align:left;color:var(--vig-text);font:inherit;cursor:pointer}
.vig-note-item:hover{background:var(--vig-surface-sunken)}
.vig-note-item-title{font-size:12.5px;font-weight:600;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.vig-note-item-prompt{font-size:11.5px;color:var(--vig-text-muted);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.vig-note-item-tags{display:flex;gap:4px;flex-wrap:wrap}
.vig-note-pop-empty{display:flex;flex-direction:column;align-items:center;gap:6px;padding:14px 8px;font-size:12px;color:var(--vig-text-faint)}
.vig-note-pop-foot{padding:6px 4px 2px;border-top:1px solid var(--vig-line);font-size:11.5px;color:var(--vig-text-faint);text-align:center}
.vig-count{margin-left:auto;font-size:11px;color:var(--vig-text-faint)}
/* 协议选择：输入框那一行的参数之一（短名 + title 挂全名，别把这一行撑开） */
.vig-endpoint{max-width:150px;flex:0 1 auto}
/* 失败卡片：状态 chip + 那句话 + 实际请求 + 原始响应体。一张卡说清一件事，
   不再「一句话一行、证据又一块」地叠三层红框。 */
.vig-fail{margin-top:8px;border:1px solid rgba(229,72,77,.22);border-radius:10px;background:rgba(229,72,77,.045);
	overflow:hidden}
.vig-fail-head{display:flex;align-items:center;gap:8px;padding:7px 9px;flex-wrap:wrap}
.vig-fail-chip{flex:none;display:inline-flex;align-items:center;height:20px;padding:0 7px;border-radius:6px;
	background:rgba(229,72,77,.14);color:var(--vig-danger);font-size:11px;font-weight:600;
	font-variant-numeric:tabular-nums;white-space:nowrap}
.vig-fail-msg{flex:1;min-width:0;color:var(--vig-danger);font-size:12px;overflow:hidden;
	text-overflow:ellipsis;white-space:nowrap}
.vig-fail-meta{display:flex;align-items:center;gap:10px;padding:0 9px 7px;flex-wrap:wrap;font-size:11px;
	color:var(--vig-text-faint);font-family:ui-monospace,SFMono-Regular,Menlo,monospace}
.vig-fail-meta-item{max-width:100%;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.vig-fail-meta-item:first-child{color:var(--vig-text-muted)}
.vig-fail-pre{margin:0;padding:8px 9px;border-top:1px solid rgba(229,72,77,.16);max-height:220px;overflow:auto;
	font-size:11px;line-height:1.55;font-family:ui-monospace,SFMono-Regular,Menlo,monospace;
	white-space:pre-wrap;word-break:break-all;color:var(--vig-text)}
.vig-fail-none{padding:0 9px 8px;font-size:11px;color:var(--vig-text-faint)}
/* 失败卡里的「一句人话」：key 和接口地址不是一家的那种提示 */
.vig-fail-hint{padding:7px 9px;border-top:1px solid rgba(229,72,77,.16);font-size:11.5px;line-height:1.55;
	background:rgba(180,83,9,.07);color:#b45309;white-space:pre-wrap;word-break:break-word}
.vig-fail .vig-mini{color:var(--vig-text-muted)}
.vig-fail .vig-mini:hover{background:rgba(229,72,77,.12);color:var(--vig-danger)}
/* 视频任务卡：同一套骨架，中性配色（这不是错误） */
.vig-video{margin-top:8px;border:1px solid var(--vig-line);border-radius:10px;background:var(--vig-surface-soft);overflow:hidden}
.vig-video-head{display:flex;align-items:center;gap:8px;padding:7px 9px;flex-wrap:wrap}
.vig-video-chip{flex:none;display:inline-flex;align-items:center;height:20px;padding:0 7px;border-radius:6px;
	background:var(--vig-accent-soft,var(--vig-surface-sunken));color:var(--vig-accent);font-size:11px;font-weight:600;white-space:nowrap}
.vig-video-msg{flex:1;min-width:0;font-size:12px;color:var(--vig-text-muted);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.vig-video-none{padding:0 9px 8px;font-size:11px;color:var(--vig-text-faint)}
.vig-video-pre{margin:0;padding:8px 9px;border-top:1px solid var(--vig-line);max-height:220px;overflow:auto;
	font-size:11px;line-height:1.55;font-family:ui-monospace,SFMono-Regular,Menlo,monospace;
	white-space:pre-wrap;word-break:break-all;color:var(--vig-text)}
.vig-hintline{font-size:11px;color:var(--vig-text-faint);line-height:1.5}
.vig-send{width:32px;height:32px;border-radius:999px;background:var(--vig-accent);color:#fff;
	display:inline-flex;align-items:center;justify-content:center;box-shadow:none}
.vig-send:disabled{background:var(--vig-line-strong);color:var(--vig-surface);box-shadow:none;cursor:not-allowed}
/* 参考图：一张小矩形卡（54×54 缩略图 + 右上角「×」），不写文件名、不写状态 ——
   名字在 title 里，需要的时候鼠标停一下就有。 */
.vig-refs{display:flex;gap:6px;flex-wrap:wrap;padding:2px 0}
.vig-ref{position:relative;flex:none;width:54px;height:54px;border:1px solid var(--vig-line);
	border-radius:10px;background:var(--vig-surface-soft);overflow:hidden}
.vig-ref img{width:100%;height:100%;object-fit:cover;display:block}
.vig-ref-x{position:absolute;top:2px;right:2px;width:16px;height:16px;border-radius:999px;
	display:inline-flex;align-items:center;justify-content:center;
	background:rgba(20,26,38,.62);color:#fff;opacity:.85}
.vig-ref-x:hover{opacity:1;background:var(--vig-danger)}

/* 右栏检查器 */
.vig-side{width:268px;flex:none;display:flex;flex-direction:column;gap:var(--vig-gap);min-height:0;overflow:auto}
/* 右侧检查器可折叠：展开时右上角一个「‹」，收起后整列只剩一条窄签（竖排标签），点一下展开 */
.vig-side-head{display:flex;align-items:center;gap:6px;padding:0 0 0 8px;flex:none}
.vig-side-title{font-size:11px;color:var(--vig-text-faint);letter-spacing:.4px}
.vig-side-head .vig-icon-btn{width:24px;height:24px}
/* 展开态：右上角「›」往右收；收起态：窄签上的「‹」往左展开 */
.vig-side-head .vig-ic{transform:rotate(180deg)}
.vig-side.is-collapsed{width:34px;padding:6px;gap:0;align-items:center;overflow:visible}
.vig-side-open{width:100%;flex:1;display:flex;flex-direction:column;align-items:center;justify-content:flex-start;gap:10px;
	padding:10px 0;border:1px solid var(--vig-line);border-radius:var(--vig-r-card);background:var(--vig-surface);
	color:var(--vig-text-muted);font:inherit;cursor:pointer}
.vig-side-open:hover{color:var(--vig-text);border-color:var(--vig-accent-line);background:var(--vig-surface-soft)}
.vig-side-open-label{writing-mode:vertical-rl;font-size:11px;letter-spacing:2px;line-height:1.25}
.vig-root[data-compact="1"] .vig-side.is-collapsed{width:auto;padding:0;flex-direction:row;overflow:visible}
.vig-root[data-compact="1"] .vig-side-open{flex-direction:row;justify-content:center;gap:8px;padding:8px}
.vig-root[data-compact="1"] .vig-side-open-label{writing-mode:horizontal-tb;letter-spacing:.5px}
.vig-block{background:var(--vig-surface);border:1px solid var(--vig-line);border-radius:var(--vig-r-card);
	box-shadow:var(--vig-shadow-soft);overflow:hidden}
.vig-block-head{display:flex;align-items:center;gap:8px;padding:11px 12px;cursor:pointer}
.vig-block-head:hover{background:var(--vig-surface-soft)}
.vig-block-title{font-weight:600;font-size:12.5px}
.vig-block-body{padding:0 12px 12px;display:flex;flex-direction:column;gap:8px;border-top:1px solid var(--vig-line);padding-top:11px}
.vig-drop{border:1px dashed var(--vig-line-strong);border-radius:var(--vig-r-tile);background:var(--vig-surface-soft);
	padding:16px 10px;text-align:center;color:var(--vig-text-muted);font-size:12px;display:flex;flex-direction:column;align-items:center;gap:8px}
.vig-drop.is-over{border-color:var(--vig-accent);background:var(--vig-accent-soft);color:var(--vig-accent)}
.vig-field{display:flex;flex-direction:column;gap:5px}
.vig-label{font-size:11.5px;color:var(--vig-text-muted)}
.vig-in,.vig-sel,.vig-area{
	width:100%;border:1px solid var(--vig-line);border-radius:var(--vig-r-input);background:var(--vig-surface);
	padding:8px 10px;outline:0;
}
.vig-in:focus,.vig-sel:focus,.vig-area:focus{border-color:var(--vig-accent);box-shadow:0 0 0 3px var(--vig-ring)}
.vig-area{resize:vertical;min-height:74px;font-size:12.5px}
.vig-row{display:flex;gap:8px;align-items:center}
.vig-row>*{min-width:0}
/* 按钮不许被 flex 压扁（压扁后文字会顶出边框，之前「保存」就是这样） */
.vig-row>.vig-btn,.vig-row>button{min-width:auto;flex:none}
.vig-btn{height:32px;padding:0 12px;border-radius:10px;border:1px solid var(--vig-line);
	background:var(--vig-surface);color:var(--vig-text);display:inline-flex;align-items:center;justify-content:center;gap:6px;white-space:nowrap}
.vig-btn:hover{background:var(--vig-surface-soft)}
.vig-btn.is-primary{background:var(--vig-accent);border-color:var(--vig-accent);color:#fff}
.vig-btn.is-primary:hover{filter:brightness(1.04)}
.vig-btn.is-ghost{border-color:transparent;background:transparent;color:var(--vig-text-muted)}
.vig-btn.is-ghost:hover{background:var(--vig-surface-sunken);color:var(--vig-text)}
.vig-btn.is-danger{color:var(--vig-danger);border-color:rgba(229,72,77,.3)}
.vig-btn.is-danger.is-ghost{border-color:transparent;background:transparent}
.vig-btn.is-danger.is-ghost:hover{background:rgba(229,72,77,.08);color:var(--vig-danger)}
.vig-btn.is-sm{height:28px;padding:0 9px;font-size:11.5px;border-radius:9px;gap:4px}
.vig-btn:disabled{opacity:.5;cursor:not-allowed}
.vig-toolbar-sub{font-size:12px;color:var(--vig-text-muted)}

/* 图库 / 信息 / 供应商 */
.vig-toolbar{display:flex;gap:8px;align-items:center;padding:12px 14px;border-bottom:1px solid var(--vig-line);flex-wrap:wrap}
.vig-lib-pages{display:flex;align-items:center;flex:none;flex-wrap:wrap;gap:6px;padding:4px 12px;border-bottom:1px solid var(--vig-line)}
.vig-lib-pages output{font-variant-numeric:tabular-nums;font-size:12px;color:var(--vig-text-muted)}
.vig-lib-pages [data-lib-more]{margin-inline-start:auto}
.vig-main>.vig-tiles{min-height:0;overflow-y:auto;align-content:start}
.vig-tiles{display:grid;grid-template-columns:repeat(auto-fill,minmax(148px,1fr));gap:12px;padding:14px}
.vig-tile{border:1px solid var(--vig-line);border-radius:var(--vig-r-tile);overflow:hidden;background:var(--vig-surface);
	cursor:pointer;position:relative;transition:border-color .15s ease,box-shadow .15s ease}
.vig-tile:hover{box-shadow:var(--vig-shadow-soft);border-color:var(--vig-line-strong)}
.vig-tile.is-on{border-color:var(--vig-accent);box-shadow:0 0 0 3px var(--vig-ring)}
.vig-tile img{display:block;width:100%;height:126px;object-fit:cover;background:var(--vig-surface-sunken)}
.vig-tile-meta{padding:8px 10px;font-size:11.5px;color:var(--vig-text-muted);display:flex;flex-direction:column;gap:2px}
.vig-tile-name{color:var(--vig-text);font-weight:500;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.vig-check{position:absolute;top:8px;left:8px;width:20px;height:20px;border-radius:999px;border:1.5px solid rgba(255,255,255,.9);
	background:rgba(16,24,40,.28);display:flex;align-items:center;justify-content:center;color:#fff}
.vig-tile.is-on .vig-check{background:var(--vig-accent);border-color:#fff}
.vig-list{display:flex;flex-direction:column;gap:10px;padding:14px}
.vig-item{border:1px solid var(--vig-line);border-radius:var(--vig-r-tile);padding:11px 12px;display:flex;gap:10px;flex-direction:column}
.vig-item-head{display:flex;align-items:center;gap:8px}
.vig-item-title{font-weight:600}
.vig-item-body{font-size:12.5px;color:var(--vig-text-muted);white-space:pre-wrap;word-break:break-word;max-height:96px;overflow:auto}
.vig-tag{font-size:11px;padding:1px 8px;border-radius:999px;background:var(--vig-surface-sunken);color:var(--vig-text-muted)}

/* 预设卡：右侧栏里的卡片墙。参考图占上半张，下面标题/提示词/标签，底部三个动作 */
.vig-preset-grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(112px,1fr));gap:9px;grid-auto-rows:minmax(0,1fr)}
.vig-preset-card{display:flex;flex-direction:column;min-width:0;border:1px solid var(--vig-line);border-radius:var(--vig-r-tile);
	overflow:hidden;background:var(--vig-surface);transition:border-color .16s ease,box-shadow .16s ease}
.vig-preset-card:hover{border-color:var(--vig-line-strong);box-shadow:var(--vig-shadow-soft)}
.vig-preset-cover{display:block;width:100%;height:86px;padding:0;border:0;background:var(--vig-surface-sunken);cursor:pointer;overflow:hidden}
.vig-preset-cover img{display:block;width:100%;height:100%;object-fit:cover}
.vig-preset-cover:hover img{transform:scale(1.03)}
.vig-preset-cover img{transition:transform .2s ease}
.vig-preset-blank{display:flex;flex-direction:column;align-items:center;justify-content:center;gap:6px;width:100%;height:100%;
	font-size:11.5px;color:var(--vig-text-faint)}
.vig-preset-body{display:flex;flex-direction:column;gap:6px;padding:9px 10px 0;min-width:0}
.vig-preset-head{display:flex;align-items:center;gap:6px;min-width:0}
.vig-preset-title{font-size:12.5px;font-weight:600;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.vig-preset-prompt{margin:0;font-size:11.5px;line-height:1.5;color:var(--vig-text-muted);
	display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden}
.vig-preset-tags{display:flex;flex-wrap:wrap;gap:4px}
.vig-preset-foot{display:flex;flex-direction:column;gap:6px;padding:8px 10px 10px;margin-top:auto}
.vig-preset-foot .vig-mini{white-space:nowrap}
.vig-preset-foot .vig-mini.is-primary{width:100%;text-align:center;color:var(--vig-accent);background:var(--vig-accent-soft)}
.vig-preset-acts{display:flex;align-items:center;gap:6px}
.vig-preset-acts .vig-icon-btn{width:24px;height:24px;padding:0;flex:none}
.vig-preset-acts .vig-mini.is-danger{margin-left:auto;padding:3px 5px}
.vig-preset-acts .vig-mini.is-danger:hover{color:var(--vig-danger,#d64545);background:rgba(214,69,69,.1)}
.vig-preset-ref{display:flex;align-items:center;gap:10px}
.vig-preset-ref img{width:64px;height:64px;border-radius:10px;object-fit:cover;border:1px solid var(--vig-line)}
.vig-preset-ref .vig-preset-blank{width:64px;height:64px;border:1px dashed var(--vig-line-strong);border-radius:10px}
.vig-preset-ref-actions{display:flex;flex-wrap:wrap;gap:6px;min-width:0}
.vig-preset-picker{display:grid;grid-template-columns:repeat(auto-fill,minmax(56px,1fr));gap:6px;max-height:150px;overflow:auto;margin-top:8px}
.vig-preset-pick{padding:0;border:1px solid var(--vig-line);border-radius:8px;overflow:hidden;background:none;cursor:pointer}
.vig-preset-pick img{display:block;width:100%;height:52px;object-fit:cover}
.vig-preset-pick:hover{border-color:var(--vig-accent)}
.vig-root[data-compact="1"] .vig-preset-grid{grid-template-columns:repeat(auto-fill,minmax(100px,1fr));gap:8px}
.vig-root[data-compact="1"] .vig-preset-cover{height:74px}
.vig-root[data-compact="1"] .vig-preset-prompt{-webkit-line-clamp:3}
/* 页面骨架：表单页居中收窄（宽面板里把输入框拉成一条长条很难看），图库那种列表页照旧满宽 */
.vig-page{width:100%;max-width:760px;margin:0 auto;display:flex;flex-direction:column;gap:12px}
.vig-form-grid{display:grid;grid-template-columns:minmax(0,1fr) 168px;gap:10px}
.vig-root[data-compact="1"] .vig-page{max-width:none}
.vig-root[data-compact="1"] .vig-form-grid{grid-template-columns:1fr}

/* 供应商列表：一行一卡。窄侧栏里 4 列表格必炸，所以不做表格 */
.vig-prov{display:flex;align-items:center;gap:10px;padding:11px 12px;border:1px solid var(--vig-line);
	border-radius:var(--vig-r-tile);background:var(--vig-surface);flex-wrap:wrap}
.vig-prov.is-on{border-color:var(--vig-accent-line);background:var(--vig-accent-soft)}
.vig-prov-main{display:flex;flex-direction:column;gap:3px;min-width:0;flex:1}
.vig-prov-name{display:flex;align-items:center;gap:8px;font-weight:600;min-width:0}
.vig-prov-line{font-size:11.5px;color:var(--vig-text-muted);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.vig-prov-acts{display:flex;align-items:center;gap:4px;flex:none;margin-left:auto;flex-wrap:wrap;justify-content:flex-end}
.vig-sep{color:var(--vig-text-faint);padding:0 2px}
.vig-tag.is-on{background:var(--vig-accent);color:#fff}
.vig-muted{color:var(--vig-text-muted)}

/* 模型选择器：平时只显示当前模型，点开才按 能力 → 前缀族 → 模型 展开 */
.vig-picker{position:relative;flex:0 1 auto;display:inline-flex;min-width:0}
.vig-toolbar,.vig-composer{position:relative}
.vig-pick{height:28px;max-width:200px;min-width:0;padding:0 8px;border:1px solid var(--vig-line);border-radius:9px;
	background:var(--vig-surface);color:var(--vig-text);display:inline-flex;align-items:center;gap:6px;overflow:hidden}
.vig-pick:hover{background:var(--vig-surface-soft)}
.vig-pick.is-open{border-color:var(--vig-accent);box-shadow:0 0 0 3px var(--vig-ring)}
.vig-pick:disabled{opacity:.5;cursor:not-allowed}
.vig-pick-text{overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-size:12.5px}
.vig-pick svg{flex:none;color:var(--vig-text-muted)}
.vig-pop{position:absolute;z-index:30;width:288px;max-height:320px;overflow:auto;right:0;
	background:var(--vig-surface);border:1px solid var(--vig-line);border-radius:var(--vig-r-tile);
	box-shadow:var(--vig-shadow);padding:6px}
/* 往上弹的时候贴右（输入区在右边），往下弹的时候贴左（页头在左边），保证弹层落在卡片里 */
.vig-pop.is-up{bottom:calc(100% + 6px)}
.vig-pop.is-down{top:calc(100% + 6px);left:0;right:auto}
.vig-pop-head{position:sticky;top:-6px;z-index:1;display:flex;align-items:center;gap:8px;padding:6px;background:var(--vig-surface);
	border-bottom:1px solid var(--vig-line);margin-bottom:4px}
.vig-pop-search{flex:1;min-width:0;height:28px;border:1px solid var(--vig-line);border-radius:8px;padding:0 8px;
	background:var(--vig-surface);outline:0;font-size:12.5px}
.vig-pop-search:focus{border-color:var(--vig-accent);box-shadow:0 0 0 3px var(--vig-ring)}
.vig-pop-group+.vig-pop-group{margin-top:6px;border-top:1px solid var(--vig-line);padding-top:6px}
.vig-pop-group-head,.vig-pop-family-head{display:flex;align-items:center;gap:6px;padding:5px 8px;font-size:11px;
	color:var(--vig-text-faint);letter-spacing:.3px;text-transform:uppercase}
.vig-pop-family-head{padding-left:16px;text-transform:none;font-size:11.5px}
.vig-pop-count{margin-left:auto;color:var(--vig-text-faint)}
.vig-pop-item{width:100%;display:flex;align-items:center;gap:8px;padding:6px 8px 6px 16px;border-radius:8px;
	text-align:left;color:var(--vig-text);font-size:12.5px}
.vig-pop-item:hover{background:var(--vig-surface-sunken)}
.vig-pop-item.is-on{background:var(--vig-accent-soft);color:var(--vig-accent);font-weight:600}
.vig-pop-item.is-off{opacity:.55}
.vig-pop-item .vig-tag{margin-left:auto;flex:none}
.vig-pop-item.is-on svg{margin-left:auto;color:var(--vig-accent)}
.vig-pop-item-text{overflow:hidden;text-overflow:ellipsis;white-space:nowrap;min-width:0}
.vig-pop-all{padding-left:8px}
.vig-pop-empty{padding:14px 8px;text-align:center;color:var(--vig-text-faint);font-size:12px}
.vig-empty{padding:36px 16px;text-align:center;color:var(--vig-text-faint);font-size:12.5px}
.vig-modal-mask{position:fixed;inset:0;background:rgba(16,24,40,.34);display:flex;align-items:center;justify-content:center;z-index:60;padding:24px}
.vig-modal{width:min(520px,100%);max-height:86vh;overflow:auto;background:var(--vig-surface);border:1px solid var(--vig-line);
	border-radius:var(--vig-r-card);box-shadow:var(--vig-shadow);padding:16px;display:flex;flex-direction:column;gap:12px}
.vig-modal-title{font-weight:600;font-size:14px}
/* 供应商编辑弹窗里的「测试连接」结果：留在弹窗里，别一闪就没 */
.vig-prov-test{display:flex;flex-direction:column;gap:4px;padding:8px 10px;border-radius:8px;
	font-size:11.5px;line-height:1.5;border:1px solid var(--vig-line);background:var(--vig-surface-soft);
	color:var(--vig-text-muted);word-break:break-word}
.vig-prov-test.is-ok{border-color:rgba(22,163,74,.28);background:rgba(22,163,74,.06);color:#15803d}
.vig-prov-test.is-bad{border-color:rgba(229,72,77,.3);background:rgba(229,72,77,.05);color:var(--vig-danger)}
.vig-prov-test-head{font-weight:600}
.vig-prov-test-line{font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:11px;color:var(--vig-text-faint)}
.vig-prov-test-hint{padding-top:4px;border-top:1px dashed rgba(180,83,9,.3);color:#b45309}
/* 图片查看器：铺满视口的深色舞台 + 中间一张大图 */
.vig-viewer{position:fixed;inset:0;z-index:70;background:rgba(16,24,40,.72);display:flex;align-items:center;justify-content:center;padding:20px}
.vig-viewer-body{width:min(1120px,100%);height:min(760px,calc(100vh - 40px));background:var(--vig-surface);border:1px solid var(--vig-line);
	border-radius:var(--vig-r-card);box-shadow:var(--vig-shadow);display:flex;flex-direction:column;overflow:hidden}
.vig-viewer-head{display:flex;align-items:center;gap:6px;padding:9px 12px;border-bottom:1px solid var(--vig-line);flex-wrap:nowrap}
.vig-viewer-title{font-size:13px;font-weight:600;max-width:42%;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.vig-viewer-count{font-size:11.5px;color:var(--vig-text-faint);font-variant-numeric:tabular-nums}
.vig-viewer-zoom{font-size:11.5px;color:var(--vig-text-muted);min-width:42px;text-align:center;font-variant-numeric:tabular-nums}
.vig-viewer-stage{position:relative;flex:1;min-height:200px;display:flex;align-items:center;justify-content:center;
	background:var(--vig-surface-sunken);overflow:hidden;touch-action:none;cursor:default}
.vig-viewer-stage.is-zoomed{cursor:grab}
.vig-viewer-stage.is-panning{cursor:grabbing}
.vig-viewer-img{max-width:100%;max-height:100%;object-fit:contain;user-select:none;-webkit-user-drag:none;
	transform-origin:center center;will-change:transform}
.vig-viewer-missing{font-size:12px;color:var(--vig-text-faint)}
.vig-viewer-nav{position:absolute;top:50%;transform:translateY(-50%);width:34px;height:58px;display:flex;align-items:center;justify-content:center;
	border:1px solid var(--vig-line);border-radius:10px;background:var(--vig-surface);color:var(--vig-text-muted);box-shadow:var(--vig-shadow);opacity:.86}
.vig-viewer-nav:hover{opacity:1;color:var(--vig-text)}
.vig-viewer-nav.is-prev{left:10px}
.vig-viewer-nav.is-next{right:10px}
.vig-viewer-prompt{padding:8px 12px;border-top:1px solid var(--vig-line);background:var(--vig-surface-soft);
	font-size:12px;line-height:1.55;color:var(--vig-text-muted);max-height:92px;overflow:auto;white-space:pre-wrap;word-break:break-word}
.vig-viewer-foot{display:flex;align-items:center;gap:6px;padding:8px 12px;border-top:1px solid var(--vig-line);flex-wrap:wrap}
.vig-viewer-meta{font-size:11.5px;color:var(--vig-text-faint);max-width:100%;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.vig-viewer-foot .vig-btn{white-space:nowrap}
/* 四点变形的角点覆盖层：画在整块舞台上，角点拖出图外也看得见 */
.vig-viewer-quad{position:absolute;inset:0;width:100%;height:100%;overflow:visible;z-index:6;touch-action:none}
.vig-viewer-quad circle{filter:drop-shadow(0 1px 2px rgba(15,23,42,.45))}
.vig-icon-btn.is-on{color:var(--vig-accent);border-color:var(--vig-accent)}
.vig-btn.is-primary.is-sm{background:var(--vig-accent);border-color:var(--vig-accent);color:#fff}
.vig-root[data-compact="1"] .vig-viewer{padding:8px}
.vig-root[data-compact="1"] .vig-viewer-body{height:calc(100vh - 16px)}
.vig-root[data-compact="1"] .vig-viewer-title{max-width:30%}
/* 提示条：贴在窗口额头（fixed 到视口顶端居中），内容两侧各留三字白。
   以前是贴着容器底部的通栏横条 —— 在右侧栏 / 停靠面板里会被拉成一整行，读起来像报错页。 */
.vig-toasts{position:fixed;top:10px;left:50%;transform:translateX(-50%);z-index:80;
	display:flex;flex-direction:column;align-items:center;gap:6px;pointer-events:none;max-width:min(560px,calc(100vw - 24px))}
.vig-toast{pointer-events:auto;display:inline-flex;align-items:center;justify-content:center;
	padding:0 3em;min-height:34px;border-radius:999px;background:var(--vig-surface);
	border:1px solid var(--vig-line);box-shadow:var(--vig-shadow);font-size:12.5px;line-height:1.4;
	text-align:center;word-break:break-word}
.vig-toast.is-err{border-color:rgba(229,72,77,.4);color:var(--vig-danger);background:rgba(255,247,247,.98)}
.vig-toast.is-ok{border-color:var(--vig-accent-line)}
body[data-ds-dark-theme] .vig-toast.is-err{background:rgba(48,26,30,.96)}
.vig-split{display:flex;gap:var(--vig-gap);min-height:0;flex:1}
.vig-ic{width:16px;height:16px;display:block}

/* 右侧停靠面板：内缩，不再盖住窗口标题栏与控制按钮 */
.vig-dock{
	position:fixed;top:46px;right:10px;bottom:10px;z-index:40;
	width:var(--vig-dock-w,min(430px,42vw));max-width:calc(100vw - 20px);box-sizing:border-box;display:flex;gap:0;padding:8px 8px 8px 0;
	background:var(--vig-surface-soft);border:1px solid var(--vig-line);
	border-radius:var(--vig-r-card);box-shadow:0 18px 48px rgba(16,24,40,.18);
}
	.vig-dock-body{flex:1;min-width:0;min-height:0;display:flex}
/* 侧栏 tab 里的宿主容器：只是给可见性判定一个可量的盒子，不参与视觉（原来直接返回
   Workbench，IntersectionObserver 没有可观测的自家节点）。 */
.vig-pane-host{display:flex;flex-direction:column;flex:1;min-width:0;min-height:0;height:100%}
.vig-dock-grip{
	position:absolute;left:-3px;top:50%;width:6px;height:74px;margin-top:-37px;border-radius:999px;
	cursor:ew-resize;touch-action:none;background:transparent;
}
.vig-dock-grip:hover{background:var(--vig-accent-soft)}

/* 窄容器（产品右侧栏 / 停靠面板 / 分屏）：导航折成顶部段控件，检查器沉到工作区下方。
   这条是必须的——470px 里再并排放 150 导航 + 268 检查器，中间就没地方了。 */
.vig-root[data-compact="1"]{overflow:auto}
.vig-root[data-compact="1"] .vig-shell{flex-direction:column;gap:10px;min-height:0}
.vig-root[data-compact="1"] .vig-nav{
	width:auto;flex:none;flex-direction:row;flex-wrap:wrap;gap:2px;padding:5px;
}
.vig-root[data-compact="1"] .vig-nav-item{width:auto;padding:7px 10px;font-size:12.5px;height:auto;flex:none}
.vig-root[data-compact="1"] .vig-nav-foot{display:none}
.vig-root[data-compact="1"] .vig-side{width:auto;flex:none;overflow:visible}
.vig-root[data-compact="1"] .vig-main{min-height:360px;flex:1 0 auto}
.vig-root[data-compact="1"] .vig-main-body{overflow:visible}
.vig-root[data-compact="1"] .vig-tiles{grid-template-columns:repeat(auto-fill,minmax(118px,1fr));padding:12px}
.vig-root[data-compact="1"] .vig-grid{width:100%;max-width:640px;grid-template-columns:repeat(2,minmax(0,1fr));gap:6px}
.vig-root[data-compact="1"] .vig-grid.is-single{width:min(100%,360px);grid-template-columns:minmax(0,1fr)}
.vig-root[data-compact="1"] .vig-grid.is-trio{grid-template-columns:repeat(2,minmax(0,1fr))}
.vig-root[data-compact="1"] .vig-mini{padding:3px 7px;font-size:11.5px;border-radius:7px}
/* 窄栏里缩略图那一行放不下「用这张重绘 / 复制链接 / 打开原图」三个全称，
   用 data-short 里的短文案换掉（title 里仍有全称，鼠标悬停能看到）。 */
.vig-root[data-compact="1"] .vig-shot-bar .vig-mini{font-size:0}
.vig-root[data-compact="1"] .vig-shot-bar .vig-mini::after{content:attr(data-short);font-size:11.5px}
.vig-root[data-compact="1"] .vig-shot-bar{justify-content:space-between;flex-wrap:wrap}
.vig-root[data-compact="1"] .vig-composer{margin:0 10px 10px}
.vig-root[data-compact="1"] .vig-head{padding:10px 12px}
.vig-root[data-compact="1"] .vig-title{font-size:13px}

/* 宽度硬约束。踩过的坑：输入区那排控件里 <select> 是 width:100% 且 min-width:auto，
   而 select 的最小内容宽度就是最长选项文字（“nano-banana-2.1” ~120px），三个并排 +
   工具按钮 + 计数 + 发送键 ≈ 500px，压不下去 —— 整列被撑宽，超出侧栏的部分被宿主裁掉。
   所以：flex 子项统一 min-width:0，下拉改成可压缩的弹性宽度，窄栏里再收紧一档。 */
.vig-root{width:100%;max-width:100%}
.vig-shell>.vig-col,.vig-shell>.vig-side,.vig-main-head>*,.vig-tools>*,.vig-shot-bar>*{min-width:0}
.vig-tools select,.vig-tools .vig-sel{width:auto;flex:0 1 auto;min-width:0}
.vig-root[data-compact="1"]{overflow-x:hidden}
.vig-root[data-compact="1"] .vig-tools select,.vig-root[data-compact="1"] .vig-tools .vig-sel{
	flex:0 1 auto;min-width:0;padding:6px 8px;font-size:12px}
/* 模型选择器是自绘的，窄栏里收紧按钮；弹层的定位包含块从按钮提到输入区/工具条，
   宽度铺满卡片——不然 236px 的弹层在 300px 卡片里会伸出去被 overflow:hidden 裁掉。 */
.vig-root[data-compact="1"] .vig-tools .vig-picker{flex:0 1 auto;min-width:0}
.vig-root[data-compact="1"] .vig-tools .vig-pick{max-width:124px;padding:0 7px}
.vig-root[data-compact="1"] .vig-picker{position:static}
.vig-root[data-compact="1"] .vig-pop{width:auto;left:0;right:0;max-height:min(300px,52vh)}
.vig-root[data-compact="1"] .vig-head .vig-pill{display:none}
.vig-root[data-compact="1"] .vig-main-body{min-height:180px}

/* ---- 图片处理工具箱：左工具条 / 中画布 / 右参数 ---- */
.vig-ps{--vig-tool-col:clamp(60px,10%,96px);--vig-layers-col:clamp(144px,22%,240px);--vig-float-w:clamp(236px,32%,320px);display:grid;grid-template-columns:var(--vig-tool-col) minmax(0,1fr) var(--vig-layers-col);gap:12px;padding:12px;align-items:start;position:relative}
/* 拖入：整块工具箱蒙一层虚框，松手就载入（不抢当前工具的状态） */
.vig-ps::after{content:"";position:absolute;inset:6px;border:2px dashed transparent;border-radius:14px;
	pointer-events:none;transition:border-color .12s}
.vig-ps[data-drop="1"]::after{border-color:var(--vig-accent);background:rgba(11,11,12,.04)}
.vig-ps-drop{position:absolute;inset:0;display:none;align-items:center;justify-content:center;pointer-events:none;z-index:5}
.vig-ps[data-drop="1"] .vig-ps-drop{display:flex}
.vig-ps-drop-card{display:inline-flex;align-items:center;gap:8px;padding:10px 16px;border-radius:12px;
	background:var(--vig-surface);border:1px solid var(--vig-accent-line);box-shadow:var(--vig-shadow);
	color:var(--vig-accent);font-size:13px;font-weight:600}
/* 按需展开：收起标签 → 工具条瘦成图标栏；收起参数 → 参数栏瘦成一条竖签 */
.vig-ps[data-labels="0"]{--vig-tool-col:52px}
.vig-ps-tools{display:flex;flex-direction:column;gap:6px;position:relative}
.vig-ps-tools-toggle{display:flex;align-items:center;justify-content:center;height:20px;border:0;border-radius:8px;
	background:transparent;color:var(--vig-text-muted);cursor:pointer;opacity:.75}
.vig-ps-tools-toggle:hover{background:var(--vig-surface-sunken);opacity:1}
.vig-ps[data-labels="0"] .vig-ps-tool span{display:none}
.vig-ps[data-labels="0"] .vig-ps-tool{padding:9px 2px}
.vig-ps-tool{display:flex;flex-direction:column;align-items:center;gap:4px;padding:10px 4px;border:1px solid transparent;
	border-radius:var(--vig-r-tile);background:var(--vig-surface);color:var(--vig-text-muted);font-size:11.5px;cursor:pointer;
	transition:border-color .14s ease,color .14s ease,background .14s ease}
.vig-ps-tool:hover{border-color:var(--vig-line-strong);color:var(--vig-text)}
.vig-ps-tool.is-on{border-color:var(--vig-accent);color:var(--vig-accent);background:var(--vig-accent-soft)}
.vig-ps-stage{position:relative;display:block;min-height:clamp(320px,58vh,720px);border:1px solid var(--vig-line);
	border-radius:var(--vig-r-card);overflow:hidden;
	background-color:var(--vig-surface-sunken);
	background-image:linear-gradient(45deg,rgba(0,0,0,.045) 25%,transparent 25%,transparent 75%,rgba(0,0,0,.045) 75%),
		linear-gradient(45deg,rgba(0,0,0,.045) 25%,transparent 25%,transparent 75%,rgba(0,0,0,.045) 75%);
	background-size:18px 18px;background-position:0 0,9px 9px}
/* 滚动容器自己 flex + 内容 margin:auto：放大到超出容器时左上角仍然滚得到（justify-content:center 会截头） */
.vig-ps-scroll{position:absolute;inset:0;display:flex;overflow:auto;padding:12px;box-sizing:border-box}
.vig-ps-canvas{display:block;flex:none;border-radius:var(--vig-r-tile);box-shadow:var(--vig-shadow-soft);cursor:default}
.vig-ps-canvas.is-select{cursor:crosshair;touch-action:none}
/* 标尺：光标是十字，拖的时候整层带一点过渡，肉眼跟得上但不掉帧 */
.vig-ps-canvas.is-ruler{cursor:crosshair;touch-action:none;transition:transform .04s linear}
/* 四点矫正：十字光标 + 抓手（拖的是覆盖层上的四个角点） */
.vig-ps-canvas.is-warp{cursor:crosshair;touch-action:none}
.vig-ps-seg.is-3{grid-template-columns:repeat(3,1fr)}
.vig-ps-overlay{position:absolute;left:0;top:0;pointer-events:none;border-radius:var(--vig-r-tile)}
.vig-ps-zoom{position:absolute;right:10px;bottom:10px;z-index:2;display:flex;align-items:center;gap:3px;padding:3px 5px;
	border:1px solid var(--vig-line);border-radius:999px;background:color-mix(in srgb,var(--vig-surface) 88%,transparent);
	box-shadow:var(--vig-shadow-soft);backdrop-filter:blur(6px)}
.vig-ps-zoom-btn{height:22px;min-width:22px;padding:0 7px;border:1px solid transparent;border-radius:999px;background:transparent;
	color:var(--vig-text-muted);font-size:11.5px;line-height:1;cursor:pointer}
.vig-ps-zoom-btn:hover{background:var(--vig-surface-sunken);color:var(--vig-text)}
.vig-ps-zoom-btn.is-on{border-color:var(--vig-accent);color:var(--vig-accent);background:var(--vig-accent-soft)}
.vig-ps-zoom-val{min-width:38px;text-align:center;font-size:11.5px;color:var(--vig-text);font-variant-numeric:tabular-nums}
.vig-ps-empty{position:absolute;inset:0;overflow:auto;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:8px;padding:24px 18px;color:var(--vig-text-muted);text-align:center}
/* 空画面入口先可用，缩略图只在手动展开后占用布局和网络。 */
.vig-ps-empty{justify-content:safe center}
.vig-ps-recent{width:100%;max-width:560px;margin-top:10px;display:grid;gap:8px;text-align:left;flex:none}
.vig-ps-shelf{display:grid;gap:8px;min-width:0}
.vig-ps-shelf-toggle{display:flex;align-items:center;gap:8px;width:100%;min-height:32px;padding:6px 10px;border:1px solid var(--vig-line);border-radius:var(--vig-r-input);background:var(--vig-surface);color:var(--vig-text);cursor:pointer;text-align:left}
.vig-ps-shelf-toggle span:last-child{margin-left:auto}
.vig-ps-recent-grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(76px,1fr));gap:8px}
.vig-ps-recent-tile{padding:0;border:1px solid var(--vig-line);border-radius:14px;overflow:hidden;background:var(--vig-surface);cursor:pointer;
	aspect-ratio:1/1;transition:border-color .14s ease,transform .14s ease}
.vig-ps-recent-tile:hover{border-color:var(--vig-accent);transform:translateY(-1px)}
.vig-ps-recent-tile img{width:100%;height:100%;object-fit:cover;display:block}
.vig-ps-steps{margin:12px 0 0;padding-left:20px;text-align:left;font-size:12px;line-height:1.9;color:var(--vig-text-muted)}
.vig-link{border:0;background:transparent;padding:0;color:var(--vig-accent);font:inherit;font-size:12px;cursor:pointer}
.vig-link:hover{text-decoration:underline}
.vig-ps-shot{position:relative;display:block;flex:none;margin:auto}
.vig-ps-transform{position:absolute;pointer-events:none;outline:1px solid #169dff;box-sizing:border-box}
.vig-root button.vig-ps-grip{position:absolute;width:15px;height:15px;padding:0;margin:0;min-width:0;border:0;background:transparent;display:grid;place-items:center;transform:translate(-50%,-50%);touch-action:none;pointer-events:auto}
.vig-ps-grip::after{content:'';width:7px;height:7px;border:1px solid #145187;background:white}
.vig-ps-grip[data-ps-handle="move"]::after{border-radius:50%;background:#169dff;box-shadow:0 0 0 1px white}
.vig-ps-shot img{display:block;width:100%;height:100%;border-radius:var(--vig-r-tile);box-shadow:var(--vig-shadow-soft)}
.vig-ps-marquee{position:absolute;border:1px dashed var(--vig-accent);background:rgba(11,11,12,.12);box-sizing:border-box}
.vig-ps-marquee i{position:absolute;width:8px;height:8px;margin:-4px 0 0 -4px;background:#fff;border:1px solid var(--vig-accent)}
/* 静态预览里的标尺（跟真机上 canvas 画的那条一个样子） */
.vig-ps-shot img{transform-origin:center center}
.vig-ps-ruler-line{position:absolute;height:0;border-top:2px dashed var(--vig-accent);transform-origin:0 0;pointer-events:none}
/* 静态预览的四点矫正层：和真画布那层同一套几何，只是用 SVG 画（预览里没有 canvas） */
.vig-ps-warp-shot{position:absolute;left:0;top:0;pointer-events:none}
.vig-ps-warp-shot text{font:600 11px system-ui,sans-serif}
.vig-ps-ruler-angle{position:absolute;padding:2px 7px;border-radius:999px;background:rgba(16,24,40,.78);color:#fff;font-size:11.5px;pointer-events:none}
.vig-ps-seg{display:grid;grid-template-columns:1fr 1fr;gap:4px;padding:3px;border:1px solid var(--vig-line);border-radius:999px;background:var(--vig-surface-sunken)}
.vig-ps-seg-btn{height:24px;border:0;border-radius:999px;background:transparent;color:var(--vig-text-muted);font-size:12px;cursor:pointer}
.vig-ps-seg-btn.is-on{background:var(--vig-surface);color:var(--vig-text);box-shadow:var(--vig-shadow-soft)}
.vig-ps-dpi{display:grid;grid-template-columns:1fr repeat(4,auto);gap:4px;align-items:center}
.vig-ps-dpi .vig-in{width:100%;min-width:0}
.vig-ps-dpi-btn{height:26px;padding:0 7px;border:1px solid var(--vig-line);border-radius:8px;background:var(--vig-surface);
	color:var(--vig-text-muted);font-size:11.5px;cursor:pointer;font-variant-numeric:tabular-nums}
.vig-ps-dpi-btn.is-on{border-color:var(--vig-accent);color:var(--vig-accent);background:var(--vig-accent-soft)}
/* 参数栏现在是浮窗：压在画布上，拖头部就移动（位置记在 localStorage） */
.vig-ps-float{position:absolute;right:12px;top:12px;z-index:6;width:256px;max-height:calc(100% - 24px);overflow:auto;
	background:var(--vig-surface);box-shadow:var(--vig-shadow);cursor:default}
/* 曲线编辑器：256×256 的曲线空间，网格 + 对角参考线 + 控制点 */
.vig-curve{display:flex;flex-direction:column;gap:6px;margin-top:6px}
.vig-curve-svg{border:1px solid var(--vig-line);border-radius:10px;background:var(--vig-surface-soft);display:block;max-width:100%}
.vig-curve-grid{stroke:var(--vig-line);stroke-width:1}
.vig-curve-diagonal{stroke:var(--vig-line-strong, var(--vig-line));stroke-width:1;stroke-dasharray:4 4;opacity:.7}
.vig-curve-line{fill:none;stroke:var(--vig-accent);stroke-width:2.5;stroke-linejoin:round;stroke-linecap:round}
.vig-curve-dot{fill:var(--vig-surface);stroke:var(--vig-accent);stroke-width:2.5}/* 「调整」面板的规范化表单：分区标题 + 两列网格 + 右对齐动作行（尺寸/对齐统一，不再大小不一） */
/* 收起后的参数：一条贴右边缘的窄抽屉（只剩一个竖排小签），不再是一大片空白盒子 */
.vig-ps-float.is-collapsed{width:auto;min-width:0;max-width:none;padding:0;border-radius:12px 0 0 12px;
	box-shadow:var(--vig-shadow);overflow:visible}
.vig-ps-float.is-collapsed .vig-ps-params-open{width:30px;font-size:11px}/* 历史操作记录：钉在画布正下方（第 2 行第 2 列），一条横向滚动的步骤列表 */
.vig-ps-history{display:flex;flex-direction:column;gap:6px;min-width:0;padding-top:8px;
	border-top:1px solid var(--vig-line)}
.vig-ps-history-title{flex:none;font-size:11.5px;color:var(--vig-text-muted);white-space:nowrap}
.vig-ps-history-list{display:flex;flex-direction:column;align-items:stretch;gap:3px;min-width:0;max-height:132px;overflow-y:auto}
.vig-ps-history-item{flex:none;height:24px;padding:0 8px;border-radius:7px;border:1px solid transparent;
	font-size:11.5px;color:var(--vig-text-muted);white-space:nowrap;max-width:160px;overflow:hidden;text-overflow:ellipsis}
.vig-ps-history-item:hover{background:var(--vig-surface-sunken);color:var(--vig-text)}
.vig-ps-history-item.is-current{border-color:var(--vig-accent-line);background:var(--vig-accent-soft);color:var(--vig-accent);font-weight:600}
.vig-ps-history-item.is-future{opacity:.55;text-decoration:line-through}
.vig-ps-form{display:flex;flex-direction:column;gap:8px;min-width:0}
.vig-ps-form .vig-ps-section{margin-top:4px}
.vig-ps-form-grid{display:grid;grid-template-columns:minmax(0,1fr) minmax(0,1fr);gap:8px;min-width:0}
.vig-ps-form-grid.is-three{grid-template-columns:repeat(3,minmax(0,1fr))}
.vig-ps-control{display:flex;flex-direction:column;gap:4px;min-width:0}
.vig-ps-control-head{display:flex;align-items:baseline;justify-content:space-between;gap:6px;min-width:0;
	font-size:11px;color:var(--vig-text-muted)}
.vig-ps-control-head>span:first-child{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.vig-ps-control-value{flex:none;font-variant-numeric:tabular-nums;color:var(--vig-text);font-weight:600}
.vig-ps-control .vig-range{display:block;width:100%}
.vig-ps-control .vig-in{width:100%;height:28px;padding:0 8px}
.vig-ps-row{display:flex;align-items:center;gap:6px;flex-wrap:wrap;min-width:0}
.vig-ps-actions{display:flex;align-items:center;gap:6px;padding-top:2px}
.vig-ps-actions .vig-btn{flex:none}
.vig-ps-presets{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:4px}
.vig-ps-presets .vig-btn{width:100%;justify-content:center;padding:5px 4px;font-size:11.5px}
.vig-ps-form .vig-curve-svg{width:100%;height:auto}.vig-ps-section{margin-top:10px;padding-top:8px;border-top:1px solid var(--vig-line);font-size:11.5px;font-weight:600;color:var(--vig-text-muted)}
.vig-ps-layers{display:flex;flex-direction:column;gap:8px;padding:12px;border:1px solid var(--vig-line);min-width:0;
	border-radius:var(--vig-r-card);background:var(--vig-surface);min-height:0}
.vig-ps-layers-head{display:flex;align-items:center;gap:7px;font-size:13px;font-weight:600;color:var(--vig-text)}
.vig-ps-layers-empty{font-size:11.5px;line-height:1.6;color:var(--vig-text-faint)}
.vig-ps-layer-row{display:flex;align-items:center;gap:6px;padding:6px;border:1px solid var(--vig-line);flex-wrap:wrap;
	border-radius:10px;background:var(--vig-surface-soft);min-width:0}
.vig-ps-layer-row.is-base{background:transparent;border-style:dashed}
.vig-ps-layer-row.is-hidden{opacity:.5}
.vig-ps-layer-name{flex:1 1 60px;min-width:0;font-size:12px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.vig-ps-layer-meta{font-size:11px;color:var(--vig-text-faint)}
.vig-ps-layer-eye{width:20px;height:20px;border-radius:6px;display:inline-flex;align-items:center;justify-content:center;
	color:var(--vig-text-muted);flex:none}
.vig-ps-layer-eye:hover{background:var(--vig-surface-sunken);color:var(--vig-text)}
.vig-ps-layer-mode{height:24px;border-radius:7px;border:1px solid var(--vig-line);background:var(--vig-surface);min-width:0;
	font-size:11px;max-width:86px;flex:none}
.vig-ps-layer-opacity{width:56px;flex:1 1 56px;min-width:40px}
.vig-ps-layer-mini{width:18px;height:18px;border-radius:5px;display:inline-flex;align-items:center;justify-content:center;
	color:var(--vig-text-faint);flex:none}
.vig-ps-layer-mini:hover{background:var(--vig-surface-sunken);color:var(--vig-text)}
.vig-ps-layer-mini.is-danger:hover{color:var(--vig-danger)}
.vig-ps-layer-mini.is-on{color:var(--vig-accent)}
.vig-ps-layer-row[title]{cursor:pointer}
.vig-ps-layer-row.is-editing{border-color:var(--vig-accent-line);background:var(--vig-accent-soft)}
.vig-ps-layer-session{display:flex;align-items:center;gap:8px;padding:6px 8px;border-radius:9px;
	background:var(--vig-accent-soft);border:1px solid var(--vig-accent-line);color:var(--vig-accent);font-size:11.5px}
.vig-ps-params{display:flex;flex-direction:column;gap:10px;padding:12px;border:1px solid var(--vig-line);
	border-radius:var(--vig-r-card);background:var(--vig-surface)}
/* 收起态：只剩一条竖签（工具图标 + 竖排名字），点一下展开 */
.vig-ps-params.is-collapsed{padding:0;align-items:center;gap:0}
.vig-ps-params-open{display:flex;flex-direction:column;align-items:center;gap:6px;width:100%;padding:10px 5px;border:0;
	border-radius:12px;background:transparent;color:var(--vig-text-muted);cursor:pointer;font-size:11px}
.vig-ps-params-open span{writing-mode:vertical-rl;letter-spacing:1px}
.vig-ps-params-open:hover{background:var(--vig-surface-sunken);color:var(--vig-text)}
.vig-ps-params-head{display:flex;align-items:center;gap:7px;font-size:13px;font-weight:600;color:var(--vig-text)}
.vig-ps-params-name{white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.vig-ps-params .vig-field{display:flex;flex-direction:column;gap:5px}
.vig-ps-params .vig-label{white-space:nowrap}
/* 顶点矫正/透视面板：限宽 + 长提示换行，别把浮层撑成一大块 */
.vig-ps-params{max-width:100%;width:var(--vig-float-w);box-sizing:border-box;overflow-wrap:anywhere}
.vig-ps-params .vig-ps-row{flex-wrap:wrap;gap:6px}
.vig-ps-params .vig-btn{height:28px;padding:0 10px;font-size:12px}
.vig-ps-params .vig-muted{font-size:11.5px;line-height:1.5;margin:0}
.vig-ps-float{max-width:340px}
.vig-ps-params .vig-sel{width:100%}
.vig-ps-params .vig-form-grid{grid-template-columns:1fr 1fr}
.vig-ps-readout{font-size:12px;color:var(--vig-text);background:var(--vig-surface-sunken);border-radius:var(--vig-r-tile);
	padding:8px 10px;font-variant-numeric:tabular-nums}
.vig-ps-foot{display:flex;gap:6px;padding-top:8px;border-top:1px solid var(--vig-line);margin-top:2px}
.vig-ps-foot .vig-btn{flex:1 1 0;justify-content:center}
.vig-ps-btns{display:grid;grid-template-columns:repeat(auto-fit,minmax(76px,1fr));gap:6px}
.vig-ps-btns .vig-btn{justify-content:center}
.vig-ps-btns.is-ratio{grid-template-columns:repeat(3,minmax(0,1fr))}
/* 参数栏里单独站着的主按钮铺满一列；夹在行里（和滑杆/清零一排）的按钮保持自适应，
   否则 width:100% 会把那一行撑破（踩过：框选面板的「裁切」把参数栏顶出 154px）。 */
.vig-ps-params .vig-btn.is-primary{width:100%;justify-content:center}
.vig-ps-params .vig-row .vig-btn{width:auto;flex:none}
.vig-ps-anchor{display:grid;grid-template-columns:repeat(3,22px);gap:4px;justify-content:start}
.vig-ps-anchor-btn{width:22px;height:22px;padding:0;border:1px solid var(--vig-line);border-radius:6px;background:var(--vig-surface);cursor:pointer}
.vig-ps-anchor-btn i{display:block;width:6px;height:6px;border-radius:2px;background:var(--vig-text-muted);margin:auto}
.vig-ps-anchor-btn.is-on{border-color:var(--vig-accent);background:var(--vig-accent-soft)}
.vig-ps-anchor-btn.is-on i{background:var(--vig-accent)}
.vig-ps-tiles{display:grid;grid-template-columns:repeat(auto-fill,minmax(84px,1fr));gap:8px}
.vig-ps-tile{display:flex;flex-direction:column;gap:5px;font-size:11px}
.vig-ps-tile img{width:100%;height:64px;object-fit:cover;border-radius:6px;background:var(--vig-surface-sunken)}
.vig-ps-tile-meta{color:var(--vig-text-muted);font-variant-numeric:tabular-nums}
.vig-range{-webkit-appearance:none;appearance:none;width:100%;height:4px;border-radius:2px;background:var(--vig-line-strong);outline:none}
.vig-range::-webkit-slider-thumb{-webkit-appearance:none;width:14px;height:14px;border-radius:50%;background:var(--vig-accent);cursor:pointer}
.vig-root[data-compact="1"] .vig-ps{grid-template-columns:minmax(0,1fr);gap:10px}
.vig-root[data-compact="1"] .vig-ps-tools{flex-direction:row;flex-wrap:wrap}
.vig-root[data-compact="1"] .vig-ps-tools-toggle{display:none}
.vig-root[data-compact="1"] .vig-ps-tool{flex:1 1 72px;flex-direction:row;justify-content:center;padding:8px 6px}
.vig-root[data-compact="1"] .vig-ps-stage{min-height:240px}
/* 窄容器里浮窗改成贴右上，别按绝对 left 往外顶（320px 会横向溢出） */

.vig-ps-keys{display:flex;flex-direction:column;gap:6px;margin-top:12px}
.vig-ps-keys-title{font-size:11.5px;font-weight:600;color:var(--vig-text-muted);letter-spacing:.4px}
.vig-ps-keys-row{display:grid;grid-template-columns:126px minmax(0,1fr) auto;gap:10px;align-items:center;font-size:12.5px}
/* 键帽就是按钮：点一下进录制态 */
.vig-ps-key{display:inline-block;min-width:0;padding:3px 9px;border:1px solid var(--vig-line);border-bottom-width:2px;
	border-radius:8px;background:var(--vig-surface-sunken);font:inherit;font-size:11.5px;color:var(--vig-text);
	text-align:center;white-space:nowrap;cursor:pointer;transition:border-color .14s ease,color .14s ease}
.vig-ps-key:hover{border-color:var(--vig-accent);color:var(--vig-accent)}
.vig-ps-key.is-custom{border-color:var(--vig-accent);border-style:dashed}
.vig-ps-key.is-off{color:var(--vig-text-muted);border-style:dotted}
.vig-ps-key.is-recording{border-color:var(--vig-accent);color:var(--vig-accent);background:var(--vig-accent-soft);
	animation:vig-ps-key-pulse 1s ease-in-out infinite}
@keyframes vig-ps-key-pulse{0%,100%{opacity:1}50%{opacity:.55}}
.vig-ps-key-reset{display:inline-flex;align-items:center;border:0;background:transparent;padding:3px;border-radius:8px;
	color:var(--vig-text-muted);cursor:pointer}
.vig-ps-key-reset:hover{background:var(--vig-surface-sunken);color:var(--vig-text)}
.vig-ps-key-error{margin-top:8px;padding:7px 10px;border-radius:10px;background:rgba(214,69,69,.1);color:#c0392b;font-size:12px}
/* 矫正面板里的实时读数：拖的时候亮起来 */
.vig-ps-ruler{display:flex;align-items:center;gap:8px;padding:8px 11px;border:1px dashed var(--vig-line);border-radius:12px;
	font-size:12.5px;color:var(--vig-text-muted)}
.vig-ps-ruler.is-live{border-style:solid;border-color:var(--vig-accent);color:var(--vig-accent);background:var(--vig-accent-soft)}
.vig-ps-ruler-read{white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.vig-modal.is-keys{width:min(540px,100%);max-height:min(82vh,720px);overflow:auto}
.vig-kbd-dot{display:inline-block;width:18px;text-align:center;font-size:12.5px;font-weight:600}
.vig-root[data-compact="1"] .vig-ps-zoom{right:8px;bottom:8px}
.vig-root :where(.vig-ps-tool,.vig-ps-anchor-btn,.vig-ps-zoom-btn,.vig-ps-seg-btn,.vig-ps-dpi-btn,.vig-range){font-family:inherit}

/* ============================================================
   设计系统 v2 · 杂志极简白（Editorial Minimal White）
   规范见 docs/UI-SPEC.md：
   · 墨黑承担全部层级，朱红（--vig-signal）只做点缀，面积 <2%
   · 点一下触发的东西一律胶囊（pill）；承载内容的一律大圆角
   · 卡片只留 1px 细线，阴影只给浮层；数字等宽；动效 160ms 统一
   ============================================================ */
.vig-root ::selection{background:var(--vig-accent);color:var(--vig-surface)}
.vig-root :where(button,a,input,textarea,select,[tabindex]):focus-visible{outline:0;box-shadow:0 0 0 3px var(--vig-ring)}
.vig-root :where(button,a,[role="button"]):disabled{opacity:.45;cursor:not-allowed}

/* --- 排版尺度 --- */
.vig-title{font-size:15px;font-weight:600;letter-spacing:-.01em}
.vig-launch-text .vig-title,.vig-main-head .vig-title,.vig-page-head .vig-title{font-size:22px;font-weight:650;letter-spacing:-.015em;line-height:1.15}
.vig-block-title{font-size:11px;font-weight:600;letter-spacing:.08em;text-transform:uppercase;color:var(--vig-text-muted)}
.vig-block-title:before{content:"";display:inline-block;width:12px;height:1px;background:var(--vig-accent);margin-right:8px;vertical-align:3px}
.vig-label{font-size:11px;letter-spacing:.04em;color:var(--vig-text-muted)}
.vig-muted,.vig-hint,.vig-hint-sub{font-size:12px;color:var(--vig-text-muted)}
.vig-text{font-size:13.5px;line-height:1.65}
.vig-tag,.vig-kbd-dot,.vig-block-title,.vig-shot-bar,.vig-viewer-meta,.vig-count{font-variant-numeric:tabular-nums}

/* --- 顶部栏：白纸 + 一条细线，不再是浮起来的卡片 --- */
.vig-head{background:transparent;border:0;border-bottom:1px solid var(--vig-line);border-radius:0;box-shadow:none;padding:14px 18px}
.vig-mark{background:var(--vig-accent);color:var(--vig-surface);border-radius:12px;box-shadow:none;width:28px;height:28px}
.vig-mark svg{width:15px;height:15px}

/* --- 左侧导航：胶囊选中（墨黑底白字，反相自动适配深色） --- */
.vig-nav-item{border-radius:var(--vig-r-pill);color:var(--vig-text-muted);
	transition:background-color var(--vig-dur) var(--vig-ease),color var(--vig-dur) var(--vig-ease)}
.vig-nav-item:hover{background:var(--vig-surface-sunken);color:var(--vig-text)}
.vig-nav-item.is-on{background:var(--vig-accent);color:var(--vig-surface);font-weight:600}
.vig-nav-item.is-on :where(svg,.vig-ic){color:var(--vig-surface)}
.vig-nav-foot{border-top:1px solid var(--vig-line)}
.vig-nav-foot-row{display:flex;align-items:baseline;justify-content:space-between;gap:8px;padding:3px 0}
.vig-nav-foot-row>span:first-child{font-size:11px;letter-spacing:.06em;color:var(--vig-text-faint)}
.vig-nav-foot-val{font-family:var(--vig-font-display);font-size:18px;font-weight:600;line-height:1.05;
	color:var(--vig-text);font-variant-numeric:tabular-nums}

/* --- 按钮：全部胶囊 --- */
.vig-btn{border-radius:var(--vig-r-pill);height:32px;padding:0 14px;font-size:13px;font-weight:500;
	transition:background-color var(--vig-dur) var(--vig-ease),color var(--vig-dur) var(--vig-ease),
		border-color var(--vig-dur) var(--vig-ease),transform 120ms var(--vig-ease)}
.vig-btn:hover{background:var(--vig-surface-sunken);color:var(--vig-text)}
.vig-btn:active{transform:scale(.985)}
.vig-btn.is-primary{background:var(--vig-accent);border-color:var(--vig-accent);color:var(--vig-surface)}
.vig-btn.is-primary:hover{background:#26262a;border-color:#26262a;color:#fff}
body[data-ds-dark-theme] .vig-btn.is-primary:hover{background:#fff;border-color:#fff;color:#0b0b0c}
.vig-btn.is-ghost{background:transparent;border-color:transparent;color:var(--vig-text-muted)}
.vig-btn.is-ghost:hover{background:var(--vig-surface-sunken);color:var(--vig-text)}
.vig-btn.is-sm{height:26px;padding:0 11px;font-size:12px}
.vig-btn.is-danger{background:transparent;border-color:transparent;color:var(--vig-danger)}
.vig-btn.is-danger:hover{background:rgba(217,33,33,.08);color:var(--vig-danger)}

/* --- 图标按钮 / 工具按钮：圆形 --- */
.vig-icon-btn,.vig-tool{width:30px;height:30px;border-radius:var(--vig-r-pill);color:var(--vig-text-muted);
	transition:background-color var(--vig-dur) var(--vig-ease),color var(--vig-dur) var(--vig-ease)}
.vig-icon-btn:hover,.vig-tool:hover{background:var(--vig-surface-sunken);color:var(--vig-text)}
.vig-icon-btn.is-on,.vig-tool.is-on{background:var(--vig-accent);color:var(--vig-surface)}
.vig-mini{width:26px;height:26px;border-radius:var(--vig-r-pill);color:var(--vig-text-faint);
	transition:background-color var(--vig-dur) var(--vig-ease),color var(--vig-dur) var(--vig-ease)}
.vig-mini:hover{background:var(--vig-surface-sunken);color:var(--vig-text)}

/* --- 结果卡动作行：杂志式小字标签 --- */
.vig-shot-bar{font-size:11px;letter-spacing:.06em;color:var(--vig-text-faint);gap:2px}
.vig-shot-bar button{font-size:11px;letter-spacing:.06em;color:var(--vig-text-faint);padding:4px 7px;
	border-radius:var(--vig-r-pill);transition:color var(--vig-dur) var(--vig-ease),background-color var(--vig-dur) var(--vig-ease)}
.vig-shot-bar button:hover{color:var(--vig-text);background:var(--vig-surface-sunken)}
.vig-shot-img{border-radius:var(--vig-r-tile)}

/* --- 卡片：细线，无阴影；hover 只加深线 --- */
.vig-card{box-shadow:none;transition:border-color var(--vig-dur) var(--vig-ease)}
.vig-card:hover{border-color:var(--vig-line-strong)}
.vig-block{box-shadow:none}
.vig-side{border-radius:var(--vig-r-card);border:0;box-shadow:none;background:transparent}
.vig-side-head{border-bottom:1px solid var(--vig-line)}

/* --- 输入区：18px 方肩，focus 墨色环 --- */
.vig-composer{border:1px solid var(--vig-line);border-radius:var(--vig-r-card);background:var(--vig-surface);
	box-shadow:none;transition:border-color var(--vig-dur) var(--vig-ease),box-shadow var(--vig-dur) var(--vig-ease)}
.vig-composer:focus-within{border-color:var(--vig-accent);box-shadow:0 0 0 3px var(--vig-ring)}
.vig-input{font-size:13.5px;line-height:1.65}
.vig-send{width:34px;height:34px;border-radius:var(--vig-r-pill);background:var(--vig-accent);color:var(--vig-surface);
	box-shadow:none;transition:background-color var(--vig-dur) var(--vig-ease),opacity var(--vig-dur) var(--vig-ease)}
.vig-send:hover{background:#26262a}
body[data-ds-dark-theme] .vig-send:hover{background:#fff}
.vig-send:disabled{opacity:.35}
.vig-sel{height:30px;padding:0 10px;border:1px solid var(--vig-line);background:var(--vig-surface);font-size:12.5px;
	border-radius:var(--vig-r-pill);transition:border-color var(--vig-dur) var(--vig-ease)}
.vig-sel:hover{border-color:var(--vig-line-strong)}

/* --- 标签 / chip / 计数 --- */
.vig-tag{height:20px;padding:0 8px;font-size:11px;font-weight:600;letter-spacing:.06em;border-radius:var(--vig-r-pill);
	background:var(--vig-surface-sunken);color:var(--vig-text-muted);display:inline-flex;align-items:center}
.vig-pill{height:26px;padding:0 12px;font-size:12px;border-radius:var(--vig-r-pill)}
.vig-count{border-radius:var(--vig-r-pill);font-size:11px;font-weight:600;background:var(--vig-surface-sunken);
	color:var(--vig-text-muted);padding:1px 7px;min-width:20px;text-align:center}
.vig-ref{border-radius:var(--vig-r-tile)}
.vig-ref-x{width:18px;height:18px;border-radius:var(--vig-r-pill)}

/* --- 会话气泡与头像 --- */
.vig-bubble.is-user{border-radius:18px 18px 6px 18px;border:1px solid var(--vig-line);background:var(--vig-surface);box-shadow:none}
.vig-avatar{width:22px;height:22px;border-radius:var(--vig-r-pill);font-size:10.5px;font-weight:600;letter-spacing:.02em}
.vig-turn.is-user .vig-avatar{background:var(--vig-accent);color:var(--vig-surface);border:0}
.vig-turn:not(.is-user) .vig-avatar{background:var(--vig-surface);border:1px solid var(--vig-line);color:var(--vig-text-muted)}
.vig-turn-acts .vig-mini{width:24px;height:24px}
.vig-me{font-size:13px}

/* --- 提示条：反白胶囊（杂志做法） --- */
.vig-toast{background:var(--vig-accent);color:var(--vig-surface);border:0;border-radius:var(--vig-r-pill);
	padding:0 16px;min-height:34px;font-size:12.5px;box-shadow:var(--vig-sh-2)}
.vig-toast.is-err{background:var(--vig-danger);color:#fff}
.vig-toast.is-err:before,.vig-toast.is-ok:before{content:"";width:6px;height:6px;border-radius:var(--vig-r-pill);
	margin-right:8px;flex:none;background:var(--vig-toast-dot,var(--vig-surface))}
.vig-toast.is-err:before{background:#fff}
.vig-toast.is-ok:before{background:#8ae0a8}

/* --- 弹窗 / 浮层 --- */
.vig-modal,.vig-pop{border-radius:var(--vig-r-sheet);border:1px solid var(--vig-line);box-shadow:var(--vig-sh-2)}
.vig-pop-item,.vig-note-item{border-radius:var(--vig-r-tile);
	transition:background-color var(--vig-dur) var(--vig-ease),color var(--vig-dur) var(--vig-ease)}
.vig-pop-item:hover,.vig-note-item:hover{background:var(--vig-surface-sunken)}
.vig-pop-item.is-on,.vig-note-item.is-on{background:var(--vig-accent);color:var(--vig-surface)}
.vig-floating,.vig-ps-zoom{border-radius:var(--vig-r-pill)}
/* 透视矫正面板：矩形容器（之前被 pill 规则套成胶囊/椭圆） */
.vig-ps-float{border-radius:12px}
.vig-ps-params{border-radius:12px}
.vig-ps-params .vig-btn{border-radius:8px}
.vig-ps-params .vig-ps-seg{border-radius:8px}
.vig-ps-params .vig-ps-seg-btn{border-radius:6px}

/* --- 查看器 --- */
.vig-viewer-body{border-radius:var(--vig-r-sheet)}
.vig-viewer-head{border-bottom:1px solid var(--vig-line)}
.vig-viewer-img{border-radius:8px}
.vig-viewer-foot{border-top:1px solid var(--vig-line)}
.vig-viewer-stage{background:var(--vig-surface-soft)}

/* --- 图片处理：画布工具用 tile 圆角，选中墨黑 --- */
.vig-ps-tool,.vig-ps-anchor-btn,.vig-ps-zoom-btn,.vig-ps-dpi-btn{border-radius:var(--vig-r-tile);
	transition:background-color var(--vig-dur) var(--vig-ease),color var(--vig-dur) var(--vig-ease)}
.vig-ps-tool:hover,.vig-ps-anchor-btn:hover,.vig-ps-zoom-btn:hover,.vig-ps-dpi-btn:hover{background:var(--vig-surface-sunken)}
.vig-ps-tool.is-on,.vig-ps-anchor-btn.is-on{background:var(--vig-accent);color:var(--vig-surface)}
.vig-ps-seg{border-radius:var(--vig-r-pill);border:1px solid var(--vig-line);padding:2px;background:var(--vig-surface-soft)}
.vig-ps-seg-btn{border-radius:var(--vig-r-pill)}
.vig-ps-seg-btn.is-on{background:var(--vig-accent);color:var(--vig-surface)}
.vig-ps-layer-row,.vig-ps-layer-mini{border-radius:var(--vig-r-tile)}
.vig-ps-layer-mini.is-on{border-color:var(--vig-accent)}
.vig-range{accent-color:var(--vig-accent)}
.vig-ps-key{border-radius:var(--vig-r-tile)}

/* --- 细节：滚动条、空状态、短横线 --- */
.vig-root ::-webkit-scrollbar{width:6px;height:6px}
.vig-empty{border:1px dashed var(--vig-line-strong);border-radius:var(--vig-r-card);background:transparent;
	font-size:12.5px;color:var(--vig-text-muted)}
.vig-sep{background:var(--vig-line)}
.vig-hintline{border-top:1px solid var(--vig-line)}

/* --- 动效降级（尊重系统设置） --- */
@media (prefers-reduced-motion: reduce){
	.vig-root *,.vig-root *:before,.vig-root *:after{transition:none !important;animation:none !important}
}

/* ============================================================
   设计系统 v2.1 · 分辨率修正（第一版验收截图里发现的问题）
   · 文字型小按钮被压成竖排：一律 nowrap + 自动宽度；图标型才固定 24 方
   · 主面板标题抬到 16/650；图片处理工具列收紧到 11px 一行
   ============================================================ */
.vig-mini{width:auto;min-width:24px;height:24px;padding:0 8px;line-height:1.2;border-radius:var(--vig-r-pill);
	font-size:12px;white-space:nowrap;color:var(--vig-text-muted)}
.vig-mini:hover{background:var(--vig-surface-sunken);color:var(--vig-text)}
.vig-turn-acts .vig-mini,.vig-icon-btn.vig-mini{width:24px;min-width:24px;height:24px;padding:0}
.vig-shot-bar{flex-wrap:wrap;justify-content:space-between;gap:2px;row-gap:4px}
.vig-shot-bar button{white-space:nowrap;flex:0 0 auto}
.vig-main-head .vig-title,.vig-main-head .vig-item-title{font-size:16px;font-weight:650;letter-spacing:-.01em}
.vig-main-head{padding:14px 18px}
.vig-ps-tool{white-space:nowrap;font-size:11px;letter-spacing:.02em;padding:7px 2px;line-height:1.25}
.vig-ps-tools{gap:4px}
.vig-tile-meta{font-size:11px;letter-spacing:.02em;gap:3px}
.vig-tile-name{font-weight:600}
.vig-item-title{font-size:13px}
.vig-page{gap:var(--vig-gap-lg)}
/* 图库卡片：图片铺满整宽（1:1），动作行收成无底 SVG 图标 —— 卡片不再被一行文字撑高 */
.vig-tiles{grid-template-columns:repeat(auto-fill,minmax(168px,1fr));gap:14px;padding:16px}
/* 布局密度：S 小图 / M 标准 / L 大图（记在 localStorage） */
.vig-density{display:inline-flex;align-items:center;gap:2px;padding:2px;border:1px solid var(--vig-line);
	border-radius:var(--vig-r-pill);background:var(--vig-surface-soft)}
.vig-density-btn{height:24px;min-width:30px;padding:0 8px;border:0;border-radius:var(--vig-r-pill);background:transparent;
	color:var(--vig-text-muted);font-size:11px;font-weight:600;letter-spacing:.04em;
	transition:background-color var(--vig-dur) var(--vig-ease),color var(--vig-dur) var(--vig-ease)}
.vig-density-btn:hover{background:var(--vig-surface-sunken);color:var(--vig-text)}
.vig-density-btn.is-on{background:var(--vig-accent);color:var(--vig-surface)}
.vig-tiles[data-density="compact"]{grid-template-columns:repeat(auto-fill,minmax(112px,1fr));gap:10px;padding:12px}
.vig-tiles[data-density="large"]{grid-template-columns:repeat(auto-fill,minmax(260px,1fr));gap:18px;padding:18px}
.vig-tile{min-width:0;align-self:start}
.vig-tile img{height:auto;aspect-ratio:1/1;width:100%;object-fit:cover;display:block}
.vig-tiles[data-density="compact"] .vig-tile-sub{display:none}
.vig-tiles[data-density="compact"] .vig-tile-acts .vig-mini{width:22px;min-width:22px;height:22px}
.vig-tiles[data-density="compact"] .vig-tile-meta{padding:7px 8px 6px}
.vig-tile-meta{padding:10px 12px 9px;font-size:11px;gap:3px}
.vig-tile-name{font-size:12px;font-weight:600;letter-spacing:-.005em}
.vig-tile-sub{color:var(--vig-text-faint);letter-spacing:.02em;font-variant-numeric:tabular-nums;
	white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
/* 视图切换：网格 / 大图（大图 = 上方固定大图 + 下方缩略条按容器宽度分页） */
.vig-viewmode{display:inline-flex;align-items:center;gap:2px;padding:2px;border:1px solid var(--vig-line);
	border-radius:var(--vig-r-pill);background:var(--vig-surface-soft)}
.vig-viewmode-btn{height:24px;min-width:34px;padding:0 8px;border:0;border-radius:var(--vig-r-pill);background:transparent;
	color:var(--vig-text-muted);font-size:11px;font-weight:600;letter-spacing:.02em;
	display:inline-flex;align-items:center;justify-content:center;
	transition:background-color var(--vig-dur) var(--vig-ease),color var(--vig-dur) var(--vig-ease)}
.vig-viewmode-btn:hover{background:var(--vig-surface-sunken);color:var(--vig-text)}
.vig-viewmode-btn.is-on{background:var(--vig-accent);color:var(--vig-surface)}
.vig-stage-view{display:flex;flex-direction:column;flex:1;min-height:0;background:var(--vig-surface)}
.vig-stage-main{flex:1;min-height:0;display:flex;align-items:center;justify-content:center;padding:18px;
	background:var(--vig-surface-soft);overflow:hidden;position:relative}
/* 左右隐藏式翻页箭头：进到大图区域才显形 */
.vig-stage-nav{position:absolute;top:50%;transform:translateY(-50%);width:36px;height:56px;
	display:inline-flex;align-items:center;justify-content:center;border-radius:var(--vig-r-pill);
	border:1px solid var(--vig-line);background:var(--vig-surface);color:var(--vig-text-muted);
	opacity:0;pointer-events:none;z-index:2;box-shadow:var(--vig-sh-2);
	transition:opacity var(--vig-dur) var(--vig-ease),background-color var(--vig-dur) var(--vig-ease),color var(--vig-dur) var(--vig-ease)}
.vig-stage-nav.is-prev{left:10px}
.vig-stage-nav.is-next{right:10px}
.vig-stage-main:hover .vig-stage-nav,.vig-stage-nav:focus-visible{opacity:.94;pointer-events:auto}
.vig-stage-nav:hover{background:var(--vig-surface-sunken);color:var(--vig-text)}
.vig-stage-img{max-width:100%;max-height:100%;object-fit:contain;border-radius:8px;
	box-shadow:var(--vig-sh-2);cursor:zoom-in}
.vig-stage-bar{display:flex;align-items:center;justify-content:center;gap:12px;padding:10px 16px;
	border-top:1px solid var(--vig-line);flex:none}
.vig-stage-name{font-size:11px;font-weight:600;color:var(--vig-text-muted);max-width:160px;
	white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.vig-stage-meta{font-size:11px;color:var(--vig-text-faint);font-variant-numeric:tabular-nums;
	white-space:nowrap;overflow:hidden;text-overflow:ellipsis;max-width:240px}
/* .vig-count 原本靠 margin-left:auto 顶到右边，这里要整组居中 */
.vig-stage-bar .vig-count{margin-left:0}
.vig-stage-acts{display:inline-flex;align-items:center;gap:4px;padding-left:12px;margin-left:2px;
	border-left:1px solid var(--vig-line)}
.vig-strip{--vig-thumb-edge:64px;--vig-thumb-gap:8px;display:flex;justify-content:center;gap:var(--vig-thumb-gap);padding:10px 14px;overflow:hidden;
	border-top:1px solid var(--vig-line);flex:none;min-width:0;position:relative}
.vig-strip-item{min-width:0;height:var(--vig-thumb-edge);flex:0 1 calc((100% + var(--vig-thumb-gap)) / var(--vig-strip-cols, 1) - var(--vig-thumb-gap));padding:0;border:2px solid transparent;border-radius:10px;
	overflow:hidden;background:var(--vig-surface-sunken);cursor:pointer;
	transition:border-color var(--vig-dur) var(--vig-ease)}
.vig-strip-item img{width:100%;height:100%;object-fit:cover;display:block}
.vig-strip-item:hover{border-color:var(--vig-line-strong)}
.vig-strip-item.is-on{border-color:var(--vig-accent)}
/* 切换当前图时给选中项一个 Q 弹（reduced-motion 下由全局规则关掉） */
@keyframes vig-strip-pop{0%{transform:scale(.94)}58%{transform:scale(1.07)}100%{transform:scale(1)}}
.vig-strip-item.is-on{animation:vig-strip-pop .34s cubic-bezier(.34,1.56,.64,1)}
/* ============================================================
   设计系统 v2.8 · 信息条悬浮（不占英雄主视图空间）
   · 信息条从「占一行」改成浮在大图区底部居中的毛玻璃胶囊
   · 缩略条仍是底部独立一行（导航），--vig-strip-h 固定它的高度
   ============================================================ */
.vig-stage-view{position:relative;--vig-strip-h:85px}
.vig-stage-bar{position:absolute;left:50%;bottom:calc(var(--vig-strip-h,85px) + 12px);transform:translateX(-50%);
	z-index:3;flex:none;padding:6px 14px;border:1px solid var(--vig-line);border-radius:var(--vig-r-pill);
	background:rgba(255,255,255,.92);box-shadow:var(--vig-sh-2);max-width:calc(100% - 28px);
	-webkit-backdrop-filter:blur(12px) saturate(1.15);backdrop-filter:blur(12px) saturate(1.15);
	border-top:1px solid var(--vig-line);white-space:nowrap}
.vig-stage-bar>*{flex:none}
.vig-stage-bar .vig-count{white-space:nowrap}
.vig-stage-name{max-width:150px}
.vig-stage-meta{max-width:200px}
body[data-ds-dark-theme] .vig-stage-bar{background:rgba(20,20,22,.9);border-color:var(--vig-line)}
/* ============================================================
   设计系统 v2.10 · 局部改图（框选 / 画笔 → mask 胶囊对话）
   ============================================================ */
.vig-stage-frame{position:relative;display:inline-flex;max-width:100%;max-height:100%;line-height:0}
.vig-stage-frame img{max-width:100%;max-height:100%;display:block;border-radius:8px;box-shadow:var(--vig-sh-2)}
.vig-stage-frame img{cursor:zoom-in}
.vig-stage-view.is-painting .vig-stage-frame img{cursor:crosshair}
.vig-stage-view.is-painting .vig-stage-nav{display:none}
.vig-stage-ink{position:absolute;inset:0;width:100%;height:100%;border-radius:8px;pointer-events:none}
/* 胶囊对话：替代信息条浮在同一位置 */
.vig-mask-pill{position:absolute;left:50%;bottom:calc(var(--vig-strip-h,85px) + 12px);transform:translateX(-50%);z-index:4;
	display:flex;align-items:center;gap:6px;padding:6px 8px 6px 14px;border:1px solid var(--vig-line);
	border-radius:var(--vig-r-pill);background:rgba(255,255,255,.95);box-shadow:var(--vig-sh-2);
	-webkit-backdrop-filter:blur(12px) saturate(1.15);backdrop-filter:blur(12px) saturate(1.15);
	max-width:calc(100% - 28px);white-space:nowrap}
body[data-ds-dark-theme] .vig-mask-pill{background:rgba(20,20,22,.94)}
.vig-mask-input{border:0;outline:0;background:transparent;font-size:12.5px;min-width:200px;max-width:360px;color:var(--vig-text)}
.vig-mask-input::placeholder{color:var(--vig-text-faint)}
.vig-mask-tool{width:26px;height:26px;border-radius:var(--vig-r-pill);color:var(--vig-text-muted);
	display:inline-flex;align-items:center;justify-content:center;flex:none}
.vig-mask-tool:hover{background:var(--vig-surface-sunken);color:var(--vig-text)}
.vig-mask-send{width:30px;height:30px;border-radius:var(--vig-r-pill);background:var(--vig-accent);color:var(--vig-surface);
	display:inline-flex;align-items:center;justify-content:center;flex:none}
.vig-mask-send:disabled{opacity:.45}
.vig-brush-sizes{display:inline-flex;align-items:center;gap:2px;padding:2px;border:1px solid var(--vig-line);
	border-radius:var(--vig-r-pill);background:var(--vig-surface-soft);flex:none}
.vig-brush-size{height:22px;min-width:26px;padding:0 6px;border:0;border-radius:var(--vig-r-pill);background:transparent;
	color:var(--vig-text-muted);font-size:10.5px;font-weight:600;font-variant-numeric:tabular-nums}
.vig-brush-size:hover{background:var(--vig-surface-sunken);color:var(--vig-text)}
.vig-brush-size.is-on{background:var(--vig-accent);color:var(--vig-surface)}
/* v2.13：画笔粗细改成 1–50 滑块（原五档胶囊删掉 60/80/100） */
.vig-brush-size{display:inline-flex;align-items:center;gap:8px;padding:0 8px 0 4px;flex:none}
.vig-brush-range{width:96px;height:18px}
.vig-brush-size-val{font-size:10.5px;font-weight:600;color:var(--vig-text-muted);min-width:18px;text-align:right;
	font-variant-numeric:tabular-nums}
/* ============================================================
   设计系统 v2.12 · 结果卡动作图标化 / 输入区工具行折叠 + 无边框
   ============================================================ */
/* 结果卡：四个动作收成图标，靠右对齐 */
.vig-shot-bar{justify-content:flex-end;gap:2px;padding:4px 2px 0}
.vig-shot-bar .vig-shot-act{width:26px;min-width:26px;height:26px;padding:0;border-radius:var(--vig-r-pill);
	color:var(--vig-text-faint);display:inline-flex;align-items:center;justify-content:center;line-height:0}
.vig-shot-bar .vig-shot-act:hover{background:var(--vig-surface-sunken);color:var(--vig-text)}
/* 工具行：无边框（靠 hover 底与图标区分），次要参数收进悬浮展开器面板 */
.vig-tools .vig-sel{border-color:transparent;background:transparent;color:var(--vig-text-muted)}
.vig-tools .vig-sel:hover{background:var(--vig-surface-sunken);color:var(--vig-text)}
.vig-tools .vig-pick{border-color:transparent;background:transparent;box-shadow:none}
.vig-tools .vig-pick:hover{background:var(--vig-surface-sunken)}
.vig-tools .vig-pick.is-open{border-color:var(--vig-line);background:var(--vig-surface)}
.vig-tools .vig-count{background:transparent;padding:0 4px;color:var(--vig-text-faint)}
.vig-tools .vig-tool{color:var(--vig-text-muted)}
/* 工具行不换行：模型/尺寸可收缩，发送贴右 */
.vig-tools{position:relative;flex-wrap:nowrap}
.vig-tools .vig-picker{min-width:0;flex:0 1 auto}
.vig-tools .vig-send{margin-left:auto;flex:none;width:auto;min-width:42px;padding:0 10px;font:inherit;font-weight:600;white-space:nowrap}
.vig-tools .vig-sel{min-width:0;max-width:170px;flex:none;white-space:nowrap}
/* 展开器：一块浮在工具行上方的面板，不占行内空间（不是把按钮塞回行里） */
.vig-tools-pop{position:absolute;left:0;bottom:calc(100% + 10px);z-index:34;display:flex;flex-wrap:wrap;align-items:center;gap:8px;
	width:min(560px,100%);min-width:0;max-width:100%;padding:10px 12px;
	border:1px solid var(--vig-line);border-radius:var(--vig-r-card);background:rgba(255,255,255,.97);
	box-shadow:var(--vig-sh-2);-webkit-backdrop-filter:blur(14px) saturate(1.1);backdrop-filter:blur(14px) saturate(1.1);
	opacity:0;visibility:hidden;pointer-events:none;transform:translateY(4px);
	transition:opacity var(--vig-dur) var(--vig-ease),transform var(--vig-dur) var(--vig-ease),visibility var(--vig-dur)}
.vig-tools-pop.is-open{opacity:1;visibility:visible;pointer-events:auto;transform:none}
body[data-ds-dark-theme] .vig-tools-pop{background:rgba(20,20,22,.96)}
/* ============================================================
   设计系统 v2.18 · 更新入口（先设计，宿主未接壤）+ 按需进度条
   ============================================================ */
.vig-update{display:flex;flex-direction:column;gap:6px;padding:10px 2px 2px}
.vig-update-row{display:flex;align-items:center;gap:8px;min-width:0;flex-wrap:wrap;overflow:visible;row-gap:2px}
.vig-update-btn{display:inline-flex;align-items:center;gap:6px;height:24px;padding:0 9px;border-radius:var(--vig-r-pill);flex:none;white-space:nowrap;font-size:11px;
	border:1px solid var(--vig-line);background:var(--vig-surface);color:var(--vig-text);font-size:11.5px;font-weight:500;
	transition:background-color var(--vig-dur) var(--vig-ease),border-color var(--vig-dur) var(--vig-ease)}
.vig-update-btn:hover{background:var(--vig-surface-sunken);border-color:var(--vig-line-strong)}
.vig-update-btn:disabled{opacity:.6;cursor:default}
.vig-update-btn.is-busy svg{animation:vig-update-spin 900ms linear infinite}
@keyframes vig-update-spin{to{transform:rotate(360deg)}}
.vig-update-tag{flex:none;font-size:10px;letter-spacing:0;color:var(--vig-text-muted);
	white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.vig-update-bar{order:-1;height:3px;border-radius:var(--vig-r-pill);background:var(--vig-surface-sunken);overflow:hidden;margin:0 2px 6px}
.vig-update-bar>i{display:block;height:100%;width:0;background:var(--vig-accent);transition:width 260ms var(--vig-ease)}
.vig-update-bar.is-err>i{background:var(--vig-danger)}
.vig-update-bar.is-ok>i{background:var(--vig-ok)}
.vig-root[data-compact="1"] .vig-update{padding:0;justify-content:center}
.vig-root[data-compact="1"] .vig-update-tag{display:none}
/* ============================================================
   设计系统 v2.19 · 上下文管理「对话式」浮层
   ============================================================ */
.vig-ctx-wrap{position:static;display:inline-flex}
.vig-ctx-pop{position:absolute;left:0;bottom:calc(100% + 10px);z-index:38;width:min(360px,100%);
	display:flex;flex-direction:column;gap:10px;padding:14px 16px;border:1px solid var(--vig-line);
	border-radius:var(--vig-r-card);background:rgba(255,255,255,.97);box-shadow:var(--vig-sh-2);
	-webkit-backdrop-filter:blur(14px) saturate(1.1);backdrop-filter:blur(14px) saturate(1.1)}
body[data-ds-dark-theme] .vig-ctx-pop{background:rgba(20,20,22,.96)}
.vig-ctx-head{display:flex;flex-direction:column;gap:3px}
.vig-ctx-title{font-size:12.5px;font-weight:650;letter-spacing:-.01em}
.vig-ctx-note{font-size:11px;color:var(--vig-text-faint);line-height:1.5}
.vig-ctx-row{display:flex;align-items:center;gap:8px;font-size:12px;color:var(--vig-text)}
.vig-ctx-row.is-wired{font-size:10.5px;color:var(--vig-text-faint);letter-spacing:.02em;padding-top:8px;border-top:1px dashed var(--vig-line)}
.vig-ctx-check{width:14px;height:14px;accent-color:var(--vig-accent);flex:none}
.vig-ctx-label{color:var(--vig-text-muted);flex:none;font-size:11.5px}
.vig-ctx-range{flex:1;min-width:80px}
.vig-ctx-val{font-size:11px;font-weight:600;font-variant-numeric:tabular-nums;min-width:18px;text-align:right}
.vig-ctx-hot{flex-wrap:wrap}
.vig-ctx-hint{flex-basis:100%;font-size:10.5px;color:var(--vig-text-faint);padding-left:22px}
.vig-ctx-select{flex:1;min-width:0;height:26px;border:1px solid var(--vig-line);border-radius:var(--vig-r-pill);padding:0 8px;background:var(--vig-surface);font-size:11.5px;color:var(--vig-text)}
/* 进行中：三点跳动（用户发送后立刻看得见「在跑」，agent/生图都可能几十秒） */
.vig-typing{display:inline-flex;align-items:center;gap:4px;height:22px}
.vig-typing span{width:5px;height:5px;border-radius:50%;background:var(--vig-text-faint);animation:vig-typing 1.2s infinite ease-in-out}
.vig-typing span:nth-child(2){animation-delay:.15s}
.vig-typing span:nth-child(3){animation-delay:.3s}
@keyframes vig-typing{0%,60%,100%{opacity:.35;transform:translateY(0)}30%{opacity:1;transform:translateY(-2px)}}
@media (prefers-reduced-motion:reduce){.vig-typing span{animation:none;opacity:.6}}
/* ============================================================
   设计系统 v2.25 · 「回到底部」浮标（上翻历史时出现）
   ============================================================ */
.vig-bottom-dock{position:sticky;bottom:8px;display:flex;align-items:flex-end;justify-content:flex-end;height:0;z-index:7;pointer-events:none}
.vig-root[data-compact="1"] .vig-main-body.vig-chat-feed{flex:0 1 auto;min-height:128px;height:clamp(180px,calc(var(--vig-host-height,100vh)*.47),600px);overflow:auto;scrollbar-gutter:stable}
.vig-root[data-compact="1"] .vig-col:has(.vig-chat-feed){flex:0 0 auto!important}
.vig-bottom-jump{pointer-events:auto;display:inline-flex;align-items:center;gap:6px;height:32px;padding:0 12px;
	border-radius:var(--vig-r-pill);border:1px solid var(--vig-line);background:rgba(255,255,255,.94);
	-webkit-backdrop-filter:blur(10px);backdrop-filter:blur(10px);box-shadow:var(--vig-sh-2);
	color:var(--vig-text);font-size:12px;font-weight:500;cursor:pointer;transform:translateY(4px);
	transition:background-color var(--vig-dur) var(--vig-ease),transform var(--vig-dur) var(--vig-ease)}
.vig-bottom-jump:hover{background:var(--vig-surface-sunken)}
.vig-bottom-jump-count{min-width:18px;height:18px;padding:0 5px;border-radius:var(--vig-r-pill);background:var(--vig-accent);
	color:#fff;font-size:10px;font-weight:650;display:inline-flex;align-items:center;justify-content:center;
	font-variant-numeric:tabular-nums;line-height:1}
	color:#fff;font-size:10px;font-weight:650;display:inline-flex;align-items:center;justify-content:center;
	font-variant-numeric:tabular-nums;line-height:1}
body[data-ds-dark-theme] .vig-bottom-jump{background:rgba(26,26,28,.94);border-color:var(--vig-line-strong)}
@media (prefers-reduced-motion: reduce){.vig-bottom-jump{transition:none;transform:none}}
/* 更新入口与统计一起贴底：更新块吃掉 nav 剩余的 auto 空白，统计紧跟它 */
.vig-update{margin-top:auto}
.vig-nav-foot{margin-top:0!important;padding-top:8px;border-top:1px solid var(--vig-line)}
.vig-tools-pop .vig-note-pick{position:relative}
/* 模型下拉：抬到最上层、向上弹、限高滚动 —— 别被行内其它元素压住/裁掉 */
.vig-tools .vig-picker{z-index:36}
.vig-tools .vig-pop{z-index:40;right:auto;left:0;width:min(320px,calc(100vw - 56px));max-height:min(46vh,420px)}
/* ============================================================
   设计系统 v2.7 · 顶栏贴合任务窗口
   · 顶栏压到 34px、与内容零间隙（不再单独占一条厚卡片）
   · 状态胶囊收成圆点（文字进 tooltip），右侧图标更纤细
   ============================================================ */
.vig-root{gap:0}
.vig-head{height:34px;padding:0 12px;gap:8px;border:0;border-bottom:1px solid var(--vig-line);
	border-radius:0;box-shadow:none;background:var(--vig-surface)}
.vig-head .vig-mark{width:22px;height:22px;border-radius:7px}
.vig-head .vig-mark svg{width:12px;height:12px}
.vig-head .vig-title{font-size:13.5px;font-weight:650;letter-spacing:-.01em}
.vig-head .vig-ic{stroke-width:1.05}
.vig-head .vig-icon-btn{width:26px;height:26px}
.vig-head .vig-pill{width:20px;height:20px;min-width:20px;padding:0;font-size:0;gap:0;justify-content:center;border-radius:var(--vig-r-pill)}
.vig-head .vig-pill .vig-dot{width:7px;height:7px}
.vig-shell{padding-top:10px}
/* 刊头：logo 20 + 标题 13.5/650 + STUDIO kicker，右侧细图标——像书刊的刊头行 */
.vig-head{height:36px;padding:0 14px;gap:9px}
.vig-head .vig-mark{width:20px;height:20px;border-radius:6px}
.vig-head .vig-mark svg{width:11px;height:11px}
.vig-head .vig-title{font-size:13.5px;font-weight:650;letter-spacing:-.015em}
.vig-kicker{font-size:9.5px;font-weight:600;letter-spacing:.16em;text-transform:uppercase;
	color:var(--vig-text-faint);padding-left:2px;align-self:center;margin-top:1px}
.vig-head .vig-icon-btn{width:24px;height:24px}
.vig-head .vig-pill{width:18px;height:18px;min-width:18px}
.vig-tile-acts{display:flex;align-items:center;gap:2px;margin-top:4px}
.vig-tile-acts .vig-mini{width:24px;min-width:24px;height:24px;padding:0;color:var(--vig-text-faint)}
.vig-tile-acts .vig-mini:hover{background:var(--vig-surface-sunken);color:var(--vig-text)}
.vig-empty{padding:20px 16px}
.vig-hint-title{font-size:15px;font-weight:600;color:var(--vig-text)}
.vig-head .vig-title{font-size:16px;font-weight:650;letter-spacing:-.01em}
/* 截图驱动的结果节点只是数据载体，不参与视觉 */
#vig-viewer-out{position:fixed;left:-9999px;top:0;width:1px;height:1px;overflow:hidden}
/* ============================================================
   设计系统 v2.27 · 图片处理 · 图层控制条（画布下方横排）
   ============================================================ */
.vig-ps{grid-template-rows:auto auto}
.vig-ps-tools{grid-column:1;grid-row:1}
.vig-ps-stage{grid-column:2;grid-row:1}
.vig-ps-layers{grid-column:3;grid-row:1}
/* 右侧收纳：整块图层面板可收起，第三列归零，留一个浮动按钮叫回来 */
.vig-ps{position:relative}
.vig-ps[data-layers="0"]{--vig-layers-col:0px}
.vig-ps-layers.is-collapsed{display:none}
.vig-ps-aside-toggle{position:absolute;right:10px;top:12px;z-index:6;width:30px;height:30px;border-radius:50%;border:1px solid var(--vig-line);background:var(--vig-surface);color:var(--vig-text-muted);display:inline-flex;align-items:center;justify-content:center;cursor:pointer;box-shadow:0 2px 10px rgba(0,0,0,.08);transition:color var(--vig-dur) var(--vig-ease),border-color var(--vig-dur) var(--vig-ease)}
.vig-ps-aside-toggle:hover{color:var(--vig-text);border-color:var(--vig-line-strong)}
.vig-root[data-compact="1"] .vig-ps-tools,
.vig-root[data-compact="1"] .vig-ps-stage,
.vig-root[data-compact="1"] .vig-ps-layers,
.vig-root[data-compact="1"] .vig-ps-layerbar{grid-column:auto;grid-row:auto}
.vig-ps-layerbar{grid-column:1 / -1;grid-row:2;position:sticky;bottom:8px;z-index:3;display:flex;align-items:stretch;gap:8px;padding:10px 12px;
	border:1px solid var(--vig-line);border-radius:var(--vig-r-card);background:var(--vig-surface);
	overflow-x:auto;overflow-y:hidden;min-height:84px;scrollbar-width:thin}
.vig-ps-chip{position:relative;display:flex;flex-direction:column;gap:4px;width:78px;flex:none;padding:4px;
	border:1px solid var(--vig-line);border-radius:var(--vig-r-tile);background:var(--vig-surface-sunken);cursor:pointer;
	transition:border-color var(--vig-dur) var(--vig-ease),box-shadow var(--vig-dur) var(--vig-ease)}
.vig-ps-chip:hover{border-color:var(--vig-line-strong)}
.vig-ps-chip.is-on{border-color:var(--vig-accent);box-shadow:0 0 0 2px var(--vig-accent-soft)}
.vig-ps-chip.is-hidden .vig-ps-chip-thumb{opacity:.35}
.vig-ps-chip.is-dragging{opacity:.5}
.vig-ps-chip.is-editing{outline:1px dashed var(--vig-accent);outline-offset:2px}
.vig-ps-chip-thumb{width:100%;height:52px;object-fit:cover;border-radius:8px;background:var(--vig-surface-sunken);display:block}
.vig-ps-chip-name{font-size:10.5px;color:var(--vig-text-muted);white-space:nowrap;overflow:hidden;text-overflow:ellipsis;text-align:center}
.vig-ps-chip.is-base .vig-ps-chip-name{color:var(--vig-text)}
.vig-ps-chip-eye,.vig-ps-chip-x{position:absolute;top:-6px;width:16px;height:16px;border-radius:999px;
	border:1px solid var(--vig-line);background:var(--vig-surface);color:var(--vig-text-muted);display:flex;
	align-items:center;justify-content:center;padding:0;opacity:0;transition:opacity var(--vig-dur) var(--vig-ease)}
.vig-ps-chip-eye{left:-6px}
.vig-ps-chip-x{right:-6px}
.vig-ps-chip:hover .vig-ps-chip-eye,.vig-ps-chip:hover .vig-ps-chip-x,
.vig-ps-chip.is-on .vig-ps-chip-eye,.vig-ps-chip.is-on .vig-ps-chip-x{opacity:1}
.vig-ps-chip-x:hover{color:var(--vig-danger);border-color:var(--vig-danger)}
.vig-ps-chip.is-add{width:auto;min-width:64px;align-items:center;justify-content:center;gap:6px;color:var(--vig-text-muted);
	font-size:11px;border-style:dashed;flex-direction:row}
.vig-ps-chip.is-add:hover{color:var(--vig-text);border-color:var(--vig-line-strong)}
/* 选中图层的属性条：控制条自洽（叠加算法 / 不透明度 / 顺序 / 蒙版 / 编辑 / 删除） */
.vig-ps-chipprops{display:flex;align-items:center;gap:10px;flex:none;margin-left:auto;padding-left:12px;border-left:1px solid var(--vig-line)}
.vig-ps-chipprops-name{font-size:11px;color:var(--vig-text);max-width:96px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.vig-ps-chipprops-row{display:flex;align-items:center;gap:6px;font-size:11px;color:var(--vig-text-muted);white-space:nowrap}
.vig-ps-chipprops-row select{height:24px;border:1px solid var(--vig-line);border-radius:var(--vig-r-pill);padding:0 8px;background:var(--vig-surface);font-size:11px;color:var(--vig-text)}
.vig-ps-chipprops-row .vig-ps-layer-opacity{width:72px}
.vig-ps-chipprops-val{font-size:10.5px;font-variant-numeric:tabular-nums;color:var(--vig-text-muted);min-width:30px}
/* 右栏图层列表默认收起：图层操作走底部控制条，展开才看叠加算法/不透明度等高级项 */
.vig-ps-layers.is-fold .vig-ps-layer-row{display:none}
/* 按面板内可分配的空间伸缩，不缩放文字或画布像素。 */
.vig-root[data-compact="0"] .vig-nav{width:clamp(100px,14%,168px)}
.vig-root[data-compact="0"] .vig-side:not(.is-collapsed){width:clamp(152px,22%,268px)}
.vig-tools{flex-wrap:wrap}
.vig-tools-pop .vig-note-pick{position:static}
.vig-note-pop{max-width:100%}
.vig-ps-host{container:vig-editor / inline-size}
.vig-ps-host .vig-ps-stage{min-height:clamp(180px,calc(var(--vig-host-height,100vh)*.56),720px)}
.vig-ps-params.vig-ps-float{top:clamp(0px,var(--vig-float-y),max(0px,100% - 100px));right:auto;left:clamp(0px,var(--vig-float-x),max(0px,100% - var(--vig-float-w)));max-height:calc(100% - clamp(0px,var(--vig-float-y),max(0px,100% - 100px)))}
.vig-ps-params.vig-ps-float.is-collapsed{width:auto;left:auto;right:0}
/* 外层仍能三列时，编辑器自身也可能只剩 400px。此时参数进入文档流，不覆盖取点区。 */
@container vig-editor (max-width: 720px){
 .vig-root .vig-ps{grid-template-columns:minmax(0,1fr);grid-template-rows:auto;gap:8px;padding:8px}
 .vig-root .vig-ps>.vig-ps-tools{grid-area:1/1;flex-direction:row;flex-wrap:nowrap;overflow-x:auto;min-width:0}
 .vig-root .vig-ps-tools-toggle{display:none}
 .vig-root .vig-ps .vig-ps-tool{flex:0 0 auto;flex-direction:row;padding:6px 8px;min-height:32px}
 .vig-root .vig-ps>.vig-ps-stage{grid-area:2/1;width:100%;min-width:0;min-height:clamp(160px,min(60cqw,calc(var(--vig-host-height,100vh)*.44)),360px)}
 .vig-root .vig-ps>.vig-ps-params{grid-area:3/1;position:static;width:100%;max-width:100%;max-height:none}
 .vig-root .vig-ps>.vig-ps-params.is-collapsed{width:100%;border-radius:12px}
 .vig-root .vig-ps-params-open{flex-direction:row;justify-content:center;width:100%}
 .vig-root .vig-ps-params-open span{writing-mode:horizontal-tb}
 .vig-root .vig-ps>.vig-ps-layerbar{grid-area:4/1;position:static;min-width:0}
 .vig-root .vig-ps>.vig-ps-layers{grid-area:5/1;min-width:0}
 .vig-root .vig-ps-aside-toggle{position:static;grid-area:5/1;justify-self:end}
 .vig-ps-params-head{cursor:default!important;touch-action:auto!important}
}
.vig-json-modal{width:min(560px,100%);max-height:min(90dvh,100%)}
/* 表单、图库和管理列表按工作区本身重排；查看器仍是独立全屏工具。 */
.vig-dialog-frame{box-sizing:border-box;inset:auto;margin:0;border:0;max-width:none;max-height:none;color:var(--vig-text);padding:clamp(6px,2%,18px);overflow:hidden}
.vig-viewer.vig-dialog-frame{container:vig-viewer / inline-size}
.vig-viewer.vig-dialog-frame .vig-viewer-body{max-height:100%;min-width:0}
.vig-viewer-body .vig-viewer-stage{min-height:0}
.vig-viewer-body .vig-viewer-foot{max-height:32%;overflow:auto}
@container vig-viewer (max-width:600px){.vig-viewer-head{flex-wrap:wrap;gap:4px}.vig-viewer-title{max-width:100%}.vig-viewer-head .vig-spacer{flex-basis:100%;height:0}}
.vig-dialog-frame .vig-toasts{position:absolute;top:6px;max-width:calc(100% - 12px);pointer-events:none}
.vig-dialog-frame[data-anchored]{top:max(0px,anchor(top));left:max(0px,anchor(left));right:max(0px,anchor(right));bottom:max(0px,anchor(bottom));width:auto;height:auto;align-self:stretch;justify-self:stretch}
.vig-dialog-frame::backdrop{background:transparent}
.vig-dialog-frame>.vig-modal{min-width:0;max-width:100%;max-height:100%;overscroll-behavior:contain}
.vig-dialog-frame>.vig-modal>*{flex-shrink:0}
.vig-dialog-frame label,.vig-dialog-frame input,.vig-dialog-frame textarea{min-width:0;max-width:100%}
.vig-grid-editor{container:vig-grid-panel / inline-size;width:min(1040px,100%);padding:0;gap:0;color:var(--vig-text);isolation:isolate}
.vig-grid-editor :is(h2,h3,p,figure){margin:0}.vig-grid-editor h2{font:600 18px/1.35 var(--vig-font);letter-spacing:-.02em}.vig-grid-editor h3{font:600 14px/1.4 var(--vig-font)}
.vig-grid-head,.vig-grid-foot{display:flex;align-items:center;justify-content:space-between;gap:12px;padding:14px 20px}.vig-grid-head{border-bottom:1px solid var(--vig-line)}
.vig-grid-ident,.vig-grid-line,.vig-grid-foot-actions{display:flex;align-items:center;flex-wrap:wrap;gap:8px;min-width:0}.vig-grid-ident{gap:12px;flex:1;flex-wrap:nowrap}.vig-grid-ident>div{min-width:0}.vig-grid-symbol{flex:none;display:grid;place-items:center;width:38px;height:38px;background:var(--vig-accent);color:var(--vig-surface);border-radius:12px}
.vig-grid-editor .vig-muted,.vig-grid-note{color:var(--vig-text-muted);font:400 12px/1.55 var(--vig-font);overflow-wrap:anywhere}.vig-grid-head .vig-icon-btn{width:36px;height:36px;flex:none}
.vig-grid-workarea{display:grid;grid-template-columns:minmax(0,1fr);align-items:start;gap:20px;padding:18px 20px}.vig-grid-workarea>section{min-width:0}.vig-grid-preview,.vig-grid-inspector,.vig-grid-form,.vig-grid-review{display:grid;gap:12px;align-content:start}
.vig-grid-subhead{display:flex;align-items:center;justify-content:space-between;gap:8px;flex-wrap:wrap}.vig-grid-editor label{display:inline-flex;align-items:center;gap:6px;font-size:13px}.vig-grid-editor .vig-sel{width:auto;max-width:100%;height:34px;color:var(--vig-text);background-color:var(--vig-surface);border-color:var(--vig-line-strong)}
.vig-grid-board{display:grid;place-items:center;min-height:90px;padding:8px;background:var(--vig-surface-sunken);border:1px solid var(--vig-line);border-radius:var(--vig-r-tile)}
.vig-grid-stage{position:relative;min-width:0;max-width:100%;overflow:hidden;border-radius:5px}.vig-grid-raster,.vig-grid-raster canvas{display:block;width:100%;height:100%}
.vig-grid-overlay{position:absolute;display:block;object-fit:cover;pointer-events:none;background:var(--vig-surface-sunken)}
.vig-grid-editor .vig-grid-region{position:absolute;box-sizing:border-box;display:flex;align-items:flex-start;justify-content:flex-start;padding:0;background:transparent;border:0;border-radius:0;box-shadow:inset 0 0 0 1px #ffffff99;cursor:pointer}
.vig-grid-editor .vig-grid-region[aria-pressed=true]{box-shadow:inset 0 0 0 3px #00886a,inset 0 0 0 4px #fff;z-index:1}.vig-grid-region span{display:inline-flex;align-items:center;gap:2px;margin:4px;padding:1px 6px;border-radius:5px;color:#fff;background:#172026d9;font-size:11px;line-height:1.6;pointer-events:none}.vig-grid-region[aria-pressed=true] span{background:#045e49}
.vig-grid-editor .vig-grid-region:focus-visible{outline:2px dashed white;outline-offset:-6px}.vig-grid-editor :is(.vig-btn,.vig-sel,.vig-input,.vig-icon-btn):focus-visible{outline:2px solid var(--vig-text);outline-offset:2px}
.vig-grid-inspector{border:1px solid var(--vig-line);background:var(--vig-surface-soft);border-radius:var(--vig-r-tile);padding:16px}.vig-grid-target{padding-bottom:12px;border-bottom:1px solid var(--vig-line);display:grid;gap:8px}.vig-grid-cell-meta{display:flex;align-items:center;justify-content:space-between;gap:6px;flex-wrap:wrap}.vig-grid-field{display:grid!important;gap:5px!important;font-weight:500}.vig-grid-field .vig-sel{width:100%}
.vig-grid-editor textarea.vig-input{display:block;width:100%;min-height:76px;resize:vertical;padding:9px 11px;border:1px solid var(--vig-line-strong);border-radius:9px;background:var(--vig-surface);color:var(--vig-text)}
.vig-grid-editor .vig-btn{min-height:34px;height:auto;padding:6px 11px;line-height:1.35;white-space:normal}.vig-grid-inspector .is-primary{min-height:38px;flex:1}.vig-grid-actions{display:flex;gap:8px;flex-wrap:wrap}
.vig-grid-review-body{display:flex;align-items:center;gap:10px;min-width:0}.vig-grid-candidate{width:auto;height:auto;max-width:38%;max-height:96px;object-fit:cover;border-radius:7px}.vig-grid-summary{color:var(--vig-text);overflow-wrap:anywhere;white-space:pre-wrap;font-size:13px;max-height:7em;overflow:auto}.vig-grid-preview-meta{display:flex;align-items:center;justify-content:space-between;gap:8px;flex-wrap:wrap}
.vig-grid-preview-meta [aria-pressed=true]{background:var(--vig-accent);border-color:var(--vig-accent);color:var(--vig-surface)}
.vig-grid-status{font-size:12px;line-height:1.5;color:var(--vig-text-muted)}.vig-grid-foot{border-top:1px solid var(--vig-line);flex-wrap:wrap;background:var(--vig-surface-soft)}.vig-grid-foot-actions{gap:6px}.vig-grid-editor .vig-grid-foot .vig-btn{background:var(--vig-surface)}
@container vig-grid-panel (min-width:720px){.vig-grid-workarea{grid-template-columns:minmax(0,1fr) minmax(258px,31%);gap:18px}}
@container vig-grid-panel (max-width:440px){.vig-grid-head,.vig-grid-workarea,.vig-grid-foot{padding:12px}.vig-grid-workarea{gap:12px}.vig-grid-inspector{padding:12px}.vig-grid-editor .vig-btn,.vig-grid-editor .vig-sel,.vig-grid-head .vig-icon-btn{min-height:40px}.vig-grid-foot-actions{width:100%}.vig-grid-foot-actions .vig-btn{flex:1 1 auto}}
.vig-dialog-frame .vig-modal-title,.vig-prov-test,.vig-item-title,.vig-tag,.vig-block .vig-muted{overflow-wrap:anywhere}
.vig-item-head{flex-wrap:wrap}.vig-item-head .vig-tag{max-width:100%}
.vig-root{container:vig-workbench / inline-size}
/* 主布局只看宿主宽度；不等 ResizeObserver / React 下一帧才给窄栏腾位置。 */
@container vig-workbench (width < 660px){
 .vig-root .vig-shell{flex-direction:column;gap:10px}
 .vig-root .vig-shell>.vig-nav{width:auto;flex:none;flex-flow:row wrap;gap:2px;padding:5px}
 .vig-root .vig-nav-item{width:auto;flex:none;height:auto;padding:7px 10px}
 .vig-nav .vig-conv-tabs{flex:0 0 100%;order:1;flex-wrap:nowrap;overflow-x:auto;overflow-y:hidden;max-width:100%;box-sizing:border-box;margin:2px 0 0;padding:4px 2px 1px;border-inline-start:0;border-top:1px solid var(--vig-line)}
 .vig-root .vig-nav-foot{display:none}
 .vig-root .vig-shell>.vig-side:not(.is-collapsed){width:auto;flex:none}
 .vig-root .vig-main-head{flex-wrap:wrap}
}
.vig-main{container:vig-page / inline-size}
@container vig-page (max-width: 580px){
 .vig-main-head{flex-wrap:wrap;gap:5px 8px;padding:8px 10px}
 .vig-toolbar{gap:5px 8px;padding:8px 10px}.vig-toolbar .vig-in{max-width:100%}
 .vig-prov{flex-direction:column;align-items:stretch}.vig-prov-acts{margin-left:0;justify-content:flex-start}
 .vig-prov-name,.vig-prov-line{overflow-wrap:anywhere}.vig-prov-acts .vig-btn{flex-shrink:0}
 .vig-stage-view{min-height:clamp(290px,calc(var(--vig-host-height,100vh)*.68),520px)}
 .vig-stage-view .vig-stage-main{padding:6px;min-height:140px;flex-direction:column}
 .vig-stage-frame{min-height:0;flex:0 1 auto}.vig-stage-view.is-painting .vig-stage-frame{max-height:calc(100% - 66px)}
 .vig-stage-bar,.vig-mask-pill{position:static;transform:none;align-self:stretch;max-width:100%;margin:4px;flex-wrap:wrap;justify-content:flex-start;border-radius:var(--vig-r-tile);padding:4px 8px;gap:4px}
 .vig-stage-bar .vig-stage-name,.vig-stage-bar .vig-stage-meta{flex:1 1 80px;min-width:0}.vig-stage-acts{max-width:100%;flex-wrap:wrap;padding-left:0;border-left:0}
 .vig-mask-input{flex:1 1 100px;min-width:64px;max-width:100%}.vig-mask-pill .vig-brush-range{width:64px}
 .vig-strip{--vig-thumb-edge:48px;padding:5px 8px}
}
.vig-tiles[data-density="large"]{grid-template-columns:repeat(auto-fill,minmax(min(100%,240px),1fr))}
@media (hover:none){.vig-stage-nav{opacity:1;pointer-events:auto}.vig-stage-view.is-painting .vig-stage-nav{display:none}}
.vig-json-editor{box-sizing:border-box;width:100%;height:clamp(100px,36dvh,320px);max-height:56dvh;font:12px ui-monospace,monospace;resize:vertical}

`;

		/* ------------------------------------------------------------------ *
		 * 图标：16px 线性图标，自持，不依赖宿主 icon 包
		 * ------------------------------------------------------------------ */

		const ICONS = {
			spark: "M8 1.6l1.5 4.2L13.7 7.3l-4.2 1.5L8 13l-1.5-4.2L2.3 7.3l4.2-1.5z",
			chat: "M2.6 3.4h10.8v7.2H7.4L4.3 13v-2.4H2.6z",
			image: "M2.4 3.2h11.2v9.6H2.4zM2.4 10l3.2-3 2.6 2.4 2.4-2.2 3 2.8",
			note: "M4 2.4h8v11.2H4zM6 5.4h4M6 8h4M6 10.6h2.6",
			provider: "M8 2.6a2 2 0 1 1 0 4 2 2 0 0 1 0-4zM3.2 13.4c0-2.4 2.1-3.8 4.8-3.8s4.8 1.4 4.8 3.8",
			plus: "M8 3.6v8.8M3.6 8h8.8",
			upload: "M8 11.4V4.2M5 7.2L8 4.2l3 3M3 12.6h10",
			send: "M3 8l10-4.6L10.6 13 8 9.6 3 8z",
			close: "M4.2 4.2l7.6 7.6M11.8 4.2l-7.6 7.6",
			chevron: "M5.6 3.8L9.8 8l-4.2 4.2",
			chevronDown: "M3.8 5.8L8 10l4.2-4.2",
			refresh: "M13 8a5 5 0 1 1-1.6-3.7M13 2.6V5.4h-2.8",
			/* 电源符号：重载整个界面（桌面端没绑 Ctrl+R，也没有菜单项） */
			reboot: "M8 2.6a5.4 5.4 0 1 0 5.4 5.4M8 2.6v5.2",
			check: "M3.4 8.4l3 3 6-6.4",
			trash: "M3.6 5h8.8M6.4 5V3.6h3.2V5M5 5l.6 8h4.8L11 5",
			link: "M6.6 9.4a2.6 2.6 0 0 0 3.7 0l1.8-1.8a2.6 2.6 0 0 0-3.7-3.7l-.7.7M9.4 6.6a2.6 2.6 0 0 0-3.7 0L3.9 8.4a2.6 2.6 0 0 0 3.7 3.7l.7-.7",
			copy: "M5.4 5.4h6.2v6.2H5.4zM3.4 10.6V3.4h7.2",
			external: "M9.4 3.4h3.2v3.2M12.6 3.4L7.8 8.2M11 9.8v2.8H3.4V5h2.8",
			open: "M8.6 3.4h4v4M12.6 3.4L8.2 7.8M11.4 9.6v3H3.4v-8h3",
			edit: "M3.4 12.6l.4-2.6 6.6-6.6 2.2 2.2-6.6 6.6z",
			grid: "M3 3h4.2v4.2H3zM8.8 3H13v4.2H8.8zM3 8.8h4.2V13H3zM8.8 8.8H13V13H8.8z",
			/* 工具箱：选框 / 裁切 / 旋转 / 水平 / 扩边 / 羽化 / 缩放 / 翻转 / 撤销重做 */
			pen: "M3.2 12.8l1-3.1 6.4-6.4 2.1 2.1-6.4 6.4-3.1 1z",
			marquee: "M3 4.4V3.8A.8.8 0 0 1 3.8 3H4.4M6.6 3H8M10.2 3h.6a.8.8 0 0 1 .8.8v.6M13 6.6V8M13 10.2v.6a.8.8 0 0 1-.8.8h-.6M10.2 13H8M6.6 13H4.4a.8.8 0 0 1-.8-.8v-.6M3 10.2V8M3 6.6V6",
			crop: "M5 2.6v8.8h8.8M2.6 5H11v8.4",
			scissors: "M4.6 4.2a1.6 1.6 0 1 0 0 3.2 1.6 1.6 0 0 0 0-3.2zM4.6 8.6a1.6 1.6 0 1 0 0 3.2 1.6 1.6 0 0 0 0-3.2zM6.2 8.8L13 3.6M6.2 7.3L13 12.4",
			rotate: "M13 8a5 5 0 1 1-1.6-3.7M13 2.6V5.4h-2.8M8 5.4v5.2M5.6 8h4.8",
			level: "M2.6 12.4h10.8M4.8 12.4L12 5.6M9.6 12.4a6.4 6.4 0 0 0 1.4-2.6",
			/* 透视矫正：一个被拉歪的四边形（四个角就是可拖的点） */
			warp: "M3 5.6L8.6 3H13v7.4L7.4 13H3z",
			expand: "M3 6V3.8A.8.8 0 0 1 3.8 3H6M10 3h2.2a.8.8 0 0 1 .8.8V6M13 10v2.2a.8.8 0 0 1-.8.8H10M6 13H3.8a.8.8 0 0 1-.8-.8V10M6.4 6.4h3.2v3.2H6.4z",
			feather: "M3.4 12.6C3.4 7 6.6 3.4 12.6 3.4c-.6 5.6-4 8.2-9.2 9.2zM6.4 10.6c1.4-.6 2.6-1.8 3.2-3.2",
			flip: "M8 2.6v10.8M3 5.2h3.2v5.6H3zM9.8 5.2H13v5.6H9.8z",
			scale: "M3 13L13 3M3 9.4V13h3.6M13 6.6V3H9.4",
			undo: "M5.6 6.4h4.2a3.2 3.2 0 0 1 0 6.4H6M5.6 6.4L8 4M5.6 6.4L8 8.8",
			redo: "M10.4 6.4H6.2a3.2 3.2 0 0 0 0 6.4H10M10.4 6.4L8 4M10.4 6.4L8 8.8",
			resize: "M3.4 3.4h9.2v9.2zM10.6 3.4v9.2M3.4 10.6h9.2",
			/* 素材目录 / 查看器：文件夹、左右翻页、缩放、适应、下载、平移 */
			folder: "M2.4 4.2h4.2l1.1 1.6h5.9v6.6H2.4zM2.4 4.2V3.2h4.2v1",
			chevronLeft: "M10.4 3.8L6.2 8l4.2 4.2",
			zoomIn: "M7.2 3.6a3.6 3.6 0 1 0 0 7.2 3.6 3.6 0 0 0 0-7.2zM10 10l3.4 3.4M7.2 5.7v3M5.7 7.2h3",
			zoomOut: "M7.2 3.6a3.6 3.6 0 1 0 0 7.2 3.6 3.6 0 0 0 0-7.2zM10 10l3.4 3.4M5.7 7.2h3",
			fit: "M3.4 6V3.4H6M10 3.4h2.6V6M12.6 10v2.6H10M6 12.6H3.4V10",
			download: "M8 2.6v7.4M5 7.2L8 10l3-2.8M3 12.6h10",
			move: "M8 2.4v11.2M2.4 8h11.2M8 2.4L6.2 4.2M8 2.4l1.8 1.8M8 13.6l-1.8-1.8M8 13.6l1.8-1.8M2.4 8l1.8-1.8M2.4 8l1.8 1.8M13.6 8l-1.8-1.8M13.6 8l-1.8 1.8"
		};

		/** 「开始页」那张卡的图标：宿主的 EntryBox 以 <Icon size={…} className={…} /> 调用它。 */
		function GuideIcon({ size = 24, className }) {
			return h(Icon, { name: "spark", size, className });
		}

		function Icon({ name, size = 16, className }) {
			const path = ICONS[name] ?? ICONS.spark;
			return h(
				"svg",
				{
					className: className ?? "vig-ic",
					width: size,
					height: size,
					viewBox: "0 0 16 16",
					fill: "none",
					stroke: "currentColor",
					strokeWidth: 1.4,
					strokeLinecap: "round",
					strokeLinejoin: "round",
					"aria-hidden": "true"
				},
				h("path", { d: path })
			);
		}

		/* ------------------------------------------------------------------ *
		 * 数据层
		 * ------------------------------------------------------------------ */

		async function call(path, options) {
			const init = Object.assign({ cache: "no-store", credentials: "same-origin" }, options || {});
			if (init.body !== undefined && typeof init.body !== "string") {
				init.headers = Object.assign({ "content-type": "application/json" }, init.headers || {});
				init.body = JSON.stringify(init.body);
			}
			const response = await fetch(`${API}${path}`, init);
			const text = await response.text();
			let payload = null;
			try {
				payload = text.length > 0 ? JSON.parse(text) : null;
			} catch {
				throw new Error(`${response.status} 非 JSON 响应：${text.slice(0, 120)}`);
			}
			if (!response.ok) throw new Error(payload?.error || `HTTP ${response.status}`);
			return payload;
		}

		/** 把 File 读成 data URL，供上传与图生图共用。 */
		function fileToDataUrl(file) {
			return new Promise((resolve, reject) => {
				const reader = new FileReader();
				reader.onload = () => resolve(String(reader.result));
				reader.onerror = () => reject(new Error("读取文件失败"));
				reader.readAsDataURL(file);
			});
		}

		/**
		 * 从剪贴板里挑出图片：优先 `items`（Chrome/Edge/Safari 从截图工具、网页图片、
		 * 文件管理器复制过来的都在这里），老浏览器只看 `files`。
		 * 纯函数，方便测试：拿不到图片就返回 null，输入框里的文字粘贴照旧走默认行为。
		 */
		function pickClipboardImage(clipboard) {
			const items = Array.from(clipboard?.items ?? []);
			for (const item of items) {
				if (item?.kind && item.kind !== "file") continue;
				const type = String(item?.type ?? "");
				const file = typeof item?.getAsFile === "function" ? item.getAsFile() : null;
				if (file && (type.startsWith("image/") || String(file.type ?? "").startsWith("image/"))) return file;
			}
			const files = Array.from(clipboard?.files ?? []);
			return files.find((file) => String(file?.type ?? "").startsWith("image/")) ?? null;
		}

		/** 粘贴进来的图给个像样的名字（截图工具给的常常就叫 image.png / blob）。 */
		function pastedImageName(file) {
			const raw = String(file?.name ?? "").trim();
			const kind = String(file?.type ?? "image/png").split("/")[1] || "png";
			const ext = kind === "jpeg" ? "jpg" : kind.replace(/[^a-z0-9]/gi, "") || "png";
			const generic = /^(image|blob|clipboard|pasted|untitled|图片|截图)([-_. ]?\d*)?\.[a-z0-9]+$/i.test(raw);
			if (raw && /\.[a-z0-9]+$/i.test(raw) && !generic) return raw;
			const stamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
			return `粘贴的图片-${stamp}.${ext}`;
		}

		/** 远端/本地的图拿回 base64，用于「用这张重绘」。 */
		async function urlToDataUrl(url) {
			const response = await fetch(url, { cache: "no-store", credentials: "same-origin" });
			if (!response.ok) throw new Error(`取图失败 HTTP ${response.status}`);
			const blob = await response.blob();
			// 拿回来不是图（404 页面 / JSON 错误）：返回空串，别让调用方把垃圾当图片用
			if (blob.type && !blob.type.startsWith("image/")) return "";
			return await fileToDataUrl(new File([blob], "reference.png", { type: blob.type || "image/png" }));
		}

		/* ---------------- 尺寸 = 比例 × 像素 ---------------- */

		// 上游要的是像素，用户要的是比例：下拉里把比例写在前面（1:1 / 3:2 / 16:9 …），
		// 选哪条就把 config.defaultSize 写成对应像素。老配置里的冷门尺寸也兜底显示。
		/* 尺寸 = 比例 × 分辨率档：1K 基准表 ×1 / ×2 / ×4，6 个常用比例都有 1K / 2K / 4K */
		const SIZE_BASE = [
			{ ratio: "1:1", w: 1024, h: 1024 },
			{ ratio: "3:2", w: 1536, h: 1024 },
			{ ratio: "2:3", w: 1024, h: 1536 },
			{ ratio: "16:9", w: 1536, h: 864 },
			{ ratio: "9:16", w: 864, h: 1536 },
			{ ratio: "21:9", w: 2048, h: 864 }
		];
		const SIZE_TIERS = [
			{ id: "1K", scale: 1 },
			{ id: "2K", scale: 2 },
			{ id: "4K", scale: 4 }
		];
		const SIZE_OPTIONS = SIZE_TIERS.flatMap((tier) =>
			SIZE_BASE.map((base) => ({
				value: `${base.w * tier.scale}x${base.h * tier.scale}`,
				ratio: `${base.ratio} · ${tier.id}`
			}))
		);


		/** 像素 → { tier, ratio }：size 只放分辨率档（4K），宽高比单独放 aspect_ratio（21:9）。 */
		function sizePartsFor(value) {
			const raw = String(value ?? "").trim();
			const hit = SIZE_OPTIONS.find((option) => option.value === raw);
			if (!hit) return { tier: raw, ratio: "" };
			const [ratio, tier] = String(hit.ratio).split(" · ");
			return { tier: tier || raw, ratio: ratio || "" };
		}

		/**
		 * 尺寸表达式：JSON 请求体里 size 可以写像素（3072x1728），也可以写「档位 + 宽高比」：
		 *   "2K"、"16:9"、"2K · 16:9"（也认 2k/2K/4K、空格或 @ 分隔）。返回像素字符串。
		 */
		function resolveSizeExpression(value, fallback = "1024x1024") {
			const raw = String(value ?? "").trim();
			if (!raw) return fallback;
			if (/^\d{2,5}\s*[x×*]\s*\d{2,5}$/i.test(raw)) return raw.replace(/\s*[x×*]\s*/i, "x");
			const fallbackPixels = String(fallback).match(/^(\d+)x(\d+)$/);
			const fallbackLong = fallbackPixels ? Math.max(Number(fallbackPixels[1]), Number(fallbackPixels[2])) : 1024;
			const tierMatch = raw.match(/(\d)\s*k/i);
			let scale = tierMatch ? Math.max(1, Number(tierMatch[1])) : 0;
			if (!scale) scale = fallbackLong >= 3000 ? 4 : fallbackLong >= 1500 ? 2 : 1;
			const ratioMatch = raw.match(/(\d{1,2})\s*[:：]\s*(\d{1,2})/);
			const ratioId = ratioMatch ? `${Number(ratioMatch[1])}:${Number(ratioMatch[2])}` : "";
			const knownFallback = sizePartsFor(fallback);
			if (!tierMatch && knownFallback.ratio) scale = Number.parseInt(knownFallback.tier, 10);
			const fallbackRatio = knownFallback.ratio || (fallbackPixels ? `${Number(fallbackPixels[1])}:${Number(fallbackPixels[2])}` : "1:1");
			const base =
				SIZE_BASE.find((item) => item.ratio === ratioId) ||
				SIZE_BASE.find((item) => item.ratio === fallbackRatio) ||
				SIZE_BASE[0];
			return `${base.w * scale}x${base.h * scale}`;
		}


		/** 从同一份尺寸描述生成宿主字段；视频/自定义像素不套图片档位表。 */
		function generationSize(body, raw, fallback, video = false) {
			const size = String(body.size || fallback).trim();
			const pixel = /^\d+\s*[x×*]\s*\d+$/i.test(size);
			const parts = sizePartsFor(pixel ? resolveSizeExpression(size) : fallback);
			const inlineRatio = size.match(/\d{1,2}\s*[:：]\s*\d{1,2}/)?.[0];
			const tier = size.match(/(\d+)\s*k/i)?.[1];
			const ratio = String(inlineRatio || body.aspect_ratio || body.aspectRatio || parts.ratio || "").replace(/\s/g, "").replace("：", ":");
			if (video || (pixel && !parts.ratio) || (!pixel && !tier && !inlineRatio)) return { size, ...(raw && (body.aspect_ratio || body.aspectRatio) ? { aspect_ratio: body.aspect_ratio || body.aspectRatio } : {}) };
			const level = tier ? `${tier}K` : parts.ratio ? parts.tier : "1K";
			if (raw) return { size: level, ...(ratio ? { aspect_ratio: ratio } : {}) };
			return { size: pixel && !body.aspect_ratio && !body.aspectRatio ? resolveSizeExpression(size) : resolveSizeExpression(`${level} ${ratio}`, fallback) };
		}

		const GEMINI_RATIOS = ["1:1", "2:3", "3:2", "3:4", "4:3", "4:5", "5:4", "9:16", "16:9", "21:9"];
		const geminiTiers = model => /^gemini-2\.5-flash-image(?:-|$)/i.test(String(model || "").replace(/^models\//i, "")) ? ["1K"] : ["1K", "2K", "4K"];
		function imageRequestProtocol(endpoint, providerId, providers) {
			return (!endpoint || endpoint === "auto") && providers?.find(p => p.id === providerId)?.endpoint === GEMINI_NATIVE ? GEMINI_NATIVE : endpoint || "auto";
		}
		function geminiSettings(config) {
			const legacy = sizePartsFor(config.defaultSize), tiers = geminiTiers(config.defaultModel);
			const size = config.geminiSize || legacy.tier, ratio = config.geminiRatio || legacy.ratio;
			return { size:tiers.includes(size) ? size : "1K", aspect_ratio:GEMINI_RATIOS.includes(ratio) ? ratio : "1:1" };
		}
		function geminiBody(body) {
			const {quality, seconds, aspectRatio, ...rest} = body;
			const legacy = sizePartsFor(rest.size), size = legacy.tier || "1K", ratio = rest.aspect_ratio || aspectRatio || legacy.ratio || "1:1";
			if (!geminiTiers(rest.model).includes(size) || !GEMINI_RATIOS.includes(ratio) || rest.mask || seconds || (rest.n != null && Number(rest.n) !== 1)) throw Error(t("chat.geminiParams"));
			return {...rest, size, aspect_ratio:ratio, n:1};
		}

		function normalizeGenerationBody(body, raw, fallback, video) {
			if (body.endpoint === GEMINI_NATIVE) return geminiBody(body);
			const { aspect_ratio, aspectRatio, ...rest } = body;
			return { ...rest, ...generationSize(body, raw, fallback, video) };
		}

		/** 预览和入队都从这里取字段；补传参考图只会补本站 URL。 */
		function buildGenerationRequest({ prompt, config, providers, conversationId, references, isVideoEndpoint, sizeRaw }) {
			const providerId = providerIdForModel(providers, config), endpoint = imageRequestProtocol(config.defaultEndpoint, providerId, providers);
			const urls = references.map((ref) => ref.url).filter(Boolean);
			const images = references.map((ref) => ref.dataUrl).filter((url) => typeof url === "string" && url.startsWith("data:")).slice(0, 4);
			const size = isVideoEndpoint ? config.videoSize || "1280x720" : config.defaultSize;
			return normalizeGenerationBody({
				prompt, userText: prompt, planNote: "", conversationId,
				model: config.defaultModel, providerId,
				size, quality: config.defaultQuality, n: isVideoEndpoint ? 1 : config.defaultCount,
				seconds: isVideoEndpoint ? config.videoSeconds || "4" : "", endpoint,
				mode: references.length ? "edit" : "generate", referenceUrl: urls[0] || "", referenceUrls: urls,
				...(images.length ? { image: images[0] } : {}), images, source: "ui",
				...(endpoint === GEMINI_NATIVE ? {...geminiSettings(config), n:1, seconds:""} : {})
			}, sizeRaw, size, isVideoEndpoint);
		}

		/** 只记编辑过的字段，不把旧 prompt、模型或参考图冻结到下一次发送。 */
		function requestOverrides(base, edited) {
			return Object.fromEntries(Object.entries(edited).filter(([key, value]) => key !== "conversationId" && JSON.stringify(base[key]) !== JSON.stringify(value)));
		}

		function sizeOptionsFor(current) {
			const list = SIZE_OPTIONS.slice();
			if (current && !list.some((item) => item.value === current)) list.unshift({ value: current, ratio: t("chat.sizeCustom") });
			return list;
		}

		/** 下拉正面：比例 + 分辨率（`16:9 · 1536×864`）；认不出的老尺寸只显示像素。 */
		function sizeOptionLabel(option) {
			const ratio = option?.ratio && option.ratio !== option.value ? option.ratio : "";
			const pixels = String(option?.value || "").replace("x", "×");
			return ratio ? `${ratio} · ${pixels}` : pixels;
		}

		/** 悬停 / 选项里给全称：`16:9 · 1536×864`。 */
		function sizeOptionTitle(option) {
			return sizeOptionLabel(option);
		}

		/* ---------------- 快捷拖拽：一张图能被拖到哪儿去 ---------------- */

		const IMAGE_DRAG_TYPE = "application/x-velapi-image";
		// 图库原图的本地 file:// 地址缓存（宿主 /asset/local 给的）。拖出去时优先给真文件地址，
		// 拿不到才退回页面 URL —— dsh-app:// 这种自定义协议资源管理器不认，会变成一串文本。
		const LOCAL_FILE_CACHE = new Map();
		// 宿主能力（/capabilities）：nativeDrag 才有必要在 Shift+拖 时同步打原生拖拽；
		// 老宿主没有这条路由就保持 null，普通拖拽照旧，不会因为同步请求卡住界面。
		let HOST_CAPS = null;
		/** 给测试/预览注入能力表（真机上由 reload() 从 /capabilities 取）。 */
		function setHostCapabilities(caps) {
			HOST_CAPS = caps && typeof caps === "object" ? caps : null;
		}

		function localFileNameOf(imageUrl) {
			return String(imageUrl || "").split("?")[0].split("/").pop() || "";
		}

		/** 提前问宿主这张图的本地路径（pointerdown 时就开始问，dragstart 时通常已经到了）。 */
		async function prefetchLocalFileUrl(image) {
			const name = localFileNameOf(image?.url);
			// 只问正常的图库文件名；data: / 外站 URL 没有本地副本，别拿整串去查
			if (!name || !/^[A-Za-z0-9._-]+$/.test(name)) return "";
			if (LOCAL_FILE_CACHE.has(name)) return LOCAL_FILE_CACHE.get(name) || "";
			try {
				const payload = await call(`/asset/local?file=${encodeURIComponent(name)}`);
				if (payload?.fileUrl) LOCAL_FILE_CACHE.set(name, payload.fileUrl);
			} catch {
				/* 老宿主没有这条路由：拖出去就退回页面 URL */
			}
			return LOCAL_FILE_CACHE.get(name) || "";
		}

		/**
		 * 原生拖出：网页层只能塞 URL/文本，拖到别的程序就变成一串字；
		 * 真文件得让 Electron 主进程 webContents.startDrag 来拉。dragstart 里必须**同步**把请求发出去，
		 * 原生拖拽才会在这一次手势里起来（所以用同步 XHR，只在 Shift+拖 时走这条路）。
		 * 宿主不是 Electron / 没这个文件就返回 false，退回普通 HTML5 拖拽。
		 */
		function requestNativeDrag(fileName) {
			if (!fileName || !/^[A-Za-z0-9._-]+$/.test(fileName)) return false;
			try {
				const xhr = new XMLHttpRequest();
				xhr.open("POST", `${API}/drag/native`, false);
				xhr.setRequestHeader("content-type", "application/json");
				xhr.send(JSON.stringify({ file: fileName }));
				return xhr.status >= 200 && xhr.status < 300;
			} catch {
				return false;
			}
		}

		/** 这张图在图库里的文件名（导出 / 复制图片用）；data: 或外站 URL 用 name 兜底。 */
		function assetFileName(image) {
			const derived = String(image?.url || "").split("?")[0].split("/").pop() || "";
			if (/^[A-Za-z0-9._-]+$/.test(derived)) return derived;
			return String(image?.name || "image.png").replace(/[\\/:*?"<>|]+/g, "_");
		}

		/** 把图读成 PNG blob：系统剪贴板最稳的是 image/png，JPEG/WebP 就用 canvas 转一次。 */
		async function imageBlobForClipboard(url) {
			const absolute = new URL(url, window.location.origin).toString();
			const response = await fetch(absolute, { cache: "no-store", credentials: "same-origin" });
			if (!response.ok) throw new Error(`取图失败 HTTP ${response.status}`);
			const blob = await response.blob();
			const type = String(blob.type || "").startsWith("image/") ? blob.type : "image/png";
			if (type === "image/png") return blob;
			const bitmap = await createImageBitmap(blob);
			const canvas = document.createElement("canvas");
			canvas.width = bitmap.width;
			canvas.height = bitmap.height;
			canvas.getContext("2d").drawImage(bitmap, 0, 0);
			const png = await new Promise((resolve) => {
				canvas.toBlob((value) => resolve(value), "image/png");
			});
			bitmap.close?.();
			if (!png) throw new Error("转 PNG 失败");
			return png;
		}

		/**
		 * 把「图片本身」写进系统剪贴板 —— 纯网页能力，**不需要宿主重启**。
		 * PPT / 文档里 Ctrl+V 贴出来的是图，不是一串 URL。
		 * 环境不支持（没有 ClipboardItem / 非安全上下文）就返回 false，走宿主端点那条老路。
		 */
		async function copyImageToClipboard(image) {
			if (typeof ClipboardItem === "undefined" || !navigator?.clipboard?.write) return false;
			const blob = await imageBlobForClipboard(image.url);
			await navigator.clipboard.write([new ClipboardItem({ "image/png": blob })]);
			return true;
		}

		/** 存文件：blob + `<a download>`。走宿主端点也行，但这条纯前端、旧宿主也能用。 */
		async function downloadImageFile(image) {
			const absolute = new URL(image.url, window.location.origin).toString();
			const response = await fetch(absolute, { cache: "no-store", credentials: "same-origin" });
			if (!response.ok) throw new Error(`取图失败 HTTP ${response.status}`);
			const blob = await response.blob();
			const objectUrl = URL.createObjectURL(blob);
			const link = document.createElement("a");
			link.href = objectUrl;
			link.download = assetFileName(image);
			document.body.appendChild(link);
			link.click();
			link.remove();
			setTimeout(() => URL.revokeObjectURL(objectUrl), 4000);
		}

		/**
		 * 让一张图可拖：拖进输入区 = 挂成参考图；拖进「图片处理」= 载入编辑；
		 * 拖到资源管理器 / 桌面 = 落一份文件（Chromium 认 DownloadURL；能拿到本地 file:// 地址就用它，
		 * 因为 dsh-app:// 页面 URL 资源管理器取不回来，只会显示成一串文本）。
		 * 另附 text/html，富文本目标（笔记 / 文档）能直接嵌图而不是贴 URL。
		 * **Shift + 拖** 走宿主原生拖拽（Electron `webContents.startDrag`）—— 拖到别的程序得到的是
		 * 真图片文件，而不是 URL 文本；宿主不是 Electron 时自动退回普通 HTML5 拖拽。
		 */
		function imageDragProps(image) {
			return {
				draggable: true,
				onPointerDown: () => {
					void prefetchLocalFileUrl(image);
				},
				onDragStart: (event) => {
					if (!image?.url) return;
					try {
						const absolute = new URL(image.url, window.location.origin).toString();
						const name = image.name || "image.png";
						const payload = JSON.stringify({
							url: absolute,
							name,
							assetId: image.assetId || "",
							model: image.model || "",
							prompt: image.prompt || ""
						});
						const transfer = event.dataTransfer;
						if (!transfer) return;
						transfer.setData(IMAGE_DRAG_TYPE, payload);
						transfer.setData("text/uri-list", absolute);
						transfer.setData("text/plain", absolute);
						transfer.setData("text/html", `<img src="${absolute.replace(/"/g, "%22")}" alt="${String(name).replace(/"/g, "")}">`);
						try {
							const fileUrl = LOCAL_FILE_CACHE.get(localFileNameOf(image.url)) || absolute;
							transfer.setData("DownloadURL", `${image.mime || "image/png"}:${name}:${fileUrl}`);
						} catch {
							/* 有的环境不认 DownloadURL，不影响拖进输入区 / 图片处理 */
						}
						transfer.effectAllowed = "copy";
						// 宿主支持原生拖拽时，**每次拖都先试原生**：拖到 PPT / 资源管理器 / 桌面
						// 得到的是真图片文件（HTML5 拖拽只会给一串 URL）。拉不起来才退回普通拖拽。
						if (HOST_CAPS?.nativeDrag === true && requestNativeDrag(localFileNameOf(image.url))) {
							event.preventDefault();
						}
					} catch {
						/* 拖拽失败就当用户没拖 */
					}
				}
			};
		}

		/** 从拖拽数据里认出「本插件自己的图」：优先自定义类型，其次 uri-list。 */
		function readImageDrag(dataTransfer) {
			if (!dataTransfer) return null;
			try {
				const raw = dataTransfer.getData(IMAGE_DRAG_TYPE);
				if (raw) {
					const parsed = JSON.parse(raw);
					if (parsed && typeof parsed.url === "string" && parsed.url.trim()) {
						return { ...parsed, url: parsed.url.trim(), name: parsed.name || "image.png" };
					}
				}
			} catch {
				/* 自定义类型坏了就看 uri-list */
			}
			const uri = String(dataTransfer.getData("text/uri-list") || "")
				.split(/\r?\n/)
				.map((line) => line.trim())
				.find((line) => /^https?:\/\//i.test(line) || line.startsWith("/api/"));
			if (!uri) return null;
			return { url: uri, name: uri.split("/").pop() || "image.png" };
		}

		/* ------------------------------------------------------------------ *
		 * 通用小组件
		 * ------------------------------------------------------------------ */

		// 单次保存：React 更新按钮之前也不能再提交同一份草稿。
		function useSubmitLock() {
			const lock = useRef(false);
			const [busy, setBusy] = useState(false);
			const run = async (submit) => {
				if (lock.current) return false;
				lock.current = true;
				setBusy(true);
				try { return await submit(); }
				finally { lock.current = false; setBusy(false); }
			};
			return { busy, run };
		}

		function splitFieldList(text, limit = Infinity) {
			return [...new Set(String(text ?? '').split(/[,，\n]/).map((v) => v.trim()).filter(Boolean))].slice(0, limit);
		}

		// 使用浏览器模态焦点栈，但将表单限制在当前工作台和视口的交集，不盖到另一个面板。
		let dialogAnchorId = 0;
		const FeedbackContext = react.createContext?.(null);
		function WorkbenchDialog({ onDismiss, label, children, fullscreen = false }) {
			const feedback = FeedbackContext ? react.useContext(FeedbackContext) : null;
			const ref = useRef(null);
			useMeasureEffect(() => {
				const dialog = ref.current;
				if (!dialog) return;
				const root = dialog.closest('.vig-root');
				const opener = document.activeElement;
				// 锚点由布局引擎逐帧更新，滚动和拖动宿主时即刻定位。旧版 Chromium 退回测量。
				const anchored = !fullscreen && root && window.CSS?.supports('position-anchor: --vig') && window.CSS.supports('top: max(0px, anchor(top))');
				if (anchored) {
					const anchor = root.style.anchorName || `--vig-dialog-${++dialogAnchorId}`;
					root.style.anchorName = anchor;
					dialog.style.positionAnchor = anchor;
					dialog.dataset.anchored = '1';
				}
				const measure = () => {
					if (anchored) return;
					const r = fullscreen ? null : root?.getBoundingClientRect();
					const w = document.documentElement.clientWidth, h = document.documentElement.clientHeight;
					const left = Math.max(0, r?.left ?? 0), top = Math.max(0, r?.top ?? 0);
					Object.assign(dialog.style, {left: `${left}px`, top: `${top}px`, width: `${Math.max(0, Math.min(w, r?.right ?? w) - left)}px`, height: `${Math.max(0, Math.min(h, r?.bottom ?? h) - top)}px`});
				};
				measure();
				dialog.showModal();
				const observer = !anchored && !fullscreen && root && typeof ResizeObserver === 'function' ? new ResizeObserver(measure) : null;
				if (observer) observer.observe(root);
				window.addEventListener('resize', measure);
				window.addEventListener('scroll', measure, true);
				return () => {
					observer?.disconnect(); window.removeEventListener('resize', measure); window.removeEventListener('scroll', measure, true);
					dialog.close();
					if (opener?.isConnected) opener.focus?.({preventScroll:true});
				};
			}, []);
			return h('dialog', {className:fullscreen ? 'vig-viewer vig-dialog-frame' : 'vig-modal-mask vig-dialog-frame', ref, 'aria-label':label, 'aria-modal':'true',
				onCancel: (e) => { e.preventDefault(); onDismiss(); },
				onKeyDown: (e) => { if (e.key === 'Escape' && !e.defaultPrevented) { e.preventDefault(); e.stopPropagation(); onDismiss(); } },
				onClick: (e) => { if (e.target === e.currentTarget) onDismiss(); }
			}, children, feedback);
		}

		function Pill({ tone, children }) {
			return h("span", { className: `vig-pill${tone ? ` is-${tone}` : ""}` }, h("i", { className: "vig-dot" }), children);
		}

		function Block({ title, icon, defaultOpen = true, right, children }) {
			const [open, setOpen] = useState(defaultOpen);
			return h(
				"section",
				{ className: "vig-block" },
				h(
					"div",
					{ className: "vig-block-head", role:"button", tabIndex:0, "aria-expanded":open, onKeyDown:(e)=>{if(e.target===e.currentTarget && (e.key==="Enter" || e.key===" ")){e.preventDefault();setOpen(v=>!v);}}, onClick: () => setOpen((value) => !value) },
					h(Icon, { name: icon }),
					h("span", { className: "vig-block-title" }, title),
					h("div", { className: "vig-spacer" }),
					right ?? null,
					h(Icon, { name: open ? "chevronDown" : "chevron" })
				),
				open ? h("div", { className: "vig-block-body" }, children) : null
			);
		}

		/** 提示条本体：窗口额头居中悬浮。抽成组件是为了预览/测试能单独渲染它。 */
		function ToastHost({ items }) {
			return h(
				"div",
				{ className: "vig-toasts", role:"status", "aria-live":"polite" },
				(items ?? []).map((item) =>
					h(
						"div",
						{
							key: item.id,
							className: `vig-toast${item.tone === "err" ? " is-err" : item.tone === "ok" ? " is-ok" : ""}`
						},
						item.message
					)
				)
			);
		}

		function useToasts() {
			const [items, setItems] = useState([]);
			const push = useCallback((message, tone) => {
				const id = Math.random().toString(36).slice(2);
				setItems((list) => [...list, { id, message, tone }]);
				setTimeout(() => setItems((list) => list.filter((item) => item.id !== id)), 4200);
			}, []);
			return [h(ToastHost, { items }), push];
		}

		/**
		 * 量自己的容器宽度，决定走宽屏三段式还是窄屏堆叠。
		 * 不能看 window.innerWidth：同一个组件会落进产品右侧栏、停靠面板、设置页，
		 * 三处宽度差好几倍，只看窗口宽度会把停靠面板误判成宽屏然后挤成一团。
		 *
		 * 用 layoutEffect 而不是 effect：首帧就会按容器宽度定形态，否则窄容器里会先
		 * 闪一帧「三段并排」再跳成堆叠（那一帧还是会溢出被裁）。
		 */
		function useWide(ref, breakpoint = 660) {
			const [wide, setWide] = useState(true);
			useMeasureEffect(() => {
				const node = ref.current;
				if (!node) return undefined;
				const apply = (width) => setWide(width >= breakpoint);
				node.style.setProperty("--vig-host-height", `${node.clientHeight}px`);
				apply(node.clientWidth || 0);
				if (typeof ResizeObserver === "undefined") return undefined;
				const observer = new ResizeObserver((entries) => {
					const bounds = entries[0]?.contentRect;
					node.style.setProperty("--vig-host-height", `${bounds?.height ?? node.clientHeight}px`);
					const width = bounds?.width ?? node.clientWidth ?? 0;
					apply(width);
				});
				observer.observe(node);
				return () => observer.disconnect();
			}, [ref, breakpoint]);
			return wide;
		}

		/* ------------------------------------------------------------------ *
		 * 对话生图
		 * ------------------------------------------------------------------ */

		/** 以源像素为单位，复用编辑器的舍入边界；拒绝空格，不用裁剪或拉伸去补齐。 */
		function psGridLayout(width, height, rows, cols) {
			if (![width, height, rows, cols].every(Number.isSafeInteger) || width < 1 || height < 1 ||
				width > 0xffffffff || height > 0xffffffff || rows < 1 || cols < 1 ||
				rows > Math.min(6, height) || cols > Math.min(6, width)) throw new RangeError("无效的宫格尺寸或行列数");
			return psSplitTiles(width, height, cols, rows).map(({ x, y, w, h }) => ({ x, y, w, h }));
		}

		function psGridCheckRect(canvas, rect) {
			if (!canvas || typeof canvas.getContext !== "function") throw new TypeError("需要源画布");
			const { x, y, w, h } = rect || {};
			if (![canvas.width, canvas.height, x, y, w, h].every(Number.isSafeInteger) || x < 0 || y < 0 ||
				w < 1 || h < 1 || x > canvas.width - w || y > canvas.height - h) throw new RangeError("宫格区域超出源画布");
		}

		function psGridCrop(sourceCanvas, rect) {
			psGridCheckRect(sourceCanvas, rect);
			return psSlice(sourceCanvas, rect);
		}

		function psGridReplace(sourceCanvas, rect, patch) {
			psGridCheckRect(sourceCanvas, rect);
			const pw = patch?.naturalWidth ?? patch?.width, ph = patch?.naturalHeight ?? patch?.height;
			if (![pw, ph].every(Number.isSafeInteger) || pw < 1 || ph < 1) throw new RangeError("需要已解码的替换图");
			const { x, y, w, h } = rect;
			const out = psCanvas(sourceCanvas.width, sourceCanvas.height);
			const ctx = out.getContext("2d");
			ctx.drawImage(sourceCanvas, 0, 0);
			// 先清除目标格，透明像素也要替换旧内容；九参 drawImage 只写这个整数矩形。
			ctx.clearRect(x, y, w, h);
			const scale = Math.max(w / pw, h / ph);
			const sw = Math.min(pw, w / scale), sh = Math.min(ph, h / scale);
			ctx.drawImage(patch, (pw - sw) / 2, (ph - sh) / 2, sw, sh, x, y, w, h);
			return out;
		}

		function Shot({ image, onReuse, onToast, onPreview, onSave, onGrid }) {
			const displayed = useRef(null);
			const [busy, setBusy] = useState(false);
			const safeName = (image.name || "image").replace(/[\\/:*?"<>|]+/g, "_");
			const naturalWidth = Number(image.width), naturalHeight = Number(image.height);
			const imageRatio = naturalWidth > 0 && naturalHeight > 0 && Number.isFinite(naturalWidth / naturalHeight) ? naturalWidth / naturalHeight : 1;
			const ratioStyle = { "--vig-image-ratio": imageRatio, "--vig-image-width": `${420 * imageRatio}px` };
			return h(
				"figure",
				{ className: "vig-shot", style: { margin: 0, ...ratioStyle } },
				// 点图开查看器（放大 / 缩放 / 翻页）；拖出去可以当参考图、拖进图片处理、拖到文件夹保存。
				h(
					"button",
					{
						type: "button",
						className: "vig-shot-img",
						title: `${t("chat.open")} · ${image.name || t("viewer.title")} · ${t("common.dragHint")}`,
						"aria-label": `${t("chat.open")} · ${image.name || t("viewer.title")}`,
						onClick: () => onPreview?.(image),
						...imageDragProps(image)
					},
					h("img", { ref:displayed, src: image.url, alt: image.name || "", draggable: false })
				),
				h(
					"figcaption",
					{ className: "vig-shot-bar" },
					onGrid ? h("button", {type:"button", className:"vig-mini vig-shot-act", title:t("grid.title"), "aria-label":t("grid.title"), "data-grid-open":"1", onClick:()=>onGrid(image, displayed.current)}, h(Icon,{name:"grid",size:14})) : null,
					h(
						"button",
						{
							className: "vig-mini vig-shot-act",
							title: t("chat.reuse"),
							"aria-label": t("chat.reuse"),
							onClick: async () => {
								setBusy(true);
								try {
									await onReuse(image);
								} finally {
									setBusy(false);
								}
							}
						},
						busy ? h("span", { className: "vig-spin" }) : h(Icon, { name: "refresh", size: 13 })
					),
					h(
						"button",
						{
							className: "vig-mini vig-shot-act",
							title: t("chat.copy"),
							"aria-label": t("chat.copy"),
							onClick: async () => {
								const absolute = new URL(image.url, window.location.origin).toString();
								try {
									await navigator.clipboard.writeText(absolute);
									onToast(t("chat.copy"));
								} catch {
									onToast(absolute);
								}
							}
						},
						h(Icon, { name: "copy", size: 13 })
					),
					h(
						"button",
						{
							className: "vig-mini vig-shot-act",
							title: t("chat.saveTitle"),
							"aria-label": t("chat.saveShort"),
							onClick: () => onSave?.(image)
						},
						h(Icon, { name: "download", size: 13 })
					),
					h(
						"a",
						{
							className: "vig-mini vig-shot-act",
							href: image.url,
							download: safeName,
							title: t("chat.open"),
							"aria-label": t("chat.openShort")
						},
						h(Icon, { name: "external", size: 13 })
					)
				)
			);
		}

		// 结果卡已经有原始像素。只复用被点击的那一张，不取同名图、不截界面缩略图。
		function gridCheckPixels(img) {
			const w = img.naturalWidth, h = img.naturalHeight;
			if (!w || !h) throw new Error(t("grid.badImage"));
			if (w * h > 48 * 1024 * 1024 || Math.max(w, h) > 16384) throw new RangeError(t("grid.imageLimit"));
			// 跨域图片可能可见但不可导出；先在独立小画布验证，不污染工作稿。
			const probe = psCanvas(1, 1).getContext("2d", {willReadFrequently:true});
			probe.drawImage(img, 0, 0, 1, 1, 0, 0, 1, 1); probe.getImageData(0, 0, 1, 1);
		}
		function gridNativeImage(src, signal, cors = false) {
			return new Promise((resolve, reject) => {
				signal.throwIfAborted(); const img = new Image();
				const clean = () => { img.onload = img.onerror = null; signal.removeEventListener("abort", cancel); };
				const cancel = () => { clean(); img.removeAttribute("src"); reject(signal.reason); };
				img.onload = () => { clean(); resolve(img); };
				img.onerror = () => { clean(); reject(new Error(t("grid.badImage"))); };
				signal.addEventListener("abort", cancel, {once:true});
				if (cors) img.crossOrigin = "anonymous";
				img.src = src;
			});
		}
		function gridImageSource(url, base, pageURL) {
			if (!url) throw new Error(t("grid.badImage"));
			const src = new URL(url, base), page = new URL(pageURL);
			// Electron 的主窗口是 dsh-app://app/。不要用 URL.origin 的 "null" 比较自定义协议，
			// 也不要将此地址改写为会变化的 localhost 端口；由桌面壳转发已认证的相对 API 请求。
			if (src.protocol === "dsh-app:" && page.protocol === src.protocol && page.host === "app" && src.host === page.host &&
				!src.username && !src.password && /^\/api\/velapi-image-go\/(asset|upload|preset)\/[A-Za-z0-9._-]+$/.test(src.pathname)) {
				return { src, remote:false, request:src.pathname + src.search };
			}
			if (!["http:","https:","blob:","data:"].includes(src.protocol)) throw new Error(t("grid.unsupportedSource", {scheme:src.protocol}));
			return { src, remote:/^https?:$/.test(src.protocol) && src.origin !== page.origin, request:src.href };
		}
		async function gridLoadImage(url, parent, displayed = null) {
			parent.throwIfAborted();
			const { src, remote, request } = gridImageSource(url, document.baseURI, location.href);
			const borrowed = (img) => ({img, url:src.href, release:()=>{}});
			if (displayed?.complete && displayed.naturalWidth && (displayed.currentSrc || displayed.src) === src.href) {
				try { gridCheckPixels(displayed); return borrowed(displayed); }
				catch (e) { if (e instanceof RangeError) throw e; /* 显示图不可读：尝试取得可导出的副本。 */ }
			}
			// 没有可复用的原图时先走与卡片相同的 img 通道，最后才使用 fetch。
			const controller = new AbortController(), {signal} = controller;
			const cancel = () => controller.abort(parent.reason);
			parent.addEventListener("abort", cancel, {once:true});
			const timer = setTimeout(()=>controller.abort(new Error(t("grid.readTimeout"))), 30000);
			let owned;
			try {
				try { const img = await gridNativeImage(src.href, signal, remote); gridCheckPixels(img); return borrowed(img); }
				catch (e) { signal.throwIfAborted(); if (e instanceof RangeError) throw e; }
				let response;
				try { response = await fetch(request, {signal, credentials:"same-origin"}); }
				catch { signal.throwIfAborted(); throw new Error(t(remote ? "grid.remoteRead" : "grid.localRead")); }
				if (!response.ok) throw new Error(response.status === 404 ? t("grid.notFound") : `${t("grid.readError")} (HTTP ${response.status})`);
				let blob; try { blob = await response.blob(); } catch { signal.throwIfAborted(); throw new Error(t("grid.localRead")); }
				signal.throwIfAborted(); owned = URL.createObjectURL(blob);
				const img = await gridNativeImage(owned, signal); gridCheckPixels(img);
				const objectUrl = owned; owned = null;
				return {img, url:objectUrl, release:()=>URL.revokeObjectURL(objectUrl)};
			} finally { clearTimeout(timer); parent.removeEventListener("abort",cancel); if (owned) URL.revokeObjectURL(owned); }
		}
		const gridPNG = (canvas) => new Promise((resolve, reject) => canvas.toBlob((blob) => blob ? resolve(blob) : reject(new Error(t("grid.encodeError"))), "image/png"));
		function gridDownload(blob, filename) {
			const url = URL.createObjectURL(blob), a = document.createElement("a");
			try { a.href = url; a.download = filename; document.body.append(a); a.click(); }
			finally { a.remove(); setTimeout(() => URL.revokeObjectURL(url), 30000); }
		}
		// PNG 已压缩，ZIP 使用 STORE。逐格编码，不同时为几十格分配位图。
		async function gridPack(sheet, cells, cols, signal) {
			const files = [], directory = []; let offset = 0, dirBytes = 0;
			const record = (size, fields) => {
				const bytes = new Uint8Array(size), v = new DataView(bytes.buffer);
				for (const [at, n, value] of fields) n === 4 ? v.setUint32(at, value, true) : v.setUint16(at, value, true);
				return bytes;
			};
			for (const [i, rect] of cells.entries()) {
				signal.throwIfAborted(); const tile = psGridCrop(sheet, rect); let png;
				try { png = await gridPNG(tile); } finally { tile.width = tile.height = 1; }
				const bytes = new Uint8Array(await png.arrayBuffer()), name = new TextEncoder().encode(`r${Math.floor(i / cols) + 1}-c${i % cols + 1}.png`);
				const crc = psCrc32(bytes), size = png.size;
				const local = record(30, [[0,4,0x04034b50],[4,2,20],[12,2,33],[14,4,crc],[18,4,size],[22,4,size],[26,2,name.length]]);
				const center = record(46, [[0,4,0x02014b50],[4,2,20],[6,2,20],[14,2,33],[16,4,crc],[20,4,size],[24,4,size],[28,2,name.length],[42,4,offset]]);
				files.push(local, name, png); directory.push(center, name); dirBytes += 46 + name.length; offset += 30 + name.length + size;
			}
			const end = record(22, [[0,4,0x06054b50],[8,2,cells.length],[10,2,cells.length],[12,4,dirBytes],[16,4,offset]]);
			return new Blob([...files, ...directory, end], {type:"application/zip"});
		}
		function gridOutputSize(rect, configSize, raw) {
			// 保留当前分辨率档位，在支持的比例中选最接近这一格的；不能沿用整幅宫格的比例。
			const closest = SIZE_BASE.reduce((a, b) => Math.abs(Math.log(b.w / b.h / (rect.w / rect.h))) < Math.abs(Math.log(a.w / a.h / (rect.w / rect.h))) ? b : a);
			const tier = SIZE_TIERS.find((t) => t.id === sizePartsFor(configSize).tier || t.id === configSize) || SIZE_TIERS[0];
			return raw ? {size:tier.id, aspect_ratio:closest.ratio} : { size:`${closest.w * tier.scale}x${closest.h * tier.scale}` };
		}
		async function gridWaitJob(job, signal) {
			const id = job?.id, until = Date.now() + 6 * 60 * 1000;
			if (!id) throw new Error(t("chat.noReceipt"));
			while (["queued", "running"].includes(job.status)) {
				if (Date.now() >= until) throw new Error(t("grid.waitTimeout"));
				await new Promise((resolve, reject) => {
					signal.throwIfAborted();
					const stop = () => { clearTimeout(timer); reject(signal.reason); };
					const timer = setTimeout(() => { signal.removeEventListener("abort", stop); resolve(); }, 1100);
					signal.addEventListener("abort", stop, {once:true});
				});
				const res = await call(`/job?id=${encodeURIComponent(id)}`, {signal});
				if (!res?.job || res.job.id !== id) throw new Error(t("grid.missingResult"));
				job = res.job;
			}
			return job;
		}

		function GridEditor({ target, onClose, onJob, onHandoff }) {
			const { image, config, providerId, conversationId, sizeRaw, canGenerate } = target;
			const [rows, setRows] = useState(2), [cols, setCols] = useState(3), [index, setIndex] = useState(0);
			const [dimensions, setDimensions] = useState(null), [prompt, setPrompt] = useState(""), [mode, setMode] = useState("edit");
			const [hasEdits, setHasEdits] = useState(false);
			const [loadAttempt, setLoadAttempt] = useState(0);
			const [showBefore, setShowBefore] = useState(false);
			const [busy, setBusy] = useState("load"), [error, setError] = useState(""), [patch, setPatch] = useState(null), [dirty, setDirty] = useState(false);
			const mount = useRef(null), sheet = useRef(null), lifecycle = useRef(null), lock = useRef(false), candidate = useRef(null);
			const tracking = useRef(null);
			const handoff = () => { if (tracking.current) { onHandoff(tracking.current); tracking.current = null; } };
			const putSheet = (next) => {
				next.dataset.gridCanvas = "1"; next.setAttribute("aria-label", t("grid.sheet"));
				mount.current.replaceChildren(next); const old = sheet.current; sheet.current = next;
				if (old) old.width = old.height = 1;
			};
			const releasePatch = () => { candidate.current?.release(); candidate.current = null; };
			useEffect(() => {
				const controller = new AbortController(); lifecycle.current = controller;
				setBusy("load"); setError("");
				(async () => {
					const asset = await gridLoadImage(image.url, controller.signal, target.displayed);
					try {
						controller.signal.throwIfAborted(); const w = asset.img.naturalWidth, h = asset.img.naturalHeight;
						const original = psCanvas(w, h); original.getContext("2d").drawImage(asset.img, 0, 0); putSheet(original);
						setRows(Math.min(h, 2)); setCols(Math.min(w, 3)); setDimensions({w,h});
					} finally { asset.release(); }
				})().catch((e) => { if (!controller.signal.aborted) setError(String(e.message || e)); })
					.finally(() => { if (!controller.signal.aborted) setBusy(""); });
				return () => { controller.abort(); releasePatch(); if (sheet.current) sheet.current.width = sheet.current.height = 1; sheet.current = null; };
			}, [image.url, loadAttempt]);
			const cells = useMemo(() => dimensions ? psGridLayout(dimensions.w, dimensions.h, rows, cols) : [], [dimensions, rows, cols]);
			const rect = cells[index], blocked = !rect || !!busy || !!patch;
			const boxStyle = (cell) => ({left:`${cell.x/dimensions.w*100}%`, top:`${cell.y/dimensions.h*100}%`, width:`${cell.w/dimensions.w*100}%`, height:`${cell.h/dimensions.h*100}%`});
			const cellName = (i) => t("grid.coord", {r:Math.floor(i / cols) + 1, c:i % cols + 1});
			const stem = String(image.name || "sheet").replace(/\.[^.]+$/, "").replace(/[\\/:*?"<>|]+/g, "_");
			const transact = async (kind, fn) => {
				if (lock.current || !rect || !lifecycle.current || lifecycle.current.signal.aborted) return;
				lock.current = true; setBusy(kind); setError(""); const {signal} = lifecycle.current;
				try { await fn(signal); } catch (e) { if (!signal.aborted) setError(String(e?.message || e)); }
				finally { lock.current = false; if (!signal.aborted) setBusy(""); }
			};
			const dismiss = () => {
				if ((dirty || patch || busy === "generate") && !window.confirm(t(busy === "generate" ? "grid.leaveJob" : "grid.leaveDraft"))) return;
				lifecycle.current?.abort(); handoff(); onClose();
			};
			const generate = () => {
				if (blocked || !prompt.trim() || !canGenerate) return;
				void transact("generate", async (signal) => {
					const body = { prompt:prompt.trim(), userText:prompt.trim(), conversationId, providerId, model:config.defaultModel,
						quality:config.defaultQuality, n:1, mode, endpoint:mode === "edit" ? "images_edits" : "images_generations", source:"ui", ...gridOutputSize(rect, config.defaultSize, sizeRaw) };
					if (mode === "edit") {
						const tile = psGridCrop(sheet.current, rect);
						let blob;
						try { blob = await gridPNG(tile); } finally { tile.width = tile.height = 1; }
						// 宿主重试依赖 referenceUrls。只上传裁下的这一格，入队时不再重复附带图片字节。
						if (blob.size > 17 * 1024 * 1024) throw new Error(t("grid.uploadLimit"));
						const data = await fileToDataUrl(blob); signal.throwIfAborted();
						const uploaded = await call("/upload", {method:"POST", signal, body:{name:`${stem}-${index+1}.png`,data}});
						const ref = uploaded?.item?.url;
						if (!/^\/api\/velapi-image-go\/upload\/[A-Za-z0-9._-]+$/.test(ref || "")) throw new Error(t("grid.readError"));
						body.referenceUrl = ref; body.referenceUrls = [ref];
					}
					signal.throwIfAborted(); const res = await call("/generate", {method:"POST",body,signal});
					signal.throwIfAborted(); if (res?.job?.id) { tracking.current = res.job.id; onJob(res.job); }
					let done;
					try { done = await gridWaitJob(res?.job, signal); } catch (e) { if (!signal.aborted) handoff(); throw e; }
					signal.throwIfAborted(); tracking.current = null; onJob(done);
					if (done.status !== "succeeded" || !done.images?.[0]?.url) throw new Error(String(done.error || t("grid.missingResult")));
					const loaded = await gridLoadImage(done.images[0].url, signal);
					if (signal.aborted) { loaded.release(); return; }
					setShowBefore(false); candidate.current = { ...loaded, rect, index }; setPatch(candidate.current);
				});
			};
			const applyPatch = () => {
				if (busy || !patch || patch !== candidate.current || patch.index !== index) return;
				try { putSheet(psGridReplace(sheet.current, patch.rect, patch.img)); setDirty(true); setHasEdits(true); releasePatch(); setPatch(null); setError(""); }
				catch (e) { setError(String(e.message || e)); }
			};
			const download = (what) => void transact("export", async (signal) => {
				let file;
				if (what === "all") file = await gridPack(sheet.current, cells, cols, signal);
				else if (what === "sheet") file = await gridPNG(sheet.current);
				else { const tile = psGridCrop(sheet.current, rect); try { file = await gridPNG(tile); } finally { tile.width = tile.height = 1; } }
				signal.throwIfAborted(); const name = what === "cell" ? `r${Math.floor(index / cols)+1}-c${index % cols+1}.png` : what === "all" ? `${rows}x${cols}.zip` : "grid.png";
				gridDownload(file, `${stem}-${name}`); if (what === "sheet") setDirty(false);
			});
			const button = (key, label, action, disabled, primary=false) => h("button", {type:"button", className:`vig-btn${primary ? " is-primary" : ""}`, [`data-grid-${key}`]:"1", disabled, onClick:action}, t(label));
			const dimSelect = (key, val, max, set) => h("label", null, t(`grid.${key}`), h("select", {className:"vig-sel", value:val, [`data-grid-${key}`]:"1", disabled:blocked, onChange:(e)=>{set(Number(e.target.value));setIndex(0);setError("");}}, Array.from({length:Math.min(6,max)},(_,i)=>h("option",{key:i+1,value:i+1},i+1))));
			// 正在编辑与审核候选是互斥步骤；导出始终在独立页脚，不截断选格→填回的操作顺序。
			const current = rect && h("div", {className:"vig-grid-target"},
				h("h3",null,t(patch ? "grid.review" : "grid.editor")),
				h("div",{className:"vig-grid-cell-meta"},h("label",null,t("grid.cell"),h("select",{className:"vig-sel",disabled:blocked,value:index,onChange:e=>{setIndex(Number(e.target.value));setError("");}},cells.map((_,i)=>h("option",{key:i,value:i},cellName(i))))),
					h("span",{className:"vig-muted"},`${rect.w} × ${rect.h} px`)));
			const board = h("section",{className:"vig-grid-preview","data-grid-preview":"1","aria-label":t("grid.overview")},
				h("div",{className:"vig-grid-subhead"},h("h3",null,t("grid.overview")),h("div",{className:"vig-grid-line"},dimSelect("rows",rows,dimensions?.h || 2,setRows),dimSelect("cols",cols,dimensions?.w || 3,setCols))),
				h("div",{className:"vig-grid-board"},h("div",{className:"vig-grid-stage",style:dimensions ? {width:`min(100%, ${360 * dimensions.w/dimensions.h}px)`,aspectRatio:`${dimensions.w}/${dimensions.h}`} : undefined},
					h("div",{className:"vig-grid-raster",ref:mount}),
					patch && !showBefore && h("img",{className:"vig-grid-overlay",src:patch.url,alt:"",style:boxStyle(patch.rect)}),
					dimensions && cells.map((cell,i)=>h("button",{key:i,type:"button",className:"vig-grid-region","data-grid-cell":String(i),"aria-label":cellName(i),"aria-pressed":index===i,title:cellName(i),disabled:blocked,onClick:()=>{setIndex(i);setError("");},style:boxStyle(cell)},h("span",null,index===i && h(Icon,{name:"check",size:12}),i+1))))),
				h("div",{className:"vig-grid-preview-meta"},h("span",{className:"vig-grid-note",role:"status"},!dimensions ? (error ? "" : t("grid.busy.load")) : patch ? t(showBefore ? "grid.showingBefore" : "grid.pending") : t("grid.selectHint")),
					patch ? h("button",{type:"button",className:"vig-btn","data-grid-compare":"1","aria-pressed":showBefore,onClick:()=>setShowBefore(v=>!v)},t("grid.before")) : dimensions && h("span",{className:"vig-muted"},`${dimensions.w} × ${dimensions.h} px`)),
				!dimensions && error && h("div",{role:"alert",className:"vig-error"},error),
				!dimensions && !busy && error && button("retry-load","grid.retryLoad",()=>setLoadAttempt(n=>n+1),false));
			const form = rect && !patch && h("div",{className:"vig-grid-form"},
				h("label",{className:"vig-grid-field"},t("grid.fill"),h("select",{className:"vig-sel","data-grid-mode":"1",value:mode,disabled:blocked,onChange:e=>setMode(e.target.value)},h("option",{value:"edit"},t("grid.edit")),h("option",{value:"generate"},t("grid.generate")))),
				h("label",{className:"vig-grid-field"},t("grid.description"),h("textarea",{className:"vig-input",rows:3,maxLength:2000,placeholder:t("grid.prompt"),"data-grid-prompt":"1",value:prompt,disabled:blocked,onChange:e=>setPrompt(e.target.value)})),
				h("div",{className:"vig-grid-actions"},button("generate",busy==="generate" ? "grid.busy.generate" : "grid.submit",generate,blocked || !prompt.trim() || !canGenerate,true)),
				h("p",{className:"vig-grid-status",role:"status"},busy ? t(`grid.busy.${busy}`) : !canGenerate ? t("grid.needModel") : t("grid.safe")),
				h("p",{className:"vig-muted"},config.defaultModel));
			const review = patch && h("div",{className:"vig-grid-review","data-grid-review":"1"},
				h("div",{className:"vig-grid-review-body"},h("img",{className:"vig-grid-candidate","data-grid-candidate":"1",src:patch.url,alt:t("grid.preview"),style:{width:`min(38%, ${Math.min(108, 96*rect.w/rect.h)}px)`,aspectRatio:`${rect.w}/${rect.h}`}}),
					h("div",{style:{minWidth:0}},h("span",{className:"vig-muted"},t("grid.description")),h("p",{className:"vig-grid-summary"},prompt))),
				h("p",{className:"vig-grid-note"},t("grid.reviewNote")),
				h("div",{className:"vig-grid-actions"},button("apply","grid.apply",applyPatch,false,true),button("discard","grid.discard",()=>{releasePatch();setPatch(null);},false)));
			const inspector = dimensions && h("section",{className:"vig-grid-inspector","data-grid-inspector":"1","aria-label":t(patch ? "grid.review" : "grid.editor")},current,form,review,error && h("div",{role:"alert",className:"vig-error"},error));
			const exportsBar = dimensions && h("footer",{className:"vig-grid-foot","data-grid-exports":"1"},
				h("div",null,h("h3",null,t("grid.exports")),h("p",{className:"vig-grid-note",role:"status"},t(patch ? "grid.exportPending" : dirty ? "grid.dirty" : busy==="export" ? "grid.busy.export" : "grid.exportHint"))),
				h("div",{className:"vig-grid-foot-actions"},button("export-cell","grid.cellPNG",()=>download("cell"),blocked),button("export-all","grid.allZIP",()=>download("all"),blocked),hasEdits && button("export-sheet","grid.sheetPNG",()=>download("sheet"),blocked)));
			return h(WorkbenchDialog,{label:t("grid.title"),onDismiss:dismiss},h("section",{className:"vig-modal vig-grid-editor","data-grid-editor":"1"},
				h("header",{className:"vig-grid-head"},h("div",{className:"vig-grid-ident"},h("span",{className:"vig-grid-symbol","aria-hidden":true},h(Icon,{name:"grid",size:18})),h("div",null,h("h2",null,t("grid.title")),h("p",{className:"vig-muted"},t("grid.intro")))),h("button",{type:"button",className:"vig-icon-btn",title:t("grid.close"),"aria-label":t("grid.close"),"data-grid-close":"1",onClick:dismiss},h(Icon,{name:"close"}))),
				h("div",{className:"vig-grid-workarea"},board,inspector),exportsBar));
		}

		/* ------------------------------------------------------------------ *
		 * 图片查看器
		 *
		 * 结果卡 / 图库里点开大图：滚轮缩放、拖动平移、←/→ 翻页、Esc 关闭，
		 * 顺手能「用作参考图 / 丢进图片处理 / 复制链接 / 打开原图 / 下载 / 删除」。
		 * 列表是调用方给的（一次生成的多张图、或当前筛选下的整个图库），
		 * 翻页不重新拉数据 —— 左邻右舍就是它们。
		 * ------------------------------------------------------------------ */

		const VIEWER_ZOOM_MIN = 0.2;
		const VIEWER_ZOOM_MAX = 8;

		function ImageViewer({ items, index = 0, onClose, onIndex, onToast, onUseReference, onEdit, onDelete, onSave, onCopy, onDownload, onQuadApply }) {
			const list = (Array.isArray(items) ? items : []).filter(Boolean);
			const safeIndex = Math.min(Math.max(Number(index) || 0, 0), Math.max(0, list.length - 1));
			const current = list[safeIndex] ?? null;
			const [zoom, setZoom] = useState(1);
			const [pan, setPan] = useState({ x: 0, y: 0 });
			const [panning, setPanning] = useState(false);
			const [broken, setBroken] = useState(false);
			const stageRef = useRef(null);
			const dragRef = useRef(null);
			/* 四点变形：角点用的是图的自然坐标，**不做图内限制** —— 拖出边界、拖成负值都行，
			   输出画布取四个角的外接矩形（所以结果可以比原图大 / 偏移到图外）。 */
			const [quadMode, setQuadMode] = useState(false);
			const [quad, setQuad] = useState(null);
			const [quadDrag, setQuadDrag] = useState(-1);
			const [imgRect, setImgRect] = useState(null);
			const imgRef = useRef(null);
			const naturalRef = useRef(null);
			const quadModeRef = useRef(false);
			quadModeRef.current = quadMode;

			const enterQuad = () => {
				const img = imgRef.current;
				const w = img?.naturalWidth || 0;
				const height = img?.naturalHeight || 0;
				if (!w || !height) {
					onToast?.(t("viewer.missing"), "err");
					return;
				}
				naturalRef.current = { w, h: height };
				setZoom(1);
				setPan({ x: 0, y: 0 });
				setQuad(psQuadCorners(w, height));
				setQuadMode(true);
			};
			const exitQuad = () => {
				setQuadMode(false);
				setQuad(null);
				setQuadDrag(-1);
			};
			/* 量出图在舞台里的显示矩形：角点自然坐标 ↔ 屏幕坐标 就靠它换算 */
			const measureQuad = () => {
				const img = imgRef.current;
				const stage = stageRef.current;
				if (!img || !stage || !quadModeRef.current) return;
				const ir = img.getBoundingClientRect();
				const sr = stage.getBoundingClientRect();
				if (ir.width < 2 || ir.height < 2) return;
				setImgRect({ left: ir.left - sr.left, top: ir.top - sr.top, width: ir.width, height: ir.height, w: img.naturalWidth, h: img.naturalHeight });
			};
			useEffect(() => {
				if (!quadMode) {
					setImgRect(null);
					return undefined;
				}
				measureQuad();
				window.addEventListener("resize", measureQuad);
				return () => {
					window.removeEventListener("resize", measureQuad);
				};
			}, [quadMode, current?.url, zoom, pan, broken]); // eslint-disable-line react-hooks/exhaustive-deps
			/* 拖角点：window 级 pointer 监听，拖出图外、拖出舞台都不断 */
			useEffect(() => {
				if (quadDrag < 0) return undefined;
				const onMove = (event) => {
					const stage = stageRef.current?.getBoundingClientRect();
					if (!stage || !imgRect) return;
					const nx = ((event.clientX - stage.left - imgRect.left) / imgRect.width) * imgRect.w;
					const ny = ((event.clientY - stage.top - imgRect.top) / imgRect.height) * imgRect.h;
					setQuad((points) => points.map((point, i) => (i === quadDrag ? { x: nx, y: ny } : point)));
				};
				const onUp = () => setQuadDrag(-1);
				window.addEventListener("pointermove", onMove);
				window.addEventListener("pointerup", onUp);
				window.addEventListener("pointercancel", onUp);
				return () => {
					window.removeEventListener("pointermove", onMove);
					window.removeEventListener("pointerup", onUp);
					window.removeEventListener("pointercancel", onUp);
				};
			}, [quadDrag, imgRect]); // eslint-disable-line react-hooks/exhaustive-deps
			const applyQuad = async () => {
				const img = imgRef.current;
				const natural = naturalRef.current;
				if (!img || !natural || !quad) return;
				const plan = psWarpPlan({ mode: "distort", src: psQuadCorners(natural.w, natural.h), dst: quad, width: natural.w, height: natural.h });
				if (!plan) {
					onToast?.(t("viewer.quadBad"), "err");
					return;
				}
				try {
					const srcCanvas = document.createElement("canvas");
					srcCanvas.width = natural.w;
					srcCanvas.height = natural.h;
					srcCanvas.getContext("2d").drawImage(img, 0, 0);
					const out = psWarpCanvas(srcCanvas, plan.inverse, plan.size.w, plan.size.h);
					const dataUrl = out.toDataURL("image/png");
					const base = safeName.replace(/\.[a-z0-9]+$/i, "") || "image";
					if (!onQuadApply) throw new Error("no uploader");
					await onQuadApply({ name: `${base}_四点变形.png`, data: dataUrl });
					exitQuad();
				} catch (error) {
					onToast?.(String(error?.message ?? error) || t("viewer.quadFail"), "err");
				}
			};

			const clampZoom = (value) => Math.min(VIEWER_ZOOM_MAX, Math.max(VIEWER_ZOOM_MIN, Number(value) || 1));
			const fit = () => {
				setZoom(1);
				setPan({ x: 0, y: 0 });
			};
			const go = (nextIndex) => {
				if (list.length === 0) return;
				const wrapped = (nextIndex + list.length) % list.length;
				onIndex?.(wrapped);
				fit();
				setBroken(false);
			};
			const step = (factor) => {
				setZoom((value) => {
					const next = clampZoom(value * factor);
					if (next === 1) setPan({ x: 0, y: 0 });
					return next;
				});
			};

			// 键盘：Esc 关、←/→ 翻页、+/- 缩放、0 适应
			useEffect(() => {
				const onKey = (event) => {
					const mine = stageRef.current?.closest("dialog");
					if (!mine?.open || !mine.contains(document.activeElement) || event.defaultPrevented || event.ctrlKey || event.metaKey || event.altKey) return;
					if (event.key === "Escape") {
						// 变形模式里 Esc 只退模式，不关查看器
						if (quadModeRef.current) exitQuad();
						else onClose?.();
					}
					else if (event.key === "ArrowLeft") go(safeIndex - 1);
					else if (event.key === "ArrowRight") go(safeIndex + 1);
					else if (event.key === "+" || event.key === "=") step(1.25);
					else if (event.key === "-" || event.key === "_") step(1 / 1.25);
					else if (event.key === "0") fit();
				};
				window.addEventListener("keydown", onKey);
				return () => window.removeEventListener("keydown", onKey);
			}, [safeIndex, list.length, onClose]); // eslint-disable-line react-hooks/exhaustive-deps

			// 滚轮缩放：React 的 onWheel 在根上是 passive 的，preventDefault 会报警，这里挂原生
			useEffect(() => {
				const node = stageRef.current;
				if (!node) return undefined;
				const onWheel = (event) => {
					event.preventDefault();
					const factor = event.deltaY < 0 ? 1.15 : 1 / 1.15;
					setZoom((value) => clampZoom(value * factor));
				};
				node.addEventListener("wheel", onWheel, { passive: false });
				return () => node.removeEventListener("wheel", onWheel);
			}, []);

			if (!current) return null;
			const absolute = (() => {
				try {
					return new URL(current.url, window.location.origin).toString();
				} catch {
					return current.url;
				}
			})();
			const safeName = String(current.name || "image.png").replace(/[\\/:*?"<>|]+/g, "_");
			const metaLine = [current.model, current.size, current.width && current.height ? `${current.width}×${current.height}` : ""].filter(Boolean).join(" · ");

			return h(
				WorkbenchDialog,
				{ fullscreen:true, label:t("viewer.title"), onDismiss:() => quadModeRef.current ? exitQuad() : onClose?.() },
				h(
					"div",
					{ className: "vig-viewer-body", onClick: (event) => event.stopPropagation() },
					h(
						"header",
						{ className: "vig-viewer-head" },
						h(Icon, { name: "image" }),
						h("span", { className: "vig-viewer-title", title: current.name || "" }, current.name || t("viewer.title")),
						h("span", { className: "vig-viewer-count" }, t("viewer.counter", { i: safeIndex + 1, n: list.length })),
						h("div", { className: "vig-spacer" }),
						h("button", { className: "vig-icon-btn", title: t("viewer.zoomOut"), onClick: () => step(1 / 1.25) }, h(Icon, { name: "zoomOut", size: 14 })),
						h("span", { className: "vig-viewer-zoom" }, `${Math.round(zoom * 100)}%`),
						h("button", { className: "vig-icon-btn", title: t("viewer.zoomIn"), onClick: () => step(1.25) }, h(Icon, { name: "zoomIn", size: 14 })),
						h("button", { className: "vig-icon-btn", title: t("viewer.fit"), onClick: fit }, h(Icon, { name: "fit", size: 14 })),
						h("button", { className: "vig-icon-btn", title: t("viewer.hint"), "aria-label": t("viewer.hint"), onClick: () => onToast?.(t("viewer.hint")) }, h(Icon, { name: "move", size: 14 })),
						h(
							"button",
							{
								className: `vig-icon-btn${quadMode ? " is-on" : ""}`,
								title: t("viewer.quad"),
								onClick: () => (quadMode ? exitQuad() : enterQuad())
							},
							h(Icon, { name: "warp", size: 14 })
						),
						h("button", { className: "vig-icon-btn", title: "Esc", onClick: () => onClose?.() }, h(Icon, { name: "close", size: 14 }))
					),
					h(
						"div",
						{
							className: `vig-viewer-stage${zoom > 1 ? " is-zoomed" : ""}${panning ? " is-panning" : ""}`,
							ref: stageRef,
							onPointerDown: (event) => {
								if (zoom <= 1 || quadModeRef.current) return;
								dragRef.current = { x: event.clientX, y: event.clientY, pan: { ...pan } };
								setPanning(true);
								event.currentTarget.setPointerCapture?.(event.pointerId);
							},
							onPointerMove: (event) => {
								const start = dragRef.current;
								if (!start) return;
								setPan({ x: start.pan.x + (event.clientX - start.x), y: start.pan.y + (event.clientY - start.y) });
							},
							onPointerUp: () => {
								dragRef.current = null;
								setPanning(false);
							},
							onPointerCancel: () => {
								dragRef.current = null;
								setPanning(false);
							},
							onDoubleClick: () => (zoom > 1 ? fit() : setZoom(2)),
							title: t("viewer.hint")
						},
						list.length > 1 ? h("button", { className: "vig-viewer-nav is-prev", title: t("viewer.prev"), onClick: () => go(safeIndex - 1) }, h(Icon, { name: "chevronLeft", size: 18 })) : null,
						broken
							? h("div", { className: "vig-viewer-missing" }, t("viewer.missing"))
							: h("img", {
									ref: imgRef,
									className: "vig-viewer-img",
									src: current.url,
									alt: current.name || "",
									draggable: false,
									onError: () => setBroken(true),
									onLoad: measureQuad,
									style: { transform: `translate(${pan.x}px, ${pan.y}px) scale(${zoom})` }
								}),
						quadMode && quad && imgRect
							? h(
									"svg",
									{ className: "vig-viewer-quad" },
									h("polygon", {
										points: quad
											.map((point) => `${imgRect.left + (point.x / imgRect.w) * imgRect.width},${imgRect.top + (point.y / imgRect.h) * imgRect.height}`)
											.join(" "),
										fill: "rgba(59,130,246,.16)",
										stroke: "#3b82f6",
										"stroke-width": 1.5,
										"stroke-dasharray": "5 3"
									}),
									quad.map((point, handle) =>
										h("circle", {
											key: handle,
											cx: imgRect.left + (point.x / imgRect.w) * imgRect.width,
											cy: imgRect.top + (point.y / imgRect.h) * imgRect.height,
											r: 7,
											fill: handle === quadDrag ? "#2563eb" : "#ffffff",
											stroke: "#2563eb",
											"stroke-width": 2,
											style: { cursor: "move" },
											onPointerDown: (event) => {
												// 角点可以拖到图外：不做任何图内限制
												event.stopPropagation();
												event.preventDefault();
												setQuadDrag(handle);
											}
										})
									)
								)
							: null,
						list.length > 1 ? h("button", { className: "vig-viewer-nav is-next", title: t("viewer.next"), onClick: () => go(safeIndex + 1) }, h(Icon, { name: "chevron", size: 18 })) : null
					),
					current.prompt ? h("div", { className: "vig-viewer-prompt", title: current.prompt }, current.prompt) : null,
					h(
						"footer",
						{ className: "vig-viewer-foot" },
						metaLine ? h("span", { className: "vig-viewer-meta", title: metaLine }, metaLine) : null,
						quadMode ? h("span", { className: "vig-viewer-meta" }, t("viewer.quadTip")) : null,
						h("div", { className: "vig-spacer" }),
						quadMode
							? h(
									"button",
									{ className: "vig-btn is-ghost is-sm", title: t("viewer.quadReset"), onClick: () => setQuad(psQuadCorners(naturalRef.current?.w || 0, naturalRef.current?.h || 0)) },
									h(Icon, { name: "refresh", size: 13 }),
									t("viewer.quadReset")
								)
							: null,
						quadMode
							? h("button", { className: "vig-btn is-primary is-sm", onClick: () => void applyQuad() }, h(Icon, { name: "warp", size: 13 }), t("viewer.quadApply"))
							: null,
						quadMode ? null : onUseReference ? h("button", { className: "vig-btn is-ghost is-sm", onClick: () => onUseReference(current) }, h(Icon, { name: "image", size: 13 }), t("viewer.useRef")) : null,
						onEdit ? h("button", { className: "vig-btn is-ghost is-sm", onClick: () => onEdit(current) }, h(Icon, { name: "crop", size: 13 }), t("viewer.edit")) : null,
						h(
							"button",
							{
								className: "vig-btn is-ghost is-sm",
								onClick: async () => {
									try {
										await navigator.clipboard.writeText(absolute);
										onToast?.(t("chat.copy"));
									} catch {
										onToast?.(absolute);
									}
								}
							},
							h(Icon, { name: "link", size: 13 }),
							t("chat.copy")
						),
						h("a", { className: "vig-btn is-ghost is-sm", href: current.url, target: "_blank", rel: "noreferrer" }, h(Icon, { name: "external", size: 13 }), t("chat.open")),
						onSave ? h("button", { className: "vig-btn is-ghost is-sm", title: t("chat.saveTitle"), onClick: () => onSave(current) }, h(Icon, { name: "download", size: 13 }), t("chat.save")) : null,
						onCopy ? h("button", { className: "vig-btn is-ghost is-sm", title: t("chat.copyImageTitle"), onClick: () => onCopy(current) }, h(Icon, { name: "copy", size: 13 }), t("chat.copyImage")) : null,
						onDownload
							? h("button", { className: "vig-btn is-ghost is-sm", title: t("chat.downloading"), onClick: () => onDownload(current) }, h(Icon, { name: "download", size: 13 }), t("viewer.download"))
							: h("a", { className: "vig-btn is-ghost is-sm", href: current.url, download: safeName }, h(Icon, { name: "download", size: 13 }), t("viewer.download")),
						onDelete ? h("button", { className: "vig-btn is-ghost is-sm is-danger", onClick: () => onDelete(current) }, h(Icon, { name: "trash", size: 13 }), t("viewer.delete")) : null
					)
				)
			);
		}

		/* ------------------------------------------------------------------ *
		 * 上游报错：原样摆出来
		 *
		 * 中转站给的那句「生成请求失败，请查看具体上游错误」是它自己的话，
		 * 真正能定位问题的东西是 HTTP 状态 + 响应体原文 + 实际打的那条地址。
		 * 这三样宿主都随任务一起给下来（job.errorDetail / job.endpoint），
		 * 界面只负责摆出来 + 一键复制，不再让人去猜、去翻日志。
		 * ------------------------------------------------------------------ */

		/** 把一次失败拼成可以整段复制的文本（复制走的和屏幕上看到的一样）。 */
		function upstreamText(job) {
			const detail = job?.errorDetail;
			if (!detail) return String(job?.error ?? "");
			return [
				`${detail.method || "POST"} ${detail.url || ""}`.trim(),
				detail.status ? `HTTP ${detail.status}${detail.statusText ? ` ${detail.statusText}` : ""}` : "",
				detail.code ? `code: ${detail.code}` : "",
				detail.model ? `model: ${detail.model}` : "",
				detail.cause ? `cause: ${detail.cause}` : "",
				"",
				detail.body || job?.error || ""
			]
				.filter((line) => line !== undefined && line !== null && line !== "")
				.join("\n")
				.trim();
		}

		/**
		 * 一次失败的完整呈现：状态 chip + 上游那句话 + 实际请求 + 原始响应体 + 重试 / 复制。
		 * 有原始证据就摆全（一行状态、一行请求、一段响应体），没有就只摆那一行 ——
		 * 老任务（或本地就报的错）不该被凑成三个空壳红框。
		 */
		function JobError({ job, onToast, onRetry }) {
			const detail = job?.errorDetail ?? null;
			const status = detail?.status
				? `HTTP ${detail.status}${detail.statusText ? ` ${detail.statusText}` : ""}`
				: "";
			const body = typeof detail?.body === "string" ? detail.body : "";
			const meta = detail
				? [
						detail.method && detail.url ? `${detail.method} ${detail.url}` : detail.url || "",
						detail.code ? `code ${detail.code}` : "",
						detail.model || job?.model || "",
						detail.cause ? `cause ${detail.cause}` : ""
					].filter(Boolean)
				: [];
			return h(
				"div",
				{ className: "vig-fail" },
				h(
					"div",
					{ className: "vig-fail-head" },
					h("span", { className: "vig-fail-chip" }, status || t("common.failed")),
					h("span", { className: "vig-fail-msg", title: job?.error || t("common.failed") }, job?.error || t("common.failed")),
					h("div", { className: "vig-spacer" }),
					onRetry ? h("button", { className: "vig-mini", onClick: () => onRetry(job) }, t("err.upstreamRetry")) : null,
					h(
						"button",
						{
							className: "vig-mini",
							title: t("err.upstreamCopy"),
							onClick: async () => {
								const text = upstreamText(job);
								try {
									await navigator.clipboard.writeText(text);
									onToast?.(t("err.upstreamCopied"));
								} catch {
									onToast?.(text);
								}
							}
						},
						t("err.upstreamCopy")
					)
				),
				meta.length > 0
					? h(
							"div",
							{ className: "vig-fail-meta" },
							meta.map((line, index) => h("span", { key: index, className: "vig-fail-meta-item", title: line }, line))
						)
					: null,
				body
					? h("pre", { className: "vig-fail-pre" }, body)
					: detail
						? h("div", { className: "vig-fail-none" }, t("err.upstreamNone"))
						: null,
				// 上游 401/403 且本地能解释「key 和接口地址不是一家的」时，宿主带回来的一句话
				detail?.hint ? h("div", { className: "vig-fail-hint" }, detail.hint) : null
			);
		}

		/** 任务里的视频：上游返回的是任务体，能认出地址就给链接，认不出就摆原始响应。 */
		function VideoResult({ job, onToast }) {
			const video = job?.video ?? {};
			const raw = (() => {
				try {
					return JSON.stringify(video.payload ?? null, null, 2);
				} catch {
					return "";
				}
			})();
			return h(
				"div",
				{ className: "vig-video" },
				h(
					"div",
					{ className: "vig-video-head" },
					h("span", { className: "vig-video-chip" }, t("chat.video")),
					h("span", { className: "vig-video-msg", title: video.model || job.model }, video.model || job.model),
					h("div", { className: "vig-spacer" }),
					video.url ? h("a", { className: "vig-mini", href: video.url, target: "_blank", rel: "noreferrer" }, t("chat.open")) : null,
					h(
						"button",
						{
							className: "vig-mini",
							onClick: async () => {
								try {
									await navigator.clipboard.writeText(video.url || raw);
									onToast?.(t("err.upstreamCopied"));
								} catch {
									onToast?.(video.url || raw);
								}
							}
						},
						t("chat.copy")
					)
				),
				video.url ? null : h("div", { className: "vig-video-none" }, t("chat.videoQueued")),
				raw ? h("pre", { className: "vig-video-pre" }, raw.slice(0, 4000)) : null
			);
		}

		/**
		 * 一轮对话 = 我发的那句话（靠右）+ 工作台的回复（靠左）。
		 * 以前只渲染回复，翻记录时看不出「当时让它做了什么」—— 提示词是这条任务的一部分，
		 * 不能只活在输入框里。任务的 prompt 就是发出去的那句话，所以直接用它。
		 */
		function JobTurn({ job, onReuseImage, onToast, onRetry, onRefresh, onPreview, onSave, onDelete, onEdit, onGrid }) {
			const pending = job.status === "queued" || job.status === "running";
			const prompt = typeof job.prompt === "string" ? job.prompt.trim() : "";
			// 气泡里显示用户原话（对话模型改写后的提示词单独留一行，见下面 planNote）
			const displayPrompt = String(job.userText || job.prompt || "").trim();
			/* 进行中占位（用户消息 + 「思考中」气泡）：agent / 生图都可能跑几十秒，
			   没有这个占位用户会以为界面没反应。 */
			if (job.kind === "pending") {
				const meText = String(job.userText || job.prompt || "").trim();
				return h(
					react.Fragment,
					null,
					meText
						? h(
								"article",
								{ className: "vig-turn is-user" },
								h("div", { className: "vig-bubble is-user" }, h("div", { className: "vig-me" }, meText)),
								h("div", { className: "vig-avatar", title: t("chat.me") }, t("chat.meShort"))
							)
						: null,
					h(
						"article",
						{ className: "vig-turn", "data-pending": "1" },
						h("div", { className: "vig-avatar" }, "AI"),
						h(
							"div",
							{ className: "vig-bubble" },
							h("div", { className: "vig-who" }, `${t("chat.assistant")} · ${t("chat.thinking")}`),
							h("div", { className: "vig-typing" }, h("span", null), h("span", null), h("span", null))
						)
					)
				);
			}
			// 过程留痕：这条任务是界面点出来的、对话里工具调的，还是外部程序打进来的。
			// 老记录没有 source —— 宁可不显示，也不瞎猜一个。
			const sourceLabel =
				job.source === "tool" ? t("chat.sourceTool") : job.source === "api" ? t("chat.sourceApi") : job.source === "ui" ? t("chat.sourceUi") : "";
			return h(
				react.Fragment,
				null,
				displayPrompt
					? h(
							"article",
							{ className: "vig-turn is-user" },
							h(
								"div",
								{ className: "vig-bubble is-user" },
								// 这次带着的参考图：缩略图跟着我那条消息走（宿主只存 URL，不存 base64），多张全展示
								((Array.isArray(job.referenceUrls) && job.referenceUrls.length > 0 ? job.referenceUrls : job.referenceUrl ? [job.referenceUrl] : []).slice(0, 4)).map((url, index) =>
									h("img", { className: "vig-me-ref", key: `${url}_${index}`, src: url, alt: "", title: t("chat.meRef") })
								),
								h("div", { className: "vig-me" }, displayPrompt)
							),
							h("div", { className: "vig-avatar", title: t("chat.me") }, t("chat.meShort"))
						)
					: null,
				// 我这条消息下面的三个不抢眼的动作：重试 / 删除 / 编辑（无底色、纯 SVG 图标）
				displayPrompt && (onRetry || onDelete || onEdit)
					? h(
							"div",
							{ className: "vig-turn-acts" },
							onRetry
								? h(
										"button",
										{ className: "vig-mini", title: t("chat.retry"), "aria-label": t("chat.retry"), onClick: () => onRetry(job) },
										h(Icon, { name: "refresh", size: 13 })
									)
								: null,
							onDelete
								? h(
										"button",
										{ className: "vig-mini", title: t("lib.delete"), "aria-label": t("lib.delete"), onClick: () => onDelete(job) },
										h(Icon, { name: "trash", size: 13 })
									)
								: null,
							onEdit
								? h(
										"button",
										{ className: "vig-mini", title: t("chat.editPrompt"), "aria-label": t("chat.editPrompt"), onClick: () => onEdit(job) },
										h(Icon, { name: "edit", size: 13 })
									)
								: null
						)
					: null,
				// 纯对话轮（上下文模型判成 reply）：不出图，助手直接回一句话
				job.kind === "reply" && job.reply
					? h(
							"article",
							{ className: "vig-turn" },
							h("div", { className: "vig-avatar" }, "AI"),
							h(
								"div",
								{ className: "vig-bubble" },
								h(
									"div",
									{ className: "vig-who" },
									`${t("chat.assistant")} · ${job.model || t("chat.context")}`
								),
								h("div", { className: "vig-text" }, job.reply)
							)
						)
					: null,
				// 生成任务/失败卡（对话轮 reply 已经在上面的气泡里画过，不再套一层空壳）
				job.kind === "reply"
					? null
					: h(
					"article",
					{ className: "vig-turn" },
					h("div", { className: "vig-avatar" }, "AI"),
					h(
						"div",
						{ className: "vig-bubble" },
						h(
							"div",
							{ className: "vig-who" },
							`${t("chat.assistant")} · ${job.model} · ${job.size}${job.protocol === GEMINI_NATIVE ? ` · ${[job.aspectRatio, protocolShortLabel(GEMINI_NATIVE)].filter(Boolean).join(" · ")}` : ""}${job.endpoint ? ` · ${job.endpoint}` : ""}`
						),
						// 对话模型把这句话整理成了什么（原话在上面气泡里，这里只摆改写结果）
						job.planNote && job.planNote !== displayPrompt
							? h("div", { className: "vig-who", title: job.planNote }, `${t("chat.planRewrite")} · ${job.planNote}`)
							: null,
						sourceLabel
							? h(
									"div",
									{ className: "vig-who", title: job.sessionId ? `${t("chat.session")}: ${job.sessionId}` : "" },
									`${t("chat.source")} · ${sourceLabel}${job.sessionId ? ` · ${t("chat.session")} ${String(job.sessionId).slice(0, 24)}` : ""}`
								)
							: null,
						pending && !job.stale
							? h(
									"div",
									{ className: "vig-row vig-muted" },
									h("span", { className: "vig-spin" }),
									h("span", null, job.status === "queued" ? t("common.loading") : t("chat.sending"))
								)
							: null,
						// 轮询停了还没终态：别一直转圈，直接说清楚（宿主可能重启过）并给个刷新入口
						pending && job.stale
							? h(
									"div",
									{ className: "vig-fail" },
									h(
										"div",
										{ className: "vig-fail-head" },
										h("span", { className: "vig-fail-chip" }, t("chat.stale")),
										h("span", { className: "vig-fail-msg" }, t("chat.staleHint")),
										h("div", { className: "vig-spacer" }),
										onRefresh ? h("button", { className: "vig-mini", onClick: () => onRefresh() }, t("chat.staleRefresh")) : null
									)
								)
							: null,
						job.error ? h(JobError, { job, onToast, onRetry }) : null,
						job.video ? h(VideoResult, { job, onToast }) : null,
						Array.isArray(job.images) && job.images.length > 0
							? h(
									"div",
									{
										// 按张数给尺寸：单图最多占一半宽（大图才看得清），两张收敛，
										// 三张以上回到小格排开 —— 别让一张图只占 132px 一条。
										className: `vig-grid${job.images.length === 1 ? " is-single" : job.images.length === 2 ? " is-duo" : job.images.length === 3 ? " is-trio" : ""}`,
										"data-count": String(job.images.length)
									},
									(() => {
										// 查看器要能左右翻页：把这一轮的所有图连同「是哪句话生的」一起递过去
										const previewItems = job.images.map((image) => ({
											...image,
											prompt: job.prompt || "",
											model: job.model || "",
											size: job.size || "",
											createdAt: job.createdAt || ""
										}));
										return job.images.map((image, position) =>
											h(Shot, {
												key: image.assetId,
												image,
												onReuse: onReuseImage,
												onGrid,
												onToast,
												onPreview: () => onPreview?.(previewItems, position, "chat"),
												onSave: onSave ? () => onSave(image) : null
											})
										);
									})()
								)
							: null
					)
				)
			);
		}

		function ConversationNav({ items, selected, onSelect }) {
			const list = useRef(null);
			const position = items.findIndex((item) => item.id === selected);
			// 只滚动编号区。切换页面或新建后显示当前编号，不滚动整张工作台。
			useMeasureEffect(() => {
				const box = list.current, active = box?.querySelector('[aria-current="true"]');
				if (!active) return;
				const showActive = () => {
					const bounds = box.getBoundingClientRect(), button = active.getBoundingClientRect();
					const bottom = bounds.top + box.clientTop + box.clientHeight, right = bounds.left + box.clientLeft + box.clientWidth;
					if (button.bottom > bottom) box.scrollTop += Math.ceil(button.bottom - bottom);
					else if (button.top < bounds.top) box.scrollTop += button.top - bounds.top;
					if (button.right > right) box.scrollLeft += Math.ceil(button.right - right);
					else if (button.left < bounds.left) box.scrollLeft += button.left - bounds.left;
				};
				showActive();
				if (typeof ResizeObserver === "undefined") return;
				const observer = new ResizeObserver(showActive);
				observer.observe(box);
				return () => observer.disconnect();
			}, [selected, position, items.length]);
			return h("div", { ref:list, className:"vig-conv-tabs", role:"group", "aria-label":t("chat.convList") },
				items.map((item, index) => {
					const title = item.title || t("chat.untitledConv");
					return h("button", {
						key:item.id, type:"button", className:`vig-conv-tab${item.id === selected ? " is-active" : ""}`,
						"aria-current":item.id === selected ? "true" : undefined, "aria-label":`${index + 1} · ${title}`,
						title:`${title}${item.count ? ` · ${item.count}` : ""}`, "data-conv":item.id, onClick:() => onSelect(item.id)
					}, String(index + 1));
				}));
		}

		function ChatView({ state, actions }) {
			const { config, providers, notes, jobs, busyJobIds, references, draft, conversations, conversationId, isVideoEndpoint, jsonOpen, jsonDraft, setJsonOpen, setJsonDraft, sizeRaw, toggleJsonSize } = state;
			const [overLimit, setOverLimit] = useState(false);
			// 浮层只展示直出参数；编辑通过同一个 JSON 入口。
			const [summaryOpen, setSummaryOpen] = useState(false);
			const summaryBoxRef = useRef(null);
			useEffect(() => {
				if (!summaryOpen) return undefined;
				const onDown = (event) => {
					const box = summaryBoxRef.current;
					if (box && !box.contains(event.target)) setSummaryOpen(false);
				};
				const onKey = (event) => {
					if (event.key === "Escape") setSummaryOpen(false);
				};
				window.addEventListener("pointerdown", onDown);
				window.addEventListener("keydown", onKey);
				return () => {
					window.removeEventListener("pointerdown", onDown);
					window.removeEventListener("keydown", onKey);
				};
			}, [summaryOpen]);
			const inputRef = useRef(null);
			const dropRef = useRef(null);
			const bodyRef = useRef(null);
			const stickRef = useRef(true);
			const previousFeed = useRef({ owner: null, known: new Set() });
			const unreadKeys = useRef(new Set());
			const [atBottom, setAtBottom] = useState(true);
			const [unread, setUnread] = useState(0);
			const clearUnread = () => { unreadKeys.current.clear(); setUnread(0); };
			const scrollToBottom = () => {
				const box = bodyRef.current;
				if (box) box.scrollTop = box.scrollHeight;
				setAtBottom(true);
				clearUnread();
			};
			const trackStick = () => {
				const box = bodyRef.current;
				if (!box) return;
				const nearBottom = box.scrollHeight - box.scrollTop - box.clientHeight <= 12;
				stickRef.current = nearBottom;
				setAtBottom(nearBottom);
				if (nearBottom) clearUnread();
			};
			const jumpToBottom = () => {
				stickRef.current = true;
				scrollToBottom();
			};
			const [dragOver, setDragOver] = useState(false);
			// 输入框旁的「信息卡」：点开先快速选一张，二级「管理」才跳信息管理页
			const [noteOpen, setNoteOpen] = useState(false);
			// 工具行折叠：默认只留「模型 / 尺寸 / 展开器 / 发送」，其余参数收进展开器
			const [toolsOpen, setToolsOpen] = useState(false);
			const noteBoxRef = useRef(null);
			const toolsBoxRef = useRef(null);
			// 展开器面板：点面板外或 Esc 收起（和「信息卡」同一套行为）
			useEffect(() => {
				if (!toolsOpen) return undefined;
				const onDown = (event) => {
					const box = toolsBoxRef.current;
					if (!box) return;
					// 面板内的点击、以及展开/收起按钮本身都不收起
					if (box.contains(event.target)) return;
					if (event.target.closest && event.target.closest("[data-tools-toggle]")) return;
					setToolsOpen(false);
				};
				const onKey = (event) => {
					if (event.key === "Escape") setToolsOpen(false);
				};
				window.addEventListener("pointerdown", onDown);
				window.addEventListener("keydown", onKey);
				return () => {
					window.removeEventListener("pointerdown", onDown);
					window.removeEventListener("keydown", onKey);
				};
			}, [toolsOpen]);
			useEffect(() => {
				if (!noteOpen) return undefined;
				const onDown = (event) => {
					if (noteBoxRef.current && !noteBoxRef.current.contains(event.target)) setNoteOpen(false);
				};
				const onKey = (event) => {
					if (event.key === "Escape") setNoteOpen(false);
				};
				window.addEventListener("pointerdown", onDown);
				window.addEventListener("keydown", onKey);
				return () => {
					window.removeEventListener("pointerdown", onDown);
					window.removeEventListener("keydown", onKey);
				};
			}, [noteOpen]);
			const catalog = useMemo(() => modelCatalogFor(providers, config), [providers, config]);
			const endpoint = config.defaultEndpoint || "auto";
			/* 模型要按「这次要出什么」过滤：图片协议只列图片模型，视频协议只列视频模型，
			   音频 / 向量 / 对话模型不进这个下拉（用户要求：视频参数与图片配置区分开）。
			   分类以宿主给的 modelMeta.kind 为准（中转站目录里带的），没有元数据的按图片算。 */
			const endpointKind = isVideoEndpoint ? "video" : "image";
			const nativeGemini = imageRequestProtocol(endpoint, providerIdForModel(providers, config), providers) === GEMINI_NATIVE, gemini = geminiSettings(config);
			const unavailable = nativeGemini && !geminiReady(state.protocols);
			const pickerModels = usableModelsFor(catalog).filter(id => !nativeGemini || modelKindOf(id, providers) !== "video");
			/* 切到视频协议时，当前模型如果还是图片模型，自动换成该协议下的第一个可用模型
			   （否则下拉里选不到、发出去也多半会报错）。*/
			useEffect(() => {
				if (catalog.models.length === 0 || pickerModels.length === 0) return;
				const currentKind = (catalog.meta[config.defaultModel] || {}).kind || "";
				if (!currentKind || currentKind === endpointKind) return;
				const fallback = pickerModels[0];
				if (!fallback || fallback === config.defaultModel) return;
				void actions.saveConfig({ defaultModel: fallback, activeProviderId: providerIdForModel(providers, config, fallback) || config.activeProviderId });
			}, [endpointKind, config.defaultModel, config.activeProviderId]); // eslint-disable-line react-hooks/exhaustive-deps

			useEffect(() => {
				if (inputRef.current) {
					inputRef.current.style.height = "auto";
					inputRef.current.style.height = `${Math.min(180, inputRef.current.scrollHeight)}px`;
				}
			}, [draft]);

			// 宿主按从新到旧返回；只在属于本地发送的槽位内整理 clientSeq，历史不会被反转或移到远端新增任务之后。
			const orderedJobs = useMemo(() => {
				const timeline = jobs.slice().reverse();
				const local = timeline.filter((job) => Number.isFinite(job.clientSeq)).sort((a, b) => a.clientSeq - b.clientSeq);
				let index = 0;
				return local.length < 2 ? timeline : timeline.map((job) => Number.isFinite(job.clientSeq) ? local[index++] : job);
			}, [jobs]);

			useMeasureEffect(() => {
				const previous = previousFeed.current;
				if (previous.owner !== conversationId) stickRef.current = true;
				const known = new Set(), unseen = new Set();
				let count = 0, pastKnownTail = true;
				// 从尾部数新增；回填更早的历史不算新消息。已受理任务保留 id 别名，完整刷新丢掉 clientSeq 也不重复计数。
				for (let i = orderedJobs.length - 1; i >= 0; i--) {
					const job = orderedJobs[i];
					const id = `id:${job.id}`, seq = Number.isFinite(job.clientSeq) ? `send:${job.clientSeq}` : id;
					const existed = previous.known.has(id) || previous.known.has(seq);
					const wasUnread = unreadKeys.current.has(id) || unreadKeys.current.has(seq);
					if (!stickRef.current && (wasUnread || (pastKnownTail && !existed))) {
						unseen.add(id); unseen.add(seq); count++;
					}
					if (existed) pastKnownTail = false;
					known.add(id); known.add(seq);
				}
				previousFeed.current = { owner: conversationId, known };
				unreadKeys.current = unseen;
				if (stickRef.current) scrollToBottom();
				else setUnread(count);
			}, [conversationId, orderedJobs]);

			// 图片解码、容器伸缩或输入区增高后，仅在读者仍然贴底时跟随；不再全树观察或定时强拉位置。
			useEffect(() => {
				const box = bodyRef.current;
				if (!box) return;
				const follow = () => { if (stickRef.current) scrollToBottom(); };
				const observer = typeof ResizeObserver === "function" ? new ResizeObserver(follow) : null;
				observer?.observe(box);
				if (box.firstElementChild) observer?.observe(box.firstElementChild);
				box.addEventListener("load", follow, true);
				return () => { observer?.disconnect(); box.removeEventListener("load", follow, true); };
			}, []);

			const limit = 500;
			const onInput = (event) => {
				const raw = event.target.value;
				setOverLimit(raw.length > limit);
				actions.setDraft(raw.slice(0, limit));
			};

			const composingRef = useRef(false);
			const submit = () => {
				if (composingRef.current || !draft.trim()) return;
				void actions.generate();
				inputRef.current?.focus({ preventScroll: true });
			};
			const onComposerKeyDown = (event) => {
				if (event.key !== "Enter" || event.defaultPrevented || event.shiftKey || event.altKey) return;
				// 某些输入法在选词回车时只报告 229；让浏览器完成输入法提交，不能吃掉这个键。
				if (composingRef.current || event.nativeEvent?.isComposing || event.nativeEvent?.keyCode === 229) return;
				event.preventDefault();
				if (!event.repeat) submit();
			};
			const editInComposer = (job) => {
				if (!actions.editJob(job)) return;
				const input = inputRef.current;
				input?.focus();
				// 新草稿在下一次提交渲染后才写入 DOM。
				window.requestAnimationFrame(() => {
					if (input && input === document.activeElement) input.setSelectionRange(input.value.length, input.value.length);
				});
			};

			const onDrop = async (event) => {
				event.preventDefault();
				setDragOver(false);
				// 从图库 / 结果卡拖过来的图：带着本站 URL，读回字节后挂成参考图
				const dragged = readImageDrag(event.dataTransfer);
				if (dragged) {
					if (actions.attachImageUrl) await actions.attachImageUrl(dragged);
					return;
				}
				const file = event.dataTransfer?.files?.[0];
				if (!file) return;
				const dataUrl = await fileToDataUrl(file);
				await actions.attachReference({ name: file.name, dataUrl });
			};

			/** 粘贴进来的图：和拖进来 / 点 + 选一张走同一条路（存一份到 uploads，再挂成参考图）。 */
			const onPasteImage = async (file) => {
				try {
					const dataUrl = await fileToDataUrl(file);
					if (await actions.attachReference({ name: pastedImageName(file), dataUrl })) actions.toast?.(t("chat.pasted"));
				} catch (error) {
					actions.toast?.(String(error?.message ?? error), "err");
				}
			};

			const thread = orderedJobs
				.map((job) =>
					h(JobTurn, {
						key: Number.isFinite(job.clientSeq) ? `send:${job.clientSeq}` : job.id,
						job,
						onReuseImage: actions.switchToEdit,
						onToast: actions.toast,
						onRetry: actions.retryJob,
						onRefresh: actions.reload,
						onPreview: actions.openViewer,
						onSave: actions.exportAsset,
						onDelete: actions.deleteJob,
						onGrid: actions.openGrid,
						onEdit: editInComposer
					})
				);

			return h(
				"div",
				{
					className: "vig-main",
					// Ctrl+V 粘图挂在整个工作区上（焦点在模型 / 尺寸下拉里也照样粘得上）。
					// 纯文字粘贴不拦：拿不到图片就让浏览器按默认行为贴进输入框。
					onPaste: (event) => {
						const file = pickClipboardImage(event.clipboardData);
						if (!file) return;
						event.preventDefault();
						void onPasteImage(file);
					}
				},
				/* 编辑当前会话的下一次请求。 */
				jsonOpen ? h(
					WorkbenchDialog,
					{ label: t("chat.jsonBody"), onDismiss: () => setJsonOpen(false) },
					h(
						"div",
						{ className: "vig-modal vig-json-modal", onClick: (event) => event.stopPropagation() },
						h("span", { className: "vig-modal-title" }, t("chat.jsonBody")),
						h("p", { className: "vig-muted", style: { fontSize: 12, margin: "4px 0 10px" } }, t("chat.jsonHint")),
						h(
							"label",
							{ className: "vig-ctx-row", style: { marginBottom: 8 } },
							h("input", { type: "checkbox", className: "vig-ctx-check", checked: nativeGemini || sizeRaw, disabled:nativeGemini, "data-size-raw": "1", onChange: () => toggleJsonSize(!sizeRaw) }),
							h("span", null, t("chat.sizeRaw"))
						),
						h("textarea", {
							className: "vig-input vig-json-editor", "aria-label": t("chat.jsonBody"),
							"data-json-editor": "1",
							value: jsonDraft,
							onChange: (event) => setJsonDraft(event.target.value)
						}),
						h(
							"div",
							{ style: { display: "flex", gap: 8, justifyContent: "flex-end", marginTop: 12 } },
							h("button", { className: "vig-btn", onClick: () => { actions.resetJsonBody(); } }, t("chat.jsonReset")),
							h("button", { className: "vig-btn", onClick: () => setJsonOpen(false) }, "关闭"),
							h("button", { className: "vig-btn is-primary", "data-json-apply": "1", onClick: () => actions.applyJsonBody() }, t("chat.jsonApply"))
						)
					)
				) : null,
				h(
					"div",
					{ className: "vig-main-head" },
					h(Icon, { name: "chat" }),
					h("span", { className: "vig-item-title" }, t("nav.chat")),
					// 会话选择属于导航；头部只保留当前会话的管理操作。
					h(
						"div",
						{ className: "vig-conv", title: t("chat.convMemory") },
						h(
							"button",
							{ className: "vig-icon-btn", title: t("chat.newConv"), onClick: () => void actions.newConversation() },
							h(Icon, { name: "plus", size: 14 })
						),
						h(
							"button",
							{
								className: "vig-icon-btn",
								title: t("chat.renameConv"),
								onClick: () => {
									const current = (conversations || []).find((item) => item.id === conversationId);
									const next = window.prompt(t("chat.renameConv"), current?.title || "");
									if (next != null && next.trim()) void actions.renameConversation(conversationId, next.trim());
								}
							},
							h(Icon, { name: "edit", size: 14 })
						),
						h(
							"button",
							{ className: "vig-icon-btn", title: t("chat.deleteConv"), onClick: () => void actions.deleteConversation() },
							h(Icon, { name: "trash", size: 14 })
						)
					),
					h("div", { className: "vig-spacer" }),
					h(Pill, { tone: config.hasKey ? "ok" : "warn" }, config.hasKey ? t("status.key", { mask: config.keyMask }) : t("status.nokey")),
					state.pending > 0 ? h(Pill, null, t("status.pending", { n: state.pending })) : null
				),
				h(
					"div",
					{ className: "vig-main-body vig-chat-feed", ref: bodyRef, onScroll: trackStick },
					h("div", { className: "vig-chat-content" },
						thread.length > 0 ? h("div", { className: "vig-thread" }, thread) : h(react.Fragment, null,
							h("div", { className: "vig-hint" }, h(Icon, { name: "spark", size: 18 }),
								h("div", null, h("div", { className: "vig-hint-title" }, t("chat.hint.title")), h("div", { className: "vig-hint-sub" }, t("chat.hint.sub")))),
							h("div", { className: "vig-empty" }, t("chat.empty"))
						)
					),
					// 回到底部浮标：上翻历史时出现在右下角，贴底自动收起
					!atBottom
						? h(
								"div",
								{ className: "vig-bottom-dock" },
								h(
									"button",
									{ className: "vig-bottom-jump", onClick: jumpToBottom, title: t("chat.toBottom") },
									h(Icon, { name: "chevronDown", size: 14 }),
									h("span", null, t("chat.toBottom")),
									unread > 0 ? h("span", { className: "vig-bottom-jump-count" }, unread > 99 ? "99+" : String(unread)) : null
								)
							)
						: null
				),
				state.unsent?.length ? h("div", {className:"vig-recover-list"}, state.unsent.map((entry) => h("div", { key:entry.seq, className:"vig-recover", role:"status" },
					h("div", null, h("strong", null, t("chat.noReceiptHint")), h("small", null, entry.error), h("span", {title:entry.text}, entry.text)),
					h("button", {className:"vig-mini", "data-recover-prompt":"1", onClick:()=>actions.recoverUnsent(entry)}, t("chat.restorePrompt")),
					h("button", {className:"vig-icon-btn", "aria-label":t("chat.dismissRecovery"), onClick:()=>actions.dismissUnsent(entry.seq)}, h(Icon, {name:"close"}))))) : null,
				h(
					"div",
					{
						className: `vig-composer${state.generating ? " is-busy" : ""}`,
						ref: dropRef,
						onDragOver: (event) => {
							event.preventDefault();
							setDragOver(true);
						},
						onDragLeave: () => setDragOver(false),
						onDrop
					},
					references.length > 0
						? h(
								"div",
								{ className: "vig-refs", style: dragOver ? { borderColor: "var(--vig-accent)" } : undefined },
								// 一排小矩形卡：缩略图 + 右上角「×」（点哪张删哪张），名字放进 title
								references.map((item, index) =>
									h(
										"div",
										{ className: "vig-ref", key: `${item.url || item.name}_${index}` },
										h("img", { src: item.dataUrl, alt: item.name, title: `${item.name}（第 ${index + 1} 张${state.editMode ? " · 图生图" : ""}）` }),
										h(
											"button",
											{
												className: "vig-ref-x",
												onClick: () => actions.removeReference(index),
												title: t("chat.refClear"),
												"aria-label": t("chat.refClear")
											},
											h(Icon, { name: "close", size: 12 })
										)
									)
								)
							)
						: null,
					unavailable ? h("div", {className:"vig-muted", role:"status", "data-gemini-unavailable":"1"}, t("chat.geminiReload")) : null,
					h("textarea", {
						ref: inputRef,
						className: "vig-input",
						value: draft,
						placeholder: t("chat.placeholder"),
						title: t("chat.sendKeys"), "aria-label": t("chat.placeholder"),
						onChange: onInput,
						onCompositionStart: () => { composingRef.current = true; },
						onCompositionEnd: () => { composingRef.current = false; },
						onBlur: () => { composingRef.current = false; },
						onKeyDown: onComposerKeyDown
					}),
					h(
						"div",
						{ className: `vig-tools${toolsOpen ? " is-open" : ""}` },
						// 沿用原来的 ✨ 入口，但展示真正会提交的参数，而不是无效的聊天开关。
						h("div", {className:"vig-ctx-wrap", ref: summaryBoxRef},
							h("button", {className:`vig-tool${summaryOpen ? " is-open" : ""}`, title:t("chat.requestInfo"), "aria-label":t("chat.requestInfo"), "aria-expanded":summaryOpen, "data-context-toggle":"1", onClick:()=>setSummaryOpen(v=>!v)}, h(Icon,{name:"spark",size:14})),
							summaryOpen ? h("div", {className:"vig-ctx-pop", role:"dialog", "aria-label":t("chat.requestInfo")},
								h("div",{className:"vig-ctx-title"}, t("chat.requestInfo")),
								h("p",{className:"vig-muted"},t("chat.directHint")),
								h("div",{className:"vig-ctx-row"},config.defaultModel || "—"),
								h("div",{className:"vig-ctx-row"}, nativeGemini ? `${protocolShortLabel(GEMINI_NATIVE)} · ${gemini.size} · ${gemini.aspect_ratio} · ×1` : isVideoEndpoint ? config.videoSize : config.defaultSize),
								h("button",{className:"vig-btn",onClick:()=>{setSummaryOpen(false); actions.openJsonBody();}},t("chat.jsonBody"))
							) : null),
						// 工具展开器：一块悬浮面板收纳全部次要参数（上传 / 图库 / 信息卡 / 张数 / 协议 / 计数）
						h(
							"div",
							{ className: `vig-tools-pop${toolsOpen ? " is-open" : ""}`, ref: toolsBoxRef },
						// 尺寸：视频协议按「比例 / 分辨率」两段分开选（像素 size 由两者组合），图片协议走图片尺寸
						nativeGemini ? [
							h("select", {key:"gemini-size", className:"vig-sel", "data-gemini-size":"1", title:t("chat.geminiSize"), "aria-label":t("chat.geminiSize"), value:gemini.size,
								onChange:e => actions.setGeminiOptions({geminiSize:e.target.value})}, geminiTiers(config.defaultModel).map(v => h("option", {key:v,value:v}, v))),
							h("select", {key:"gemini-ratio", className:"vig-sel", "data-gemini-ratio":"1", title:t("chat.geminiRatio"), "aria-label":t("chat.geminiRatio"), value:gemini.aspect_ratio,
								onChange:e => actions.setGeminiOptions({geminiRatio:e.target.value})}, GEMINI_RATIOS.map(v => h("option", {key:v,value:v}, v)))
						] : isVideoEndpoint
							? [
									h(
										"select",
										{
											key: "video-ratio",
											className: "vig-sel",
											style: { width: "auto", height: 28, padding: "0 8px" },
											value: VIDEO_RATIOS.includes(config.videoRatio || "") ? config.videoRatio : "16:9",
											title: `${t("chat.videoRatio")} · ${videoSizeFor(config.videoRatio || "16:9", config.videoResolution || "720p")}`,
											onChange: (event) => {
												const ratio = event.target.value;
												void actions.saveConfig({ videoRatio: ratio, videoSize: videoSizeFor(ratio, config.videoResolution || "720p") });
											}
										},
										VIDEO_RATIOS.map((value) => h("option", { key: value, value, title: `${value} · ${t("chat.videoRatio")}` }, value))
									),
									h(
										"select",
										{
											key: "video-resolution",
											className: "vig-sel",
											style: { width: "auto", height: 28, padding: "0 8px" },
											value: VIDEO_RESOLUTIONS.includes(config.videoResolution || "") ? config.videoResolution : "720p",
											title: `${t("chat.videoResolution")} · ${videoSizeFor(config.videoRatio || "16:9", config.videoResolution || "720p")}`,
											onChange: (event) => {
												const resolution = event.target.value;
												void actions.saveConfig({ videoResolution: resolution, videoSize: videoSizeFor(config.videoRatio || "16:9", resolution) });
											}
										},
										VIDEO_RESOLUTIONS.map((value) => h("option", { key: value, value, title: `${value} · ${t("chat.videoResolution")}` }, value))
									),
									// 时长：上游视频接口的 seconds（4/6/8/10/12 秒）
									h(
										"select",
										{
											key: "video-seconds",
											className: "vig-sel",
											style: { width: "auto", height: 28, padding: "0 8px" },
											value: VIDEO_SECONDS.includes(config.videoSeconds || "") ? config.videoSeconds : "4",
											title: `${t("chat.videoSeconds")} · ${videoSizeFor(config.videoRatio || "16:9", config.videoResolution || "720p")}`,
											onChange: (event) => void actions.saveConfig({ videoSeconds: event.target.value })
										},
										VIDEO_SECONDS.map((value) => h("option", { key: value, value, title: `${value} 秒 · ${t("chat.videoSeconds")}` }, `${value}s`))
									)
								]
							: h(
									"select",
									{
										className: "vig-sel",
										style: { width: "auto", height: 28, padding: "0 8px" },
										value: config.defaultSize,
										onChange: (event) => void actions.saveConfig({ defaultSize: event.target.value })
									},
									sizeOptionsFor(config.defaultSize).map((option) =>
										h("option", { key: option.value, value: option.value, title: sizeOptionTitle(option) }, sizeOptionLabel(option))
									)
								),
						h(ModelPicker, {
							value: config.defaultModel,
							models: pickerModels,
							meta: catalog.meta,
							hints: catalog.owners,
							// 选模型顺手把「当前供应商」切到模型所属那条：两条链各管各的模型，
							// 不切的话界面显示的还是上一条，请求也会跟着上一条跑（踩过 503）。
							onChange: (id) => {
								const ownerId = providerIdForModel(providers, config, id);
								void actions.saveConfig(ownerId && ownerId !== config.activeProviderId ? { defaultModel: id, activeProviderId: ownerId } : { defaultModel: id });
							},
							drop: "up",
							title: isVideoEndpoint ? t("chat.videoSize") : t("chat.model")
						}),
							h(
							"button",
							{ className: "vig-tool", title: t("panel.upload"), onClick: actions.pickFile },
							h(Icon, { name: "plus" })
						),
						h(
							"button",
							{ className: "vig-tool", title: t("panel.pick"), onClick: () => actions.setPickOpen(true) },
							h(Icon, { name: "image" })
						),						// 信息卡：先展开快速选择（点一张直接插进输入框），二级「管理」才跳信息管理页
						h(
							"div",
							{ className: "vig-note-pick", ref: noteBoxRef },
							h(
								"button",
								{
									className: `vig-tool${noteOpen ? " is-on" : ""}`,
									title: t("notes.pickHint"),
									"aria-expanded": noteOpen ? "true" : "false",
									onClick: () => setNoteOpen((value) => !value)
								},
								h(Icon, { name: "note" })
							),
							noteOpen
								? h(
										"div",
										{ className: "vig-note-pop", role: "listbox", "aria-label": t("notes.pickTitle") },
										h(
											"div",
											{ className: "vig-note-pop-head" },
											h("span", { className: "vig-note-pop-title" }, t("notes.pickTitle")),
											h("div", { className: "vig-spacer" }),
											h(
												"button",
												{
													className: "vig-mini",
													onClick: () => {
														setNoteOpen(false);
														actions.setView("notes");
													}
												},
												t("notes.pickManage")
											)
										),
										state.notes.length === 0
											? h(
													"div",
													{ className: "vig-note-pop-empty" },
													h("div", null, t("notes.pickEmpty")),
													h(
														"button",
														{
															className: "vig-mini",
															onClick: () => {
																setNoteOpen(false);
																actions.setView("notes");
															}
														},
														t("notes.pickCreate")
													)
												)
											: state.notes.slice(0, 20).map((note) =>
													h(
														"button",
														{
															key: note.id,
															className: "vig-note-item",
															onClick: () => {
																setNoteOpen(false);
																actions.insertNote(note);
															}
														},
														h("span", { className: "vig-note-item-title" }, note.title || t("notes.new")),
														note.prompt ? h("span", { className: "vig-note-item-prompt" }, note.prompt) : null,
														(note.tags || []).length > 0
															? h(
																	"span",
																	{ className: "vig-note-item-tags" },
																	note.tags.map((tag) => h("span", { className: "vig-tag", key: tag }, tag))
																)
															: null
													)
												),
										state.notes.length > 20
											? h("div", { className: "vig-note-pop-foot" }, t("notes.pickMore", { n: state.notes.length - 20 }))
											: null
									)
								: null
						),
						// 张数只对图片有意义：视频一次一条，视频协议下不显示
						nativeGemini ? h("span", {className:"vig-muted", "data-gemini-count":"1"}, "×1") : isVideoEndpoint
							? null
							: h(
									"select",
									{
										className: "vig-sel",
										style: { width: "auto", height: 28, padding: "0 8px" },
										value: String(config.defaultCount),
										onChange: (event) => void actions.saveConfig({ defaultCount: Number(event.target.value) })
									},
									[1, 2, 3, 4].map((value) => h("option", { key: value, value: String(value) }, `x${value}`))
								),
						// 协议：这次生成打哪条路由（图片生成 / 图片编辑 / 视频生成 …）。
						// 上游报错不在这条行里摆（报错在气泡里给全套证据），这一行只放参数。
						h(
							"select",
							{
								className: "vig-sel vig-endpoint",
								style: { width: "auto", height: 28, padding: "0 8px" },
								value: endpoint,
								title: `${t("prov.endpoint")}：${protocolLabel(state.protocols, endpoint)}\n${t("prov.endpointHint")}`,
								onChange: (event) => void actions.saveConfig({ defaultEndpoint: event.target.value })
							},
							generationProtocols(state.protocols).map((option) =>
								h("option", { key: option.id, value: option.id, disabled:option.disabled, title: option.disabled ? t("chat.geminiReload") : option.label }, protocolShortLabel(option.id) + (option.disabled ? ` · ${t("common.restartNeed")}` : ""))
							)
						),
						h("span", { className: "vig-count" }, overLimit ? t("chat.over") : t("chat.counter", { n: draft.length })),
						),
						// 展开器：点开一块悬浮面板（上传 / 图库 / 信息卡 / 张数 / 协议 / 字数），不是把按钮塞回行里
						h(
							"button",
							{
								className: `vig-tool${toolsOpen ? " is-on" : ""}`,
								title: toolsOpen ? t("chat.collapseTools") : t("chat.expandTools"),
								"aria-label": toolsOpen ? t("chat.collapseTools") : t("chat.expandTools"),
								"aria-expanded": toolsOpen ? "true" : "false",
								"data-tools-toggle": "1",
								onClick: () => setToolsOpen((value) => !value)
							},
							h(Icon, { name: toolsOpen ? "chevronDown" : "chevron", size: 14 })
						),
						// JSON 请求体：查看 / 编辑这次发送给宿主的 /generate body
						h(
							"button",
							{
								className: "vig-tool",
								"data-json-body": "1",
								title: t("chat.jsonBody"),
								"aria-label": t("chat.jsonBody"),
								onClick: () => actions.openJsonBody()
							},
							h(Icon, { name: "note", size: 14 })
						),
						h(
							"button",
							{
								type: "button", className: "vig-send", "data-force-generate": "1",
								"aria-keyshortcuts": "Enter Control+Enter Meta+Enter", title: t("chat.sendKeys"),
								disabled: unavailable || !draft.trim(), onClick: submit
							},
							t("chat.send")
						)
					)
				)
			);
		}

		/** 模型下拉：供应商目录优先，其次运行期默认模型；顺带把目录元数据合并出来。 */
		function modelCatalogFor(providers, config) {
			const ids = new Set();
			const meta = {};
			const owners = {};
			for (const provider of providers) {
				for (const [id, entry] of Object.entries(provider.modelMeta || {})) meta[id] = { ...(meta[id] || {}), ...entry };
				for (const model of provider.models || []) {
					ids.add(model);
					// 这个模型是哪条供应商链给的：写在选项上（不然「选了 GPT 的模型」
					// 根本看不出它归谁管，选路就只能靠猜）。
					if (!owners[model]) owners[model] = provider.name || provider.id;
				}
			}
			if (config.defaultModel) ids.add(config.defaultModel);
			return { models: [...ids], meta, owners };
		}

		/* 模型能干什么：先看目录 kind（权威），**没有元数据时按能力关键词判**。
		   踩过的两个坑：① wan3.0-video-1080p 名字带 video 但上游当图片模型（所以 wan 不进视频词表）；
		   ② grok 目录不给 kind，grok-4.7（对话）会被当成图片模型直接 404（所以要能认出对话模型）。
		   关键词判断顺序：图片 → 视频 → 音频 → 对话；都不命中返回 ""（按图片显示，由用户自己切协议）。 */
		const MODEL_ABILITY = [
			["image", /(^|[-_.])(image|imagine|imagen|dall-?e|flux|banana|seedream|seededit|kolors|recraft|photo|paint)([-_.]|$)/i],
			["video", /(^|[-_.])(video|veo|sora|kling|hailuo|seedance|vidu|runway|pika|t2v|i2v)([-_.]|$)/i],
			["audio", /(^|[-_.])(suno|tts|whisper|audio|music|speech|voice)([-_.]|$)/i],
			["chat", /claude|gpt-[0-9]|gpt-4|gpt-5|gemini|glm|qwen|kimi|deepseek|llama|grok|chat|reasoner|o[1-4](?:-|\.|$)/i]
		];
		function modelAbility(id) {
			const text = String(id || "");
			for (const [kind, pattern] of MODEL_ABILITY) {
				if (pattern.test(text)) return kind;
			}
			return "";
		}
		function modelKindOf(id, providers) {
			for (const provider of providers || []) {
				const kind = provider?.modelMeta?.[id]?.kind;
				if (typeof kind === "string" && kind) return kind;
			}
			return modelAbility(id);
		}
		/** 看起来像「聊天/提问」而不是出图指令（上下文模型失效时的兜底判断）。 */
		function looksLikeChat(text) {
			const value = String(text || "").trim();
			if (!value) return false;
			if (/[?？]|吗|呢|什么|谁|怎么|为什么|如何|是不是|对不对|帮我看看|解释|介绍|你好|在吗/.test(value)) return true;
			// 很短又没有出图动词：多半是聊天
			const drawVerb = /画|生成|出图|做一张|来一张|改|修|换|重绘|合成|加|去掉|删掉|调亮|调暗|裁剪|旋转|放大|缩小|风格/;
			return value.length <= 12 && !drawVerb.test(value);
		}

		/** 当前协议可用的模型（图片/视频两组都给；音频/对话/向量不进生图下拉）。 */
		function usableModelsFor(catalog) {
			return (catalog?.models || []).filter((id) => {
				const kind = (catalog?.meta?.[id] || {}).kind || modelAbility(id);
				if (!kind) return true;
				return kind === "image" || kind === "video";
			});
		}

		/**
		 * 这个模型该由哪条供应商链去跑。规则与宿主 providerForModel() 一致：
		 *   1) 指定/当前供应商的目录里就有它（或还没拉过目录）→ 就是它；
		 *   2) 否则目录里有它的那条供应商 —— 模型属于谁就打到谁那儿；
		 *   3) 都没有才回落到指定/当前/第一条启用的。
		 * 踩过的坑：只发 activeProviderId，模型是 GPT 的、当前是 grok，
		 * 请求就打到 grok 的 baseUrl，回「No available channel for model …」。
		 */
		function providerIdForModel(providers, config, model = config?.defaultModel) {
			const wanted = String(model || "").trim();
			const list = Array.isArray(providers) ? providers : [];
			const enabled = list.filter((item) => item && item.enabled !== false);
			const owns = (provider) => wanted !== "" && Array.isArray(provider?.models) && provider.models.includes(wanted);
			const preferred = list.find((item) => item.id === (config?.activeProviderId || "")) ?? null;
			if (preferred && (wanted === "" || !(preferred.models || []).length || owns(preferred))) return preferred.id;
			const owner = enabled.find(owns) ?? list.find(owns);
			return owner?.id || preferred?.id || enabled[0]?.id || "";
		}

		function modelOptionsFor(providers, config) {
			return modelCatalogFor(providers, config).models;
		}

		/* ------------------------------------------------------------------ *
		 * 模型目录：先按能力（图片 / 视频 / 音频 / 其它），同能力内再按名字前缀分族。
		 * 中转站的模型目录是一长串平铺 id（nano-banana-*、veo_3_1_*、imagen-4.0-*…），
		 * 直接拉一个原生 select 会甩出二十多条无结构选项。
		 *
		 * 分组按中转站自己给的 image_family / video_family.kind —— 那是权威来源。
		 * 名字前缀表只是元数据缺失时的兜底（踩过：omni-flash 靠名字猜成「对话」，
		 * 实际 family 写的是 video / 模式 r2v,t2v）。
		 * ------------------------------------------------------------------ */

		const MODEL_KIND_ORDER = ["image", "video", "audio", "chat", "other"];
		const MODEL_KINDS = [
			{ key: "image", prefixes: ["nano-banana", "imagen", "gpt-image", "flux", "seedream", "qwen-image", "kolors", "ideogram", "dall", "sd"] },
			{
				key: "video",
				prefixes: ["veo", "omni", "sora", "kling", "runway", "pika", "seedance", "wan", "luma", "hunyuan-video", "minimax-video"]
			},
			{ key: "audio", prefixes: ["tts", "audio", "speech", "whisper", "music", "suno", "voice"] }
		];

		// 结尾这些词是变体不是型号：nano-banana-pro / veo-3.1-flash / omni-flash 都该归到同一族
		const MODEL_VARIANT_TAIL = /-(pro|plus|flash|lite|max|mini|turbo|fast|slow|relaxed|ultra|hd|preview|portrait|landscape|extend|t2v|i2v|r2v|8s|4s|s)$/;

		/** 名字前缀 = 去掉版本号与变体后缀：nano-banana-2.1 → nano-banana；veo_3_1_fast_x → veo。 */
		function modelFamily(id) {
			const text = String(id || "").toLowerCase().replace(/_/g, "-");
			const match = text.match(/^([a-z]+(?:-[a-z]+)*?)(?=-\d|\d|$)/);
			let family = (match ? match[1] : text).replace(/-+/g, "-");
			for (let prev = ""; prev !== family; ) {
				prev = family;
				family = family.replace(MODEL_VARIANT_TAIL, "");
			}
			return family || text;
		}

		const MODEL_KIND_KEYS = new Set(["image", "video", "audio", "chat"]);

		/** 有目录元数据就用它，没有才靠名字前缀兜底，都不认就落「其它」。 */
		function modelKind(id, meta = null) {
			const declared = String(meta?.kind ?? "").toLowerCase();
			if (MODEL_KIND_KEYS.has(declared)) return declared;
			const text = String(id || "").toLowerCase();
			const hit = MODEL_KINDS.find((kind) => kind.prefixes.some((prefix) => text.startsWith(prefix)));
			return hit ? hit.key : "other";
		}

		/** 三层结构：能力 → 前缀族 → 模型列表。族按条数多的排前面；未开通的排到族尾。 */
		function groupModels(models, meta = {}) {
			const kinds = new Map();
			for (const raw of models) {
				const id = typeof raw === "string" ? raw : raw?.id;
				if (!id) continue;
				const entry = { id, enabled: meta[id]?.enabled !== false, label: meta[id]?.label || "" };
				const kind = modelKind(id, meta[id]);
				if (!kinds.has(kind)) kinds.set(kind, new Map());
				const families = kinds.get(kind);
				const family = modelFamily(id);
				if (!families.has(family)) families.set(family, []);
				families.get(family).push(entry);
			}
			return MODEL_KIND_ORDER.filter((kind) => kinds.has(kind)).map((kind) => {
				const families = [...kinds.get(kind).entries()]
					.map(([family, list]) => ({
						family,
						models: list
							.slice()
							.sort((a, b) => Number(b.enabled) - Number(a.enabled) || a.id.localeCompare(b.id))
					}))
					.sort((a, b) => b.models.length - a.models.length || a.family.localeCompare(b.family));
				return {
					kind,
					title: t(`model.kind.${kind}`),
					count: families.reduce((sum, item) => sum + item.models.length, 0),
					families
				};
			});
		}

		/**
		 * 模型选择器：默认只显示当前模型，点开才展开分组列表（按需展开，不预先渲染二十多条选项）。
		 * drop="up" 用于输入区（往上弹），"down" 用于页头工具栏。
		 */
		function ModelPicker({ value, models, meta = {}, hints = {}, onChange, allLabel = null, drop = "up", disabled = false, title = null, defaultOpen = false }) {
			const [open, setOpen] = useState(defaultOpen);
			const [query, setQuery] = useState("");
			const box = useRef(null);

			useEffect(() => {
				if (!open) return undefined;
				const onDown = (event) => {
					if (box.current && !box.current.contains(event.target)) setOpen(false);
				};
				const onKey = (event) => {
					if (event.key === "Escape") setOpen(false);
				};
				window.addEventListener("pointerdown", onDown);
				window.addEventListener("keydown", onKey);
				return () => {
					window.removeEventListener("pointerdown", onDown);
					window.removeEventListener("keydown", onKey);
				};
			}, [open]);

			const keyword = query.trim().toLowerCase();
			const groups = useMemo(
				() =>
					groupModels(
						keyword
							? models.filter((item) => {
									const id = typeof item === "string" ? item : item?.id;
									const label = meta[id]?.label || "";
									return `${id} ${label}`.toLowerCase().includes(keyword);
								})
							: models,
						meta
					),
				[models, meta, keyword]
			);
			const total = groups.reduce((sum, group) => sum + group.count, 0);
			const valueKind = modelKind(value, meta[value]);
			const pick = (id) => {
				setOpen(false);
				setQuery("");
				if (id !== value) onChange(id);
			};

			return h(
				"div",
				{ className: "vig-picker", ref: box },
				h(
					"button",
					{
						type: "button",
						className: `vig-pick${open ? " is-open" : ""}`,
						disabled,
						title: title || value,
						"aria-expanded": open ? "true" : "false",
						onClick: () => setOpen((prev) => !prev)
					},
					h(Icon, { name: valueKind === "image" ? "image" : "spark", size: 13 }),
					h("span", { className: "vig-pick-text" }, value || t("model.none")),
					h(Icon, { name: "chevronDown", size: 12 })
				),
				open
					? h(
							"div",
							{ className: `vig-pop is-${drop}`, role: "listbox", "aria-label": t("model.list") },
							h(
								"div",
								{ className: "vig-pop-head" },
								h("input", {
									className: "vig-pop-search",
									placeholder: t("model.search"),
									value: query,
									onChange: (event) => setQuery(event.target.value),
									autoFocus: true
								}),
								h("span", { className: "vig-pop-count" }, t("model.count", { n: total }))
							),
							allLabel
								? h(
										"button",
										{ type: "button", className: `vig-pop-item vig-pop-all${value ? "" : " is-on"}`, onClick: () => pick("") },
										h("span", { className: "vig-pop-item-text" }, allLabel),
										value ? null : h(Icon, { name: "check", size: 13 })
									)
								: null,
							groups.map((group) =>
								h(
									"div",
									{ key: group.kind, className: "vig-pop-group" },
									h(
										"div",
										{ className: "vig-pop-group-head" },
										group.title,
										h("span", { className: "vig-pop-count" }, String(group.count))
									),
									group.families.map((family) =>
										h(
											"div",
											{ key: family.family, className: "vig-pop-family" },
											h(
												"div",
												{ className: "vig-pop-family-head" },
												family.family,
												h("span", { className: "vig-pop-count" }, String(family.models.length))
											),
											family.models.map((entry) =>
												h(
													"button",
													{
														type: "button",
														key: entry.id,
														className: `vig-pop-item${entry.id === value ? " is-on" : ""}${entry.enabled ? "" : " is-off"}`,
														// 模型归哪条供应商链：选中之后请求就该打那条链，
														// 所以选项上直接标出来（不然只看到一串模型名）。
														title: [entry.id, hints[entry.id] || "", entry.enabled ? "" : t("model.disabled")].filter(Boolean).join(" · "),
														onClick: () => pick(entry.id)
													},
													h("span", { className: "vig-pop-item-text" }, entry.id),
													hints[entry.id] ? h("span", { className: "vig-tag" }, hints[entry.id]) : null,
													entry.enabled ? null : h("span", { className: "vig-tag" }, t("model.disabled")),
													entry.id === value ? h(Icon, { name: "check", size: 13 }) : null
												)
											)
										)
									)
								)
							),
							groups.length === 0 ? h("div", { className: "vig-pop-empty" }, t("model.empty")) : null
						)
					: null
			);
		}

		/* ------------------------------------------------------------------ *
		 * 图片管理
		 * ------------------------------------------------------------------ */

		// 图库索引只有原图 URL 的老宿主也能使用。只缓存缩过的 Blob，不把原图或活动 DOM 的 URL 留在 LRU。
		const GALLERY_THUMB_SIDE = 320;
		const thumbCache = new Map(), thumbJobs = new Map(), thumbQueue = [];
		let thumbBytes = 0, thumbActive = 0;
		function rememberThumb(key, blob) {
			thumbCache.set(key, blob);
			thumbBytes += blob.size;
			while (thumbCache.size > 64 || thumbBytes > 8 * 1024 * 1024) {
				const oldest = thumbCache.keys().next().value;
				thumbBytes -= thumbCache.get(oldest).size;
				thumbCache.delete(oldest);
			}
		}

		async function shrinkGalleryBlob(blob, signal, dimensions) {
			let image, temporaryUrl, decodedSmall = false;
			const canvas = document.createElement("canvas");
			try {
				if (typeof createImageBitmap === "function") {
					// 一侧由解码器按比例计算；不能同时指定两侧把实际长宽比拉歪。
					if (dimensions && Math.max(dimensions.w, dimensions.h) > GALLERY_THUMB_SIDE) {
						const side = dimensions.w >= dimensions.h ? "resizeWidth" : "resizeHeight";
						try { image = await createImageBitmap(blob, { [side]: GALLERY_THUMB_SIDE, resizeQuality: "high" }); decodedSmall = true; } catch { /* 不支持 resize 选项的旧引擎 */ }
					}
					if (!image && !signal?.aborted) {
						try { image = await createImageBitmap(blob); } catch { /* 浏览器可能只在 img 解码器支持这个格式。 */ }
					}
				}
				if (signal?.aborted) throw new Error("cancelled");
				if (!image) {
					image = new Image();
					temporaryUrl = URL.createObjectURL(blob);
					await new Promise((resolve, reject) => { image.onload = resolve; image.onerror = reject; image.src = temporaryUrl; });
				}
				if (signal?.aborted) throw new Error("cancelled");
				const w = image.naturalWidth || image.width, h = image.naturalHeight || image.height;
				if (!w || !h) throw new Error("empty image");
				const ratio = Math.min(1, GALLERY_THUMB_SIDE / Math.max(w, h));
				if (!decodedSmall && ratio === 1 && blob.size <= 256 * 1024) return blob;
				canvas.width = Math.max(1, Math.round(w * ratio));
				canvas.height = Math.max(1, Math.round(h * ratio));
				canvas.getContext("2d").drawImage(image, 0, 0, canvas.width, canvas.height);
				return await new Promise((resolve, reject) => canvas.toBlob((out) => out ? resolve(out) : reject(new Error("empty thumbnail")), "image/webp", 0.82));
			} finally {
				image?.close?.();
				if (temporaryUrl) URL.revokeObjectURL(temporaryUrl);
				canvas.width = canvas.height = 0;
			}
		}

		async function loadGalleryThumb(job) {
			const signal = job.controller?.signal;
			for (const url of new Set([job.thumb, job.original].filter(Boolean))) {
				if (!job.listeners.size) break;
				try {
					const response = await fetch(url, { credentials: "same-origin", signal });
					if (!response.ok) continue;
					const blob = await response.blob();
					if (!blob.size || !job.listeners.size || /^(text\/|application\/json)/i.test(blob.type)) continue;
					try { return { blob: await shrinkGalleryBlob(blob, signal, url === job.original ? job.dimensions : null), cache: true }; }
					catch {
						// 没有 canvas 编码器时使用已经下载的原图；不绕过队列重发 HTTP，也不长期缓存大图。
						if (url === job.original && job.listeners.size && blob.type.startsWith("image/")) return { blob, cache: false };
					}
				} catch { /* 预制缩图不存在时，在同一槽内尝试原图。 */ }
			}
			return null;
		}

		function pumpGalleryThumbs() {
			while (thumbActive < 2 && thumbQueue.length) {
				const job = thumbQueue.shift();
				if (!job.listeners.size) continue;
				thumbActive++;
				void loadGalleryThumb(job).then((result) => {
					if (!job.listeners.size) return;
					if (result?.cache && job.key.length < 4096) rememberThumb(job.key, result.blob);
					for (const notify of job.listeners) notify(result?.blob ?? null);
				}).finally(() => {
					if (thumbJobs.get(job.key) === job) thumbJobs.delete(job.key);
					thumbActive--;
					pumpGalleryThumbs();
				});
			}
		}

		function acquireGalleryThumb(key, original, thumb, dimensions, notify) {
			const cached = thumbCache.get(key);
			if (cached) {
				thumbCache.delete(key); thumbCache.set(key, cached);
				notify(cached);
				return () => {};
			}
			let job = thumbJobs.get(key);
			if (!job) {
				job = { key, original, thumb, dimensions, listeners: new Set(), controller: typeof AbortController === "function" ? new AbortController() : null };
				thumbJobs.set(key, job);
				thumbQueue.push(job);
			}
			job.listeners.add(notify);
			pumpGalleryThumbs();
			return () => {
				job.listeners.delete(notify);
				if (!job.listeners.size) {
					if (thumbJobs.get(key) === job) thumbJobs.delete(key);
					const i = thumbQueue.indexOf(job);
					if (i >= 0) thumbQueue.splice(i, 1);
					job.controller?.abort();
				}
			};
		}

		function observeGalleryThumb(node, change) {
			if (typeof IntersectionObserver === "function") {
				const observer = new IntersectionObserver((entries) => change(entries[entries.length - 1].isIntersecting), { rootMargin: "160px" });
				observer.observe(node);
				return () => observer.disconnect();
			}
			// 老浏览器用同一个可见性判据，不能因为没有 observer 就让列表全部取图。
			const measure = () => {
				const r = node.getBoundingClientRect();
				change(r.width > 0 && r.height > 0 && r.bottom >= -160 && r.top <= window.innerHeight + 160 && r.right >= -160 && r.left <= window.innerWidth + 160);
			};
			measure();
			window.addEventListener("scroll", measure, true); window.addEventListener("resize", measure);
			return () => { window.removeEventListener("scroll", measure, true); window.removeEventListener("resize", measure); };
		}

		function GalleryThumb({ asset, ...imgProps }) {
			const ref = useRef(null), [near, setNear] = useState(false), [display, setDisplay] = useState(null);
			const original = asset?.url || "", thumb = asset?.thumbUrl || "";
			const width = Number(asset?.width), height = Number(asset?.height);
			const hasDimensions = Number.isFinite(width) && width > 0 && Number.isFinite(height) && height > 0;
			const hash = asset?.sha256 || "";
			const key = useMemo(() => JSON.stringify([thumb, original, hash]), [thumb, original, hash]);
			useEffect(() => ref.current ? observeGalleryThumb(ref.current, setNear) : undefined, []);
			useEffect(() => {
				if (!near || (!original && !thumb)) return undefined;
				let live = true, objectUrl, reader;
				const release = acquireGalleryThumb(key, original, thumb, hasDimensions ? {w:width, h:height} : null, (blob) => {
					if (!live) return;
					if (!blob) { setDisplay({ key, src: undefined }); return; }
					if (typeof URL.createObjectURL === "function") {
						objectUrl = URL.createObjectURL(blob);
						setDisplay({ key, src: objectUrl });
					} else {
						reader = new FileReader(); reader.onload = () => { if (live) setDisplay({ key, src: reader.result }); };
						reader.readAsDataURL(blob);
					}
				});
				return () => {
					live = false; release(); if (reader?.readyState === 1) reader.abort();
					if (objectUrl) URL.revokeObjectURL(objectUrl);
					setDisplay(null);
				};
			}, [key, original, thumb, near, hasDimensions, width, height]);
			const src = near && display?.key === key ? display.src : undefined;
			const scale = hasDimensions ? Math.min(1, GALLERY_THUMB_SIDE / Math.max(width, height)) : 1;
			return h("img", {
				alt: asset?.name || "", width: hasDimensions ? Math.max(1, Math.round(width * scale)) : 64,
				height: hasDimensions ? Math.max(1, Math.round(height * scale)) : 64,
				...imgProps, ref, srcSet: undefined, src, decoding: "async"
			});
		}

		const GALLERY_GRID_PAGE_SIZE = 12;
		// 只观察图片带本身，不用桌面宽度；记忆的大图模式、分栏拖动和筛选恢复都走这里。
		function useFilmstripCapacity(ref, mounted) {
			const [capacity, setCapacity] = useState(1);
			useMeasureEffect(() => {
				const el = mounted && ref.current;
				if (!el) return;
				function measure() {
					const css = getComputedStyle(el);
					const width = el.clientWidth - parseFloat(css.paddingLeft) - parseFloat(css.paddingRight);
					if (!(width > 0)) return;
					const target = parseFloat(css.getPropertyValue("--vig-thumb-edge")) || 64;
					const gap = parseFloat(css.columnGap) || 0;
					setCapacity(Math.max(1, Math.min(48, Math.round((width + gap) / (target + gap)))));
				}
				measure();
				if (typeof ResizeObserver !== "undefined") {
					const observer = new ResizeObserver(measure); observer.observe(el); return () => observer.disconnect();
				}
				window.addEventListener("resize", measure); return () => window.removeEventListener("resize", measure);
			}, [ref, mounted]);
			return capacity;
		}

		function LibraryView({ state, actions }) {
			const [selected, setSelected] = useState([]);
			const [query, setQuery] = useState("");
			const [model, setModel] = useState("");
			/* 布局密度：S 小图 / M 标准 / L 大图，选一次记一辈子（localStorage） */
			const [density, setDensity] = useState(() => {
				try {
					return localStorage.getItem("vig.library.density") || "standard";
				} catch (error) {
					return "standard";
				}
			});
			const pickDensity = (value) => {
				setDensity(value);
				try {
					localStorage.setItem("vig.library.density", value);
				} catch (error) {
					/* 隐私模式里写不了就只活这一次 */
				}
			};
			/* 视图：网格（三档密度）/ 大图（上方固定大图 + 下方缩略条按容器宽度分页），选择也记忆 */
			const [mode, setMode] = useState(() => {
				try {
					return localStorage.getItem("vig.library.mode") || "grid";
				} catch (error) {
					return "grid";
				}
			});
			const pickMode = (value) => {
				if (value === mode) return;
				if (value === "grid") setGridPage(Math.max(0, Math.floor(activeIndex / GALLERY_GRID_PAGE_SIZE)));
				else {
					setStripGroup(0);
					if (activeIndex < start || activeIndex >= start + GALLERY_GRID_PAGE_SIZE) setActiveId(items[start]?.id || "");
				}
				setSelected([]);
				setMode(value);
				try {
					localStorage.setItem("vig.library.mode", value);
				} catch (error) {
					/* 同上 */
				}
			};
			// 只限制卡片的 DOM，不截断检索、查看器或方向键可达的索引。
			const [stripGroup, setStripGroup] = useState(0);
			const stripRef = useRef(null);
			const [gridPage, setGridPage] = useState(0);
			const gridRef = useRef(null);
			const [activeId, setActiveId] = useState("");
			const items = useMemo(() => {
				const needle = query.trim().toLowerCase();
				if (!model && !needle) return state.library;
				return state.library.filter((asset) => (!model || asset.model === model) &&
					(!needle || `${asset.name} ${asset.prompt} ${asset.model}`.toLowerCase().includes(needle)));
			}, [state.library, model, query]);
			const activeIndex = items.length ? Math.max(0, items.findIndex((asset) => asset.id === activeId)) : -1;
			const current = items[activeIndex] || null;
			const stage = mode === "stage";
			const stripCapacity = useFilmstripCapacity(stripRef, stage && items.length > 0);
			const pageSize = stage ? stripCapacity : GALLERY_GRID_PAGE_SIZE;
			const pages = Math.max(1, Math.ceil(items.length / pageSize));
			// 尾组借前面的相邻图片补齐。显式保留组号：点重叠缩略图时不把整排跳回前一组。
			const groupStart = n => stage ? Math.min(n * pageSize, Math.max(0, items.length - pageSize)) : n * pageSize;
			const preferred = Math.min(stripGroup, pages - 1), preferredStart = groupStart(preferred);
			const activeGroup = activeIndex >= preferredStart && activeIndex < preferredStart + pageSize
				? preferred : Math.max(0, Math.floor(activeIndex / pageSize));
			const page = stage ? activeGroup : Math.min(gridPage, pages - 1);
			const start = groupStart(page);
			const pageItems = useMemo(() => items.slice(start, start + pageSize), [items, start, pageSize]);
			const visibleIds = useMemo(() => new Set(pageItems.map((item) => item.id)), [pageItems]);
			const changePage = (index) => {
				if (index < 0 || index >= pages) return;
				setSelected([]);
				if (stage) { setStripGroup(index); setActiveId(items[index * pageSize].id); }
				else setGridPage(index);
			};
			const resetFilter = (setter, value) => { setter(value); setGridPage(0); setStripGroup(0); setActiveId(""); };
			useEffect(() => { if (gridRef.current) gridRef.current.scrollTop = 0; }, [page, query, model]);
			const visibleSelected = selected.filter((id) => visibleIds.has(id));
			const deletingRef = useRef(false);
			const [deleting, setDeleting] = useState(false);
			useEffect(() => {
				setSelected((list) => list.every((id) => visibleIds.has(id)) ? list : list.filter((id) => visibleIds.has(id)));
			}, [visibleIds]);
			const models = useMemo(() => [...new Set(state.library.map((asset) => asset.model).filter(Boolean))].sort(), [state.library]);
			// 图库里的模型 id 也要用目录元数据分组：供应商记录里那份 modelMeta
			const meta = useMemo(() => {
				const merged = {};
				for (const provider of state.providers || []) {
					for (const id of models) {
						const entry = provider.modelMeta?.[id];
						if (entry) merged[id] = { ...merged[id], ...entry };
					}
				}
				return merged;
			}, [state.providers, models]);
			const stageRef = useRef(null);
			const lastWheelSwitch = useRef(-Infinity);
			/* 切上一张 / 下一张（箭头、键盘、滚轮共用） */
			const stepActive = (direction) => {
				if (items.length === 0) return;
				const index = Math.max(0, items.indexOf(current));
				const next = (index + direction + items.length) % items.length;
				setStripGroup(next >= start && next < start + pageSize ? page : Math.floor(next / pageSize));
				setActiveId(items[next].id);
			};
			const onStageKey = (event) => {
				if (event.target !== event.currentTarget || event.defaultPrevented || items.length < 2 || event.altKey || event.ctrlKey || event.metaKey || event.shiftKey || event.nativeEvent?.isComposing) return;
				if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return;
				event.preventDefault();
				event.stopPropagation();
				stepActive(event.key === "ArrowRight" ? 1 : -1);
			};
			/* 大图模式：滚轮切图 —— 累积 + 节流，避免普通鼠标一滚就跳好几张 */
			useEffect(() => {
				if (mode !== "stage") return undefined;
				const node = stageRef.current;
				if (!node) return undefined;
				let accumulated = 0;
				const onWheel = (event) => {
					if (items.length < 2 || event.ctrlKey || drawRef.current || event.target?.closest?.(".vig-mask-pill")) return;
					event.preventDefault();
					const now = Date.now();
					if (now - lastWheelSwitch.current < 200) return;
					accumulated += event.deltaY;
					if (Math.abs(accumulated) < 40) return;
					lastWheelSwitch.current = now;
					stepActive(accumulated > 0 ? 1 : -1);
					accumulated = 0;
				};
				node.addEventListener("wheel", onWheel, { passive: false });
				return () => node.removeEventListener("wheel", onWheel);
			}, [mode, items, current, start, page, pageSize]);

			/* ---- 局部改图：框选（矩形）+ 画笔（自由笔迹）都产出 mask（白=重画）---- */
			const [tool, setTool] = useState("");
			const [brushSize, setBrushSize] = useState(20);
			const [strokes, setStrokes] = useState([]);
			const [marquee, setMarquee] = useState(null);
			const [maskPrompt, setMaskPrompt] = useState("");
			const [maskBusy, setMaskBusy] = useState(false);
			const frameRef = useRef(null);
			const canvasRef = useRef(null);
			const stageImgRef = useRef(null);
			const drawRef = useRef(null);
			const maskOwner = useRef(null);
			const maskRequest = useRef(null);
			const painting = tool === "marquee" || tool === "brush";
			const hasMask = Boolean((marquee && marquee.w > 2 && marquee.h > 2) || strokes.length > 0);
			const canSubmitMask = painting && hasMask && Boolean(maskPrompt.trim()) && !maskBusy;
			const clearMask = () => {
				drawRef.current = null;
				setMarquee(null);
				setStrokes([]);
				setMaskPrompt("");
			};
			// 键盘、滚轮、筛选和刷新都会改变实际展示的图；在显示新帧前丢弃旧草稿。
			useMeasureEffect(() => {
				maskOwner.current = mode === "stage" && current?.id ? { id: current.id, url: current.url } : null;
				clearMask();
				setTool("");
				setMaskBusy(false);
				return () => { maskOwner.current = null; maskRequest.current = null; drawRef.current = null; };
			}, [mode, current?.id, current?.url]);
			const toNatural = (event) => {
				const img = stageImgRef.current;
				if (!img?.naturalWidth || !img.naturalHeight) return null;
				const rect = img.getBoundingClientRect();
				if (rect.width < 2 || rect.height < 2) return null;
				return {
					x: Math.min(img.naturalWidth, Math.max(0, ((event.clientX - rect.left) / rect.width) * img.naturalWidth)),
					y: Math.min(img.naturalHeight, Math.max(0, ((event.clientY - rect.top) / rect.height) * img.naturalHeight))
				};
			};
			const onInkDown = (event) => {
				if (!painting || !current || maskOwner.current?.id !== current.id || maskRequest.current || drawRef.current || event.button !== 0) return;
				const point = toNatural(event);
				if (!point) return;
				event.preventDefault();
				event.stopPropagation();
				try {
					event.currentTarget.setPointerCapture(event.pointerId);
				} catch (error) {
					/* 忽略 */
				}
				if (tool === "marquee") {
					drawRef.current = { mode: "marquee", pointerId: event.pointerId, start: point };
					setMarquee({ x: point.x, y: point.y, w: 0, h: 0 });
				} else {
					drawRef.current = { mode: "brush", pointerId: event.pointerId };
					setStrokes((list) => [...list, { size: brushSize, points: [point] }]);
				}
			};
			const onInkMove = (event) => {
				const drag = drawRef.current;
				if (!drag || drag.pointerId !== event.pointerId) return;
				const point = toNatural(event);
				if (!point) return;
				if (drag.mode === "marquee") {
					setMarquee({
						x: Math.min(drag.start.x, point.x),
						y: Math.min(drag.start.y, point.y),
						w: Math.abs(point.x - drag.start.x),
						h: Math.abs(point.y - drag.start.y)
					});
				} else {
					setStrokes((list) => {
						if (list.length === 0) return list;
						const last = list[list.length - 1];
						return [...list.slice(0, -1), { ...last, points: [...last.points, point] }];
					});
				}
			};
			const onInkUp = (event) => {
				const drag = drawRef.current;
				if (!drag || event.pointerId !== drag.pointerId) return;
				drawRef.current = null;
				if (drag?.mode === "marquee") setMarquee((box) => (box && (box.w < 3 || box.h < 3) ? null : box));
			};
			/* 预览层：朱红半透明矩形 / 朱红笔迹（只画在图片实际显示区域上） */
			useEffect(() => {
				const canvas = canvasRef.current;
				const img = stageImgRef.current;
				const frame = frameRef.current;
				if (!canvas || !img || !frame || !img.naturalWidth) return;
				const rect = frame.getBoundingClientRect();
				if (rect.width < 2) return;
				const scale = rect.width / img.naturalWidth;
				canvas.width = Math.max(1, Math.round(rect.width));
				canvas.height = Math.max(1, Math.round(rect.height));
				const ctx = canvas.getContext("2d");
				ctx.clearRect(0, 0, canvas.width, canvas.height);
				if (marquee) {
					ctx.fillStyle = "rgba(255,58,0,.18)";
					ctx.fillRect(marquee.x * scale, marquee.y * scale, marquee.w * scale, marquee.h * scale);
					ctx.strokeStyle = "#ff3a00";
					ctx.lineWidth = 1.5;
					ctx.setLineDash([5, 3]);
					ctx.strokeRect(marquee.x * scale, marquee.y * scale, marquee.w * scale, marquee.h * scale);
					ctx.setLineDash([]);
				}
				ctx.strokeStyle = "#ff3a00";
				ctx.lineCap = "round";
				ctx.lineJoin = "round";
				for (const stroke of strokes) {
					const head = stroke.points[0];
					if (!head) continue;
					ctx.lineWidth = Math.max(1, stroke.size * scale);
					ctx.beginPath();
					ctx.moveTo(head.x * scale, head.y * scale);
					for (const point of stroke.points.slice(1)) ctx.lineTo(point.x * scale, point.y * scale);
					if (stroke.points.length === 1) ctx.lineTo(head.x * scale + 0.1, head.y * scale + 0.1);
					ctx.stroke();
				}
			}, [marquee, strokes, current?.id, tool]);
			/* 提交：mask（白=要改的区域）+ 一句指令 → 走图生图局部重画 */
			const submitMask = async () => {
				const prompt = maskPrompt.trim();
				const owner = maskOwner.current;
				const img = stageImgRef.current;
				if (!canSubmitMask || !owner || owner.id !== current?.id || maskRequest.current || drawRef.current || !img?.naturalWidth || !img.naturalHeight) return;
				const request = {};
				maskRequest.current = request;
				const stillHere = () => maskOwner.current === owner && maskRequest.current === request;
				setMaskBusy(true);
				try {
					const naturalW = img.naturalWidth;
					const naturalH = img.naturalHeight;
					const maskCanvas = document.createElement("canvas");
					maskCanvas.width = naturalW;
					maskCanvas.height = naturalH;
					const ctx = maskCanvas.getContext("2d");
					ctx.fillStyle = "#000";
					ctx.fillRect(0, 0, naturalW, naturalH);
					ctx.fillStyle = "#fff";
					ctx.strokeStyle = "#fff";
					ctx.lineCap = "round";
					ctx.lineJoin = "round";
					if (marquee) ctx.fillRect(marquee.x, marquee.y, marquee.w, marquee.h);
					for (const stroke of strokes) {
						const head = stroke.points[0];
						if (!head) continue;
						ctx.lineWidth = Math.max(1, stroke.size);
						ctx.beginPath();
						ctx.moveTo(head.x, head.y);
						for (const point of stroke.points.slice(1)) ctx.lineTo(point.x, point.y);
						if (stroke.points.length === 1) ctx.lineTo(head.x + 0.1, head.y + 0.1);
						ctx.stroke();
					}
					const maskDataUrl = maskCanvas.toDataURL("image/png");
					const imageDataUrl = await urlToDataUrl(new URL(owner.url, window.location.origin).toString());
					if (!stillHere()) return;
					if (!imageDataUrl) throw new Error(t("viewer.missing"));
					const result = await actions.maskEdit({ imageDataUrl, maskDataUrl, prompt, referenceUrl: owner.url });
					if (stillHere() && result?.ok) {
						clearMask();
						if (result.showJob) actions.setView("chat");
					}
				} catch (error) {
					if (stillHere()) actions.toast?.(String(error?.message ?? error), "err");
				} finally {
					if (stillHere()) { maskRequest.current = null; setMaskBusy(false); }
				}
			};

			const toggle = (id) =>
				setSelected((list) => (list.includes(id) ? list.filter((item) => item !== id) : [...list, id]));

			return h(
				"div",
				{ className: "vig-main" },
				h(
					"div",
					{ className: "vig-toolbar" },
					h(Icon, { name: "grid" }),
					h("span", { className: "vig-item-title" }, t("nav.library")),
					h("input", { className: "vig-in", style: { width: 200, height: 30 }, placeholder: t("lib.search"), value: query, onChange: (event) => resetFilter(setQuery, event.target.value) }),
					h(ModelPicker, {
						value: model,
						models,
						meta,
						onChange: (value) => resetFilter(setModel, value),
						allLabel: t("lib.allModels"),
						drop: "down",
						title: t("lib.allModels")
					}),
					h("div", { className: "vig-spacer" }),
					// 视图切换：网格 / 大图（大图 = 上方固定大图 + 下方缩略条滚动）
					h(
						"div",
						{ className: "vig-viewmode", role: "group", "aria-label": t("lib.view"), title: t("lib.view") },
						["grid", "stage"].map((value) =>
							h(
								"button",
								{
									key: value,
									type: "button",
									className: `vig-viewmode-btn${mode === value ? " is-on" : ""}`,
									"aria-pressed": mode === value,
									title: t(`lib.view.${value}`),
									"aria-label": t(`lib.view.${value}`),
									onClick: () => pickMode(value)
								},
								h("span", null, t(`lib.view.${value}`))
							)
						)
					),
					// 布局密度：三段胶囊（小图 / 标准 / 大图），选择记在本地；大图视图下不需要
					mode === "grid"
						? h(
								"div",
								{ className: "vig-density", role: "group", "aria-label": t("lib.density"), title: t("lib.density") },
								["compact", "standard", "large"].map((value) =>
									h(
										"button",
										{
											key: value,
											type: "button",
											className: `vig-density-btn${density === value ? " is-on" : ""}`,
											"aria-pressed": density === value,
											title: t(`lib.density.${value}`),
											onClick: () => pickDensity(value)
										},
										t(`lib.density.${value}`)
									)
								)
							)
						: null,
					visibleSelected.length > 0 ? h("span", { className: "vig-muted" }, t("lib.selected", { n: visibleSelected.length })) : null,
					visibleSelected.length > 0
						? h(
								"button",
								{
									className: "vig-btn is-danger", disabled: deleting,
									onClick: async () => {
										if (deletingRef.current || !window.confirm(t("lib.confirmDelete", { n: visibleSelected.length }))) return;
										deletingRef.current = true;
										setDeleting(true);
										try {
											if (await actions.deleteAssets(visibleSelected)) setSelected((list) => list.filter((id) => !visibleSelected.includes(id)));
										} finally { deletingRef.current = false; setDeleting(false); }
									}
								},
								h(Icon, { name: "trash" }),
								t("lib.delete")
							)
						: null,
					h(
						"button",
						{ className: "vig-btn", onClick: () => void actions.reloadLibrary() },
						h(Icon, { name: "refresh" }),
						t("lib.refresh")
					)
				),
				pages > 1 || state.libraryTotal > state.library.length ? h("nav", { className: "vig-lib-pages", "aria-label": t("lib.pages") },
					pages > 1 ? [
						h("button", { key: "prev", className: "vig-icon-btn", "data-lib-prev": "1", title: t("lib.prevPage"), "aria-label": t("lib.prevPage"), disabled: page === 0, onClick: () => changePage(page - 1) }, h(Icon, { name: "chevronLeft" })),
						h("output", { key: "range" }, `${start + 1}–${start + pageItems.length} / ${items.length}`),
						h("button", { key: "next", className: "vig-icon-btn", "data-lib-next": "1", title: t("lib.nextPage"), "aria-label": t("lib.nextPage"), disabled: page >= pages - 1, onClick: () => changePage(page + 1) }, h(Icon, { name: "chevron" }))
					] : null,
					state.libraryTotal > state.library.length ? h("button", { className: "vig-btn is-ghost is-sm", "data-lib-more": "1", disabled: state.libraryLoadingMore, onClick: actions.loadMoreLibrary },
						t("lib.moreIndex", { n: state.library.length, total: state.libraryTotal })) : null
				) : null,
				items.length === 0
					? h("div", { className: "vig-empty" }, t("lib.empty"))
					: mode === "stage"
						? h(
								"div",
								{ className: `vig-stage-view${painting ? " is-painting" : ""}` },
								h(
									"div",
									{ className: "vig-stage-main", ref: stageRef, tabIndex: 0, role: "region", "aria-label": t("lib.view.stage"), onKeyDown: onStageKey },
									current
										? h(
												"div",
												{
													key: `${current.id}:${current.url}`,
													className: "vig-stage-frame",
													style: painting ? { touchAction: "none" } : undefined,
													ref: frameRef,
													onPointerDown: onInkDown,
													onPointerMove: onInkMove,
													onPointerUp: onInkUp,
													onPointerCancel: onInkUp
												},
												h("img", {
													className: "vig-stage-img",
													ref: stageImgRef,
													src: current.url,
													alt: current.name,
													draggable: false,
													title: t("viewer.title"),
													onClick: () => {
														if (painting) return;
														actions.openViewer(items, Math.max(0, activeIndex), "library");
													},
													...(painting ? { draggable: false } : imageDragProps(current))
												}),
												h("canvas", { className: "vig-stage-ink", ref: canvasRef, "aria-hidden": "true" })
											)
										: null,
									// 左右隐藏式箭头：鼠标进到大图区域才显形（纯 CSS :hover 触发）
									current
										? h(
												"button",
												{
													type: "button",
													className: "vig-stage-nav is-prev",
													title: t("viewer.prev"),
													"aria-label": t("viewer.prev"),
													onClick: () => stepActive(-1)
												},
												h(Icon, { name: "chevronLeft", size: 20 })
											)
										: null,
									current
										? h(
												"button",
												{
													type: "button",
													className: "vig-stage-nav is-next",
													title: t("viewer.next"),
													"aria-label": t("viewer.next"),
													onClick: () => stepActive(1)
												},
												h(Icon, { name: "chevron", size: 20 })
											)
										: null,
									// 工具激活时：信息条让位给「胶囊对话」输入（框选/画笔都是给 model 一句指令）
									painting
										? h(
												"div",
												{ className: "vig-mask-pill" },
												tool === "brush"
													? h(
															"div",
															{ className: "vig-brush-size", title: `${t("lib.brushSize")} ${brushSize}` },
															h("input", {
																type: "range",
																className: "vig-range vig-brush-range",
																min: 1,
																max: 50,
																step: 1,
																value: brushSize,
																"aria-label": t("lib.brushSize"),
																onChange: (event) => setBrushSize(Math.max(1, Math.min(50, Number(event.target.value) || 1)))
															}),
															h("span", { className: "vig-brush-size-val" }, String(brushSize))
														)
													: null,
												h("input", {
													className: "vig-mask-input",
													placeholder: t("lib.maskHint"),
													value: maskPrompt,
													readOnly: maskBusy,
													onChange: (event) => setMaskPrompt(event.target.value),
													onKeyDown: (event) => {
														if (event.key === "Enter" && !event.nativeEvent?.isComposing) {
															event.preventDefault();
															void submitMask();
														}
													}
												}),
												hasMask
													? h(
															"button",
															{
																className: "vig-mask-tool",
																title: t("lib.maskClear"),
																"aria-label": t("lib.maskClear"),
																disabled: maskBusy,
																onClick: clearMask
															},
															h(Icon, { name: "trash", size: 13 })
														)
													: null,
												h(
													"button",
													{
														className: "vig-mask-tool",
														disabled: maskBusy,
														title: t("chat.cancel"),
														"aria-label": t("chat.cancel"),
														onClick: () => {
															setTool("");
															clearMask();
														}
													},
													h(Icon, { name: "close", size: 13 })
												),
												h(
													"button",
													{
														className: "vig-mask-send",
														title: t("lib.maskSend"),
														"aria-label": t("lib.maskSend"),
														disabled: !canSubmitMask,
														onClick: () => void submitMask()
													},
													maskBusy ? h("span", { className: "vig-spin" }) : h(Icon, { name: "send", size: 14 })
												)
											)
										: null
								),
								painting
									? null
									: h(
											"div",
											{ className: "vig-stage-bar" },
									// 名称缩小截断；「模型 · 分辨率 · 计数」和右侧按键群整体居中
									h("span", { className: "vig-stage-name", title: current?.name || "" }, current?.name || ""),
									current
										? h(
												"span",
												{ className: "vig-stage-meta", title: `${current.model || "-"} · ${current.width || "?"}×${current.height || "?"}` },
												`${current.model || "-"} · ${current.width || "?"}×${current.height || "?"}`
											)
										: null,
									h("span", { className: "vig-count" }, `${Math.max(1, activeIndex + 1)} / ${items.length}`),
									h(
										"span",
										{ className: "vig-stage-acts" },
										current
											? h(
													"button",
													{
														className: "vig-icon-btn",
														title: t("viewer.title"),
														"aria-label": t("viewer.title"),
														onClick: () => actions.openViewer(items, Math.max(0, activeIndex), "library")
													},
													h(Icon, { name: "expand", size: 14 })
												)
											: null,
										current
											? h(
													"button",
													{
														className: "vig-icon-btn",
														title: t("lib.rename"),
														"aria-label": t("lib.rename"),
														onClick: async () => {
															const next = window.prompt(t("lib.rename"), current.name);
															if (next != null && next.trim()) await actions.renameAsset(current.id, next.trim());
														}
													},
													h(Icon, { name: "edit", size: 14 })
												)
											: null,
										current
											? h(
													"button",
													{
														className: "vig-icon-btn",
														title: t("chat.saveTitle"),
														"aria-label": t("chat.saveShort"),
														onClick: () => void actions.exportAsset(current)
													},
													h(Icon, { name: "download", size: 14 })
												)
											: null,
										// 局部改图工具：框选 / 画笔（都是给上游一份 mask，白=重画）
										current
											? h(
													"button",
													{
														className: `vig-icon-btn${tool === "marquee" ? " is-on" : ""}`,
														title: t("lib.marquee"),
														"aria-label": t("lib.marquee"),
														"aria-pressed": tool === "marquee",
														onClick: () => setTool(tool === "marquee" ? "" : "marquee")
													},
													h(Icon, { name: "marquee", size: 14 })
												)
											: null,
										current
											? h(
													"button",
													{
														className: `vig-icon-btn${tool === "brush" ? " is-on" : ""}`,
														title: t("lib.brush"),
														"aria-label": t("lib.brush"),
														"aria-pressed": tool === "brush",
														onClick: () => setTool(tool === "brush" ? "" : "brush")
													},
													h(Icon, { name: "pen", size: 14 })
												)
											: null,
										current
											? h(
													"button",
													{ className: "vig-btn is-ghost is-sm", onClick: () => void actions.useAsReference(current) },
													h(Icon, { name: "image", size: 13 }),
													t("chat.reuse")
												)
											: null
									)
								),
								h(
									"div",
									{ className: "vig-strip", ref: stripRef, style: { "--vig-strip-cols":stripCapacity } },
									pageItems.map((asset) =>
										h(
											"button",
											{
												key: asset.id,
												type: "button",
												className: `vig-strip-item${current && asset.id === current.id ? " is-on" : ""}`,
												title: asset.name,
												"aria-pressed": Boolean(current && asset.id === current.id),
												onClick: () => { setStripGroup(page); setActiveId(asset.id); },
												...imageDragProps(asset)
											},
											h(GalleryThumb, { asset, draggable: false })
										)
									)
								)
							)
						: h(
							"div",
							{ className: "vig-tiles", ref: gridRef, "data-density": density },
							pageItems.map((asset, index) =>
								h(
									"div",
									{
										key: asset.id,
										className: `vig-tile${selected.includes(asset.id) ? " is-on" : ""}`,
										onClick: () => toggle(asset.id),
										// 整张卡片可拖：拖进输入区当参考图 / 拖进图片处理 / 拖到文件夹保存
										title: t("common.dragHint"),
										...imageDragProps(asset)
									},
									h("div", { className: "vig-check" }, selected.includes(asset.id) ? h(Icon, { name: "check", size: 12 }) : null),
									h(GalleryThumb, {
										asset,
										alt: asset.name,
										loading: "lazy",
										draggable: false,
										title: t("viewer.title"),
										onClick: (event) => {
											event.stopPropagation();
											actions.openViewer(items, start + index, "library");
										}
									}),
									h(
										"div",
										{ className: "vig-tile-meta" },
										h("div", { className: "vig-tile-name", title: asset.name }, asset.name),
										h(
											"div",
											{ className: "vig-tile-sub", title: `${asset.model || "-"} · ${asset.width || "?"}×${asset.height || "?"}` },
											`${asset.model || "-"} · ${asset.width || "?"}×${asset.height || "?"}`
										),
										// 动作收成无底 SVG 图标：悬停时才出浅底，title/aria 保留原名
										h(
											"div",
											{ className: "vig-tile-acts", onClick: (event) => event.stopPropagation() },
											h(
												"button",
												{
													className: "vig-mini",
													title: t("viewer.title"),
													"aria-label": t("viewer.title"),
													onClick: () => actions.openViewer(items, start + index, "library")
												},
												h(Icon, { name: "expand", size: 13 })
											),
											h(
												"button",
												{
													className: "vig-mini",
													title: t("lib.rename"),
													"aria-label": t("lib.rename"),
													onClick: async () => {
														const next = window.prompt(t("lib.rename"), asset.name);
														if (next != null && next.trim()) await actions.renameAsset(asset.id, next.trim());
													}
												},
												h(Icon, { name: "edit", size: 13 })
											),
											h(
												"button",
												{
													className: "vig-mini",
													title: t("chat.saveTitle"),
													"aria-label": t("chat.saveShort"),
													onClick: () => void actions.exportAsset(asset)
												},
												h(Icon, { name: "download", size: 13 })
											),
											h(
												"button",
												{
													className: "vig-mini",
													title: t("chat.reuse"),
													"aria-label": t("chat.reuse"),
													onClick: () => void actions.useAsReference(asset)
												},
												h(Icon, { name: "image", size: 13 })
											)
										)
									)
								)
							)
						)
			);
		}

		/* ------------------------------------------------------------------ *
		 * 信息管理
		 * ------------------------------------------------------------------ */

		function NotesView({ state, actions }) {
			const [editing, setEditing] = useState(null);
			const saving = useSubmitLock();
			const blank = { id: "", title: "", prompt: "", meta: "", tags: [] };
			const current = editing ?? blank;
			const setField = (patch) => setEditing({ ...current, ...patch });

			return h(
				"div",
				{ className: "vig-main" },
				h(
					"div",
					{ className: "vig-toolbar" },
					h(Icon, { name: "note" }),
					h("span", { className: "vig-item-title" }, t("nav.notes")),
					h("div", { className: "vig-spacer" }),
					h(
						"button",
						{ className: "vig-btn is-primary", onClick: () => setEditing({ ...blank }) },
						h(Icon, { name: "plus" }),
						t("notes.new")
					)
				),
				h(
					"div",
					{ className: "vig-main-body" },
					state.notes.length === 0 && !editing ? h("div", { className: "vig-empty" }, t("notes.empty")) : null,
					h(
						"div",
						{ className: "vig-list", style: { padding: 0 } },
						state.notes.map((note) =>
							h(
								"div",
								{ className: "vig-item", key: note.id },
								h(
									"div",
									{ className: "vig-item-head" },
									h("span", { className: "vig-item-title" }, note.title),
									(note.tags || []).map((tag) => h("span", { className: "vig-tag", key: tag }, tag)),
									h("div", { className: "vig-spacer" }),
									h(
										"button",
										{ className: "vig-mini", onClick: () => actions.insertNote(note) },
										t("notes.insert")
									),
									h("button", { className: "vig-mini", onClick: () => setEditing({ ...note }) }, t("prov.edit")),
									h(
										"button",
										{ className: "vig-mini", onClick: () => { if (window.confirm(`${t("lib.delete")} ${note.title}?`)) void actions.deleteNote(note.id); } },
										t("notes.delete")
									)
								),
								note.prompt ? h("div", { className: "vig-item-body" }, note.prompt) : null,
								note.meta ? h("div", { className: "vig-muted", style: { fontSize: 12 } }, note.meta) : null
							)
						)
					)
				),
				editing
					? h(
							WorkbenchDialog,
							{ label: t("nav.notes"), onDismiss: () => { if (!saving.busy) setEditing(null); } },
							h(
								"fieldset",
								{ className: "vig-modal", disabled: saving.busy, "aria-busy": saving.busy, onClick: (event) => event.stopPropagation() },
								h(
									"div",
									{ className: "vig-row" },
									h("span", { className: "vig-modal-title" }, current.id ? t("notes.title") : t("notes.new")),
									h("div", { className: "vig-spacer" }),
									h("button", { className: "vig-icon-btn", "aria-label": t("prov.close"), onClick: () => setEditing(null) }, h(Icon, { name: "close" }))
								),
								h(
									"label",
									{ className: "vig-field" },
									h("span", { className: "vig-label" }, t("notes.title")),
									h("input", { className: "vig-in", value: current.title, onChange: (event) => setField({ title: event.target.value }) })
								),
								h(
									"label",
									{ className: "vig-field" },
									h("span", { className: "vig-label" }, t("notes.prompt")),
									h("textarea", { className: "vig-area", value: current.prompt, onChange: (event) => setField({ prompt: event.target.value }) })
								),
								h(
									"label",
									{ className: "vig-field" },
									h("span", { className: "vig-label" }, t("notes.meta")),
									h("textarea", { className: "vig-area", value: current.meta, onChange: (event) => setField({ meta: event.target.value }) })
								),
								h(
									"label",
									{ className: "vig-field" },
									h("span", { className: "vig-label" }, t("notes.tags")),
									h("input", {
										className: "vig-in",
										value: current.tagsText ?? (current.tags || []).join(", "),
										onChange: (event) => setField({ tagsText: event.target.value })
									})
								),
								h(
									"div",
									{ className: "vig-row", style: { justifyContent: "flex-end" } },
									h("button", { className: "vig-btn", onClick: () => setEditing(null) }, t("prov.close")),
									h(
										"button",
										{
											className: "vig-btn is-primary", disabled: saving.busy,
											onClick: async () => {
												const { tagsText, ...note } = current;
												const ok = await saving.run(() => actions.saveNote({ ...note, tags: splitFieldList(tagsText ?? (note.tags || []).join(',')) }));
												if (ok) setEditing((active) => active === current ? null : active);
											}
										},
										t("notes.save")
									)
								)
							)
						)
					: null
			);
		}

		/* ------------------------------------------------------------------ *
		 * 供应商管理
		 * ------------------------------------------------------------------ */

		function storageTargetIssue(raw, current) {
			const target = raw.trim();
			const winPath = p => /^(?:[A-Za-z]:[\\/]|[\\/]{2}[^\\/]+[\\/][^\\/]+)/.test(p);
			const windows = winPath(current) || (!current && winPath(target));
			if (!target || /[\0\r\n]/.test(target) || !(windows ? winPath(target) : target.startsWith("/"))) return "prov.storageAbsolute";
			const key = p => (windows ? p.replace(/\\/g, "/").toLowerCase() : p).replace(/\/+$/, "");
			return key(target) === key(current) && current ? "prov.storageSame" : "";
		}

		function StorageMoveDialog({ current, initialTarget, busy, onMove, onClose }) {
			const [target, setTarget] = useState(initialTarget);
			const [error, setError] = useState("");
			const lock = useSubmitLock();
			const pending = busy || lock.busy, issue = storageTargetIssue(target, current);
			const dismiss = () => { if (!pending) onClose(); };
			return h(WorkbenchDialog, {label:t("prov.storageMoveTitle"), onDismiss:dismiss},
				h("form", {className:"vig-modal", "data-storage-dialog":"1", "aria-busy":pending, onSubmit:e => {
					e.preventDefault(); if (pending || issue) return;
					void lock.run(async () => {
						setError("");
						const result = await onMove(target.trim());
						if (result?.ok) onClose(); else setError(result?.message || t("common.failed"));
					});
				}},
					h("strong", {className:"vig-modal-title"}, t("prov.storageMoveTitle")),
					h("div", {className:"vig-muted", style:{overflowWrap:"anywhere"}}, `${t("prov.storageCurrent")}：${current || "—"}`),
					h("label", {className:"vig-field"}, h("span", {className:"vig-label"}, t("prov.storageTarget")),
						h("input", {className:"vig-in", "data-storage-target":"1", value:target, disabled:pending, spellCheck:false, autoComplete:"off",
							placeholder:/^(?:[A-Za-z]:|\\\\)/.test(current) ? "D:\\Media\\Studio" : "/data/studio", "aria-invalid":Boolean(target && issue),
							onChange:e => { setTarget(e.target.value); setError(""); }})),
					h("div", {className:"vig-muted"}, t("prov.storageMovePick")),
					pending ? h("div", {role:"status"}, t("prov.storageBusy")) : error || (issue && target) ? h("div", {className:"vig-prov-test is-bad", role:"alert"}, error || t(issue)) : null,
					h("div", {className:"vig-row", style:{justifyContent:"flex-end", flexWrap:"wrap"}},
						h("button", {type:"button", className:"vig-btn", "data-storage-cancel":"1", disabled:pending, onClick:dismiss}, t("chat.cancel")),
						h("button", {type:"submit", className:"vig-btn is-primary", "data-storage-confirm":"1", disabled:pending || Boolean(issue)}, t("prov.storageConfirm")))));
		}

		function ProvidersView({ state, actions, initialDialog = null }) {
			// initialDialog 只有预览/测试会传：真跑起来永远是空手打开（点「编辑」才弹）。
			const toDraft = (provider) => provider && ({ ...provider, apiKey: "", useRuntimeKey: Boolean(provider.useRuntimeKey ?? provider.usesRuntimeKey), modelsText: (provider.models || []).join(", ") });
			const [dialog, setDialog] = useState(() => toDraft(initialDialog));
			const [testInfo, setTestInfo] = useState(null);
			const draftRevision = useRef(0);
			const testingRevision = useRef(-1);
			const [pendingTest, setPendingTest] = useState(-1);
			const saveLock = useSubmitLock();
			const runtimeLock = useSubmitLock();
			const changeDialog = (next) => {
				draftRevision.current += 1;
				setTestInfo(null);
				setDialog(next);
			};
			const closeDialog = () => changeDialog(null);
			// 只保留改过的运行期字段：重载宿主配置时不会覆盖用户未保存的输入。
			const [runtimeEdits, setRuntimeEdits] = useState({});
			const runtime = { baseUrl: state.config.baseUrl, apiKeyEnv: state.config.apiKeyEnv, dir: state.config.stateDir || "", chatModel: state.config.chatModel || "", contextTurns: state.config.contextTurns ?? 6, ...runtimeEdits };
			const runtimeRevision = useRef(0);
			const editRuntime = (key, value) => { runtimeRevision.current += 1; setRuntimeEdits((prev) => ({ ...prev, [key]: value })); };
			const [runtimeKey, setRuntimeKey] = useState("");
			const [moveDraft, setMoveDraft] = useState(null);
			const [storageResult, setStorageResult] = useState(null);
			const moveStorage = async dir => {
				setStorageResult(null);
				const result = await actions.saveStateDir(dir);
				if (result?.ok) setRuntimeEdits(prev => { const {dir: unused, ...rest} = prev; return rest; });
				setStorageResult(result || null);
				return result;
			};

			const blank = { id: "", name: "", baseUrl: state.config.baseUrl, apiKey: "", useRuntimeKey: false, models: [], note: "" };

			return h(
				"div",
				{ className: "vig-main" },
				h(
					"div",
					{ className: "vig-toolbar" },
					h(Icon, { name: "provider" }),
					h("span", { className: "vig-item-title" }, t("nav.providers")),
					h("span", { className: "vig-toolbar-sub" }, t("prov.listCount", { n: state.providers.length })),
					h("div", { className: "vig-spacer" }),
					h(
						"button",
						{ className: "vig-btn", onClick: () => changeDialog(toDraft(blank)) },
						h(Icon, { name: "plus", size: 14 }),
						t("prov.add")
					)
				),
				h(
					"div",
					{ className: "vig-main-body" },
					h(
						"div",
						{ className: "vig-page" },
						h(Block, { title: t("prov.runtime"), icon: "provider" },
						h(
							"div",
							{ className: "vig-form-grid" },
							h(
								"label",
								{ className: "vig-field" },
								h("span", { className: "vig-label" }, t("prov.baseUrl")),
								h("input", { className: "vig-in", value: runtime.baseUrl, onChange: (event) => editRuntime("baseUrl", event.target.value) })
							),
							h(
								"label",
								{ className: "vig-field" },
								h("span", { className: "vig-label" }, t("prov.keyEnv")),
								h("input", { className: "vig-in", value: runtime.apiKeyEnv, onChange: (event) => editRuntime("apiKeyEnv", event.target.value) })
							)
						),
						h("p", { className: "vig-muted" }, t("prov.chatOnlyHint")),
						h(
							"div",
							{ className: "vig-form-grid" },
							h(
								"label",
								{ className: "vig-field" },
								h("span", { className: "vig-label" }, t("prov.chatModel")),
								h(
									"select",
									{
										className: "vig-in",
										value: runtime.chatModel || "",
										onChange: (event) => editRuntime("chatModel", event.target.value)
									},
									h("option", { value: "" }, t("prov.chatModelAuto")),
									(state.chatModels || []).map((item) => h("option", { key: item.id, value: item.id }, `${item.id} · ${item.providerName}`))
								)
							),
							h(
								"label",
								{ className: "vig-field" },
								h("span", { className: "vig-label" }, t("prov.contextTurns")),
								h("input", {
									className: "vig-in",
									type: "number",
									min: 0,
									max: 12,
									value: runtime.contextTurns ?? 6,
									onChange: (event) => editRuntime("contextTurns", Number(event.target.value))
								})
							)
						),
						h(
							"label",
							{ className: "vig-field" },
							h("span", { className: "vig-label" }, `${t("prov.key")}（${state.config.hasKey ? state.config.keyMask : t("common.empty")}）`),
							h("input", {
								className: "vig-in",
								type: "password",
								placeholder: t("prov.keyHint"),
								value: runtimeKey,
								onChange: (event) => { runtimeRevision.current += 1; setRuntimeKey(event.target.value); }
							})
						),
						h(
							"div",
							{ className: "vig-row" },
							h(
								"button",
								{
									className: "vig-btn is-primary",
									disabled: runtimeLock.busy,
									onClick: () => runtimeLock.run(async () => {
										const rev = runtimeRevision.current;
										const patch = { baseUrl: runtime.baseUrl, apiKeyEnv: runtime.apiKeyEnv, chatModel: runtime.chatModel || "", contextTurns: Number(runtime.contextTurns) || 0 };
										if (runtimeKey.trim()) patch.apiKey = runtimeKey.trim();
										if (await actions.saveConfig(patch) && rev === runtimeRevision.current) {
											setRuntimeKey("");
											setRuntimeEdits((prev) => prev.dir === undefined ? {} : { dir: prev.dir });
										}
									})
								},
								t("prov.save")
							),
							h(
								"button",
								{
									className: "vig-btn",
									"data-runtime-test": "1", disabled: runtimeLock.busy,
									onClick: () => runtimeLock.run(() => actions.testProvider({ scope: "runtime", baseUrl: runtime.baseUrl, apiKey: runtimeKey.trim() }))
								},
								t("prov.test")
							)
						)
						),
						// 素材目录：素材默认存在本地，这里能看 / 能改；换目录时宿主会把现有素材复制过去
						h(
							Block,
							{ title: t("prov.storage"), icon: "folder" },
							h(
								"label",
								{ className: "vig-field" },
								h("span", { className: "vig-label" }, t("prov.storage")),
								h("input", {
									className: "vig-in",
									value: runtime.dir || "", disabled: state.storageBusy,
									placeholder: state.config.stateDir || "",
									onChange: (event) => { setStorageResult(null); editRuntime("dir", event.target.value); }
								})
							),
							h("div", { className: "vig-muted", style: { fontSize: 12 } }, t("prov.storageHint")),
							h(
								"div",
								{ className: "vig-row", style: { flexWrap: "wrap" } },
								h(
									"button",
									{
										className: "vig-btn is-primary",
										disabled: state.storageBusy || !(runtime.dir || "").trim() || (runtime.dir || "").trim() === (state.config.stateDir || ""),
										onClick: () => void moveStorage(runtime.dir.trim())
									},
									t("prov.save")
								),
								h("button", { className: "vig-btn", onClick: () => actions.revealDir() }, h(Icon, { name: "folder", size: 13 }), t("prov.storageOpen")),
										// 弹窗确认目标路径，清理结果以宿主回执为准。
								h(
									"button",
									{
										className: "vig-btn", type:"button", "data-storage-move":"1", disabled:state.storageBusy,
										onClick: () => setMoveDraft(runtime.dir !== state.config.stateDir ? runtime.dir || "" : "")
									},
									h(Icon, { name: "folder", size: 13 }),
									t("prov.storageMove")
								),
								h("div", { className: "vig-spacer" }),
								h("span", { className: "vig-muted", style: { fontSize: 12 } }, `${t("prov.storageCurrent")}：${state.config.stateDir || "-"}`)
							),
							moveDraft == null && (state.storageBusy || storageResult) ? h("div", { className:`vig-prov-test${state.storageBusy ? "" : storageResult?.ok ? " is-ok" : " is-bad"}`, role:storageResult && !storageResult.ok ? "alert" : "status" }, state.storageBusy ? t("prov.storageBusy") : storageResult.message) : null
						),
						state.providers.length === 0
							? h("div", { className: "vig-empty" }, t("prov.empty"))
							: h(
									"div",
									{ className: "vig-page" },
									state.providers.map((provider) => {
										const on = provider.id === state.config.activeProviderId;
										const models = provider.models || [];
										const modelsText = models.length === 0
											? t("prov.modelsNone")
											: models.length === 1
												? models[0]
												: t("prov.modelsMany", { name: models[0], n: models.length });
										return h(
											"div",
											{ key: provider.id, className: `vig-prov${on ? " is-on" : ""}` },
											h(
												"div",
												{ className: "vig-prov-main" },
												h(
													"div",
													{ className: "vig-prov-name" },
													provider.name || provider.id,
													on ? h("span", { className: "vig-tag is-on" }, t("prov.active")) : null
												),
												h("div", { className: "vig-prov-line" }, provider.baseUrl),
												h(
													"div",
													{ className: "vig-prov-line" },
													`${t("prov.keyMask")} ${provider.keyMask || (provider.usesRuntimeKey ? t("prov.keyRuntime") : t("common.empty"))}`,
													h("span", { className: "vig-sep" }, "·"),
													`${t("prov.modelsLabel")} ${modelsText}`,
													provider.note ? h("span", { className: "vig-sep" }, "·") : null,
													provider.note ? `${t("prov.note")} ${provider.note}` : null
												)
											),
											h(
												"div",
												{ className: "vig-prov-acts" },
												on ? null : h("button", { className: "vig-btn is-ghost is-sm", onClick: () => void actions.setActiveProvider(provider.id) }, t("prov.makeActive")),
												h("button", { className: "vig-btn is-ghost is-sm", onClick: () => void actions.refreshModels(provider.id) }, t("prov.refresh")),
												h("button", { className: "vig-btn is-ghost is-sm", onClick: () => changeDialog(toDraft(provider)) }, t("prov.edit")),
												h(
													"button",
													{
														className: "vig-btn is-ghost is-sm is-danger",
														onClick: async () => {
															if (!window.confirm(`${t("lib.delete")} ${provider.name}?`)) return;
															await actions.deleteProvider(provider.id);
														}
													},
													t("lib.delete")
												)
											)
										);
									})
								)
					)
				),
				moveDraft !== null ? h(StorageMoveDialog, {current:state.config.stateDir || "", initialTarget:moveDraft, busy:state.storageBusy, onMove:moveStorage, onClose:() => setMoveDraft(null)}) : null,
				dialog
					? h(
							WorkbenchDialog,
							{ onDismiss: closeDialog, label: dialog.id ? dialog.name : t("prov.add") },
							h(
								"div",
								{ className: "vig-modal", "data-provider-editor": "1" },
								h(
									"div",
									{ className: "vig-row" },
									h("span", { className: "vig-modal-title" }, dialog.id ? dialog.name : t("prov.add")),
									h("div", { className: "vig-spacer" }),
									h("button", { className: "vig-icon-btn", "aria-label": t("prov.close"), onClick: closeDialog }, h(Icon, { name: "close" }))
								),
								h(
									"label",
									{ className: "vig-field" },
									h("span", { className: "vig-label" }, t("prov.name")),
									h("input", { className: "vig-in", value: dialog.name, onChange: (event) => changeDialog({ ...dialog, name: event.target.value }) })
								),
								h(
									"label",
									{ className: "vig-field" },
									h("span", { className: "vig-label" }, t("prov.baseUrl")),
									h("input", { className: "vig-in", value: dialog.baseUrl, onChange: (event) => changeDialog({ ...dialog, baseUrl: event.target.value }) })
								),
								h(
									"label",
									{ className: "vig-field" },
									h("span", { className: "vig-label" }, t("prov.key")),
									h("input", {
										className: "vig-in",
										type: "password",
										placeholder: t("prov.keyHint"),
										value: dialog.apiKey || "",
										onChange: (event) => changeDialog({ ...dialog, apiKey: event.target.value })
									})
								),
								h(
									"label",
									{ className: "vig-field" },
									h("span", { className: "vig-label" }, t("prov.models")),
									h("textarea", {
										className: "vig-in", rows: 2, style: { resize: "vertical", minHeight: 42 },
										"data-provider-models": "1", value: dialog.modelsText,
										onChange: (event) => changeDialog({ ...dialog, modelsText: event.target.value })
									})
								),
								h("label", { className: "vig-field" },
									h("span", null, h("input", { type: "checkbox", "data-provider-runtime-key": "1", disabled: Boolean(dialog.apiKey.trim()), checked: !dialog.apiKey.trim() && dialog.useRuntimeKey,
										onChange: (event) => changeDialog({ ...dialog, useRuntimeKey: event.target.checked }) }), " ", t("prov.key"), " · ", t("prov.keyRuntime"))
								),
								// 端点协议不在这里选：它在「对话生图」输入框那一行（跟着每次生成走）。
								// 供应商这条记录只负责地址 / 密钥 / 模型，别让同一件事有两个家。
								h(
									"label",
									{ className: "vig-field" },
									h("span", { className: "vig-label" }, t("prov.note")),
									h("input", { className: "vig-in", value: dialog.note || "", onChange: (event) => changeDialog({ ...dialog, note: event.target.value }) })
								),
								h(
									"div",
									{ className: "vig-row", style: { justifyContent: "flex-end" } },
									h("button", { className: "vig-btn", onClick: closeDialog }, t("prov.close")),
									h(
										"button",
										{
											className: "vig-btn",
											"data-provider-test": "1", disabled: saveLock.busy || pendingTest === draftRevision.current,
											onClick: async () => {
												const rev = draftRevision.current;
												if (testingRevision.current === rev) return;
												testingRevision.current = rev;
												setPendingTest(rev);
												setTestInfo(null);
												try {
													const payload = await actions.testProvider({ scope: "provider", id: dialog.id, baseUrl: dialog.baseUrl, apiKey: dialog.apiKey, useRuntimeKey: !dialog.apiKey.trim() && dialog.useRuntimeKey });
													if (rev === draftRevision.current) setTestInfo(payload ?? null);
												} finally {
													if (testingRevision.current === rev) { testingRevision.current = -1; setPendingTest(-1); }
												}
											}
										},
										t("prov.test")
									),
									h(
										"button",
										{
											className: "vig-btn is-primary",
											"data-provider-save": "1", disabled: saveLock.busy,
											onClick: () => saveLock.run(async () => {
												const rev = draftRevision.current;
												const { id, name, baseUrl, apiKey, note, modelsText, useRuntimeKey } = dialog;
												const saved = await actions.saveProvider({ id, name, baseUrl, apiKey: apiKey.trim(), note, useRuntimeKey: !apiKey.trim() && useRuntimeKey, models: splitFieldList(modelsText) });
												if (saved && rev === draftRevision.current) closeDialog();
											})
										},
										t("prov.save")
									)
								),
								testInfo
									? h(
											"div",
											{ className: `vig-prov-test${testInfo.ok ? " is-ok" : " is-bad"}` },
											h(
												"div",
												{ className: "vig-prov-test-head" },
												testInfo.ok
													? `${t("prov.testOk")} · ${(testInfo.models || []).length} ${t("prov.testModels")} · ${testInfo.elapsedMs ?? 0}ms`
													: `${t("prov.testBad")} · ${testInfo.error || t("common.failed")}`
											),
											!testInfo.ok && testInfo.detail?.url
												? h(
														"div",
														{ className: "vig-prov-test-line" },
														`${testInfo.detail.method || "GET"} ${testInfo.detail.url}${
															testInfo.detail.status ? ` · HTTP ${testInfo.detail.status}` : ""
														}`
													)
												: null,
											// 最有用的一句：key 和接口地址是不是一家的
											testInfo.hint ? h("div", { className: "vig-prov-test-hint" }, testInfo.hint) : null
										)
									: null
							)
						)
					: null
			);
		}

		/* ------------------------------------------------------------------ *
		 * 右栏检查器：图片 / 信息 / 供应商
		 * ------------------------------------------------------------------ */

		/* ------------------------------------------------------------------ *
		 * 预设卡：标题 + 提示词 + 参考图，点一下就能套进输入框
		 * ------------------------------------------------------------------ */

		/** 卡片墙。一张卡 = 参考图封面 + 标题 + 提示词摘要 + 标签 + 三个动作。 */
		function PresetBoard({ presets, onUse, onEdit, onDelete }) {
			const items = Array.isArray(presets) ? presets : [];
			// 参考图加载失败（文件被挪走 / 图库条目删了）就退回占位，不留一个破图框。
			const [broken, setBroken] = useState(() => ({}));
			if (items.length === 0) return h("div", { className: "vig-empty" }, t("preset.empty"));
			return h(
				"div",
				{ className: "vig-preset-grid" },
				items.map((preset) => {
					const cover = preset.image && broken[preset.id] !== preset.image ? preset.image : "";
					return h(
						"div",
						{ className: "vig-preset-card", key: preset.id, title: preset.prompt || preset.title },
						h(
							"button",
							{ className: "vig-preset-cover", onClick: () => onUse(preset), "aria-label": t("preset.use") },
							cover
								? h("img", {
										src: cover,
										alt: preset.title,
										loading: "lazy",
										onError: () => setBroken((value) => ({ ...value, [preset.id]: preset.image }))
									})
								: h("span", { className: "vig-preset-blank" }, h(Icon, { name: "image" }), t("preset.cover"))
						),
						h(
							"div",
							{ className: "vig-preset-body" },
							h(
								"div",
								{ className: "vig-preset-head" },
								h("span", { className: "vig-preset-title" }, preset.title),
								preset.builtin ? h("span", { className: "vig-tag" }, t("preset.builtin")) : null
							),
							preset.prompt ? h("p", { className: "vig-preset-prompt" }, preset.prompt) : null,
							(preset.tags || []).length > 0
								? h(
										"div",
										{ className: "vig-preset-tags" },
										preset.tags.map((tag) => h("span", { className: "vig-tag", key: tag }, tag))
									)
								: null
						),
						h(
							"div",
							{ className: "vig-preset-foot" },
							h("button", { className: "vig-mini is-primary", onClick: () => onUse(preset) }, t("preset.use")),
							h(
								"div",
								{ className: "vig-preset-acts" },
								h(
									"button",
									{ className: "vig-icon-btn", title: t("preset.edit"), "aria-label": t("preset.edit"), onClick: () => onEdit(preset) },
									h(Icon, { name: "edit" })
								),
								h(
									"button",
									{ className: "vig-mini is-danger", onClick: () => onDelete(preset.id), title: t("preset.delete"), "aria-label": t("preset.delete") },
									h(Icon, { name: "trash" })
								)
							)
						)
					);
				})
			);
		}

		/** 预设卡编辑器：标题 / 提示词 / 参考图（上传或从图库拿）/ 标签。 */
		function PresetDialog({ preset, library, onClose, onSave, onUpload }) {
			const [draftCard, setDraftCard] = useState(() => ({ ...preset }));
			const saving = useSubmitLock();
			const [tagsText, setTagsText] = useState(() => (preset.tags || []).join(", "));
			const imageRevision = useRef(0);
			const [uploading, setUploading] = useState(false);
			const chooseImage = (image) => { ++imageRevision.current; setUploading(false); setField({ image }); };
			const [picking, setPicking] = useState(false);
			const fileRef = useRef(null);
			const setField = (patch) => setDraftCard((value) => ({ ...value, ...patch }));
			const items = Array.isArray(library) ? library : [];
			return h(
				WorkbenchDialog,
				{ label: t("preset.edit"), onDismiss: () => { if (!saving.busy) onClose(); } },
				h(
					"fieldset",
					{ className: "vig-modal", disabled:saving.busy, "aria-busy":saving.busy, onClick: (event) => event.stopPropagation() },
					h(
						"div",
						{ className: "vig-row" },
						h("span", { className: "vig-modal-title" }, preset.id ? t("preset.edit") : t("preset.new")),
						h("div", { className: "vig-spacer" }),
						h("button", { className: "vig-icon-btn", onClick: onClose }, h(Icon, { name: "close" }))
					),
					h(
						"div",
						{ className: "vig-field" },
						h("span", { className: "vig-label" }, t("preset.image")),
						h(
							"div",
							{ className: "vig-preset-ref" },
							draftCard.image
								? h("img", { src: draftCard.image, alt: t("preset.image") })
								: h("span", { className: "vig-preset-blank" }, h(Icon, { name: "image" }), t("preset.cover")),
							h(
								"div",
								{ className: "vig-preset-ref-actions" },
								h("button", { className: "vig-mini", onClick: () => fileRef.current?.click() }, t("preset.upload")),
								h("button", { className: "vig-mini", onClick: () => setPicking((value) => !value) }, t("preset.fromLibrary")),
								draftCard.image ? h("button", { className: "vig-mini", onClick: () => chooseImage("") }, t("preset.clearImage")) : null
							)
						),
						h("input", {
							ref: fileRef,
							type: "file",
							accept: "image/*",
							style: { display: "none" },
							onChange: async (event) => {
								const file = event.target.files?.[0];
								event.target.value = "";
								if (!file) return;
								const token = ++imageRevision.current;
								setUploading(true);
								try {
									const url = await onUpload(file);
									if (url && token === imageRevision.current) setField({ image: url });
								} finally { if (token === imageRevision.current) setUploading(false); }
							}
						}),
						picking
							? h(
									"div",
									{ className: "vig-preset-picker" },
									items.length === 0
										? h("span", { className: "vig-muted", style: { fontSize: 12 } }, t("lib.empty"))
										: items.slice(0, 24).map((asset) =>
												h(
													"button",
													{ className: "vig-preset-pick", key: asset.id, onClick: () => chooseImage(asset.url) },
													h("img", { src: asset.url, alt: asset.name })
												)
											)
								)
							: null
					),
					h(
						"label",
						{ className: "vig-field" },
						h("span", { className: "vig-label" }, t("preset.title")),
						h("input", { className: "vig-in", value: draftCard.title, onChange: (event) => setField({ title: event.target.value }) })
					),
					h(
						"label",
						{ className: "vig-field" },
						h("span", { className: "vig-label" }, t("preset.prompt")),
						h("textarea", { className: "vig-area", value: draftCard.prompt, onChange: (event) => setField({ prompt: event.target.value }) })
					),
					h(
						"label",
						{ className: "vig-field" },
						h("span", { className: "vig-label" }, t("preset.tags")),
						h("input", {
							className: "vig-in",
							value: tagsText,
							onChange: (event) => setTagsText(event.target.value)
						})
					),
					h(
						"div",
						{ className: "vig-row", style: { justifyContent: "flex-end" } },
						h("button", { className: "vig-btn", onClick: onClose }, t("prov.close")),
						h(
							"button",
							{
								className: "vig-btn is-primary", disabled: saving.busy || uploading,
								onClick: async () => {
								const ok = await saving.run(() => onSave({ ...draftCard, tags: splitFieldList(tagsText, 6) }));
									if (ok) onClose();
								}
							},
							t("notes.save")
						)
					)
				)
			);
		}

		function ReferencePicker({ library, onDismiss, onPick }) {
			const pick = useSubmitLock();
			return h(WorkbenchDialog, { label: t("panel.pick"), onDismiss }, h("div", { className: "vig-modal" },
				h("div", { className: "vig-row" }, h("span", {className:"vig-modal-title"}, t("panel.pick")), h("div", {className:"vig-spacer"}),
					h("button", {className:"vig-icon-btn", "aria-label":t("prov.close"), onClick:onDismiss}, h(Icon, {name:"close"}))),
				library.length ? h("div", {className:"vig-grid"}, library.map((asset) => h("button", {key:asset.id, className:"vig-tile", disabled:pick.busy,
					onClick:() => pick.run(async () => { if (await onPick(asset)) onDismiss(); })}, h("img", {src:asset.url, alt:asset.name, loading:"lazy"})))) : h("div", {className:"vig-empty"}, t("lib.empty"))
			));
		}

		function Inspector({ state, actions, open = true, onToggle }) {
			const { references, config, providers, presets, library } = state;
			const [presetEditing, setPresetEditing] = useState(null);

			const onFile = async (file) => {
				if (!file) return;
				const dataUrl = await fileToDataUrl(file);
				await actions.attachReference({ name: file.name, dataUrl });
			};

			const foldable = typeof onToggle === "function";
			// 收起态：整列只剩一条窄签（竖排「图片 · 预设 · 供应商」+ 一个「<」），点一下展开
			if (foldable && open === false) {
				return h(
					"aside",
					{ className: "vig-side is-collapsed" },
					h(
						"button",
						{ className: "vig-side-open", title: t("side.expand"), "aria-label": t("side.expand"), onClick: onToggle },
						h(Icon, { name: "chevronLeft", size: 14 }),
						h("span", { className: "vig-side-open-label" }, t("side.tab"))
					)
				);
			}

			return h(
				"aside",
				{ className: "vig-side" },
				foldable
					? h(
							"div",
							{ className: "vig-side-head" },
							h("span", { className: "vig-side-title" }, t("side.title")),
							h("div", { className: "vig-spacer" }),
							h(
								"button",
								{ className: "vig-icon-btn", title: t("side.collapse"), "aria-label": t("side.collapse"), onClick: onToggle },
								h(Icon, { name: "chevronLeft", size: 14 })
							)
						)
					: null,
				h(
					Block,
					{ title: t("panel.image"), icon: "image" },
					h(
						"div",
						{
							className: "vig-drop",
							onClick: actions.pickFile,
							onDragOver: (event) => {
								event.preventDefault();
								event.currentTarget.classList.add("is-over");
							},
							onDragLeave: (event) => event.currentTarget.classList.remove("is-over"),
							onDrop: async (event) => {
								event.preventDefault();
								event.currentTarget.classList.remove("is-over");
								await onFile(event.dataTransfer?.files?.[0]);
							}
						},
						h(Icon, { name: "upload", size: 18 }),
						h("div", { style: { color: "var(--vig-text)", fontWeight: 600 } }, t("panel.upload")),
						h("div", null, t("panel.image.hint"))
					),
					h(
						"button",
						{ className: "vig-btn", onClick: () => actions.setPickOpen(true) },
						h(Icon, { name: "grid" }),
						t("panel.pick")
					),
					references.length > 0
						? h(
								"div",
								{ className: "vig-row" },
								references.map((item, index) =>
									h(
										"div",
										{ className: "vig-ref", key: `${item.url || item.name}_${index}` },
										h("img", { src: item.dataUrl, alt: item.name, title: `${item.name}（第 ${index + 1} 张）` }),
										h("span", null, item.name),
										h("div", { className: "vig-spacer" }),
										h("button", { className: "vig-icon-btn", title: t("chat.refClear"), onClick: () => actions.removeReference(index) }, h(Icon, { name: "close" }))
									)
								)
							)
						: null
				),
				h(
					Block,
					{ title: t("panel.presets"), icon: "note" },
					h(
						"div",
						{ className: "vig-row" },
						h("button", { className: "vig-btn is-primary", onClick: () => setPresetEditing({ id: "", title: "", prompt: "", image: "", tags: [] }) }, h(Icon, { name: "plus" }), t("preset.new")),
						h("div", { className: "vig-spacer" }),
						h("button", { className: "vig-icon-btn", title: t("preset.reset"), onClick: () => void actions.resetPresets() }, h(Icon, { name: "refresh" }))
					),
					h(PresetBoard, {
						presets,
						onUse: (preset) => void actions.applyPreset(preset),
						onEdit: (preset) => setPresetEditing({ ...preset }),
						onDelete: (id) => { const card = presets.find((item) => item.id === id); if (window.confirm(`${t("lib.delete")} ${card?.title || id}?`)) void actions.deletePreset(id); }
					})
				),
				h(
					Block,
					{ title: t("panel.provider"), icon: "provider" },
					h(
						"select",
						{
							className: "vig-sel",
							value: config.activeProviderId || providerIdForModel(providers, config) || "",
							onChange: (event) => void actions.saveConfig({ activeProviderId: event.target.value })
						},
						providers.map((provider) => h("option", { key: provider.id, value: provider.id }, provider.name))
					),
					h(
						"div",
						{ className: "vig-muted", style: { fontSize: 12 } },
						`${t("prov.baseUrl")}：${providers.find((p) => p.id === (config.activeProviderId || providerIdForModel(providers, config)))?.baseUrl || config.baseUrl}`
					)
					// 密钥与「供应商管理」跳转不在这里重复：密钥是工作区头部那颗胶囊的
					// 活，跳转是左侧导航项的事，检查器只负责「当前用哪个供应商」。
				),
				presetEditing
					? h(PresetDialog, {
							preset: presetEditing,
							library,
							onClose: () => setPresetEditing(null),
							onSave: (card) => actions.savePreset(card),
							onUpload: (file) => actions.uploadPresetImage(file)
						})
					: null
			);
		}

		/* ------------------------------------------------------------------ *
		 * 图片处理工具箱（PS 那套：框选 / 裁切 / 切割拆分 / 旋转 / 矫正 / 画布 / 羽化 / 缩放 / 翻转）
		 *
		 * 全部在浏览器里用 canvas 算，不依赖上游也不落盘：结果有两处出口 ——
		 * 「设为参考图」（走宿主 uploads，接着就能拿去图生图）与本地下载。
		 * 每个动作前把当前位图压进历史，所以撤销/重做是真的能回退一顿操作的。
		 * ------------------------------------------------------------------ */

		const PS_TOOLS = [
			{ id: "select", icon: "marquee" },
			{ id: "transform", icon: "scale" },
			{ id: "crop", icon: "crop" },
			{ id: "split", icon: "scissors" },
			{ id: "rotate", icon: "rotate" },
			{ id: "straighten", icon: "level" },
			{ id: "warp", icon: "warp" },
			{ id: "canvasSize", icon: "expand" },
			{ id: "feather", icon: "feather" },
			{ id: "resize", icon: "scale" },
			{ id: "flip", icon: "flip" },
			// 调整：亮度 / 对比度 / 饱和度 / 色相 / 灰度 / 反相（像素级，纯函数在 psAdjustPixels）
			{ id: "adjust", icon: "sliders" }
		];

		const PS_MAX_HISTORY = 12;

		/** 所有能绑键的动作：9 个工具 + 视图 / 编辑 / 出口。id 就是分发时的指令名。 */
		const PS_ACTIONS = [
			...PS_TOOLS.map((item) => ({ id: `tool.${item.id}`, group: "tools", label: `ps.tool.${item.id}` })),
			{ id: "zoomIn", group: "view", label: "ps.zoom.in" },
			{ id: "zoomOut", group: "view", label: "ps.zoom.out" },
			{ id: "fit", group: "view", label: "ps.zoom.fit" },
			{ id: "actual", group: "view", label: "ps.zoom.actual" },
			{ id: "focus", group: "view", label: "ps.key.focus" },
			{ id: "undo", group: "edit", label: "ps.undo" },
			{ id: "redo", group: "edit", label: "ps.redo" },
			{ id: "selectAll", group: "edit", label: "ps.key.selectAll" },
			{ id: "clearSelection", group: "edit", label: "ps.key.clearSel" },
			{ id: "apply", group: "edit", label: "ps.key.apply" },
			{ id: "download", group: "out", label: "ps.download" },
			{ id: "reference", group: "out", label: "ps.toReference" },
			{ id: "help", group: "out", label: "ps.key.help" }
		];

		/** 默认键位：字母切工具（和 PS 肌肉记忆对齐），组合键做动作。 */
		const PS_DEFAULT_BINDINGS = {
			"tool.select": "v",
			"tool.transform": "t",
			"tool.crop": "c",
			"tool.split": "s",
			"tool.rotate": "r",
			"tool.straighten": "l",
			"tool.warp": "w",
			"tool.canvasSize": "n",
			"tool.feather": "f",
			"tool.resize": "z",
			"tool.flip": "m",
			// 调整（亮度/对比度/饱和度/色相）：Photoshop 里是 ⌘U，这里给一个单键 u
			"tool.adjust": "u",
			zoomIn: "+,=",
			zoomOut: "-,_",
			fit: "ctrl+0",
			actual: "ctrl+1",
			focus: "\\",
			undo: "ctrl+z",
			redo: "ctrl+shift+z,ctrl+y",
			selectAll: "ctrl+a",
			clearSelection: "escape,delete",
			apply: "enter",
			download: "ctrl+s",
			reference: "ctrl+d",
			help: "?"
		};

		/** 兼容老测试/老键位表：工具 → 字母。 */
		const PS_SHORTCUT_TOOLS = Object.fromEntries(
			Object.entries(PS_DEFAULT_BINDINGS)
				.filter(([id, combo]) => id.startsWith("tool.") && /^[a-z0-9]$/.test(combo))
				.map(([id, combo]) => [combo, id.slice(5)])
		);

		const PS_BINDING_ALIASES = { "=": "+", "_": "-", " ": "space", esc: "escape", del: "delete" };

		/** 事件 → 「ctrl+shift+z」这样的组合串。纯函数，键盘怎么算都能离线测。 */
		function psCombo(event) {
			const raw = String(event?.key ?? "");
			if (!raw) return "";
			let key = raw.toLowerCase();
			if (key === "control" || key === "shift" || key === "alt" || key === "meta") return "";
			key = PS_BINDING_ALIASES[key] ?? key;
			const parts = [];
			if (event?.ctrlKey || event?.metaKey) parts.push("ctrl");
			if (event?.altKey) parts.push("alt");
			if (event?.shiftKey) parts.push("shift");
			parts.push(key);
			return parts.join("+");
		}

		/** 组合串 → 好看的样子（Ctrl+Shift+Z / Esc / 「+ / =」）。一个动作可以绑多个，用逗号分。 */
		function psComboLabel(combo) {
			if (!combo) return "";
			return String(combo)
				.split(",")
				.map((item) => item.trim())
				.filter(Boolean)
				.map((item) =>
					item
						.split("+")
						.map((part, index, all) => {
							if (index < all.length - 1) return part === "ctrl" ? "Ctrl" : part.charAt(0).toUpperCase() + part.slice(1);
							const named = { escape: "Esc", enter: "Enter", delete: "Del", space: "Space", backspace: "Backspace", arrowup: "↑", arrowdown: "↓", arrowleft: "←", arrowright: "→" };
							return named[part] ?? (part.length === 1 ? part.toUpperCase() : part);
						})
						.join("+")
				)
				.join(" / ");
		}

		function psBindingMap(overrides) {
			const map = { ...PS_DEFAULT_BINDINGS };
			for (const [id, combo] of Object.entries(overrides || {})) {
				if (combo === null || combo === "") delete map[id];
				else map[id] = String(combo).toLowerCase().split(",").map((item) => item.trim()).filter(Boolean).join(",");
			}
			return map;
		}

		/** 组合串 → 动作 id 的查找表（一个动作多个键位时都要能命中）。 */
		function psLookup(overrides) {
			const lookup = {};
			for (const [id, combo] of Object.entries(psBindingMap(overrides))) {
				for (const one of String(combo).split(",")) {
					const key = one.trim();
					if (key && !lookup[key]) lookup[key] = id;
				}
			}
			return lookup;
		}

		/** 这个组合串被谁占了（换键位时查重）。 */
		function psConflict(overrides, combo, exceptId) {
			const wanted = String(combo || "").trim().toLowerCase();
			if (!wanted) return "";
			for (const [id, value] of Object.entries(psBindingMap(overrides))) {
				if (id === exceptId) continue;
				if (String(value).split(",").map((item) => item.trim()).includes(wanted)) return id;
			}
			return "";
		}

		/**
		 * 事件 → 指令的纯映射。DOM 事件只负责传进来，方便离线逐条测。
		 * 第二参可以传用户改过的键位（只需存和默认不同的部分），不传就走默认。
		 */
		function psShortcut(event, overrides) {
			const combo = psCombo(event);
			if (!combo) return null;
			const id = psLookup(overrides)[combo];
			if (!id) return null;
			if (id.startsWith("tool.")) return { tool: id.slice(5), action: id, combo };
			return { action: id, combo };
		}

		/** 画布：不在 DOM 里挂一个离屏 canvas 就能算像素。 */
		function psCanvas(width, height) {
			const canvas = document.createElement("canvas");
			canvas.width = Math.max(1, Math.round(width));
			canvas.height = Math.max(1, Math.round(height));
			return canvas;
		}

		/* ------------------------------------------------------------------ *
		 * 图层与叠加算法
		 *
		 * 用画布原生的 `globalCompositeOperation`（multiply / screen / overlay / darken /
		 * lighten / lighter）做叠加 —— 这是浏览器自带的正确实现，比手写像素公式少一半错。
		 * `psDrawLayers` 把**可见**图层自下而上叠上去，`psLayerExport` 出一张合成图给导出用。
		 * ------------------------------------------------------------------ */

		const PS_BLEND_MODES = [
			{ id: "normal", op: "source-over", labelKey: "ps.layer.normal" },
			{ id: "multiply", op: "multiply", labelKey: "ps.layer.multiply" },
			{ id: "screen", op: "screen", labelKey: "ps.layer.screen" },
			{ id: "overlay", op: "overlay", labelKey: "ps.layer.overlay" },
			{ id: "darken", op: "darken", labelKey: "ps.layer.darken" },
			{ id: "lighten", op: "lighten", labelKey: "ps.layer.lighten" },
			{ id: "add", op: "lighter", labelKey: "ps.layer.add" }
		];

		/** 混合模式 id → 画布的合成算子；认不出的按正常叠加。 */
		function psBlendOp(id) {
			return (PS_BLEND_MODES.find((mode) => mode.id === id) ?? PS_BLEND_MODES[0]).op;
		}

		/** 把图层自下而上叠到已经画好底图的 ctx 上（不可见图层跳过，不透明度夹在 0..1）。 */
		function psDrawLayers(ctx, layers, width, height, prepare) {
			if (!ctx) return 0;
			let drawn = 0;
			for (const layer of layers ?? []) {
				if (!layer || layer.visible === false || !layer.canvas) continue;
				const opacity = Number.isFinite(Number(layer.opacity)) ? Number(layer.opacity) : 1;
				let bitmap = layer.canvas;
				if (layer.mask) {
					// 有蒙版的层必须走蒙版合成：调用方没给合成器就整层跳过，
					// 绝不「蒙版找不到那就算了」把蒙住的内容原样露出来。
					if (typeof prepare !== "function") continue;
					// 目标框 = 底图框（width×height）：图层和蒙版按同一个框铺，不会各缩各的错位
					bitmap = prepare(layer, width, height);
				}
				if (!bitmap) continue;
				ctx.save();
				ctx.globalAlpha = Math.max(0, Math.min(1, opacity));
				if (layer.compositeResult && psBlendOp(layer.mode) === "source-over") {
					// 完整画面的透明像素也是结果。带蒙版/强度时，按覆盖率混合两份预乘 RGBA。
					if (!layer.mask && ctx.globalAlpha === 1) ctx.globalCompositeOperation = "copy";
					else {
						ctx.globalCompositeOperation = "destination-out";
						if (layer.mask) ctx.drawImage(layer.mask.canvas, 0, 0, width, height);
						else { ctx.fillStyle = "#fff"; ctx.fillRect(0, 0, width, height); }
						ctx.globalCompositeOperation = "lighter";
					}
				} else ctx.globalCompositeOperation = psBlendOp(layer.mode);
				ctx.drawImage(bitmap, 0, 0, width, height);
				ctx.restore();
				drawn += 1;
			}
			return drawn;
		}

		/* ------------------------------------------------------------------ *
		 * 像素调整：亮度 / 对比度 / 饱和度 / 色相，外加灰度与反相。
		 * 直接改 Uint8ClampedArray（ImageData.data），纯函数、不碰 canvas —— Node 里也能测。
		 * 亮度/对比度/饱和度都用 -100..100 的整数，色相 -180..180（度）。
		 * ------------------------------------------------------------------ */

		/* ------------------------------------------------------------------ *
		 * 图层蒙版
		 *
		 * 蒙版是一张**只有 alpha 有用**的图：alpha=255 露出来，0 藏起来。合成时把图层画到
		 * 临时画布上，再用画布自带的 `destination-in` 把蒙版乘上去（dest = dest × src.alpha）。
		 * 覆盖率本身由 psMaskAlpha / psInvertAlpha 算 —— 纯数组，Node 里能测。
		 * ------------------------------------------------------------------ */

		/** 尺寸归一化：非数字 / 0 / 负数一律退回后备值（至少 1）。 */
		function psMaskSize(value, fallback) {
			const at = Math.round(Number(value));
			if (Number.isFinite(at) && at > 0) return at;
			const back = Math.round(Number(fallback));
			return Number.isFinite(back) && back > 0 ? back : 1;
		}

		/** 蒙版该按哪个尺寸铺：优先蒙版自己的画布（= 蒙版坐标系），没有才跟图层 / 底图走。 */
		function psMaskDims(mask, fallbackCanvas) {
			const canvas = mask?.canvas ?? null;
			return {
				w: psMaskSize(canvas?.width, psMaskSize(fallbackCanvas?.width, 1)),
				h: psMaskSize(canvas?.height, psMaskSize(fallbackCanvas?.height, 1))
			};
		}

		/** 按选区出蒙版覆盖率：选区里 255、外面 0；没有选区就整张 255（全可见）。 */
		function psMaskAlpha(width, height, selection) {
			const w = psMaskSize(width, 1);
			const h = psMaskSize(height, 1);
			const alpha = new Uint8ClampedArray(w * h);
			if (!selection || typeof selection !== "object") {
				alpha.fill(255);
				return alpha;
			}
			const x = Number(selection.x);
			const y = Number(selection.y);
			const w2 = Number(selection.w);
			const h2 = Number(selection.h);
			// 选区字段坏了（NaN / 缺字段）一个像素都不放：宁可全藏，也不能把整层露白
			if (![x, y, w2, h2].every(Number.isFinite)) return alpha;
			const x0 = Math.max(0, Math.floor(x));
			const y0 = Math.max(0, Math.floor(y));
			const x1 = Math.min(w, Math.ceil(x + w2));
			const y1 = Math.min(h, Math.ceil(y + h2));
			for (let atY = y0; atY < y1; atY += 1) {
				for (let atX = x0; atX < x1; atX += 1) alpha[atY * w + atX] = 255;
			}
			return alpha;
		}

		/** 蒙版反相：255−a（白黑互换）。 */
		function psInvertAlpha(alpha) {
			const next = new Uint8ClampedArray(alpha?.length ?? 0);
			for (let index = 0; index < next.length; index += 1) next[index] = 255 - alpha[index];
			return next;
		}

		/** 把覆盖率铺成一张画布（RGB 全白，只有 alpha 有信息）。
		 *  覆盖率缺位（空蒙版 / alpha 长度对不上）一律按 0（藏起来）算 ——
		 *  以前这里补 255，一块缺失的蒙版会变成完全不透明，整层白白露出来。 */
		function psMaskCanvas(width, height, alpha) {
			const w = psMaskSize(width, 1);
			const h = psMaskSize(height, 1);
			const canvas = psCanvas(w, h);
			const ctx = canvas.getContext("2d");
			const imageData = ctx.createImageData(w, h);
			const coverage = alpha && typeof alpha.length === "number" ? alpha : null;
			for (let index = 0; index < w * h; index += 1) {
				const at = index * 4;
				imageData.data[at] = 255;
				imageData.data[at + 1] = 255;
				imageData.data[at + 2] = 255;
				imageData.data[at + 3] = coverage && index < coverage.length ? coverage[index] : 0;
			}
			ctx.putImageData(imageData, 0, 0);
			return canvas;
		}

		/** 图层 × 蒙版 → 一张新画布（不动原来的层）。
		 *  width / height = 目标框（底图尺寸，默认跟图层一样）：图层和蒙版按同一个框铺满，
		 *  底图被裁过 / 图层尺寸和底图不一致时两边也不会各缩各的错位。
		 *  蒙版缺失就返回 null —— 调用方整层跳过，不能画成「没蒙版」的样子。 */
		function psMaskedCanvas(layerCanvas, maskCanvas, width, height) {
			if (!layerCanvas || !maskCanvas) return null;
			const w = psMaskSize(width, layerCanvas.width);
			const h = psMaskSize(height, layerCanvas.height);
			const canvas = psCanvas(w, h);
			const ctx = canvas.getContext("2d");
			ctx.drawImage(layerCanvas, 0, 0, canvas.width, canvas.height);
			ctx.globalCompositeOperation = "destination-in";
			ctx.drawImage(maskCanvas, 0, 0, canvas.width, canvas.height);
			ctx.globalCompositeOperation = "source-over";
			return canvas;
		}

		function psClampByte(value) {
			return value < 0 ? 0 : value > 255 ? 255 : Math.round(value);
		}

		/** 颜色 → 色相（度）→ 回到 RGB：只转色相，明度/饱和度不动。 */
		function psRgbToHsl(r, g, b) {
			const rn = r / 255;
			const gn = g / 255;
			const bn = b / 255;
			const max = Math.max(rn, gn, bn);
			const min = Math.min(rn, gn, bn);
			const l = (max + min) / 2;
			if (max === min) return { h: 0, s: 0, l };
			const d = max - min;
			const s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
			let h;
			if (max === rn) h = ((gn - bn) / d + (gn < bn ? 6 : 0)) / 6;
			else if (max === gn) h = ((bn - rn) / d + 2) / 6;
			else h = ((rn - gn) / d + 4) / 6;
			return { h, s, l };
		}

		function psHslToRgb(h, s, l) {
			const hue = ((h % 1) + 1) % 1;
			if (s === 0) {
				const v = psClampByte(l * 255);
				return { r: v, g: v, b: v };
			}
			const q = l < 0.5 ? l * (1 + s) : l + s - l * s;
			const p = 2 * l - q;
			const channel = (t) => {
				let value = t;
				if (value < 0) value += 1;
				if (value > 1) value -= 1;
				if (value < 1 / 6) return p + (q - p) * 6 * value;
				if (value < 1 / 2) return q;
				if (value < 2 / 3) return p + (q - p) * (2 / 3 - value) * 6;
				return p;
			};
			return {
				r: psClampByte(channel(hue + 1 / 3) * 255),
				g: psClampByte(channel(hue) * 255),
				b: psClampByte(channel(hue - 1 / 3) * 255)
			};
		}

		/**
		 * 就地调整一段像素。参数全可选、默认 0；alpha 不动。
		 * 顺序：亮度 → 对比度 → 饱和度 → 色相（和大多数编辑器一致）。
		 */
		function psAdjustPixels(data, options = {}) {
			if (!data || typeof data.length !== "number") return data;
			const brightness = Math.max(-100, Math.min(100, Number(options.brightness) || 0));
			const contrast = Math.max(-100, Math.min(100, Number(options.contrast) || 0));
			const saturation = Math.max(-100, Math.min(100, Number(options.saturation) || 0));
			const hue = Math.max(-180, Math.min(180, Number(options.hue) || 0));
			const grayscale = Boolean(options.grayscale);
			const invert = Boolean(options.invert);
			// 对比度：-100 全灰、0 不变、+100 阈值化（标准公式）
			// 对比度 -100 按 PS 的语义压成全灰（公式在 -100 只会给 0.44，达不到「全灰」）
			const flatContrast = contrast <= -100;
			const factor = contrast === 0 || flatContrast ? 1 : (259 * (contrast + 255)) / (255 * (259 - contrast));
			const brightOffset = (brightness / 100) * 255;
			const satFactor = 1 + saturation / 100;
			for (let index = 0; index < data.length; index += 4) {
				let r = data[index];
				let g = data[index + 1];
				let b = data[index + 2];
				if (brightness !== 0) {
					r += brightOffset;
					g += brightOffset;
					b += brightOffset;
				}
				if (flatContrast) {
					// 对比度 -100：按 PS 的语义整张压成中灰（公式在 -100 只给 0.4385，达不到「全灰」）
					r = 128;
					g = 128;
					b = 128;
				} else if (contrast !== 0) {
					r = factor * (r - 128) + 128;
					g = factor * (g - 128) + 128;
					b = factor * (b - 128) + 128;
				}
				if (saturation !== 0) {
					const gray = 0.2126 * r + 0.7152 * g + 0.0722 * b;
					r = gray + (r - gray) * satFactor;
					g = gray + (g - gray) * satFactor;
					b = gray + (b - gray) * satFactor;
				}
				if (hue !== 0 || grayscale) {
					const hsl = psRgbToHsl(psClampByte(r), psClampByte(g), psClampByte(b));
					const next = psHslToRgb(hsl.h + hue / 360, grayscale ? 0 : hsl.s, hsl.l);
					r = next.r;
					g = next.g;
					b = next.b;
				}
				if (invert) {
					r = 255 - r;
					g = 255 - g;
					b = 255 - b;
				}
				data[index] = psClampByte(r);
				data[index + 1] = psClampByte(g);
				data[index + 2] = psClampByte(b);
			}
			return data;
		}

		/* ------------------------------------------------------------------ *
		 * 曲线 / 色阶 / 自然饱和度 / 滤镜
		 *
		 * 都做成「先算查找表（LUT）或就地改像素」的纯函数：Node 里能直接测，
		 * 画布那边只负责 getImageData → 调这里 → putImageData。
		 * ------------------------------------------------------------------ */

		/** 256 项查找表：把像素值 0..255 映射成新值。恒等表就是不变。 */
		function psIdentityLut() {
			const lut = new Uint8ClampedArray(256);
			for (let index = 0; index < 256; index += 1) lut[index] = index;
			return lut;
		}

		/**
		 * 曲线：控制点 [x, y]（0..255，按 x 升序），点之间线性插值，两头保持端点值。
		 * 少于 2 个点就返回恒等表 —— 宁可不改，也不能把画面搞乱。
		 */
		function psCurveLut(points) {
			const list = (points ?? [])
				.map((point) => [Math.max(0, Math.min(255, Number(point[0]))), Math.max(0, Math.min(255, Number(point[1])))])
				.filter((point) => Number.isFinite(point[0]) && Number.isFinite(point[1]))
				.sort((a, b) => a[0] - b[0]);
			if (list.length < 2) return psIdentityLut();
			const lut = new Uint8ClampedArray(256);
			for (let index = 0; index < 256; index += 1) {
				if (index <= list[0][0]) {
					lut[index] = list[0][1];
					continue;
				}
				const last = list[list.length - 1];
				if (index >= last[0]) {
					lut[index] = last[1];
					continue;
				}
				for (let at = 1; at < list.length; at += 1) {
					const [x0, y0] = list[at - 1];
					const [x1, y1] = list[at];
					if (index <= x1) {
						const ratio = x1 === x0 ? 0 : (index - x0) / (x1 - x0);
						lut[index] = Math.round(y0 + (y1 - y0) * ratio);
						break;
					}
				}
			}
			return lut;
		}

		/**
		 * 色阶：黑场 / 白场 / 中间伽马 + 输出范围。
		 * 就是 Photoshu 的 Levels：先把 [inBlack, inWhite] 拉满，再做 gamma，最后压进输出范围。
		 */
		function psLevelsLut({ inBlack = 0, inWhite = 255, gamma = 1, outBlack = 0, outWhite = 255 } = {}) {
			const black = Math.max(0, Math.min(254, Number(inBlack)));
			const white = Math.max(black + 1, Math.min(255, Number(inWhite)));
			const rawGamma = Number(gamma);
			// gamma 允许 0.01..9.99；0 / NaN 按 1 处理，负数才钳到下限（以前 Number(gamma) || 1 会把 0 吞成 1）
			const safeGamma = Number.isFinite(rawGamma) && rawGamma !== 0 ? Math.max(0.01, Math.min(9.99, rawGamma)) : 1;
			const low = Math.max(0, Math.min(255, Number(outBlack)));
			const high = Math.max(low, Math.min(255, Number(outWhite)));
			const lut = new Uint8ClampedArray(256);
			for (let index = 0; index < 256; index += 1) {
				const normalized = Math.max(0, Math.min(1, (index - black) / (white - black)));
				const corrected = Math.pow(normalized, 1 / safeGamma);
				lut[index] = Math.round(low + corrected * (high - low));
			}
			return lut;
		}

		/** 用查找表逐通道改像素（三个通道可以不一样，曲线就是这样用的）。 */
		function psApplyLutPixels(data, lutR, lutG = lutR, lutB = lutR) {
			if (!data || typeof data.length !== "number") return data;
			for (let index = 0; index < data.length; index += 4) {
				data[index] = lutR[data[index]];
				data[index + 1] = lutG[data[index + 1]];
				data[index + 2] = lutB[data[index + 2]];
			}
			return data;
		}

		/**
		 * 自然饱和度（vibrance）：只抬「不够艳」的那部分，已经很艳的几乎不动 ——
		 * 这是它和普通饱和度的区别（普通饱和度会把肤色调成塑料）。
		 */
		function psVibrancePixels(data, amount = 0) {
			if (!data || typeof data.length !== "number") return data;
			const strength = Math.max(-100, Math.min(100, Number(amount) || 0)) / 100;
			if (strength === 0) return data;
			for (let index = 0; index < data.length; index += 4) {
				const r = data[index];
				const g = data[index + 1];
				const b = data[index + 2];
				const max = Math.max(r, g, b);
				const min = Math.min(r, g, b);
				const saturation = max === 0 ? 0 : (max - min) / max;
				// 越饱和越少动（1 - saturation），负值同理
				const boost = strength * (1 - saturation);
				const gray = 0.2126 * r + 0.7152 * g + 0.0722 * b;
				data[index] = psClampByte(gray + (r - gray) * (1 + boost));
				data[index + 1] = psClampByte(gray + (g - gray) * (1 + boost));
				data[index + 2] = psClampByte(gray + (b - gray) * (1 + boost));
			}
			return data;
		}

		/** 盒式模糊：可分离两遍（横 + 竖），小半径下就是廉价的高斯近似。 */
		function psBoxBlurPixels(data, width, height, radius = 2) {
			const w = Math.max(1, Math.round(width));
			const h = Math.max(1, Math.round(height));
			const r = Math.max(0, Math.min(64, Math.round(radius)));
			if (!data || r === 0) return data;
			const span = r * 2 + 1;
			const tmp = new Uint8ClampedArray(data.length);
			// 横向
			for (let y = 0; y < h; y += 1) {
				for (let x = 0; x < w; x += 1) {
					let rr = 0;
					let gg = 0;
					let bb = 0;
					let aa = 0;
					let count = 0;
					for (let dx = -r; dx <= r; dx += 1) {
						const sx = Math.max(0, Math.min(w - 1, x + dx));
						const at = (y * w + sx) * 4;
						rr += data[at];
						gg += data[at + 1];
						bb += data[at + 2];
						aa += data[at + 3];
						count += 1;
					}
					const at = (y * w + x) * 4;
					tmp[at] = rr / count;
					tmp[at + 1] = gg / count;
					tmp[at + 2] = bb / count;
					tmp[at + 3] = aa / count;
				}
			}
			// 纵向
			for (let y = 0; y < h; y += 1) {
				for (let x = 0; x < w; x += 1) {
					let rr = 0;
					let gg = 0;
					let bb = 0;
					let aa = 0;
					let count = 0;
					for (let dy = -r; dy <= r; dy += 1) {
						const sy = Math.max(0, Math.min(h - 1, y + dy));
						const at = (sy * w + x) * 4;
						rr += tmp[at];
						gg += tmp[at + 1];
						bb += tmp[at + 2];
						aa += tmp[at + 3];
						count += 1;
					}
					const at = (y * w + x) * 4;
					data[at] = rr / count;
					data[at + 1] = gg / count;
					data[at + 2] = bb / count;
					data[at + 3] = aa / count;
				}
			}
			void span;
			return data;
		}

		/** 锐化（USM 的简化版）：原图 + 强度 ×（原图 − 模糊图）。 */
		function psSharpenPixels(data, width, height, amount = 50) {
			const strength = Math.max(0, Math.min(200, Number(amount) || 0)) / 100;
			if (!data || strength === 0) return data;
			const blurred = new Uint8ClampedArray(data);
			psBoxBlurPixels(blurred, width, height, 1);
			for (let index = 0; index < data.length; index += 4) {
				for (let channel = 0; channel < 3; channel += 1) {
					const original = data[index + channel];
					data[index + channel] = psClampByte(original + (original - blurred[index + channel]) * strength);
				}
			}
			return data;
		}

		/** 噪点：固定种子的伪随机（同样的参数永远得到同样的噪点，测试才可复现）。 */
		function psNoisePixels(data, amount = 0, seed = 1) {
			const strength = Math.max(0, Math.min(100, Number(amount) || 0));
			if (!data || strength === 0) return data;
			let state = (Math.floor(Number(seed) || 1) % 2147483647) || 1;
			const next = () => {
				state = (state * 48271) % 2147483647;
				return (state / 2147483647) * 2 - 1;
			};
			for (let index = 0; index < data.length; index += 4) {
				const delta = next() * strength * 1.28;
				data[index] = psClampByte(data[index] + delta);
				data[index + 1] = psClampByte(data[index + 1] + delta);
				data[index + 2] = psClampByte(data[index + 2] + delta);
			}
			return data;
		}

		/* ---- 曲线控制点：x 严格递增、首尾钉在 0 / 255（和 PS 一样，两端只能上下动） ---- */

		/** 规范化：按 x 排序、夹到 0..255、去掉重复 x、首尾补齐并钉死。 */
		function psCurveNormalize(points) {
			const list = (Array.isArray(points) ? points : [])
				.map((point) => [
					Math.max(0, Math.min(255, Math.round(Number(point?.[0] ?? 0)))),
					Math.max(0, Math.min(255, Math.round(Number(point?.[1] ?? 0))))
				])
				.filter((point) => Number.isFinite(point[0]) && Number.isFinite(point[1]))
				.sort((a, b) => a[0] - b[0]);
			const unique = [];
			for (const point of list) {
				if (unique.length === 0 || point[0] !== unique[unique.length - 1][0]) unique.push(point);
			}
			if (unique.length === 0) return [[0, 0], [255, 255]];
			if (unique[0][0] !== 0) unique.unshift([0, unique[0][1]]);
			else unique[0] = [0, unique[0][1]];
			const last = unique[unique.length - 1];
			if (last[0] !== 255) unique.push([255, last[1]]);
			else unique[unique.length - 1] = [255, last[1]];
			return unique.length >= 2 ? unique : [[0, 0], [255, 255]];
		}

		/** 命中测试：返回最近的控制点下标（没命中 -1）。坐标是 0..255 的曲线空间。 */
		function psCurveHit(points, x, y, radius = 14) {
			let best = -1;
			let bestDistance = radius;
			(points ?? []).forEach((point, index) => {
				const distance = Math.hypot(point[0] - x, point[1] - y);
				if (distance <= bestDistance) {
					best = index;
					bestDistance = distance;
				}
			});
			return best;
		}

		/** 移动一个控制点：两端只让上下动，中间的点夹在邻居之间（x 保持递增）。 */
		function psCurveMove(points, index, x, y) {
			const list = psCurveNormalize(points).map((point) => point.slice());
			if (index < 0 || index >= list.length) return list;
			const clampedY = Math.max(0, Math.min(255, Math.round(Number(y))));
			if (index === 0 || index === list.length - 1) {
				list[index] = [list[index][0], clampedY];
				return list;
			}
			const low = list[index - 1][0] + 1;
			const high = list[index + 1][0] - 1;
			const clampedX = Math.max(low, Math.min(high, Math.round(Number(x))));
			list[index] = [clampedX, clampedY];
			return list;
		}

		/** 在曲线上加一个点（离已有的太近就不加）。 */
		function psCurveAdd(points, x, y) {
			const list = psCurveNormalize(points).map((point) => point.slice());
			const at = Math.max(1, Math.min(254, Math.round(Number(x))));
			if (list.some((point) => Math.abs(point[0] - at) < 4)) return list;
			list.push([at, Math.max(0, Math.min(255, Math.round(Number(y))))]);
			return psCurveNormalize(list);
		}

		/** 删掉一个中间点（首尾不许删，至少留两个点）。 */
		function psCurveRemoveAt(points, index) {
			const list = psCurveNormalize(points).map((point) => point.slice());
			if (index <= 0 || index >= list.length - 1 || list.length <= 2) return list;
			list.splice(index, 1);
			return psCurveNormalize(list);
		}

		/** 预设曲线（曲线面板上的几个常用形状，点一下就能用）。 */
		function psCurvePreset(id) {
			if (id === "brighten") return [[0, 24], [255, 255]];
			if (id === "darken") return [[0, 0], [255, 231]];
			if (id === "contrast") return [[0, 0], [64, 40], [192, 215], [255, 255]];
			if (id === "invert") return [[0, 255], [255, 0]];
			return [[0, 0], [255, 255]];
		}

		/** 按 id 找图层（找不到 / id 不像话都返回 null，免得把写回塞给一个没 id 的层）。 */
		function psLayerById(layers, id) {
			if (id === null || id === undefined) return null;
			return (Array.isArray(layers) ? layers : []).find((layer) => layer && layer.id === id) ?? null;
		}

		/**
		 * 把改完的画布写回某一层：只换 canvas，蒙版/名称/混合模式/不透明度都保留。
		 * 「单层裁切」就是靠它 —— 工具照旧作用在 source 上，退出编辑时把结果塞回这一层。
		 */
		function psLayerCommit(layers, id, canvas) {
			const list = Array.isArray(layers) ? layers : [];
			// 没有可用 id 就不写：不然 id 是 undefined 时会把「没 id 的层」当成目标，写错层
			if (!canvas || id === null || id === undefined) return list;
			return list.map((layer) => (layer && layer.id === id ? { ...layer, canvas, width: canvas.width, height: canvas.height, pixelRevision:(layer.pixelRevision || 0) + 1 } : layer));
		}

		/**
		 * 开一个单层编辑会话：没有图层画布 / 没有可用 id / 没有真底图（只有宽高的静态预览也算没有）/
		 * 已经在会话里（连点两下、或者会话没退又点别的层）都返回 null。
		 * 没底图就进会话的话退出时没东西可还原，底图会被这一层顶掉。
		 */
		function psLayerSessionStart(layer, source, current) {
			if (current) return null;
			if (!layer || typeof layer !== "object" || !layer.canvas) return null;
			if (layer.id === null || layer.id === undefined || layer.id === "") return null;
			if (!source || typeof source !== "object" || !source.canvas) return null;
			return { id: layer.id, name: layer.name, base: source };
		}

		/**
		 * 退出会话：有可写回的内容就只换这一层的画布（蒙版 / 混合模式 / 不透明度留着），
		 * 底图原样还原；没有 stage（静态预览 / 用户选了不写回）就只还原底图，不写回。
		 */
		function psLayerSessionExit(session, layers, edited) {
			if (!session) return null;
			const list = Array.isArray(layers) ? layers : [];
			const canvas = edited && typeof edited === "object" ? edited : null;
			return {
				layers: canvas ? psLayerCommit(list, session.id, canvas) : list,
				base: session.base && session.base.canvas ? session.base : null,
				committed: Boolean(canvas)
			};
		}

		/* ------------------------------------------------------------------ *
		 * 底图几何变换 → 图层 / 蒙版跟着变
		 *
		 * 底图裁 / 转 / 改画布 / 缩放 / 翻转 / 四点透视之后，图层如果还留在旧坐标系里，导出合成图就会错位。
		 * 这里把六种几何做成一套纯函数：图层画布走 psCrop / psRotate / psCanvasSize /
		 * psResize / psFlip / psWarpCanvas，蒙版 alpha 跟着重算（长度 = 新尺寸），蒙版画布再从 alpha 重铺。
		 * 透视和底图共用同一份 plan（同一套单应矩阵），图层才不会和底图各变形一次、对不上。
		 * 坐标基准统一是「变换前的底图尺寸」；图层尺寸和底图不一致时先按底图重铺，不裁掉内容。
		 * ------------------------------------------------------------------ */

		const PS_GEOMETRY_KINDS = ["crop", "rotate", "canvasSize", "resize", "flip", "warp"];

		/** 认得的几何种类才认；别的一律返回空串（底图操作保持原行为）。 */
		function psGeometryKind(kind) {
			const id = String(kind ?? "");
			return PS_GEOMETRY_KINDS.indexOf(id) >= 0 ? id : "";
		}

		/** 一步几何做完之后的画布尺寸（和 psCrop / psRotate / psCanvasSize / psResize / psFlip 同一套公式）。 */
		function psGeometryDims(op, width, height) {
			const w = psMaskSize(width, 1);
			const h = psMaskSize(height, 1);
			const kind = psGeometryKind(op?.kind);
			if (kind === "crop") {
				const box = psClampRect(op?.rect, w, h);
				return box ? { w: box.w, h: box.h } : { w, h };
			}
			if (kind === "rotate") {
				const angle = ((Number(op?.angle) || 0) * Math.PI) / 180;
				const sin = Math.abs(Math.sin(angle));
				const cos = Math.abs(Math.cos(angle));
				return { w: Math.max(1, Math.round(w * cos + h * sin)), h: Math.max(1, Math.round(w * sin + h * cos)) };
			}
			if (kind === "canvasSize" || kind === "resize") {
				return { w: psMaskSize(op?.w, w), h: psMaskSize(op?.h, h) };
			}
			// 透视的输出尺寸由 plan 自己决定（目标四点的外接矩形），和进来的宽高无关
			if (kind === "warp") {
				const size = psWarpGeometrySize(op?.plan);
				return size ? { w: size.w, h: size.h } : { w, h };
			}
			return { w, h };
		}

		/** 蒙版 alpha 最近邻重采样：任意尺寸的覆盖率拉到目标尺寸，长度一定重算。 */
		function psResampleAlpha(alpha, width, height, targetW, targetH) {
			const sw = psMaskSize(width, 1);
			const sh = psMaskSize(height, 1);
			const dw = psMaskSize(targetW, sw);
			const dh = psMaskSize(targetH, sh);
			const source = alpha && typeof alpha.length === "number" ? alpha : null;
			const out = new Uint8ClampedArray(dw * dh);
			for (let y = 0; y < dh; y += 1) {
				const sy = Math.min(sh - 1, Math.floor((y * sh) / dh));
				for (let x = 0; x < dw; x += 1) {
					const sx = Math.min(sw - 1, Math.floor((x * sw) / dw));
					const at = sy * sw + sx;
					out[y * dw + x] = source && at < source.length ? source[at] : 0;
				}
			}
			return out;
		}

		/** 透视这一步的输出尺寸：plan 有效就用 plan 的 size；没有 plan / 已经退化返回 null（不抛）。 */
		function psWarpGeometrySize(plan) {
			if (!plan || typeof plan !== "object") return null;
			const H = plan.inverse;
			if (!H || typeof H.length !== "number" || H.length !== 9) return null;
			for (let index = 0; index < 9; index += 1) {
				if (!Number.isFinite(Number(H[index]))) return null;
			}
			const w = Math.round(Number(plan.size?.w));
			const h = Math.round(Number(plan.size?.h));
			if (!Number.isFinite(w) || !Number.isFinite(h) || w < 1 || h < 1) return null;
			return { w, h };
		}

		/**
		 * 蒙版覆盖率按同一份单应矩阵变形：H 是「输出坐标 → 源坐标」，和 psWarpCanvas 反查用的是同一个矩阵。
		 * 输出长度一定 = 新尺寸；反查不到（透视后落在图层外面）的地方按 0（藏起来）。
		 */
		function psWarpAlpha(alpha, width, height, H, outW, outH) {
			const w = psMaskSize(width, 1);
			const h = psMaskSize(height, 1);
			const dw = psMaskSize(outW, 1);
			const dh = psMaskSize(outH, 1);
			const out = new Uint8ClampedArray(dw * dh);
			if (!H || typeof H.length !== "number" || H.length !== 9) return out;
			const source = alpha && typeof alpha.length === "number" ? alpha : null;
			const [m0, m1, m2, m3, m4, m5, m6, m7, m8] = H;
			for (let y = 0; y < dh; y += 1) {
				// 和 psWarpCanvas 一样沿行递推，省掉每像素的乘法
				let nx = m1 * y + m2;
				let ny = m4 * y + m5;
				let den = m7 * y + m8;
				for (let x = 0; x < dw; x += 1, nx += m0, ny += m3, den += m6) {
					if (!(Math.abs(den) > 1e-12)) continue;
					const sx = Math.round(nx / den);
					const sy = Math.round(ny / den);
					if (sx < 0 || sy < 0 || sx >= w || sy >= h) continue;
					const at = sy * w + sx;
					if (source && at < source.length) out[y * dw + x] = source[at];
				}
			}
			return out;
		}

		/** 蒙版覆盖率按几何变换（和画布算子同一套坐标公式，输出长度 = 新尺寸，缺位按 0 藏起来）。 */
		function psTransformAlpha(alpha, width, height, op) {
			const w = psMaskSize(width, 1);
			const h = psMaskSize(height, 1);
			const source = alpha && typeof alpha.length === "number" ? alpha : new Uint8ClampedArray(w * h);
			const kind = psGeometryKind(op?.kind);
			const sample = (index) => (index >= 0 && index < source.length ? source[index] : 0);
			if (kind === "crop") {
				const box = psClampRect(op?.rect, w, h);
				if (!box) return { alpha: psResampleAlpha(source, w, h, w, h), width: w, height: h };
				const out = new Uint8ClampedArray(box.w * box.h);
				for (let y = 0; y < box.h; y += 1) {
					const sy = Math.min(h - 1, box.y + y);
					for (let x = 0; x < box.w; x += 1) {
						out[y * box.w + x] = sample(sy * w + Math.min(w - 1, box.x + x));
					}
				}
				return { alpha: out, width: box.w, height: box.h };
			}
			if (kind === "rotate") {
				const angle = ((Number(op?.angle) || 0) * Math.PI) / 180;
				const sin = Math.abs(Math.sin(angle));
				const cos = Math.abs(Math.cos(angle));
				const outW = Math.max(1, Math.round(w * cos + h * sin));
				const outH = Math.max(1, Math.round(w * sin + h * cos));
				const out = new Uint8ClampedArray(outW * outH);
				const c = Math.cos(angle);
				const s = Math.sin(angle);
				for (let y = 0; y < outH; y += 1) {
					for (let x = 0; x < outW; x += 1) {
						const dx = x - outW / 2;
						const dy = y - outH / 2;
						const ix = Math.round(dx * c + dy * s + w / 2);
						const iy = Math.round(-dx * s + dy * c + h / 2);
						if (ix < 0 || iy < 0 || ix >= w || iy >= h) continue;
						out[y * outW + x] = sample(iy * w + ix);
					}
				}
				return { alpha: out, width: outW, height: outH };
			}
			if (kind === "canvasSize") {
				const outW = psMaskSize(op?.w, w);
				const outH = psMaskSize(op?.h, h);
				const out = new Uint8ClampedArray(outW * outH);
				const at = psAnchorOffset(w, h, outW, outH, op?.anchor || "c");
				for (let y = 0; y < h; y += 1) {
					const ty = y + at.y;
					if (ty < 0 || ty >= outH) continue;
					for (let x = 0; x < w; x += 1) {
						const tx = x + at.x;
						if (tx < 0 || tx >= outW) continue;
						out[ty * outW + tx] = sample(y * w + x);
					}
				}
				return { alpha: out, width: outW, height: outH };
			}
			if (kind === "resize") {
				const outW = psMaskSize(op?.w, w);
				const outH = psMaskSize(op?.h, h);
				return { alpha: psResampleAlpha(source, w, h, outW, outH), width: outW, height: outH };
			}
			if (kind === "warp") {
				const size = psWarpGeometrySize(op?.plan);
				// 没有 plan / 四点退化：当没这一步（原样重采样），不抛
				if (!size) return { alpha: psResampleAlpha(source, w, h, w, h), width: w, height: h };
				return { alpha: psWarpAlpha(source, w, h, op.plan.inverse, size.w, size.h), width: size.w, height: size.h };
			}
			if (kind === "flip") {
				const vertical = op?.axis === "v";
				const out = new Uint8ClampedArray(w * h);
				for (let y = 0; y < h; y += 1) {
					for (let x = 0; x < w; x += 1) {
						const sx = vertical ? x : w - 1 - x;
						const sy = vertical ? h - 1 - y : y;
						out[y * w + x] = sample(sy * w + sx);
					}
				}
				return { alpha: out, width: w, height: h };
			}
			return { alpha: psResampleAlpha(source, w, h, w, h), width: w, height: h };
		}

		/** 图层画布按底图几何变换（先用旧底图尺寸重铺：尺寸不一致也不裁掉内容）。 */
		function psGeometryCanvas(canvas, op, width, height) {
			if (!canvas) return canvas;
			const w = psMaskSize(width, canvas.width);
			const h = psMaskSize(height, canvas.height);
			const base = canvas.width === w && canvas.height === h ? canvas : psResize(canvas, w, h);
			const kind = psGeometryKind(op?.kind);
			if (kind === "crop") return psCrop(base, op?.rect);
			if (kind === "rotate") return psRotate(base, Number(op?.angle) || 0);
			if (kind === "resize") return psResize(base, psMaskSize(op?.w, w), psMaskSize(op?.h, h));
			// 图层新区域一律透明：底色已经铺在底图上了，图层再铺一遍会变成两层颜色
			if (kind === "canvasSize") return psCanvasSize(base, psMaskSize(op?.w, w), psMaskSize(op?.h, h), op?.anchor || "c", "");
			if (kind === "flip") return psFlip(base, op?.axis === "v" ? "v" : "h");
			if (kind === "warp") {
				const size = psWarpGeometrySize(op?.plan);
				// plan 退化（四点自交 / 共线）就照原路走：不抛、不动图层
				if (!size) return base;
				try {
					return psWarpCanvas(base, op.plan.inverse, size.w, size.h);
				} catch {
					return base;
				}
			}
			return base;
		}

		/** 蒙版跟着变：有 alpha 就从 alpha 重算（顺带重铺蒙版画布），只有画布就只变换画布。 */
		function psTransformMask(mask, op, width, height) {
			if (!mask || typeof mask !== "object") return mask;
			const w = psMaskSize(width, 1);
			const h = psMaskSize(height, 1);
			const source = mask.alpha && typeof mask.alpha.length === "number" && mask.alpha.length > 0 ? mask.alpha : null;
			if (!source) return { ...mask, canvas: mask.canvas ? psGeometryCanvas(mask.canvas, op, w, h) : null };
			// 蒙版坐标系 = 底图坐标系：先按旧底图尺寸归一，变换后的覆盖率才能和图层一一对齐
			const inBase = psResampleAlpha(source, psMaskSize(mask.canvas?.width, w), psMaskSize(mask.canvas?.height, h), w, h);
			const moved = psTransformAlpha(inBase, w, h, op);
			return { ...mask, canvas: psMaskCanvas(moved.width, moved.height, moved.alpha), alpha: moved.alpha };
		}

		/**
		 * 底图几何 → 一套新图层（纯函数，不改入参，也不改原图层对象）。
		 * op = { kind, width, height, w, h, rect?, angle?, axis?, anchor?, plan? }（也可以传一组，按顺序做）：
		 * plan 只有透视（kind: "warp"）用：图层和蒙版都按它同一套单应矩阵变形，输出尺寸 = plan.size。
		 *   width / height 是**变换前**的底图尺寸（图层坐标基准），w / h 是**变换后**的底图尺寸。
		 * 没图层 / kind 不认识 → 原样返回，底图单独变换的老行为不变。
		 */
		function psTransformLayers(layers, op) {
			const list = Array.isArray(layers) ? layers : [];
			const steps = (Array.isArray(op) ? op : [op])
				.filter((item) => item && psGeometryKind(item.kind))
				.map((item) => ({ ...item, kind: psGeometryKind(item.kind) }));
			if (!list.length || !steps.length) return list;
			return list.map((layer) => {
				if (!layer || typeof layer !== "object" || !layer.canvas) return layer;
				let dims = {
					w: psMaskSize(steps[0].width, layer.canvas.width),
					h: psMaskSize(steps[0].height, layer.canvas.height)
				};
				let canvas = layer.canvas;
				let mask = layer.mask;
				for (const step of steps) {
					canvas = psGeometryCanvas(canvas, step, dims.w, dims.h);
					if (mask) mask = psTransformMask(mask, step, dims.w, dims.h);
					dims = psGeometryDims(step, dims.w, dims.h);
				}
				const next = { ...layer, canvas, width: canvas.width, height: canvas.height };
				if (mask) next.mask = mask;
				return next;
			});
		}

		/** 拉直 = 旋转 + 裁到内接矩形：和 psStraighten 用同一套尺寸，图层才和底图严丝合缝。 */
		function psStraightenGeometry(width, height, angleDeg) {
			const rotated = psGeometryDims({ kind: "rotate", angle: angleDeg }, width, height);
			const box = psInscribedSize(width, height, angleDeg);
			return [
				{ kind: "rotate", angle: angleDeg },
				{
					kind: "crop",
					rect: {
						x: Math.round((rotated.w - box.w) / 2),
						y: Math.round((rotated.h - box.h) / 2),
						w: box.w,
						h: box.h
					}
				}
			];
		}

		/** 历史快照：底图 + 图层 + 单层会话一起记，撤销才能把整屏状态一起回退。 */
		function psHistorySnapshot(source, layers, layerSession, label, meta = {}) {
			const canvas = source?.canvas ?? null;
			if (!canvas) return null;
			return {
				name: source?.name || "image",
				canvas,
				layers: Array.isArray(layers) ? layers.slice() : [],
				activeLayerId: meta.activeLayerId ?? layerSession?.id ?? "",
				warpResultId: meta.warpResultId ?? "",
				// 标签写的是「进入这个状态的操作」，而不是下一步尚未执行的操作。
				label: typeof label === "string" ? label : "",
				layerSession: layerSession && typeof layerSession === "object" ? layerSession : null
			};
		}

		/** 快照复用不可变的像素对象；这里只移动引用，跳多步不会重算滤镜/重跑变形。 */
		function psHistoryPush(history, before, nextLabel) {
			return { past: [...history.past, { ...before, label:history.currentLabel || before.label || before.name }].slice(-PS_MAX_HISTORY), currentLabel:nextLabel, future:[] };
		}
		function psHistorySeek(history, current, kind, index) {
			if (!current || !Number.isInteger(index) || !["past","future"].includes(kind) || !history[kind]?.[index]) return null;
			const {past,future} = history, line = [...past, current, ...future];
			const at = kind === "past" ? index : past.length + 1 + index;
			return { target:line[at], history:{past:line.slice(0,at), currentLabel:line[at].label, future:line.slice(at+1)} };
		}

		/**
		 * 历史条要显示的步骤：过去的（可点回去）+ 当前这一步 + 未来的（可点重做）。
		 * 标签优先用快照上的 label，老快照没有就退回「第 N 步」，不会显示空白。
		 */
		function psHistorySteps(history, currentLabel) {
			const past = Array.isArray(history?.past) ? history.past : [];
			const future = Array.isArray(history?.future) ? history.future : [];
			const rows = past.map((snapshot, index) => ({
				kind: "past",
				index,
				label: (snapshot && snapshot.label) || `第 ${index + 1} 步`
			}));
			rows.push({ kind: "current", index: past.length, label: history?.currentLabel || currentLabel || "当前" });
			future.forEach((snapshot, index) => {
				rows.push({ kind: "future", index, label: (snapshot && snapshot.label) || `第 ${index + 1} 步` });
			});
			return rows;
		}

		/**
		 * 快照 → 能直接 set 的状态。旧快照（上一版只存了 canvas）没有 layers / layerSession 字段，
		 * 那就沿用当前状态：不能因为撤销一张老快照把图层整个清空。
		 */
		function psHistoryRestore(snapshot, current) {
			if (!snapshot || typeof snapshot !== "object" || !snapshot.canvas) return null;
			const base = current && typeof current === "object" ? current : {};
			const layers = Array.isArray(snapshot.layers) ? snapshot.layers : Array.isArray(base.layers) ? base.layers : [];
			const layerSession = snapshot.layerSession === undefined ? base.layerSession ?? null : snapshot.layerSession;
			const activeId = snapshot.activeLayerId ?? layerSession?.id ?? base.activeLayerId ?? "";
			const warpId = snapshot.warpResultId ?? base.warpResultId ?? "";
			const label = typeof snapshot.label === "string" ? snapshot.label : "";
			return {
				name: snapshot.name || "image",
				canvas: snapshot.canvas,
				width: snapshot.canvas.width,
				height: snapshot.canvas.height,
				layers,
				label,
				activeLayerId: psLayerById(layers, activeId)?.id ?? "",
				warpResultId: layerSession?.id === warpId ? warpId : "",
				layerSession: layerSession && typeof layerSession === "object" ? layerSession : null
			};
		}

		/** 行点击是否等于「打开这一层」：点在行里的控件（眼睛 / 混合模式 / 不透明度 / 蒙版按钮）上不算。 */
		function psLayerRowActivate(event) {
			if (event?.target?.closest?.("button,select,option,input,textarea,label")) return false;
			const tag = String(event?.target?.tagName ?? "").toUpperCase();
			return !["BUTTON", "SELECT", "OPTION", "INPUT", "TEXTAREA", "LABEL"].includes(tag);
		}

		/** 图层上下移动：delta = +1 往上（更靠前），-1 往下。越界就原样返回。 */
		function psMoveLayer(layers, index, delta) {
			const list = Array.isArray(layers) ? layers.slice() : [];
			const target = index + delta;
			if (index < 0 || index >= list.length || target < 0 || target >= list.length) return list;
			[list[index], list[target]] = [list[target], list[index]];
			return list;
		}

		/** 图层拖拽排序：把 fromId 挪到 toId 的位置（控制条里直接拖）。 */
		function psMoveLayerTo(layers, fromId, toId) {
			const list = Array.isArray(layers) ? layers.slice() : [];
			const from = list.findIndex((item) => item.id === fromId);
			const to = list.findIndex((item) => item.id === toId);
			if (from < 0 || to < 0 || from === to) return list;
			const [moved] = list.splice(from, 1);
			list.splice(to, 0, moved);
			return list;
		}

		// 已提交的像素画布按不可变对象使用；几何操作/单层写回更换 canvas，纯属性变更不应重新编码整排缩略图。
		// 若调用方复用同一画布并更新像素，显式递增 pixelRevision。每个弱键仅保留最后一个尺寸/版本。
		const psLayerThumbCache = new WeakMap();
		function psLayerThumb(canvas, size = 56, pixelRevision = 0) {
			try {
				if (!canvas || !canvas.width || !canvas.height) return "";
				const cached = psLayerThumbCache.get(canvas);
				if (cached && cached.size === size && cached.w === canvas.width && cached.h === canvas.height && cached.revision === pixelRevision) return cached.url;
				const thumb = psCanvas(size, size);
				const context = thumb.getContext("2d");
				context.imageSmoothingQuality = "high";
				context.drawImage(canvas, 0, 0, size, size);
				const url = thumb.toDataURL("image/png");
				psLayerThumbCache.set(canvas, {size,w:canvas.width,h:canvas.height,revision:pixelRevision,url});
				return url;
			} catch (error) {
				return "";
			}
		}

		/** 合成用的那张图：底图 + 图层（导出、设为参考图都走它，保证「看到的就是导出的」）。
		 *  蒙版必须和画布上一样参与合成 —— 以前这里不传 prepare，导出会把蒙住的内容原样露出来。 */
		function psPaintStack(target, base, layers) {
			const ctx = target.getContext("2d"), w = target.width, h = target.height;
			ctx.clearRect(0, 0, w, h);
			if (base) ctx.drawImage(base, 0, 0, w, h);
			psDrawLayers(ctx, layers, w, h, layer => psMaskedCanvas(layer.canvas, layer.mask?.canvas, w, h));
			return target;
		}
		function psLayerExport(base, layers, width, height) {
			return psPaintStack(psCanvas(width, height), base, layers);
		}

		/** 画布上该叠哪些层：平时是全部图层，单层会话里只有这一层在画布上（别的层不叠、自己也不叠自己）。 */
		function psCanvasLayers(layers, inSession) {
			if (inSession) return [];
			return Array.isArray(layers) ? layers : [];
		}

		/** 导出该拿哪张图：单层会话导会话内容（底图已经被换掉了，别再叠一遍所有图层）；否则有图层就导合成图。 */
		function psExportComposite(shown, layers, inSession) {
			if (!shown) return null;
			if (inSession) return shown;
			return Array.isArray(layers) && layers.some(layer => layer?.canvas && layer.visible !== false) ? psLayerExport(shown, layers, shown.width, shown.height) : shown;
		}

		/** 把选区夹回图内；宽高至少 1px。传 null 表示没有选区。 */
		function psClampRect(rect, width, height) {
			if (!rect) return null;
			const x = Math.min(Math.max(0, Math.round(rect.x)), Math.max(0, width - 1));
			const y = Math.min(Math.max(0, Math.round(rect.y)), Math.max(0, height - 1));
			const w = Math.min(Math.round(rect.w), width - x);
			const h = Math.min(Math.round(rect.h), height - y);
			if (w < 1 || h < 1) return null;
			return { x, y, w, h };
		}

		/** 从起点到终点的矩形，带上「往哪边拖」的正负号。 */
		function psRectFrom(start, end, width, height) {
			return psClampRect({ x: Math.min(start.x, end.x), y: Math.min(start.y, end.y), w: Math.abs(end.x - start.x), h: Math.abs(end.y - start.y) }, width, height);
		}

		/** 8 个手柄拖完后的矩形。handle: nw/n/ne/e/se/s/sw/w。退化也留 1px，不把选区弄没。 */
		function psResizeRect(rect, handle, point, width, height) {
			const next = { ...rect };
			if (handle.includes("w")) {
				next.w = rect.x + rect.w - point.x;
				next.x = point.x;
			}
			if (handle.includes("e")) next.w = point.x - rect.x;
			if (handle.includes("n")) {
				next.h = rect.y + rect.h - point.y;
				next.y = point.y;
			}
			if (handle.includes("s")) next.h = point.y - rect.y;
			if (next.w < 0) {
				next.x += next.w;
				next.w = -next.w;
			}
			if (next.h < 0) {
				next.y += next.h;
				next.h = -next.h;
			}
			const x = Math.min(Math.max(0, Math.round(next.x)), Math.max(0, width - 1));
			const y = Math.min(Math.max(0, Math.round(next.y)), Math.max(0, height - 1));
			return {
				x,
				y,
				w: Math.max(1, Math.min(Math.round(next.w) || 1, width - x)),
				h: Math.max(1, Math.min(Math.round(next.h) || 1, height - y))
			};
		}

		/** 切割拆分：把 w×h 按 cols×rows 均分，余数摊到最后一块。 */
		function psSplitTiles(width, height, cols, rows) {
			if (!Number.isInteger(width) || !Number.isInteger(height) || width < 1 || height < 1) return [];
			const c = Math.max(1, Math.min(width, 8, Math.round(cols) || 1));
			const r = Math.max(1, Math.min(height, 8, Math.round(rows) || 1));
			const tiles = [];
			for (let row = 0; row < r; row += 1) {
				for (let col = 0; col < c; col += 1) {
					const x = Math.round((width * col) / c);
					const y = Math.round((height * row) / r);
					const right = Math.round((width * (col + 1)) / c);
					const bottom = Math.round((height * (row + 1)) / r);
					tiles.push({ index: tiles.length, col, row, x, y, w: right - x, h: bottom - y });
				}
			}
			return tiles;
		}

		/** 转 angle 度之后还能留住的最大**同比例**矩形（矫正自动裁边：取景不变，只是斜边被裁掉）。 */
		function psInscribedSize(width, height, angleDeg) {
			const w = Math.max(1, width);
			const h = Math.max(1, height);
			const k = h / w;
			const angle = Math.abs((angleDeg * Math.PI) / 180);
			const sinA = Math.abs(Math.sin(angle));
			const cosA = Math.abs(Math.cos(angle));
			// 候选框的四条边在源图坐标里的投影都必须落在图内，取更紧的那一边
			const byWidth = w / (cosA + k * sinA);
			const byHeight = h / (k * cosA + sinA);
			const fit = Math.max(1, Math.min(byWidth, byHeight));
			return { w: Math.max(1, Math.round(fit)), h: Math.max(1, Math.round(fit * k)) };
		}

		/** 画布锚点：把 w×h 放进 cw×ch 时左上角该落在哪。anchor 用 nw/n/ne/… 九宫格。 */
		function psAnchorOffset(width, height, canvasW, canvasH, anchor) {
			const dx = { w: 0, c: (canvasW - width) / 2, e: canvasW - width };
			const dy = { n: 0, c: (canvasH - height) / 2, s: canvasH - height };
			const [vertical, horizontal] = anchor === "nw" || anchor === "n" || anchor === "ne"
				? [`n`, anchor === "nw" ? "w" : anchor === "ne" ? "e" : "c"]
				: anchor === "w" || anchor === "c" || anchor === "e"
					? ["c", anchor === "w" ? "w" : anchor === "e" ? "e" : "c"]
					: ["s", anchor === "sw" ? "w" : anchor === "se" ? "e" : "c"];
			return { x: Math.round(dx[horizontal]), y: Math.round(dy[vertical]) };
		}

		/** 行的「墨量」序列：把图转到 angle 度，按行数黑点，返回逐行差值平方的均值。
		 *  条纹被摆平时每行非黑即白，行间落差最大 —— 落差最大的角度就是歪了多少。
		 *  采样用双线性（最近邻在细条纹上会跳），阈值取全图均值，明暗底都吃得下。 */
		function psRowScore(luma, width, height, angleDeg, threshold) {
			const angle = (angleDeg * Math.PI) / 180;
			const sin = Math.sin(angle);
			const cos = Math.cos(angle);
			const cx = width / 2;
			const cy = height / 2;
			let cut = threshold;
			if (cut === undefined) {
				let sum = 0;
				for (let i = 0; i < luma.length; i += 1) sum += luma[i];
				cut = sum / Math.max(1, luma.length);
			}
			const counts = new Float64Array(height);
			for (let ry = 0; ry < height; ry += 1) {
				let ink = 0;
				for (let rx = 0; rx < width; rx += 1) {
					const dx = rx - cx;
					const dy = ry - cy;
					// 反向旋转：把输出行的每个点打回源图坐标采样
					const sx = dx * cos + dy * sin + cx;
					const sy = -dx * sin + dy * cos + cy;
					if (sx < 0 || sy < 0 || sx >= width - 1 || sy >= height - 1) continue;
					const x0 = sx | 0;
					const y0 = sy | 0;
					const fx = sx - x0;
					const fy = sy - y0;
					const top = luma[y0 * width + x0] * (1 - fx) + luma[y0 * width + x0 + 1] * fx;
					const bottom = luma[(y0 + 1) * width + x0] * (1 - fx) + luma[(y0 + 1) * width + x0 + 1] * fx;
					if (top * (1 - fy) + bottom * fy < cut) ink += 1;
				}
				counts[ry] = ink;
			}
			let score = 0;
			let pairs = 0;
			for (let i = 1; i < height; i += 1) {
				const diff = counts[i] - counts[i - 1];
				score += diff * diff;
				pairs += 1;
			}
			return pairs > 0 ? score / pairs : 0;
		}

		/** 自动矫正：在 ±maxAngle 里找让行落差最大的角度（正数 = 要顺时针补偿这么多）。 */
		function psDeskewAngle(luma, width, height, maxAngle = 8, step = 0.5) {
			let best = 0;
			let bestScore = -1;
			for (let angle = -maxAngle; angle <= maxAngle + 1e-9; angle += step) {
				const score = psRowScore(luma, width, height, angle);
				if (score > bestScore) {
					bestScore = score;
					best = angle;
				}
			}
			return Math.round(best * 10) / 10;
		}

		/** 位图 → 灰度数组（自动矫正要先降采样，全分辨率太慢）。 */
		function psLumaFromCanvas(canvas, maxSide = 220) {
			const scale = Math.min(1, maxSide / Math.max(canvas.width, canvas.height));
			const width = Math.max(8, Math.round(canvas.width * scale));
			const height = Math.max(8, Math.round(canvas.height * scale));
			const small = psCanvas(width, height);
			const ctx = small.getContext("2d");
			ctx.drawImage(canvas, 0, 0, width, height);
			const data = ctx.getImageData(0, 0, width, height).data;
			const luma = new Float64Array(width * height);
			for (let i = 0; i < width * height; i += 1) {
				luma[i] = 0.299 * data[i * 4] + 0.587 * data[i * 4 + 1] + 0.114 * data[i * 4 + 2];
			}
			return { luma, width, height };
		}

		/** 旋转（正数顺时针）。算完把内容转回正位，整张图跟着变大。 */
		function psRotate(canvas, angleDeg) {
			const angle = (angleDeg * Math.PI) / 180;
			const sin = Math.abs(Math.sin(angle));
			const cos = Math.abs(Math.cos(angle));
			const width = Math.round(canvas.width * cos + canvas.height * sin);
			const height = Math.round(canvas.width * sin + canvas.height * cos);
			const out = psCanvas(width, height);
			const ctx = out.getContext("2d");
			ctx.translate(width / 2, height / 2);
			ctx.rotate(angle);
			ctx.drawImage(canvas, -canvas.width / 2, -canvas.height / 2);
			return out;
		}

		/**
		 * 指针捕获：拖到画布外面也收得到 move。合成事件（自动化测试）里没有真实指针，
		 * setPointerCapture 会抛 NotFoundError —— 吞掉就好，事件照样按 target 派发。
		 */
		function psCapturePointer(element, pointerId) {
			try {
				element?.setPointerCapture?.(pointerId);
			} catch {
				/* 没有真实指针，忽略 */
			}
		}

		/** 旋转 + 裁到最大同比例内接矩形：拍照歪了那条「矫正」就是这个。 */
		function psStraighten(canvas, angleDeg) {
			const rotated = psRotate(canvas, angleDeg);
			const box = psInscribedSize(canvas.width, canvas.height, angleDeg);
			const sx = Math.round((rotated.width - box.w) / 2);
			const sy = Math.round((rotated.height - box.h) / 2);
			const out = psCanvas(box.w, box.h);
			out.getContext("2d").drawImage(rotated, sx, sy, box.w, box.h, 0, 0, box.w, box.h);
			return out;
		}

		/**
		 * 标尺（PS 的「拉直」就是这么干的）：在图上沿一条本该水平的边拖一条线，
		 * 返回「画面要转多少度才让它正」（就是 psStraighten 的入参）。纯函数，离线可测。
		 * 线比 45° 还陡就按「本该竖直」处理；拖得太短不当真（返回 null）。
		 */
		function psRulerAngle(from, to) {
			const dx = Number(to?.x) - Number(from?.x);
			const dy = Number(to?.y) - Number(from?.y);
			if (!Number.isFinite(dx) || !Number.isFinite(dy) || Math.hypot(dx, dy) < 8) return null;
			let deg = (Math.atan2(dy, dx) * 180) / Math.PI; // (-180, 180]
			if (deg > 90) deg -= 180;
			if (deg <= -90) deg += 180; // (-90, 90]
			let fix = -deg;
			if (fix > 45) fix -= 90;
			if (fix < -45) fix += 90;
			return Math.round(fix * 100) / 100;
		}

		/* ---------------- 四点透视矫正（变形 / 四点畸变 / 自由拉伸） ----------------
		 * 三件事共用一套投影变换（单应矩阵）：把「从哪儿取」的四边形映到「放到哪儿」的四边形。
		 *   flat    四点畸变：源四点框住倾斜的四边形，目标 = 自动算出的正矩形（把梯形拉平）
		 *   free    自由拉伸：源、目标都是任意四边形，八个角都能拖
		 *   distort 变形：源就是整图四角，只拖目标四点，整幅图跟着被拉成那个四边形
		 * 矩阵一律 9 元数组 [a,b,c,d,e,f,g,h,i]（i 恒为 1），作用在点上时 w = g·x + h·y + i。
		 * ------------------------------------------------------------------ */

		/** 高斯消元（部分主元）。matrix 是 n×n，vector 长 n；退化返回 null。 */
		function psSolveLinear(matrix, vector) {
			const n = vector.length;
			const a = matrix.map((row, index) => [...row.map(Number), Number(vector[index])]);
			for (let col = 0; col < n; col += 1) {
				let pivot = col;
				for (let row = col + 1; row < n; row += 1) {
					if (Math.abs(a[row][col]) > Math.abs(a[pivot][col])) pivot = row;
				}
				if (!(Math.abs(a[pivot][col]) > 1e-12)) return null;
				if (pivot !== col) {
					const held = a[pivot];
					a[pivot] = a[col];
					a[col] = held;
				}
				const lead = a[col][col];
				for (let row = col + 1; row < n; row += 1) {
					const factor = a[row][col] / lead;
					if (factor === 0) continue;
					for (let k = col; k <= n; k += 1) a[row][k] -= factor * a[col][k];
				}
			}
			const out = new Array(n).fill(0);
			for (let row = n - 1; row >= 0; row -= 1) {
				let sum = a[row][n];
				for (let k = row + 1; k < n; k += 1) sum -= a[row][k] * out[k];
				out[row] = sum / a[row][row];
			}
			return out.every((value) => Number.isFinite(value)) ? out : null;
		}

		/** 四点归一：接受 [{x,y}×4] 或 [[x,y]×4]；缺一个或不是数就返回 null。 */
		/** 四点排序：左上 → 右上 → 右下 → 左下（点选顺序随便，确认前先理顺，避免凹形/翻面）。 */
		function psQuadOrder(points) {
			if (!Array.isArray(points) || points.length !== 4) return null;
			const list = points.filter((point) => point && Number.isFinite(point.x) && Number.isFinite(point.y));
			if (list.length !== 4) return null;
			const cx = list.reduce((sum, point) => sum + point.x, 0) / 4;
			const cy = list.reduce((sum, point) => sum + point.y, 0) / 4;
			const sorted = list
				.slice()
				.sort((left, right) => Math.atan2(left.y - cy, left.x - cx) - Math.atan2(right.y - cy, right.x - cx));
			let start = 0;
			let best = Infinity;
			sorted.forEach((point, index) => {
				const score = point.x + point.y;
				if (score < best) {
					best = score;
					start = index;
				}
			});
			const ordered = [];
			for (let index = 0; index < 4; index += 1) ordered.push(sorted[(start + index) % 4]);
			return ordered;
		}

		function psQuadPoints(quad) {
			if (!quad || quad.length !== 4) return null;
			const out = [];
			for (const item of quad) {
				const x = Number(Array.isArray(item) ? item[0] : item?.x);
				const y = Number(Array.isArray(item) ? item[1] : item?.y);
				if (!Number.isFinite(x) || !Number.isFinite(y)) return null;
				out.push({ x, y });
			}
			return out;
		}

		/** 整图四角，顺序固定：左上、右上、右下、左下（后面所有四点都按这个顺序）。 */
		function psQuadCorners(width, height) {
			return [
				{ x: 0, y: 0 },
				{ x: width, y: 0 },
				{ x: width, y: height },
				{ x: 0, y: height }
			];
		}

		/** 四边内缩 ratio 之后的四点：初始位置，给手柄留出能抓住的余量。 */
		function psQuadInset(width, height, ratio) {
			const dx = Math.max(2, Math.round(width * ratio));
			const dy = Math.max(2, Math.round(height * ratio));
			return [
				{ x: dx, y: dy },
				{ x: Math.max(dx + 1, width - dx), y: dy },
				{ x: Math.max(dx + 1, width - dx), y: Math.max(dy + 1, height - dy) },
				{ x: dx, y: Math.max(dy + 1, height - dy) }
			];
		}

		/**
		 * 取图四点（src）：谁被当成源。
		 * **变形模式（distort）必须是原图四角** —— 变形是「把原图拉成形状」，源只能是整张原图；
		 * 畸变 / 自由拉伸允许用户自己框一小块，所以用存下来的四点。
		 */
		function warpSrcQuad(mode, src, width, height) {
			if (mode === "distort") return psQuadCorners(width, height);
			return src ?? null;
		}

		/** 拉平之后输出多大：对边取平均（上/下 → 宽，左/右 → 高），至少 1 像素。 */
		function psQuadFlatSize(quad) {
			const q = psQuadPoints(quad);
			if (!q) return null;
			const span = (p, r) => Math.hypot(r.x - p.x, r.y - p.y);
			const w = (span(q[0], q[1]) + span(q[3], q[2])) / 2;
			const h = (span(q[0], q[3]) + span(q[1], q[2])) / 2;
			return { w: Math.max(1, Math.round(w)), h: Math.max(1, Math.round(h)) };
		}

		/** 四点的外接矩形（自由拉伸 / 变形时的输出画布）。 */
		function psQuadBounds(quad) {
			const q = psQuadPoints(quad);
			if (!q) return null;
			const xs = q.map((point) => point.x);
			const ys = q.map((point) => point.y);
			const x = Math.floor(Math.min(...xs));
			const y = Math.floor(Math.min(...ys));
			return { x, y, w: Math.max(1, Math.ceil(Math.max(...xs) - x)), h: Math.max(1, Math.ceil(Math.max(...ys) - y)) };
		}

		/** 拖一个角：夹在图内，返回新的四点（原点不动）。 */
		function psMoveQuadPoint(quad, index, point, width, height) {
			const q = psQuadPoints(quad);
			if (!q || !(index >= 0 && index <= 3)) return q;
			const clamp = (value, max) => Math.max(0, Math.min(max, Number(value) || 0));
			const x = clamp(point?.x, width);
			const y = clamp(point?.y, height);
			return q.map((item, at) => (at === index ? { x, y } : item));
		}

		/** 命中哪个角：返回 {index, dist}，屏幕判定半径已经换算成图片坐标。 */
		function psHitQuad(quad, point, radius) {
			const q = psQuadPoints(quad);
			if (!q || !point) return null;
			let best = null;
			q.forEach((item, index) => {
				const dist = Math.hypot(item.x - point.x, item.y - point.y);
				if (dist <= radius && (!best || dist < best.dist)) best = { index, dist };
			});
			return best;
		}

		/** 单应矩阵：src 四点 → dst 四点（解 8 元线性方程组）。三点共线/重合这类退化返回 null。 */
		function psHomography(src, dst) {
			const S = psQuadPoints(src);
			const D = psQuadPoints(dst);
			if (!S || !D) return null;
			const matrix = [];
			const vector = [];
			for (let index = 0; index < 4; index += 1) {
				const { x, y } = S[index];
				const u = D[index].x;
				const v = D[index].y;
				matrix.push([x, y, 1, 0, 0, 0, -x * u, -y * u]);
				vector.push(u);
				matrix.push([0, 0, 0, x, y, 1, -x * v, -y * v]);
				vector.push(v);
			}
			const solved = psSolveLinear(matrix, vector);
			return solved ? [...solved, 1] : null;
		}

		/** 矩阵作用在一个点上（带透视除法）。 */
		function psApplyH(H, point) {
			if (!H || H.length !== 9 || !point) return null;
			const w = H[6] * point.x + H[7] * point.y + H[8];
			if (!Number.isFinite(w) || Math.abs(w) < 1e-12) return null;
			const x = (H[0] * point.x + H[1] * point.y + H[2]) / w;
			const y = (H[3] * point.x + H[4] * point.y + H[5]) / w;
			return Number.isFinite(x) && Number.isFinite(y) ? { x, y } : null;
		}

		/** 逆矩阵（伴随矩阵 / 行列式）：采样要反着查，用它把「源→目标」翻过来。 */
		function psInvertH(H) {
			if (!H || H.length !== 9) return null;
			const [a, b, c, d, e, f, g, h, i] = H;
			const c11 = e * i - f * h;
			const c12 = -(d * i - f * g);
			const c13 = d * h - e * g;
			const det = a * c11 + b * c12 + c * c13;
			if (!Number.isFinite(det) || Math.abs(det) < 1e-12) return null;
			const c21 = -(b * i - c * h);
			const c22 = a * i - c * g;
			const c23 = -(a * h - b * g);
			const c31 = b * f - c * e;
			const c32 = -(a * f - c * d);
			const c33 = a * e - b * d;
			return [c11 / det, c21 / det, c31 / det, c12 / det, c22 / det, c32 / det, c13 / det, c23 / det, c33 / det];
		}

		/** 3×3 矩阵相乘：先作用 b，再作用 a（都按上面那套 9 元数组摆）。 */
		function psMatMul(a, b) {
			const out = new Array(9).fill(0);
			for (let row = 0; row < 3; row += 1) {
				for (let col = 0; col < 3; col += 1) {
					out[row * 3 + col] = a[row * 3] * b[col] + a[row * 3 + 1] * b[3 + col] + a[row * 3 + 2] * b[6 + col];
				}
			}
			return out;
		}

		/** 缩放矩阵 diag(sx, sy, 1)。 */
		function psScaleH(sx, sy) {
			return [sx, 0, 0, 0, sy, 0, 0, 0, 1];
		}

		/**
		 * 实时预览用的一份降采样计划：输出按 outScale 缩放、源图压到 srcMax 以内，
		 * 两级缩放直接并进采样矩阵 —— 小图预览和大图结果走的还是同一套几何。
		 */
		function psWarpPreview(plan, { outScale = 1, srcW = 0, srcH = 0, srcMax = 0 } = {}) {
			if (!plan || !plan.inverse) return null;
			const k = Number.isFinite(outScale) && outScale > 0 ? outScale : 1;
			const srcSpan = Math.max(srcW, srcH);
			const q = srcMax > 0 && srcSpan > srcMax ? srcMax / srcSpan : 1;
			// 预览像素 → 计划输出 → 源图 → 降采样源图
			return {
				H: psMatMul(psScaleH(q, q), psMatMul(plan.inverse, psScaleH(1 / k, 1 / k))),
				w: Math.max(1, Math.round(plan.size.w * k)),
				h: Math.max(1, Math.round(plan.size.h * k)),
				outScale: k,
				srcScale: q
			};
		}

		/** 两组四点是不是同一个位置（容差内）：判断用户到底动没动过，没动就别往历史里塞。 */
		function psQuadsEqual(a, b, tol = 0.5) {
			const A = psQuadPoints(a);
			const B = psQuadPoints(b);
			if (!A || !B) return false;
			return A.every((point, index) => Math.abs(point.x - B[index].x) <= tol && Math.abs(point.y - B[index].y) <= tol);
		}

		/**
		 * 四点是不是一个凸的、不自交的四边形。
		 * 凹进去或交叉的四点解出来的单应矩阵会把画面翻到四边形外面去（画面上看着就是一团乱的镜像），
		 * 所以这种输入直接判死，比给出一个「能算但是错」的结果强。
		 */
		function psQuadConvex(quad) {
			const q = psQuadPoints(quad);
			if (!q) return false;
			let sign = 0;
			for (let index = 0; index < 4; index += 1) {
				const a = q[index];
				const b = q[(index + 1) % 4];
				const c = q[(index + 2) % 4];
				const cross = (b.x - a.x) * (c.y - b.y) - (b.y - a.y) * (c.x - b.x);
				if (!Number.isFinite(cross) || Math.abs(cross) < 1e-9) return false;
				const side = cross > 0 ? 1 : -1;
				if (sign === 0) sign = side;
				else if (side !== sign) return false;
			}
			return true;
		}

		/**
		 * 变形计划：把 UI 上的三个方式归一成「采样矩阵 + 输出尺寸」。
		 * 返回 { mode, from, to, size, bounds, forward（源→目标）, inverse（目标→源） }；退化返回 null。
		 */
		function psWarpPlan({ mode, src, dst, width, height }) {
			const from = psQuadPoints(src);
			if (!from || !Number.isFinite(width) || !Number.isFinite(height)) return null;
			if (!psQuadConvex(from)) return null;
			const kind = mode === "free" || mode === "distort" ? mode : "flat";
			let to = null;
			let size = null;
			let bounds = null;
			if (kind === "flat") {
				size = psQuadFlatSize(from);
				if (!size) return null;
				to = psQuadCorners(size.w, size.h);
				bounds = { x: 0, y: 0, w: size.w, h: size.h };
			} else {
				const target = psQuadPoints(dst);
				if (!target) return null;
				if (!psQuadConvex(target)) return null;
				bounds = psQuadBounds(target);
				if (!bounds) return null;
				size = { w: bounds.w, h: bounds.h };
				// 输出画布贴着目标四点的外接矩形：把目标平移到原点，取图侧不动
				to = target.map((point) => ({ x: point.x - bounds.x, y: point.y - bounds.y }));
			}
			const forward = psHomography(from, to);
			const inverse = psHomography(to, from);
			if (!forward || !inverse) return null;
			return { mode: kind, from, to, size, bounds, forward, inverse };
		}

		/**
		 * 逐像素反查源图做投影变换（双线性采样），查不到的地方留透明。
		 * H 是「输出坐标 → 源坐标」的单应矩阵；12M 像素量级也就一两秒，跟着「应用」走。
		 */
		function psWarpCanvas(canvas, H, outW, outH) {
			const w = Math.max(1, Math.round(Number(outW) || 1));
			const h = Math.max(1, Math.round(Number(outH) || 1));
			const out = psCanvas(w, h);
			if (!canvas || !H || H.length !== 9) return out;
			const sw = canvas.width;
			const sh = canvas.height;
			const src = canvas.getContext("2d").getImageData(0, 0, sw, sh).data;
			const ctx = out.getContext("2d");
			const image = ctx.createImageData(w, h);
			const dst = image.data;
			const [m0, m1, m2, m3, m4, m5, m6, m7, m8] = H;
			for (let y = 0; y < h; y += 1) {
				// 沿行递推：分母每步 +m6，分子每步 +m0 / +m3，省掉每像素的乘法
				let nx = m1 * y + m2;
				let ny = m4 * y + m5;
				let den = m7 * y + m8;
				for (let x = 0; x < w; x += 1, nx += m0, ny += m3, den += m6) {
					const at = (y * w + x) * 4;
					if (!(Math.abs(den) > 1e-12)) continue;
					const sx = nx / den;
					const sy = ny / den;
					if (!(sx >= -0.5 && sy >= -0.5 && sx <= sw - 0.5 && sy <= sh - 0.5)) continue;
					const x0 = Math.max(0, Math.min(sw - 1, Math.floor(sx)));
					const y0 = Math.max(0, Math.min(sh - 1, Math.floor(sy)));
					const x1 = Math.min(sw - 1, x0 + 1);
					const y1 = Math.min(sh - 1, y0 + 1);
					const fx = sx - Math.floor(sx);
					const fy = sy - Math.floor(sy);
					const i00 = (y0 * sw + x0) * 4;
					const i10 = (y0 * sw + x1) * 4;
					const i01 = (y1 * sw + x0) * 4;
					const i11 = (y1 * sw + x1) * 4;
					for (let ch = 0; ch < 4; ch += 1) {
						const top = src[i00 + ch] * (1 - fx) + src[i10 + ch] * fx;
						const bottom = src[i01 + ch] * (1 - fx) + src[i11 + ch] * fx;
						dst[at + ch] = Math.round(top * (1 - fy) + bottom * fy);
					}
				}
			}
			ctx.putImageData(image, 0, 0);
			return out;
		}

		/** 裁切。 */
		function psCrop(canvas, rect) {
			const box = psClampRect(rect, canvas.width, canvas.height);
			if (!box) return canvas;
			const out = psCanvas(box.w, box.h);
			out.getContext("2d").drawImage(canvas, box.x, box.y, box.w, box.h, 0, 0, box.w, box.h);
			return out;
		}

		/** 翻转。 */
		function psFlip(canvas, axis) {
			const out = psCanvas(canvas.width, canvas.height);
			const ctx = out.getContext("2d");
			ctx.translate(axis === "h" ? canvas.width : 0, axis === "v" ? canvas.height : 0);
			ctx.scale(axis === "h" ? -1 : 1, axis === "v" ? -1 : 1);
			ctx.drawImage(canvas, 0, 0);
			return out;
		}

		/** 缩放（默认保比例由调用方决定传不传死宽高）。 */
		function psResize(canvas, width, height) {
			const out = psCanvas(width, height);
			const ctx = out.getContext("2d");
			ctx.imageSmoothingQuality = "high";
			ctx.drawImage(canvas, 0, 0, out.width, out.height);
			return out;
		}

		/** 画布大小：扩边/缩边，锚点决定原图落点，背景默认透明。 */
		function psCanvasSize(canvas, width, height, anchor, fill) {
			const out = psCanvas(width, height);
			const ctx = out.getContext("2d");
			if (fill && fill !== "transparent") {
				ctx.fillStyle = fill;
				ctx.fillRect(0, 0, out.width, out.height);
			}
			const at = psAnchorOffset(canvas.width, canvas.height, out.width, out.height, anchor);
			ctx.drawImage(canvas, at.x, at.y);
			return out;
		}

		/** 羽化：把选区（或整张图）的边缘按半径柔化，外面变透明。
		 *  做法是拿一张蒙版按 destination-in 扣 alpha：边界落在选区线上，模糊半径取 r/2.4，
		 *  这样 alpha 从边界往外约 r 像素内淡到 0，r 像素以内基本回到实心（跟 PS 的手感一致）。 */
		function psFeather(canvas, rect, radius) {
			const r = Math.max(0, Math.round(radius));
			const box = psClampRect(rect, canvas.width, canvas.height);
			const out = psCanvas(canvas.width, canvas.height);
			const ctx = out.getContext("2d");
			ctx.drawImage(canvas, 0, 0);
			if (r <= 0) return out;
			const mask = psCanvas(canvas.width, canvas.height);
			const mctx = mask.getContext("2d");
			const target = box ?? { x: 0, y: 0, w: canvas.width, h: canvas.height };
			mctx.filter = `blur(${Math.max(0.6, r / 2.4)}px)`;
			mctx.fillStyle = "#fff";
			mctx.fillRect(target.x, target.y, target.w, target.h);
			mctx.filter = "none";
			if (box) {
				// 选区以外一律不留（PS 也是：羽化只作用在选区边上，外面本来就切掉）
				mctx.globalCompositeOperation = "destination-in";
				mctx.fillStyle = "#fff";
				mctx.fillRect(box.x, box.y, box.w, box.h);
				mctx.globalCompositeOperation = "source-over";
			}
			ctx.globalCompositeOperation = "destination-in";
			ctx.drawImage(mask, 0, 0);
			ctx.globalCompositeOperation = "source-over";
			return out;
		}

		/** 位图取一块出来（切割拆分用）。 */
		function psSlice(canvas, tile) {
			const out = psCanvas(tile.w, tile.h);
			out.getContext("2d").drawImage(canvas, tile.x, tile.y, tile.w, tile.h, 0, 0, tile.w, tile.h);
			return out;
		}

		/**
		 * 曲线编辑器：一条 0..255 的曲线，点一下加点、拖着动、右键删中间点。
		 * 两端只能上下动（x 钉在 0/255），中间点夹在邻居之间 —— 和 PS 的手感一致。
		 * 画的是 psCurveLut 的真 LUT，所以「看到的形状」就是「应用后的结果」。
		 */
		function CurveEditor({ points, onChange, onApply, disabled }) {
			const size = 216;
			const [dragIndex, setDragIndex] = useState(-1);
			const toCurve = (event) => {
				const rect = event.currentTarget.getBoundingClientRect();
				const x = ((event.clientX - rect.left) / Math.max(1, rect.width)) * 255;
				const y = 255 - ((event.clientY - rect.top) / Math.max(1, rect.height)) * 255;
				return { x: Math.max(0, Math.min(255, x)), y: Math.max(0, Math.min(255, y)) };
			};
			const lut = psCurveLut(points);
			const polyline = Array.from({ length: 256 }, (_, index) => `${index},${255 - lut[index]}`).join(" ");
			return h(
				"div",
				{ className: "vig-curve" },
				h(
					"svg",
					{
						className: "vig-curve-svg",
						viewBox: "0 0 256 256",
						width: size,
						height: size,
						"aria-label": t("ps.adjust.curves"),
						onPointerDown: (event) => {
							if (disabled) return;
							event.preventDefault();
							const point = toCurve(event);
							const hit = psCurveHit(points, point.x, point.y);
							if (hit >= 0) {
								setDragIndex(hit);
								return;
							}
							const next = psCurveAdd(points, point.x, point.y);
							onChange(next);
							setDragIndex(psCurveHit(next, point.x, point.y));
						},
						onPointerMove: (event) => {
							if (disabled || dragIndex < 0) return;
							event.preventDefault();
							const point = toCurve(event);
							onChange(psCurveMove(points, dragIndex, point.x, point.y));
						},
						onPointerUp: () => setDragIndex(-1),
						onPointerCancel: () => setDragIndex(-1),
						onContextMenu: (event) => {
							event.preventDefault();
							if (disabled) return;
							const point = toCurve(event);
							const hit = psCurveHit(points, point.x, point.y);
							if (hit >= 0) onChange(psCurveRemoveAt(points, hit));
						},
						style: { touchAction: "none", cursor: disabled ? "not-allowed" : "crosshair" }
					},
					[0, 64, 128, 192].map((at) =>
						h("line", { key: `v${at}`, x1: at, y1: 0, x2: at, y2: 256, className: "vig-curve-grid" })
					),
					[0, 64, 128, 192].map((at) =>
						h("line", { key: `h${at}`, x1: 0, y1: at, x2: 256, y2: at, className: "vig-curve-grid" })
					),
					h("line", { x1: 0, y1: 256, x2: 256, y2: 0, className: "vig-curve-diagonal" }),
					h("polyline", { points: polyline, className: "vig-curve-line" }),
					(points ?? []).map((point, index) =>
						h("circle", {
							key: `p${index}`,
							cx: point[0],
							cy: 255 - point[1],
							r: dragIndex === index ? 6 : 5,
							className: "vig-curve-dot"
						})
					)
				),
				h(
					"div",
					{ className: "vig-row" },
					h("span", { className: "vig-muted", style: { fontSize: 11 } }, t("ps.adjust.curveHint")),
					h("div", { className: "vig-spacer" }),
					h("button", { className: "vig-btn is-primary is-sm", disabled, onClick: onApply }, t("ps.adjust.applyCurve"))
				)
			);
		}

		// 最近一次选图持有从取图到提交的所有权；即使底层忽略 abort，旧回包也不能写入当前文档。
		function psReadChannel() {
			let current = null;
			const cancel = () => { const previous = current; current = null; previous?.abort(); };
			return { cancel, async run(work, commit, onError, onBusy) {
				cancel(); const task = new AbortController(); current = task; onBusy(true);
				try {
					const image = await work(task.signal);
					if (task !== current) return false;
					return commit(image) !== false;
				} catch (error) {
					if (task === current) onError(error);
					return false;
				} finally { if (task === current) { current = null; onBusy(false); } }
			} };
		}

		function psAdjustDefaults() {
			return { brightness:0, contrast:0, saturation:0, vibrance:0, hue:0, grayscale:false,
				invert:false, inBlack:0, inWhite:255, gamma:1, blur:0, sharpen:0, noise:0 };
		}

		async function psDecodeInput(input, signal, size) {
			signal.throwIfAborted();
			if (input.canvas) return {canvas:input.canvas, dpi:input.dpi || 72};
			let blob = input.file, src = input.dataUrl, owned = null;
			if (!blob && !src) {
				const {request} = gridImageSource(input.url, document.baseURI, location.href);
				const response = await fetch(request, {signal, credentials:"same-origin"});
				if (!response.ok) throw new Error(`取图失败 HTTP ${response.status}`);
				blob = await response.blob();
			}
			signal.throwIfAborted();
			try {
				if (blob) { if (!blob.size) throw new Error(t("grid.badImage")); owned = URL.createObjectURL(blob); src = owned; }
				else if (!/^data:image\//i.test(src || "")) throw new Error(t("grid.badImage"));
				const image = await gridNativeImage(src, signal);
				signal.throwIfAborted();
				const w = image.naturalWidth, h = image.naturalHeight;
				if (!w || !h) throw new Error(t("grid.badImage"));
				if (Math.max(w,h)>16384 || w*h>48*1024*1024) throw new RangeError(t("grid.imageLimit"));
				// 文件和 URL 都不经整图 base64 中转；DPI 只查前 256 KiB，新增图层沿用文档 DPI。
				const dpi = size ? 72 : (blob ? psReadDpiBytes(new Uint8Array(await blob.slice(0,256*1024).arrayBuffer())) : psReadDpi(src)) || 72;
				signal.throwIfAborted();
				const canvas = psCanvas(size?.width || w, size?.height || h);
				canvas.getContext("2d").drawImage(image, 0, 0, canvas.width, canvas.height);
				return {canvas, dpi};
			} finally { if (owned) URL.revokeObjectURL(owned); }
		}

		// 未选择素材时不创建 img；原生 loading=lazy 对视口附近的折叠内容也会发请求。
		function PsAssetShelf({ kind, label, items, onOpen }) {
			const [limit, setLimit] = useState(0);
			if (!items.length) return null;
			return h("section", { className: "vig-ps-shelf" },
				h("button", { type: "button", className: "vig-ps-shelf-toggle", "data-ps-browse": kind,
					"aria-expanded": limit > 0, onClick: () => setLimit(n => n ? 0 : 8) },
					h(Icon, {name: limit ? "chevronDown" : "chevron", size: 13}), label,
					h("span", {className:"vig-muted"}, items.length)),
				limit > 0 && h("div", { className:"vig-ps-recent-grid" }, items.slice(0, limit).map(item => {
					const sample = kind === "samples", name = sample ? (item.title || t("ps.empty.samples")) : item.name;
					const asset = sample ? { url:item.image, name } : item;
					return h("button", {type:"button", key:item.id || asset.url, className:"vig-ps-recent-tile", title:name,
						onClick:() => onOpen(sample ? `${name}.png` : name, asset.url)}, h(GalleryThumb, {asset}));
				})),
				limit > 0 && limit < items.length && h("button", {type:"button", className:"vig-link", onClick:() => setLimit(n => n + 8)}, t("ps.empty.more")));
		}

		// Committed bitmaps are immutable. Inspect alpha only when a target is explicitly selected.
		const psInkCache = new WeakMap();
		function psInkBounds(bitmap, revision) {
			const cached=psInkCache.get(bitmap);
			if(cached && cached.revision===revision) return cached.box;
			const {width:w,height:h}=bitmap, ctx=bitmap.getContext('2d');
			let left=w,right=-1,top=h,bottom=-1;
			for(let row=0;row<h;row+=64){
				const lines=Math.min(64,h-row), bytes=ctx.getImageData(0,row,w,lines).data;
				for(let y=0;y<lines;y++){
					let first=0,last=w-1, offset=y*w*4+3;
					while(first<w && !bytes[offset+first*4]) first++;
					if(first===w) continue;
					while(last>first && !bytes[offset+last*4]) last--;
					left=Math.min(left,first);right=Math.max(right,last);top=Math.min(top,row+y);bottom=row+y;
				}
			}
			const box=right<left ? null : {x:left/w,y:top/h,w:(right-left+1)/w,h:(bottom-top+1)/h};
			psInkCache.set(bitmap,{revision,box});return box;
		}
		function psGripBox(box, grip, dx, dy, keep) {
			dx=Math.round(dx);dy=Math.round(dy);
			if(grip==='move') return {...box,x:box.x+dx,y:box.y+dy};
			const hx=grip.includes('w')?-1:grip.includes('e')?1:0, hy=grip.includes('n')?-1:grip.includes('s')?1:0;
			let w=Math.max(1,box.w+dx*hx),h=Math.max(1,box.h+dy*hy);
			if(keep){const factor=hx && (!hy || Math.abs(dx/box.w)>=Math.abs(dy/box.h))?w/box.w:h/box.h;w=Math.max(1,box.w*factor);h=Math.max(1,box.h*factor);}
			return {x:box.x+(hx<0?1:hx===0?0.5:0)*(box.w-w),y:box.y+(hy<0?1:hy===0?0.5:0)*(box.h-h),w,h};
		}
		// All boxes use coordinates in the document at pointerdown; a negative extent origin
		// adds padding on the left/top without rescaling any of the stationary content.
		function psGripExtent(to,w,h){
			const x=Math.floor(Math.min(0,to.x)),y=Math.floor(Math.min(0,to.y));
			return {x,y,w:Math.ceil(Math.max(w,to.x+to.w))-x,h:Math.ceil(Math.max(h,to.y+to.h))-y};
		}
		function psGripWithinBudget(ext,planes=1){
			return [ext.x,ext.y,ext.w,ext.h].every(Number.isFinite) && ext.w>0 && ext.h>0 && ext.w<=16384 && ext.h<=16384 && ext.w*ext.h<=67108864 && ext.w*ext.h*planes<=134217728;
		}
		function psGripBitmap(bitmap,from,to,docW,docH,ext,outW=ext.w,outH=ext.h){
			const result=psCanvas(outW,outH),kx=to.w/from.w,ky=to.h/from.h;
			result.getContext('2d').drawImage(bitmap,(to.x-from.x*kx-ext.x)*outW/ext.w,(to.y-from.y*ky-ext.y)*outH/ext.h,kx*docW*outW/ext.w,ky*docH*outH/ext.h);
			return result;
		}
		const psGripClipCache=new WeakMap(); // Raw pixels / prior masks survive undo and expanding a previously restricted window.
		function psGripClip(bitmap,rect,w,h,outW,outH){
			const out=psCanvas(outW,outH),ctx=out.getContext('2d');ctx.scale(outW/w,outH/h);
			ctx.beginPath();ctx.rect(rect.x,rect.y,rect.w,rect.h);ctx.clip();
			if(bitmap) ctx.drawImage(bitmap,0,0,w,h);else {ctx.fillStyle='white';ctx.fillRect(0,0,w,h);}return out;
		}
		function psGripMask(canvas){
			const data=canvas.getContext('2d').getImageData(0,0,canvas.width,canvas.height).data,alpha=new Uint8ClampedArray(canvas.width*canvas.height);
			for(let i=0;i<alpha.length;i++) alpha[i]=data[4*i+3];return {canvas,alpha};
		}
		function PsView({ state, actions, initial, initialUrl, onConsumeInitialUrl }) {
			// 提示统一走宿主注入的 actions.toast：PsView 里没有提示容器，
			// 壳里那份 .vig-toasts 才是唯一的（以前这里直接调全局 toast，等于每条提示都报 ReferenceError）
			const notify = actions?.toast ?? (() => {});
			const [source, setSource] = useState(initial || null); // {name, canvas, width, height}
			const recentAssets = useMemo(() => (state.library || []).slice(0, 24), [state.library]);
			const sampleAssets = useMemo(() => {
				const found = [];
				for (const item of state.presets || []) { if (item.image) found.push(item); if (found.length === 12) break; }
				return found;
			}, [state.presets]);
			const [tool, setTool] = useState(initial?.tool || "select");
			const [selection, setSelection] = useState(initial?.selection || null);
			const [drag, setDrag] = useState(null);
			const [history, setHistory] = useState({ past: [], future: [] });
			const [busy, setBusy] = useState("");
			// 拖一张图进来就直接载入（用户原话：支持拖入）
			const [fileOver, setFileOver] = useState(false);
			// 曲线的控制点（默认恒等；预设按钮改的就是它）
			const [curve, setCurve] = useState([[0, 0], [255, 255]]);
			// 「调整」的参数（亮度/对比度/饱和度/色相 + 灰度/反相）
			const [adjust, setAdjust] = useState(psAdjustDefaults);
			const [reading, setReading] = useState(false);
			const readChannelRef = useRef(null);
			if (!readChannelRef.current) readChannelRef.current = psReadChannel();
			const reads = readChannelRef.current;
			const invalidatePsReads = () => { reads.cancel(); setReading(false); };
			useMeasureEffect(() => () => reads.cancel(), [reads]);
			// 图层（叠加算法）：底图之外再叠几层，默认空（initial.layers = 静态预览 / 截图用的种子）
			const [layers, setLayers] = useState(() => (Array.isArray(initial?.layers) ? initial.layers : []));
			// 单层编辑会话：正在把哪一层当底图在改（null = 改底图）；initial.layerSession 同样是预览种子
			const [layerSession, setLayerSession] = useState(() => initial?.layerSession || null);
			// 底部控制条：当前选中的图层（"" = 底图）与正在拖拽的图层
			const [activeLayerId, setActiveLayerId] = useState("");
			// 右栏图层列表默认收起（图层操作走底部控制条；展开可看叠加算法 / 不透明度等高级项）
			const [layersOpen, setLayersOpen] = useState(false);
			/* 右侧收纳：图层面板可整体收起（localStorage 记住），腾出画布宽度 */
			const [layersAside, setLayersAside] = useState(() => {
				try {
					return window.localStorage.getItem("dsh.velapi-image-go.ps-layers-aside") !== "0";
				} catch (error) {
					return true;
				}
			});
			const setLayersAsidePersist = (open) => {
				setLayersAside(open);
				try {
					window.localStorage.setItem("dsh.velapi-image-go.ps-layers-aside", open ? "1" : "0");
				} catch (error) {
					/* 隐私模式写不了就只活这次 */
				}
			};
			const [dragLayerId, setDragLayerId] = useState("");
			// 会话锁：state 要等下一轮渲染才看得到，连点两下同一层靠这个 ref 当场挡掉
			const layerSessionRef = useRef(initial?.layerSession || null);
			// 「加图层」从图库挑：复用同一个选择器，只是挑回来当成一层
			const [layerPick, setLayerPick] = useState(false);
			// 底部控制条缩略图（底图 + 各层）：随 source / layers 变化重算
			const layerThumbs = useMemo(() => {
				const base = psLayerThumb((layerSession?.base ?? source)?.canvas);
				const items = layers.map(layer => psLayerThumb(layer.id === layerSession?.id ? source?.canvas : layer.canvas, 56, layer.pixelRevision));
				return { base, items };
			}, [source, layers, layerSession]);
			// 控制条选中的图层（"" = 底图）：属性条（叠加算法 / 不透明度 / 顺序 / 蒙版 / 删除）跟着它走
			const activeLayerIndex = (layers || []).findIndex((item) => item.id === activeLayerId);
			const activeLayer = activeLayerIndex >= 0 ? layers[activeLayerIndex] : null;
			// 手势内 slider 多次 input 只产生一步历史，键盘/独立点击则分别记。其余结构变更必须截断合并。
			const opacityGesture = useRef(null);
			const layerControlsLocked = Boolean(layerSession) || !source?.canvas;
			const changeLayers = (label, update, nextId, gesture = null) => {
				if (layerSessionRef.current || !source?.canvas) return false;
				const next = update(layers);
				if (next === layers || (next.length === layers.length && next.every((item, i) => item === layers[i]))) return false;
				if (!gesture || gesture.last !== layers) pushHistory(source.canvas, label);
				if (gesture) gesture.last = next;
				else opacityGesture.current = null;
				setLayers(next);
				if (nextId !== undefined) setActiveLayerId(nextId);
				else if (activeLayerId && !next.some(item => item.id === activeLayerId)) setActiveLayerId("");
				return true;
			};
			const editLayer = (id, key, patch, gesture) => changeLayers(t(key), list => list.map(item => item.id !== id ? item : patch(item)), undefined, gesture);
			const toggleLayer = id => editLayer(id, "ps.layer.visible", layer => ({...layer,visible:layer.visible === false}));
			const removeLayer = id => changeLayers(t("ps.layer.remove"), list => list.filter(item => item.id !== id));
			const moveLayer = (index, delta) => changeLayers(t(delta > 0 ? "ps.layer.up" : "ps.layer.down"), list => psMoveLayer(list, index, delta));
			const layerModeProps = layer => ({
				disabled:layerControlsLocked, value:layer.mode || "normal", title:t("ps.layer.mode"),
				onChange:e => { const mode=e.target.value; editLayer(layer.id,"ps.layer.mode", l => (l.mode || "normal") === mode ? l : {...l,mode}); }
			});
			const layerOpacityProps = layer => ({
				disabled:layerControlsLocked, type:"range", min:0,max:100,step:1,value:Math.round((layer.opacity ?? 1)*100),title:t("ps.layer.opacity"),
				onPointerDown:() => { opacityGesture.current={id:layer.id}; },
				onPointerUp:() => { opacityGesture.current=null; }, onPointerCancel:() => { opacityGesture.current=null; }, onBlur:() => { opacityGesture.current=null; },
				onChange:e => { const opacity=Number(e.target.value)/100; editLayer(layer.id,"ps.layer.opacity",l => (l.opacity ?? 1) === opacity ? l : {...l,opacity}, opacityGesture.current?.id === layer.id ? opacityGesture.current : null); }
			});
			const toggleLayerMask = layer => editLayer(layer.id,layer.mask ? "ps.layer.maskInvert" : "ps.layer.maskAdd", l => {
				const dims = psMaskDims(l.mask, l.mask ? l.canvas : source.canvas);
				const alpha = l.mask ? psInvertAlpha(l.mask.alpha) : psMaskAlpha(dims.w, dims.h, selection);
				return {...l, mask:{canvas:psMaskCanvas(dims.w, dims.h, alpha), alpha}};
			});
			// 参数面板浮窗的位置（拖过就记住）
			const [floatPos, setFloatPos] = useState(() => {
				try {
					const saved = JSON.parse(window.localStorage.getItem("dsh.velapi-image-go.ps.float") ?? "null");
					if (saved && Number.isFinite(saved.x) && Number.isFinite(saved.y)) return saved;
				} catch {
					/* 坏数据就当没存过 */
				}
				return { x: 108, y: 12 };
			});
			const [splitCols, setSplitCols] = useState(2);
			const [splitRows, setSplitRows] = useState(2);
			const [tiles, setTiles] = useState([]);
			const [angle, setAngle] = useState(0);
			const [featherRadius, setFeatherRadius] = useState(12);
			const [featherTarget, setFeatherTarget] = useState("all");
			const [canvasSize, setCanvasSize] = useState({ w: initial?.width || 0, h: initial?.height || 0, anchor: "c", fill: "transparent" });
			const [canvasUnit, setCanvasUnit] = useState("px");
			const [dpi, setDpi] = useState(Number(initial?.dpi) || 72);
			const [target, setTarget] = useState({ w: initial?.width || 0, h: initial?.height || 0, keep: true });
			const [flipAxis, setFlipAxis] = useState("h");
			// 标尺：矫正工具拖出来的参考线（图片坐标），拖的时候画面跟着转，松手提交
			const [ruler, setRuler] = useState(() => initial?.ruler || null);
			// 四点透视矫正：src = 从哪儿取（蓝），dst = 放到哪儿（橙）。flat 模式没有 dst（目标是自动算的矩形）。
			// initial.warp 是给静态预览/截图用的种子（预览里没有真 canvas，effect 摆不了初值）。
			const warpSeed = initial?.warp || null;
		// 变形模式的源永远钉在原图四角；这里把种子也规范化一次，免得预览/老状态把源带歪
		const seedSrc = warpSeed?.src && initial?.warpMode !== "distort" ? warpSeed.src : null;
			const [warp, setWarp] = useState(() => ({ mode: initial?.warpMode || "flat", src: seedSrc, dst: warpSeed?.dst || null }));
			// 一边看原图（放四点）、一边看结果（定形状）。取图四点画在原图上才对得准，
			// 目标四点画在结果上才对得齐 —— 两边在同一个视图里会重叠成一个，所以给个切换。
			const [warpSide, setWarpSide] = useState(() => (initial?.warpMode === "distort" ? "dst" : "src"));
			const [warpResultId, setWarpResultId] = useState("");
			const warpLocked = Boolean(warpResultId && layerSession?.id === warpResultId);
			const warpPick = warp.mode === "flat" ? warp.src?.length || 0 : 4;
			const [keysOpen, setKeysOpen] = useState(() => Boolean(initial?.keys));
			// 两侧面板按需展开：默认都展开，用户收起过才记住（存 "0"），和停靠面板同一套逻辑
			const [panels, setPanels] = useState(() => {
				if (typeof initial?.collapsed === "boolean") return { labels: !initial.collapsed, params: !initial.collapsed };
				const read = (key) => window.localStorage.getItem(key) !== "0";
				return { labels: read("dsh.velapi-image-go.ps.tools"), params: read("dsh.velapi-image-go.ps.params") };
			});
			const [pickOpen, setPickOpen] = useState(false);
			// 自定义键位：只存「和默认不一样」的那几条，以后默认键位改了照样吃到新的
			const [overrides, setOverrides] = useState(() => {
				if (initial?.bindings) return initial.bindings;
				try {
					return JSON.parse(window.localStorage.getItem("dsh.velapi-image-go.ps.bindings") || "{}") || {};
				} catch {
					return {};
				}
			});
			const [recording, setRecording] = useState("");
			const [keyError, setKeyError] = useState("");
			/** 键位落两处：浏览器本地立刻生效；宿主 config.json 跨更新活着（宿主老版本忽略该字段，自动退回本地）。 */
			const saveBindings = (next) => {
				try {
					window.localStorage.setItem("dsh.velapi-image-go.ps.bindings", JSON.stringify(next));
				} catch {
					/* 隐私模式写不进去也不影响当前会话 */
				}
				void call("/config", { method: "POST", body: { shortcuts: JSON.stringify(next) } }).catch(() => {});
			};
			useEffect(() => {
				// 宿主那边有就更信宿主（换端口清掉 localStorage 之后靠它把键位捞回来）
				void call("/config")
					.then((data) => {
						const raw = data?.config?.shortcuts;
						if (typeof raw !== "string" || !raw.trim()) return;
						const parsed = JSON.parse(raw);
						if (parsed && typeof parsed === "object" && Object.keys(parsed).length) setOverrides(parsed);
					})
					.catch(() => {});
			}, []);
			const fileRef = useRef(null);
			const stageRef = useRef(null);
			const scrollRef = useRef(null);
			const viewRef = useRef(null);
			const overlayRef = useRef(null);
			const panRef = useRef(null);
			const pendingScroll = useRef(null);
			const scaleRef = useRef(1);
			const [view, setView] = useState({ fit: 1, rect: { x: 0, y: 0, w: 1, h: 1 } });
			// 缩放：fit = 跟着容器适应；actual = 1:1；free = 用户滚轮/按钮定的比例
			const [zoom, setZoom] = useState(() => {
				const given = Number(initial?.scale);
				return Number.isFinite(given) && given > 0 && given !== 1 ? { mode: "free", scale: psClampZoom(given) } : { mode: "fit", scale: 1 };
			});

			const stage = source ? source.canvas : null;
			useMeasureEffect(() => { setTiles(list => list.length ? [] : list); }, [stage, layers, layerSession, splitCols, splitRows]);
			// 静态预览分支只有宽高没有 canvas，参数栏读尺寸、画布算显示尺寸都统一走这两个值
			const stageW = stage ? stage.width : source?.width || 0;
			const stageH = stage ? stage.height : source?.height || 0;
			const gripRef=useRef(null), [gripDraft,setGripDraft]=useState(null), [gripMode,setGripMode]=useState('pixels');
			const gripLayer=!layerSession && activeLayer ? activeLayer : null;
			const gripBitmap=tool==='transform' && (gripLayer ? gripLayer.visible!==false && gripLayer.canvas : stage);
			const gripClipKey=gripLayer?gripLayer.mask?.canvas:gripBitmap;
			const gripClip=gripClipKey && psGripClipCache.get(gripClipKey);
			const gripBox=useMemo(()=>{
				if(!gripBitmap) return null;
				const b=gripMode==='mask' && gripClip ? gripClip.rect : psInkBounds(gripBitmap,gripLayer?.pixelRevision);
				return b && {x:b.x*stageW,y:b.y*stageH,w:b.w*stageW,h:b.h*stageH};
			},[gripBitmap,gripClip,gripMode,gripLayer?.pixelRevision,stageW,stageH]);
			const gripShown=gripDraft?.to || gripBox;
			const gripExtent=gripDraft?.ext || {x:0,y:0,w:stageW,h:stageH};
			useMeasureEffect(()=>{if(tool!=='transform')setGripMode('pixels');},[tool]);
			useMeasureEffect(()=>{setGripMode('pixels');},[activeLayerId,layerSession?.id]);
			useMeasureEffect(()=>{gripRef.current=null;setGripDraft(null);},[tool,stage,layers,layerSession,activeLayerId,gripMode]);
			const scale = zoom.mode === "fit" ? view.fit : zoom.mode === "actual" ? 1 : zoom.scale;
			scaleRef.current = scale;

			// 平面矫正只保存真实点击，不用四个默认角和另一份计数假装已选。
			const warpInitial = (mode, width, height) => ({ mode,
				src: mode === "flat" ? [] : psQuadCorners(width, height),
				dst: mode === "flat" ? null : psQuadCorners(width, height)
			});
			const warpPlanNow = tool === "warp" && stageW && stageH && !warpLocked ? psWarpPlan({ mode: warp.mode,
				src: warp.mode === "flat" ? psQuadOrder(warp.src) : warpSrcQuad(warp.mode, warp.src, stageW, stageH),
				dst: warp.dst, width: stageW, height: stageH
			}) : null;
			const shownW = stageW, shownH = stageH;
			const canvasW = Math.max(1, Math.round(stageW * scale));
			const canvasH = Math.max(1, Math.round(stageH * scale));
			// 预览缓冲跟随实际屏幕像素，不按源文件分辨率复制；原件仍保存在 source 用于编辑/导出。
			const renderScale = stage ? Math.min(1, scale * Math.min(2, typeof window === "undefined" ? 1 : Math.max(1, Number(window.devicePixelRatio) || 1))) : 1;
			const renderW = Math.max(1, Math.ceil(gripExtent.w * renderScale));
			const renderH = Math.max(1, Math.ceil(gripExtent.h * renderScale));
			useEffect(() => {
				if (!stage || tool !== "warp") return;
				setWarp(warpInitial(warp.mode, stage.width, stage.height));
				setWarpSide(warp.mode === "distort" ? "dst" : "src");
				setDrag(null);
			}, [stage, warp.mode, tool]);

			/** 主预览按屏幕像素绘制，避免为 8K 原图分配同尺寸副本。 */
			useEffect(() => {
				const canvas = viewRef.current;
				const shown = stage;
				if (!canvas || !shown) return;
				if (canvas.width !== renderW) canvas.width = renderW;
				if (canvas.height !== renderH) canvas.height = renderH;
				let base=shown,stack=psCanvasLayers(layers,Boolean(layerSession));
				if(gripDraft && gripRef.current){
					const {from,to,ext}=gripDraft,doc={x:0,y:0,w:stageW,h:stageH};
					if(gripMode==='mask'){
						const clip=b=>psGripClip(b,to,stageW,stageH,renderW,renderH);
						if(!gripLayer) base=clip(gripClip?.raw || shown);
						else stack=stack.map(l=>l===gripLayer?{...l,mask:{canvas:clip((gripClip ? gripClip.previous : l.mask)?.canvas)}}:l);
					}else{
						const expanded=ext.w!==stageW || ext.h!==stageH;
						const draw=(b,target)=>target||expanded?psGripBitmap(b,target?from:doc,target?to:doc,stageW,stageH,ext,renderW,renderH):b;
						base=draw(shown,!gripLayer);
						stack=stack.map(l=>!l.canvas||l.visible===false||(!expanded&&l!==gripLayer)?l:{...l,canvas:draw(l.canvas,l===gripLayer),mask:l.mask?.canvas?{canvas:draw(l.mask.canvas,l===gripLayer)}:l.mask});
					}
				}
				psPaintStack(canvas,base,stack);
			}, [stage,layers,layerSession,renderW,renderH,gripDraft,gripLayer]);

			/** 选区 / 切割线画在第二层：拖动时只重画这一层。线宽按缩放比折算，视觉粗细恒定。 */
			const needsOverlay = Boolean(selection || tool === "split" || ruler || (tool === "warp" && !warpLocked && ((warpSide === "dst" ? warp.dst : warp.src)?.length)));
			useEffect(() => {
				const canvas = overlayRef.current;
				const shown = stage;
				if (!canvas || !shown) return;
				if (!needsOverlay) {
					if (canvas.width !== 1) canvas.width = 1;
					if (canvas.height !== 1) canvas.height = 1;
					return;
				}
				if (canvas.width !== renderW) canvas.width = renderW;
				if (canvas.height !== renderH) canvas.height = renderH;
				const ctx = canvas.getContext("2d");
				ctx.setTransform(renderW / stage.width, 0, 0, renderH / stage.height, 0, 0);
				ctx.clearRect(0, 0, stage.width, stage.height);
				const thin = 1.4 / scale;
				if (selection) {
					ctx.save();
					ctx.fillStyle = "rgba(11,11,12,.12)";
					ctx.fillRect(selection.x, selection.y, selection.w, selection.h);
					ctx.strokeStyle = "#0b0b0c";
					ctx.lineWidth = thin;
					ctx.setLineDash([6 / scale, 4 / scale]);
					ctx.strokeRect(selection.x, selection.y, selection.w, selection.h);
					ctx.setLineDash([]);
					const size = Math.max(8 / scale, Math.round(7 / scale));
					ctx.fillStyle = "#fff";
					for (const handle of psHandles(selection)) {
						ctx.fillRect(handle.x - size / 2, handle.y - size / 2, size, size);
						ctx.strokeRect(handle.x - size / 2, handle.y - size / 2, size, size);
					}
					ctx.restore();
				}
				if (tool === "split") {
					ctx.save();
					ctx.strokeStyle = "rgba(11,11,12,.8)";
					ctx.lineWidth = thin;
					for (const tile of psSplitTiles(stage.width, stage.height, splitCols, splitRows)) {
						ctx.strokeRect(tile.x, tile.y, tile.w, tile.h);
					}
					ctx.restore();
				}
				/* 标尺：参考线 + 端点 + 实时角度；再画一圈「裁完还剩多少」（画面在转，这个框不转） */
				if (ruler) {
					const angle = psRulerAngle(ruler.from, ruler.to);
					ctx.save();
					ctx.strokeStyle = "#0b0b0c";
					ctx.lineWidth = thin;
					ctx.setLineDash([7 / scale, 5 / scale]);
					ctx.beginPath();
					ctx.moveTo(ruler.from.x, ruler.from.y);
					ctx.lineTo(ruler.to.x, ruler.to.y);
					ctx.stroke();
					ctx.setLineDash([]);
					const tick = Math.max(10 / scale, 6 / scale);
					for (const point of [ruler.from, ruler.to]) {
						ctx.beginPath();
						ctx.moveTo(point.x - tick, point.y);
						ctx.lineTo(point.x + tick, point.y);
						ctx.moveTo(point.x, point.y - tick);
						ctx.lineTo(point.x, point.y + tick);
						ctx.stroke();
					}
					if (angle !== null) {
						const box = psInscribedSize(stage.width, stage.height, angle);
						const bx = (stage.width - box.w) / 2;
						const by = (stage.height - box.h) / 2;
						ctx.fillStyle = "rgba(16,24,40,.4)";
						ctx.beginPath();
						ctx.rect(0, 0, stage.width, stage.height);
						ctx.rect(bx, by, box.w, box.h);
						ctx.fill("evenodd");
						ctx.strokeStyle = "rgba(255,255,255,.9)";
						ctx.lineWidth = 1.6 / scale;
						ctx.strokeRect(bx, by, box.w, box.h);
					}
					ctx.restore();
				}
				if (tool === "warp" && !warpLocked) {
					const points = (warpSide === "dst" ? warp.dst : warp.src) || [];
					if (!points.length) return;
					const outline = warp.mode === "flat" && points.length === 4 ? psQuadOrder(points) : points;
					const stroke = warpSide === "dst" ? "#f08a24" : "#18a05a";
					ctx.save();
					ctx.beginPath();
					outline.forEach((p, i) => i ? ctx.lineTo(p.x, p.y) : ctx.moveTo(p.x, p.y));
					if (points.length === 4) { ctx.closePath(); ctx.fillStyle = warpSide === "dst" ? "rgba(240,138,36,.14)" : "rgba(24,160,90,.14)"; ctx.fill(); }
					ctx.strokeStyle = stroke;
					ctx.lineWidth = 1.6 / scale;
					ctx.stroke();
					const size = 9 / scale;
					ctx.font = `600 ${11 / scale}px system-ui, sans-serif`;
					points.forEach((p, i) => {
						ctx.fillStyle = "#fff";
						ctx.fillRect(p.x-size/2, p.y-size/2, size, size);
						ctx.strokeRect(p.x-size/2, p.y-size/2, size, size);
						ctx.fillStyle = stroke;
						ctx.fillText(String(i+1), p.x+size, p.y-size/2);
					});
					ctx.restore();
				}
			}, [stage, selection, tool, splitCols, splitRows, scale, ruler, warp, warpSide, warpLocked, needsOverlay, renderW, renderH]);

			/** 适应窗口的比例：容器尺寸变了就重算（用户手动放大过就不动它）。 */
			useMeasureEffect(() => {
				if (!stage) return undefined;
				const measure = () => {
					const host = stageRef.current;
					if (!host) return;
					const rect = host.getBoundingClientRect();
					setView({
						fit: psFitZoom(stage.width, stage.height, rect.width - 24, rect.height - 24),
						rect: { x: rect.width, y: rect.height, w: rect.width, h: rect.height }
					});
				};
				measure();
				const observer = typeof ResizeObserver === "function" ? new ResizeObserver(measure) : null;
				observer?.observe(stageRef.current);
				return () => observer?.disconnect();
			}, [stage]);

			/** 滚轮缩放：以光标为锚点，缩放后把滚动位置补回光标底下那个点。 */
			useEffect(() => {
				const box = scrollRef.current;
				if (!box || !stage) return undefined;
				const onWheel = (event) => {
					event.preventDefault();
					const rect = box.getBoundingClientRect();
					const moved = psZoomAt(
						scaleRef.current,
						psWheelZoom(scaleRef.current, event.deltaY),
						{ x: event.clientX - rect.left, y: event.clientY - rect.top },
						{ left: box.scrollLeft, top: box.scrollTop }
					);
					pendingScroll.current = { scrollLeft: moved.scrollLeft, scrollTop: moved.scrollTop };
					setZoom({ mode: "free", scale: moved.scale });
				};
				// React 的 onWheel 在根节点上是 passive 的，preventDefault 不生效，所以自己挂
				box.addEventListener("wheel", onWheel, { passive: false });
				return () => box.removeEventListener("wheel", onWheel);
			}, [stage]);

			useMeasureEffect(() => {
				const box = scrollRef.current;
				if (!box || !pendingScroll.current) return;
				box.scrollLeft = pendingScroll.current.scrollLeft;
				box.scrollTop = pendingScroll.current.scrollTop;
				pendingScroll.current = null;
			}, [scale]);

			/** 工具栏的 − / + ：一档 25%，锚点取当前视口中心。 */
			const nudgeZoom = (direction) => {
				const box = scrollRef.current;
				const current = scaleRef.current;
				const next = psStepZoom(current, direction);
				const cursor = box ? { x: box.clientWidth / 2, y: box.clientHeight / 2 } : { x: 0, y: 0 };
				const scroll = box ? { left: box.scrollLeft, top: box.scrollTop } : { left: 0, top: 0 };
				const moved = psZoomAt(current, next, cursor, scroll);
				if (box) pendingScroll.current = { scrollLeft: moved.scrollLeft, scrollTop: moved.scrollTop };
				setZoom({ mode: "free", scale: moved.scale });
			};

			/* 中键拖动 = 平移（左键留给选区） */
			const onStagePointerDown = (event) => {
				if (event.button !== 1) return;
				const box = scrollRef.current;
				if (!box) return;
				event.preventDefault();
				panRef.current = { x: event.clientX, y: event.clientY, left: box.scrollLeft, top: box.scrollTop };
				box.setPointerCapture?.(event.pointerId);
			};
			const onStagePointerMove = (event) => {
				const box = scrollRef.current;
				if (!panRef.current || !box) return;
				box.scrollLeft = panRef.current.left - (event.clientX - panRef.current.x);
				box.scrollTop = panRef.current.top - (event.clientY - panRef.current.y);
			};
			const onStagePointerUp = () => {
				panRef.current = null;
			};

			const currentSnapshot = (canvas = source?.canvas) => psHistorySnapshot(
				{ name:source?.name, canvas }, layers, layerSession, history.currentLabel || source?.name, { activeLayerId, warpResultId }
			);
			const pushHistory = (canvas, label) => {
				const snapshot = currentSnapshot(source?.canvas ?? canvas);
				if (snapshot) setHistory(value => psHistoryPush(value, snapshot, label));
			};

			/**
			 * 提交一张新底图。geometry（可选）= 这一步做的几何：裁切 / 旋转 / 拉直 / 改画布 /
			 * 缩放 / 翻转。底图变了图层和蒙版也得跟着变，而变换前那套 layers 要先被历史拍下来，
			 * 撤销才回得去。单层编辑会话里不跟着变 —— 那时候画布上只有正在编辑的这一层。
			 *
			 * 「所有改动都默认新图层」：颜色 / 滤镜这类不改尺寸的调整不再直接改写底图，
			 * 而是把结果压成一层新的叠上去（旧层先隐藏：它们已经被烘焙进这一层，历史里可撤回）。
			 * 几何类（改尺寸）仍改写底图，否则图层坐标对不上。
			 */
			const syncCanvasDimensions = (w, h) => {
				setCanvasSize(value => ({ ...value, w:canvasUnit === "percent" ? 100 : w, h:canvasUnit === "percent" ? 100 : h }));
				setTarget(value => ({ ...value, w, h }));
			};
			const commit = (canvas, name, geometry, label) => {
				if (!canvas) return;
				invalidatePsReads();
				pushHistory(source?.canvas ?? canvas, label || (tool ? t(`ps.tool.${tool}`) : ""));
				const before = source?.canvas ?? null;
				const steps = (Array.isArray(geometry) ? geometry : geometry ? [geometry] : [])
					.filter((item) => item && psGeometryKind(item.kind))
					.map((item) => ({
						...item,
						kind: psGeometryKind(item.kind),
						width: before?.width ?? canvas.width,
						height: before?.height ?? canvas.height,
						w: canvas.width,
						h: canvas.height
					}));
				const isGeometryChange = steps.length > 0;
				if (!isGeometryChange && !layerSessionRef.current) {
					// 默认新图层：结果压成一层，旧层隐藏（已被烘焙进去），底图保持不动
					const layerName = label || name || (tool ? t(`ps.tool.${tool}`) : t("ps.layer.new"));
					const id = `layer_${Date.now().toString(36)}_${layers.length}`;
					setLayers((list) => [
						...list.map((item) => ({ ...item, visible: false })),
						{
							id, compositeResult:true,
							name: layerName,
							canvas,
							visible: true,
							mode: "normal",
							opacity: 1
						}
					]);
					setActiveLayerId(id);
					if (name !== null) setSelection(null);
					return;
				}
				if (steps.length && !layerSessionRef.current) {
					const nextLayers = psTransformLayers(layers, steps);
					if (nextLayers !== layers) setLayers(nextLayers);
				}
				const next = { name: name || source?.name || "image", canvas, width: canvas.width, height: canvas.height };
				setSource(next);
				syncCanvasDimensions(canvas.width, canvas.height);
				if (name !== null) setSelection(null);
			};

			// 工具草稿跟着画布；面板位置与快捷键是工作区偏好，不随图片更换。
			const resetPsToolDrafts = (w, h) => {
				setSelection(null); setTiles([]); setRuler(null); setDrag(null); setDragLayerId("");
				panRef.current = null; pendingScroll.current = null;
				setWarp(warpInitial("flat", w, h)); setWarpSide("src");
				setCurve(psCurvePreset("identity")); setAdjust(psAdjustDefaults());
				setAngle(0); setFeatherRadius(12); setFeatherTarget("all"); setSplitCols(2); setSplitRows(2); setFlipAxis("h");
				setCanvasUnit("px"); setCanvasSize({w,h,anchor:"c",fill:"transparent"}); setTarget({w,h,keep:true});
				setZoom({mode:"fit",scale:1});
			};
			const loadError = error => notify(String(error?.message ?? error), "err");
			const loadImage = input => reads.run(signal => psDecodeInput(input, signal), ({canvas,dpi}) => {
				layerSessionRef.current = null; setLayerSession(null); setLayers([]); setActiveLayerId(""); setWarpResultId("");
				setPickOpen(false); setLayerPick(false); setFileOver(false);
				setSource({name:input.name || "image",canvas,width:canvas.width,height:canvas.height}); setDpi(dpi);
				setHistory({past:[],future:[]}); resetPsToolDrafts(canvas.width,canvas.height); setTool("select");
			}, loadError, setReading);

			// 交接的是一次选择意图：先按身份消费，即便解码途中离开也不会回来时重复打开。
			const handoffRef = useRef(null);
			useMeasureEffect(() => {
				if (!initialUrl?.url && !initialUrl?.dataUrl) return;
				void loadImage(initialUrl);
				if (handoffRef.current !== initialUrl) { handoffRef.current = initialUrl; onConsumeInitialUrl?.(initialUrl); }
			}, [initialUrl]);

			/** 「加图层」属于选择时的合成文档，慢回包不得写到新文档或单层会话。 */
			const changeLayersLatest = useRef(changeLayers), readStage = useRef(stage);
			changeLayersLatest.current = changeLayers; readStage.current = stage;
			const addLayerFrom = input => {
				const base = stage;
				if (!base || layerSessionRef.current) return false;
				return reads.run(signal => psDecodeInput(input, signal, {width:base.width,height:base.height}), ({canvas}) => {
					if (readStage.current !== base || layerSessionRef.current) return false;
					const id = `layer_${Date.now().toString(36)}_${Math.random().toString(36).slice(2)}`;
					const layer = {id,name:input.name || t("ps.layer.new"),canvas,visible:true,mode:"normal",opacity:1};
					return changeLayersLatest.current(t("ps.layer.addLayer"), list => [...list,layer], id);
				}, loadError, setReading);
			};

			/** 单层是一段局部编辑时间线；外层快照/历史只保存引用，离开时恢复或合并成一步。 */
			const enterLayer = (layer) => {
				const session = psLayerSessionStart(layer, source, layerSessionRef.current);
				if (!session) return;
				invalidatePsReads();
				session.parent = {history, before:currentSnapshot(), initialCanvas:layer.canvas};
				layerSessionRef.current = session;
				setLayerSession(session);
				setActiveLayerId(layer.id);
				setWarpResultId("");
				setSource({name:layer.name, canvas:layer.canvas, width:layer.canvas.width, height:layer.canvas.height});
				resetPsToolDrafts(layer.canvas.width, layer.canvas.height);
				setHistory({past:[], currentLabel:layer.name, future:[]});
				notify(t("ps.layer.editing", { name: layer.name }));
			};

			const exitLayer = (commitChanges = true) => {
				const session = layerSessionRef.current;
				if (!session?.base?.canvas) return;
				invalidatePsReads();
				const parent = session.parent;
				const changed = commitChanges && stage && (!parent || stage !== parent.initialCanvas || layers.length !== parent.before.layers.length || layers.some((item,i) => item !== parent.before.layers[i]));
				const result = psLayerSessionExit(session, layers, changed ? stage : null);
				const clip=changed && psGripClipCache.get(stage);
				if(clip?.raw){
					const {width:w,height:h}=stage,r=clip.rect;
					const rect={x:r.x*w,y:r.y*h,w:r.w*w,h:r.h*h};
					result.layers=result.layers.map(l=>{
						if(l.id!==session.id)return l;
						const mask=psGripMask(psGripClip(l.mask?.canvas,rect,w,h,w,h));
						psGripClipCache.set(mask.canvas,{rect:r,previous:l.mask});
						return {...l,canvas:clip.raw,mask};
					});
				}
				const base=parent && !changed ? {...result.base,canvas:parent.before.canvas,width:parent.before.canvas.width,height:parent.before.canvas.height} : result.base;
				if (parent) {
					setHistory(changed ? psHistoryPush(parent.history, parent.before, t("ps.layer.committed",{name:session.name})) : parent.history);
					setLayers(changed ? result.layers : parent.before.layers);
				} else {
					// 显式透视提交打开结果会话，但沿用主时间线，退出也是可逆的一步。
					pushHistory(stage, t("ps.layer.back"));
					if (changed) setLayers(result.layers);
				}
				layerSessionRef.current = null;
				setLayerSession(null);
				setSource(base);
				setActiveLayerId(psLayerById(result.layers, session.id)?.id ?? "");
				setWarpResultId("");
				resetPsToolDrafts(base.canvas.width, base.canvas.height);
				if (changed) notify(t("ps.layer.committed",{name:session.name}));
			};
			/** 拖进来的图片文件 / 拖过来的图片链接，都走这一条。 */
			const dropImage = async (event) => {
				event.preventDefault();
				setFileOver(false);
				const files = Array.from(event.dataTransfer?.files ?? []);
				const file = files.find((item) => String(item?.type ?? "").startsWith("image/"));
				if (file) {
					await fromFile(file);
					return;
				}
				// 优先使用自己的拖拽载荷；桌面图片路径也经过同一地址边界，不接受 file:。
				const text = event.dataTransfer?.getData?.("text/uri-list") || event.dataTransfer?.getData?.("text/plain") || "";
				const item = readImageDrag(event.dataTransfer);
				const url = item?.url || String(text).split(/\r?\n/).map(s => s.trim()).find(s => /^(?:https?:\/\/|dsh-app:\/\/app\/|\/api\/velapi-image-go\/)/i.test(s));
				if (!url) { notify(t("ps.drop.none"), "err"); return; }
				await loadImage({name:item?.name || url.split("/").pop() || "image", url});
			};
			const fromFile = file => file ? loadImage({name:file.name,file}) : false;

			/** 导出已提交的画面，不读取工具草稿。单层会话保留裁出图层的实际宽高。 */
			const committedPixels = () => psExportComposite(stage, layers, Boolean(layerSession));
			const toDataUrl = () => {
				const out = committedPixels();
				if (!out) return "";
				return psApplyDpi(out.toDataURL("image/png"), dpi);
			};

			/** 快照 → 状态：底图、图层、单层会话一起还原（旧快照缺字段就沿用当前值，不清空图层）。 */
			const applySnapshot = (snapshot) => {
				const restored = psHistoryRestore(snapshot, { layers, layerSession, activeLayerId, warpResultId });
				if (!restored) return;
				setSource({ name: restored.name, canvas: restored.canvas, width: restored.width, height: restored.height });
				invalidatePsReads();
				setActiveLayerId(restored.activeLayerId);
				setWarpResultId(restored.warpResultId);
				setDrag(null);
				setRuler(null);
				setTiles([]);
				syncCanvasDimensions(restored.width, restored.height);
				setLayers(restored.layers);
				// 会话状态也一起回退：只回底图不回会话，画布上会挂着「已经退出的会话层」
				layerSessionRef.current = restored.layerSession;
				setLayerSession(restored.layerSession);
				setSelection(null);
			};
			const jumpHistory = (row) => {
				const move = psHistorySeek(history, currentSnapshot(), row?.kind, row?.index);
				if (!move) return;
				setHistory(move.history);
				applySnapshot(move.target);
			};
			const undo = () => jumpHistory({kind:"past", index:history.past.length-1});
			const redo = () => jumpHistory({kind:"future", index:0});

			/* ---- 画布上的指针交互：拖框 / 移动 / 手柄缩放 ---- */
			const pointToImage = (event) => {
				const canvas = viewRef.current;
				if (!canvas) return { x: 0, y: 0 };
				const rect = canvas.getBoundingClientRect();
				if (!(rect.width > 0) || !(rect.height > 0)) return { x: 0, y: 0 };
				/* 显示尺寸 → 图片像素：x/y 分别按 canvas 与显示框的比例换算（CSS 非等比拉伸也不会偏） */
				const sx = stage.width / Math.max(1, rect.width);
				const sy = stage.height / Math.max(1, rect.height);
				const x = (event.clientX - rect.left) * sx;
				const y = (event.clientY - rect.top) * sy;
				return { x, y };
			};

			const stopGrip = () => {gripRef.current=null;setGripDraft(null);};
			const startGrip = (event,key) => {
				if(event.button!==0 || !gripBox || gripRef.current) return;
				event.preventDefault();event.stopPropagation();event.currentTarget.focus({preventScroll:true});
				psCapturePointer(event.currentTarget,event.pointerId);
				const r=viewRef.current.getBoundingClientRect();
				gripRef.current={id:event.pointerId,key,cx:event.clientX,cy:event.clientY,sx:stageW/r.width,sy:stageH/r.height,from:gripBox};
			};
			const updateGripMask=(to)=>{
				const doc={x:0,y:0,w:stageW,h:stageH};
				if(!psGripWithinBudget(doc,2)){notify(t('ps.transform.limit'),'err');return;}
				const rect=to && {x:to.x/stageW,y:to.y/stageH,w:to.w/stageW,h:to.h/stageH};
				if(gripLayer){
					const previous=gripClip ? gripClip.previous : gripLayer.mask;
					const mask=to?psGripMask(psGripClip(previous?.canvas,to,stageW,stageH,stageW,stageH)):previous;
					if(to) psGripClipCache.set(mask.canvas,{rect,previous});
					changeLayers(t('ps.transform.mask'),list=>list.map(l=>l===gripLayer?{...l,mask}:l));
				}else{
					const raw=gripClip?.raw || stage;
					const canvas=to?psGripClip(raw,to,stageW,stageH,stageW,stageH):raw;
					if(to) psGripClipCache.set(canvas,{rect,raw});
					pushHistory(stage,t('ps.transform.mask'));setSource({...source,canvas});
				}
			};
			const trackGrip = (event,finish) => {
				const g=gripRef.current;if(!g || g.id!==event.pointerId) return;
				event.stopPropagation();const from=g.from,doc={x:0,y:0,w:stageW,h:stageH};
				let to=psGripBox(from,g.key,(event.clientX-g.cx)*g.sx,(event.clientY-g.cy)*g.sy,event.shiftKey);
				if(gripMode==='mask'){
					if(g.key==='move') to={...to,x:Math.max(0,Math.min(stageW-to.w,to.x)),y:Math.max(0,Math.min(stageH-to.h,to.y))};
					else {const x=Math.max(0,Math.min(stageW-1,to.x)),y=Math.max(0,Math.min(stageH-1,to.y));to={x,y,w:Math.max(1,Math.min(stageW,to.x+to.w)-x),h:Math.max(1,Math.min(stageH,to.y+to.h)-y)};}
				}
				const ext=gripMode==='mask'?doc:psGripExtent(to,stageW,stageH),expanded=ext.w!==stageW || ext.h!==stageH;
				const planes=expanded?layers.reduce((n,l)=>n+(l.mask?4:1)+(psGripClipCache.has(l.canvas)?1:0)+(l.mask?.canvas && psGripClipCache.has(l.mask.canvas)?3:0),3):gripLayer?.mask || layerSession?6:2;
				if(!psGripWithinBudget(ext,planes)){if(finish){stopGrip();notify(t('ps.transform.limit'),'err');}return;}
				if(!finish){setGripDraft({from,to,ext});return;}
				stopGrip();if(to.x===from.x && to.y===from.y && to.w===from.w && to.h===from.h) return;
				invalidatePsReads();if(gripMode==='mask'){updateGripMask(to);return;}
				// In a local editing session, the parent document may use a different pixel scale.
				// Pad it in its own coordinate system so returning to the stack never squashes the new layer.
				const parent=layerSession?.base?.canvas,parentDoc=parent?{x:0,y:0,w:parent.width,h:parent.height}:doc;
				const parentExt=layerSession && expanded?psGripExtent({x:ext.x*parentDoc.w/stageW,y:ext.y*parentDoc.h/stageH,w:ext.w*parentDoc.w/stageW,h:ext.h*parentDoc.h/stageH},parentDoc.w,parentDoc.h):ext;
				if(expanded && layerSession && !psGripWithinBudget(parentExt,planes)){notify(t('ps.transform.limit'),'err');return;}
				const bake=(b,target,d,e)=>{
					const a=target?from:d,z=target?to:d;
					const render=bitmap=>psGripBitmap(bitmap,a,z,d.w,d.h,e);
					const canvas=render(b),clip=psGripClipCache.get(b);
					if(clip){
						const kx=z.w/a.w,ky=z.h/a.h,r=clip.rect;
						const rect={x:(z.x+(r.x*d.w-a.x)*kx-e.x)/e.w,y:(z.y+(r.y*d.h-a.y)*ky-e.y)/e.h,w:r.w*d.w*kx/e.w,h:r.h*d.h*ky/e.h};
						psGripClipCache.set(canvas,clip.raw?{rect,raw:render(clip.raw)}:{rect,previous:clip.previous?.canvas?psGripMask(render(clip.previous.canvas)):null});
					}
					return canvas;
				};
				const paint=(b,target)=>bake(b,target,doc,ext);
				const pad=b=>bake(b,false,parentDoc,parentExt);
				const pixels=paint(gripBitmap,true);
				const nextStage=gripLayer?(expanded?pad(stage):stage):pixels;
				const nextLayers=layers.map(l=>{
					const target=l===gripLayer || layerSession?.id===l.id;
					if(!l.canvas || (!target&&!expanded)) return l;
					const c=target?pixels:pad(l.canvas);
					const mask=l.mask?.canvas?psGripMask(target?paint(l.mask.canvas,true):pad(l.mask.canvas)):l.mask;
					return {...l,canvas:c,width:c.width,height:c.height,mask,pixelRevision:(l.pixelRevision||0)+1};
				});
				let session=layerSession;
				if(layerSession && expanded){const canvas=pad(parent);session={...session,base:{...session.base,canvas,width:canvas.width,height:canvas.height}};}
				pushHistory(stage,t('ps.tool.transform'));setLayers(nextLayers);
				if(session!==layerSession){layerSessionRef.current=session;setLayerSession(session);}
				if(nextStage!==stage){setSource({...source,canvas:nextStage,width:nextStage.width,height:nextStage.height});syncCanvasDimensions(nextStage.width,nextStage.height);}
				setSelection(null);
			};
			const activateInk = point => {
				const b=!layerSession && activeLayer ? activeLayer.visible!==false && activeLayer.canvas : stage;
				if(!b) return false;
				const x=Math.floor(point.x*b.width/stageW),y=Math.floor(point.y*b.height/stageH);
				if(x<0 || y<0 || x>=b.width || y>=b.height || !b.getContext('2d').getImageData(x,y,1,1).data[3]) return false;
				setTool('transform');return true;
			};
			const onPointerDown = (event) => {
				if (!stage || event.button !== 0) return;
				if(tool==='warp' && warpLocked){activateInk(pointToImage(event));return;}
				if(tool==='transform') setTool('select');
				// 矫正 = PS 的标尺：按下去就开始拉线，不经过任何输入框 / 按钮
				if (tool === "straighten") {
					event.preventDefault();
					psCapturePointer(event.currentTarget, event.pointerId);
					const point = pointToImage(event);
					setRuler({ from: point, to: point, angle: 0 });
					setDrag({ mode: "ruler" });
					return;
				}
				if (tool !== "select" && tool !== "transform") {
					if (tool !== "warp" || warpLocked) return;
					const at = pointToImage(event);
					event.preventDefault();
					const point = { x: Math.max(0, Math.min(at.x, stageW)), y: Math.max(0, Math.min(at.y, stageH)) };
					if (warp.mode === "flat" && warpPick < 4) {
						setWarp((value) => value.src?.length >= 4 ? value : { ...value, src: [...(value.src || []), point] });
						return;
					}
					const which = warpSide === "dst" ? "dst" : "src";
					const quad = warp[which];
					const hit = psHitQuad(quad, at, Math.max(2, 12 / scale));
					if (hit) {
						psCapturePointer(event.currentTarget, event.pointerId);
						setDrag({ mode: "warp", which, index: hit.index, origin: quad });
					} else if (warp.mode === "flat" && quad?.length === 4) {
						const nearest = quad.reduce((i, p, j) => Math.hypot(p.x-at.x, p.y-at.y) < Math.hypot(quad[i].x-at.x, quad[i].y-at.y) ? j : i, 0);
						setWarp((value) => ({ ...value, src: value.src.map((p,i) => i === nearest ? point : p) }));
					}
					return;
				}
				event.preventDefault();
				psCapturePointer(event.currentTarget, event.pointerId);
				const point = pointToImage(event);
				// 手柄的判定半径按缩放折算：屏幕上永远是 ~10px，放大缩小时手感一致
				const hit = selection ? psHitHandle(selection, point, Math.max(6, 10 / scale)) : null;
				if (hit) {
					setDrag({ mode: "resize", handle: hit, start: point, origin: selection });
					return;
				}
				if (selection && point.x >= selection.x && point.x <= selection.x + selection.w && point.y >= selection.y && point.y <= selection.y + selection.h) {
					setDrag({ mode: "move", start: point, origin: selection });
					return;
				}
				setSelection(psClampRect({ x: point.x, y: point.y, w: 1, h: 1 }, stage.width, stage.height));
				setDrag({ mode: "new", start: point, clientX:event.clientX,clientY:event.clientY,origin: selection });
			};

			const onPointerMove = (event) => {
				if (!drag || !stage) return;
				const point = pointToImage(event);
				if (drag.mode === "ruler") {
					setRuler((value) => {
						const from = value?.from ?? point;
						return { from, to: point, angle: psRulerAngle(from, point) ?? 0 };
					});
					return;
				}
				if (drag.mode === "warp") {
					setWarp((value) => {
						const quad = drag.which === "src" ? value.src : value.dst;
						const moved = psMoveQuadPoint(quad, drag.index, point, stage.width, stage.height);
						return drag.which === "src" ? { ...value, src: moved } : { ...value, dst: moved };
					});
					return;
				}
				if (drag.mode === "new") setSelection(psRectFrom(drag.start, point, stage.width, stage.height));
				else if (drag.mode === "move") {
					const dx = point.x - drag.start.x;
					const dy = point.y - drag.start.y;
					setSelection(psClampRect({ ...drag.origin, x: drag.origin.x + dx, y: drag.origin.y + dy }, stage.width, stage.height));
				} else if (drag.mode === "resize") setSelection(psResizeRect(drag.origin ?? selection, drag.handle, point, stage.width, stage.height));
			};

			const onPointerUp = event => {
				if(drag?.mode==="new" && !drag.origin && Math.hypot(event.clientX-drag.clientX,event.clientY-drag.clientY)<3) activateInk(pointToImage(event));
				if (drag?.mode === "ruler") {
					setDrag(null);
					const angle = ruler ? psRulerAngle(ruler.from, ruler.to) : null;
					setRuler(null);
					// 松手即生效：和 PS 标尺一样，没有「应用」这一步
					if (angle === null) {
						notify(t("ps.straighten.tooShort"), "err");
						return;
					}
					if (Math.abs(angle) < 0.05) {
						notify(t("ps.straightAlready"));
						setAngle(0);
						return;
					}
					setAngle(angle);
					applyStraighten(angle);
					return;
				}
				if (drag?.mode === "warp") {
					setDrag(null);
					return;
				}
				if (drag?.mode === "resize" && selection) setSelection((value) => psClampRect(value, stage.width, stage.height));
				if (drag?.mode === "new" && selection && (selection.w < 4 || selection.h < 4)) setSelection(null);
				setDrag(null);
			};

			// 系统取消指针（窗口失焦/触控中断）不是松手确认，尤其不能提交标尺拉直。
			const cancelToolDrag = () => {
				if (drag?.mode === "ruler") setRuler(null);
				else if (drag?.mode === "warp") setWarp(value => ({ ...value, [drag.which]: drag.origin }));
				else if (drag) setSelection(drag.origin ?? null);
				setDrag(null);
			};

			/* ---- 各工具的执行 ---- */
			const needSelection = () => {
				if (selection) return true;
				notify(t("ps.needSelection"), "err");
				return false;
			};

			const applyCrop = () => {
				if (!stage || !needSelection()) return;
				commit(psCrop(stage, selection), null, { kind: "crop", rect: selection });
			};

			const applyRotate = (deg) => {
				if (!stage) return;
				commit(psRotate(stage, deg), null, { kind: "rotate", angle: deg });
			};

			const applyStraighten = (deg) => {
				if (!stage) return;
				commit(psStraighten(stage, deg), null, psStraightenGeometry(stage.width, stage.height, deg));
				notify(t("ps.straightened", { angle: String(deg) }));
			};

			const resetWarp = () => {
				if (!stage) return;
				setDrag(null);
				setWarpResultId("");
				setWarp(warpInitial(warp.mode, stageW, stageH));
			};
			// 按钮和 Enter 共用唯一提交点。打开独立图层会话，避免将局部结果拉伸成原图大小。
			const applyWarp = () => {
				if (!stage || !warpPlanNow || warpLocked) return;
				try {
					const plan = warpPlanNow;
					const pixels = committedPixels();
					const out = psWarpCanvas(pixels, plan.inverse, plan.size.w, plan.size.h);
					const id = `layer_${Date.now().toString(36)}_${layers.length}`;
					const result = { id, name: t("ps.warp.confirm"), canvas: out, compositeResult:true, visible: true, mode: "normal", opacity: 1 };
					const base = layerSession?.base || source;
					const previous = layerSession ? psLayerSessionExit(layerSession, layers, stage).layers : layers;
					const session = psLayerSessionStart(result, base, null);
					if (!session) return;
					invalidatePsReads();
					// 普通单层里再做显式透视，内层仍可撤销；回到合成时收束到原外层时间线。
					if (layerSession?.parent) session.parent = layerSession.parent;
					pushHistory(stage, result.name);
					setLayers([...previous.map((item) => ({ ...item, visible: false })), result]);
					layerSessionRef.current = session;
					setLayerSession(session);
					setActiveLayerId(id);
					setSource({ name: result.name, canvas: out, width: out.width, height: out.height });
					syncCanvasDimensions(out.width, out.height);
					setSelection(null);
					setWarpResultId(id);
					notify(t("ps.warp.done", { w: out.width, h: out.height }));
				} catch (error) { notify(String(error?.message ?? error), "err"); }
			};
			const flipWarpResult = (axis) => {
				if (!warpLocked || !stage) return;
				const out = psFlip(stage, axis);
				pushHistory(stage, t(axis === "h" ? "ps.warp.flipH" : "ps.warp.flipV"));
				setLayers(psLayerCommit(layers, warpResultId, out));
				setSource({ ...source, canvas: out });
			};

			const autoStraighten = () => {
				if (!stage) return;
				setBusy("矫正");
				try {
					const { luma, width, height } = psLumaFromCanvas(committedPixels());
					const best = psDeskewAngle(luma, width, height);
					if (Math.abs(best) < 0.3) {
						notify(t("ps.straightAlready"));
						return;
					}
					commit(psStraighten(stage, -best), null, psStraightenGeometry(stage.width, stage.height, -best));
					notify(t("ps.straightened", { angle: String(-best) }));
				} finally {
					setBusy("");
				}
			};

			const applyResize = () => {
				if (!stage) return;
				const w = Math.max(1, Math.min(8192, Math.round(target.w)));
				const h = Math.max(1, Math.min(8192, Math.round(target.h)));
				commit(psResize(stage, w, h), null, { kind: "resize", w, h });
			};

			/** 画布面板：像素 / 百分比两种口径，百分比是相对「当前画布」算的。 */
			const canvasPixels = () => {
				if (!stage) return { w: 1, h: 1 };
				if (canvasUnit === "percent") {
					const pw = Math.max(1, Number(canvasSize.w) || 100);
					const ph = Math.max(1, Number(canvasSize.h) || 100);
					return { w: Math.round((stage.width * pw) / 100), h: Math.round((stage.height * ph) / 100) };
				}
				return { w: Math.round(Number(canvasSize.w) || 1), h: Math.round(Number(canvasSize.h) || 1) };
			};

			const switchCanvasUnit = (unit) => {
				if (unit === canvasUnit) return;
				if (stage) {
					if (unit === "percent") {
						setCanvasSize((value) => ({ ...value, w: Math.round((value.w / stage.width) * 1000) / 10, h: Math.round((value.h / stage.height) * 1000) / 10 }));
					} else {
						setCanvasSize((value) => ({ ...value, w: Math.max(1, Math.round((value.w / 100) * stage.width)), h: Math.max(1, Math.round((value.h / 100) * stage.height)) }));
					}
				}
				setCanvasUnit(unit);
			};

			const applyCanvasSize = () => {
				if (!stage) return;
				const px = canvasPixels();
				const w = Math.max(1, Math.min(8192, px.w));
				const h = Math.max(1, Math.min(8192, px.h));
				commit(psCanvasSize(stage, w, h, canvasSize.anchor, canvasSize.fill === "transparent" ? "" : canvasSize.fill), null, { kind: "canvasSize", w, h, anchor: canvasSize.anchor });
				if (canvasUnit === "percent") setCanvasSize((value) => ({ ...value, w: 100, h: 100 }));
			};

			const applyFeather = () => {
				if (!stage) return;
				if (featherTarget === "selection" && !needSelection()) return;
				commit(psFeather(committedPixels(), featherTarget === "selection" ? selection : null, featherRadius), null);
			};

			const applyFlip = () => {
				if (!stage) return;
				commit(psFlip(stage, flipAxis), null, { kind: "flip", axis: flipAxis });
			};

			const runSplit = () => {
				if (!stage) return;
				const pixels = committedPixels();
				// 各块共享已提交的像素；列表只编码小预览，在下载或打开某块时才裁出原始尺寸。
				const list = psSplitTiles(pixels.width, pixels.height, splitCols, splitRows).map(tile => {
					const scale = Math.min(1, 160 / Math.max(tile.w, tile.h));
					const thumb = psCanvas(Math.max(1, Math.round(tile.w * scale)), Math.max(1, Math.round(tile.h * scale)));
					thumb.getContext("2d").drawImage(pixels, tile.x, tile.y, tile.w, tile.h, 0, 0, thumb.width, thumb.height);
					return { ...tile, pixels, url: thumb.toDataURL("image/png") };
				});
				setTiles(list);
				notify(t("ps.splitDone", { n: String(list.length) }));
			};

			const useTile = async (tile) => {
				if (await loadImage({name:`${source?.name || "image"}-${tile.index + 1}`, canvas:psSlice(tile.pixels, tile), dpi})) notify(t("ps.tileLoaded", {n:String(tile.index+1)}));
			};

			const download = (url, name) => {
				const link = document.createElement("a");
				link.href = url;
				link.download = `${(name || "image").replace(/\.[a-z0-9]+$/i, "")}-${dpi}dpi.png`;
				document.body.appendChild(link);
				link.click();
				link.remove();
			};

			const useAsReference = async () => {
				if (!stage) return;
				setBusy("上传");
				try {
					const dataUrl = toDataUrl();
					if (!await actions.attachReference({ name: `${source?.name || "image"}-处理.png`, dataUrl })) return;
					notify(t("ps.toReference"));
				} catch (error) {
					notify(String(error?.message ?? error), "err");
				} finally {
					setBusy("");
				}
			};

			const angleSlider = (value, setValue, onApply, label) =>
				h(
					"div",
					{ className: "vig-field" },
					h("span", { className: "vig-label" }, label),
					h("input", { className: "vig-range", type: "range", min: -15, max: 15, step: 0.5, value, onChange: (event) => setValue(Number(event.target.value)) }),
					h(
						"div",
						{ className: "vig-row" },
						h("span", { className: "vig-count", style: { marginLeft: 0 } }, `${value}°`),
						h("div", { className: "vig-spacer" }),
						h("button", { className: "vig-mini", onClick: () => setValue(0) }, t("ps.reset")),
						h("button", { className: "vig-btn is-primary", onClick: () => onApply(value) }, t("ps.apply"))
					)
				);

			/** 快捷键 Enter：按当前工具跑一次（焦点在按钮/输入框上时不拦，免得点两下）。 */
			const applyCurrent = () => {
				if (!stage) return;
				switch (tool) {
					case "select":
					case "crop":
						applyCrop();
						return;
					case "split":
						runSplit();
						return;
					case "rotate":
						applyRotate(angle);
						return;
					case "straighten":
						applyStraighten(angle);
						return;
					case "warp":
						applyWarp();
						return;
					case "canvasSize":
						applyCanvasSize();
						return;
					case "feather":
						applyFeather();
						return;
					case "resize":
						applyResize();
						return;
					case "flip":
						applyFlip();
						return;
					default:
						return;
				}
			};

			const focusMode = !panels.labels && !panels.params;
			/** 当前生效的整套键位（默认 + 用户改的），工具栏提示、快捷键表、分发都用它。 */
			const bindings = psBindingMap(overrides);
			const loadAsset = (name, url) => loadImage({name,url});
			const togglePanels = (next) => {
				setPanels((value) => {
					const merged = { ...value, ...next };
					window.localStorage.setItem("dsh.velapi-image-go.ps.tools", merged.labels ? "1" : "0");
					window.localStorage.setItem("dsh.velapi-image-go.ps.params", merged.params ? "1" : "0");
					return merged;
				});
			};

			/** 键盘：字母切工具、组合键做动作，键位可改。存成 ref，永远拿到最新闭包。 */
			const psOwnerRef = useRef(null);
			const keyRunnerRef = useRef(null);
			keyRunnerRef.current = (event) => {
				if(gripRef.current && event.key==='Escape'){event.preventDefault();stopGrip();return;}
				const owner = psOwnerRef.current;
				const target = event.target?.nodeType === 1 ? event.target : document.activeElement;
				if (!owner?.getClientRects().length || ((event.target !== window || target !== document.body) && target && !owner.contains(target)) || event.isComposing) return;
				// Esc 在录制中只取消录制；其它弹层只响应关闭，不操作底下的画布。
				if (!recording && psCombo(event) === "escape" && (keysOpen || pickOpen)) {
					setKeysOpen(false);
					setPickOpen(false);
					event.preventDefault();
					return;
				}
				if (recording) {
					// 录制中：拦下一切，Esc 取消，Backspace 恢复默认
					event.preventDefault();
					event.stopPropagation();
					const combo = psCombo(event);
					if (!combo) return;
					if (combo === "escape") {
						setRecording("");
						setKeyError("");
						return;
					}
					if (combo === "backspace") {
						setOverrides((value) => {
							const next = { ...value };
							delete next[recording];
							saveBindings(next);
							return next;
						});
						setRecording("");
						setKeyError("");
						return;
					}
					const taken = psConflict(overrides, combo, recording);
					if (taken) {
						setKeyError(t("ps.keys.taken", { keys: psComboLabel(combo), who: t(PS_ACTIONS.find((item) => item.id === taken)?.label || taken) }));
						return;
					}
					setOverrides((value) => {
						const next = { ...value, [recording]: combo };
						saveBindings(next);
						return next;
					});
					setRecording("");
					setKeyError("");
					return;
				}
				const hit = psShortcut(event, overrides);
				if (!hit) return;
				const el = event.target;
				if (keysOpen || pickOpen) return;
				const tag = String(el?.tagName || "").toLowerCase();
				const typing = tag === "input" || tag === "textarea" || tag === "select" || Boolean(el?.isContentEditable);
				// 输入框里打字不拦键；但 Esc / Enter 这类「退出、确认」语义的键仍旧生效
				if (typing && hit.action !== "clearSelection" && hit.action !== "apply") return;
				// Esc 先管「正在拖的标尺」：拖到一半反悔就撤掉，不动画面
				if (hit.action === "clearSelection" && drag?.mode === "warp") {
					// 拖角拖到一半反悔：把那个角放回拖之前的位置
					setWarp((value) => (drag.which === "src" ? { ...value, src: drag.origin } : { ...value, dst: drag.origin }));
					setDrag(null);
					event.preventDefault();
					return;
				}
				if (hit.action === "clearSelection" && ruler) {
					setRuler(null);
					setDrag(null);
					event.preventDefault();
					return;
				}
				if (hit.action === "clearSelection" && selection) {
					setSelection(null);
					event.preventDefault();
					return;
				}
				if (hit.action === "clearSelection") return;
				if (!hit.tool && !source) return;
				event.preventDefault();
				if (hit.tool) {
					setTool(hit.tool);
					return;
				}
				switch (hit.action) {
					case "undo":
						undo();
						return;
					case "redo":
						redo();
						return;
					case "fit":
						setZoom({ mode: "fit", scale: 1 });
						return;
					case "actual":
						setZoom({ mode: "actual", scale: 1 });
						return;
					case "zoomIn":
						nudgeZoom(1);
						return;
					case "zoomOut":
						nudgeZoom(-1);
						return;
					case "selectAll":
						setTool("select");
						setSelection({ x: 0, y: 0, w: stageW, h: stageH });
						return;
					case "reference":
						void useAsReference();
						return;
					case "download":
						download(toDataUrl(), source?.name);
						return;
					case "apply":
						if (["button", "input", "select", "textarea"].includes(tag)) return;
						applyCurrent();
						return;
					case "focus":
						togglePanels({ labels: focusMode, params: focusMode });
						return;
					case "help":
						setKeysOpen((value) => !value);
						return;
					default:
						return;
				}
			};
			useEffect(() => {
				const onKeyDown = (event) => keyRunnerRef.current?.(event);
				// 捕获阶段：录制新键位时要先于宿主的快捷键反应，stopPropagation 才拦得住
				window.addEventListener("keydown", onKeyDown, true);
				return () => window.removeEventListener("keydown", onKeyDown, true);
			}, []);

			const params = () => {
				if (!source) return null;
				switch (tool) {
					case "adjust": {
						/* 调整 / 曲线 / 色阶 / 滤镜：滑块只改参数，点动作行的按钮才写回像素（进撤销栈） */
						const runPixels = (mutate) => {
							if (!source?.canvas) return;
							// 加工私有画布，不原地改写历史或单层源图。
							const canvas = psLayerExport(stage, psCanvasLayers(layers, !!layerSession), stage.width, stage.height);
							const ctx = canvas.getContext("2d");
							const imageData = ctx.getImageData(0, 0, canvas.width, canvas.height);
							mutate(imageData, canvas);
							ctx.putImageData(imageData, 0, 0);
							commit(canvas, source.name, null, t("ps.tool.adjust"));
							notify(t("ps.adjust.done"));
						};
						const applyAdjust = () =>
							runPixels((imageData) =>
								psAdjustPixels(psVibrancePixels(imageData.data, adjust.vibrance), {
									brightness: adjust.brightness,
									contrast: adjust.contrast,
									saturation: adjust.saturation,
									hue: adjust.hue,
									grayscale: adjust.grayscale,
									invert: adjust.invert
								})
							);
						/* 参数控件统一长相：标签左侧、当前值右侧（同一行），控件铺满格子 */
						const slider = (key, labelKey, min, max, suffix = "") =>
							h(
								"div",
								{ className: "vig-ps-control" },
								h(
									"div",
									{ className: "vig-ps-control-head" },
									h("span", null, t(labelKey)),
									h("span", { className: "vig-ps-control-value" }, `${adjust[key]}${suffix}`)
								),
								h("input", {
									className: "vig-range",
									type: "range",
									min,
									max,
									step: 1,
									value: adjust[key],
									onChange: (event) => setAdjust((value) => ({ ...value, [key]: Number(event.target.value) }))
								})
							);
						const numberField = (key, labelKey, min, max) =>
							h(
								"label",
								{ className: "vig-ps-control" },
								h("div", { className: "vig-ps-control-head" }, h("span", null, t(labelKey))),
								h("input", {
									className: "vig-in",
									type: "number",
									min,
									max,
									step: 0.1,
									value: adjust[key],
									onChange: (event) => setAdjust((value) => ({ ...value, [key]: Number(event.target.value) }))
								})
							);
						return h(
							"div",
							{ className: "vig-ps-form" },
							/* ---- 调整 ---- */
							h("div", { className: "vig-ps-section" }, t("ps.adjust.tone")),
							h(
								"div",
								{ className: "vig-ps-form-grid" },
								slider("brightness", "ps.adjust.brightness", -100, 100),
								slider("contrast", "ps.adjust.contrast", -100, 100),
								slider("saturation", "ps.adjust.saturation", -100, 100),
								slider("vibrance", "ps.adjust.vibrance", -100, 100)
							),
							slider("hue", "ps.adjust.hue", -180, 180, "°"),
							h(
								"div",
								{ className: "vig-ps-row" },
								h(
									"button",
									{
										className: `vig-btn is-sm${adjust.grayscale ? " is-primary" : ""}`,
										onClick: () => setAdjust((value) => ({ ...value, grayscale: !value.grayscale }))
									},
									t("ps.adjust.grayscale")
								),
								h(
									"button",
									{
										className: `vig-btn is-sm${adjust.invert ? " is-primary" : ""}`,
										onClick: () => setAdjust((value) => ({ ...value, invert: !value.invert }))
									},
									t("ps.adjust.invert")
								)
							),
							h(
								"div",
								{ className: "vig-ps-actions" },
								h(
									"button",
									{
										className: "vig-btn is-sm is-ghost",
										onClick: () => setAdjust(psAdjustDefaults())
									},
									t("ps.adjust.reset")
								),
								h("div", { className: "vig-spacer" }),
								h("button", { className: "vig-btn is-sm is-primary", onClick: applyAdjust }, t("ps.adjust.apply"))
							),
							/* ---- 曲线 ---- */
							h("div", { className: "vig-ps-section" }, t("ps.adjust.curves")),
							h(
								"div",
								{ className: "vig-ps-presets" },
								[
									["brighten", "ps.adjust.curveBrighten"],
									["darken", "ps.adjust.curveDarken"],
									["contrast", "ps.adjust.curveContrast"],
									["invert", "ps.adjust.curveInvert"]
								].map(([id, labelKey]) =>
									h(
										"button",
										{
											key: id,
											className: "vig-btn is-sm",
											onClick: () => setCurve(psCurveNormalize(psCurvePreset(id)))
										},
										t(labelKey)
									)
								)
							),
							h(CurveEditor, {
								points: curve,
								onChange: setCurve,
								disabled: !source,
								onApply: () => runPixels((imageData) => psApplyLutPixels(imageData.data, psCurveLut(curve)))
							}),
							/* ---- 色阶 ---- */
							h("div", { className: "vig-ps-section" }, t("ps.adjust.levels")),
							h(
								"div",
								{ className: "vig-ps-form-grid is-three" },
								numberField("inBlack", "ps.adjust.inBlack", 0, 254),
								numberField("inWhite", "ps.adjust.inWhite", 1, 255),
								numberField("gamma", "ps.adjust.gamma", 0.1, 4)
							),
							h(
								"div",
								{ className: "vig-ps-actions" },
								h("div", { className: "vig-spacer" }),
								h(
									"button",
									{
										className: "vig-btn is-sm is-primary",
										onClick: () =>
											runPixels((imageData) =>
												psApplyLutPixels(imageData.data, psLevelsLut({ inBlack: adjust.inBlack, inWhite: adjust.inWhite, gamma: adjust.gamma }))
											)
									},
									t("ps.adjust.applyLevels")
								)
							),
							/* ---- 滤镜 ---- */
							h("div", { className: "vig-ps-section" }, t("ps.adjust.filters")),
							slider("blur", "ps.adjust.blur", 0, 24, "px"),
							slider("sharpen", "ps.adjust.sharpen", 0, 200),
							slider("noise", "ps.adjust.noise", 0, 100),
							h(
								"div",
								{ className: "vig-ps-actions" },
								h("div", { className: "vig-spacer" }),
								h(
									"button",
									{
										className: "vig-btn is-sm is-primary",
										onClick: () =>
											runPixels((imageData, canvas) => {
												psBoxBlurPixels(imageData.data, canvas.width, canvas.height, adjust.blur);
												psSharpenPixels(imageData.data, canvas.width, canvas.height, adjust.sharpen);
												psNoisePixels(imageData.data, adjust.noise, 7);
											})
									},
									t("ps.adjust.applyFilters")
								)
							)
						);
					}
					case "transform": return h('div',{className:'vig-ps-form-grid'},
						h('div',{className:'vig-ps-seg'},['pixels','mask'].map(mode=>h('button',{key:mode,type:'button','data-ps-grip-mode':mode,className:`vig-ps-seg-btn${gripMode===mode?' is-on':''}`,'aria-pressed':gripMode===mode,onClick:()=>{stopGrip();setGripMode(mode);}},t('ps.transform.'+mode)))),
						h('p',{className:'vig-muted'},t(gripMode==='mask'?'ps.transform.maskHint':'ps.transform.hint')),
						gripMode==='mask' && h('button',{type:'button',className:'vig-btn is-sm','data-ps-mask-reset':'1',disabled:!gripClip,onClick:()=>updateGripMask(null)},t('ps.transform.resetMask')));
					case "select":
						return h(
							"div",
							null,
							h("p", { className: "vig-muted", style: { fontSize: 12, marginTop: 0 } }, t("ps.select.hint")),
							h(
								"div",
								{ className: "vig-ps-readout" },
								selection
									? `${Math.round(selection.x)}, ${Math.round(selection.y)} · ${selection.w} × ${selection.h}`
									: t("ps.none")
							),
							h(
								"div",
								{ className: "vig-row" },
								h("button", { className: "vig-btn", onClick: () => setSelection({ x: 0, y: 0, w: source.width, h: source.height }) }, t("ps.select.all")),
								h("button", { className: "vig-btn", onClick: () => setSelection(null) }, t("ps.select.none")),
								h("div", { className: "vig-spacer" }),
								h("button", { className: "vig-btn is-primary", onClick: applyCrop }, t("ps.tool.crop"))
							)
						);
					case "crop":
						return h(
							"div",
							null,
							h("p", { className: "vig-muted", style: { fontSize: 12, marginTop: 0 } }, t("ps.crop.hint")),
							h(
								"div",
								{ className: "vig-row" },
								h("button", { className: "vig-btn", onClick: () => setTool("select") }, t("ps.toSelect")),
								h("div", { className: "vig-spacer" }),
								h("button", { className: "vig-btn is-primary", onClick: applyCrop }, t("ps.apply"))
							)
						);
					case "split":
						return h(
							"div",
							null,
							h(
								"div",
								{ className: "vig-form-grid" },
								h("label", { className: "vig-field" }, h("span", { className: "vig-label" }, t("ps.split.cols")), h("input", { className: "vig-in", type: "number", min: 1, max: 8, value: splitCols, onChange: (event) => setSplitCols(Number(event.target.value) || 1) })),
								h("label", { className: "vig-field" }, h("span", { className: "vig-label" }, t("ps.split.rows")), h("input", { className: "vig-in", type: "number", min: 1, max: 8, value: splitRows, onChange: (event) => setSplitRows(Number(event.target.value) || 1) }))
							),
							h("button", { className: "vig-btn is-primary", onClick: runSplit }, t("ps.split.run")),
							tiles.length > 0
								? h(
										"div",
										{ className: "vig-ps-tiles" },
										tiles.map((tile) =>
											h(
												"div",
												{ className: "vig-ps-tile", key: tile.index },
												h("img", { src: tile.url, alt: `#${tile.index + 1}` }),
												h("div", { className: "vig-ps-tile-meta" }, `#${tile.index + 1} · ${tile.w}×${tile.h}`),
												h(
													"div",
													{ className: "vig-row" },
													h("button", { className: "vig-mini", onClick: () => void useTile(tile) }, t("ps.tileUse")),
													h("button", { className: "vig-mini", onClick: () => download(psApplyDpi(psSlice(tile.pixels, tile).toDataURL("image/png"), dpi), `${source?.name || "image"}-${tile.index + 1}`) }, t("ps.download"))
												)
											)
										)
									)
								: null
						);
					case "rotate":
						return h(
							"div",
							null,
							h(
								"div",
								{ className: "vig-ps-btns" },
								h("button", { className: "vig-btn", onClick: () => applyRotate(-90) }, t("ps.rotate.ccw")),
								h("button", { className: "vig-btn", onClick: () => applyRotate(90) }, t("ps.rotate.cw")),
								h("button", { className: "vig-btn", onClick: () => applyRotate(180) }, t("ps.rotate.180"))
							),
							angleSlider(angle, setAngle, applyRotate, t("ps.rotate.free"))
						);
					case "straighten":
						/* 照 PS 的标尺来：没有滑块、没有「应用」——在图上拖一条线，拖的过程就转，松手即生效 */
						return h(
							"div",
							null,
							h("p", { className: "vig-muted", style: { fontSize: 12, marginTop: 0 } }, t("ps.straighten.hint")),
							h(
								"div",
								{ className: `vig-ps-ruler${ruler ? " is-live" : ""}` },
								h(Icon, { name: "level", size: 14 }),
								h("span", { className: "vig-ps-ruler-read" }, ruler ? t("ps.straighten.live", { angle: String(ruler.angle) }) : angle ? t("ps.straighten.last", { angle: String(angle) }) : t("ps.straighten.drag"))
							),
							h("button", { className: "vig-btn is-primary", onClick: autoStraighten }, busy === "矫正" ? t("ps.straighten.autoBusy") : t("ps.straighten.auto")),
							h("p", { className: "vig-muted", style: { fontSize: 11.5, margin: 0 } }, t("ps.straighten.dragHint"))
						);
					case "warp": {
						const size = warpPlanNow?.size;
						const canSrc = warp.mode !== "distort";
						const canDst = warp.mode !== "flat";
						return h(
							"div",
							null,
							/* 顶点矫正流程：点选四角 → 确认矫正（锁定）→ 规范矩形 */
							(() => {
								const ready = Boolean(warpPlanNow) && !warpLocked;
								return h(
									"div",
									{ className: "vig-ps-row", style: { display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" } },
									h(
										"button",
										{
											className: "vig-btn",
											"data-warp-pick": "1",
											disabled: !stage || warp.mode !== "flat",
											onClick: () => {
												resetWarp();
												notify(t("ps.warp.pickHint"));
											}
										},
										t("ps.warp.pick")
									),
									h(
										"button",
										{
											className: "vig-btn is-primary",
											"data-warp-confirm": "1",
											disabled: !ready,
											onClick: applyWarp
										},
										t("ps.warp.confirm")
									),
									h(
										"button",
										{
											className: "vig-btn",
											"data-warp-fliph": "1",
											disabled: !warpLocked,
											onClick: () => flipWarpResult("h")
										},
										t("ps.warp.flipH")
									),
									h(
										"button",
										{
											className: "vig-btn",
											"data-warp-flipv": "1",
											disabled: !warpLocked,
											onClick: () => flipWarpResult("v")
										},
										t("ps.warp.flipV")
									),
									warpLocked
										? h("span", { className: "vig-muted", "data-warp-locked": "1" }, t("ps.warp.locked"))
										: warpPick > 0
											? h("span", { className: "vig-muted" }, t("ps.warp.pickCount", { n: Math.min(4, warpPick) }))
											: null
								);
							})(),
							h("p", { className: "vig-muted", style: { fontSize: 12, marginTop: 0 } }, t(`ps.warp.hint.${warp.mode}`)),
							h("span", { className: "vig-label" }, t("ps.warp.mode")),
							h(
								"div",
								{ className: "vig-ps-seg is-3" },
								["flat", "free", "distort"].map((id) =>
									h(
										"button",
										{
											key: id,
											className: `vig-ps-seg-btn${warp.mode === id ? " is-on" : ""}`,
											onClick: () => { setWarpResultId(""); setWarp((value) => ({ ...value, mode: id })); }
										},
										t(`ps.warp.mode.${id}`)
									)
								)
							),
							h("span", { className: "vig-label" }, t("ps.warp.view")),
							h(
								"div",
								{ className: "vig-ps-seg" },
								[
									{ id: "src", ok: canSrc },
									{ id: "dst", ok: canDst }
								]
									.filter((item) => item.ok)
									.map((item) =>
										h(
											"button",
											{
												key: item.id,
												className: `vig-ps-seg-btn${warpSide === item.id ? " is-on" : ""}`,
												onClick: () => setWarpSide(item.id)
											},
											t(`ps.warp.side.${item.id}`)
										)
									)
							),
							h("div", { className: "vig-ps-readout" }, size ? t("ps.warp.out", { w: String(size.w), h: String(size.h) }) : warpLocked ? t("ps.warp.locked") : warpPick === 4 && warp.src?.length ? t("ps.warp.degenerate") : t("ps.warp.pickCount", { n: warpPick })),
							h(
								"div",
								{ className: "vig-row" },
								h("button", { className: "vig-btn", onClick: resetWarp }, t("ps.warp.reset")),
								h("div", { className: "vig-spacer" }),
								h("span", { className: "vig-muted", style: { fontSize: 11.5 } }, t("ps.warp.liveTag"))
							),
							h("p", { className: "vig-muted", style: { fontSize: 11.5, margin: 0 } }, t("ps.warp.tip"))
						);
					}
					case "canvasSize":
						return h(
							"div",
							null,
							h("p", { className: "vig-muted", style: { fontSize: 12, marginTop: 0 } }, t("ps.canvas.current", { w: String(stageW), h: String(stageH), dpi: String(dpi) })),
							h(
								"label",
								{ className: "vig-field" },
								h("span", { className: "vig-label" }, t("ps.canvas.unit")),
								h(
									"div",
									{ className: "vig-ps-seg" },
									["px", "percent"].map((unit) =>
										h("button", { key: unit, className: `vig-ps-seg-btn${canvasUnit === unit ? " is-on" : ""}`, onClick: () => switchCanvasUnit(unit) }, t(`ps.canvas.unit.${unit}`))
									)
								)
							),
							h(
								"div",
								{ className: "vig-form-grid" },
								h("label", { className: "vig-field" }, h("span", { className: "vig-label" }, t("ps.width")), h("input", { className: "vig-in", type: "number", min: 1, value: canvasSize.w, onChange: (event) => setCanvasSize({ ...canvasSize, w: Number(event.target.value) }) })),
								h("label", { className: "vig-field" }, h("span", { className: "vig-label" }, t("ps.height")), h("input", { className: "vig-in", type: "number", min: 1, value: canvasSize.h, onChange: (event) => setCanvasSize({ ...canvasSize, h: Number(event.target.value) }) }))
							),
							h("span", { className: "vig-label" }, t("ps.canvas.preset")),
							h(
								"div",
								{ className: "vig-ps-btns is-ratio" },
								[["1:1", 1], ["4:3", 4 / 3], ["3:4", 3 / 4], ["16:9", 16 / 9], ["9:16", 9 / 16]].map(([label, ratio]) =>
									h("button", { key: label, className: "vig-btn", onClick: () => {
										const { w, h } = psRatioSize(stageW, stageH, ratio);
										setCanvasSize(value => ({ ...value, w:canvasUnit === "percent" ? 100*w/stageW : w, h:canvasUnit === "percent" ? 100*h/stageH : h }));
									} }, label)
								)
							),
							h("span", { className: "vig-label" }, t("ps.canvas.dpi")),
							h(
								"div",
								{ className: "vig-ps-dpi" },
								h("input", {
									className: "vig-in",
									type: "number",
									min: 1,
									max: 1200,
									value: dpi,
									onChange: (event) => setDpi(Math.max(1, Math.min(1200, Math.round(Number(event.target.value) || 72))))
								}),
								[72, 96, 150, 300].map((preset) =>
									h("button", { key: preset, className: `vig-ps-dpi-btn${dpi === preset ? " is-on" : ""}`, onClick: () => setDpi(preset) }, String(preset))
								)
							),
							h("p", { className: "vig-muted", style: { fontSize: 11, margin: "0 0 2px" } }, t("ps.canvas.dpi.hint")),
							h("span", { className: "vig-label" }, t("ps.anchor")),
							h(
								"div",
								{ className: "vig-ps-anchor" },
								["nw", "n", "ne", "w", "c", "e", "sw", "s", "se"].map((anchor) =>
									h(
										"button",
										{
											key: anchor,
											className: `vig-ps-anchor-btn${canvasSize.anchor === anchor ? " is-on" : ""}`,
											onClick: () => setCanvasSize({ ...canvasSize, anchor }),
											title: anchor
										},
										h("i", null)
									)
								)
							),
							h(
								"label",
								{ className: "vig-field" },
								h("span", { className: "vig-label" }, t("ps.fill")),
								h(
									"select",
									{ className: "vig-sel", value: canvasSize.fill, onChange: (event) => setCanvasSize({ ...canvasSize, fill: event.target.value }) },
									h("option", { value: "transparent" }, t("ps.fill.none")),
									h("option", { value: "#ffffff" }, t("ps.fill.white")),
									h("option", { value: "#f4f5f8" }, t("ps.fill.grey"))
								)
							),
							h("button", { className: "vig-btn is-primary", onClick: applyCanvasSize }, t("ps.apply"))
						);
					case "feather":
						return h(
							"div",
							null,
							h(
								"label",
								{ className: "vig-field" },
								h("span", { className: "vig-label" }, t("ps.feather.radius")),
								h("input", {
									className: "vig-range",
									type: "range",
									min: 0,
									max: 80,
									step: 1,
									value: featherRadius,
									onChange: (event) => setFeatherRadius(Number(event.target.value))
								}),
								h("span", { className: "vig-count", style: { marginLeft: 0 } }, `${featherRadius}px`)
							),
							h(
								"div",
								{ className: "vig-ps-btns" },
								h("button", { className: `vig-btn${featherTarget === "all" ? " is-primary" : ""}`, onClick: () => setFeatherTarget("all") }, t("ps.feather.all")),
								h("button", { className: `vig-btn${featherTarget === "selection" ? " is-primary" : ""}`, onClick: () => setFeatherTarget("selection") }, t("ps.feather.selection"))
							),
							h("button", { className: "vig-btn is-primary", onClick: applyFeather }, t("ps.apply"))
						);
					case "resize":
						return h(
							"div",
							null,
							h(
								"div",
								{ className: "vig-form-grid" },
								h("label", { className: "vig-field" }, h("span", { className: "vig-label" }, t("ps.width")), h("input", { className: "vig-in", type: "number", value: target.w, onChange: (event) => {
									const w = Number(event.target.value) || 1;
									setTarget(target.keep ? { ...target, w, h: Math.max(1, Math.round((w * source.height) / source.width)) } : { ...target, w });
								} })),
								h("label", { className: "vig-field" }, h("span", { className: "vig-label" }, t("ps.height")), h("input", { className: "vig-in", type: "number", value: target.h, onChange: (event) => {
									const h2 = Number(event.target.value) || 1;
									setTarget(target.keep ? { ...target, h: h2, w: Math.max(1, Math.round((h2 * source.width) / source.height)) } : { ...target, h: h2 });
								} }))
							),
							h(
								"label",
								{ className: "vig-row", style: { fontSize: 12 } },
								h("input", { type: "checkbox", checked: target.keep, onChange: (event) => setTarget({ ...target, keep: event.target.checked }) }),
								t("ps.resize.keep")
							),
							h("button", { className: "vig-btn is-primary", onClick: applyResize }, t("ps.apply"))
						);
					case "flip":
						return h(
							"div",
							null,
							h(
								"div",
								{ className: "vig-ps-btns" },
								h("button", { className: `vig-btn${flipAxis === "h" ? " is-primary" : ""}`, onClick: () => setFlipAxis("h") }, t("ps.flip.h")),
								h("button", { className: `vig-btn${flipAxis === "v" ? " is-primary" : ""}`, onClick: () => setFlipAxis("v") }, t("ps.flip.v"))
							),
							h("button", { className: "vig-btn is-primary", onClick: applyFlip }, t("ps.apply"))
						);
					default:
						return null;
				}
			};

			return h(
				"div",
				{ className: "vig-main", ref: psOwnerRef, tabIndex: -1, onPointerDownCapture: (event) => {
					if (!event.target.closest?.("button,input,select,textarea,a,dialog,[contenteditable=true]")) event.currentTarget.focus({preventScroll:true});
				} },
				h(
					"div",
					{ className: "vig-toolbar" },
					h(Icon, { name: "crop" }),
					h("span", { className: "vig-item-title" }, t("nav.ps")),
					reading && h("span", {role:"status",className:"vig-muted"}, t("grid.busy.load")),
					h("span", { className: "vig-muted", style: { fontSize: 12 } }, source ? `${source.name} · ${shownW}×${shownH} · ${dpi} DPI` : t("ps.noSource")),
					h("div", { className: "vig-spacer" }),
					h("button", {
						className: "vig-icon-btn",
						title: `${t("ps.focus")} (\\)`,
						"aria-pressed": focusMode,
						onClick: () => togglePanels({ labels: focusMode, params: focusMode })
					}, h(Icon, { name: "expand" })),
					h("button", { className: "vig-icon-btn", title: `${t("ps.keys")} (?)`, onClick: () => setKeysOpen(true) }, h("span", { className: "vig-kbd-dot" }, "?")),
					h("button", { className: "vig-icon-btn", title: t("ps.undo"), disabled: history.past.length === 0, onClick: undo }, h(Icon, { name: "undo" })),
					h("button", { className: "vig-icon-btn", title: t("ps.redo"), disabled: history.future.length === 0, onClick: redo }, h(Icon, { name: "redo" })),
					h("button", { className: "vig-btn", disabled: !source, onClick: () => download(toDataUrl(), source?.name) }, t("ps.download")),
					h("button", { className: "vig-btn is-primary", disabled: !source, onClick: () => void useAsReference() }, busy === "上传" ? t("ps.toReferenceBusy") : t("ps.toReference"))
				),
				h(
					"div",
					{ className: "vig-main-body vig-ps-host", style: { padding: 0 } },
					h(
						"div",
						{
							className: "vig-ps",
							"data-layers": layersAside ? "1" : "0",
							"data-labels": panels.labels ? "1" : "0",
							"data-params": panels.params ? "1" : "0",
							"data-drop": fileOver ? "1" : "0",
							// 整块工具箱都接拖入：拖一张图进来直接载入（文件或网页图片链接都认）
							onDragOver: (event) => {
								event.preventDefault();
								if (event.dataTransfer) event.dataTransfer.dropEffect = "copy";
								if (!fileOver) setFileOver(true);
							},
							onDragLeave: (event) => {
								if (event.currentTarget && event.currentTarget.contains?.(event.relatedTarget)) return;
								setFileOver(false);
							},
							onDrop: (event) => void dropImage(event)
						},
						// 拖入时的提示条（指针事件透传，不挡拖放本身）
						h(
							"div",
							{ className: "vig-ps-drop" },
							h("div", { className: "vig-ps-drop-card" }, h(Icon, { name: "image", size: 16 }), t("ps.drop.hint"))
						),
						h(
							"div",
							{ className: "vig-ps-tools" },
							h(
								"button",
								{
									className: "vig-ps-tools-toggle",
									title: panels.labels ? `${t("ps.collapse")} (${t("ps.panels.tools")})` : `${t("ps.expand")} (${t("ps.panels.tools")})`,
									"aria-label": panels.labels ? t("ps.collapse") : t("ps.expand"),
									"aria-pressed": panels.labels,
									onClick: () => togglePanels({ labels: !panels.labels })
								},
								h(Icon, { name: panels.labels ? "chevron" : "chevronDown", size: 14 })
							),
							PS_TOOLS.map((item) =>
								h(
									"button",
									{
										key: item.id,
										"data-ps-tool":item.id,
										className: `vig-ps-tool${tool === item.id ? " is-on" : ""}`,
										onClick: () => setTool(item.id),
										title: `${t(`ps.tool.${item.id}`)}${psComboLabel(bindings[`tool.${item.id}`]) ? ` · ${psComboLabel(bindings[`tool.${item.id}`])}` : ""}`,
										"aria-label": t(`ps.tool.${item.id}`)
									},
									h(Icon, { name: item.icon, size: 17 }),
									h("span", null, t(`ps.tool.${item.id}`))
								)
							)
						),
						h(
							"div",
							{ className: "vig-ps-stage", ref: stageRef },
							source
								? h(
										"div",
										{
											className: "vig-ps-scroll",
											ref: scrollRef,
											onPointerDown: onStagePointerDown,
											onPointerMove: onStagePointerMove,
											onPointerUp: onStagePointerUp,
											onPointerCancel: onStagePointerUp,
											onAuxClick: (event) => event.preventDefault()
										},
										source.preview
											? /* 静态预览用（tools/preview.mjs 喂 initial.preview）：真跑起来是下面那两块 canvas，
											     这里只是把同一套选框画成 DOM，免得预览里看到一片空白画布。 */
												h(
													"div",
													{ className: "vig-ps-shot", style: { width: canvasW, height: canvasH } },
													h("img", {
														src: source.preview,
														alt: source.name,
														style: ruler ? { transform: `rotate(${ruler.angle}deg)` } : undefined
													}),
													ruler
														? [
																h("span", {
																	className: "vig-ps-ruler-line",
																	key: "ruler-line",
																	style: (() => {
																		const dx = (ruler.to.x - ruler.from.x) * scale;
																		const dy = (ruler.to.y - ruler.from.y) * scale;
																		return {
																			left: ruler.from.x * scale,
																			top: ruler.from.y * scale,
																			width: Math.hypot(dx, dy),
																			transform: `rotate(${(Math.atan2(dy, dx) * 180) / Math.PI}deg)`
																		};
																	})()
																}),
																h("span", {
																	className: "vig-ps-ruler-angle",
																	key: "ruler-angle",
																	style: { left: ruler.to.x * scale + 10, top: ruler.to.y * scale + 10 }
																}, `${ruler.angle}°`)
															]
														: null,
													selection
														? h(
																"div",
																{
																	className: "vig-ps-marquee",
																	style: {
																		left: selection.x * scale,
																		top: selection.y * scale,
																		width: selection.w * scale,
																		height: selection.h * scale
																	}
																},
																psHandles(selection).map((handle) =>
																	h("i", {
																		key: handle.id,
																		style: { left: (handle.x - selection.x) * scale, top: (handle.y - selection.y) * scale }
																	})
																)
															)
														: null,
													/* 四点矫正的静态版：几何和真画布那层完全一样，只是画成 SVG */
													warp.src || warp.dst
														? h(
																"svg",
																{
																	className: "vig-ps-warp-shot",
																	viewBox: `0 0 ${stageW} ${stageH}`,
																	width: canvasW,
																	height: canvasH
																},
																[
																	{ which: "src", stroke: "#0b0b0c", fill: "rgba(11,11,12,.12)", dash: "6 4", show: true },
																	{ which: "dst", stroke: "#f08a24", fill: "rgba(240,138,36,.14)", dash: "", show: warp.mode !== "flat" }
																]
																	.filter((item) => item.show)
																	.map((item) => {
																		const quad = warp[item.which];
																		if (!quad) return null;
																		const faint = item.which === "src" && warp.mode === "distort";
																		return h(
																			"g",
																			{ key: item.which, opacity: faint ? 0.55 : 1 },
																			h("polygon", {
																				points: quad.map((point) => `${point.x},${point.y}`).join(" "),
																				fill: item.fill,
																				stroke: item.stroke,
																				strokeWidth: 2,
																				strokeDasharray: item.dash || undefined
																			}),
																			quad.map((point, index) =>
																				h(
																					"g",
																					{ key: index },
																					h("rect", {
																						x: point.x - 5,
																						y: point.y - 5,
																						width: 10,
																						height: 10,
																						fill: "#fff",
																						stroke: item.stroke,
																						strokeWidth: 2
																					}),
																					h("text", { x: point.x + 9, y: point.y - 6, fill: item.stroke }, String(index + 1))
																				)
																			)
																		);
																	})
															)
														: null
												)
											: h(
													"div",
													{ className: "vig-ps-shot", style: { width: canvasW, height: canvasH } },
													h("canvas", {
														ref: viewRef,
														className: `vig-ps-canvas${tool === "select" ? " is-select" : ""}${tool === "straighten" ? " is-ruler" : ""}${tool === "warp" ? " is-warp" : ""}`,
														style: {
															width: canvasW,
															height: canvasH,
															imageRendering: scale >= 2 ? "pixelated" : "auto",
															...(gripDraft ? {position:'absolute',left:gripExtent.x*canvasW/stageW,top:gripExtent.y*canvasH/stageH,width:gripExtent.w*canvasW/stageW,height:gripExtent.h*canvasH/stageH} : {}),
															// 拖标尺时整层跟着转（一个 transform，不重画像素）—— 这就是「实时」的那一下
															transform: ruler ? `rotate(${ruler.angle}deg)` : undefined
														},
														onPointerDown,
														onPointerMove,
														onPointerUp,
														onPointerCancel: cancelToolDrag
													}),
													/* 选框 / 切割线单独一层：拖选区时不用重画底图（3000×4000 的图重画一次很贵） */
													h("canvas", {
														ref: overlayRef,
														className: "vig-ps-overlay",
														style: { width: canvasW, height: canvasH },
														"aria-hidden": "true"
													}),
													gripShown && h("div",{className:"vig-ps-transform",style:{left:gripShown.x/stageW*canvasW,top:gripShown.y/stageH*canvasH,width:gripShown.w/stageW*canvasW,height:gripShown.h/stageH*canvasH}},
														[...psHandles({x:0,y:0,w:100,h:100}),{id:"move",x:50,y:50}].map(({id,x,y})=>h("button",{key:id,type:"button",className:"vig-ps-grip","data-ps-handle":id,"aria-label":t("ps.tool.transform")+" · "+id,style:{left:x+"%",top:y+"%",cursor:id==="move"?"move":id+"-resize"},onPointerDown:e=>startGrip(e,id),onPointerMove:e=>trackGrip(e,false),onPointerUp:e=>trackGrip(e,true),onLostPointerCapture:stopGrip,onPointerCancel:stopGrip})))
												)
									)
								: h(
										"div",
										{ className: "vig-ps-empty" },
										h(Icon, { name: "image", size: 26 }),
										h("div", { style: { fontWeight: 600, color: "var(--vig-text)" } }, t("ps.empty")),
										h("div", { className: "vig-muted", style: { fontSize: 12 } }, t("ps.empty.hint")),
										h(
											"div",
											{ className: "vig-row" },
											h("button", { className: "vig-btn is-primary", onClick: () => fileRef.current?.click() }, h(Icon, { name: "upload" }), t("preset.upload")),
											h("button", { className: "vig-btn", onClick: () => { setLayerPick(false); setPickOpen(true); } }, h(Icon, { name: "grid" }), t("preset.fromLibrary"))
										),
										/* 进入页面只给出入口，不让浏览器预取原图。 */
										recentAssets.length || sampleAssets.length
											? h("div", { className:"vig-ps-recent" },
												h(PsAssetShelf, {kind:"recent", label:t("ps.empty.recent"), items:recentAssets, onOpen:loadAsset}),
												h(PsAssetShelf, {kind:"samples", label:t("ps.empty.samples"), items:sampleAssets, onOpen:loadAsset}))
											: h(
													"ol",
													{ className: "vig-ps-steps" },
													h("li", null, t("ps.empty.step1")),
													h("li", null, t("ps.empty.step2")),
													h("li", null, t("ps.empty.step3"))
												)
									),
							source
								? h(
										"div",
										{ className: "vig-ps-zoom", title: t("ps.zoom.hint") },
										h("button", { className: "vig-ps-zoom-btn", title: t("ps.zoom.out"), "aria-label": t("ps.zoom.out"), onClick: () => nudgeZoom(-1) }, "−"),
										h("span", { className: "vig-ps-zoom-val" }, `${Math.round(scale * 100)}%`),
										h("button", { className: "vig-ps-zoom-btn", title: t("ps.zoom.in"), "aria-label": t("ps.zoom.in"), onClick: () => nudgeZoom(1) }, "+"),
										h("button", { className: `vig-ps-zoom-btn${zoom.mode === "fit" ? " is-on" : ""}`, onClick: () => setZoom({ mode: "fit", scale: 1 }) }, t("ps.zoom.fit")),
										h("button", { className: `vig-ps-zoom-btn${zoom.mode === "actual" ? " is-on" : ""}`, onClick: () => setZoom({ mode: "actual", scale: 1 }) }, t("ps.zoom.actual"))
									)
								: null
						),
						// 图层控制条（画布下方横排）：底图 + 各层缩略图；点选中、×删除、眼睛显隐、拖拽排序、双击进单层编辑
						h(
							"div",
							{ className: "vig-ps-layerbar", role: "list", "aria-label": t("ps.layers") },
							h(
								"button",
								{
									className: `vig-ps-chip is-base${activeLayerId ? "" : " is-on"}`,
									title: t("ps.layer.baseHint"),
									onClick: () => {setActiveLayerId("");if(!selection && (tool==="select" || warpLocked)) setTool("transform");}
								},
								layerThumbs.base ? h("img", { className: "vig-ps-chip-thumb", src: layerThumbs.base, alt: "" }) : h("span", { className: "vig-ps-chip-thumb is-empty" }),
								h("span", { className: "vig-ps-chip-name" }, t("ps.layer.base"))
							),
							(layers || []).map((layer, index) =>
								h(
									"div",
									{
										key: layer.id,
										className: `vig-ps-chip${activeLayerId === layer.id ? " is-on" : ""}${layer.visible === false ? " is-hidden" : ""}${layerSession?.id === layer.id ? " is-editing" : ""}${dragLayerId === layer.id ? " is-dragging" : ""}`,
										role: "listitem",
										draggable: !layerControlsLocked,
										title: `${layer.name} · 拖拽排序 / 双击进入单层编辑`,
										onDragStart: () => setDragLayerId(layer.id),
										onDragEnd: () => setDragLayerId(""),
										onDragOver: (event) => event.preventDefault(),
										onDrop: (event) => {
											event.preventDefault();
											if (!dragLayerId) return;
											event.stopPropagation();
											const from = dragLayerId;
											setDragLayerId("");
											if (from && from !== layer.id) changeLayers(t("ps.layers"), list => psMoveLayerTo(list, from, layer.id));
										},
										onClick: () => {setActiveLayerId(layer.id);if(!selection && (tool==="select" || warpLocked)) setTool("transform");},
										onDoubleClick: event => { if (!layerControlsLocked && psLayerRowActivate(event)) void enterLayer(layer); }
									},
									layerThumbs.items[index]
										? h("img", { className: "vig-ps-chip-thumb", src: layerThumbs.items[index], alt: "" })
										: h("span", { className: "vig-ps-chip-thumb is-empty" }),
									h("span", { className: "vig-ps-chip-name", title: layer.name }, layer.name),
									h(
										"button",
										{
											className: "vig-ps-chip-eye",
											title: t("ps.layer.visible"), disabled: layerControlsLocked,
											"aria-pressed": layer.visible !== false,
											onClick: (event) => {
												event.stopPropagation();
												toggleLayer(layer.id);
											}
										},
										h(Icon, { name: layer.visible === false ? "close" : "check", size: 10 })
									),
									h(
										"button",
										{
											className: "vig-ps-chip-x",
											title: t("ps.layer.remove"), disabled: layerControlsLocked,
											onClick: (event) => {
												event.stopPropagation();
												removeLayer(layer.id);
											}
										},
										h(Icon, { name: "close", size: 10 })
									)
								)
							),
							h(
								"button",
								{
									className: "vig-ps-chip is-add",
									title: t("ps.layer.addLayer"), disabled: layerControlsLocked,
									onClick: () => {
										setLayerPick(true);
										setPickOpen(true);
									}
								},
								h(Icon, { name: "plus", size: 14 }),
								h("span", null, t("ps.layer.addLayer"))
							),
							// 选中图层的属性（控制条自洽：不用再去右栏找）：叠加算法 / 不透明度 / 顺序 / 蒙版 / 删除
							activeLayer
								? h(
										"div",
										{ className: "vig-ps-chipprops" },
										h("span", { className: "vig-ps-chipprops-name", title: activeLayer.name }, activeLayer.name),
										h(
											"label",
											{ className: "vig-ps-chipprops-row", title: t("ps.layer.mode") },
											h("span", null, t("ps.layer.mode")),
											h(
												"select",
												{
													className: "vig-ps-layer-mode", ...layerModeProps(activeLayer)
												},
												PS_BLEND_MODES.map((mode) => h("option", { key: mode.id, value: mode.id }, t(mode.labelKey)))
											)
										),
										h(
											"label",
											{ className: "vig-ps-chipprops-row", title: t("ps.layer.opacity") },
											h("span", null, t("ps.layer.opacity")),
											h("input", {
												className: "vig-range vig-ps-layer-opacity", ...layerOpacityProps(activeLayer)
											}),
											h("span", { className: "vig-ps-chipprops-val" }, `${Math.round((activeLayer.opacity ?? 1) * 100)}%`)
										),
										h(
											"button",
											{ className: "vig-ps-layer-mini", title: t("ps.layer.up"), disabled: layerControlsLocked || activeLayerIndex === layers.length - 1, onClick: () => moveLayer(activeLayerIndex, 1) },
											h(Icon, { name: "chevron", size: 11 })
										),
										h(
											"button",
											{ className: "vig-ps-layer-mini", title: t("ps.layer.down"), disabled: layerControlsLocked || activeLayerIndex === 0, onClick: () => moveLayer(activeLayerIndex, -1) },
											h(Icon, { name: "chevronDown", size: 11 })
										),
										h(
											"button",
											{
												className: `vig-ps-layer-mini${activeLayer.mask ? " is-on" : ""}`,
												title: activeLayer.mask ? t("ps.layer.maskInvert") : t("ps.layer.maskAdd"), disabled: layerControlsLocked,
												onClick: () => toggleLayerMask(activeLayer)
											},
											h(Icon, { name: activeLayer.mask ? "marquee" : "crop", size: 11 })
										),
										h(
											"button",
											{
												className: "vig-ps-layer-mini",
												title: t("ps.layer.edit"), disabled: layerControlsLocked,
												onClick: () => void enterLayer(activeLayer)
											},
											h(Icon, { name: "pen", size: 11 })
										),
										h(
											"button",
											{
												className: "vig-ps-layer-mini is-danger",
												title: t("ps.layer.remove"), disabled: layerControlsLocked,
												onClick: () => removeLayer(activeLayer.id)
											},
											h(Icon, { name: "trash", size: 11 })
										)
									)
								: null
						),
						// 原来参数栏的位置：图层（叠加算法）。参数改成浮窗，压在画布上。
						h(
							"div",
							{ className: `vig-ps-layers${layersOpen ? "" : " is-fold"}${layersAside ? "" : " is-collapsed"}` },
							h(
								"div",
								{ className: "vig-ps-layers-head" },
								h(
									"button",
									{
										className: "vig-mini",
										title: t("ps.layers.collapse"),
										"data-layers-aside": "collapse",
										onClick: () => setLayersAsidePersist(false)
									},
									h(Icon, { name: "chevron", size: 13 })
								),
								h(Icon, { name: "image", size: 15 }),
								h("span", null, t("ps.layers")),
								h("div", { className: "vig-spacer" }),
								h(
									"button",
									{
										className: "vig-ps-layer-mini",
										title: layersOpen ? t("ps.collapse") : t("ps.expand"),
										"aria-expanded": layersOpen ? "true" : "false",
										onClick: () => setLayersOpen((value) => !value)
									},
									h(Icon, { name: layersOpen ? "chevronDown" : "chevron", size: 12 })
								),
								h(
									"button",
									{
										className: "vig-btn is-ghost is-sm",
										title: t("preset.fromLibrary"), disabled: layerControlsLocked,
										onClick: () => {
											setLayerPick(true);
											setPickOpen(true);
										}
									},
									h(Icon, { name: "plus", size: 13 }),
									t("ps.layer.addLayer")
								)
							),
// 历史操作记录：做过哪几步、现在停在哪，点一下就能回到那一步
h(
	"div",
	{ className: "vig-ps-history" },
	h("span", { className: "vig-ps-history-title" }, t("ps.history")),
	h(
		"div",
		{ className: "vig-ps-history-list" },
		psHistorySteps(history, t("ps.history.now")).map((row) =>
			h(
				"button",
				{
					key: `${row.kind}-${row.index}`,
					className: `vig-ps-history-item is-${row.kind}`,
					title: row.label,
					onClick: () => jumpHistory(row)
				},
				row.label
			)
		)
	)
),
							layers.length === 0 ? h("div", { className: "vig-ps-layers-empty" }, t("ps.layer.empty")) : null,
							layerSession
								? h(
										"div",
										{ className: "vig-ps-layer-session" },
										h("span", null, t("ps.layer.editing", { name: layerSession.name })),
										h("div", { className: "vig-spacer" }),
										h("button", { className: "vig-btn is-sm is-primary", onClick: () => void exitLayer(true) }, t("ps.layer.back"))
									)
								: null,
							h(
								"div",
								{ className: "vig-ps-layer-row is-base" },
								// 会话里 source 已经换成那一层了，底图那一行要显示真正的底图名字
								h(
									"span",
									{ className: "vig-ps-layer-name", title: t("ps.layer.baseHint") },
									`${t("ps.layer.base")} · ${(layerSession?.base ?? source)?.name ?? ""}`
								),
								h("span", { className: "vig-ps-layer-meta" }, t("ps.layer.baseTag"))
							),
							layers
								.map((layer, index) => ({ layer, index }))
								.reverse()
								.map(({ layer, index }) =>
									h(
										"div",
										{ key: layer.id, className: `vig-ps-layer-row${layer.visible === false ? " is-hidden" : ""}${layerSession?.id === layer.id ? " is-editing" : ""}`, title: t("ps.layer.edit"), onClick: (event) => {
											// 点在行里的控件上（眼睛 / 混合模式 / 不透明度 / 蒙版 / 上下移 / 删除）不算「打开这层」：
											// 以前没拦，点一下不透明度滑杆就进了单层编辑会话
											if (layerControlsLocked || !psLayerRowActivate(event)) return;
											void enterLayer(layer);
										} },
										h(
											"button",
											{
												className: "vig-ps-layer-eye",
												title: t("ps.layer.visible"), disabled: layerControlsLocked,
												"aria-pressed": layer.visible !== false,
												onClick: () =>
													toggleLayer(layer.id)
											},
											h(Icon, { name: layer.visible === false ? "close" : "check", size: 12 })
										),
										h("span", { className: "vig-ps-layer-name", title: layer.name }, layer.name),
										h(
											"select",
											{
												className: "vig-ps-layer-mode", ...layerModeProps(layer)
											},
											PS_BLEND_MODES.map((mode) => h("option", { key: mode.id, value: mode.id }, t(mode.labelKey)))
										),
										h(
											"input",
											{
												className: "vig-ps-layer-opacity", ...layerOpacityProps(layer)
											}
										),
										h(
											"button",
											{ className: "vig-ps-layer-mini", title: t("ps.layer.up"), disabled: layerControlsLocked || index === layers.length - 1, onClick: () => moveLayer(index, 1) },
											h(Icon, { name: "chevron", size: 11 })
										),
										// 蒙版：有选区就用选区，没有就是整张可见（之后可以反转）
										h(
											"button",
											{
												className: `vig-ps-layer-mini${layer.mask ? " is-on" : ""}`,
												title: layer.mask ? t("ps.layer.maskInvert") : t("ps.layer.maskAdd"), disabled: layerControlsLocked,
													onClick: () => toggleLayerMask(layer)
											},
											h(Icon, { name: layer.mask ? "marquee" : "crop", size: 11 })
										),
										layer.mask
											? h(
													"button",
													{ className: "vig-ps-layer-mini is-danger", title: t("ps.layer.maskRemove"), disabled: layerControlsLocked, onClick: () => editLayer(layer.id, "ps.layer.maskRemove", l => l.mask ? {...l, mask:null} : l) },
													h(Icon, { name: "close", size: 11 })
												)
											: null,
										h(
											"button",
											{ className: "vig-ps-layer-mini", title: t("ps.layer.down"), disabled: layerControlsLocked || index === 0, onClick: () => moveLayer(index, -1) },
											h(Icon, { name: "chevronDown", size: 11 })
										),
										h(
											"button",
											{ className: "vig-ps-layer-mini is-danger", title: t("ps.layer.remove"), disabled: layerControlsLocked, onClick: () => removeLayer(layer.id) },
											h(Icon, { name: "trash", size: 11 })
										)
									)
								)
						),
					// 收纳后的浮动展开按钮（右栏归零时还能把图层/历史叫回来）
					layersAside
						? null
						: h(
								"button",
								{
									className: "vig-ps-aside-toggle",
									title: t("ps.layers.expand"),
									"data-layers-aside": "expand",
									onClick: () => setLayersAsidePersist(true)
								},
								h(Icon, { name: "chevronLeft", size: 14 })
							),
						h(
							"div",
							{
								className: `vig-ps-params vig-ps-float${panels.params ? "" : " is-collapsed"}`,
								// 收起时贴在右边缘（当抽屉把），展开时用拖过的位置
								style: { "--vig-float-x": `${floatPos.x}px`, "--vig-float-y": `${floatPos.y}px` }
							},
							panels.params
								? h(
										"div",
										{
											className: "vig-ps-params-head",
											style: { cursor: "grab", touchAction: "none" },
											title: t("ps.float.drag"),
											// 按住头部把浮窗拖走；位置记在 localStorage（下次打开还在原处）
											onPointerDown: (event) => {
												if (event.button !== 0) return;
												if (event.target?.closest?.("button")) return;
												const panel = event.currentTarget.parentElement;
												const area = panel.offsetParent;
												if (!area || getComputedStyle(panel).position !== "absolute") return;
												event.preventDefault();
												const startX = event.clientX, startY = event.clientY;
												const origin = { x: panel.offsetLeft, y: panel.offsetTop };
												let saved = origin;
												const move = (moveEvent) => {
													const next = {
														x: Math.max(0, Math.min(area.clientWidth - panel.offsetWidth, origin.x + moveEvent.clientX - startX)),
														y: Math.max(0, Math.min(area.clientHeight - 100, origin.y + moveEvent.clientY - startY))
													};
													saved = next;
													setFloatPos(next);
												};
												const stop = () => {
													window.removeEventListener("pointermove", move);
													window.removeEventListener("pointerup", stop);
													window.removeEventListener("pointercancel", stop);
													try {
														window.localStorage.setItem("dsh.velapi-image-go.ps.float", JSON.stringify(saved));
													} catch {
														/* 存不了就算了，本次会话照样能拖 */
													}
												};
												window.addEventListener("pointermove", move);
												window.addEventListener("pointerup", stop);
												window.addEventListener("pointercancel", stop);
											}
										},
										h(Icon, { name: PS_TOOLS.find((item) => item.id === tool)?.icon || "crop" }),
										h("span", { className: "vig-ps-params-name" }, t(`ps.tool.${tool}`)),
										h("div", { className: "vig-spacer" }),
										h("button", {
											className: "vig-icon-btn",
											title: `${t("ps.collapse")} (${t("ps.panels.params")})`,
											"aria-label": t("ps.collapse"),
											onClick: () => togglePanels({ params: false })
										}, h(Icon, { name: "chevron", size: 14 }))
									)
								: null,
							panels.params
								? params()
								: h(
										"button",
										{
											className: "vig-ps-params-open",
											title: `${t("ps.expand")} (${t("ps.panels.params")})`,
											"aria-label": t("ps.expand"),
											onClick: () => togglePanels({ params: true })
										},
										h(Icon, { name: PS_TOOLS.find((item) => item.id === tool)?.icon || "crop", size: 17 }),
										h("span", null, t(`ps.tool.${tool}`))
									),
							panels.params
								? h("div", { className: "vig-ps-foot" },
										h("button", { className: "vig-btn", onClick: () => fileRef.current?.click() }, h(Icon, { name: "upload" }), t("ps.replace")),
										h("button", { className: "vig-btn", disabled: !source, onClick: () => resetPsToolDrafts(stageW, stageH) }, t("ps.reload"))
									)
								: null
						)
					)
				),
				h("input", {
					ref: fileRef,
					type: "file",
					accept: "image/*",
					style: { display: "none" },
					onChange: (event) => {
						const file = event.target.files?.[0];
						event.target.value = "";
						void fromFile(file);
					}
				}),
				pickOpen
					? h(
							WorkbenchDialog,
							{ label: t("panel.pick"), onDismiss: () => { setLayerPick(false); setPickOpen(false); } },
							h(
								"div",
								{ className: "vig-modal", onClick: (event) => event.stopPropagation() },
								h(
									"div",
									{ className: "vig-row" },
									h("span", { className: "vig-modal-title" }, t("preset.fromLibrary")),
									h("div", { className: "vig-spacer" }),
									h("button", { className: "vig-icon-btn", onClick: () => setPickOpen(false) }, h(Icon, { name: "close" }))
								),
								state.library.length === 0
									? h("div", { className: "vig-empty" }, t("lib.empty"))
									: h(
											"div",
											{ className: "vig-grid" },
											state.library.slice(0, 32).map((asset) =>
												h(
													"button",
													{
														key: asset.id,
														className: "vig-tile",
														onClick: () => {
															setPickOpen(false); setLayerPick(false);
															void (layerPick ? addLayerFrom : loadImage)({name:asset.name,url:asset.url});
														}
													},
													h(GalleryThumb, {asset})
												)
											)
										)
							)
						)
					: null,
				keysOpen
					? h(
							WorkbenchDialog,
							{ label: t("ps.keys"), onDismiss: () => setKeysOpen(false) },
							h(
								"div",
								{ className: "vig-modal is-keys", onClick: (event) => event.stopPropagation() },
								h(
									"div",
									{ className: "vig-row" },
									h("span", { className: "vig-modal-title" }, t("ps.keys")),
									h("div", { className: "vig-spacer" }),
									Object.keys(overrides).length
										? h("button", {
												className: "vig-btn",
												onClick: () => {
													setOverrides({});
													saveBindings({});
													setRecording("");
													setKeyError("");
												}
											}, t("ps.keys.resetAll"))
										: null,
									h("button", { className: "vig-icon-btn", onClick: () => setKeysOpen(false) }, h(Icon, { name: "close" }))
								),
								[
									{ id: "tools", title: t("ps.keys.tools") },
									{ id: "view", title: t("ps.keys.view") },
									{ id: "edit", title: t("ps.keys.edit") },
									{ id: "out", title: t("ps.keys.out") }
								].map((group) =>
									h(
										"div",
										{ className: "vig-ps-keys", key: group.id },
										h("div", { className: "vig-ps-keys-title" }, group.title),
										PS_ACTIONS.filter((item) => item.group === group.id).map((item) => {
											const bound = bindings[item.id] || "";
											const custom = overrides[item.id] !== undefined;
											return h(
												"div",
												{ className: "vig-ps-keys-row", key: item.id },
												h(
													"button",
													{
														className: `vig-ps-key${recording === item.id ? " is-recording" : ""}${custom ? " is-custom" : ""}${bound ? "" : " is-off"}`,
														title: t("ps.keys.record"),
														onClick: () => {
															setKeyError("");
															setRecording(item.id);
														}
													},
													recording === item.id ? t("ps.keys.press") : psComboLabel(bound) || t("ps.keys.none")
												),
												h("span", null, t(item.label)),
												custom
													? h(
															"button",
															{
																className: "vig-ps-key-reset",
																title: `${t("ps.keys.reset")} · ${psComboLabel(PS_DEFAULT_BINDINGS[item.id])}`,
																onClick: () => {
																	setOverrides((value) => {
																		const next = { ...value };
																		delete next[item.id];
																		saveBindings(next);
																		return next;
																	});
																	setKeyError("");
																}
															},
															h(Icon, { name: "refresh", size: 13 })
														)
													: null
											);
										})
									)
								),
								keyError ? h("div", { className: "vig-ps-key-error" }, keyError) : null,
								h("p", { className: "vig-muted", style: { fontSize: 11.5, margin: "2px 0 0" } }, t("ps.keys.hint")),
								h("p", { className: "vig-muted", style: { fontSize: 11.5, margin: 0 } }, t("ps.keys.note"))
							)
						)
					: null
			);
		}

		/** 8 个手柄的坐标（画在选区边框上）。 */
		function psHandles(rect) {
			const midX = rect.x + rect.w / 2;
			const midY = rect.y + rect.h / 2;
			const left = rect.x;
			const right = rect.x + rect.w;
			const top = rect.y;
			const bottom = rect.y + rect.h;
			return [
				{ id: "nw", x: left, y: top },
				{ id: "n", x: midX, y: top },
				{ id: "ne", x: right, y: top },
				{ id: "e", x: right, y: midY },
				{ id: "se", x: right, y: bottom },
				{ id: "s", x: midX, y: bottom },
				{ id: "sw", x: left, y: bottom },
				{ id: "w", x: left, y: midY }
			];
		}

		/** 命中了哪个手柄（判断半径内最近的那个）。 */
		function psHitHandle(rect, point, radius) {
			let hit = null;
			let best = radius;
			for (const handle of psHandles(rect)) {
				const distance = Math.hypot(handle.x - point.x, handle.y - point.y);
				if (distance <= best) {
					best = distance;
					hit = handle.id;
				}
			}
			return hit;
		}

		/* ---- 缩放：滚轮以光标为锚点，比例夹在 5% ~ 800% ---- */

		const PS_ZOOM_MIN = 0.05;
		const PS_ZOOM_MAX = 8;
		const PS_ZOOM_STEP = 1.25;

		function psClampZoom(value) {
			const scale = Number(value);
			if (!Number.isFinite(scale) || scale <= 0) return 1;
			return Math.min(PS_ZOOM_MAX, Math.max(PS_ZOOM_MIN, scale));
		}

		/** 档位式加减（工具栏 − / + 用的）：一步 25%，到顶到底就停住。 */
		function psStepZoom(scale, direction) {
			return psClampZoom((Number(scale) || 1) * (direction > 0 ? PS_ZOOM_STEP : 1 / PS_ZOOM_STEP));
		}

		/** 滚轮缩放：返回新比例 + 让光标底下那个点原地不动的滚动位置。 */
		function psZoomAt(current, next, cursor, scroll) {
			const scale = psClampZoom(current);
			const target = psClampZoom(next);
			const ratio = target / scale;
			const cx = Number(cursor?.x) || 0;
			const cy = Number(cursor?.y) || 0;
			const left = Number(scroll?.left) || 0;
			const top = Number(scroll?.top) || 0;
			return { scale: target, scrollLeft: (left + cx) * ratio - cx, scrollTop: (top + cy) * ratio - cy };
		}

		/** 滚轮一次滚多少：每 100 像素当作一档，触控板的小步也不会跳。 */
		function psWheelZoom(scale, deltaY) {
			const steps = (-Number(deltaY) || 0) / 100;
			return psClampZoom((Number(scale) || 1) * PS_ZOOM_STEP ** steps);
		}

		/** 适应窗口的比例（只缩不放，1:1 留给用户自己按）。 */
		function psFitZoom(width, height, boxWidth, boxHeight) {
			const w = Math.max(1, Number(width) || 1);
			const h = Math.max(1, Number(height) || 1);
			const bw = Math.max(40, Number(boxWidth) || 40);
			const bh = Math.max(40, Number(boxHeight) || 40);
			return psClampZoom(Math.min(bw / w, bh / h, 1));
		}

		/* ---- 分辨率（DPI）：PNG 的 pHYs 块 / JPEG 的 JFIF 密度 ---- */

		/** base64 ↔ 字节：自己实现，浏览器和测试沙箱里都不缺依赖。 */
		const PS_B64 = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";

		function psB64Decode(text) {
			const clean = String(text || "").replace(/[^A-Za-z0-9+/]/g, "");
			const out = new Uint8Array(Math.floor((clean.length * 3) / 4));
			let acc = 0;
			let bits = 0;
			let index = 0;
			for (const char of clean) {
				const value = PS_B64.indexOf(char);
				if (value < 0) continue;
				acc = (acc << 6) | value;
				bits += 6;
				if (bits >= 8) {
					bits -= 8;
					out[index] = (acc >> bits) & 0xff;
					index += 1;
				}
			}
			return out.slice(0, index);
		}

		function psB64Encode(bytes) {
			let out = "";
			for (let i = 0; i < bytes.length; i += 3) {
				const b0 = bytes[i];
				const b1 = bytes[i + 1];
				const b2 = bytes[i + 2];
				out += PS_B64[b0 >> 2];
				out += PS_B64[((b0 & 3) << 4) | ((b1 ?? 0) >> 4)];
				out += i + 1 < bytes.length ? PS_B64[((b1 & 15) << 2) | ((b2 ?? 0) >> 6)] : "=";
				out += i + 2 < bytes.length ? PS_B64[b2 & 63] : "=";
			}
			return out;
		}

		let psCrcTable = null;

		function psCrc32(bytes) {
			if (!psCrcTable) {
				psCrcTable = new Uint32Array(256);
				for (let n = 0; n < 256; n += 1) {
					let c = n;
					for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
					psCrcTable[n] = c >>> 0;
				}
			}
			let crc = 0xffffffff;
			for (let i = 0; i < bytes.length; i += 1) crc = psCrcTable[(crc ^ bytes[i]) & 0xff] ^ (crc >>> 8);
			return (crc ^ 0xffffffff) >>> 0;
		}

		const psReadU32 = (bytes, at) => ((bytes[at] << 24) | (bytes[at + 1] << 16) | (bytes[at + 2] << 8) | bytes[at + 3]) >>> 0;
		const psReadU16 = (bytes, at) => (bytes[at] << 8) | bytes[at + 1];

		function psWriteU32(bytes, at, value) {
			bytes[at] = (value >>> 24) & 0xff;
			bytes[at + 1] = (value >>> 16) & 0xff;
			bytes[at + 2] = (value >>> 8) & 0xff;
			bytes[at + 3] = value & 0xff;
		}

		const psPngChunk = (bytes, at) => String.fromCharCode(bytes[at + 4], bytes[at + 5], bytes[at + 6], bytes[at + 7]);

		function psIsPng(bytes) {
			return bytes.length > 8 && bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47;
		}

		function psIsJpeg(bytes) {
			return bytes.length > 4 && bytes[0] === 0xff && bytes[1] === 0xd8;
		}

		/** 读 DPI：PNG 取 pHYs（单位米），JPEG 取 JFIF 密度；读不到返回 null。 */
		function psReadDpi(dataUrl) {
			const comma = String(dataUrl || "").indexOf(",");
			if (comma < 0) return null;
			return psReadDpiBytes(psB64Decode(String(dataUrl).slice(comma + 1, comma + 1 + 349524)));
		}
		function psReadDpiBytes(bytes) {
			if (psIsPng(bytes)) {
				let at = 8;
				while (at + 12 <= bytes.length) {
					const length = psReadU32(bytes, at);
					const type = psPngChunk(bytes, at);
					if (type === "pHYs" && length >= 9 && at + 17 <= bytes.length) {
						const unit = bytes[at + 8 + 8];
						const perMeter = psReadU32(bytes, at + 8);
						if (unit === 1 && perMeter > 0) return Math.round(perMeter * 0.0254);
						return 72;
					}
					if (type === "IDAT" || type === "IEND") break;
					at += 12 + length;
				}
				return null;
			}
			if (bytes.length >= 18 && psIsJpeg(bytes) && bytes[2] === 0xff && bytes[3] === 0xe0) {
				const units = bytes[13];
				const x = psReadU16(bytes, 14);
				const y = psReadU16(bytes, 16);
				if (units === 1) return Math.round((x + y) / 2);
				if (units === 2) return Math.round(((x + y) / 2) * 2.54);
				return null;
			}
			return null;
		}

		/** 往 PNG 里写 pHYs：旧的先丢掉，新的插在 IHDR 后面，CRC 重算。 */
		function psPngWithDpi(bytes, dpi) {
			// pHYs 存的是「像素/米」，按 1 inch = 0.0254 m 换算
			const perMeter = Math.max(1, Math.round((Number(dpi) || 72) / 0.0254));
			const phys = new Uint8Array(9);
			psWriteU32(phys, 0, perMeter);
			psWriteU32(phys, 4, perMeter);
			phys[8] = 1;
			const header = bytes.slice(0, 8);
			const chunks = [];
			let at = 8;
			let sawIhdr = false;
			let inserted = false;
			while (at + 12 <= bytes.length) {
				const length = psReadU32(bytes, at);
				const type = psPngChunk(bytes, at);
				const end = at + 12 + length;
				if (type === "pHYs") {
					// 旧的扔掉，最后用新的补上
					at = end;
					continue;
				}
				if (sawIhdr && !inserted) {
					chunks.push(psPngChunkBytes("pHYs", phys));
					inserted = true;
				}
				chunks.push(bytes.slice(at, Math.min(end, bytes.length)));
				if (type === "IHDR") sawIhdr = true;
				if (type === "IEND") break;
				at = end;
			}
			if (sawIhdr && !inserted) chunks.push(psPngChunkBytes("pHYs", phys));
			const total = header.length + chunks.reduce((sum, chunk) => sum + chunk.length, 0);
			const out = new Uint8Array(total);
			out.set(header, 0);
			let cursor = header.length;
			for (const chunk of chunks) {
				out.set(chunk, cursor);
				cursor += chunk.length;
			}
			return out;
		}

		function psPngChunkBytes(type, data) {
			const chunk = new Uint8Array(12 + data.length);
			psWriteU32(chunk, 0, data.length);
			for (let i = 0; i < 4; i += 1) chunk[4 + i] = type.charCodeAt(i);
			chunk.set(data, 8);
			psWriteU32(chunk, 8 + data.length, psCrc32(chunk.slice(4, 8 + data.length)));
			return chunk;
		}

		/** 往 JPEG 的 JFIF APP0 里写密度（单位 inch）。没有 APP0 就原样返回。 */
		function psJpegWithDpi(bytes, dpi) {
			if (bytes.length < 20 || bytes[2] !== 0xff || bytes[3] !== 0xe0) return bytes;
			const out = bytes.slice(0);
			const density = Math.min(65535, Math.max(1, Math.round(dpi)));
			out[13] = 1;
			out[14] = (density >> 8) & 0xff;
			out[15] = density & 0xff;
			out[16] = (density >> 8) & 0xff;
			out[17] = density & 0xff;
			return out;
		}

		/** 统一的「按分辨率导出」：PNG / JPEG 各自写进自己的头，别的格式原样返回。 */
		function psApplyDpi(dataUrl, dpi) {
			const comma = String(dataUrl || "").indexOf(",");
			if (comma < 0) return dataUrl;
			const head = String(dataUrl).slice(0, comma);
			if (!/^data:image\/(png|jpe?g)/i.test(head)) return dataUrl;
			const target = Math.min(1200, Math.max(1, Math.round(Number(dpi) || 72)));
			const bytes = psB64Decode(String(dataUrl).slice(comma + 1));
			const next = psIsPng(bytes) ? psPngWithDpi(bytes, target) : psIsJpeg(bytes) ? psJpegWithDpi(bytes, target) : bytes;
			return `${head},${psB64Encode(next)}`;
		}

		/** 按比例算目标尺寸（画布面板的「常用尺寸」）：长边不动，短边跟着比例走。 */
		function psRatioSize(width, height, ratio) {
			const w = Math.max(1, Number(width) || 1);
			const h = Math.max(1, Number(height) || 1);
			const target = Math.max(0.01, Number(ratio) || 1);
			const long = Math.max(w, h);
			return target >= 1
				? { w: long, h: Math.max(1, Math.round(long / target)) }
				: { w: Math.max(1, Math.round(long * target)), h: long };
		}



		/** 重载整个界面。
		 *  桌面端（Electron）没有绑 Ctrl+R，菜单里也没有「重新加载」，F12 才开得出控制台，
		 *  所以把这件事做进面板：客户端插件平时是热的（宿主盯着 bundle 文件，一变就通过
		 *  /plugins/events 推 rebuilt，页面里的 client-hmr 立刻重载那个条目），
		 *  但这个按钮是页面级兜底 —— 缓存、半挂的席位、连不上的事件流，重载一次全清掉。 */
		function reloadShell() {
			try {
				window.location.reload();
			} catch (error) {
				console.warn("[velapi-image-go] reload failed", error);
			}
		}

		/* 渲染兜底：插件重载或渲染异常时不再整块白屏，给出可恢复的一屏错误提示。 */
		// 有些最小 React 环境（测试用 mock）没有 Component：降级成一个普通类，避免模块加载就崩
		const BoundaryBase =
			typeof react.Component === "function"
				? react.Component
				: class {
						constructor(props) {
							this.props = props;
							this.state = null;
						}
						setState() {}
				  };
		class PluginBoundary extends BoundaryBase {
			constructor(props) {
				super(props);
				this.state = { error: null };
			}
			static getDerivedStateFromError(error) {
				return { error };
			}
			componentDidCatch(error, info) {
				console.error("[velapi-image-go] render failed:", error, info);
			}
			render() {
				if (!this.state.error) return this.props.children;
				return h(
					"div",
					{ className: "vig-root", style: { padding: 24, font: "13px/1.6 ui-sans-serif, system-ui", color: "#0b0b0c" } },
					h("div", { style: { fontWeight: 650, fontSize: 14, marginBottom: 8 } }, "生图工作台渲染出错"),
					h("div", { style: { color: "#8a8a8f", marginBottom: 12, wordBreak: "break-all" } }, String(this.state.error?.message ?? this.state.error)),
					h(
						"button",
						{
							style: { height: 32, padding: "0 14px", borderRadius: 999, background: "#ff3a00", color: "#fff", border: 0, cursor: "pointer" },
							onClick: () => this.setState({ error: null })
						},
						"重试"
					)
				);
			}
		}

		// 刷新只恢复文本和本站已留档图片的路径，不向浏览器存储写 base64 或 JSON 请求覆盖。
		const draftKey = (id) => `dsh.velapi-image-go.draft.${id}`;
		function readComposer(id) {
			let stored;
			try { if (id) stored = JSON.parse(window.sessionStorage.getItem(draftKey(id))); } catch { /* storage may be disabled */ }
			const refs = (Array.isArray(stored?.refs) ? stored.refs : []).filter((r) => /^\/api\/velapi-image-go\/(?:asset|upload|preset)\/[\w.-]+$/.test(r?.url)).slice(0, 4);
			return { text: String(stored?.text || "").slice(0, 500), refs: refs.map((r) => ({name:String(r.name || "image"), url:r.url, dataUrl:r.url})), edit: !!stored?.edit, override:null };
		}
		function persistComposer(id, text, refs, edit) {
			if (!id) return;
			try {
				const linked = refs.filter((r) => /^\/api\/velapi-image-go\/(?:asset|upload|preset)\/[\w.-]+$/.test(r.url)).map(({url, name}) => ({url, name}));
				if (text || linked.length) window.sessionStorage.setItem(draftKey(id), JSON.stringify({text, refs:linked, edit}));
				else window.sessionStorage.removeItem(draftKey(id));
			} catch { /* 内存中的编辑继续可用 */ }
		}

		function Workbench({ onOpenInRightbar }) {
			const [view, setView] = useState(() => window.localStorage.getItem(VIEW_KEY) || "chat");
			// 右侧检查器收没收起（存 "0" = 收起）；默认展开
			const [sideOpen, setSideOpen] = useState(() => window.localStorage.getItem(SIDE_KEY) !== "0");
			// 对话（会话）：每个会话独立历史（新对话不继承记忆）；上下文管理默认开
			const [conversations, setConversations] = useState([]);
			const [conversationId, setConversationId] = useState(() => window.localStorage.getItem(CONV_KEY) || "");
			const [chatModels, setChatModels] = useState([]);
			const [config, setConfig] = useState({ baseUrl: "", apiKeyEnv: "", keyMask: "", hasKey: false, defaultModel: "", defaultSize: "1024x1024", videoSize: "1280x720", videoRatio: "16:9", videoResolution: "720p", videoSeconds: "4", defaultQuality: "LOW", defaultCount: 1, defaultEndpoint: window.localStorage.getItem(ENDPOINT_KEY) || "auto", activeProviderId: "", stateDir: "", chatModel: "", contextTurns: 6 });
			const [providers, setProviders] = useState([]);
			const [library, setLibrary] = useState([]);
			const [libraryTotal, setLibraryTotal] = useState(0);
			const [libraryLoadingMore, setLibraryLoadingMore] = useState(false);
			const libraryRevision = useRef(0);
			const morePending = useRef(false);
			const storageMoveLock = useSubmitLock();
			const replaceLibrary = (payload) => {
				++libraryRevision.current;
				const rows = payload.items || [];
				setLibrary(rows);
				setLibraryTotal(payload.total ?? rows.length);
			};
			const [notes, setNotes] = useState([]);
			const [presets, setPresets] = useState([]);
			/* JSON 面板：基于当前草稿，仅将编辑过的字段绑定到下一次发送。 */
			const [jsonOpen, setJsonOpen] = useState(false);
			/* size 原样发送：上游认「档位 + 宽高比」；关掉则发送前转成像素 */
			const [sizeRaw, setSizeRaw] = useState(() => {
				try {
					return window.localStorage.getItem("dsh.velapi-image-go.size-raw") !== "0";
				} catch (error) {
					return true;
				}
			});
			const setSizeRawPersist = (value) => {
				setSizeRaw(value);
				try {
					window.localStorage.setItem("dsh.velapi-image-go.size-raw", value ? "1" : "0");
				} catch (error) {
					/* 隐私模式写不了就只活这次 */
				}
			};
			const [jsonDraft, setJsonDraft] = useState("");
			const jsonOverrideRef = useRef(null);
			const jsonBaseRef = useRef(null);
			const buildRequestPreview = (prompt, raw = sizeRaw) => buildGenerationRequest({ prompt: String(prompt || "").trim(), config, providers, conversationId, references, isVideoEndpoint, sizeRaw: raw });
			const jsonBody = () => {
				const parsed = JSON.parse(jsonDraft);
				if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("not an object");
				return parsed;
			};
			const openJsonPreview = () => {
				const base = buildRequestPreview(draft);
				jsonBaseRef.current = base;
				const candidate = { ...base, ...jsonOverrideRef.current };
				let preview = candidate;
				try { preview = normalizeGenerationBody(candidate, sizeRaw, isVideoEndpoint ? config.videoSize : config.defaultSize, isVideoEndpoint); }
				catch (error) { toast(error.message, "err"); }
				setJsonDraft(JSON.stringify(preview, null, 2));
				setJsonOpen(true);
			};
			const toggleJsonSize = (next) => {
				try {
					const body = normalizeGenerationBody(jsonBody(), next, isVideoEndpoint ? config.videoSize : config.defaultSize, isVideoEndpoint);
					jsonBaseRef.current = buildRequestPreview(draft, next);
					setJsonDraft(JSON.stringify(body, null, 2));
					setSizeRawPersist(next);
				} catch (error) { toast(error.message === t("chat.geminiReload") || error.message === t("chat.geminiParams") ? error.message : t("chat.jsonInvalid"), "err"); }
			};
			const applyJsonDraft = () => {
				try {
					const candidate = jsonBody();
					candidate.endpoint = imageRequestProtocol(candidate.endpoint || config.defaultEndpoint, candidate.providerId || providerIdForModel(providers, config, candidate.model), providers);
					if (candidate.endpoint === GEMINI_NATIVE && !geminiReady(protocols)) throw Error(t("chat.geminiReload"));
					const parsed = normalizeGenerationBody(candidate, sizeRaw, isVideoEndpoint ? config.videoSize : config.defaultSize, isVideoEndpoint);
					jsonOverrideRef.current = requestOverrides(jsonBaseRef.current || {}, parsed);
					setJsonOpen(false);
					toast(t("chat.jsonApplied"));
				} catch (error) { toast(error.message === t("chat.geminiReload") || error.message === t("chat.geminiParams") ? error.message : t("chat.jsonInvalid"), "err"); }
			};
			// 端点协议整表由宿主 /status 给（宿主给了就用它那份带 label 的）。
			const [protocols, setProtocols] = useState([]);
			/* 这次要出的是图还是视频：优先看「选中的模型」是不是视频模型（用户常常直接点
			   wan3.0-video-1080p 这种模型），其次看端点协议的 kind。视频走独立尺寸/时长参数。
			   放在 Workbench 层，是因为 generate（actions 里）和 ChatView 的渲染都要用它。 */
			const endpointKind = (() => {
				const hit = (protocols || []).find((item) => item.id === (config.defaultEndpoint || "auto"));
				return hit?.kind === "video" ? "video" : "image";
			})();
			const selectedModelKind = modelKindOf(config.defaultModel, providers);
			const isVideoEndpoint = config.defaultEndpoint !== GEMINI_NATIVE && (endpointKind === "video" || selectedModelKind === "video");
			/* 更新入口：一次点击 = 检查；查到新版本后再点一次 = 只拉取，不重启。
			   （进度条只在这期间出现，结束就收起。） */
			const [updateState, setUpdateState] = useState({ phase: "idle", percent: 0 });
			const updateInfoRef = useRef(null), buildEpoch = useRef(0);
			const [build, setBuild] = useState({ version:PLUGIN_VERSION, sha:"" });
			const shortSha = value => /^[0-9a-f]{7,64}$/i.test(value || "") ? value.slice(0,7).toLowerCase() : "";
			const buildLabel = [build.version ? `v${build.version.replace(/^(\d+\.\d+\.\d+)-rev\.(\d+)$/, "$1.$2")}` : t("update.pulledLabel"), build.sha].filter(Boolean).join(" · ");
			useEffect(() => {
				let active = true; const initial = buildEpoch.current;
				// 兼容尚未重载的 0.1.0 宿主：其 check 不识别 localOnly，remote="." 也只查本机仓库。
				void call("/update/check", { method:"POST", body:{localOnly:true, remote:"."} }).then(info => {
					if (active && initial === buildEpoch.current) setBuild({version:info.packageVersion || PLUGIN_VERSION, sha:shortSha(info.localSha)});
				}).catch(() => {}); // 无 git 或老宿主不支持：只显示包版本，不猜提交号。
				return () => { active = false; };
			}, []);
			const checkUpdate = async () => {
				if (updateState.phase === "running") return;
				++buildEpoch.current;
				const recent = updateInfoRef.current;
				// 第二次点击（刚查到 behind，两分钟内有效）：直接只拉取，不重启
				if (recent?.code === "behind" && Date.now() - recent.at < 120000) {
					updateInfoRef.current = null;
					setUpdateState({ phase: "running", percent: 45 });
					try {
						const applied = await call("/update/apply", { method: "POST", body: {} });
						if (applied?.pulled) {
							setBuild({version:applied.packageVersion || "", sha:shortSha(applied.to || applied.short?.to)});
							setUpdateState({ phase: "done", percent: 100 });
							toast(t("update.applied", { sha: applied.short?.to || "" }));
							window.setTimeout(() => setUpdateState({ phase: "idle", percent: 0 }), 3600);
							return;
						}
						setUpdateState({ phase: "done", percent: 100 });
						toast(applied?.hint || t("update.latest"));
						if (applied?.code !== "latest") setUpdateState({ phase: "unwired", percent: 100 });
						window.setTimeout(() => setUpdateState({ phase: "idle", percent: 0 }), 3600);
					} catch (error) {
						setUpdateState({ phase: "unwired", percent: 100 });
						const reason = String(error?.message ?? error);
						const networkIssue = /unable to access|failed to connect|timed out|could not resolve|网络无法链接/i.test(reason);
						toast(networkIssue ? t("update.networkBlocked") : t("update.pullFailed", { reason }), "err");
						window.setTimeout(() => setUpdateState({ phase: "idle", percent: 0 }), 3600);
					}
					return;
				}
				// 第一次点击：检查远端有没有新提交
				setUpdateState({ phase: "running", percent: 12 });
				const finish = (phase, ms) => window.setTimeout(() => setUpdateState({ phase: "idle", percent: 0 }), ms);
				try {
					const payload = await call("/update/check", { method: "POST", body: {} });
					if (payload.localSha) setBuild(prev => ({...prev, sha:shortSha(payload.localSha)}));
					setUpdateState({ phase: "done", percent: 100 });
					if (payload?.code === "behind") {
						updateInfoRef.current = { code: "behind", at: Date.now(), remote: payload.short?.remote };
						toast(`${t("update.behind", { sha: payload.short?.remote || payload.remoteSha?.slice(0, 7) || "?" })} · ${t("update.clickAgain")}`);
					} else if (payload?.code === "latest") {
						toast(`${t("update.latest")}${payload.short?.local ? ` · ${payload.short.local}` : ""}`);
					} else {
						setUpdateState({ phase: "unwired", percent: 100 });
						// 网络问题（GitHub 不可达）统一说人话：需要特殊网络环境
						const networkIssue =
							payload?.code === "remote_unreachable" ||
							/unable to access|failed to connect|timed out|could not resolve/i.test(String(payload?.error ?? ""));
						toast(networkIssue ? t("update.networkBlocked") : payload?.hint || t("update.notWired"), "err");
					}
					finish(payload?.code === "behind" || payload?.code === "latest" ? "done" : "unwired", 3200);
				} catch (error) {
					// 宿主连这个端点都没有（老版本）：说清楚没接壤
					setUpdateState({ phase: "unwired", percent: 100 });
					toast(t("update.notWired"), "err");
					finish("unwired", 3200);
				}
			};
			const [jobs, setJobs] = useState([]);
			/* 会话隔离：切换会话时恢复该会话自己的生图配置；新会话回落到最初默认，不继承上一个会话。 */
			const conversationIdRef = useRef(conversationId);
			const initialConfigRef = useRef(null);
			// 切换时只恢复本地设置，绝不把上一个会话的 render 快照写给新会话。
			const inputEpoch = useRef(0);
			const [initialDraft] = useState(() => readComposer(conversationId));
			const savedComposers = useRef(new Map());
			const [draft, renderDraft] = useState(initialDraft.text);
			const [references, renderReferences] = useState(initialDraft.refs);
			const [editMode, renderEditMode] = useState(initialDraft.edit);
			const draftNow = useRef(draft), refsNow = useRef(references), editNow = useRef(editMode);
			const persistCurrent = () => persistComposer(conversationIdRef.current, draftNow.current, refsNow.current, editNow.current);
			const setDraft = (next) => {
				draftNow.current = typeof next === "function" ? next(draftNow.current) : next;
				renderDraft(draftNow.current); persistCurrent();
			};
			const setReferences = (next) => {
				refsNow.current = typeof next === "function" ? next(refsNow.current) : next;
				renderReferences(refsNow.current); persistCurrent();
			};
			const setEditMode = (value) => { editNow.current = value; renderEditMode(value); persistCurrent(); };
			const activateConversation = useCallback((id, forget = false) => {
				const prev = conversationIdRef.current, drafts = savedComposers.current;
				const current = {text:draftNow.current, refs:refsNow.current.map((r) => r.url ? { ...r, dataUrl:r.url } : r), edit:editNow.current, override:jsonOverrideRef.current};
				if (prev && !forget) {
					drafts.delete(prev);
					if (current.text || current.refs.length || current.override) drafts.set(prev, current);
					if (drafts.size > 12) drafts.delete(drafts.keys().next().value);
				}
				const next = drafts.get(id) || (!prev && (current.text || current.refs.length) ? current : readComposer(id));
				drafts.delete(id);
				++inputEpoch.current;
				conversationIdRef.current = id;
				setConversationId(id);
				renderDraft(draftNow.current = next.text);
				renderReferences(refsNow.current = next.refs);
				renderEditMode(editNow.current = next.edit);
				jsonOverrideRef.current = next.override;
				if (!prev && next === current) persistComposer(id, next.text, next.refs, next.edit);
				setJsonOpen(false); setPickOpen(false); setGridTarget(null);
				const saved = readConvSettings()[id] || initialConfigRef.current;
				if (saved) setConfig((previous) => ({ ...previous, geminiSize:undefined, geminiRatio:undefined, ...saved }));
			}, []);
			const [pending, setPending] = useState(0);
			const [unsent, setUnsent] = useState([]);
			const discardedConvs = useRef(new Set());
			const retryLocks = useRef(new Set());
			const awaitingJobs = useRef(new Map());
			const withAwaiting = (id, rows) => [...awaitingJobs.current.values()].filter((item) => item.conversationId === id).reverse().concat(rows);
			const newConvPending = useRef(false);

			const appendReference = (entry) => {
				if (refsNow.current.length >= 4) { toast(t("chat.refLimit"), "err"); return false; }
				setReferences([...refsNow.current, entry]);
				return true;
			};
			/** 参考图留档：上传到宿主 uploads，换回本站 URL（缩略图 / 重试 / 编辑都靠它）。失败返回空串。 */
			const uploadRefData = async (name, dataUrl) => {
				try {
					const payload = await call("/upload", { method: "POST", body: { name: name || "reference.png", data: dataUrl } });
					return payload?.item?.url || "";
				} catch {
					return "";
				}
			};
			const [generating, setGenerating] = useState(false);
			const [pickOpen, setPickOpen] = useState(false);
			const [ready, setReady] = useState(false);
			const [fatal, setFatal] = useState("");
			// 宿主版本比界面旧（/capabilities 都没有）：原生拖拽 / 图生图修复都在宿主侧，
			// 必须重启 DSH。这里明确挂出来，别让用户以为「拖到 PPT 坏了」。
			const [hostOutdated, setHostOutdated] = useState(false);
			// 新宿主但没有 Electron 原生拖拽能力（被沙箱限制）：也得出声，改为引导用复制图片
			const [capsInfo, setCapsInfo] = useState(null);
			// 图片查看器：{ items, index, source }；source = chat / library（决定给不给「删除」）
			const [viewer, setViewer] = useState(null);
			const [gridTarget, setGridTarget] = useState(null);
			const deletingAssetIds = useRef(new Set());
			const libraryIdFor = (image) => {
				const id = image?.id || image?.assetId;
				return id && library.some((asset) => asset.id === id) ? id : null;
			};
			// 「到图片处理」的入口：{ name, dataUrl }，PsView 载入后由它自己消化
			const [psImage, setPsImage] = useState(null);
			const fileRef = useRef(null);
			const rootRef = useRef(null);
			const wide = useWide(rootRef);
			const timers = useRef(new Map());
			const [toasts, toast] = useToasts();

			useEffect(() => {
				window.localStorage.setItem(VIEW_KEY, view);
			}, [view]);

			useEffect(() => {
				window.localStorage.setItem(SIDE_KEY, sideOpen ? "1" : "0");
			}, [sideOpen]);

			useEffect(() => {
				window.localStorage.setItem(ENDPOINT_KEY, config.defaultEndpoint || "auto");
			}, [config.defaultEndpoint]);

			useEffect(() => {
				window.localStorage.setItem(CONV_KEY, conversationId || "");
			}, [conversationId]);


			const reload = useCallback(async () => {
				try {
					// 预设卡这条单独兜底：宿主老版本还没这条路由时，界面照常起来（空墙而已），
					// 不至于因为一条 404 把整个工作台打进错误页。
					const presetList = await call("/presets").catch(() => ({ items: [] }));
					// 宿主能力（原生拖拽 / 剪贴板）：老宿主 404 就保持 null，并在头部挂「重启 DSH」提示
					void call("/capabilities")
						.then((caps) => {
							setHostCapabilities(caps);
							setCapsInfo(caps);
							setHostOutdated(false);
						})
						.catch(() => {
							setHostCapabilities(null);
							setCapsInfo(null);
							setHostOutdated(true);
						});
					const [status, providerList, lib, noteList, convList] = await Promise.all([
						call("/status"),
						call("/providers"),
						call("/library?limit=200"),
						call("/notes"),
						call("/conversations").catch(() => ({ items: [] }))
					]);
					if (!initialConfigRef.current && status.config?.defaultModel) initialConfigRef.current = pickConfigFields(status.config);
					setConfig((previous) => ({
						...status.config,
						// 宿主老版本没有这个字段时，保留本地那份（协议选择不至于刷新就回默认）
						defaultEndpoint: status.config?.defaultEndpoint || previous.defaultEndpoint || "auto",
						// 老宿主还没有这个字段：保留本地那份，素材目录块不至于显示成空
						stateDir: status.config?.stateDir || previous.stateDir || "",
						chatModel: status.config?.chatModel || previous.chatModel || "",
						contextTurns: status.config?.contextTurns ?? previous.contextTurns ?? 6
					}));
					setProtocols(Array.isArray(status.protocols) ? status.protocols : []);
					setChatModels(Array.isArray(status.chatModels) ? status.chatModels : []);
					setProviders(providerList.items || []);
					replaceLibrary(lib);
					setNotes(noteList.items || []);
					setPresets(presetList.items || status.presets || []);
					/* 对话（会话）：挑一个当前对话（本地记着的那条还在就用它，否则用第一条），
					   只拉这个会话的任务 —— 每个会话记忆互相隔离。 */
					const convItems = convList.items || [];
					setConversations(convItems);
					const storedConv = conversationIdRef.current || window.localStorage.getItem(CONV_KEY) || "";
					const activeConv = convItems.some((item) => item.id === storedConv) ? storedConv : convItems[0]?.id || "";
					if (activeConv !== conversationIdRef.current) activateConversation(activeConv);
					else {
						const saved = readConvSettings()[activeConv];
						if (saved) setConfig((previous) => ({ ...previous, geminiSize:undefined, geminiRatio:undefined, ...saved }));
					}
					const jobList = await call(`/jobs?limit=40${activeConv ? `&conversationId=${encodeURIComponent(activeConv)}` : ""}`).catch(() => ({ items: [], pending: 0 }));
					if (activeConv !== conversationIdRef.current) return;
					const items = jobList.items || [];
					setJobs(withAwaiting(activeConv, items));
					setPending(jobList.pending || 0);
					// 还挂着的任务要接着轮询：刷新页面（或从别处切回来）时，之前发出去的任务
					// 不归任何人管 —— 宿主早跑完了，界面却一直停在「生成中…」（踩过）。
					for (const job of items) {
						if (job.status === "queued" || job.status === "running") watchRef.current?.(job.id);
					}
					setReady(true);
					setFatal("");
				} catch (error) {
					setFatal(t("err.network", { error: String(error?.message ?? error) }));
				}
			}, []);

			useEffect(() => {
				void reload();
			}, [reload]);

			/** 单条任务轮询：终态即停，异常退避；超过 STALE_MS 还没终态就标 stale（别一直转圈）。 */
			const STALE_MS = 6 * 60 * 1000;
			const watchJob = useCallback(
				(jobId) => {
					if (timers.current.has(jobId)) return;
					let delay = 1200;
					const startedAt = Date.now();
					const tick = async () => {
						try {
							const payload = await call(`/job?id=${encodeURIComponent(jobId)}`);
							const job = payload.job;
							/* 会话隔离：任务属于别的会话 → 本会话不更新、不再轮询（避免切窗口后历史串混） */
							if (job?.conversationId && conversationIdRef.current && job.conversationId !== conversationIdRef.current) {
								timers.current.delete(jobId);
								return;
							}
							setJobs((list) => list.map((item) => (item.id === job.id ? { ...item, ...job } : item)));
							if (job.status === "queued" || job.status === "running") {
								// 宿主那边有 300s 超时兜着，正常不会走到这里；走到就是它没消息了
								if (Date.now() - startedAt > STALE_MS) {
									timers.current.delete(jobId);
									setJobs((list) => list.map((item) => (item.id === jobId ? { ...item, stale: true } : item)));
									setGenerating(false);
									return;
								}
								timers.current.set(jobId, window.setTimeout(tick, delay));
								delay = Math.min(4000, delay * 1.25);
								return;
							}
							timers.current.delete(jobId);
							setGenerating(false);
							setPending((value) => Math.max(0, value - 1));
							if (job.status === "succeeded") {
								toast(t("chat.saved"));
								void reload();
							} else if (job.status === "failed" || job.status === "interrupted") {
								toast(job.error || t("common.failed"), "err");
							}
						} catch (error) {
							timers.current.delete(jobId);
							setGenerating(false);
							setJobs((list) => list.map((item) => (item.id === jobId ? { ...item, stale: true } : item)));
							toast(String(error?.message ?? error), "err");
						}
					};
					timers.current.set(jobId, window.setTimeout(tick, delay));
				},
				[reload, toast]
			);
			// reload() 里要用 watchJob（刷新后接着轮询还挂着的任务），而 watchJob 又依赖 reload ——
			// 用 ref 打破这个环，比把两个回调绞在一起清楚。
			const watchRef = useRef(null);
			watchRef.current = watchJob;

			useEffect(
				() => () => {
					for (const timer of timers.current.values()) window.clearTimeout(timer);
					timers.current.clear();
				},
				[]
			);

			const saveConfig = useCallback(
				async (patch) => {
					// 先乐观落到本地：宿主老版本还没有 defaultEndpoint 这个字段（重启后才吃到），
					// 它回的那份 config 里没有这一项 —— 直接 setConfig(payload.config) 会把用户刚选的
					// 值冲回默认，看起来就是「协议选不动」。
					const owner = conversationIdRef.current;
					if (Object.hasOwn(patch, "defaultEndpoint") && jsonOverrideRef.current) {
						const {endpoint, size, aspect_ratio, aspectRatio, seconds, n, quality, ...remaining} = jsonOverrideRef.current;
						jsonOverrideRef.current = remaining;
					}
					const selected = pickConfigFields(patch);
					if (owner && Object.keys(selected).length) {
						writeConvSetting(owner, { ...initialConfigRef.current, ...readConvSettings()[owner], ...selected });
					}
					setConfig((previous) => ({ ...previous, ...patch }));
					try {
						const payload = await call("/config", { method: "POST", body: patch });
						if (owner !== conversationIdRef.current) return payload.config;
						setConfig((previous) => ({
							...previous,
							...payload.config,
							...readConvSettings()[owner],
							// 宿主没回这个字段就保留本地的选择（老宿主 / 请求被吞）
							defaultEndpoint: readConvSettings()[owner]?.defaultEndpoint || payload.config?.defaultEndpoint || previous.defaultEndpoint || "auto"
						}));
						return payload.config;
					} catch (error) {
						toast(String(error?.message ?? error), "err");
						return null;
					}
				},
				[toast]
			);

			// 点击时固定本次请求；只串行提交，不等待上游完成出图。
			const sendChainRef = useRef(Promise.resolve());
			const pendingSendsRef = useRef(0);
			const sendSeqRef = useRef(0);
			const runGenerateFlow = async (requestBody, override, seq, inputText) => {
				const isCurrent = () => requestBody.conversationId === conversationIdRef.current;
				const pendingId = `pending_${seq}`;
				if (discardedConvs.current.has(requestBody.conversationId)) return;
				try {
					/* 发送前把「还没有本站 URL」的参考图补一份留档：从图库 / 重绘 / 预设挂进来的
					   chip 不走 /upload，没有 URL 的话 referenceUrls 会少一张 —— 发出去变成单图，
					   缩略图 / 重试 / 编辑也会丢图。补传失败就退回纯字节（images[]）继续发。 */
					const readyRefs = [];
					for (const item of references) {
						let entry = item;
						if (!item.url && typeof item.dataUrl === "string" && item.dataUrl.startsWith("data:")) {
							const url = await uploadRefData(item.name, item.dataUrl);
							entry = { ...item, url };
							if (url && isCurrent()) setReferences((current) => current.map((ref) => (ref.dataUrl === item.dataUrl && !ref.url ? { ...ref, url } : ref)));
						}
						readyRefs.push(entry);
					}
					const urls = readyRefs.map((ref) => ref.url).filter(Boolean);
					const finalBody = { ...requestBody,
						referenceUrls: Object.hasOwn(override, "referenceUrls") ? requestBody.referenceUrls : urls,
						referenceUrl: Object.hasOwn(override, "referenceUrl") ? requestBody.referenceUrl : urls[0] || ""
					};
					if (discardedConvs.current.has(requestBody.conversationId)) return;
					const payload = await call("/generate", { method: "POST", body: finalBody });
					if (!payload?.job?.id) throw new Error(t("chat.noReceipt"));
					const job = { ...payload.job, images: [], clientSeq: seq };
					awaitingJobs.current.delete(seq);
					if (isCurrent()) {
						setJobs((list) => [job, ...list.filter((item) => item.id !== job.id && item.id !== pendingId)]);
						setPending(payload.queue ?? 1);
					}
					// 对话标题可能刚被这段提示词命名（宿主会改），刷新一下会话列表
					void call("/conversations")
						.then((list) => setConversations(list.items || []))
						.catch(() => {});
					if (isCurrent()) watchJob(job.id);
				} catch (error) {
					// 网络中断不等于宿主没有接单。保留原文，让用户先查记录，不自动重发或覆盖新草稿。
					if (!discardedConvs.current.has(requestBody.conversationId)) {
						const entry = { owner:requestBody.conversationId, seq, text:inputText, error:String(error?.message ?? error) };
						setUnsent((list) => [...list.slice(-11), entry]);
					}
				}
			};

			/** 发送队列：串行提交独立的生成请求。 */
			const queueWarnRef = useRef(0);
			const enqueueSend = (rawPrompt) => {
				if (String(rawPrompt || "").trim().length === 0) return null;
				if (pendingSendsRef.current >= 6) {
					// 连点保护：同一句话被连点时不刷屏，3 秒内只提示一次
					if (Date.now() - queueWarnRef.current > 3000) {
						queueWarnRef.current = Date.now();
						toast(t("chat.queueFull"), "err");
					}
					return null;
				}
				// JSON 修改只属于当前会话的下一次入队，不读取队列等待期间的新设置。
				const override = jsonOverrideRef.current || {};
				const effectiveEndpoint = imageRequestProtocol(override.endpoint || config.defaultEndpoint, override.providerId || providerIdForModel(providers, config, override.model || config.defaultModel), providers);
				if (effectiveEndpoint === GEMINI_NATIVE && !geminiReady(protocols)) { toast(t("chat.geminiReload"), "err"); return null; }
				const base = buildRequestPreview(rawPrompt);
				let body;
				try { body = normalizeGenerationBody({ ...base, ...override }, sizeRaw, isVideoEndpoint ? config.videoSize : config.defaultSize, isVideoEndpoint); }
				catch (error) { toast(error.message, "err"); return null; }
				const known = providers.some((provider) => provider.models?.includes(body.model));
				if (!known || ["chat", "audio", "embedding", "rerank"].includes(modelKindOf(body.model, providers))) {
					toast(t("chat.modelInvalid"), "err");
					return null;
				}
				jsonOverrideRef.current = null;
				// 入队即清空输入框：连点不会重复发送同一句（prompt 已经捕获进队列）
				setDraft("");
				const seq = ++sendSeqRef.current;
				const placeholder = {
					id: `pending_${seq}`, kind: "pending", status: "queued", prompt: rawPrompt, userText: rawPrompt,
					images: [], referenceUrls: body.referenceUrls, conversationId: body.conversationId,
					clientSeq: seq, createdAt: new Date().toISOString()
				};
				awaitingJobs.current.set(seq, placeholder);
				setJobs((list) => [placeholder, ...list]);
				pendingSendsRef.current += 1;
				setGenerating(true);
				const runSend = () => runGenerateFlow(body, override, seq, rawPrompt);
				const run = sendChainRef.current.then(runSend, runSend);
				sendChainRef.current = run.catch(() => {});
				return run.finally(() => {
					awaitingJobs.current.delete(seq);
					pendingSendsRef.current = Math.max(0, pendingSendsRef.current - 1);
					setJobs((list) => list.filter((item) => item.id !== `pending_${seq}`));
					if (pendingSendsRef.current === 0) setGenerating(false);
				});
			};

			const addAssetReference = async (asset, goToChat) => {
				const epoch = inputEpoch.current;
				try {
					if (refsNow.current.length >= 4) { toast(t("chat.refLimit"), "err"); return false; }
					const dataUrl = String(asset.url).startsWith("data:image/") ? asset.url : await urlToDataUrl(new URL(asset.url, window.location.origin).toString());
					if (epoch !== inputEpoch.current) return false;
					if (!dataUrl) throw new Error(t("viewer.missing"));
					const name = asset.name || "image.png";
					if (!await actions.attachReference({ name, dataUrl })) return false;
					if (epoch !== inputEpoch.current) return false;
					setEditMode(true);
					if (goToChat) setView("chat");
					toast(t("chat.reuse"));
					return true;
				} catch (error) { toast(String(error?.message ?? error), "err"); return false; }
			};
			const actions = {
				dismissUnsent: (seq) => setUnsent((list) => list.filter((entry) => entry.seq !== seq)),
				recoverUnsent: (entry) => {
					if (entry.owner !== conversationIdRef.current) return;
					if (draftNow.current.trim() && draftNow.current !== entry.text && !window.confirm(t("chat.replaceForRecovery"))) return;
					setDraft(entry.text); actions.dismissUnsent(entry.seq);
					rootRef.current?.querySelector(".vig-composer textarea")?.focus();
				},
				setGeminiOptions: patch => {
					const owner = conversationIdRef.current;
					if (owner) writeConvSetting(owner, {...initialConfigRef.current, ...readConvSettings()[owner], ...patch});
					setConfig(current => ({...current, ...patch}));
				},
				resetJsonBody: () => { jsonOverrideRef.current = null; jsonBaseRef.current = buildRequestPreview(draft); setJsonDraft(JSON.stringify(jsonBaseRef.current, null, 2)); toast(t("chat.jsonReset")); },
				openJsonBody: () => openJsonPreview(),
				applyJsonBody: () => applyJsonDraft(),
				toast,
				reload,
				setView,
				setDraft,
				setPickOpen,
				saveConfig,
				reloadLibrary: async () => {
					const payload = await call("/library?limit=200");
					replaceLibrary(payload);
				},
				loadMoreLibrary: async () => {
					if (morePending.current || library.length >= libraryTotal) return;
					morePending.current = true;
					setLibraryLoadingMore(true);
					const revision = libraryRevision.current;
					try {
						const payload = await call(`/library?limit=200&offset=${library.length}`);
						if (revision !== libraryRevision.current) return;
						const known = new Set(library.map((asset) => asset.id));
						const extra = (payload.items || []).filter((asset) => !known.has(asset.id));
						replaceLibrary({ items: [...library, ...extra], total: payload.total });
					} catch (error) { toast(String(error?.message ?? error), "err"); }
					finally { morePending.current = false; setLibraryLoadingMore(false); }
				},
				/* ---- 对话（会话）：新建不带记忆，每个会话的历史互相隔离 ---- */
				switchConversation: async (id) => {
					if (!id || id === conversationIdRef.current) return;
					activateConversation(id);
					setJobs(withAwaiting(id, []));
					setPending(0);
					try {
						const payload = await call(`/jobs?limit=40&conversationId=${encodeURIComponent(id)}`);
						if (conversationIdRef.current !== id) return;
						setJobs(withAwaiting(id, payload.items || []));
						for (const job of payload.items || []) if (["queued", "running"].includes(job.status)) watchJob(job.id);
						setPending(payload.pending || 0);
					} catch (error) {
						toast(String(error?.message ?? error), "err");
					}
				},
				newConversation: async () => {
					if (newConvPending.current) return;
					newConvPending.current = true;
					const owner = conversationIdRef.current;
					try {
						const payload = await call("/conversations", { method: "POST", body: {} });
						setConversations(payload.items || []);
						if (owner !== conversationIdRef.current || !payload.item?.id) return;
						activateConversation(payload.item.id);
						setJobs([]);
						setPending(0);
						toast(t("chat.newConvHint"));
					} catch (error) {
						const message = String(error?.message ?? error);
						toast(message.includes("未知端点") ? t("prov.storageNeedRestart") : message, "err");
					} finally { newConvPending.current = false; }
				},
				renameConversation: async (id, title) => {
					try {
						const payload = await call("/conversations/rename", { method: "POST", body: { id, title } });
						setConversations(payload.items || []);
					} catch (error) {
						toast(String(error?.message ?? error), "err");
					}
				},
				deleteConversation: async () => {
					const id = conversationId;
					if (!id) return;
					if (!window.confirm(t("chat.confirmDeleteConv"))) return;
					try {
						const payload = await call("/conversations/delete", { method: "POST", body: { id } });
						const items = payload.items || [];
						setConversations(items);
						const next = items[0]?.id || "";
						savedComposers.current.delete(id);
						persistComposer(id, "", [], false);
						discardedConvs.current.add(id);
						setUnsent((list) => list.filter((entry) => entry.owner !== id));
						if (conversationIdRef.current !== id) return;
						activateConversation(next, true); setJobs([]); setPending(0);
						const jobsPayload = next ? await call(`/jobs?limit=40&conversationId=${encodeURIComponent(next)}`) : { items: [], pending: 0 };
						if (conversationIdRef.current !== next) return;
						setJobs(withAwaiting(next, jobsPayload.items || []));
						setPending(jobsPayload.pending || 0);
						toast(t("chat.deletedConv"));
					} catch (error) {
						const message = String(error?.message ?? error);
						toast(message.includes("未知端点") ? t("prov.storageNeedRestart") : message, "err");
					}
				},
				generate: async () => {
					const rawPrompt = draft.trim();
					if (rawPrompt.length === 0) return;
					return enqueueSend(rawPrompt);
				},
				/** 局部改图：框选/画笔产出的 mask（白=重画）+ 一句指令 → 图生图局部重画。 */
				maskEdit: async ({ imageDataUrl, maskDataUrl, prompt, referenceUrl }) => {
					const clean = String(prompt || "").trim();
					if (!clean) {
						toast(t("lib.maskEmpty"), "err");
						return { ok: false };
					}
					try {
						/* 引用来源要留档：气泡下面那张缩略图、以及「编辑/重试」找回原图都靠它。
						   图库里的图本来就是本站 URL；其它来源就地补一份 upload。 */
						let refUrl = /^\/api\/velapi-image-go\/(upload|asset)\/[A-Za-z0-9._-]+$/.test(String(referenceUrl || "")) ? String(referenceUrl) : "";
						if (!refUrl && typeof imageDataUrl === "string" && imageDataUrl.startsWith("data:")) {
							refUrl = await uploadRefData(`局部改图-${Date.now()}.png`, imageDataUrl);
						}
						const payload = await call("/generate", {
							method: "POST",
							body: {
								prompt: clean,
								userText: clean,
								conversationId,
								model: config.defaultModel,
								providerId: providerIdForModel(providers, config),
								...generationSize({ size: config.defaultSize }, sizeRaw, config.defaultSize),
								quality: config.defaultQuality,
								n: 1,
								endpoint: "images_edits",
								mode: "edit",
								images: [imageDataUrl],
								mask: maskDataUrl,
								referenceUrl: refUrl,
								referenceUrls: refUrl ? [refUrl] : [],
								source: "ui"
							}
						});
						const next = { ...payload.job, images: [] };
						const showJob = conversationId === conversationIdRef.current;
						if (showJob) {
							setJobs((list) => [next, ...list.filter((item) => item.id !== next.id)]);
							setPending(payload.queue ?? 1);
							watchJob(next.id);
						}
						toast(t("lib.maskQueued"));
						return { ok: true, jobId: next.id, showJob };
					} catch (error) {
						toast(String(error?.message ?? error), "err");
						return { ok: false };
					}
				},
				/** 用失败任务的原参数再发一次（上游偶发抖动时最常见的一步）。 */
				retryJob: async (job) => {
					const prompt = String(job?.prompt ?? "").trim();
					const owner = job?.conversationId || conversationId;
					if (!prompt || owner !== conversationIdRef.current || retryLocks.current.has(job.id)) return;
					retryLocks.current.add(job.id);
					setGenerating(true);
					try {
						/* 重试也要过模型隔离：老任务若记的是对话模型（修隔离之前误发的），
						   用当前生图模型重试，否则会把 grok-4.7 再打到 /images/generations。 */
						const retryModel = modelKindOf(job.model, providers) === "chat" ? config.defaultModel : job.model || config.defaultModel;
						const retryEndpoint = imageRequestProtocol(job.protocol || config.defaultEndpoint, job.providerId || providerIdForModel(providers, config, retryModel), providers);
						const nativeRetry = retryEndpoint === GEMINI_NATIVE;
						if (nativeRetry && !geminiReady(protocols)) throw Error(t("chat.geminiReload"));
						const providerId = nativeRetry && job.providerId ? job.providerId : providerIdForModel(providers, config, retryModel) || job.providerId || config.activeProviderId;
						const payload = await call("/generate", {
							method: "POST",
							body: {
								prompt, model:retryModel, providerId,
								...(nativeRetry ? geminiBody({model:retryModel, size:job.size || "1K", aspect_ratio:job.aspectRatio, n:1}) : {
									size: job.size || config.defaultSize, ...(job.aspectRatio ? {aspect_ratio:job.aspectRatio} : {}),
									...(job.seconds ? {seconds:job.seconds} : {}), quality: job.quality || config.defaultQuality, n: job.count || config.defaultCount
								}),
								endpoint: retryEndpoint,
								referenceUrl: job.referenceUrl || "",
								referenceUrls: Array.isArray(job.referenceUrls) && job.referenceUrls.length > 0 ? job.referenceUrls : job.referenceUrl ? [job.referenceUrl] : [],
								mode: job.mode === "edit" ? "edit" : "generate",
								// 重试留在原会话里（不把新任务丢到别的对话）
								conversationId: job.conversationId || conversationId,
								source: "ui"
							}
						});
						if (owner !== conversationIdRef.current) return;
						const next = { ...payload.job, images: [] };
						setJobs((list) => [next, ...list.filter((item) => item.id !== next.id)]);
						setPending(payload.queue ?? 1);
						watchJob(next.id);
					} catch (error) {
						if (owner === conversationIdRef.current) toast(String(error?.message ?? error), "err");
					} finally { retryLocks.current.delete(job.id); if (!retryLocks.current.size && !pendingSendsRef.current) setGenerating(false); }
				},
				/** 删掉一条对话记录（图库里的素材不动）。 */
				deleteJob: async (job) => {
					const id = String(job?.id || "");
					if (!id) return;
					if (!window.confirm(t("chat.confirmDelete"))) return;
					try {
						await call("/job/delete", { method: "POST", body: { ids: [id] } });
						setJobs((list) => list.filter((item) => item.id !== id));
						toast(t("chat.deleted"));
					} catch (error) {
						const message = String(error?.message ?? error);
						toast(message.includes("未知端点") ? t("prov.storageNeedRestart") : message, "err");
					}
				},
				/** 把这条任务的原话填回输入框（连带参考图，多张全回），改完再发一次。 */
				editJob: (job) => {
					const prompt = String(job?.userText || job?.prompt || "").slice(0, 500);
					if (!prompt) return false;
					const urls = (Array.isArray(job?.referenceUrls) && job.referenceUrls.length > 0 ? job.referenceUrls : job?.referenceUrl ? [job.referenceUrl] : []).slice(0, 4);
					const attached = refsNow.current;
					const different = draft !== prompt || attached.length !== urls.length || attached.some((ref, i) => ref.url !== urls[i]);
					const hasOverrides = Object.keys(jsonOverrideRef.current || {}).length > 0;
					if ((hasOverrides || (different && (draft.length || attached.length))) && !window.confirm(t("chat.replaceDraft"))) return false;
					jsonOverrideRef.current = null;
					setDraft(prompt);
					const epoch = ++inputEpoch.current;
					setReferences([]);
					setEditMode(false);
					if (urls.length > 0) {
						// 参考图只存了本站 URL：dataUrl 先放 URL 让缩略图能显示；
						// 真正发送时宿主会按 referenceUrls 把字节读回来。
						setReferences(urls.map((url) => ({ name: "reference", dataUrl: url, url })));
						setEditMode(job.mode === "edit");
						// 顺手把真字节补回来：缩略图不再挂 ✗，直接重发时也能带得动图
						urls.forEach((url) => {
							urlToDataUrl(url)
								.then((dataUrl) => {
									if (dataUrl && epoch === inputEpoch.current) setReferences((current) => current.map((item) => (item.url === url ? { ...item, dataUrl } : item)));
								})
								.catch(() => {});
						});
					}
					setView("chat");
					toast(t("chat.edited"));
					return true;
				},
				attachReference: async ({ name, dataUrl }) => {
					const entry = { name, dataUrl, url: "" };
					if (!dataUrl || !appendReference(entry)) return false;
					const owner = conversationIdRef.current, epoch = inputEpoch.current;
					setEditMode(false);
					const url = await uploadRefData(name, dataUrl);
					// 路径只补给最初的 chip。切到 B 之后 A 的上传也能留档；被删除的 chip 不复活。
					if (url) {
						const link = (refs) => refs.map((item) => item === entry ? { ...item, url } : item);
						if (conversationIdRef.current === owner && refsNow.current.includes(entry)) setReferences(link);
						else {
							const parked = savedComposers.current.get(owner);
							if (parked?.refs.includes(entry)) {
								parked.refs = link(parked.refs);
								persistComposer(owner, parked.text, parked.refs, parked.edit);
							}
						}
					}
					return epoch === inputEpoch.current;
				},
				clearReference: () => {
					++inputEpoch.current;
					setReferences([]);
					setEditMode(false);
				},
				removeReference: (index) => {
					setReferences((current) => current.filter((_, position) => position !== index));
				},
				useAsReference: (asset) => addAssetReference(asset, true),
				switchToEdit: (image) => addAssetReference(image, false),
				/** 保存到本地：宿主把图库原图复制进「保存目录」，回一条可点的路径。 */
				exportAsset: async (image) => {
					const name = assetFileName(image);
					if (!name) {
						toast(t("common.failed"), "err");
						return;
					}
					try {
						const payload = await call("/asset/export", { method: "POST", body: { files: [name] } });
						const saved = payload?.items?.[0]?.path || payload?.dir || "";
						toast(t("common.savedTo", { path: saved }));
					} catch (error) {
						const message = String(error?.message ?? error);
						toast(message.includes("未知端点") ? t("prov.storageNeedRestart") : message, "err");
					}
				},
				/**
				 * 复制图片：**宿主剪贴板优先**（Electron clipboard 或 Windows PowerShell SetImage，
				 * 写进去的是真图片位图，剪贴板管理器 / PPT 里看到的就是图）；网页剪贴板在
				 * dsh-app:// 下常常只写进文本或直接失败，只当旧宿主兜底。
				 */
				copyImage: async (image) => {
					const name = assetFileName(image);
					if (name && HOST_CAPS?.clipboard === true) {
						try {
							await call("/clipboard/image", { method: "POST", body: { file: name } });
							toast(t("common.imageCopied"));
							return;
						} catch {
							/* 宿主这条路走不通：退到网页剪贴板 */
						}
					}
					try {
						if (await copyImageToClipboard(image)) {
							toast(t("common.imageCopied"));
							return;
						}
					} catch {
						/* 网页剪贴板不认：最后再试一次宿主端点 */
					}
					if (!name) {
						toast(t("common.failed"), "err");
						return;
					}
					try {
						await call("/clipboard/image", { method: "POST", body: { file: name } });
						toast(t("common.imageCopied"));
					} catch (error) {
						const message = String(error?.message ?? error);
						toast(message.includes("未知端点") ? t("prov.storageNeedRestart") : message, "err");
					}
				},
				/** 下载图片文件到「下载」文件夹：纯前端，旧宿主也能用；拿到文件即可拖进 PPT。 */
				downloadAsset: async (image) => {
					try {
						await downloadImageFile(image);
						toast(t("chat.downloading"));
					} catch (error) {
						toast(String(error?.message ?? error), "err");
					}
				},
				/* ---- 图片查看器 ---- */
				openGrid: (image, displayed) => {
					const model = config.defaultModel;
					const known = providers.some((provider) => provider.enabled !== false && provider.models?.includes(model));
					const kind = modelKindOf(model, providers);
					setGridTarget({image, displayed, config:{defaultModel:model, defaultQuality:config.defaultQuality, defaultSize:config.defaultSize},
						conversationId, sizeRaw, providerId:providerIdForModel(providers,config,model), canGenerate:known && (!kind || kind === "image")});
				},
				openViewer: (items, index = 0, source = "chat") => setViewer({ items: Array.isArray(items) ? items : [], index, source }),
				closeViewer: () => setViewer(null),
				setViewerIndex: (index) => setViewer((current) => (current ? { ...current, index } : current)),
				/** 查看器「四点变形」：四个角拖到哪（可出图外），应用后上传成新库图并打开它。 */
				viewerQuadApply: async ({ name, data }) => {
					const payload = await call("/upload", { method: "POST", body: { name, data } });
					const url = payload?.item?.url || "";
					await actions.reloadLibrary();
					setViewer({ items: [{ name: payload?.item?.name || name, url, width: payload?.item?.width || 0, height: payload?.item?.height || 0, prompt: "" }], index: 0, source: "library" });
					toast(t("viewer.quadDone"));
					return url;
				},
				/** 查看器「用作参考图」：拿回字节挂成参考图，回对话生图。 */
				viewerUseReference: async (image) => {
					if (await addAssetReference(image, true)) setViewer(null);
				},
				/** 交接意图后立即导航；由 PsView 而不是旧查看器负责取消读图。 */
				viewerEdit: (image) => {
					if (!image?.url) return;
					setPsImage({name:image.name || "image.png", url:image.url});
					setViewer(null); setView("ps");
				},
				clearPsImage: request => setPsImage(current => current === request ? null : current),
				viewerDelete: async (image) => {
					const id = libraryIdFor(image);
					if (viewer?.source !== "library" || !id || deletingAssetIds.current.has(id)) return;
					if (!window.confirm(`${t("lib.delete")} ${image.name || ""}?`)) return;
					if (await actions.deleteAssets([id])) {
						setViewer((open) => {
							if (!open || open.items !== viewer.items) return open;
							const shown = open.items[open.index];
							if (libraryIdFor(shown) === id) return null;
							const items = open.items.filter((item) => libraryIdFor(item) !== id);
							return { ...open, items, index: Math.max(0, items.indexOf(shown)) };
						});
						toast(t("common.ok"));
					}
				},
				/** 快捷拖拽落进输入区：先把 URL 读成字节，再走和粘贴/上传同一条路。 */
				attachImageUrl: async (image) => {
					try {
						const dataUrl = await urlToDataUrl(new URL(image.url, window.location.origin).toString());
						if (await actions.attachReference({ name: image.name || "image.png", dataUrl })) toast(t("chat.pasted"));
					} catch (error) {
						toast(String(error?.message ?? error), "err");
					}
				},
				pickFile: () => fileRef.current?.click(),
				/** 预设卡：上传参考图（先落宿主 uploads，再当普通路径用）。 */
				uploadPresetImage: async (file) => {
					if (!file) return "";
					try {
						const dataUrl = await fileToDataUrl(file);
						const payload = await call("/upload", { method: "POST", body: { name: file.name, data: dataUrl } });
						return payload.item?.url || dataUrl;
					} catch (error) {
						toast(String(error?.message ?? error), "err");
						return "";
					}
				},
				savePreset: async (card) => {
					try {
						const payload = await call("/presets", { method: "POST", body: card });
						setPresets(payload.items || []);
						toast(t("common.ok"));
						return true;
					} catch (error) {
						toast(String(error?.message ?? error), "err");
						return false;
					}
				},
				deletePreset: async (id) => {
					try {
						const payload = await call("/presets/delete", { method: "POST", body: { id } });
						setPresets(payload.items || []);
					} catch (error) {
						toast(String(error?.message ?? error), "err");
					}
				},
				resetPresets: async () => {
					try {
						const payload = await call("/presets/reset", { method: "POST", body: {} });
						setPresets(payload.items || []);
						toast(t("common.ok"));
					} catch (error) {
						toast(String(error?.message ?? error), "err");
					}
				},
				/** 点一张预设卡：提示词进输入框，参考图挂上，回到对话生图。 */
				applyPreset: async (preset) => {
					const epoch = inputEpoch.current;
					if (preset?.image && !await addAssetReference({url:preset.image, name:preset.title}, false)) return false;
					if (epoch !== inputEpoch.current) return false;
					const prompt = String(preset?.prompt || "").trim();
					if (prompt) setDraft((value) => (value.trim() ? `${value.trimEnd()}\n${prompt}` : prompt).slice(0, 500));
					setView("chat"); toast(t("preset.used", { title: preset?.title || "" })); return true;
				},
				insertNote: (note) => {
					const parts = [note.prompt, note.meta].filter(Boolean).join("\n");
					setDraft((value) => `${value}${value.length === 0 ? "" : "\n"}${parts}`.slice(0, 500));
					setView("chat");
				},
				saveNote: async (note) => {
					try {
						const payload = await call("/notes", { method: "POST", body: note });
						setNotes(payload.items || []);
						toast(t("common.ok"));
						return true;
					} catch (error) {
						toast(String(error?.message ?? error), "err");
						return false;
					}
				},
				deleteNote: async (id) => {
					try {
						const payload = await call("/notes/delete", { method: "POST", body: { id } });
						setNotes(payload.items || []);
					} catch (error) {
						toast(String(error?.message ?? error), "err");
					}
				},
				renameAsset: async (id, name) => {
					try {
						const { item } = await call("/library/rename", { method: "POST", body: { id, name } });
						++libraryRevision.current;
						setLibrary((rows) => rows.map((asset) => asset.id === id ? { ...asset, ...item, name: item?.name || name } : asset));
					} catch (error) {
						toast(String(error?.message ?? error), "err");
					}
				},
				deleteAssets: async (ids) => {
					const targets = [...new Set(ids)].filter((id) => library.some((asset) => asset.id === id));
					if (!targets.length || targets.some((id) => deletingAssetIds.current.has(id))) return false;
					targets.forEach((id) => deletingAssetIds.current.add(id));
					try {
						await call("/library/delete", { method: "POST", body: { ids: targets } });
						++libraryRevision.current;
						setLibrary((list) => list.filter((item) => !targets.includes(item.id)));
						setLibraryTotal((total) => Math.max(0, total - targets.length));
						return true;
					} catch (error) {
						toast(String(error?.message ?? error), "err");
						return false;
					} finally { targets.forEach((id) => deletingAssetIds.current.delete(id)); }
				},
				saveProvider: async (provider) => {
					try {
						const payload = await call("/providers", { method: "POST", body: provider });
						if (!payload?.ok) throw new Error(payload?.error || t("common.failed"));
						setProviders(payload.items || []);
						toast(t("common.ok"));
						return true;
					} catch (error) {
						toast(String(error?.message ?? error), "err");
						return false;
					}
				},
				deleteProvider: async (id) => {
					try {
						const payload = await call("/providers/delete", { method: "POST", body: { id } });
						setProviders(payload.items || []);
					} catch (error) {
						toast(String(error?.message ?? error), "err");
					}
				},
				testProvider: async ({ scope, id, baseUrl, apiKey, useRuntimeKey }) => {
					let payload;
					try {
						payload = await call("/providers/test", { method: "POST", body: { scope, id, baseUrl, apiKey, useRuntimeKey } });
					} catch (error) {
						payload = { ok: false, error: String(error?.message ?? error) };
					}
					if (scope === "runtime") {
						if (payload.ok) toast(`${t("common.ok")} · ${payload.models.length} models · ${payload.elapsedMs}ms`);
						else toast(payload.hint || payload.error || t("common.failed"), "err");
					}
					return payload;
				},
				refreshModels: async (providerId) => {
					try {
						const payload = await call("/models/refresh", { method: "POST", body: { providerId } });
						toast(`${t("common.ok")} · ${payload.items.length}`);
						const list = await call("/providers");
						setProviders(list.items || []);
					} catch (error) {
						toast(String(error?.message ?? error), "err");
					}
				},
				setActiveProvider: async (id) => {
					await saveConfig({ activeProviderId: id });
				},
				/* ---- 素材目录：默认在本地，可改；换目录由宿主把现有素材复制过去 ---- */
				saveStateDir: dir => storageMoveLock.run(async () => {
					try {
						const payload = await call("/config", { method: "POST", body: { stateDir: dir, cleanupSource: true } });
						if (!payload?.moved) throw new Error(t("prov.storageUnconfirmed"));
						const { moved } = payload, actual = payload.stateDir || moved.stateDir || payload.config?.stateDir || dir;
						setConfig(previous => ({...previous, stateDir:actual}));
						let message = t("prov.storageSaved", {dir:actual});
						if (moved.changed) {
							message += ` · ${t("prov.storageMoved", {files:moved.copied?.files ?? 0, indexes:moved.copied?.indexes ?? 0})}`;
							const cleanup = moved.cleanup;
							message += ` · ${Number.isInteger(cleanup?.removed) ? t("prov.storageCleaned", cleanup) : t("prov.storageCleanupUnknown")}`;
							if (cleanup?.retained > 0) message += ` · ${t("prov.storageRetained", cleanup)}`;
							try { await actions.reloadLibrary(); }
							catch { message += ` · ${t("prov.storageRefreshFailed")}`; }
						}
						toast(message); return {ok:true, message};
					} catch (error) {
						const message = String(error?.message ?? error);
						toast(message, "err"); return {ok:false, message};
					}
				}),
				revealDir: async () => {
					try {
						const payload = await call("/state/reveal", { method: "POST", body: {} });
						toast(payload.dir || t("common.ok"));
					} catch (error) {
						toast(String(error?.message ?? error), "err");
					}
				}
			};

			/* 模型与供应商对齐：模型属于哪条供应商链就切到哪条。
			   历史配置可能是错配的（模型属于 grok、activeProvider 却停在 GPT），请求发到别家会 404「模型不存在」。 */
			useEffect(() => {
				if (!providers.length || !config.defaultModel) return;
				const ownerId = providerIdForModel(providers, config, config.defaultModel);
				if (ownerId && ownerId !== config.activeProviderId) void actions.saveConfig({ activeProviderId: ownerId });
			}, [config.defaultModel, config.activeProviderId, providers]); // eslint-disable-line react-hooks/exhaustive-deps

			/* 协议隔离：生图工作台的协议只该是「自动检测 / 图片生成 / 图片编辑 / 视频生成」。
			   如果配置停在「OpenAI 对话 / Responses / Anthropic / Gemini / 重排 / 向量」这类聊天协议上
			   （生图请求会被打到 /chat/completions，注定画不出图），自动纠正成图片生成。 */
			useEffect(() => {
				if (!protocols.length || config.defaultEndpoint === GEMINI_NATIVE) return;
				const hit = protocols.find((item) => item.id === (config.defaultEndpoint || "auto"));
				if (!hit) return;
				if (["auto", "image", "video"].includes(hit.kind)) return;
				void actions.saveConfig({ defaultEndpoint: "images_generations" });
			}, [config.defaultEndpoint, protocols]); // eslint-disable-line react-hooks/exhaustive-deps

			/* 生图模型自愈：当前模型是对话/音频/向量模型，或不在任何供应商目录里时，
			   上游会 404「模型不存在」—— 直接换成目录里第一个可生图的模型（图片/视频按协议挑）。 */
			useEffect(() => {
				if (!providers.length) return;
				const all = providers.flatMap((provider) => provider.models || []);
				if (all.length === 0) return;
				const contentKind = modelKindOf(config.defaultModel, providers);
				const usable = all.find((id) => {
					const kind = modelKindOf(id, providers);
					if (!kind) return !isVideoEndpoint;
					return isVideoEndpoint ? kind === "video" : kind === "image";
				});
				const known = all.includes(config.defaultModel);
				const wrong = !known || ["chat", "audio", "embedding", "rerank"].includes(contentKind);
				if (!wrong || !usable || usable === config.defaultModel) return;
				toast(t("chat.modelSwitched", { model: usable }), "err");
				void actions.saveConfig({ defaultModel: usable, activeProviderId: providerIdForModel(providers, config, usable) || config.activeProviderId });
			}, [config.defaultModel, providers, isVideoEndpoint]); // eslint-disable-line react-hooks/exhaustive-deps

			/* 模型和协议自动对齐：选了视频模型就切到「视频生成」协议（参数区跟视频走），
			   选了图片模型却停在视频协议时切回图片生成。只在两者真正冲突时写一次配置。 */
			useEffect(() => {
				if (!providers.length || !protocols.length || config.defaultEndpoint === GEMINI_NATIVE) return;
				const modelKind = modelKindOf(config.defaultModel, providers);
				const currentKind = protocols.find((item) => item.id === (config.defaultEndpoint || "auto"))?.kind || "auto";
				if (modelKind === "video" && currentKind !== "video") void actions.saveConfig({ defaultEndpoint: "videos_generations" });
				else if (modelKind === "image" && currentKind === "video") void actions.saveConfig({ defaultEndpoint: "images_generations" });
			}, [config.defaultModel, config.defaultEndpoint, providers, protocols]); // eslint-disable-line react-hooks/exhaustive-deps

			const state = {
				config,
				providers,
				library, libraryTotal, libraryLoadingMore, storageBusy:storageMoveLock.busy,
				notes,
				presets,
				protocols,
				jobs,
				pending,
				unsent: unsent.filter((entry) => entry.owner === conversationId),
				draft,
				references,
				editMode,
				generating,
				pickOpen,
				ready,
				sideOpen,
				conversations,
				conversationId,
				isVideoEndpoint,
				jsonOpen,
				jsonDraft,
				setJsonOpen,
				setJsonDraft,
				sizeRaw,
				toggleJsonSize,
				chatModels
			};
			const navItems = [
				{ id: "chat", icon: "chat", label: t("nav.chat") },
				{ id: "library", icon: "grid", label: t("nav.library") },
				{ id: "notes", icon: "note", label: t("nav.notes") },
				{ id: "ps", icon: "crop", label: t("nav.ps") },
				{ id: "providers", icon: "provider", label: t("nav.providers") }
			];

			const main =
				view === "chat"
					? h(ChatView, { state, actions })
					: view === "library"
						? h(LibraryView, { state, actions })
						: view === "notes"
							? h(NotesView, { state, actions })
							: view === "ps"
								? h(PsView, { state, actions, initialUrl: psImage, onConsumeInitialUrl: actions.clearPsImage })
								: h(ProvidersView, { state, actions });

			return h(FeedbackContext?.Provider || react.Fragment, FeedbackContext ? {value:toasts} : null, h(
				"div",
				{ className: "vig-root", ref: rootRef, "data-compact": wide ? "0" : "1" },
				h("style", null, CSS),
				h(
					"header",
					{ className: "vig-head" },
					h("span", { className: "vig-mark" }, h(Icon, { name: "spark", size: 12 })),
					h("span", { className: "vig-title" }, t("nav.title")),
					// 刊头 kicker：一行小号大写字距的英文副标，给顶部一点杂志刊头的气口
					h("span", { className: "vig-kicker" }, t("nav.kicker")),
					h("div", { className: "vig-spacer" }),
					// 头部不再挂「velapi / 队列」这类状态胶囊：同一个事实在侧栏底部、
					// 工作区头部、检查器里各出现一次，看着就是重复。现在头部只在服务端
					// 不可用时出声，其余状态各自只有一个归属地。
					fatal ? h(Pill, { tone: "warn" }, t("common.service")) : null,
					hostOutdated
						? h(
								"span",
								{ className: "vig-pill is-warn", title: t("common.restartHint"), style: { cursor: "help" } },
								h("i", { className: "vig-dot" }),
								t("common.restartNeed")
							)
						: capsInfo && capsInfo.nativeDrag === false
							? h(
									"span",
									{ className: "vig-pill is-warn", title: t("common.noNativeDragHint"), style: { cursor: "help" } },
									h("i", { className: "vig-dot" }),
									t("common.noNativeDrag")
								)
							: null,
					// 头部只留两个按钮：拉数据、重载界面。
					// 「在右侧栏打开」那种需要用户先找到再点的入口，已经被固定面板取代了
					// （用户原话：我不要手动，我要固定）。
					h("button", { className: "vig-icon-btn", title: t("lib.refresh"), onClick: () => void reload() }, h(Icon, { name: "refresh" })),
					// 桌面端刷新界面的唯一手边入口（Ctrl+R 没绑，F12 也只开控制台）。
					h("button", { className: "vig-icon-btn", title: t("common.reloadShell"), onClick: reloadShell }, h(Icon, { name: "reboot" }))
				),
				h(
					"div",
					{ className: "vig-shell" },
					h(
						"nav",
						{ className: "vig-nav vig-card" },
						navItems.map((item) => {
							const active = view === item.id, chat = item.id === "chat";
							return h(react.Fragment, { key:item.id },
								h("button", {
									type:"button", className:`vig-nav-item${active ? " is-on" : ""}`, "data-page":item.id,
									"aria-current":active ? "page" : undefined, "aria-expanded":chat ? active && conversations.length > 0 : undefined,
									onClick:() => setView(item.id)
								}, h(Icon, { name:item.icon }), item.label),
								chat && active && conversations.length > 0 ? h(ConversationNav, { items:conversations, selected:conversationId, onSelect:actions.switchConversation }) : null);
						}),
						// 更新入口（先设计、后端未接壤）：点一下检查，进度条按需出现
						h(
							"div",
							{ className: "vig-update" },
							h(
								"div",
								{ className: "vig-update-row" },
								h(
									"button",
									{
										className: `vig-update-btn${updateState.phase === "running" ? " is-busy" : ""}`,
										title: `${t("update.check")} · ${buildLabel}`,
										disabled: updateState.phase === "running",
										onClick: () => void checkUpdate()
									},
									h(Icon, { name: "refresh", size: 12 }),
									t("update.title")
								),
								h("span", { className: "vig-update-tag", title:buildLabel }, buildLabel),
								h("div", { className: "vig-spacer" }),

							),
							updateState.phase === "running" || updateState.phase === "done" || updateState.phase === "unwired"
								? h(
										"div",
										{
											className: `vig-update-bar${updateState.phase === "unwired" ? " is-err" : ""}${updateState.phase === "done" ? " is-ok" : ""}`,
											role: "progressbar",
											"aria-valuenow": String(updateState.percent),
											"aria-valuemin": "0",
											"aria-valuemax": "100"
										},
										h("i", { style: { width: `${updateState.percent}%` } })
									)
								: null
						),
						// 竖栏在宽容器里会拉得很高，底部留一大片白会很空 —— 用「有多少东西」
						// 填住。这里只放计数：供应商/模型/密钥各自在工作区头部、输入区、
						// 检查器里已经有一处了，再抄一份就成了重复。
						// 窄容器里导航折成一行段控件，这块就藏起来。
						h(
							"div",
							{ className: "vig-nav-foot" },
							h(
								"div",
								{ className: "vig-nav-foot-row" },
								h("span", { className: "vig-label" }, t("rail.library")),
								h("span", { className: "vig-nav-foot-val" }, String(library.length))
							),
							h(
								"div",
								{ className: "vig-nav-foot-row" },
								h("span", { className: "vig-label" }, t("rail.notes")),
								h("span", { className: "vig-nav-foot-val" }, String(notes.length))
							),
							h(
								"div",
								{ className: "vig-nav-foot-row" },
								h("span", { className: "vig-label" }, t("rail.jobs")),
								h("span", { className: "vig-nav-foot-val" }, String(jobs.length))
							)
						)
					),
					h(
						"div",
						{ className: "vig-col", style: { flex: 1 } },
						fatal
							? h("div", { className: "vig-error", style: { margin: 12 } }, fatal)
							: main
					),
					view === "chat" ? h(Inspector, { state, actions, open: sideOpen, onToggle: () => setSideOpen((value) => !value) }) : null
				),
				h("input", {
					ref: fileRef,
					type: "file",
					accept: "image/*",
					style: { display: "none" },
					onChange: async (event) => {
						const file = event.target.files?.[0];
						event.target.value = "";
						if (!file) return;
						const dataUrl = await fileToDataUrl(file);
						await actions.attachReference({ name: file.name, dataUrl });
					}
				}),
				pickOpen && view === "chat" ? h(ReferencePicker, { library, onDismiss: () => setPickOpen(false), onPick: actions.useAsReference }) : null,
				gridTarget && view === "chat" && gridTarget.conversationId === conversationId ? h(GridEditor, {
					key:`${gridTarget.conversationId}:${gridTarget.image.assetId || gridTarget.image.url}`, target:gridTarget, onClose:()=>setGridTarget(null), onHandoff:watchJob, onJob:(job)=>{
						if (conversationIdRef.current !== gridTarget.conversationId) return;
						setJobs(list=>list.some(item=>item.id===job.id) ? list.map(item=>item.id===job.id ? {...item,...job} : item) : [job,...list]);
						if (job.status === "succeeded") void actions.reloadLibrary().catch(()=>{});
					}
				}) : null,
				// 图片查看器（大图 / 缩放 / 翻页 / 用作参考图 / 丢进图片处理）
				viewer
					? h(ImageViewer, {
							items: viewer.items,
							index: viewer.index,
							onClose: actions.closeViewer,
							onIndex: actions.setViewerIndex,
							onToast: toast,
							onUseReference: actions.viewerUseReference,
							onEdit: actions.viewerEdit,
							onSave: actions.exportAsset,
							onCopy: actions.copyImage,
							onDownload: actions.downloadAsset,
							onQuadApply: actions.viewerQuadApply,
							onDelete: viewer.source === "library" && libraryIdFor(viewer.items[viewer.index]) ? actions.viewerDelete : null
						})
					: null,
				toasts
			));
		}

		/* ------------------------------------------------------------------ *
		 * 席位注册
		 * ------------------------------------------------------------------ */

		/**
		 * 侧栏 tab 的宿主盒子：给可见性判定一个自家节点（原来直接返回 Workbench，
		 * 没有可观测的盒子），并向外广播 mounted/visible。
		 * 判据是几何量（display:none 时 getClientRects 为空 + visibility 计算值），
		 * IntersectionObserver / ResizeObserver 只当「重新量一次」的触发器：
		 * 目标一开始就挂在 display:none 里时，观察者可能一直不投递更新，
		 * 拿它当唯一判据会卡死在「看不见」。再加一秒一次的兜底复量收敛。
		 */
		function PaneHost({ children }) {
			const hostRef = useRef(null);
			useEffect(() => {
				const node = hostRef.current;
				const measured = () => {
					if (!node || node.getClientRects().length === 0 || node.offsetWidth <= 0 || node.offsetHeight <= 0) return false;
					try {
						return window.getComputedStyle(node).visibility !== "hidden";
					} catch {
						return true;
					}
				};
				// 「在屏幕上」：观察者明确说相交 + 几何量也说看得见。
				// 判据故意偏向「没在屏幕上」：拿不准就当看不见，最多多一个入口胶囊；
				// 反过来（拿不准就当看得见）会让停靠层让位，用户一个入口都没有。
				// 观察者的首次投递之前给 800ms 宽限（它跟着渲染帧来，不是同步的），
				// 之后只认它说的话 —— 视口外/被遮挡的宿主，几何量正常但不算数。
				let intersecting = null;
				let observed = false;
				let hasObserver = false;
				const mountedAt = Date.now();
				const onScreen = () => {
					if (!measured()) return false;
					if (!hasObserver) return true; // 没有观察者：只能信几何量
					if (observed) return intersecting === true;
					return Date.now() - mountedAt < 800;
				};
				const broadcast = (mounted, visible, on) => {
					rightbarPaneMounted = mounted;
					rightbarPaneVisible = visible;
					rightbarPaneOnScreen = on;
					window.dispatchEvent(new CustomEvent(PANE_EVENT, { detail: { mounted, visible, onScreen: on } }));
				};
				const decide = () => broadcast(true, measured(), onScreen());
				decide();
				const observers = [];
				if (node && typeof IntersectionObserver === "function") {
					try {
						const io = new IntersectionObserver(
							(entries) => {
								const entry = entries[entries.length - 1];
								observed = true;
								intersecting = Boolean(entry?.isIntersecting) && Number(entry?.intersectionRatio ?? 1) > 0.05;
								decide();
							},
							{ threshold: [0, 0.05, 0.5] }
						);
						io.observe(node);
						observers.push(io);
						hasObserver = true;
					} catch {
						/* 没有就算了，几何量那次判定已经够用 */
					}
				}
				if (node && typeof ResizeObserver === "function") {
					try {
						const ro = new ResizeObserver(() => decide());
						ro.observe(node);
						observers.push(ro);
					} catch {
						/* 同上 */
					}
				}
				const onResize = () => decide();
				window.addEventListener("resize", onResize);
				const timer = setInterval(decide, 1000);
				return () => {
					for (const observer of observers) observer.disconnect();
					window.removeEventListener("resize", onResize);
					clearInterval(timer);
					broadcast(false, false, false);
				};
			}, []);
			return h("div", { className: "vig-pane-host", ref: hostRef }, children);
		}

		/**
		 * 停靠面板该露哪张脸：
		 *   null    —— 侧栏 tab 正显示着，或者面板没打开；
		 *   "dock"  —— 面板本体。
		 * **入口只有一处**：左侧栏那颗「生图工作台」（宿主公开 slot `sidebar.footer.action`）。
		 * 停靠层自己不再额外浮一颗胶囊 —— 同一个入口出现两次就是噪音（用户原话：我就要一个）。
		 * 判据只有一条：**那个 pane 真的在屏幕上**（IntersectionObserver 认过），
		 * 「mounted」完全不等于「看得见」（keepMounted 的 tab 非激活时照样挂着）。
		 * 面板是**常驻**的：没有收起/展开那回事（用户原话：我不要手动，我要固定），
		 * 所以这里只有两个结果 —— 让位（右侧栏正显示着工作台）或者面板本体。
		 * paneOnScreen 没给（老调用方/测试）时退回 mounted && visible。
		 */
		function dockFace({ paneMounted, paneVisible, paneOnScreen }) {
			const onScreen = paneOnScreen === undefined ? Boolean(paneMounted && paneVisible) : paneOnScreen === true;
			return onScreen ? null : "dock";
		}

		/** 停靠面板本体（shell.overlay 落点）。开合与宽度记在 localStorage，重启后保持。 */
		/**
		 * 打开工作台。走的是宿主右侧栏（就是右上角那个展开按钮打开的侧边栏），
		 * 我们的工作台是里面一个 tab —— 不遮住对话区，也不用浮层。
		 * 服务由 `dsh-client-ui-sidebar-right` 提供，名字在 exports.inject 里声明过。
		 */
		let sidebarRight = null;
		function openWorkbench() {
			try {
				if (sidebarRight && typeof sidebarRight.openTab === "function") {
					sidebarRight.openTab(KIND);
					return;
				}
			} catch (error) {
				console.warn("[velapi-image-go] 打开右侧栏 tab 失败", error);
			}
		}

		/**
		 * 公开落点上的入口按钮。只挂一处：`sidebar.footer.action`（左侧栏底部，
		 * 宿主自己的 cordis 面板就挂这儿）—— 空间是宿主分好的，不读别人的 DOM、不看别人的样式。
		 * 只做一件事：把常驻面板滚到眼前。
		 */
		function WorkbenchLauncher() {
			return h(
				"button",
				{ className: "vig-launch", type: "button", title: t("tab.title"), onClick: openWorkbench },
				h(Icon, { name: "spark", size: 15 }),
				h("span", { className: "vig-launch-text" }, t("tab.title"))
			);
		}

		/**
		 * 停靠面板本体（`shell.overlay` 落点）。**常驻**：没有收起/展开，也没有胶囊 ——
		 * 用户要的是「固定」，不是每次去点一个按钮（也就不会出现「找不到展开按键」）。
		 * 宽度可以拖，记在 localStorage；唯一会让位的情况是右侧栏正显示着同一个工作台。
		 */
		function RightDock({ initialPane, initialWidth }) {
			const widthKey = "dsh.velapi-image-go.dock.w";
			const [width, setWidth] = useState(() => {
				if (initialWidth !== undefined) return initialWidth;
				const stored = Number.parseInt(window.localStorage.getItem(widthKey) ?? "", 10);
				return Number.isFinite(stored) && stored >= 320 && stored <= 900 ? stored : 420;
			});
			const [pane, setPane] = useState(() => initialPane || { mounted: rightbarPaneMounted, visible: rightbarPaneVisible, onScreen: rightbarPaneOnScreen });
			useEffect(() => {
				window.localStorage.setItem(widthKey, String(width));
			}, [width]);
			useEffect(() => {
				const sync = (event) =>
					setPane({
						mounted: Boolean(event?.detail?.mounted),
						visible: Boolean(event?.detail?.visible),
						onScreen: event?.detail?.onScreen === undefined ? undefined : Boolean(event.detail.onScreen)
					});
				window.addEventListener(PANE_EVENT, sync);
				// 面板可能比停靠层先挂上（keepMounted 的 tab 一进页面就挂），先对一次账
				setPane({ mounted: rightbarPaneMounted, visible: rightbarPaneVisible, onScreen: rightbarPaneOnScreen });
				return () => window.removeEventListener(PANE_EVENT, sync);
			}, []);
			const face = dockFace({ paneMounted: pane.mounted, paneVisible: pane.visible, paneOnScreen: pane.onScreen });
			if (face === null) return null;
			return h(
				"div",
				{ className: "vig-dock", style: { "--vig-dock-w": `${width}px` } },
				h("span", {
					className: "vig-dock-grip", role: "separator", tabIndex: 0, "aria-orientation": "vertical", "aria-label": t("panel.params"),
					"aria-valuemin": 320, "aria-valuemax": 900, "aria-valuenow": width,
					onKeyDown: (e) => {
						if (!["ArrowLeft", "ArrowRight", "Home", "End"].includes(e.key)) return;
						e.preventDefault(); setWidth((w) => e.key === "Home" ? 320 : e.key === "End" ? 900 : Math.max(320, Math.min(900, w + (e.key === "ArrowLeft" ? 16 : -16))));
					},
					title: t("panel.params"),
					onPointerDown: (event) => {
						event.preventDefault();
						const startX = event.clientX;
						const grip = event.currentTarget;
						psCapturePointer(grip,event.pointerId);
						const startWidth = grip.parentElement.getBoundingClientRect().width;
						const move = (moveEvent) => setWidth(Math.min(900, Math.max(320, startWidth + (startX - moveEvent.clientX))));
						const stop = () => {
							grip.removeEventListener("pointermove", move);
							grip.removeEventListener("pointerup", stop);
							grip.removeEventListener("lostpointercapture", stop);
							grip.removeEventListener("pointercancel", stop);
						};
						grip.addEventListener("pointermove", move);
						grip.addEventListener("pointerup", stop);
						grip.addEventListener("lostpointercapture", stop);
						grip.addEventListener("pointercancel", stop);
					}
				}),
				h("div", { className: "vig-dock-body" }, h(PluginBoundary, null, h(Workbench, { onOpenInRightbar: null })))
			);
		}

		/**
		 * 客户端自检回执：把「我到底登记上了什么」写回宿主半边（落盘在 stateDir/client-report.json）。
		 * 为什么要这个：插件跑在页面里，出问题时既看不到 DOM 也看不到 console —— 之前
		 * 「重启后入口不见了」只能靠猜。现在重启一次就有回执：apply 有没有跑到、哪个席位
		 * 登记成功、开始页那张卡在不在，一眼能看。
		 */
		function reportClient(phase, detail) {
			try {
				if (typeof fetch !== "function") return false;
				const body = JSON.stringify({ phase, at: new Date().toISOString(), detail: detail ?? null });
				void fetch(`${API}/client-report`, {
					method: "POST",
					headers: { "content-type": "application/json" },
					body,
					keepalive: true
				}).catch(() => undefined);
				return true;
			} catch {
				return false;
			}
		}

		/** 依赖面快照：每个服务在不在、席位注册到什么程度。用来判定「是等待依赖还是登记失败」。 */
		function serviceSnapshot(scope) {
			const has = (name) => {
				try {
					return Boolean(scope?.get?.(name));
				} catch {
					return false;
				}
			};
			let guide = null;
			let hasKind = null;
			try {
				const tabs = scope?.sidebarRightTabs ?? scope?.get?.("sidebarRightTabs") ?? null;
				if (tabs) {
					hasKind = typeof tabs.get === "function" ? Boolean(tabs.get(KIND)) : null;
					guide =
						typeof tabs.guide === "function"
							? tabs
									.guide()
									.map((entry) => `${entry.kind}/${entry.id}@${entry.order}`)
									.slice(0, 12)
							: null;
				}
			} catch {
				/* 快照读失败不影响注册 */
			}
			return {
				slots: Boolean(scope?.slots),
				effect: typeof scope?.effect,
				inject: typeof scope?.inject,
				sidebarRightTabs: has("sidebarRightTabs"),
				sidebarRight: has("sidebarRight"),
				settings: has("settings"),
				layout: has("layout"),
				locale: has("locale"),
				sessions: has("sessions"),
				hasKind,
				guide,
				// 席位登记的留痕：probeError 非空 = 那一刻服务还没到（守卫抛的原文），
				// attempts 是它被尝试登记的次数（>1 说明走了「等 inject 到货」那条路）。
				rightbarProbeError,
				rightbarAttempts,
				pane: { mounted: rightbarPaneMounted, visible: rightbarPaneVisible, onScreen: rightbarPaneOnScreen }
			};
		}

		/** 页面侧实况：入口到底有没有出现在 DOM 里（这是「用户看不看得见」的唯一判据）。 */
		function domSnapshot() {
			try {
				const text = (node) => String(node?.textContent ?? "");
				return {
					// 固定入口那颗按钮有没有真的渲染进宿主侧栏（入口是否存在的唯一判据）
					launcher: Boolean(document.querySelector(".vig-launch")),
					dock: Boolean(document.querySelector(".vig-dock")),
					paneHost: Boolean(document.querySelector(".vig-pane-host")),
					workbench: document.querySelectorAll(".vig-root").length,
					overlayHost: document.querySelectorAll("[data-shell-overlay]").length,
					guideHost: document.querySelectorAll("[data-sidebar-right-guide]").length,
					guideMentions: Array.from(document.querySelectorAll("[data-sidebar-right-guide] *"))
						.map(text)
						.filter((value) => value.includes("工作台"))
						.slice(0, 3),
					sidebarTabMentions: Array.from(document.querySelectorAll('[role="tab"], button'))
						.map(text)
						.filter((value) => value.includes("工作台"))
						.slice(0, 3)
				};
			} catch (error) {
				return { error: String(error?.message ?? error) };
			}
		}

		function apply(ctx, config = {}) {
			// 自检回执第一站：apply 跑到了，以及此刻依赖面长什么样。
			reportClient("apply", serviceSnapshot(ctx));
			// 右侧栏控制器：左侧栏那颗按钮点下去就是 openTab(kind) —— 打开右上角那个侧边栏
			try {
				sidebarRight = ctx.sidebarRight ?? null;
			} catch (error) {
				sidebarRight = null;
				console.warn("[velapi-image-go] 拿不到 sidebarRight", error);
			}
			// 词典是可选增强：locale 不是 inject 出来的依赖，拿不到就继续用内置中文。
			try {
				const locale = typeof ctx.get === "function" ? ctx.get("locale") : null;
				if (locale && typeof locale.register === "function") {
					ctx.effect(() => locale.register(NS, { zh, en }), "velapi-image-go: dictionaries");
					const bound = typeof locale.bind === "function" ? locale.bind(NS) : null;
					if (typeof bound === "function") t = bound;
				}
			} catch (error) {
				console.warn("[velapi-image-go] locale unavailable", error);
			}

			// 默认落点：公开 slot 上的两处入口 + 停靠面板 + 设置分区。
			// `rightbar` 是可选项（要等 ui-sidebar-right 的席位，升级时它可能改守卫/改名），
			// 默认不开 —— 入口不押在别人家的内部服务上。
			const surfaces =
				Array.isArray(config?.surfaces) && config.surfaces.length > 0
					? config.surfaces
					: ["rightbar", "settings"];
			const guideOrder = Number.isFinite(config?.guideOrder) ? config.guideOrder : 30;

			/** 产品右侧栏：把工作台作为一个 tab 类型登记，并让调用方能打开它。 */
			const openInRightbar = () => {
				const nav = ctx.get?.("sidebarRight");
				if (nav && typeof nav.openTab === "function") {
					try {
						nav.openTab(KIND, { focus: true });
						return true;
					} catch (error) {
						console.warn("[velapi-image-go] openTab failed", error);
					}
				}
				return false;
			};

			let rightbarReady = false;
			// 落点注册失败不能只在 console 里沉掉：以前界面整个不见了，用户和我
			// 都只能猜。这里攒下来，挂到 window.__velapiImageGo.errors 上，
			// 一行 console 就能看清是哪个席位/哪一步的问题。
			const surfaceErrors = [];

			/**
			 * 把工作台登记成产品右侧栏的一个 tab 类型（顺便挂上「开始」页那张卡）。
			 * 要点（读 ui-sidebar-right 的 SidebarRightTabRegistry 得来）：
			 *  · register 必须给唯一 id —— 面板内容与标题两个席位是按「id」找的，不是按 kind；
			 *  · priority 是档位字符串（extension / builtin / fallback），不是数字；
			 *  · guide[] 才是「开始页那几张卡」的来源，点一下 openTab(kind, {replaceTab})；
			 *    条目要带 order，注册表按 order 排序（缺了会排成 NaN）。
			 * 不要再注册 "sidebar.right.pane.tab.title"：宿主对每个 tab 会渲染自己的标题席
			 * （键就是这里的注册 id），tab 条上的名字来自 title()；再注册一个标题席会在面板
			 * 右上角多出一个重复的「生图工作台」，还跟宿主自己的图标挤在一起。
			 */
			/**
			 * 登记右侧栏那个席位。**任何一步都不许把异常抛出去** —— 抛出去就等于放弃整条入口。
			 * 踩过：新版 DSH 给服务访问加了守卫，没在 inject 里声明过就直接 get 会抛
			 * 「cannot get property "sidebarRightTabs" without inject」；旧代码在这一行直接炸掉，
			 * 连后面「等 ctx.inject 到货」那条路都走不到，于是重启后入口又不见了。
			 */
			const registerRightbar = (scope) => {
				rightbarAttempts += 1;
				let tabs = null;
				try {
					tabs = scope?.sidebarRightTabs ?? (typeof scope?.get === "function" ? scope.get("sidebarRightTabs") : null) ?? null;
					rightbarProbeError = "";
				} catch (error) {
					// 守卫拦下来了：如实记下原文，交给调用方走 ctx.inject（那条路才算「声明过」）
					rightbarProbeError = String(error?.message ?? error);
					tabs = null;
				}
				if (!tabs || typeof tabs.register !== "function") return false;
				try {
					const effect = typeof scope?.effect === "function" ? scope.effect.bind(scope) : ctx.effect.bind(ctx);
					const slots = scope?.slots ?? ctx.slots;
					effect(
						() =>
							tabs.register({
								id: TAB_ID,
								kind: KIND,
								priority: "extension",
								patterns: [`sidebar://${KIND}`],
								title: () => t("tab.title"),
								keepMounted: true,
								guide: [
									{
										id: "open-workbench",
										order: 20,
										icon: GuideIcon,
										title: () => t("tab.title"),
										description: () => t("guide.desc")
									}
								]
							}),
						"velapi-image-go: rightbar tab type"
					);
					slots.inject("sidebar.right.pane.tab", () =>
						slots.register({ name: "sidebar.right.pane.tab", key: TAB_ID }, function RightbarPane() {
							return h(PluginBoundary, null, h(PaneHost, null, h(Workbench, { onOpenInRightbar: null })));
						})
					);
				} catch (error) {
					rightbarProbeError = String(error?.message ?? error);
					errors.push({ surface: "rightbar", message: String(error?.message ?? error) });
					return false;
				}
				rightbarReady = true;
				rightbarWaiting = false;
				return true;
			};

			// sidebarRightTabs 是别的插件（ui-sidebar-right）挂上来的服务，不是我们的依赖，
			// 冷启动时它可能还没出现。以前这里只做一次性 ctx.get：拿不到就静默跳过，
			// 「tab 类型」和「开始页那张卡」一起没登记 —— 重启后右侧栏回到「开始」页，
			// 那张卡不在，tab 也不在，用户看到的就是「工作台按键不见了」，而且刷新前一直
			// 不会自己好。改成等它出现再登记（DSH 自己的 ui-chat 就是这么写的：
			// ctx.inject(["sidebarRightTabs"], (scope) => scope.sidebarRightTabs ...)）。
			let rightbarWaiting = false;
			if (surfaces.includes("rightbar")) {
				try {
					if (!registerRightbar(ctx)) {
						if (typeof ctx.inject === "function") {
							rightbarWaiting = true;
							ctx.inject(["sidebarRightTabs"], (scoped) => {
								try {
									if (!registerRightbar(scoped)) {
										surfaceErrors.push({
											surface: "rightbar",
											message: "sidebarRightTabs 出现了，但没有可用的 register"
										});
									}
								} catch (error) {
									surfaceErrors.push({ surface: "rightbar", message: String(error?.message ?? error) });
									console.warn("[velapi-image-go] rightbar surface unavailable", error);
								}
								reportClient("rightbar-registered", { rightbarReady, ...serviceSnapshot(scoped ?? ctx) });
							});
						} else {
							surfaceErrors.push({
								surface: "rightbar",
								message: "sidebarRightTabs 尚未挂上，且 ctx.inject 不可用"
							});
						}
						/* 不再加「有界重试」那一层：入口现在靠公开落点（下面 launchers 那两处），
						   右侧栏这条只是锦上添花，等不到就算了 —— 层数越少越不容易坏。 */
					}
				} catch (error) {
					surfaceErrors.push({ surface: "rightbar", message: String(error?.message ?? error) });
					console.warn("[velapi-image-go] rightbar surface unavailable", error);
				}
			}

			/* 固定入口：只挂一处 —— 宿主左侧栏底部那颗按钮（公开 slot `sidebar.footer.action`，
			   宿主自己的 cordis 面板就挂那儿）。点它把停靠面板打开；不读别人的 DOM，
			   不依赖别人的内部服务，也不在别处再放第二个入口。 */
			const launchers = { sidebarFooter: false };
			const mountLauncher = (slotName, key) => {
				try {
					if (!ctx.slots || typeof ctx.slots.inject !== "function") return;
					ctx.slots.inject(slotName, () =>
						ctx.slots.register({ name: slotName, id: `${NAME}-launcher`, order: 40 }, WorkbenchLauncher)
					);
					launchers[key] = true;
				} catch (error) {
					surfaceErrors.push({ surface: slotName, message: String(error?.message ?? error) });
					console.warn(`[velapi-image-go] launcher slot ${slotName} unavailable`, error);
				}
			};
			mountLauncher("sidebar.footer.action", "sidebarFooter");

			// 兜底落点：产品侧栏内部结构改了也不会连带失效，直接贴在窗口右侧停靠。
			// 折叠状态记在 localStorage，重启后保持用户上一次的选择。
			let overlayReady = false;
			if (surfaces.includes("overlay")) {
				try {
					ctx.slots.inject("shell.overlay", () => ctx.slots.register({ name: "shell.overlay", id: NAME, order: guideOrder }, RightDock));
					overlayReady = true;
				} catch (error) {
					surfaceErrors.push({ surface: "overlay", message: String(error?.message ?? error) });
					console.warn("[velapi-image-go] overlay surface unavailable", error);
				}
			}

			let settingsReady = false;
			if (surfaces.includes("settings")) {
				try {
					ctx.slots.inject("settings.section", () =>
						ctx.slots.register(
							{
								name: "settings.section",
								id: NAME,
								order: guideOrder,
								label: () => t("tab.title")
							},
							function SettingsSection() {
								return h(PluginBoundary, null, h(Workbench, { onOpenInRightbar: openInRightbar }));
							}
						)
					);
					settingsReady = true;
				} catch (error) {
					surfaceErrors.push({ surface: "settings", message: String(error?.message ?? error) });
					console.warn("[velapi-image-go] settings surface unavailable", error);
				}
			}

			if (!rightbarReady && !overlayReady && !settingsReady && !rightbarWaiting) {
				console.error("[velapi-image-go] 三个落点一个都没注册上，工作台不会有入口", surfaceErrors);
			}

			// 落定后的实况回执：1.5 秒够宿主把侧栏、停靠层都渲染一遍了。
			// 以后再有「入口不见了」，看这份回执就知道是没登记、还是登记了没渲染。
			try {
				ctx.effect(() => {
					const timer = window.setTimeout(
						() =>
							reportClient("settled", {
								rightbarReady,
								rightbarWaiting,
								overlayReady,
								settingsReady,
								launchers,
								surfaces: { rightbar: rightbarReady, overlay: overlayReady, settings: settingsReady },
								errors: surfaceErrors.slice(),
								...serviceSnapshot(ctx),
								dom: domSnapshot()
							}),
						1500
					);
					return () => window.clearTimeout(timer);
				}, "velapi-image-go: 自检回执");
			} catch {
				/* 宿主没有 effect 就算了：回执是诊断，不是功能 */
			}

			// 让「打开右侧工作台」这类外部触发有个稳定入口（面板控件、快捷键脚本、
			// 甚至控制台里手动调用都可以走这里，不用去猜 slot 名）。
			try {
				window.__velapiImageGo = {
					openInRightbar,
					kind: KIND,
					api: API,
					// 用取值器而不是快照：右侧栏那个席位可能比 apply 晚（等 sidebarRightTabs），
					// 快照会让控制台里的排查结果永远停在「没登记」，正好把问题藏起来。
					get rightbarReady() {
						return rightbarReady;
					},
					get rightbarWaiting() {
						return rightbarWaiting;
					},
					get overlayReady() {
						return overlayReady;
					},
					get settingsReady() {
						return settingsReady;
					},
					get surfaces() {
						return { rightbar: rightbarReady, overlay: overlayReady, settings: settingsReady };
					},
					get errors() {
						return surfaceErrors;
					},
					paneState: () => ({ mounted: rightbarPaneMounted, visible: rightbarPaneVisible, onScreen: rightbarPaneOnScreen }),
					// 诊断把手：控制台里 __velapiImageGo.report() 手发一份回执，
					// __velapiImageGo.snapshot() 直接把依赖面/实况打出来。
					report: reportClient,
					snapshot: () => ({ rightbarReady, rightbarWaiting, overlayReady, settingsReady, errors: surfaceErrors.slice(), ...serviceSnapshot(ctx), dom: domSnapshot() }),
					locale: NS
				};
			} catch {
				/* 只读环境就算了 */
			}
		}

		exports.name = NAME;
		/* 依赖在**模块导出里静态声明** —— 这是 DSH 自己的右侧栏插件写法
		   （`dsh-client-ui-sidebar-browser` 就是 `["slots","locale","sidebarRight","sidebarRightTabs"]`）。
		   声明过之后服务访问才算合法：新版 cordis 没声明就 get 会抛
		   「cannot get property "sidebarRightTabs" without inject」；
		   而且声明会让宿主等这两个服务到货再激活本插件 —— 冷启动竞态也从根上没了。 */
		exports.inject = ["slots", "sidebarRightTabs", "sidebarRight"];
		exports.apply = apply;
		// 开发/预览用的内部把手：tools/preview.mjs 用它把各视图单独渲染成静态页，
		// 不需要起 dsh 就能看设计效果。宿主加载时不会碰这个字段。
		exports.__internals = {
			Workbench,
			// 停靠面板的「露哪张脸」判定与落点本身：测试直接拿它验
			// 「侧栏 tab 挂着但被藏起来时，入口胶囊必须在」。
			dockFace,
			RightDock,
			PaneHost,
			reportClient,
			serviceSnapshot,
			domSnapshot,
			setPaneState(mounted, visible, onScreen) {
				rightbarPaneMounted = Boolean(mounted);
				rightbarPaneVisible = Boolean(visible);
				rightbarPaneOnScreen = onScreen === undefined ? Boolean(mounted && visible) : Boolean(onScreen);
			},
			paneState: () => ({ mounted: rightbarPaneMounted, visible: rightbarPaneVisible, onScreen: rightbarPaneOnScreen }),
			ChatView,
			LibraryView,
			NotesView,
			ProvidersView,
			// 模型 → 供应商选路：模型属于谁就把请求发到谁那儿（纯函数，Node 里可测）
			modelCatalogFor,
			providerIdForModel,
			ModelPicker,
			Inspector,
			PresetBoard,
			PresetDialog,
			PsView,
			PS_TOOLS,
			psCanvas,
			PS_BLEND_MODES,
			psBlendOp,
			psDrawLayers,
			psMaskAlpha,
			psInvertAlpha,
			psMaskSize,
			psMaskDims,
			psMaskCanvas,
			psMaskedCanvas,
			psLayerExport,
			psExportComposite,
			psCanvasLayers,
			psMoveLayer,
			psLayerById,
			psLayerThumb, psLayerCommit,
			psLayerSessionStart,
			psLayerSessionExit,
			// 底图几何 → 图层 / 蒙版联动 + 带图层的撤销快照（纯函数，Node 里可测）
			PS_GEOMETRY_KINDS,
			psGeometryKind,
			psGeometryDims,
			psResampleAlpha,
			psTransformAlpha,
			psWarpGeometrySize,
			psWarpAlpha,
			psTransformLayers,
			psStraightenGeometry,
			psHistorySnapshot, psHistoryPush, psHistorySeek,
			psHistoryRestore, psReadChannel, psDecodeInput, psReadDpiBytes,
			psLayerRowActivate,
			// 曲线 / 色阶 / 自然饱和度 / 滤镜（像素引擎，Node 里可测）
			psIdentityLut,
			psCurveLut,
			psCurvePreset,
			psCurveNormalize,
			psCurveHit,
			psCurveMove,
			psCurveAdd,
			psCurveRemoveAt,
			CurveEditor,
			psLevelsLut,
			psApplyLutPixels,
			psVibrancePixels,
			psBoxBlurPixels,
			psSharpenPixels,
			psNoisePixels,
			psAdjustPixels,
			psClampRect,
			psRectFrom,
			psResizeRect,
			psSplitTiles,
			gridImageSource, psGridLayout, psGridCrop, psGridReplace,
			psInscribedSize,
			psAnchorOffset,
			psDeskewAngle,
			psRowScore,
			psLumaFromCanvas,
			psRotate,
			psStraighten,
			psRulerAngle,
			// 四点透视矫正：单应矩阵 + 四点几何 + 逐像素变形
			psSolveLinear,
			psQuadPoints,
			psQuadCorners,
			psQuadInset,
			psHistorySteps,
			warpSrcQuad,
			psQuadFlatSize,
			psQuadBounds,
			psMoveQuadPoint,
			psHitQuad,
			psHomography,
			psApplyH,
			psInvertH,
			psMatMul,
			psScaleH,
			psWarpPreview,
			psQuadsEqual,
			psQuadConvex,
			psWarpPlan,
			psWarpCanvas,
			psCrop,
			psFlip,
			psResize,
			psCanvasSize,
			psFeather,
			psSlice,
			psHandles,
			psClampZoom,
			psStepZoom,
			psZoomAt,
			psWheelZoom,
			psFitZoom,
			PS_ZOOM_MIN,
			PS_ZOOM_MAX,
			psB64Decode,
			psB64Encode,
			psCrc32,
			psReadDpi,
			psApplyDpi,
			psPngWithDpi,
			psJpegWithDpi,
			psRatioSize,
			psShortcut,
			PS_SHORTCUT_TOOLS,
			PS_ACTIONS,
			PS_DEFAULT_BINDINGS,
			psCombo,
			psComboLabel,
			psBindingMap,
			psLookup,
			psConflict,
			psHitHandle,
			ModelPicker,
			groupModels,
			modelFamily,
			modelKind,
			modelOptionsFor,
			modelCatalogFor,
			// 上游报错：原始证据块 + 视频任务体；端点协议：输入框那一行的选择
			JobTurn,
			// 单张结果卡（图片 + 三个纯文字动作）
			Shot,
			// 图片查看器 + 快捷拖拽（纯函数 / 组件，Node 与真机都能测）
			ImageViewer,
			imageDragProps,
			readImageDrag,
			IMAGE_DRAG_TYPE,
			setHostCapabilities,
			// 尺寸 = 比例 × 像素（下拉文案与兜底项）
			SIZE_OPTIONS,
			resolveSizeExpression,
			sizePartsFor,
			buildGenerationRequest,
			normalizeGenerationBody,
			requestOverrides,
			sizeOptionsFor,
			sizeOptionLabel,
			sizeOptionTitle,
			// 纯网页能力（不需要宿主重启）：复制图片到系统剪贴板 / 下载文件
			copyImageToClipboard,
			downloadImageFile,
			assetFileName,
			ToastHost,
			JobError,
			VideoResult,
			upstreamText,
			pickClipboardImage,
			pastedImageName,
			// 固定入口：公开落点上的那颗按钮
			WorkbenchLauncher,
			openWorkbench,
			PROTOCOL_IDS,
			protocolOptions,
			protocolLabel,
			protocolShortLabel,
			Icon,
			Block,
			CSS,
			get text() {
				return t;
			}
		};
		return module.exports;
	}
});
;
