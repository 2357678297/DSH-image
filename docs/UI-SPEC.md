# UI 设计审计与样式规范 · 杂志极简白

> 对象：`client.js` 内联样式表（`.vig-root` 下 259 个类）
> 方向：Swiss Modernism 2.0 × 顶级书刊杂志版面（editorial）
> 关键词：纸白、墨黑、朱红点缀、胶囊化、细线、大留白、排版尺度、克制动效
> 落点：token 层 + 覆盖层（`/* 设计系统 v2 */` 段），不动 JSX 结构与 class 名

---

## 一、审计结论（改前）

采样：对话生图 / 图片管理 / 图片处理 / 供应商管理 四页截图（`docs/ui-audit/before-*.png`）。

### 1.1 结构性问题（P0）

| # | 问题 | 证据 | 影响 |
|---|---|---|---|
| 1 | 圆角 20 种取值并存：token 仅 4 档（18/14/12/999），实际出现 `10px ×13`、`8px ×11`、`6px ×7`、`9px ×6`、`7px ×3`、`12px ×5`、`5px`、`2px`、`14px ×2` | `border-radius` 统计 | 控件之间「圆得不一样」，是廉价感第一来源 |
| 2 | 字号 6 个相邻值混用：11 / 11.5 / 12 / 12.5 / 13 / 13.5 | `font-size` 统计 | 层级读不出来，全部像正文 |
| 3 | 蓝色 `#2f6bff` 同时承担主色 / 选中 / 链接 / 头像 / 焦点环 / 阴影（`rgba(47,107,255,.28/.32)`） | `.vig-mark` 渐变、`.vig-send` 光晕、`.vig-nav-item.is-on` | 强调色滥用 → 页面到处在「发蓝光」，不像纸媒 |
| 4 | 品牌块是蓝色渐变方块 + 蓝色大标题 | 截图左上 | SaaS 模板感，与「前卫简约白」相反 |
| 5 | 卡片三层嵌套，全都 18px 圆角 + 阴影，层级只靠阴影深浅 | `.vig-head` / `.vig-card` / `.vig-block` | 灰雾感，杂志需要的「细线 + 留白」没有 |
| 6 | 没有排版尺度：无 display 层、无 kicker 层、数字非等宽 | 全文 | 信息密度高的图库/任务列表读起来毛糙 |

### 1.2 组件级问题（P1）

| 组件 | 问题 |
|---|---|
| `.vig-nav-item` | 选中态「蓝底蓝字」，与主按钮抢；图标 5 个视觉重量不一 |
| `.vig-btn` | 圆角 10px、height 32、无状态过渡；primary 蓝底白字光晕过重 |
| `.vig-icon-btn` / `.vig-tool` | 9px 圆角方形 28px；hover 无底色，只有颜色变深 |
| `.vig-mini`（结果卡动作） | 6px 圆角 + 11.5px 灰字，四枚「重绘/复制/保存/原图」散排，无字距 |
| 输入区 | textarea 无边框容器、工具行圆角各异（9/12/999 混用） |
| `.vig-tag` / `.vig-pill` / `.vig-count` | 已有 pill，但 11/12px、内距 1–10px 不统一 |
| 气泡 | 用户/助手视觉重量差不多，头像「我」是蓝圈，AI 是灰字 |
| `.vig-toast` | 白底细线胶囊，但 `padding:0 3em` 极端，成功/失败仅靠描边色 |
| `.vig-viewer` | 头部无分隔线，图片直接贴边，脚部按钮未胶囊化 |
| 焦点态 | `box-shadow:0 0 0 3px rgba(47,107,255,.12)` 散落在 3 处硬编码 |
| 动效 | 无统一 duration/easing，未处理 `prefers-reduced-motion` |

---

## 二、设计方向

**杂志极简白（Editorial Minimal White）= Swiss 网格 + 书刊版面**

| 维度 | 规则 |
|---|---|
| 底色 | 纸白 `#FFFFFF` 面板 / `#FAFAF8` 画布（带一点暖，不像屏幕灰） |
| 墨色 | 主文字与主操作 `#0B0B0C`；二级 `#3F3F46`；三级 `#71717A`；辅助 `#A1A1AA` |
| 点缀 | 朱红 `#FF3A00`，**只用三处**：危险、录制中、必要的高亮小点；面积 < 2% |
| 线条 | `#E7E7E2`（1px），强分隔 `#D9D9D2`；阴影几乎取消（只留 1px/1 层给浮层） |
| 字体 | 正文 `Inter, "Helvetica Neue", Arial, "PingFang SC", "Microsoft YaHei"`；展示标题 `"Libre Bodoni", Georgia, "Songti SC", "SimSun", serif` |
| 排版 | display 22/650/-0.01em · title 15/600 · kicker 11/600/0.08em 大写 · body 13/1.6 · caption 12/1.4 |
| 数字 | 所有计数、尺寸、时间、参数用 `font-variant-numeric: tabular-nums` |
| 圆角 | 只有 4 档：pill 999 / card 18 / tile 12 / sheet 20 |
| 胶囊 | **所有可点控件**（按钮、图标按钮、下拉、标签、chip、页签、计数）一律 pill；卡片/面板/输入区/画布保持大圆角 |
| 动效 | 160ms `cubic-bezier(.2,.7,.2,1)`，只动 color/background/border/opacity/transform；`prefers-reduced-motion` 全关 |
| 焦点 | 统一 `0 0 0 3px rgba(11,11,12,.14)`（墨色环），键盘可见，鼠标不显 |

---

## 三、Token（三层）

### 3.1 Primitive（原值）

```
--vig-paper:#ffffff      --vig-canvas:#fafaf8     --vig-sunken:#f2f2ee
--vig-ink:#0b0b0c        --vig-ink-2:#3f3f46      --vig-ink-3:#71717a    --vig-ink-4:#a1a1aa
--vig-rule:#e7e7e2       --vig-rule-strong:#d9d9d2
--vig-signal:#ff3a00     --vig-danger:#d92121     --vig-ok:#15803d
--vig-r-pill:999px       --vig-r-card:18px        --vig-r-tile:12px      --vig-r-sheet:20px
--vig-dur:160ms          --vig-ease:cubic-bezier(.2,.7,.2,1)
--vig-sh-1:0 1px 2px rgba(11,11,12,.04)
--vig-sh-2:0 18px 40px -12px rgba(11,11,12,.18)
```

### 3.2 Semantic（映射，兼容旧变量名）

| 旧变量 | 新值 | 用途 |
|---|---|---|
| `--vig-surface` | `#ffffff` | 面板/卡片底 |
| `--vig-surface-soft` | `#fafaf8` | 画布、次级面 |
| `--vig-surface-sunken` | `#f2f2ee` | hover 底、凹槽 |
| `--vig-line` | `#e7e7e2` | 1px 线 |
| `--vig-line-strong` | `#d9d9d2` | 强分隔、滚动条 |
| `--vig-text` | `#0b0b0c` | 主文字 |
| `--vig-text-muted` | `#71717a` | 二级 |
| `--vig-text-faint` | `#a1a1aa` | 三级 |
| `--vig-accent` | `#0b0b0c` | 主操作（墨黑） |
| `--vig-accent-soft` | `#f2f2ee` | accent 的浅底（hover/选中） |
| `--vig-accent-line` | `#d9d9d2` | accent 的描边 |
| `--vig-danger` | `#d92121` | 危险 |
| `--vig-ok` | `#15803d` | 成功 |
| `--vig-ring` | `rgba(11,11,12,.14)` | 焦点环 |
| `--vig-signal` | `#ff3a00` | 朱红点缀（三处） |

深色主题同构：`surface #141416 / soft #191a1c / sunken #202023 / line #2a2a2e / text #f4f4f2 / accent #f4f4f2（近白） / signal #ff5a2b`。

### 3.3 Component（组件只引用 semantic）

按钮 `--btn-*`、卡片 `--card-*`、输入 `--field-*` 不引入新色值，全部由上面推得。

---

## 四、单组件样式规范

统一前提：所有控件 `transition: background-color/color/border-color/box-shadow var(--vig-dur) var(--vig-ease)`；`:focus-visible` 显示墨色环；`:disabled` 透明度 .45 + `cursor:not-allowed`；`cursor:pointer`。

### 4.1 顶部栏 `.vig-head`

| 属性 | 规格 |
|---|---|
| 结构 | **高 34、贴边、与内容零间隙**（`--vig-root gap:0`，靠 `.vig-shell` 的 10px padding 拉开），无边框无圆角无阴影，底边 1px `--vig-line`；padding `0 12` |
| 品牌块 `.vig-mark` | 22×22，圆角 7（`--true 7px`），墨黑实心，图标 12；无渐变无光晕 |
| 标题 | `.vig-title` 13.5px/650，字距 -0.015em；右侧接 **刊头 kicker** `.vig-kicker`（9.5px/600/字距 .16em 大写、三级灰，英文固定「STUDIO」） |
| 右侧 | 图标按钮 26×26；顶栏内图标 `stroke-width:1.05`（比正文 1.4 更纤细）；状态胶囊压成 20px 圆点（文字进 `title`） |
| 右侧动作 | 图标按钮按 4.3 |

### 4.1b 更新入口 `.vig-update`（先设计，宿主未接壤）

| 项 | 规格 |
|---|---|
| 位置 | 左侧导航**贴底**（与统计之间一条 1px 分隔线）：更新按钮吃掉 nav 剩余空白，统计紧随其下 |
| 内容 | `⟳ 更新` 胶囊按钮（24 高，11px，flex:none 不换行）+ 版本号 `v0.1.0`（9.5px 大写字距、三级灰，来自 `PLUGIN_VERSION`，与 package.json 对齐）；「PR 流程」只放 `title` 提示 |
| 行为 | 点击 → `POST /update/check`；`running` 时按钮 spinner + 禁用；宿主未实现 → 进度条转 `--vig-danger` 并提示「更新通道还没接壤」 |
| 进度条 | **按需出现**（仅检查中 / 完成瞬间 / 失败）：3px 圆角条，`order:-1` 排在按钮上方；墨黑进行、`--vig-ok` 完成、`--vig-danger` 失败；`role=progressbar` + `aria-valuenow`；结束后自动收起 |
| 接壤 | 宿主 `POST /update/check` 已实现：`git ls-remote https://github.com/2357678297/DSH-image.git refs/heads/main` 对比本地 `git rev-parse HEAD`；返回 `code=latest/behind/not_a_repo/remote_unreachable`、`short.local/remote`、`hint`；界面按 code 提示（已是最新 / 远端有更新 + 短 SHA / 具体失败原因），进度条三态不变；拉取更新用 `git pull`（或 `tools/push-update.ps1` 的反向流程），改完重启 DSH |

### 4.2 左侧导航 `.vig-nav-item`

| 属性 | 规格 |
|---|---|
| 尺寸 | 高 36，padding `0 12`，圆角 **999（胶囊）** |
| 常态 | 文字二级灰，图标 16px 线性，与文字 gap 10 |
| hover | 底 `--vig-surface-sunken`，文字墨黑 |
| 选中 `.is-on` | **墨黑底 + 白字**（不是蓝底蓝字）；图标同白 |
| 分组 | 组间距 `--vig-gap`；组标题 kicker |

### 4.3 按钮 `.vig-btn`

| 变体 | 规格 |
|---|---|
| 基础 | 高 32，padding `0 14`，**pill**，1px 线，白底，墨字，gap 6，13px/500 |
| `.is-primary` | 墨黑底 + 白字 + 墨黑边；hover 提亮到 `#26262a` |
| `.is-ghost` | 透明底无边，二级灰；hover 灰底 + 墨字 |
| `.is-danger` | 朱红底白字（危险动作），或透明 + 朱红字 |
| `.is-sm` | 高 26，padding `0 10`，12px |
| 图标按钮 `.vig-icon-btn` / `.vig-tool` | **圆形** 30×30（999），二级灰；hover 灰底墨字；`.is-on` 墨黑底白字 |
| 微型动作 `.vig-mini`（结果卡） | 24×24 圆形，无底色；hover 灰底；图标 13px |
| 禁用 | 透明度 .45，pointer-events none |

### 4.4 结果卡动作行（重绘 / 复制 / 保存 / 原图）

- 文字 11px/500，字距 `.06em`，三级灰；
- 与图片距离 8；每项横向 padding 6（点击区 ≥24×24）；
- hover 墨黑 + 轻下划线（`text-decoration-thickness:.5px; underline-offset:3px`）；
- 不再各自带圆角底，靠间距分组。

### 4.4b 结果卡动作行（图标化，靠右）

| 项 | 规格 |
|---|---|
| 布局 | `.vig-shot-bar{justify-content:flex-end;gap:2px}`：四个动作靠右排，不再均摊横排 |
| 形态 | 无底色 SVG 图标按钮 26×26（`vig-mini vig-shot-act`）：重绘 `refresh` / 复制 `copy` / 保存 `download` / 原图 `external`；hover 才出灰底 |
| 可访问 | 文案只留在 `title` + `aria-label`（完整动作名，如「用这张重绘」「复制链接」） |

### 4.4c 输入区工具行（折叠器 + 无边框）

| 项 | 规格 |
|---|---|
| 常显 | 上下文开关（`spark`）、模型下拉、尺寸下拉、折叠器、发送 |
| 展开器 | 上传 / 图库 / 信息卡 / 张数 `x1` / 协议 / 字数计数 **收进一块悬浮面板 `.vig-tools-pop`**（绝对定位在工具行上方、毛玻璃白底、圆角 18、轻阴影），不是塞回行里；展开器按钮（`chevron` / `chevronDown`、`aria-expanded`、`data-tools-toggle`）控制；点面板外或 Esc 收起 |
| 无边框 | 工具行内 `.vig-sel` 与模型选择器 `border-color:transparent;background:transparent`，hover 出 `--vig-surface-sunken`；打开态才回细边框 |
| 弹层不被遮挡 | 模型下拉：`.vig-tools .vig-picker{z-index:36}`、`.vig-tools .vig-pop{z-index:40;left:0;right:auto;width:min(320px,calc(100vw-56px));max-height:min(46vh,420px)}` —— 向上弹、限高滚动、盖在工具行之上 |
| 行内对齐 | `flex-wrap:nowrap`、模型/尺寸 `min-width:0` 可收缩（max 170）、发送 `margin-left:auto`；展开态允许换行 |

### 4.4d 上下文管理（对话式浮层）

| 项 | 规格 |
|---|---|
| 入口 | 工具行 ✨（`data-context-toggle`）；`is-on` 表示自动整理开着，`is-open` 表示浮层展开；`aria-expanded` 同步 |
| 浮层 | `.vig-ctx-pop`：360 宽、绝对定位在 ✨ 上方、毛玻璃白底、圆角 18；标题 `上下文管理 · 对话式` + 一行说明「只整理提示词与读配置，不直接调供应商出图」 |
| 控件 | ① 每轮自动整理（checkbox → `toggleContext`）② 上下文轮数滑块 0–12（写宿主 `config.contextTurns`）③ **限制直接出图**（checkbox，默认开，localStorage `context-noauto`）＋说明「开启后只按你的原话出图」 |
| 已读取配置 | 底部一行 `已读取：对话 {chatModel} · 生图 {defaultModel} · 尺寸 {defaultSize}`（虚线分隔） |
| 接壤 | 限制开启时 `/chat/plan` 带 `noAutoImage:true`；宿主提示词加「不要自行决定编辑/参考图」；客户端忽略 plan 的自动切编辑（reply 分类仍生效） |

### 4.5 输入区 `.vig-composer` / `.vig-input`

| 属性 | 规格 |
|---|---|
| 容器 | 白底，1px 线，圆角 18（**不用 pill**：长文本需要方肩），padding `12px 14px` |
| focus-within | 边框墨黑 + 墨色环 3px |
| textarea | 13px/1.6，无边框，min-height 44 |
| 工具行 | 高 30，图标按钮圆形，下拉 pill，gap 6 |
| 发送 `.vig-send` | 32 圆形墨黑底白字；hover 提亮；禁用灰底 |
| 计数 `0/500` | 11px tabular，三级灰 |

### 4.4e 回到底部浮标 `.vig-bottom-jump`

| 项 | 规格 |
|---|---|
| 出现条件 | 用户离底 >160px（`trackStick` 判定 `atBottom=false`）；贴底自动消失 |
| 形态 | 32px 高胶囊：`chevronDown` 14 + 「回到底部」12px；`rgba(255,255,255,.94)` + 1px `--vig-line` + 毛玻璃 + `--vig-sh-2`；右下 sticky（`bottom:22px`），`pointer-events` 只落在按钮上 |
| 未读 | 不在底部时新消息累计到数字徽标（`--vig-accent` 底、白字、`min-width:18px`），回底清零 |
| 回底 | `scrollTo({behavior:"smooth"})`；480ms 内忽略 scroll 判定，避免平滑滚动途中按钮闪现 |
| 深色 / 动效 | 深色主题换 `rgba(26,26,28,.94)`；`prefers-reduced-motion` 关过渡 |

### 4.5b 图片 / 视频参数分区

| 项 | 规格 |
|---|---|
| 模型列表 | 按 `kind` 过滤：`image` 协议只列图片模型、`video` 协议只列视频模型；音频/对话/向量模型一律不进下拉。`kind` 优先取目录元数据，缺失时按名字兜底（`video/veo/sora/kling/wan/seedance/t2v/i2v/runway/pika` 视为视频）——`wan3.0-video-1080p` 这类名字不再被当图片模型 |
| 模型↔协议联动 | **选中视频模型自动切到「视频生成」协议**（参数区立刻变比例/分辨率/时长）；选中图片模型却停在视频协议时自动切回图片生成；改协议也会自动换成该 kind 的模型 |
| 尺寸 | 图片协议 → `defaultSize`（比例 · 像素）；视频协议 → **比例 + 分辨率两段分开选**：比例 `16:9 / 9:16 / 1:1 / 4:3 / 3:4 / 21:9`（`videoRatio`），分辨率 `480p / 720p / 1080p`（`videoResolution`）；像素 size 由 `videoSizeFor(ratio, resolution)`（短边=分辨率档、长边按比例取偶）组合后写回 `videoSize`，宿主 config 三者分开存、互不覆盖 |
| 模型联动 | 切到视频协议时，若当前 `defaultModel` 还是图片模型，自动换成该协议下第一个可用视频模型（并切它所属供应商）；反之切回图片同理 |
| 时长 | 视频协议第三个下拉：`4s / 6s / 8s / 10s / 12s`（`videoSeconds`，默认 4），落上游 body 的 `seconds`（OpenAI 视频接口字段，字符串）；图片请求不带 |
| 张数 | 图片协议显示 `x1–x4`；视频协议固定 1，控件隐藏 |
| 请求 | 生成与 `/chat/plan` 的 `size` 按协议取；视频 `n=1`；`videoSize` 走 `POST /config` 校验 `^\d{2,5}x\d{2,5}$` |

### 4.6 下拉 `.vig-sel` / `select`

- pill（999），高 30，padding `0 10`，1px 线，白底，12.5px；
- focus 墨色环；展开原生列表（保持系统行为，不自绘）。

### 4.7 标签 / chip / 计数

| 类 | 规格 |
|---|---|
| `.vig-tag` | pill，高 20，padding `0 8`，11px/600，字距 .06em，sunken 底三级灰 |
| `.vig-pill` | pill，高 26，padding `0 12`，12px，1px 线 |
| `.vig-count` | pill，高 20，min-width 20，tabular，11px/600 |
| `.vig-ref`（参考图 chip） | 54×54 圆角 12（图片块不用 pill），1px 线；角标按钮圆形 18 |

### 4.8 卡片 `.vig-card` / `.vig-block` / 结果卡 `.vig-shot`

- 白底 1px 线，圆角 18，**无阴影**（只有 toast/弹窗/浮层用 `--vig-sh-2`）；
- 卡片内 padding 14；块标题用 kicker（11/600/.08em）+ 前导 12px 墨线（`::before`）；
- 结果卡图片圆角 12，与卡片间距 10。

### 4.8b 图库卡片 `.vig-tile`（图片管理）

| 部位 | 规格 |
|---|---|
| 网格 | `auto-fill minmax(168px,1fr)`，gap 14，容器 padding 16 |
| 图片 | **铺满卡片整宽、1:1（aspect-ratio:1/1）+ object-fit:cover**，无内边距；卡片圆角 12 裁切 |
| 文字 | 文件名 12/600 单行 ellipsis；下方 11px 三级灰「模型 · 宽×高」，tabular + 单行 ellipsis，完整值放 `title` |
| 动作 | **四个无底 SVG 图标按钮**（查看器 `expand` / 重命名 `edit` / 保存 `download` / 用作参考图 `image`），24×24 圆形、图标 13px、间距 2；hover 才出灰底；文案只留在 `title` + `aria-label` |
| 选择 | 左上角 20 圆形勾选环，选中墨黑 |
| 交互 | 整卡可拖（拖进输入区/图片处理/文件夹）；点卡片切换选中；点图开查看器 |

### 4.8c 图库布局密度（S / M / L）

| 项 | 规格 |
|---|---|
| 控件 | 工具行右侧三段胶囊 `.vig-density`（小图 / 标准 / 大图），选中墨黑底白字，`aria-pressed` |
| S 小图 | `minmax(112px,1fr)`、gap 10、padding 12；隐藏「模型 · 尺寸」行，动作图标 22 |
| M 标准 | `minmax(168px,1fr)`、gap 14、padding 16 |
| L 大图 | `minmax(260px,1fr)`、gap 18、padding 18 |
| 记忆 | `localStorage["vig.library.density"]`，刷新/重启保持；隐私模式下静默只活本次 |
| 尺寸一致性 | 图片统一 `aspect-ratio:1/1 + object-fit:cover`；竖图（如 940×1672）一律裁成方形，不会把卡片撑高；卡片 `align-self:start;min-width:0` 防网格拉伸 |

### 4.8e 局部改图（框选 / 画笔 → mask 胶囊对话）

| 部位 | 规格 |
|---|---|
| 入口 | 大图视图信息条动作组两名图标按钮：**框选**（`marquee`）/ **画笔**（`pen`），选中态墨黑；工具激活时信息条整体让位 |
| 框选 | 在图片上拖矩形：朱红 `#ff3a00` 虚线 + 18% 半透明填充（画布覆盖层，`pointer-events:none` 只预览） |
| 画笔 | 自由笔迹；粗细用**滑块 `1–50`**（自然像素，步长 1，默认 20）+ 右侧数字读数；对话条内联，不再用档位胶囊（原 60/80/100 三档已删） |
| 胶囊对话 | 悬浮在大图底部（与信息条同位置）：输入框 + 清空 + 关闭工具 + 墨黑圆形发送；Enter 提交，`isComposing` 时不拦 |
| 提交 | mask = 与原图同尺寸的黑底白图（白=要重画），`POST /generate { mode:"edit", images:[原图 dataURL], mask, prompt, referenceUrl }` → 切到对话页看结果；**referenceUrl 必须留档**（图库图用本站 URL，其它来源就地 upload 换 URL），否则气泡下面看不到「引用了哪张图」，用户会以为图没被引用 |
| 宿主 | `/generate` 收 `mask` → `job.requestMask` → 编辑走 multipart（`mask` 字段，`filename=mask.png`） |
| 切换清理 | 切图（箭头/滚轮/键盘/缩略条）自动清空选框、笔迹、指令 |

### 4.8d 图库视图：大图（主从布局）

| 部位 | 规格 |
|---|---|
| 切换 | 工具行右侧图标胶囊 `.vig-viewmode`（网格 / 大图），选中墨黑；选择记在 `localStorage["vig.library.mode"]` |
| 上：大图 | `flex:1` 固定区，浅灰底（`--vig-surface-soft`）、内边距 18；图 `object-fit:contain`、圆角 8、`--vig-sh-2` 轻阴影；点图开查看器、可拖出 |
| 中：信息条 | **悬浮式**（`position:absolute` 贴在大图区底部 12px 居中，`bottom:calc(--vig-strip-h + 12px)`），**不占主视图高度**：毛玻璃胶囊（`rgba(255,255,255,.92)` + `backdrop-filter:blur(12px)` + 1px 线 + `--vig-sh-2`）；内容一行不换行：名称 11px/三级灰/max 150 + 模型·宽×高 11px/max 200 + `n/总数` + 1px 竖分隔线 + 动作组 |
| 下：缩略条 | 高 64 缩略图、gap 8、横向滚动（`overflow-x:auto`）、上边 1px 线；选中项 2px 墨黑描边；点击切换上方大图，可拖出 |
| 键盘 | ← / → 切上一张 / 下一张（与查看器键位一致） |
| 跟随滚动 | 切图（箭头/滚轮/键盘/点缩略图）后缩略条自动把选中项滚到中间（`scrollTo({behavior:"smooth"})`），选中项播 **Q 弹**（`vig-strip-pop`：0.94→1.07→1，0.34s 回弹曲线；reduced-motion 下由全局规则关掉） |
| 精简 | 大图视图下隐藏布局密度胶囊（密度只对网格有意义） |
| 翻页 | 左右两侧**隐藏式箭头**（36×56 圆角胶囊、白底细线轻阴影）：`opacity:0`，鼠标进入大图区域（`:hover`）或键盘聚焦时才显形并变得可点 |
| 滚轮 | 大图区域滚轮切图：**累积 ≥40px 才切 + 200ms 节流**（连滚两下只切一张，避免过于灵敏）；`preventDefault` 阻止外层滚动 |
| 键盘 | ← / → 切上一张 / 下一张（与查看器、箭头、滚轮共用同一套 step 逻辑） |

### 4.9 会话气泡

| 元素 | 规格 |
|---|---|
| 用户气泡 | 白底 1px 线圆角 18（气泡右下角 6 做出方向感），13px/1.6；不再用蓝边 |
| 头像 | 22 圆形；「我」墨黑底白字 10.5/600；「AI」白底 1px 线三级灰 |
| 元信息 `.vig-who` / 来源行 | 11.5px 三级灰；模型名等宽数字 |
| 动作行 | 11px 三级灰，hover 墨黑 |

### 4.10 提示条 `.vig-toast`

- **墨黑底白字**胶囊（前卫杂志的做法：反白），高 34，padding `0 16`，圆角 999，阴影 `--vig-sh-2`；
- 成功：左端 6px 墨绿点；失败：左端 6px 朱红点 + 白字；
- 出现/消失 160ms 位移 4px + 淡入；`aria-live=polite` 由宿主处理。

### 4.11 弹窗 / 浮层 `.vig-modal` / `.vig-pop` / `.vig-picker`

- 圆角 20（sheet 档），白底，1px 线 + `--vig-sh-2`；
- 头部分隔线 1px；标题 15/600；
- 遮罩 `rgba(11,11,12,.42)`；
- 列表项 hover 灰底；选中项墨黑底白字（与导航一致）。

### 4.12 查看器 `.vig-viewer`

- 遮罩 `rgba(11,11,12,.72)`；面板圆角 20；
- 头部白底、底部 1px 分隔，标题 13.5/600；
- 舞台底 `--vig-surface-soft`，图片圆角 8（避免与卡片混淆）；
- 脚部按钮 pill，主按钮墨黑。

### 4.12b 图片处理·最近生成（2 行折叠 + 渐隐）

| 项 | 规格 |
|---|---|
| 结构 | **折叠壳 `.vig-ps-recent-fold` 包住 `.vig-ps-recent-grid`**：滚动/高度/渐隐只在壳上，网格本身不滚 —— 否则 Chrome 里格子 `aspect-ratio` 会失效，缩略图互相重叠 |
| 默认高度 | 壳 `max-height:224px` ≈ 2 整行（列宽 ~87、行高 87+gap 8）；`overflow-y:auto` 可滚 |
| 第三行半截 | 壳上 `mask-image:linear-gradient(180deg,#000 0,#000 181px,rgba(0,0,0,.16) 100%)`：第 3 行只露上半并渐隐 |
| 展开 | 头部「展开 / 收起」链接（`aria-expanded`）→ 壳 `.is-open{max-height:none;mask:none}` |
| 滚动 | 收起态也能在格子里滚（`overscroll-behavior:contain`，不带着整页跑） |

### 4.12c 图片处理·图层控制条 `.vig-ps-layerbar`

| 项 | 规格 |
|---|---|
| 位置 | `.vig-ps` 网格第 2 行跨全宽（`grid-column:1/-1;grid-row:2`，画布下方）；窄屏 compact 下回到文档流 |
| 卡片 | `.vig-ps-chip` 78px 宽：52px 缩略图（`psLayerThumb` 缩到 56px 的 dataURL）+ 10.5px 名字；底图 chip 在前，`is-add` 虚线「+ 加图层」在末尾 |
| 状态 | `is-on` 选中（accent 环）、`is-hidden` 不可见（缩略图 35%）、`is-dragging` 拖拽中、`is-editing` 单层编辑中（虚线 outline） |
| 操作 | 点击选中；hover/选中出左上眼睛（显隐切换）与右上 ×（删除）；HTML5 `draggable` 拖拽换序（`psMoveLayerTo`，末尾追加）；双击进单层编辑；末尾「+ 加图层」走图库选择器 |
| 默认新图层 | `commit()` 判断 `geometry`：无几何步骤 → 结果压成新图层、旧层全部隐藏（已烘焙，历史快照可撤销），底图不动；有几何步骤（裁切/旋转/画布/缩放/翻转）仍改写底图以保持坐标一致 |
| 右栏 | 图层列表默认折叠（`.vig-ps-layers.is-fold .vig-ps-layer-row{display:none}`），头部 chevron 展开看叠加算法/不透明度/蒙版 |

### 4.13 图片处理 `.vig-ps` 工具条

- 左侧工具列：48px 宽，工具按钮 36×36 圆角 12（工具是「画布工具」，用 tile 圆角不是 pill），选中墨黑底白字；
- 分段控件 `.vig-ps-seg`：pill 容器 + 内 pill 选中；
- 参数输入 pill。

---

## 五、胶囊化规则（一句话）

**点一下就触发的东西 = pill；看得见内容的东西 = 大圆角。**

- pill：按钮、图标按钮、工具按钮（画布除外）、下拉、标签、chip、页签、计数、提示条、发送键
- 大圆角（12/18/20）：卡片、面板、输入区容器、缩略图块、弹窗、查看器
- 例外：图片处理画布工具与图层项用 12px（画布工具在方块阵列里，pill 会互相挤压）

---

## 六、可访问性与交互

- 文字对比：主 `#0b0b0c`/白 21:1；二级 `#71717a`/白 5.0:1；三级 `#a1a1aa`/白 2.9:1 **仅限非正文信息**（时间、计数），正文不用三级灰。
- 焦点：统一 `outline:0` + `box-shadow:0 0 0 3px var(--vig-ring)`，`:focus-visible` 才显。
- 触达：图标按钮可视 24–30，点击区通过 padding 补到 ≥28；结果卡动作文字点击区 ≥24 高。
- 动效：`@media (prefers-reduced-motion: reduce)` 下 `transition:none`、`animation:none`。
- 颜色不做唯一信号：失败/成功除颜色外带图标或文案（现有 `is-err` / `is-ok` 结构保留）。

---

## 七、验收

1. `node test/client.test.mjs` 394 项全通过（样式相关断言：`:where(button)`、`.vig-row>.vig-btn`、`.vig-page` 骨架、`--vig-r-card:18px`、`--vig-r-pill:999px`、深色覆盖、图片处理栅格等保持字面）；
2. `node tools/viewer-check.mjs` 44 项通过；
3. 四页截图 `docs/ui-audit/after-*.png` 与 before 对比：圆角只有 4 档、无蓝色光晕、控件均为胶囊、卡片无阴影、字距与数字等宽生效；
4. 深色主题抽查一页（`data-ds-dark-theme`）不出现浅底白字以外的低对比。

---

## 八、审计留档

- 改前截图：`docs/ui-audit/before-chat.png`、`before-library.png`、`before-ps.png`、`before-providers.png`
- 改后截图：`docs/ui-audit/after-*.png`
- 截图入口：`node tools/viewer-check.mjs --hold chat|library|ps|providers --shot <png>`（只渲染该页并停住，走真实 Chrome）

## 九、落地记录（v2 / v2.1）

- **v2**：token 重写（纸白/墨黑/朱红、4 档圆角、ring/dur/ease/字体栈、tabular 数字）＋ 组件覆盖层（导航胶囊、按钮 pill、图标按钮圆形、卡片去阴影、输入区 18 方肩、kicker 标题、反白 toast、弹窗 sheet 圆角、图片处理 tile 圆角、细滚动条、reduced-motion）；
- 内联蓝色硬编码全部清掉：`--vig-accent` 蓝 → 墨黑；`#2f6bff` / `rgba(47,107,255,*)`（含 canvas 选框与四点变形描边）→ 墨黑系；logo 渐变 → 墨黑实心；
- **v2.1（第一版验收截图发现的两个真问题）**：
  1. `.vig-mini` 同时被「图标按钮」（气泡动作）与「文字按钮」（结果卡 / 图库卡动作）使用，原 `padding:3px;line-height:0` 让文字塌成竖排 → 现在文字型 `width:auto + nowrap + 24 高胶囊`，图标型（`.vig-turn-acts` 内）才固定 24 方；
  2. 结果卡动作行 `flex-wrap` 与 `flex:none` 组合会把按钮挤出卡片裁掉 → 改 `space-between + 允许换行`，图库窄卡自动两行；
- 左下统计数字换成衬线展示字体（Georgia/宋体回退，`--vig-font-display`）+ tabular，杂志数字感；主面板标题 16/650；空状态标题 15；
- **v2.2（按用户反馈改图库卡片）**：图片由固定 126 高改为**铺满整宽 1:1**（卡片网格同时放宽到 minmax 168），
  图片下方动作从「图片查看器 / 重命名 / 保存 / 重绘」四段文字改成**四个无底 SVG 图标按钮**
  （expand / edit / download / image，24 圆、hover 才出灰底，文案只在 title 与 aria-label）；
  卡片高度由图片 1:1 + 两行小字 + 图标行统一，不再因文字换行而错落；
- 验收：client 394、真机 44、宿主 120、引擎 133、探针 13、路由 11 全绿。
- **v2.3（图库布局密度）**：工具行加「小图 / 标准 / 大图」三段胶囊，密度记在 localStorage；图片一律 1:1 裁切（竖图不再把卡片撑高，网格行高统一），卡片 `align-self:start` + `min-width:0` 保证任意容器宽度下都不会退化成单列巨图；
- 截图：`docs/ui-audit/layout-compact.png` / `layout-standard.png` / `layout-large.png`（`node tools/viewer-check.mjs --hold library --query "hold=library&density=large" --shot x.png`）。
- **v2.27（图片处理·图层控制条）**：图层从右侧列表改成**画布下方横排控制条**（底图 + 各层 78px 缩略卡片 + 加层按钮，横向滚动）；每张卡：点击选中（`--vig-accent` 2px 环）、hover 出眼睛/×、**拖拽排序**（`psMoveLayerTo`）、双击进单层编辑；右栏图层列表默认折叠（头部 chevron 展开看叠加算法/不透明度）；**所有颜色/滤镜类改动默认新建图层**（旧层隐藏=已烘焙，历史可撤销），几何类（裁切/旋转等改尺寸）仍改写底图；截图 docs/ui-audit/ps-layerbar.png；
- **v2.26（视频模型联动）**：`modelKindOf` 先看 `modelMeta.kind`、缺失按名字兜底（wan3.0-video-1080p / veo / sora / kling / seedance…）；选中视频模型自动切 `videos_generations` 协议并显示视频参数（16:9 / 720p / 4s），选回图片模型自动切回图片生成；真机断言（hold=chat&model=omni-flash）覆盖协议切换与参数区两段；
- **v2.25（回到底部浮标）**：上翻历史（离底 >160px）时对话区右下角出现「⌄ 回到底部」胶囊（白底细线 + 毛玻璃 + 轻阴影，sticky 悬浮在滚动区底部）；有未读新消息时带 `--vig-accent` 数字徽标；点击平滑回底（480ms 守卫防止滚动途中按钮闪现）并自动收起；贴底即隐藏；
- **v2.24（刷新停在最新一条）**：会话滚动改用「贴底跟随」`stickRef`——刷新/切会话强制回底并补 60/320ms 两帧兜底；图片 `load`（捕获阶段）与 DOM 变化（MutationObserver）撑高时只要还贴着底就继续跟到底；上翻历史（离底 >160px）不抢滚动；真机断言 20 条消息下 `scrollTop+clientHeight === scrollHeight`；
- **v2.23（更新通道接壤）**：宿主实现 `POST /update/check`（`git ls-remote` 拿远端 `main` HEAD 对比本地 `rev-parse HEAD`，无需 GitHub token/API 速率）；返回 `code=latest|behind|not_a_repo|remote_unreachable` + 短 SHA + hint；界面「更新」按钮按 code 给提示（已是最新 / 远端有更新 xxxxxxx / 远端不可达原因），进度条三态不变；host 测试用本地临时 git 仓库覆盖 behind/latest/unreachable 三条分支（host 130）；
- **v2.22（视频时长）**：视频协议加第三个下拉「时长 4/6/8/10/12 秒」，`videoSeconds` 独立存；生成时视频 body 带 `seconds`（缺省 4s，图片请求不带）；三下拉文案收紧成 `16:9 / 720p / 4s` 避免挤行；
- **v2.21（视频比例 / 分辨率分段）**：视频协议从单一下拉拆成「比例 + 分辨率」两段（16:9/9:16/1:1/4:3/3:4/21:9 × 480p/720p/1080p），像素 size 由短边规则组合写回 `videoSize`；`videoRatio` / `videoResolution` 宿主分字段存；切协议自动换到对应 kind 的模型（并切供应商）。（注：本轮 host 侧联网检索不可用，参数集合按 OpenAI `size` 像素与 Kling/Seedance/Veo 的 `aspect_ratio`+`resolution` 公开规范归一实现）
- **v2.20（视频参数与图片配置分开）**：模型下拉按 `modelMeta.kind` 过滤（图片协议只列 image 模型、视频协议只列 video 模型，音频/对话/向量模型不进列表）；视频协议用**独立 `videoSize`**（1280×720 / 1920×1080 / 720×1280 / 1080×1920，宿主 config 单独存、改它不影响 `defaultSize`），张数固定 1 并隐藏；生成/plan 按协议分别带图片或视频尺寸；
- **v2.19（上下文管理·对话式）**：✨ 从「一键开关」改成打开一块设置浮层——每轮自动整理、上下文轮数滑块（0–12，写宿主 config）、**限制上下文模型直接调供应商出图**（默认开，localStorage 记忆；开启时 `/chat/plan` 带 `noAutoImage`，宿主在提示词里禁止它自行切编辑/决定参考图，客户端也忽略 plan 的自动切编辑）；底部「已读取：对话/生图/尺寸」把接壤的配置直接摆出来；
- **v2.18（更新入口）**：左侧导航贴底新增「更新」入口 + 版本号，点击检查 `/update/check`；进度条按需出现（墨黑/绿/红三态，role=progressbar）；宿主未接壤时明确提示；真机断言 hold=chat&update=1；
- **v2.17（工具行真展开器 + 弹层不被遮挡）**：次要参数从「行内隐藏再塞回」改成一块悬浮面板 `.vig-tools-pop`（点外部/Esc 收起）；模型下拉抬 z-index、向上弹、限高滚动、宽度按视口收，修「64 项列表被裁/被工具行盖住」；
- **v2.16（素材目录迁移键）**：供应商管理·素材目录行新增「迁移到…」按钮（点开填新目录）→ `POST /config {stateDir}`，宿主把现有素材复制过去并保留旧目录；与输入框+保存两条路都通；真机断言：点击后 `/config` 收到新 `stateDir`；
- **v2.15（最近生成不重叠）**：折叠/滚动/渐隐从网格移到外层壳（`.vig-ps-recent-fold`），网格保持纯 grid —— 修 Chrome 里网格自带滚动时 `aspect-ratio` 失效导致的缩略图互相叠压；
- **v2.14（最近生成折叠）**：图片处理空态「最近生成」默认 2 行（第三行露半截 + 底部渐隐），头部「展开/收起」看全部，收起态内部可滚；截图 `docs/ui-audit/ps-recent-fold.png`（`--hold ps --query "hold=ps&many=1"` 用 12 张演示）；
- **v2.13（画笔粗细滑块）**：画笔粗细从五档胶囊（1/50/60/80/100）改成 `1–50` 连续滑块（默认 20），对话条内联显示数值；60/80/100 三档删除；
- **v2.12（结果卡图标 + 工具行折叠）**：结果卡四个动作从短文字改成无底色 SVG 图标并靠右；输入区工具行默认只留模型/尺寸/折叠器/发送，其余参数收进 `vig-fold`，整行去边框（hover 才出浅底）；
- **v2.11（引用留痕）**：局部改图提交时补 `referenceUrl`（本站 URL，非本站图先 upload 换 URL）——修「改了图但消息下面没有参考图缩略图，像没引用」；真机断言：`/generate` 里 `referenceUrl` 是本站 asset/upload 路径，气泡按 URL 显示缩略图、编辑/重试可找回原图；
- **v2.10（局部改图）**：大图视图加框选/画笔，两类选区都生成同尺寸 mask（白=重画），底部胶囊对话写一句指令即提交 `mode:edit` 的局部重画；宿主 `/generate` 新增 mask 通道（multipart `mask` 字段）；真机断言：框选 → 输入 → 提交后 `/generate` 带 mask + 1 张参考图；
- **v2.9（刊头）**：顶栏排成书刊刊头——logo 20/圆角 6 + 标题 13.5/650 + `STUDIO` kicker（9.5px、字距 .16em、三级灰）；右侧图标 24、stroke 1.05；顶栏 36px 通栏细条（宿主标签行不可由插件改动，故与标签行视觉贴合而非合并）；
- **v2.8（信息条悬浮）**：大图视图的信息条从占一行改成浮动在大图区底部居中（毛玻璃胶囊、白 92% + blur 12），英雄主视图拿回整块高度；条内单行不换行（名称 150 / 信息 200 截断）；
- **v2.7（顶栏贴合任务窗口）**：顶栏压到 34px、无圆角无阴影、与内容零间隙；品牌块缩到 22、标题 13.5/650；「拖出不可用」状态胶囊收成 20px 圆点（文案进 tooltip）；顶栏图标 stroke-width 降到 1.05（更纤细）；
- **v2.6（大图信息条与缩略条）**：名称缩小到 11px 并截断；「模型 · 分辨率 · 计数 + 右侧按纽组」整组居中（去掉 count 的 margin-left:auto）；缩略条跟随选中项平滑滚动并带 Q 弹动画；视图切换改成文字胶囊（网格 / 大图），与密度胶囊同一套规格；
- **v2.5（大图视图交互）**：左右隐藏式箭头上 hover 显形；大图区域滚轮切图带累积阈值 40px + 200ms 节流（连滚两下只切一张）；键盘/箭头/滚轮共用 stepActive；
- **v2.4（大图主从视图）**：图库加「网格 / 大图」视图切换；大图视图 = 上方固定大图（contain）+ 信息条 + 下方缩略条横向滚动，←/→ 切换，密度胶囊在该视图下隐藏；截图 `docs/ui-audit/layout-stage.png`。
