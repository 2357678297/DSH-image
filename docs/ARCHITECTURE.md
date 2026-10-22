# 对话工作台 · 架构重构方案（v1）

> 状态：**待确认**。本文只做架构定义与迁移计划，不动现有代码。
> 触发原因：「对话窗口逻辑都有问题，越做越错，越走越乱」——反复在同一个输入框上打补丁（上下文判定 / 对话优先 / 模式切换 / 优化提示词），本质是**消息模型没有分清楚**。
> 注：本轮联网检索不可用（搜索端点 402、抓取不通），参考部分来自公开产品的既有形态认知，未做在线核对。

---

## 一、现在为什么乱（问题清单，对应现有实现）

| # | 现象 | 根因 | 现有代码位置 |
|---|---|---|---|
| 1 | 同一句输入有时聊天、有时生图，用户无法预期 | 用「上下文模型判意图」（`/chat/plan` 的 reply/generate 分类）决定行为，模型判错就错；后又叠加「对话优先」「模式切换」「优化提示词」三种补救 | `client.js` `runGenerateFlow` 里 `plan.action` 分支、`dialogFirst`、`sendMode` |
| 2 | 消息顺序会乱、刷新后错位 | jobs 列表同时装「用户消息 / AI 回复 / 生图任务 / 失败卡」，顺序依赖 `clientSeq` + 时间戳补丁 | `ChatView` thread 排序、`clientSeq` |
| 3 | 切模型影响历史、历史任务重试打错模型 | 模型/尺寸是「全局配置」，但历史消息又各自记了模型，两套真相 | `config.defaultModel` vs `job.model` |
| 4 | 「生成中」互斥与排队互相干扰 | 用 `generating` 一个布尔同时表达：按钮禁用、排队、滚动、状态 | `generate` 的 `pendingSendsRef` / `setGenerating` |
| 5 | 失败卡、引用缩略图、重试入口形状不一 | 没有统一「消息 + 票据 + 产物」三层 | `JobTurn` / `JobError` / reply job |
| 6 | 会话看起来不像「对话窗口」 | 聊天回复与生图任务卡片混排，没有统一的角色语义 | `JobTurn` 的 `kind==="reply"` 特判 |

**一句话结论**：不是 UI 细节问题，是**数据模型问题**——`jobs` 一个数组承担了三种东西（对话消息 / 生成任务 / 产物），只能靠补丁维持。

---

## 二、参考工作台的共性（架构提炼）

公开产品的对话型生成工作台（ChatGPT 工具出图、Midjourney `/imagine` + 变体按钮、Sora/Flow 任务卡、Claude artifacts、Krea 参数面板）形态各异，但结构共性很一致：

1. **消息是不可变事实**：一条用户消息 + 一条 AI 消息就是一段历史；「改一下」「再来一张」是**新消息**，不是改旧消息。
2. **动作挂在消息/产物上**：重绘、编辑、放大、变体、保存——都是**产物上的按钮**，点完产生新消息/新票据。
3. **意图是显式的**：出图是**明确的动作**（发送按钮旁边就有「生成」、或 `/imagine` 命令），不靠模型猜「你这句话像不像要图」。
4. **参数是会话级配置**：模型、尺寸、数量、参考图属于「这一轮生成的参数面板」，不散落在消息里；切换参数不影响历史。
5. **任务有显式状态机**：queued → running → succeeded/failed，失败可重试（新票据挂同一消息），不污染消息文本流。
6. **上下文模型只服务生成**：优化提示词是「生成前处理」，聊天永远是直连对话模型。

---

## 三、新架构（本插件的定义）

### 3.1 数据模型（客户端视图层，宿主数据不动）

```ts
// 会话
Conversation { id, title, createdAt }

// 消息 = 不可变事实
Message {
  id: string                 // 客户端生成（msg_<seq>）
  conversationId: string
  role: "user" | "assistant"
  kind: "text" | "image" | "video" | "error"
  text?: string              // 用户原话 / AI 回复正文
  ticketId?: string          // kind=image/video/error 时关联生成票据
  artifacts: Artifact[]      // 产物（URL / 尺寸 / 名字）
  meta: {                    // 这条消息「怎么来的」，只做展示与重试
    action: "chat" | "generate" | "edit"
    model?: string
    size?: string
    endpoint?: string
    planNote?: string        // 优化后的提示词（仅 generate）
  }
  clientSeq: number          // 客户端发送序号，唯一排序依据
  createdAt: string
}

// 生成票据 = 一次异步任务，挂在一个 message 下
Ticket {
  id: string                 // 宿主 job id
  messageId: string
  status: "queued" | "running" | "succeeded" | "failed"
  error?: { code, message, upstream }
  images: Artifact[]
}

// 产物
Artifact { id, url, name, width, height, kind: "image" | "video" }
```

渲染顺序只看 `clientSeq`（历史消息来自 `/jobs` 时按宿主顺序 + 时间戳补齐）；**没有 reverse/sort 补丁**。

### 3.2 交互模型（这是本次重构的核心）

输入区**只有一个 textarea**，但**两个显式动作**：

```text
┌───────────────────────────────────────────────────────────┐
│ [参考图 chips]                                            │
│  输入框……                                                 │
│  [参数：模型 尺寸 数量]            [ 聊天 ] [ 生成图片 ]  │
└───────────────────────────────────────────────────────────┘
```

- **聊天**（Enter 默认，或点「聊天」）：`/chat/say` → assistant text 消息；
- **生成图片**（Cmd/Ctrl+Enter，或点「生成图片」）：`/generate` → ticket → 产物消息；
- 参数（模型/尺寸/数量）**只在生成动作里使用**，切换参数不影响历史消息；
- 「优化提示词」是**生成动作的前置选项**（默认关），只作用于 `/generate` 的 prompt；
- **删除全局「模式切换」**（图片/对话）——它把「一句输入要干什么」从动作降级成记忆状态，正是乱的来源。

### 3.3 状态机（一条用户消息）

```text
用户发送 ──[聊天]──► assistant(text)                      // 无票据
        └─[生成]──► ticket(queued) ──► running ──► succeeded → artifacts(image)
                                        └► failed → error 节点 + [重试]（新票据，同消息）
```

- 「生成中」只影响**该消息的票据**（按钮态、骨架），不再全局禁用输入；
- 排队：同一会话最多 6 条待发，按 `clientSeq` 顺序处理（沿用现有 Promise 链，但作用域改为「消息队列」而非「整个 generate」）；
- 滚动/未读/回到最新：只依赖消息数量变化，不依赖 role 混合。

### 3.4 组件树（对应现有代码要拆的位置）

```text
ChatView
├─ ChatHeader          （会话切换、清空/删除）
├─ MessageList         （按 clientSeq 渲染，滚动容器）
│   └─ MessageItem
│       ├─ UserText
│       ├─ AssistantText
│       └─ TicketItem  （状态机 + 失败卡 + 重试）
│           └─ ArtifactGrid （图片 + 动作：重绘/编辑/用作参考/保存/原图）
└─ Composer
    ├─ ReferenceChips  （参考图，最多 4）
    ├─ PromptTextarea
    ├─ ParamsBar       （模型/尺寸/数量/优化提示词 —— 仅生成用）
    └─ ActionBar       （[聊天] [生成图片]）
```

现有 `JobTurn` / `JobError` / `首屏 hint` / `dispatch` 全部收进 `MessageItem` 分支；`ChatView` 不再直接操作 jobs 排序。

### 3.5 宿主侧（尽量不动）

宿主 API 保持不变：`/chat/say`（对话）、`/chat/plan`（仅生成路径的优化提示词）、`/generate`、`/jobs`、`/job`。
只需保证：
- `/chat/say` 成功返回 `{ job: { kind:"reply", reply, model } }`（已是）；
- `/generate` 返回 ticket（已是）；
- `/jobs` 返回宿主顺序（已是，客户端排序）。

### 3.6 上下文管理（重新定位）

- **只服务生成**：`/chat/plan` 仅当「优化提示词」勾选 + 用户点「生成图片」时调用；
- **永远不参与聊天**：聊天直连 `/chat/say`，不经过 plan；
- 「对话优先 / 模式切换 / dialogFirst」全部删除（其需求由「显式两个动作」满足）。

---

## 四、迁移计划（4 步，每步可独立回滚）

> 原则：先建新视图层，再切动作，最后删旧逻辑——不在旧结构上继续打补丁。

### 第 1 步：消息视图层（零行为变化）
- 新增 `toMessages(jobs)`：把现有 jobs 映射为 `Message[]`（reply → assistant text；生成任务 → user 消息 + ticket；失败 → error）；
- `MessageList` 按 `clientSeq`/时间排序渲染；
- 现有动作（重试/重放/保存）原样接上。
- **验收**：UI 与现在一致，测试全绿；不再出现排序补丁。

### 第 2 步：Composer 双动作
- 输入区加 `[聊天] [生成图片]` 两个按钮 + Enter/Cmd+Enter 快捷键；
- 删除「模式切换」与「对话优先」UI；
- 聊天走 `/chat/say`，生成走 `/generate`（参数仅生成使用）。
- **验收**：同样的输入，点「聊天」只出聊天；点「生成图片」只出图；切换不记忆、不互相影响。

### 第 3 步：参数与优化提示词归位
- 模型/尺寸/数量移到 Composer 的参数栏（生成专用）；
- 「优化提示词」只影响生成，默认关；
- 历史消息只读展示当时的参数（`message.meta`），不随后续切换变化。
- **验收**：切模型不改变历史；历史任务重试用原参数（或明确「用当前参数重试」）。

### 第 4 步：清理与文档
- 删除 `sendMode` / `dialogFirst` / `looksLikeChat` 兜底等历史逻辑；
- 更新 `docs/UI-SPEC.md`、`README.md`；
- 测试补：消息模型单测（toMessages）、双动作真机断言、排序断言。

---

## 五、验收标准（重构完成的定义）

1. **行为可预期**：同一个输入框，两个动作各自明确——聊天不触发生图，生成不触发聊天；
2. **顺序永远正确**：刷新、切会话、连发、失败重试，消息顺序只按发送序号；
3. **参数不串**：切模型/尺寸不影响历史消息，历史重试参数可见可回退；
4. **失败可恢复**：失败只挂在该消息的 ticket 上，重试产生新票据不影响其它消息；
5. **无隐式判定**：没有「模型猜你要不要出图」的路径（`/chat/plan` 只做生成前优化）；
6. **测试**：client / viewer / host / engine 全绿，新增 `toMessages` 与双动作断言。

---

## 六、与用户已提需求的对应

| 用户原话 | 本方案 |
|---|---|
| 「对话窗口逻辑都有问题」 | 3.1/3.2 消息与动作模型重定 |
| 「越做越错，越走越乱」 | 删掉 pattern：上下文判定 / 对话优先 / 模式切换 |
| 「重新架构」 | 第四部分 4 步迁移，先视图层后动作 |
| 「找工作的台参考」 | 第二部分共性（消息不可变、动作在产物上、参数会话级、显式动作） |
| 之前：「视频参数/模型隔离/回到底部」 | 不受影响（都属于 MessageItem / 参数栏的重排） |
