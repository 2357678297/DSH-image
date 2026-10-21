# dsh-plugin-velapi-image-go

在 DeepSeek Harness 里长出来的「**API 对话生图工作台**」：左边竖排导航（对话生图 /
图片管理 / 信息管理 / 图片处理 / 供应商管理），中间对话区，右栏三张卡片（图片 / 预设卡 /
供应商）。后端接 OpenAI 兼容的生图接口（velapi 系），生成结果**落盘成本地图库**，不是
只丢一段会过期的 URL；生完的图还能就地进「图片处理」工具箱裁切、矫正、羽化、调色、叠图层，
滚轮放大看细节、改画布尺寸与分辨率（写进导出文件的头）。

- 宿主半边 `lib/index.js`：Node ESM cordis 插件，注册 `/api/velapi-image-go` 前缀路由，
  负责调上游、落盘、排队、记账。
- 浏览器半边 `client.js`：自注册 bundle，注册进右侧栏 / 右侧停靠面板 / 设置页三个落点。
- 设计说明见 [docs/DESIGN.md](docs/DESIGN.md)，界面预览见 [docs/preview](docs/preview)。
- **UI 设计审计与样式规范见 [docs/UI-SPEC.md](docs/UI-SPEC.md)**（杂志极简白：纸白/墨黑/朱红、
  控件胶囊化、圆角 4 档、字号 5 档、动效 160ms；改前改后截图在 `docs/ui-audit/`）。

```
dsh-plugin-velapi-image-go/
├── package.json           dsh.bundle.patch + dsh.client.platform=web
├── cordis.patch.yml       bundle 层的 loader 条目（含全部默认值）
├── lib/index.js           宿主半边：路由 + 上游调用 + 图库
├── client.js              浏览器半边：工作台界面
├── docs/
│   ├── DESIGN.md          设计说明与取舍
│   ├── UI-SPEC.md         UI 审计结论 + token/组件样式规范（杂志极简白）
│   ├── ui-audit/*.png     四页改前/改后截图（chat / library / ps / providers）
│   └── preview/*.html|png 视图的静态预览（用真实组件渲染，含右侧栏开始页、上游报错那一屏、端点协议那一栏）
├── test/
│   ├── host.test.mjs      宿主半边冒烟测试（离线 122 项 + --live 真图 5 项）
│   ├── client.test.mjs    浏览器半边渲染测试（397 项）
│   └── engine.test.mjs    纯像素引擎离线测试（133 项：调整 / 曲线 / 色阶 / 滤镜 / 蒙版 / 叠加）
└── tools/
    ├── bundle.mjs         把 client.js 当 __ModuleLoader__ bundle 装进隔离上下文
    ├── markup.mjs         预览与测量共用的样例数据与页面骨架
    ├── preview.mjs        预览生成器（HTML + Chrome 截图）
    ├── fit-check.mjs      适配性检查：各宽度下量 scrollWidth 有没有溢出，外加模型弹层越界、工具箱三栏折行
    ├── ps-check.mjs       工具箱真机检查：Chrome 里跑真 canvas，量每个动作改出来的像素与尺寸，并拆落盘 PNG 的 pHYs
    ├── ruler-check.mjs    鼠标实时矫正真机检查：挂真组件 + 派真 pointer 事件，看拖动时画面转不转、松手裁没裁
    ├── warp-check.mjs     四点透视矫正真机检查：真 canvas 量拉平后的像素与尺寸，真画布上拖角点（实时、无应用、切工具自动落定）
    ├── dock-check.mjs     停靠入口可见性真机检查：display:none 的「挂载但看不见」宿主必须让胶囊露出来
    ├── preset-once.mjs    预设卡渲染探针：卡片墙 / 编辑器 / 空态一次看全
    ├── group-once.mjs     模型分组核对：拿真实目录跑一遍，打印 能力→族→模型
    ├── probe-once.mjs     几何探针：某视图某宽度下量工具栏/输入框/按钮的盒模型（定位重叠/错位）
    ├── config-check.mjs   配置保存真机回归：挂真 Workbench + 故意不认新字段的假宿主
    ├── route-check.mjs    模型选路真机回归：挂真 Workbench + 两条假供应商，验模型属于谁就发给谁
    ├── paste-check.mjs    粘贴图片真机检查：派真 ClipboardEvent + 真 DataTransfer
    ├── curve-mask-check.mjs 真机曲线 / 蒙版检查：真 DOM 里拖曲线控制点，真 canvas 上验蒙版合成
    ├── restart-rehearsal.mjs 重启复演：bundle 加载契约 → 服务到货登记 → 服务没到也不炸
    ├── restart-watch.mjs  只读 client-report.json：等到一次新的 apply 再判定入口在不在
    ├── state-audit.mjs    独立状态审计：几何联动 / 历史快照 / 变形几何三组不变量（不共享被测实现）
    ├── undo-check.mjs     撤销/重做真机检查：点真按钮做旋转 / 调整，再点撤销看尺寸与像素有没有回去
    ├── tool-probe.mjs     工具探针：从 app.asar 抠出真的 dsh-tools，验 generate_image 注册 + 执行 + 留痕
    ├── viewer-check.mjs   查看器 / 拖拽 / 素材目录真机检查（点图开查看器、翻页缩放、拖进输入区、改目录）
    ├── live-check.mjs     活 GUI 只读体检：构图 / 当前被服务的 client.js / 宿主端点
    └── guide-preview.mjs  右侧栏「开始页」卡片预览（套宿主真实的 GuideBody CSS）
```

脚本：`npm test` / `npm run fit` / `npm run ps` / `npm run ruler` / `npm run warp` / `npm run dock`
/ `npm run preview` / `npm run guide` / `npm run test:live`。`config-check` / `paste-check` /
`curve-mask-check` / `undo-check` / `state-audit` / `route-check` / `tool-probe` / `viewer-check` / `restart-rehearsal` /
`restart-watch` / `live-check` 没有 npm 别名，直接用 `node tools/…` 跑。

## 落点

工作台有三个落点，任何一个失败都不影响另外两个（`surfaces` 可控）：

| 落点 | 席位 | 说明 |
| --- | --- | --- |
| `rightbar` | `sidebarRightTabs.register()` + `sidebar.right.pane.tab` / `.title` | 作为产品右侧栏的一个标签页；**并且在右侧栏「开始页」里放一张卡片**（点一下打开工作台） |
| `overlay` | `shell.overlay` | 贴在窗口右侧的停靠面板，默认收起留一个胶囊入口，宽度可拖 |
| `settings` | `settings.section` | 设置页里的工作台整页（永远可用，是保底入口） |

> 窄容器适配：同一个组件会落进三种宽度差好几倍的容器（设置页整页 ~1280px、右侧栏分栏后
> 一栏 ~400px、停靠面板 420px）。根节点用 `ResizeObserver` 量**自己的**容器宽度（不是
> `window.innerWidth`），低于 660px 切窄形态：导航折成顶部段控件、检查器沉到底部。
> 量尺寸走 `useLayoutEffect`，首帧就定形态，不会先闪一帧「三段并排」。
> 想知道某个宽度会不会溢出：`npm run fit`。

设置页那一节右上角有个「在右侧栏打开工作台」按钮（侧栏席位不可用时自动退到停靠面板）；
控制台里也可以直接调 `window.__velapiImageGo.openInRightbar()`。

### 右侧栏的注册契约（读 `ui-sidebar-right/lib/client.js` 得来，踩过坑）

```js
tabs.register({
  id: TAB_ID,                     // 唯一；面板内容那个席位就是按这个 id 找的（不是 kind）
  kind: KIND,                     // tab 类型判别符
  priority: "extension",          // 档位字符串：extension > builtin > fallback；写数字会掉进 shadowed
  patterns: ["sidebar://" + KIND],// 地址匹配用（openTab 排序）
  title: () => t("tab.title"),    // tab 条上的名字；defaultSeed 也会调用
  keepMounted: true,              // 切走不卸载
  guide: [{ id, order, icon, title: () => …, description: () => … }]  // 「开始页」那张卡片
});
```

- `guide[]` 缺了它 → 右侧栏「开始页」那片空位不会有任何东西（只有 `+` 里能翻到）。
- 条目的 `order` 必填：注册表按 `order` 排序，缺了会排成 `NaN`。
- `title` / `description` 是惰性函数，宿主每次渲染才取。
- 条目总数 ≤ 4 时宿主会显示描述，超过就只显示标题。
- **别再注册 `sidebar.right.pane.tab.title`**：那个席位就是 tab 条上那个标签本身
  （宿主 `titlesFor()` 用 `fallback: tab.title` 兜底），注册上去会把宿主自己的标题盖掉，
  面板右上角多出一个同名标签，还跟宿主的展开按钮挤在一起。名字交给 `title()` 就够了。

### 入口只出现一次

三个落点里，**同一时刻只应该有一个可见入口**：

- 侧栏 tab 挂载时在 `window` 上广播 `velapi-image-go:rightbar-pane`，停靠面板收到就整个
  不渲染（`if (paneMounted) return null`）；
- 侧栏席位拿不到时（宿主内部结构变了、或配置里没开 `rightbar`），才轮到停靠面板；
- 停靠胶囊固定在**右下角**——窗口右上角是宿主会话头部的地盘（展开按钮在那儿）。

竖栏在宽容器里会被拉满高度，底部那块（图库 / 信息 / 任务计数）就是为了不让它变成一条空柱子。

### 粘贴、拖拽、上传：三条路都通向同一张参考图
截图工具截完直接 `Ctrl+V` 贴在输入框上就行 —— 从网页复制的图、从文件管理器复制的文件也都认。
实现上只有一条路：`pickClipboardImage(clipboardData)` 挑出图片（`items` 优先，老浏览器看 `files`；
纯文字一律返回 `null`），交给和「+ 上传」「拖进来」同一个 `attachReference`：本地读成 dataURL、
顺手存一份到 `uploads/`、挂成参考图，并回一条「已粘贴为参考图」。

- **粘贴挂在工作区根上**，不是只挂在输入框上：焦点停在模型 / 尺寸下拉里也粘得上。
- **纯文字粘贴不拦**（拿不到图片就直接 return，不 `preventDefault`），该怎么贴还怎么贴；
  图文一起复制时挑图挂上，不让 base64 跑进输入框。
- 通用文件名（`image.png` / `blob` / 截图工具给的）换成 `粘贴的图片-<时间>.png`，别在一堆同名图里找不着。
- 挂上之后就是输入框上方**一张小矩形卡**（54×54 缩略图 + 右上角一个小「×」）：不写文件名、不写状态，
  名字放进 `title`，鼠标停一下就有。以前那条通栏（图 + 长文件名 + 「参考图」）在窄栏里能占掉一整行。

### 一轮对话两条
工作台的记录里，**每轮都是「我发出去的那句话」（靠右，蓝色「我」头像）+「工作台的回复」（靠左）**。
以前只渲染回复 —— 翻记录时看不出「当时让它做了什么」，提示词只活在输入框里。
提示词用的就是任务的 `prompt`（`/generate` 入队时落盘的那个字段），所以刷新、翻历史都在，
不是界面自己记的；没有提示词的异常记录也不会冒出一个空气泡。

带着参考图发出去的那条，缩略图跟着**我这条消息**走（不是只在输入框里闪一下）。宿主只存 URL
（`job.referenceUrl`，只收本站 `/upload`、`/asset` 路径，外站地址一律丢掉），原始 base64 照旧不进历史。

**信息流从上往下**：老的在上、新的在下（宿主 `/jobs` 是新的在前，界面按时间正序反过来排）。
来新任务时自动滚到底；如果用户正往上翻历史（离底部超过 160px），就不抢滚动位置。

**每条我说的话下面有三个无底色图标动作**（纯 SVG、悬停才亮）：

| 动作 | 做什么 |
| --- | --- |
| 重试 | 用这条任务的参数（提示词 / 模型 / 尺寸 / 协议 / 参考图）再发一次 |
| 删除 | 删掉这条对话记录（`POST /job/delete`，只删记录，图库里的图不动；删前确认） |
| 编辑 | 把这句话填回输入框（带参考图的一并挂上），改完再发 |

### 对话（会话）与上下文管理

**每个对话是一段独立记忆。** 头部标题右边是一个会话下拉 + 三个按钮：

| 控件 | 行为 |
| --- | --- |
| 下拉 | 切换会话（只拉这个会话的任务记录） |
| `+` | 新建对话：**不带上一段记忆**（history 为空，风格/指代全部从头开始） |
| `✎` | 重命名（列表里按名字认） |
| `🗑` | 删除对话：连带删掉它的全部任务记录（图库里的图不动；删前确认） |

会话落在 `stateDir/conversations.json`，**重启/刷新都还在**；老任务没有会话 id 会自动归到「默认对话」。
任务记录带 `conversationId`，`GET /jobs?conversationId=` 只看这个会话。

**上下文管理模型（默认开，输入框那排第一个 ✨ 按钮可关）**：每次点生成，先把你**本会话**最近
`contextTurns` 轮（默认 6）交给一个**对话模型**（`POST /chat/plan`，`/v1/chat/completions`），
让它把「太夸张了 / 这个换个背景 / 和上一张一样但要竖版」这类话整理成这一轮可用的提示词：

```json
{"prompt":"完整提示词","mode":"edit|generate","referenceUrl":"/api/…/asset/x.png","reason":"怎么理解的"}
```

- 气泡里显示的还是**你的原话**，助手那条多一行「改写 · …」；
- 说要在上一张上改（`mode: edit` + `referenceUrl`）时，宿主会自动把那张图的字节读回来发 `/images/edits`；
- **新对话天然隔离**：history 为空，模型不会拿上一个会话的风格/指代来套；
- 对话模型在「供应商管理 → 运行期配置」里选（默认取目录里第一个 chat 模型），轮数可调 0–12；
- 没有对话模型 / 调用失败 / 返回不是 JSON → 按原话直接生成（不会把生成卡死）；
- **你在纠正 / 讨论，不是要出图**（「乱搞，S3 就是我发的参考图机器人」「这不对」）→
  上下文模型判成 `action: reply`：**不出图**，助手回一句话（承认理解错了 + 复述正确指代），
  这一问一答照常留在会话历史里（`POST /chat/message`，`kind: reply`）。
  —— 之前每句话都被当成「再出一张」，结果越改越错（踩过：纠正「S3 就是参考图里那台」
  反而又生成了一张带人形机器人的图）。
- **参考图假图防御**：恢复出来的参考图先是本站 URL 字符串（只为缩略图显示），
  老版本会把它整串当 `image` 字段发给宿主，裸 base64 解出 37 字节假图、原样转发
  给上游吃 400「无法识别的二进制格式」。现在三道闸：客户端只把 `data:` 开头的
  真 data URI 当字节发（编辑回填时会异步把 URL 补成真字节，缩略图不再挂 ✗）；
  宿主对裸 base64 验 PNG/JPEG/WebP/GIF 魔数；`referenceUrl` 指到的文件不是图
  也直接 400 `missing_reference`，绝不把垃圾转发给上游。
- **参考图能挂多张（最多 4 张）**：拖拽 / Ctrl+V / 图库「用作参考图」都是**追加**，
  每张 chip 右上角的 × 单独移除；发送时字节（`images[]`）+ 本站 URL（`referenceUrls[]`）
  一起交给宿主，`/images/edits` 的 multipart 每张占一个 `image` 字段
  （`reference_1.png`、`reference_2.png`…）；上下文对话模型也会收到完整清单
  （第 1…N 张是哪张），纠正「S2 / S3 指哪张」更稳。挂满 4 张再拖会提示先移掉一张。
- **不留档就发不出第二张**（踩过的坑）：从结果卡「重绘」/ 图库「用作参考图」挂进来的图
  以前不走上传，没有本站 URL —— 发送时那张被当成「无地址」丢掉，消息下面只剩一枚缩略图、
  上游只收到一张（看起来就是「发出去还是单图」）。现在两条路都留档：挂图时就上传换 URL；
  发送前再把「还没 URL」的补传一次（上传失败才退回纯字节）。我发出去那条消息下面的缩略图
  也按 `referenceUrls` 逐张显示。

### 提示条贴窗口额头
提示条（`ToastHost`）是 `position:fixed` 到视口顶端居中的胶囊：内容两侧各留三字白，
成功只用一个浅蓝描边、失败用红描边加浅红底，**不再是一条通栏横条**（以前贴着容器底部，
在右侧栏 / 停靠面板里会被拉成一整行，读起来像报错页）。多条一起出现时自上而下叠在额头中央。

### 一个事实只出现一次

工作台里同一个状态最多只能有一个归属地，否则一眼看过去全是重复：

| 事实 | 唯一归属地 |
|---|---|
| 密钥 / 是否连上 | 工作区头部那颗胶囊（`vig-main-head`） |
| 当前供应商 | 检查器「供应商」卡里的下拉框 |
| 模型 / 尺寸 / 张数 | 输入区那排选择器 |
| 图库 / 信息 / 任务计数 | 侧栏底部（宽容器才有，窄形态自动隐藏） |
| 队列 / 服务端异常 | 只在真的有活动任务或服务不可用时出声 |
| 「供应商管理」入口 | 左侧导航项，不在卡片里再放一遍 |
| 预设卡（标题 / 提示词 / 参考图） | 检查器「预设卡」卡片墙；要长期存档的整段记录才进「信息管理」页 |
| 图片处理（框选 / 裁切 / 羽化 …） | 左侧导航「图片处理」整页；图库、预设卡都只给一张图，不各自再塞一套工具 |

### 右侧检查器可折叠

右侧那一列（图片 / 预设卡 / 供应商）默认展开 268px，**右上角一个「›」**点一下收成
**34px 窄签**：竖排「图片 · 预设 · 供应商」+ 一个「‹」，再点一下展开。收起状态记在
`localStorage` 的 `dsh.velapi-image-go.side`（存 `"0"` = 收起），刷新后还是上次的样子。

- 收起后正文（对话 / 图库 / 工具箱…）拿到整列宽度，窄容器里尤其明显；
- 窄形态（`data-compact="1"`，右侧栏 tab 那种宽度）收起后不是竖签，而是一条**横向窄条**，
  不会把主区域挤成两行；
- 折叠手柄只挂在「对话生图」视图上（其它视图本来就没有右列）。

### 信息卡：输入框旁先「快速选」，二级才跳转

输入框工具条上那个便签图标（`+` / 图库 右边）以前是直接跳「信息管理」页。现在分两级：

1. **点一下 → 上方浮出「信息卡」面板**：列出信息卡的标题 / 提示词摘要 / 标签，最多 20 张；
   点其中一张，提示词（和 meta）**直接追加进输入框**（沿用 `insertNote`：空草稿直接填、
   非空则换行追加、总长仍按 500 字截断），浮层自动收起。
2. **二级「管理」**：面板右上角那颗「管理」才跳「信息管理」页做增删改；空态时给「去新建」。
   超过 20 张时面板底部提示「还有 N 张，去信息管理里看」。

点浮层外面或按 `Esc` 收起；按钮在展开态高亮（`.vig-tool.is-on`）。

### 尺寸 = 比例 × 像素

输入框那一排的尺寸下拉现在**先给比例**（上游要的是像素，用户想的是比例）：

| 比例 | 像素 | 说明 |
| --- | --- | --- |
| 1:1 | 1024×1024 | 默认 |
| 3:2 | 1536×1024 | 横图（GPT 系的 1536×1024） |
| 2:3 | 1024×1536 | 竖图 |
| 16:9 | 1536×864 | 宽屏 |
| 9:16 | 864×1536 | 手机竖屏 |
| 21:9 | 2048×864 | 超宽 |
| 16:9 · 2K | 2048×1152 | 2K 横图 |
| 1:1 · 2K | 2048×2048 | 2K 方图 |

- 下拉**正面同时给比例与分辨率**（`1:1 · 1024×1024` / `16:9 · 1536×864` / `16:9 · 2K · 2048×1152`），
  不用悬停就能看到实际像素；这一行放不下时按既有规则换行，不截断信息；
- 选哪条就把 `config.defaultSize` 写成对应像素 —— 发给上游的仍是像素；
- 老配置里不在表里的尺寸（比如 `512x512`）会补在第一条、标「自定义」，不会让下拉变空。

### 模型列表：先分类，再按需展开

中转站的模型目录是一长串平铺 id（`nano-banana-*`、`veo_3_1_*`、`imagen-4.0-*`、`omni-flash`…），
直接挂原生 `<select>` 会甩出二十多条无结构选项，还带一个系统级的巨长弹窗。所以：

- **按钮态**：只显示当前模型 + 一个下拉箭头，点开才渲染列表（选项不进初始 DOM）。
- **分类来源是中转站自己给的元数据**，不是名字：`GET /v1/models` 每条带 `image_family` /
  `video_family`，里面的 `kind` 就是权威值。宿主把这些收成 `modelMeta` 挂在供应商记录上，
  前端按 `kind` 分组。**踩过的坑**：`omni-flash` 靠名字被猜成「对话」，实际 family 写的是
  `video`（模式 `r2v / t2v`，8 秒）。
- **展开态**：三层结构 —— 能力（图片 / 视频 / 音频 / 其它）→ 名字前缀族 → 模型。前缀取法是
  「去掉版本号与变体后缀」：`nano-banana-2.1` 与 `nano-banana-pro` 都归 `nano-banana`，
  `veo_3_1_r2v_fast_ultra_relaxed_8s` 归 `veo`。族按条数多的排前面，未开通的排到族尾并打「未开通」。
  名字前缀表只在元数据缺失时兜底；都认不出来就落「其它」，不再硬说成「对话」。
- **未开通**：目录里 `enabled:false` 的模型（本账号是 `imagen-4*`）照样列出来，但淡显 + 标「未开通」，
  这样「选不出来的模型」有解释，而不是选了才报错。
- **搜索**：列表顶部有过滤框（同时匹配 id 与中转站给的 label），总数实时显示。
- **供应商标记与选路**：每条模型右边标出它属于哪条供应商链（`GPT` / `grok`）；选中模型的
  同时把「当前供应商」切到它所属那条，生成 / 重试请求也按模型挑供应商 —— **模型属于谁就打到谁那儿**。
  踩过的坑：供应商里加了 grok（`api.velapi.cc`）和 GPT（`gank.velapi.cc`）两条链，模型选了
  GPT 的 `gpt-image-2.5-c`，但「当前供应商」还停在 grok，请求就照着 grok 的 baseUrl 打过去，
  回 503 `No available channel for model gpt-image-2.5-c under group grok` —— 选路规则见「排障」。
- **落点**：输入区（往上弹、贴右）与图库筛选（往下弹、贴左）；窄容器里弹层的定位包含块
  从按钮提到输入区/工具条，宽度铺满卡片，避免被卡片的 `overflow:hidden` 裁掉。
- 尺寸、张数这类三五个选项的下拉照旧用原生 `<select>` —— 只有长列表才值得自绘。

`modelMeta` 是宿主半边算出来的：**改完宿主代码要重启应用**（客户端半边刷新 GUI 就行）。
只刷新 GUI 时前端走名字兜底，分类结果与元数据一致，但看不到「未开通」标记。

`node tools/group-once.mjs` 拿真实目录跑一遍分组；`node tools/preview.mjs` 会多出两张：
`model-picker.png`（宽栏展开）、`model-picker-dock.png`（窄栏展开）。

### 预设卡：点一下就能出图

右栏第一张卡片是**预设卡墙**（原来是空 textarea + 「插入输入框」——那个只搬文字，帮不上忙）。
一张卡 = 参考图封面 + 标题 + 提示词摘要 + 标签 + 三个动作（用这张 / 编辑 / 删除）：

- **点卡片**（或「用这张」）：提示词进输入框（框里已有字就换行追加），参考图挂到输入区，切回「对话生图」。
  参考图是从宿主 `/preset/<file>` 或图库路径取回后转 dataURL 再挂的，和「从图库选择」走同一条路。
- **编辑**：模态里改标题 / 提示词 / 参考图 / 标签。参考图三个入口 —— 上传本地图（落 `uploads/`）、
  从图库挑、移除。
- **首次启动种 8 张**内置卡（产品主图 / 爆炸贴纸 / 像素冒险 / 国风工笔 / 工作台线稿 / 头像特写 /
  窗边场景 / 极简海报），前四张自带 256×256 参考图，随包放在 `assets/presets/`，走
  `/api/velapi-image-go/preset/<file>` 提供（只认 `[A-Za-z0-9._-]` 文件名，挡路径穿越）。
- 内置卡被删了，右上角那个刷新按钮（`POST /presets/reset`）把缺的补回来，自己建的照旧留着。
- 参考图只收本站路径或 `data:` 图，外站 URL 一律丢掉；参考图加载失败退回「无参考图」占位，不留破图框。

`node tools/preview.mjs` 另外出 `presets.png`（卡片墙）与 `preset-dialog.png`（编辑器）。

### 图片处理：改完的图立刻能当参考图

左侧导航第四项「图片处理」是一个**完全在浏览器里跑**的 PS 式工具箱（左边工具条 / 中间画布 +
参数浮窗 / 右边图层面板，窄容器折成一栏）。参数不占列：它是一块压在画布上的浮窗，原来那列
让给了图层。不碰宿主半边，所以改这一块只要刷新界面，不用重启应用。

| 工具 | 做什么 | 参数浮窗给什么 |
| --- | --- | --- |
| 框选 | 拖出选区，四边八手柄可继续拖 | 读数（`x, y · w × h`）、全选 / 取消选区 / 裁切 |
| 裁切 | 按选区裁掉四边 | 同上 |
| 切割拆分 | 把画布切成 N×N 块（除不尽时最后一块贴边） | 列数 / 行数 / 切块 → 块上点「换这张」接着改 |
| 旋转 | 90° 顺时针 / 逆时针、任意角度 | 角度滑杆、应用 |
| 矫正 | 在图上沿一条本该水平的边**拖一条线**（PS 标尺那套），拖的时候画面实时转、松手即矫正并裁掉斜边；也能一键自动估角 | 实时角度读数（拖的时候跳）、自动矫正 |
| 透视矫正 | 四点投影矫正，三种方式：**四点畸变**（把歪着的屏幕/纸张四角拖出来，拉平成正矩形）/ **自由拉伸**（源、目标各四个角，任意四边形映到任意四边形）/ **变形**（取图四点固定是整图四角，只拖目标四点，整幅图被拉成那个四边形）。四点默认就贴着图片最外圈，拖的时候画面实时跟着变 | 方式三段切换、视图（原图 / 结果）、输出尺寸读数、重置四点。**没有「应用」**：拖完就是结果，换工具或回车落定 |
| 画布 | 改画布尺寸（像素或百分比），原图按九宫格锚点落位 | 当前尺寸 · 分辨率、单位（像素 / 百分比）、宽 / 高、常用尺寸（1:1 4:3 3:4 16:9 9:16）、分辨率 DPI、原图落点、空白处（透明 / 白 / 灰） |
| 羽化 | 选区（或整张）边缘按半径柔化，外面变透明 | 半径滑杆、整张边缘 / 选区边缘、应用 |
| 缩放 | 重采样到指定宽高（改像素数的那个） | 宽 / 高、保持比例 |
| 翻转 | 水平 / 垂直镜像 | 方向 |
| 调整（`U`） | 四段：**调整**（亮度 / 对比度 / 饱和度 / 自然饱和度 / 色相 + 灰度 / 反相）、**曲线**（可拖的曲线编辑器）、**色阶**（黑场 / 白场 / 中间调）、**滤镜**（模糊 / 锐化 / 噪点）。全是纯像素函数，点一次按钮 = 一次撤销 | 四段各一节：滑杆与复位 / 曲线编辑器和 4 个形状预设 / 三个色阶数值 / 三个滤镜滑杆，各带自己的「应用」 |

- **参数是浮窗**：参数不再占列，浮在工具箱左上角（默认压住工具条上沿与画布左沿，宽 236px）；
  可收起成「工具图标 + 竖排标签」，点一下展开。工具栏的「专注画布」或按 `\` 会同时收起
  工具条与参数浮窗。收起状态记在 localStorage，下次进来还是上次的样子。
  注：浮窗位置目前是固定的，代码里留着 `dsh.velapi-image-go.ps.float` 这个 localStorage 键，
  但没有拖拽入口，改位置要动代码。
- **图层面板就是原来参数栏那一列**：底图行 + 图层行（叠加算法 / 不透明度 / 显隐 / 上下移 /
  蒙版 / 删除），细节见下面「图层」。
- **拖入即载入**：把本地图片文件拖到工具箱任意位置，或者从网页上拖一张图片过来（带
  `text/uri-list` / `text/plain` 的 http(s) 地址），松手就进画布；拖进来不是图片也没有
  可用地址会明确报错。网页图片要先能通过 CORS 取回，否则会看到「取图失败」。
- **滚轮放大缩小**：画布上滚轮以光标为锚点缩放（5% ~ 800%），右下角比例条给 `− 比例 +`
  与「适应窗口」「1:1」；放大到超出容器后中键拖动平移，滚动条也在。线宽与手柄的判定半径
  都按缩放折算，缩小时手感不会跟着一起缩没。
- **按需展开**：左工具条能收起成 52px 图标栏；参数浮窗收起后画布基本铺满整宽。
  画布高度 `clamp(320px, 58vh, 720px)`，不再死守 320px。
- **快捷键**（照 PS 的肌肉记忆）：`V` 框选 `C` 裁切 `S` 切割拆分 `R` 旋转 `L` 矫正 `W` 透视矫正 `N` 画布
  `F` 羽化 `Z` 缩放 `M` 翻转 `U` 调整；`Ctrl+Z` / `Ctrl+Shift+Z` / `Ctrl+Y` 撤销重做，`Ctrl+0` 适应窗口，
  `Ctrl+1` 1:1，`+ / -` 缩放，`Ctrl+A` 全选，`Esc`（或 `Del`）取消选区，`Enter` 应用当前工具，
  `Ctrl+S` 下载，`Ctrl+D` 设为参考图，`\` 专注画布，`?` 打开快捷键表。在输入框里打字时不拦键。
- **键位可改、组合随便配**：`?` 打开的表里 24 条动作全是可点的键帽 —— 点一下进录制态，
  按任意组合（`Ctrl` / `Alt` / `Shift` 随便叠，比如 `Ctrl+Alt+K`）就换上；撞了别人的键会当场告诉你
  被谁占了；单条 `Backspace` 恢复默认，右上角「全部恢复默认」一键回滚。一个动作也能绑多个键位
  （默认 `+` 和 `=` 都是放大，`Esc` 和 `Del` 都是取消选区）。改过的键位存两处：浏览器本地立刻生效，
  同时写进宿主 `config.json` 的 `shortcuts`，换端口清掉 localStorage 之后照样能捞回来。
- **空画面不空着**：还没进图时，画布那块地方摆「最近生成」（图库里最近 24 张，点一下直接进画布）
  和「预设样张」（8 张预设卡的图，点一张就能拿工具箱练手）；两样都没有才退化成三步说明。
- **分辨率写进文件**：画布面板的「分辨率」不是显示用的数字 —— 导出时 PNG 会补一个 `pHYs` 块
  （像素/米，CRC 重算），JPEG 写 `JFIF` 密度；`设为参考图` 与 `下载` 都带上它，落盘文件的头部
  读出来就是那个 DPI（`tools/ps-check.mjs` 会拆落盘文件验证）。上传的图本来就带分辨率就沿用。
- **出口两个**：「设为参考图」把当前画面挂到输入区（转 dataURL 走 `/upload` 落盘，和预设卡同一条路），
  「下载」直接存本地文件。工具栏还给撤销 / 重做（最多 12 步快照），工具栏显示 `名字 · 尺寸 · DPI`。
- **进图两个**：工具箱里「上传本地图」/「从图库选」；空态和参数浮窗底部都留着入口，随时换一张。
- 原始图一直留着（参数浮窗底部「换一张」/「还原这张」），所有动作都是「原图 → 新画面」，不做原地破坏修改。
- 底图与选框分两层 canvas：拖选区时只重画选框那层，3000×4000 的图不会每个 pointermove 都重画一遍。
- 算法都是本文件里的纯函数（`psRotate` / `psStraighten` / `psRulerAngle` / `psHomography` /
  `psWarpPlan` / `psWarpCanvas` / `psFeather` / `psSplitTiles` / `psApplyDpi` / `psAdjustPixels` /
  `psVibrancePixels` / `psCurveLut` / `psCurveMove` / `psLevelsLut` / `psBoxBlurPixels` /
  `psSharpenPixels` / `psNoisePixels` / `psMaskAlpha` / `psMaskDims` / `psMaskedCanvas` /
  `psDrawLayers` / `psLayerExport` / `psLayerCommit` / `psLayerSessionStart` /
  `psLayerSessionExit` / `psMoveLayer` …）。
  `node tools/ps-check.mjs` 在真 Chrome 里跑真 canvas 验几何与像素：量改出来的宽高、红点搬到哪、
  羽化边缘的 alpha 有没有真的淡下去、歪 3° 的条纹能不能被估回 3°、写完 300 DPI 的文件头读出多少。
  调整与图层的纯函数不依赖 DOM，在 `node test\client.test.mjs` 里直接断言（曲线端点约束、
  色阶 LUT、蒙版 alpha、destination-in 合成、7 种叠加各叠几层、图层写回不动物件）。
  `node tools/ruler-check.mjs` 更进一步：把真的 `PsView` 挂进真 Chrome，在真画布上派发
  `pointerdown / pointermove / pointerup`，验「拖着的时候画面在转、松手就裁了、Esc 能撤」。
  `node tools/warp-check.mjs` 同一条路验四点矫正：造一张「梯形 + 四角色块」的图，量拉平之后的
  尺寸与四个角的颜色（还专门验「原图 (5,5) 是白的、拉平之后同一位置必须是内容」——证明几何真的动了），
  再把真的 `PsView` 挂进真 Chrome：进工具时四点就贴在图片最外圈（读数 = 整图 200 × 100）、
  拖角**拖到一半读数就变了**（`pointermove` 之后、`pointerup` 之前就断言，证明是实时的）、
  **拖到一半（`pointerup` 之前）画布里框住的那块已经是拉平后的内容**（按计划重采样后的像素误差 ≤3，和「没动过的原图」差 100、框外差 0）、松开不回弹、点空白不误触、拖到一半按 Esc 撤回；
  再验「参数栏里根本没有『应用』这个按钮」、切到「结果」侧主画布贴的就是拉平后的尺寸、
  切走工具自动落定（工具栏尺寸变成拉平后的大小、撤销从禁用变可用）、
  变形方式在结果侧拖橙四点把画面拉成形状（拉完左上角真的变透明），
  最后把角拖进对面三角形里（凹四边形）确认直接判死而不是给一张翻到外面去的乱图。
- **四点矫正的三种方式共一套投影变换**：八个角点解出一个 3×3 单应矩阵，输出画布逐像素反查源图
  （双线性采样，查不到的地方留透明）。`四点畸变` 的目标是自动算出的正矩形（对边取平均定尺寸）；
  `自由拉伸` 与 `变形` 的输出贴目标四点的外接矩形，四边形之外透明。三点共线 / 重合，或者四点凹进去 /
  交叉（单应矩阵会把画面翻到四边形外面去）都直接判死并提示，不会算出一张糊图。
- **实时预览与真画布走同一套几何**：拖动时不重画全分辨率 —— 输出压到屏幕比例（拖的时候封顶 720px）、
  源图先降采样到 1024px 缓存成代理，缩放在采样矩阵里合成（`psWarpPreview` 把两级缩放并进 `H`），
  松手再按屏幕比例补一张清晰的。放小窗口那张「实时」图已经不做了 —— 用户原话「直接在画布实时才对」：
  原图这一侧把结果按蓝四点的外接矩形贴回画布、并用蓝四点做裁剪，框里当场被拉平、框外一个像素都不动，
  跟结果侧主画布、落定后的真画布是同一份 `H`。`原图` / `结果` 是同一份计划的两个视图：
  主画布要么显示原图 + 蓝四点（取图），要么显示实时结果 + 橙四点（目标）——
  两者在输出空间里本来就重合，所以分成两视图而不是叠在一张图上。
- **落定不需要点按钮**：回车落定，换工具（或换图）也自动落定；四点没动过就不进历史（`psQuadsEqual`），
  所以点来点去不会塞一堆空撤销。

#### 「调整」（`U`）：四段各管一件事

打开调整后参数浮窗从上到下是四节，每节各有自己的「应用」；点一次应用就把结果写进当前画面、
压一份撤销快照，改坏了直接 `Ctrl+Z`。滑杆本身只改待应用参数，不动像素，所以不会拖一下刷一次图。

- **调整**：亮度 / 对比度 / 饱和度 / 自然饱和度（`-100…100`）、色相（`-180…180°`），外加灰度、
  反相两个开关；「复位」把参数清零。自然饱和度只抬不够艳的颜色、已经很艳的几乎不动，
  和普通饱和度不是一回事。
- **曲线**：256×256 的曲线空间，画的就是马上要应用的那张 LUT。**点空白处加点、按住点拖动、
  右键删点**（首尾两点不能删）；两端的控制点只能上下动（x 钉在 0 / 255），中间点被夹在左右
  邻居之间，不会把曲线拖回头。四个预设——提亮 / 压暗 / S 曲线 / 反相曲线——点一下替换形状，
  再点「应用曲线」写回像素。
- **色阶**：黑场（0–254）、白场（1–255）、中间调 gamma（0.1–4），先把 `[黑场, 白场]` 拉满再做
  gamma，「应用色阶」写回。
- **滤镜**：模糊（0–24px，可分离盒式两遍）、锐化（0–200，USM 简化版：原图 + 强度 ×（原图 − 模糊））、
  噪点（0–100，固定种子：同样参数每次的噪点图案一样）。三个滑杆共用「应用滤镜」，
  按模糊 → 锐化 → 噪点的顺序作用。

#### 图层：7 种叠加、每层蒙版、单层编辑

图层面板占画布右边那一列（就是原来参数栏的位置）：最上面是底图，下面每行是一层。

- **加图层**：「加图层」从图库挑一张，按当前画布尺寸铺成一层；列表顶行是最上层，按面板顺序
  从下往上合成。
- **7 种叠加算法**：正常 / 正片叠底 / 滤色 / 叠加 / 变暗 / 变亮 / 相加。走画布原生的
  `globalCompositeOperation`，逐层叠上去。
- **每层可调**：显隐（眼睛）、不透明度（0–100%）、上移 / 下移、删除。
- **每层一张蒙版**：有选区时点蒙版按钮 → 用选区当蒙版（选区里可见、框外藏起来）；没有选区
  就是整张可见。再点一次**反转**（黑白互换），旁边的 `×` 删掉蒙版。蒙版只动 alpha，
  合成时用 `destination-in` 把层乘一次蒙版 alpha，所以半透明蒙版也能用。
- **单层编辑会话**：点图层行进入编辑（面板上方出现「正在编辑图层「名字」」和「回到合成」），
  这时所有工具、撤销 / 重做作用的都是这一层，底图和别的层先不动；点「回到合成」把改完的
  画布写回该层（蒙版 / 叠加算法 / 不透明度 / 名字都保留），再换回原来的底图。
- **导出的就是看到的**：`下载` / `设为参考图` 在有图层时导的是「底图 + 可见图层」的合成图。
- **边界**：撤销 / 重做管的是当前画布上的像素与工具操作；加图层 / 删图层 / 改顺序 / 改叠加算法 /
  改不透明度 / 加删蒙版这些**图层结构操作不进撤销栈**，改之前先想清楚。

`node tools/preview.mjs` 另外出 `ps.png`（框选）、`ps-canvas.png`（画布 + 分辨率）、
`ps-zoom.png`（放大 200%）、`ps-focus.png`（专注画布）、`ps-keys.png`（快捷键表）、`ps-empty.png`（空画面）、`ps-ruler.png`（矫正拖线实时预览）、`ps-warp.png`（四点畸变：蓝四点框住歪着的画面）、`ps-warp-free.png`（自由拉伸：蓝橙两块四边形）、`ps-warp-distort.png`（变形：只拖橙四点）、`ps-dock.png`（窄栏羽化）。

### 结果图尺寸：按张数自适应

一轮生成出来几张，就用多大地方显示（以前不管几张都按 132px 小格排，单图也缩在一个格子里）：

| 这一轮的图 | 占画面宽度 | 效果 |
| --- | --- | --- |
| 1 张 | **最多 50%**（窄栏 62%） | 大图看得清细节，又不至于把对话顶满 |
| 2 张 | 各约 36% | 两栏收敛，并排看对比 |
| 3 张 | 各约 30% | 一行铺开 |
| 4 张及以上 | 回到 `minmax(132px, 1fr)` 小格自动排 | 多了就收，不抢对话的地方 |

实现是给 `.vig-grid` 按张数加 `is-single / is-duo / is-trio`（`data-count` 也留着给测试），
纯 CSS 网格、不量 JS、不挂 resize；右侧栏 compact 模式单独一套占比。真机量宽：单图 ≈ 0.5、
两张 ≈ 0.36（`tools/viewer-check.mjs` 量的就是这两个比例）。

### 图片查看器：点开就是大图

结果卡里的图和「图片管理」里的图都能点开查看器（图库卡片上也有一个「图片查看器」按钮）：

- **大图 + 缩放 + 平移**：滚轮缩放（20%–800%）、放大后拖拽平移、双击在「适应窗口 / 100%」之间切；
  顶部有 `− 比例 +`、适应窗口、键位提示和关闭（`Esc`）。
- **翻页**：同一轮生成的多张图 / 当前筛选下的整个图库就是一个列表，`←` `→` 或两侧箭头翻页，
  计数是 `当前 / 总数`。
- **过程一起看**：标题是文件名，下面一行是模型 · 尺寸 · 像素，再下面是这轮的提示词。
- **直接干活**：`用作参考图`（回对话区并挂上）、`图片处理`（进工具箱，图已载入）、`复制链接`、
  `打开原图`、`下载文件`；从图库打开时还有 `删除`（同时删文件）。
- **复制链接 ≠ 复制图片**：`复制链接` 给的是 URL 文本（贴到 PPT 里就是一串
  `dsh-app://app/api/…`）；要贴**图片本身**用 `复制图片`。
- **复制图片**：**宿主剪贴板优先** —— 写进去的是真图片位图（Electron `clipboard.writeImage`，
  拿不到 Electron API 时用 Windows PowerShell 的 `Clipboard.SetImage`），剪贴板管理器里看到的就是
  缩略图，PPT / 文档里 Ctrl+V 贴出来是图。网页剪贴板（`ClipboardItem` + `canvas` 转 PNG）只当兜底：
  它在 `dsh-app://` 页面里常常写不进图片，反而会留下上一次的 URL 文本（踩过）。
  > 以前「复制图片」只走网页剪贴板 → 剪贴板里留的是旧文本/URL，看起来像没复制图片。
  现在的顺序是：宿主剪贴板 → 网页剪贴板 → 再试一次宿主端点，每步失败才往下退。
- **下载文件**：`下载文件` 用 `blob + <a download>`（纯前端，旧宿主也能用）把图存进系统
  「下载」文件夹 —— 拿到文件后从资源管理器拖进 PPT 是最稳的一条路。
- **保存到本地**：`保存到本地`把图库原图复制进「保存目录」（默认
  `%USERPROFILE%\Downloads\velapi-image-go`，可用 `saveDir` 配），提示条给出完整落盘路径；
  同名不覆盖（落成 `-1`/`-2`）。需要新版宿主。
- 键位：`Esc` 关、`←/→` 翻页、`+/-` 缩放、`0` 适应窗口 —— 输入框里打字时不拦。
- **四点变形（角点不限制在图内）**：工具条上的「四点变形」进入变形模式，图像四角摆出
  四个手柄，**拖到哪都行 —— 拖出图外、拖成负值也不拦**；应用时按四点求单应矩阵做透视变形，
  输出画布取四个角的外接矩形（结果可以比原图大、带透明边）。凹四边形解不出透视会明确拒绝，
  Esc 只退变形模式不关查看器；结果自动上传成新库图（`原名_四点变形.png`）并在查看器里打开。

### 快捷拖拽：一张图拖到哪都能用

结果卡、图库卡片都是可拖的。拖起来的图同时带这几种数据：

| 拖到哪 | 会发生什么 |
| --- | --- |
| 对话输入区（`.vig-composer`） | 读回字节 → `POST /upload` → 挂成参考图（和粘贴 / 上传同一条路） |
| 「图片处理」画布 | 载入工具箱当底图（走既有 `text/uri-list` 那条拖入路径） |
| **拖到 PPT / 桌面 / 资源管理器** | 宿主支持时**直接就是真图片文件**：dragstart 里同步打 `POST /drag/native`，宿主 Electron 主进程用 `webContents.startDrag` 拉起原生拖拽（网页侧自己做不到这件事）。**不用按 Shift** |
| 宿主不支持原生拖拽 / 老宿主 | 退回 HTML5：`DownloadURL` 优先本地 `file://`、`text/html` 给富文本目标；目标不认文件时会显示成一串 URL，此时用「保存到本地」/「复制图片」。头部会有胶囊提示（「宿主旧版本 · 重启 DSH 生效」或「拖出不可用 · 用复制图片」） |
| 富文本目标（笔记 / 文档） | 另带 `text/html`（`<img src=…>`），直接嵌图而不是贴 URL |

自定义类型 `application/x-velapi-image` 里带 `url / name / assetId`，接收端优先认它，
认不出再看 `text/uri-list`；拖进浏览器别的窗口也能当普通链接/图片处理。

### 素材目录：默认在本地，可改

生成出来的图默认落在本地（`$DSH_HOME/state/velapi-image-go`，图库在 `library/`，参考图在
`uploads/`），「供应商管理 → 素材目录」里能看当前路径、改到别的盘、或者一键「打开目录」：

- **换目录会搬家**：宿主把现有 `library/`（索引 + 原图）、`uploads/`、`jobs/providers/presets/
  notes/catalog` 复制到新目录（**不覆盖**新目录里已有的同名文件，旧目录原样保留），然后立刻切换，
  不用重启；提示条会报「复制了多少文件、多少份索引」。
- **换目录前先校验**：目录建不出来 / 写不进去（只读盘、不存在的盘符）当场 400；
  有任务在跑时不允许换（避免任务还在写旧目录、界面已经指向新目录）。
- **重启也记得**：指针写在默认目录的 `location.json` 里（`{ "stateDir": "D:\\素材" }`）——
  `config.json` 自己会跟着素材搬走，拿它当指针的话重启会先回默认目录读旧配置，改动就丢了。
- `POST /state/reveal` 让宿主在系统文件管理器里打开当前目录（宿主跑在 Electron 主进程里，能开）。

## 注册到 profile

三个动作，缺一不可：

```powershell
# 1) 软链进 profile 的 node_modules
$link = 'C:\Users\Administrator\.dsh\profiles\desktop\node_modules\dsh-plugin-velapi-image-go'
New-Item -ItemType Junction -Path $link -Target 'C:\Users\Administrator\.dsh\local-plugins\dsh-plugin-velapi-image-go'

# 2) profile/package.json 的 dependencies 里加一行
#    "dsh-plugin-velapi-image-go": "link:C:/Users/Administrator/.dsh/local-plugins/dsh-plugin-velapi-image-go"

# 3) profile/cordis.patch.yml 里插一条 loader 条目（见下）
```

```yaml
- insert:
    - id: velapi-image-go
      name: dsh-plugin-velapi-image-go
      config:
        surfaces: [rightbar, overlay, settings]
        baseUrl: https://gank.velapi.cc/v1
        apiKey: SK-xxx
        defaultModel: nano-banana-2.1
```

> **只注册一次**：同一个 loader 条目 id 要么由 `dsh.profile.bundles` 插入，要么由一条
> `insert` 插入，两处都写会撞 `assertUniqueEntryIds`（硬启动错误）。
> 宿主半边是 `patchReload: live`，改完 patch 立刻生效；浏览器半边需要刷新一次 GUI。

## 配置

| 字段 | 默认 | 说明 |
| --- | --- | --- |
| `surfaces` | `[rightbar, overlay, settings]` | 落点开关 |
| `baseUrl` | `https://api.velapi.cc/v1` | 上游根（含 `/v1`） |
| `apiKey` | 空 | 内联密钥，优先级最高 |
| `apiKeyEnv` | `VELAPI_API_KEY` | 没有内联密钥时读的环境变量 |
| `defaultModel` | `nano-banana-2.1` | 默认模型（中转站偏好的名字，见下） |
| `defaultSize` / `defaultQuality` / `defaultCount` | `1024x1024` / `LOW` / `1` | 新会话默认参数 |
| `concurrency` | `3` | 同时在飞的生成任务（接口上限 20） |
| `timeoutMs` | `300000` | 单次上游超时；生图 40~90s 是常态 |
| `stateDir` | `$DSH_HOME/state/velapi-image-go` | **素材目录**（默认本地；界面里可改，换目录时现有素材会复制过去） |
| `saveDir` | `%USERPROFILE%\Downloads\velapi-image-go` | **保存目录**（查看器「保存到本地」落这儿；同名不覆盖，落成 -1/-2） |
| `chatModel` | 空（自动） | **对话模型**（上下文管理用；空 = 目录里第一个 chat 模型） |
| `contextTurns` | `6` | 喂给对话模型的最近轮数（0–12） |
| `guideOrder` | `30` | 席位排序 |

运行期在「供应商管理」里改的值写进 `stateDir/config.json`，**优先级高于 patch**，
所以 profile 里那份配置只当出厂默认值用。

## HTTP 端点

全部挂在 `/api/velapi-image-go` 前缀下（比 `/api` 更长，稳定赢过 RPC 面的前缀路由）：

| 方法 | 路径 | 作用 |
| --- | --- | --- |
| GET | `/status` | 一次拿全：配置（密钥打码）、计数、落盘目录、**端点协议表**（`protocols`）、**工具注册状态**（`tool.registered` / `tool.reason`） |
| GET/POST | `/config` | 读 / 改运行期配置 |
| GET/POST | `/providers`、`/providers/delete`、`/providers/test` | 供应商增删改查 + 测试连接（每条带 `endpoint` 协议、`endpointLabel`、`endpointRoute`） |
| GET | `/models`、POST `/models/refresh` | 模型目录（带缓存） |
| POST | `/generate` | 入队一次生成（`mode: generate\|edit`，可带 `source` / `sessionId` 留痕），立刻返回 job |
| GET | `/jobs`、`/job?id=` | 任务历史 / 单条轮询 |
| POST | `/job/cancel` | 取消（在队列里摘掉，或 abort 上游请求） |
| POST | `/job/delete` | 删除任务记录（`ids: []`；只删记录，图库素材不动） |
| GET | `/jobs?conversationId=` | 按会话取任务（不带 = 全部） |
| GET/POST | `/conversations` | 列出 / 新建对话（会话 = 独立记忆，落 `conversations.json`） |
| POST | `/conversations/rename`、`/conversations/delete` | 重命名 / 删除（删除连带删掉该会话的任务记录） |
| POST | `/chat/plan` | 对话上下文管理：本会话最近几轮 + 这句话 → 对话模型整理成 `{prompt, mode, referenceUrl, reason}` |
| GET | `/library` | 图库检索（`q` / `model` / `limit` / `offset`） |
| POST | `/library/rename`、`/library/delete` | 重命名 / 批量删除（同时删文件） |
| POST | `/upload` | 收参考图（base64） |
| GET | `/notes`、POST `/notes`、`/notes/delete` | 信息管理（提示词 / 元信息） |
| GET | `/presets`、POST `/presets`、`/presets/delete`、`/presets/reset` | 预设卡（标题 / 提示词 / 参考图），reset 把删掉的内置卡补回来 |
| GET | `/preset/<file>` | 内置预设卡的参考图（随包 PNG，只认文件名规则） |
| GET | `/asset/<file>`、`/upload/<file>` | 出图字节（文件名白名单 + 目录内校验） |
| GET/POST | `/client-report` | 浏览器半边的自检回执（报障取证用，留最近 12 条） |
| POST | `/state/reveal` | 在系统文件管理器里打开素材目录（`dir` 可指定，缺省当前） |
| POST | `/asset/export` | 把图库原图复制到保存目录（`files: [文件名]`），返回落盘路径 |
| GET | `/asset/local?file=` | 图库原图的本地绝对路径与 `file://` URL（拖出到资源管理器时用） |
| GET | `/capabilities` | 宿主能力表：`electron` / `nativeDrag` / `clipboard`（前端据此决定 Shift+拖 与复制图片，老宿主 404 时按不可用处理） |
| POST | `/drag/native` | 让宿主 Electron 主进程拉起**原生拖拽**（`file`；Shift+拖用；非 Electron 宿主回 501） |
| POST | `/clipboard/image` | 把图库原图写进**系统剪贴板**（`file`；查看器「复制图片」用；非 Electron 宿主回 501） |

任务里的 `errorDetail`：上游失败时随任务一起落盘，界面直接摆出来（HTTP 状态 / 响应体原文 /
实际请求地址 / 模型），不需要再去翻日志。`endpoint` 是这次实际打的那条路由。

**图生图（`mode: "edit"`）走 `/images/edits`，请求体是 `multipart/form-data`**（`image` 是文件字段，
`model / prompt / n / size` 是普通字段）—— 这是 OpenAI 那套接口的硬要求，塞 JSON + base64 会被
上游回 `400 image file or image_url is required`。三个补齐：

- 只给 `referenceUrl`（本站 `upload/` 或 `asset/` 路径）也行：宿主会把字节读回来再发 multipart
  —— 失败任务的「用这条提示词重试」就靠它（历史里只留缩略图 URL）。
- 协议选了「图片编辑」但**没带参考图**：宿主自动回落 `/images/generations`，不发注定 400 的请求。
- 界面侧：挂了参考图 + 输入框那一行选「图片编辑」，生成时就会带 `mode: edit` + 参考图字节，
  不再只发文字。

## 开放接口：对话里直接出图，外部程序也能灌图

生图这件事本身只有一条链路（入队 → 打上游 → 落盘 → 图库），三张嘴都通向它：

| 入口 | 谁在用 | 怎么进来 |
| --- | --- | --- |
| 工作台 | 人 | 输入框 → `POST /generate`（`source: "ui"`） |
| **DSH 工具** | 对话里的模型 | 直接调 `generate_image`（`source: "tool"`） |
| **HTTP** | 外部程序 / 脚本 | `POST /api/velapi-image-go/generate`（不加 `source` 时记 `api`） |

### DSH 工具 `generate_image`

宿主半边向 `ctx.tools` 注册一个工具，名字 `generate_image`。注册成功与否对外可见，
不用猜：

```powershell
curl.exe -s http://127.0.0.1:<端口>/api/velapi-image-go/status
# → "tool": { "name": "generate_image", "registered": true, "reason": "" }
```

`registered: false` 时 `reason` 直接写原因（`宿主没有 tools 服务` /
`解析不到 @deepseek-ai/dsh-tools 的 defineTool` / 注册抛错的原文），照着一行修就行。

参数（全部可选，只有 `prompt` 必填）：

| 参数 | 说明 |
| --- | --- |
| `prompt` | 画什么。原样跟着素材一起落盘，不截断、不改写 |
| `model` / `size` / `quality` / `n` | 覆盖这次生成的参数，缺省用工作台当前配置 |
| `providerId` | 指定供应商，缺省用当前激活的那条 |
| `protocol` | `auto` / `images_generations` / `images_edits` / `videos_generations` |
| `referenceUrl` | 本站的参考图地址（`/api/velapi-image-go/upload/…` 或 `/asset/…`），用来图生图 |

返回的是一个**等到底**的结果，不是一个 task id —— 工具调用要么拿到图，要么拿到原因：

```json
{
  "ok": true,
  "jobId": "job_...",
  "status": "succeeded",
  "prompt": "一只戴眼镜的猫",
  "model": "nano-banana-2.1",
  "size": "1024x1024",
  "protocol": "images_generations",
  "sessionId": "…",
  "elapsedMs": 41230,
  "assets": [{ "assetId": "img_...", "url": "/api/velapi-image-go/asset/img_...png", "width": 1024, "height": 1024, "bytes": 123456, "remoteUrl": "" }]
}
```

失败时 `ok: false`，`error` 是上游原始说法，`errorCode` 是归类
（`missing_api_key` / `upstream_empty` / `upstream_no_image_field` / …），
不带半张假图。

> **改动了宿主半边要重启**：`lib/index.js` 和 `package.json` 是宿主代码，改完必须
> 重启 DSH 才生效（浏览器半边才是热载）。重启后先看 `/status.tool.registered`。
>
> 不想等重启也能先验：`node tools/tool-probe.mjs` 会从 DSH 的 `app.asar` 里抠出**真的**
> `@deepseek-ai/dsh-tools`（依赖用最小桩补上），按宿主同一条 fallback 路径让
> `loadDefineTool()` 找到它，再挂最小 ctx 真跑一遍 `apply()`：注册上来的定义、参数 /
> 输出 schema、`presentCall`、`execute()` 等到底拿图、图库索引里的 `source=tool` 留痕、
> `/status.tool.registered` 一共 13 项，全绿才算这条链通。

### 过程留痕：素材和「怎么来的」存在一起

一次生成的过程写在两个地方，都是磁盘上的 JSON，重启不丢：

- **任务** `stateDir/jobs.json`：`prompt` / `revisedPrompt` / `model` / `size` /
  `quality` / `count` / `protocol` / `endpoint`（这次实际打的路由）/ `source` /
  `sessionId` / `elapsedMs` / `errorDetail`；
- **素材** `stateDir/library.json`：每张图除了 `sha256` / 尺寸 / `remoteUrl`，还带
  `prompt` / `model` / `size` / `quality` / `jobId` / `source` / `sessionId`。

所以「这张图是哪句话生的、走的哪条协议、是界面点的还是对话里调的」可以直接从图库
反查，不需要另存一份日志。参考图的 base64 只在这一次请求里活着，任务落到历史记录时
已经删掉，历史里只留参考图的 URL（缩略图用）。

### 外部程序直接打（走的是同一条队列，同一个并发上限）

```powershell
$port = 53247  # 每次重启都会变，取 GUI 地址栏那个
$body = @{
  prompt   = "赛博朋克风格的城市夜景"
  model    = "nano-banana-2.1"
  size     = "1024x1024"
  n        = 1
  endpoint = "auto"
  source   = "api"          # 可选：ui / tool / api
  sessionId = "my-batch-01"  # 可选：自己的批次号，方便回查
} | ConvertTo-Json

$job = curl.exe -s -X POST "http://127.0.0.1:$port/api/velapi-image-go/generate" `
  -H "Content-Type: application/json" -d $body | ConvertFrom-Json
$job.job.id
# 轮询这条任务（生图 40~90s 是常态）
curl.exe -s "http://127.0.0.1:$port/api/velapi-image-go/job?id=$($job.job.id)"
```

`/generate` 立刻返回（不占着连接等上游），之后靠 `/job?id=` 轮询或直接看
「图片管理」——两条路看到的是同一份 `library.json`。

## 「协议选不动」是怎么修的

症状：在输入框那一行选了「图片编辑」，关掉下拉再打开又回到「自动检测」。

根因不在下拉，在保存那条路：宿主那半边只有**重启后**才认识 `config.defaultEndpoint`，
老宿主收到 `POST /config` 会把不认识的字段丢掉，回一份**没有**该字段的 config；
界面当时是 `setConfig(payload.config)` 直接覆盖 —— 用户刚选的值被回包冲回默认。三处一起改：

1. **乐观更新**：`saveConfig` 先把 patch 落到本地（`{...previous, ...patch}`），再去请求宿主；
2. **合并回包**而不是覆盖，且 `defaultEndpoint` 缺失时保留本地值（老宿主、请求被吞都兜住）；
3. **本地留一份**（`localStorage`）：换端口会清 origin 的存储，但同一会话里刷新一定还在。

宿主重启后（`/status` 带上了 `config.defaultEndpoint`）就以宿主为准，这三层自然退居兜底。

## 上游报错：原样摆出来

中转站失败时给的那句话（例：「生成请求失败，请查看具体上游错误」）是它自己的总结，
真正能定位问题的是 **HTTP 状态 + 响应体原文 + 实际打的那条地址**。这三样现在都在：

- 宿主：`callUpstream` 失败时挂 `error.detail`（`status / statusText / code / url / model / body`），
  超时、连不上（`cause`）、下载失败、非 JSON、返回里没有图片字段，各自都有对应的 `kind`；
  任务记录里落成 `job.errorDetail`，任何一次 `/job?id=` 轮询都能拿到。
- 界面：**失败的那条气泡里就一张卡** —— 左上是状态 chip（`HTTP 502 Bad Gateway`），
  右边是「用这条提示词重试 / 复制报错」，下一行是实际请求（`POST https://…/v1/images/generations`
  + `code` + 模型），再下面是响应体原文。有证据才摆这几行；**老任务（没有 `errorDetail`）只占一行**，
  不摆空的请求行、也不硬凑一句「上游没给响应体」——一张卡说清一件事，不叠三层红框。
  输入框那一行只放参数，不摆报错。
- 老任务没有 `errorDetail` 也不装样子：只有一句话就说「上游没给响应体」。

## 端点协议：生成打哪条路由，输入框那一行说了算

「对话生图」输入框那一行（模型 / 尺寸 / 张数后面）多了一个协议选择，选项照中转站那张表，
再补生图这条链要用的三条：

| id | 路由 | 说明 |
| --- | --- | --- |
| `auto` | — | 自动检测（默认）：带参考图走 `/images/edits`，不带就走 `/images/generations` |
| `images_generations` | `POST /v1/images/generations` | 文生图 |
| `images_edits` | `POST /v1/images/edits` | 图生图 / 编辑（带参考图与可选 mask） |
| `videos_generations` | `POST /v1/videos/generations` | 视频：上游返回任务体，原样收下展示，不假装出片 |
| `openai_chat` / `openai_responses` / `openai_responses_compact` / `anthropic_messages` / `gemini_generate` / `jina_rerank` / `embeddings` | 各自路由 | 中转站那张表里的其余选项，先记录后使用 |

- 选择落进 `config.defaultEndpoint`（跟着 `config.json` 跨更新活着），每次 `/generate` 都带上。
- 取舍顺序：**这次请求里写的 > 输入框那一行选的 > 供应商记录 > 自动检测**。
  「自动检测」是缺省值，不压过上层任何更明确的选择 —— 否则在行里选了「图片编辑」，
  却因为供应商记录里留着 auto 而静默失效。认不出的值一律回落，不把生成打死。
- 供应商那条记录只负责地址 / 密钥 / 模型，**不再有协议字段的入口**（同一件事只有一个家）。
- 下拉里显示短名（图片生成 / 图片编辑 / 视频生成…），鼠标停一下的 title 给全名与路由。
- 协议表由宿主 `/status` 下发，界面只做兜底 —— 两边 id 必须一致，宿主测试卡着这条不变量。

## 入口：只挂在宿主的公开 slot 上

**这条是最终的形态**（前面那些「等席位 / 防守卫」都是这一条的补丁，现在只当可选项保留）：

| 入口 | 落点 | 性质 |
| --- | --- | --- |
| 左侧栏底部那颗「✦ 生图工作台」（**唯一入口**） | `sidebar.footer.action` | 点它 = `ctx.sidebarRight.openTab(kind)`，打开右侧栏里的工作台 tab |
| 工作台本体（**右侧栏里的一个 tab**） | `sidebarRightTabs`（`exports.inject` 里静态声明） | 就是右上角展开的那个侧边栏 —— 和「工作区文件 / 终端 / 浏览器」并排，不盖住对话区 |
| 设置页里的「生图工作台」 | `settings.section` | 宿主公开 slot，最后的保底入口 |

三处全是 `ctx.slots.inject` + `ctx.slots.register`（模板里的标准写法），**不读别人的 DOM、不碰别人的内部服务**，
所以别人升级、改守卫、改名字都影响不到它。入口按钮本身只用 `inherit` + 兜底色值，
在宿主的侧栏里看起来就是宿主自己那一排控件的一家人（见 `docs/preview/launcher.png`）。

右侧栏 tab 那条路（`sidebarRightTabs`）现在是**可选项，默认关闭**：它要等
`ui-sidebar-right` 的席位，而那个服务是别人家的内部实现 —— 想开就在 `surfaces` 里加回 `rightbar`。
即使开了，那里的每一次服务访问也包在 try/catch 里（守卫抛异常只当「还没到货」），
它的成败不再影响上面四条入口。

## 「重启后工作台入口不见了」是怎么修的

症状：DSH 重启后左侧栏那颗「生图工作台」不见了，刷新界面也回不来。两个独立缺陷叠在一起：

1. **等错了东西**。右侧栏那个席位（tab 类型 + 开始页那张卡）由 `@deepseek-ai/dsh-client-ui-sidebar-right`
   提供，而它自己要等 `slots / layout / locale / resources / sessions / uiSession / shortcuts`
   七个服务才激活；我们只等 `slots`，**激活得比它早**。旧代码用一次性
   `ctx.get("sidebarRightTabs")`，拿不到就静默跳过 —— tab 类型和开始页那张卡一起没登记，
   右侧栏重启后停在开始页，一个入口都不剩。现在改成
   `ctx.inject(["sidebarRightTabs"], (scoped) => registerRightbar(scoped))`：晚到也补上，
   补上之后再发一次回执。
2. **入口判据太乐观**。宿主对注册时写了 `keepMounted` 的 tab 会一直挂着；旧代码只认
   `mounted && visible`，可几何量会说谎（过渡动画、视口外、被别的层盖住）。一旦说谎，
   停靠面板和入口胶囊一起收起来 —— 又是「一个入口都没有」。现在多一路
   `onScreen`（IntersectionObserver 认过才算），判据故意偏向「没在屏幕上」：
   拿不准就多露一个入口胶囊，绝不让位。

顺带对齐 DSH 自己的插件模板：`package.json` 的 `dsh.client` 加 `immediately: true`，
`inject` 里改成真实存在的条目名（`dsh-client-ui-layout` / `ui-sidebar-right` / `ui-settings`；
以前写的 `dsh-client-runtime`、`dsh-client-ui-slots` 是模块名不是条目名，条目级依赖找不到
只会跳过，所以这个错一直没吭声）。

### 第二次复发：`immediately` 撞上新版守卫

上了 `immediately: true` 之后入口又消失过一次（DSH 更新到新版那次）。版本里的 cordis 给服务访问
加了守卫：**服务还没注册时 `ctx.get(name)` 不是返回 `undefined`，而是直接抛**
`cannot get property "sidebarRightTabs" without inject`。而 `immediately` 让本插件激活得**更早**，
于是那一抛发生在 `registerRightbar` 的第一行 —— 异常逃出去，`if` 块直接跳到 `catch`，
**后面「等 `ctx.inject` 到货」那条路根本没走到**，tab 类型和开始页那张卡一起没登记。

现在这一层是这样：`registerRightbar` 里**每一次服务访问都包在 try/catch 里**（守卫抛异常只当成
「还没到货」，返回 `false`），失败了就挂 `ctx.inject(["sidebarRightTabs"], …)` 等它，**外加一层
有界重试**（0.5s 起、翻倍、最多 8 次）兜住「`inject` 回调没被接上」这种情况。探针被拒的原文
（`rightbarProbeError`）和尝试次数（`rightbarAttempts`）都会随回执落盘 —— 下次再出问题，
`client-report.json` 里直接写着卡在哪一步。

**取证通道**：浏览器半边在 `apply` 之后和落定后各发一次 `POST /client-report`，内容含
落点结果、`sidebarRightTabs` 到底有没有、面板三态、以及页面实况（胶囊 / 面板 / 席位 / 开始页卡片的 DOM 命中数），
落盘 `stateDir/client-report.json`。控制台里也能手发：`__velapiImageGo.report()`、`__velapiImageGo.snapshot()`。

> 浏览器半边的改动刷新页面即生效；`package.json` 和宿主半边的改动要**重启一次 DSH**。

## 落盘

```
$DSH_HOME/state/velapi-image-go/
├── config.json          运行期配置（0600）
├── client-report.json   浏览器半边自检回执（最近 12 条）
├── providers.json       供应商
├── catalog.json         模型目录缓存
├── notes.json           信息管理记录
├── presets.json         预设卡（首次启动种 8 张趣味内置卡，之后随便改）
├── jobs.json            任务历史（保留最近 200 条）
├── library/index.json   图库索引
├── library/files/*      图库原图
└── uploads/*            上传的参考图
```

## 测试

```powershell
cd C:\Users\Administrator\.dsh\local-plugins\dsh-plugin-velapi-image-go

# 宿主半边：122 项离线（路由、参数校验、图库、路径穿越、上传、预设卡、模型目录元数据、自定义键位落盘、工具注册状态、模型→供应商选路、密钥与接口地址不匹配的解释、编辑供应商不抹 key）
$env:VIG_KEY = '<key>'; node test/host.test.mjs

# 再追 5 项真图（真调上游，40~90s；确认端到端产出、落盘、可取回）
$env:VIG_MODEL = 'nano-banana-2.1'; node test/host.test.mjs --live

# 浏览器半边：397 项（bundle 自注册形态、公开落点上的固定入口、右侧栏注册契约（可选项）、真 React 渲染、模型分类与供应商标记、模型→供应商选路、预设卡、图片处理、调整四段（调整 / 曲线 / 色阶 / 滤镜）、图层与蒙版、单层编辑会话、滚轮缩放与分辨率、两侧按需收起、快捷键（含自定义与组合）、空画面出口、PS 式标尺矫正、四点透视矫正、停靠入口可见性（含新版守卫那一档）、上游报错原样展示（含「key 和接口地址不是一家的」那句人话）、结果卡（图片一张卡 + 三个纯文字动作）、端点协议、Ctrl+V 粘图、参考图小卡与额头提示条、一轮对话两条（含参考图缩略图、来源留痕）、卡住不转圈、配置乐观更新、样式闸门）
node test/client.test.mjs

# 纯像素引擎离线测试：调整 / 曲线 LUT / 色阶 / 模糊锐化噪点 / 蒙版 alpha / 7 种叠加（不需要浏览器）
node test/engine.test.mjs

# 重启复演：对着同一份 bundle 走「加载契约 → 服务到货后登记 → 服务没到也不炸」三步
node tools/restart-rehearsal.mjs --port 59047

# 重启/刷新后自动判定：只读 client-report.json（不依赖端口），等到新的 apply 就给结论
node tools/restart-watch.mjs --timeout 600

# 「配置改不动」真机回归：挂真 Workbench + 故意不认 defaultEndpoint 的假宿主，
# 验选一次协议留得住、POST 带得出去、本地也记一份（老宿主 + 刷新照样在）
node tools/config-check.mjs

# 「模型属于谁就打到谁那儿」真机回归：挂真 Workbench + grok / GPT 两条假供应商，
# 验「当前供应商空着、模型是 GPT 的」生成时 providerId 也发 GPT；换模型顺手切当前供应商
node tools/route-check.mjs

# 工具箱真机检查：Chrome headless 里跑真 canvas，量每个动作改出来的像素与尺寸
node tools/ps-check.mjs

# 曲线 / 蒙版真机检查：真 DOM 里拖曲线控制点（加点 / 删点 / 夹在邻居之间），
# 真 canvas 上验 destination-in 蒙版合成、蒙版 + 不透明度、三种叠加组合
node tools/curve-mask-check.mjs

# 撤销/重做真机检查：挂真 PsView，点真按钮做旋转 / 调整，再点撤销看尺寸与像素有没有回去
node tools/undo-check.mjs

# 工具探针：从 app.asar 抠出真的 @deepseek-ai/dsh-tools，验 generate_image 注册 / 执行 / 留痕
# （不重启 DSH 也能先确认宿主那条链通；会写临时目录，不碰插件 state）
node tools/tool-probe.mjs

# 查看器 / 拖拽 / 素材目录真机检查：点结果卡图片开查看器、←/→ 翻页、滚轮缩放、Esc 关闭；
# 拖起图看 dataTransfer 三种数据、丢进输入区真走 /upload；供应商页改素材目录打 /config(stateDir)
node tools/viewer-check.mjs
# 想截一张查看器的图：node tools/viewer-check.mjs --shot C:\temp\viewer.png

# 鼠标实时矫正的真机检查：Chrome 里挂真组件、派真 pointer 事件，看拖动时画面转不转、松手裁没裁
node tools/ruler-check.mjs

# 四点透视矫正的真机检查：真 canvas 上量拉平后的像素与尺寸，真画布上拖角点（实时、无应用、凹四边形判死）
node tools/warp-check.mjs

# 停靠入口可见性的真机检查：display:none 的「挂载但看不见」宿主必须让胶囊露出来，
# 视口外那种「几何量说看得见、其实没在屏幕上」的宿主也一样，谁都不许把入口收没
node tools/dock-check.mjs
# （同一条命令里也验：公开落点那颗「生图工作台」按钮点了真能打开停靠面板）

# Ctrl+V 粘图的真机检查：Chrome 里派真 ClipboardEvent + 真 DataTransfer，
# 看挑图、读图、挂参考图、拦不拦默认行为、焦点停在参数下拉里也粘得上
node tools/paste-check.mjs

# 活着的 GUI 体检（只读）：构图里本插件的 rev/inject、三个席位作者在不在、
# 当前真正被服务的那份 client.js 里关键逻辑在不在、宿主端点落点。
# 端口填当前 GUI 地址栏那个（每次重启都会变；下面这个只是本机当前的值）
node tools/live-check.mjs 53247

# 预览：各视图静态页 + Chrome 截图（含右侧栏开始页那张卡片）
node tools/preview.mjs
node tools/guide-preview.mjs

# 适配性：320→1280 共 15 个宽度，量 scrollWidth 有没有溢出（窄容器必须为 0）
node tools/fit-check.mjs
```

本轮实测（2026-10-19，Node v24.16.0，Windows）：

- 宿主：`node test\host.test.mjs` **122/122** 通过。
- 浏览器：`node test\client.test.mjs` **397/397** 通过。
- 纯像素引擎：`node test\engine.test.mjs` **133/133** 通过（调整 / 曲线 / 色阶 / 滤镜 / 蒙版 / 叠加）。
- 适配：`node tools\fit-check.mjs` **15/15** 个宽度 0 溢出；模型弹层 **5/5** 不越出卡片；
  工具箱三栏/折行 **5/5** 不溢出；协议那一行 **4/4** 不溢出（320px 窄栏里 11 个选项一个不少）。
- 工具箱真机 canvas：**65/65**（旋转换边、裁切原点、切割铺满、画布锚点、羽化 alpha 斜坡、
  歪 3° 估回 3°、300 DPI 写进 PNG 头再读回 300）。
- 鼠标实时矫正：**11/11**；四点透视矫正：**39/39**；停靠入口：**13/13**；粘贴图片：**10/10**；
  配置改得动：**6/6**；模型选路真机：**11/11**；重启复演：**6/6**；曲线 / 蒙版真机：**6/6**；撤销/重做真机：**17/17**；
  状态审计（几何联动 / 历史快照 / 变形几何）：**25/25**；工具探针（真 dsh-tools 注册 + 执行 + 留痕）：**13/13**；
  查看器 / 拖拽 / 素材目录真机：**44/44**。
- `--live` 真图 5 项：**未跑**——需要真实 `VIG_KEY` 与上游，单次 40~90s；命令照上面那条。
- `node tools\restart-watch.mjs --timeout 600`：**已跑但没有结论**——600s 内没等到新的 apply
  （当时没有重启 DSH / 刷新 GUI）。这条是「挂着等一次重启」的观察器，不是一次性检查。
- 活 GUI 体检：`node tools\live-check.mjs 53247` 连上了当前 GUI，`/status` 与 `/client-report`
  都返回 200，清单逐条「有」。
- `node tools\preview.mjs` / `node tools\guide-preview.mjs`：**未跑**——它们会重写
  `docs/preview/` 下的静态页与截图，不在本次改动范围。

## 排障

- **图生图回 `400 image file or image_url is required`（`/images/edits`）**：这条接口是 OpenAI 的
  「文件上传」形态，**必须 `multipart/form-data`**；以前我们和普通生成一样发 JSON + base64，
  上游拿不到文件字段就 400。现在编辑请求统一走表单（`image` 是文件字段）；真上游实测：
  JSON 版本复现 400，multipart 版本 200 出图（我们自己的宿主链路端到端 62.7s / 1254×1254）。
  另外两条兜底：只给 `referenceUrl` 时宿主从 `uploads/` 读回字节（失败任务「重试」可用）；
  选了编辑协议却没带参考图时回落 `/images/generations`。
- **拖到 PPT / 桌面 / 资源管理器不落文件（变成一串 URL 或干脆没反应）**：先看**头部胶囊**——
  - 「**宿主旧版本 · 重启 DSH 生效**」：拖拽用的是宿主侧能力，`/capabilities`、`/drag/native`
    这些端点只有新版宿主才有。**关掉 DSH 再打开**（只刷新页面不够），刷新后胶囊消失、拖到 PPT
    直接是图片文件。实测旧宿主上 `/capabilities` 就是 404。
  - 「**拖出不可用 · 用复制图片**」：宿主是 Electron 但插件拿不到 `webContents.startDrag`
    （被沙箱限制），此时拖不出文件，用下面两条兜底。
  兜底（**都不依赖原生拖拽**）：
  1. **复制图片**（推荐）：查看器里点「复制图片」，**宿主剪贴板**（Electron `clipboard.writeImage`，
     拿不到 Electron API 时自动改用 Windows PowerShell `Clipboard.SetImage`）把图片位图写进系统
     剪贴板，剪贴板管理器里是缩略图、PPT 里 Ctrl+V 直接贴图。如果你之前贴出来是一串 URL，那是点了
     「复制链接」；如果剪贴板里只有文本，说明宿主还是旧版（旧版没有 `/clipboard/image` 的
     PowerShell 兜底）—— 重启 DSH 后它就写图片位图了。
  2. **下载文件**（旧宿主也能用）：把图存进「下载」文件夹，再从资源管理器拖进 PPT。
  3. **保存到本地**：复制进保存目录并给出完整路径，然后从文件夹拖进 PPT。
  （原生拖拽可用时：dragstart **同步**打 `POST /drag/native`，宿主用 `webContents.startDrag`
  拉起真文件拖拽，完成后压掉 HTML5 拖拽；不可用时自动退回 HTML5 + `file://` `DownloadURL`。）
- **测试连接 / 生成回 `invalid access key`，但 key 确实没抄错**：九成是**key 和接口地址不是一家的** ——
  一条供应商记录 = 一个 baseUrl + 一把这个站发的 key。拿 A 站发的 key 去问 B 站，B 站只会回
  401 `invalid access key`（本站自己的 key 格式都一样，看不出区别）。
  现在两条路都会把这句话摆出来：
  - 供应商弹窗里点「测试连接」，结果**留在弹窗里**（成功：连上 + 模型数 + 耗时；失败：上游原话 +
    `GET …/models` 的地址与状态码）。401/403 时宿主还会拿这把 key 去问**本地已经配置过的**其它
    baseUrl（不碰没配过的站），谁认它就说：「这把 key 在 `https://api.velapi.cc/v1` 上可用
    （61 个模型），在 `https://gank.velapi.cc/v1` 上被拒」——照着改接口地址或换本站 key 就行。
  - 真生成撞上 401 时，失败卡里也会多一行同样的人话（`vig-fail-hint`），并且跟着任务落盘。
  真机那次的答案：`gpt-image-2.5-c` 只存在 `api.velapi.cc` 的目录里，那把 `sk-…yDNa` 在
  `gank.velapi.cc` 上就是 401；把 GPT 供应商的接口地址改成 `https://api.velapi.cc/v1` 后，
  测试连接拿到 61 个模型，真生成一张 1254×1254 的图（24.8s）落进图库。
- **编辑供应商会不会把 key 抹掉**：不会了。弹窗里密钥框永远不回显明文，**留空 = 不改**；
  只有显式勾成「用运行期密钥」（`useRuntimeKey: true`）才会清掉供应商自己的 key。
  踩过：改个接口地址顺手把 key 写成空串，之后测试连接回 `invalid access key`，查半天。
- **选了某个模型，请求却打到另一条供应商链（503 No available channel for model …）**：
  一条供应商链 = 一个 baseUrl + 一把 key + 一份模型目录，模型必须打到**拥有它**那条链。
  选路规则（宿主 `providerForModel()`、界面 `providerIdForModel()` 同一套）：
  1. 请求里点名 / 当前供应商的目录里就有这个模型（或它还没拉过目录）→ 就用它；
  2. 否则找目录里**有它**的供应商 —— 模型属于谁就打到谁那儿；
  3. 都没有才回落到点名 / 当前 / 第一条启用的供应商。
  所以「当前供应商」只决定**没有归属**的模型走哪条链；正常选模型时界面会自动把当前供应商切过去，
  生成和「用这条提示词重试」也都会按模型重挑（老任务里记错的那条 providerId 不会被照抄）。
  真机上就是这条：`gpt-image-2.5-c` 的 providerId 被记成了 grok 那条链，于是 POST 打到
  `https://api.velapi.cc/v1/images/generations`，回 503 —— 修完会打到 `gank.velapi.cc`。
  回归脚本：`node tools/route-check.mjs`（真 Chrome 里挂真 Workbench + 两条假供应商，11 项）。
- **任务一直「生成中…」**：两条一起治。刷新页面后 `reload()` 会把还挂在 `queued / running` 的任务
  重新交给轮询（以前只有「我刚点的那次」有人管，刷新一次就没人问了 —— 宿主早跑完，界面还在转圈）；
  轮询超过 6 分钟还没终态就停止并把那条标成 **状态未更新**，摆出原因和「刷新」按钮，不再无限转圈。
  另外宿主启动时会把上个进程留下的 `running / queued` 任务标成 `interrupted`（「宿主重启，任务已中断」）。
- **状态落盘偶发失败（Windows）**：`writeJsonAtomic` 是「临时文件 + rename」，而 Windows 上 rename
  覆盖已存在文件会被外部句柄（杀软 / 索引器 / 另一个写者）挡下来，抛 `EPERM / EBUSY / EACCES`。
  所以那里做了三件事：**同一文件按路径串行排队**（自己人不撞自己人）、rename 失败退避重试四次、
  失败时清掉临时文件。另外 `enqueue()` 里那次「入队先落盘」是 fire-and-forget，
  必须 `.catch()` 打日志 —— 否则一次落盘抖动就是一个未处理的 rejection，会把宿主带崩（踩过）。
- **按钮文字顶出边框 / 按钮没有内边距**：样式重置的特异性问题。重置写成
  `.vig-root button{…}` 是 (0,1,1)，会压过 `.vig-btn`(0,1,0)。必须用
  `.vig-root :where(button){…}`。测试里有闸门。
- **`GET /plugins/.../client.js` 404**：那个上传地址的 `rev` 必须和当前构图一致；直接刷新
  GUI 即可，浏览器用 `window.__DSH_BOOT__` 里带的 URL。
- **界面没出现**：等两秒。桌面端的客户端插件是热重载的（见下一条），存盘即生效；
  仍然没有就看一下「设置 → 生图工作台」是否在列——那是保底入口。还不行就两条命令取证：
  `node tools/live-check.mjs <GUI端口>`（从外面看构图与被服务的代码），
  或看 `$DSH_HOME/state/velapi-image-go/client-report.json`（页面侧自检回执：
  `rightbarWaiting: true` 表示右侧栏那个席位还没到货，`dom` 字段是页面上四个落点的 DOM 命中数）。
- **怎么刷新界面（桌面端没有 Ctrl+R）**：Electron 桌面端既没绑 `Ctrl+R`，菜单里也没有
  「重新加载」（只在 F12 上挂了 DevTools）。不用慌：宿主盯着插件的入口产物，文件一变就通过
  `/plugins/events` 推 `{"type":"rebuilt","id":"dsh-plugin-velapi-image-go","rev":"…"}`，
  页面里的 `client-hmr` 收到就重载那个条目 —— 改完 `client.js` 存盘，界面自己换新版本。
  手动兜底两条：面板头部那颗电源图标「重载界面」（就是 `location.reload()`），
  或 F12 开 DevTools → 控制台 `location.reload()`。
  宿主半边 `lib/index.js` 不参与热重载，改它要重启一次应用。
- **重启后「按键/入口又不见了」**：工作台的主落点是右侧栏的一个 tab。宿主对注册时写了
  `keepMounted: true` 的 tab 会一直挂着、非激活时只是用 `display:none` 藏着 —— 所以
  「挂载了」不等于「看得见」。停靠面板曾经只认挂载，于是把它自己的入口胶囊也收了起来：
  右侧栏停在别的 tab（比如开始页）时，整个工作台一个入口都不剩。
  现在按几何量判定可见性（`getClientRects()` + `visibility`），看不见就一定留一个右下角胶囊。
  自查一行：控制台里 `__velapiImageGo.surfaces` 看三个落点注册结果、`__velapiImageGo.errors`
  看失败原因、`__velapiImageGo.paneState()` 看侧栏 tab 是挂着还是真的可见。
- **右侧栏一片空白 / 内容被裁**：两种不同的病。空白的病根是 tab 注册没带 `guide[]`，
  开始页就没有卡片；被裁的病根是里面有个东西压不下去（典型：`<select>` 的 `min-width:auto`
  等于最长选项文字宽）把整列撑宽，超出容器的部分被宿主裁掉——跑 `npm run fit`，
  每行「内容溢出」都得是 0px。
- **`unsupported explicit image resolution`**：某些模型（如 `nano-banana-2.1`）不接受显式
  `imageConfig.imageSize`，本插件默认不发这个字段，别在供应商备注里手工加。
- **模型名**：中转站只放行 `nano-banana-pro` / `nano-banana-2.1` / `nano-banana-2` 三个生图模型
  （`imagen-4*` 存在但 `enabled=false`）；写别的名字会拿到上游 502/400。
- **返回 JPEG 不是 PNG**：上游会归一化成 JFIF，插件按魔数嗅探真实格式并存成 `.jpg`，是正常行为。

## 路线图

- 预设卡直接从图库里「存成预设卡」（现在得进编辑器，从图库挑一张）
- 工具箱里圈完一块直接「裁成新图进图库」，不用先设为参考图再生成
- 图库卡片给一个「打开处理」入口，把图递进工具箱（现在得进工具箱再从图库选）
- 图生图带 mask 的局部重绘（协议已通，界面待加画笔）
- 视频：同一中转站的 `/v1/videos` 是另一组模型，接口形状不同，单独一版
- 把生成能力暴露成 dsh 工具，让会话里的模型自己调（当前只有人工在界面上点）



## 仓库与更新包

- 仓库：<https://github.com/2357678297/DSH-image>（分支 `main`）。
- 以后**每次改动都作为一个「更新包」提交**：
  - 手动：`git add -A && git commit -m "feat: ..." && git push`
  - 或：`pwsh tools/push-update.ps1 "feat: ..."`（不带消息时用时间戳）
- 提交前自检（本机）：`node test/host.test.mjs`、`node test/client.test.mjs`、`node test/engine.test.mjs`、
  `node tools/viewer-check.mjs`（真机 Chrome 渲染检查，CI 里不跑）。
- CI：`.github/workflows/test.yml` 在每次 push / PR 时跑 host / client / engine 三套离线测试。
- 不进货：`node_modules`、`docs/preview/`、`docs/ui-audit/*.png`（本地渲染产物，可重新生成）、密钥与环境变量。

## 插件接壤自检

```powershell
node tools/verify-wiring.mjs        # 自动探测宿主端口（DSH 每次重启端口会变）
node tools/verify-wiring.mjs --api http://127.0.0.1:54419/api/velapi-image-go   # 指定端口
```

四段链路逐项检查（退出码 0 = 接壤完整）：
1. profile `package.json` 里的 `link:` 依赖指向本目录；
2. profile `node_modules` 是 junction/symlink；
3. profile `cordis.patch.yml` 有 `id: velapi-image-go` 的 insert 条目（且没同时列进 `dsh.profile.bundles`）；
4. 宿主 API 可达（`/api/velapi-image-go/status`）；
5. 宿主加载的是当前代码（`/status` 里能看到最新字段，例如视频的 `videoRatio` / `videoSeconds`）。

**宿主半边（`lib/index.js`）改动必须重启 DSH 进程才生效；浏览器半边（`client.js`）在 `patchReload: live` 下可热加载。**

### 重启宿主

- `C:\Users\Administrator\.dsh\restart-dsh.cmd`（双击或 `cmd /c`）：延时 15 秒 → 结束 `DeepSeek Harness.exe` → 6 秒后重新拉起；
- `C:\Users\Administrator\.dsh\restart-harness.cmd`：同流程，延时 20 秒（留给当前回答写完）；
- 旧脚本里的 `G:\deepseek webui\DSH Desktop\DSH Desktop.exe` 路径已不存在，两个脚本都已修正为 `G:\deepseek-harness\DeepSeek Harness.exe`；
- 重启后 GUI 端口会变（60898 → 54419 这种），用 `node tools/verify-wiring.mjs` 自动找新端口确认接壤 8/8。

### 重启约定（2026-10-21 修正）

- `restart-dsh.cmd` / `restart-harness.cmd` **必须是纯 ASCII**：`cmd.exe` 按 GBK 读 `.cmd`，中文注释会变成乱码并报「不是内部或外部命令」（用户截图里的那个错误窗口就是它）。
- **不再自动排定重启**：宿主半边（`lib/index.js`）改动需要生效时先说明，由用户手动运行脚本或在用户明确同意后再排；浏览器半边（`client.js`）刷新页面即可。
- 重启后 GUI 端口会变，用 `node tools/verify-wiring.mjs` 自动探测确认接壤 8/8。

### 更新通道（两段式，已接壤）

- 第一次点「更新」→ `POST /update/check`（`git ls-remote` 对比本地 HEAD），返回 `latest` / `behind` / `not_a_repo` / `remote_unreachable`；
- 查到 `behind` 后**再点一次** → `POST /update/apply`（`git pull --ff-only`，本地有未提交改动会被拒绝）→ 成功后自动 `POST /update/restart`（调 `~/.dsh/restart-dsh.cmd`，15 秒后重启宿主）。
- 实测：远端 `c3c0886` 之后本机连续 3 个更新包，界面显示「已是最新（591fb71）」。

### 视频上游字段（已实测，2026-10-21）

用配置里的 key 直接打 `https://gank.velapi.cc/v1/videos/generations`：

```text
POST  {model:"veo-3.1-flash", prompt, aspect_ratio:"16:9", resolution:"720p", seconds:"8"}
→ 200  {"id":"video_4eb6...","status":"queued","model":"veo_3_1_t2v_fast_8s","seconds":8}
```

结论：
- **原生字段 `aspect_ratio` / `resolution` / `seconds` 上游认**（宿主视频 body 已同时带原生字段 + 像素 `size`）；
- 上游真实视频模型是 `veo-3.1-lite / veo-3.1-flash / veo-3.1-pro`（目录里 `kind=video`），以及一堆 `veo_3_1_*` 变体；
- `wan3.0-video-1080p` **名字带 video 但上游当图片模型**：发视频请求直接 400 `{"detail":"不是视频模型: wan3.0-video-1080p"}`。所以模型能力**只按目录 `kind` 判断，不再按名字猜**；没有 kind 的模型按图片处理，视频协议由用户手动切。
