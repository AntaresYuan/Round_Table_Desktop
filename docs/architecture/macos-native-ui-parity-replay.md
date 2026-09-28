# macOS 原生 UI 对齐：Turn 快照回放方案

状态：已接受（2026-09-20 决策见第 7 节），作为重开后 S2 的实施方案  
日期：2026-09-20  
适用范围：`apps/macos` 原生产品壳（S2 返工）与后续 Host Runtime 数据面

## 1. 背景：S2 与 Web 的实际差距

2026-09-20 在同一台机器上并排运行了两端：

- **Web**：`next dev` + dev 账号，默认 `local-dispatch` 适配器，完整跑完一个 Feature Builder mission（Intake → Clarify → Plan → 批准 → Build → Review → Delivery）。
- **Swift**：`Round Table.app`（内部 Xcode target 仍为 `RoundTableNative`；Debug，默认 1120×760 窗口），完整走过 New Mission → Approve Fixture → Execution → Review → Workflow。

结论：S2 只移植了 Web 的两个静态画面（空闲首页、New Mission），而 Web 的核心是 mission **运行中**的桌面。具体差距：

| 区域 | Web | Swift S2 |
| --- | --- | --- |
| 舞台 | 8 个座位（含 Planning/facilitator、You/chair）；运行时发言气泡、`step/steps` 进度、交接连线；白板变为 Run board | 静态图；welcome 卡片常驻并遮住桌面，默认窗口只露出 3 个座位；白板写死架构图，标题折行 |
| 批准/评审 | 留在桌面：Chat 中依次出现 Mission 卡、Plan 卡（任务/负责人/依赖/验收，`Start building`）、各 agent 结果卡、Delivery 卡（Accept / Request repair / Request tests） | 独立的橙色审批表单页、Execution 页、Review 页，Web 中不存在这些页面，视觉语言也不一致 |
| Workflow | 可编辑的阶段编辑器（排序、增删、席位、gate、模板存取） | 只读 4 步（Plan/Build/Review/Ship），与自身 New Mission 的阶段不一致 |
| Inspector | mission 前折叠；Files 列出真实产出（带版本，可渲染）；Notes/Skills/Memory 有内容 | 常驻展开并显示假消息；各 tab 为占位文案 |
| 侧栏/顶栏 | workbench 卡片、7 名成员可增删、真实 mission 列表；代码视图/设置/账号/深色模式 | 文字菜单、固定 5 人、写死的 1 条 mission；fixture 横幅占据顶栏；强制浅色 |
| 输入 | 底部 composer 可输入，支持 `@agent`；点头像进入 agent 私聊 | 底部 composer 是不可输入的 `Text` |

**根因**：[迁移计划](./macos-native-swift-migration-plan.md) 中 S2 的完成条件是"覆盖现有 **Electron** 用户流程"，而 Electron 流程是单 provider 的 `workspace → mission → approval → execution → review`。当前 Host Runtime DTO（[HostRuntimeDTOs.swift](../../apps/macos/Sources/RoundTableContracts/HostRuntimeDTOs.swift)）也只描述单次 execution，没有 Turn、Mission、planning meeting、workflow run 或多 agent dispatch。S2 忠实地实现了这份范围，但这份范围本身不是 Web 产品。

## 2. Web 的实时数据链路（现状事实）

1. **不是事件流，是快照轮询**。`dispatchStatus === 'running'` 时，`app-root.jsx` 每 1.2 s 调用 `GET /api/orchestrator/history`，返回当前 chat 的 Turn 列表，每个 Turn 是完整快照。
2. **Turn 快照**是唯一的数据源，主要字段：
   - 生命周期：`status`、`approvalStatus`、`dispatchStatus`、`dispatchStage`、`dispatchError`、`needsClarification`、`clarifyQuestions`；
   - `planningMeeting`：`participants`、`messages[{phase, agentId, role, content}]`、`decisions`、`risks`；
   - `plan.tasks[{id, owner, assignee, stageId, deps, parallel, objective, acceptanceCriteria}]`；
   - `workflow.stages[]` 与 `workflowRun.{activeStageId, stageStates, taskStates}`；
   - `dispatch[{taskId, agentId, status, events[], artifactIds}]`，`events` 为 `thinking_delta / tool_use / tool_result`；
   - `artifacts[{id, kind, title, ownerAgentId, version, preview}]`，`kind` 包括 `markdown / code / spec`；
   - `mission.{stages, tasks, checkpoints, decisions, finalDelivery}`；
   - 可选 `liveActivity`（真实 CLI 运行时的 transcript；`local-dispatch` 不产生）。
3. **场景是纯函数投影**。`src/ui/lib/live-scene.js` 中的 `buildLocalScene(baseScene, turns, agents, playback)` 把最新 Turn 投影为 `{ status[agentId], speech, tasks, work, run.phase, placed }`。Chat 卡片（`live-turn.jsx`）同样只读 Turn。
4. **发言节奏是前端生成的**。`local-dispatch` 的 7 条会议消息在后端 4 ms 内生成完毕。`app-root.jsx` 用 `planningPlayback.{meetingMessageIndex, meetingComplete}` 逐条播放，每条时长为 `planningMessageDuration = clamp(len × 27ms, 6s, 11s)`。
5. **未登录首页**使用另一套写死剧本（`RT.PLAN_TIMELINE` + `scene.clock`），与 live Turn 无关。

因此，只要能拿到"按时间排列的 Turn 快照"，就能在 Swift 中还原 Web 运行时的全部画面，**不依赖 S3**。

## 3. 回放素材格式

### 3.1 `TurnTimeline` fixture

fixture 位于 `apps/macos/Tests/Fixtures/TurnTimelines/`，首份为 `feature-builder-local-dispatch.timeline.json`：

```jsonc
{
  "format": "roundtable.turn-timeline",
  "version": 1,
  "source": { "adapter": "local-dispatch", "workflowTemplateId": "wf-feature-builder",
              "provider": "roundtable-local", "model": "agent-chain-v1", "capturedAt": "…",
              "capturedWith": "scripts/capture-turn-timeline.mjs" },
  "frames": [
    { "atMs": 1686, "gate": "plan_approval",     "turn": { /* planningMeeting + plan，dispatchStatus = not_started */ } },
    { "atMs": 2303,                              "turn": { /* approvalStatus = approved，dispatchStatus = running */ } },
    { "atMs": 2424, "gate": "delivery_decision", "turn": { /* dispatchStatus = completed，finalDelivery = ready */ } }
  ]
}
```

- `frames[].turn` 与 `/api/orchestrator/history` 返回的单个存储 Turn 完全相同，不做语义改写；客户端用 `storedTurnToLiveTurn`（`src/ui/lib/live-scene.js`）把它映射为 live turn。
- 只在 Turn 内容哈希变化时记录一帧。`gate` 标记需要用户动作才能继续的帧（`clarification`、`plan_approval`、`delivery_decision`），回放在此暂停。
- **pending 状态不在帧里**：服务端在规划完成前不保存 Turn，Web 的 pending 态是客户端在请求返回前自建的本地 turn。回放端在用户发起 mission 时同样自建，标准答案中对应 `pending` 步骤。
- 会议逐条发言**不**展开成帧，由客户端按第 2 节第 4 点的规则播放，与 Web 行为一致。

### 3.2 采集

`scripts/capture-turn-timeline.mjs`（需要非 production 的本地 Web dev server）：

```sh
node scripts/capture-turn-timeline.mjs \
  --out apps/macos/Tests/Fixtures/TurnTimelines/<name>.timeline.json \
  [--message "…"] [--workflow wf-feature-builder] [--adapter local-dispatch]
```

1. 用 dev credentials provider 登录一个新的一次性账号；
2. 调用 `POST /api/orchestrator/turn`，同时每 150 ms 轮询 `/api/orchestrator/history`；
3. 到达 `plan_approval` 后调用 `POST /api/orchestrator/approval`（`autoDispatch: true`），轮询到 dispatch 结束；
4. 脱敏：Turn 的 workspace 路径、仓库根、`$HOME` 与账号 id 分别替换为 `$WORKSPACE`、`$REPO`、`$HOME` 与 `user_fixture`。

`local-dispatch` 运行极快，只产生 3 个帧，也没有 `liveActivity`。R5 用 `scripts/synthesize-live-activity.mjs` 从录制帧派生合成 fixture `feature-builder-synthetic-live`：对话记录条目全部来自该任务录制的 dispatch 事件，任务按依赖分批启动，依赖同时完成的任务并发（与 Web 编排器一致，不代表 Phase 4 单 seat 的串行执行），文件标注 `synthetic: true` 与 `derivedFrom`。app 中通过 Mission › Replay Source 选择，选中时顶栏标明 synthetic。真实 `agent-cli` 录制推迟到 S6：在此之前它会以同 UID、`--permission-mode auto`、无隔离的方式运行 agent CLI。

### 3.3 投影 oracle

`scripts/generate-turn-scenes.mjs` 直接导入 Web 的 `buildLocalScene`、`storedTurnToLiveTurn` 与 `planningMessageDuration`，对每一帧生成 `<name>.scenes.json`：

- `steps[]`：`pending`、首个带会议的帧逐条展开的 `frame-N/meeting-K`，以及每帧会议播放结束后的 `frame-N`；每步记录 `playback` 与投影后的 scene（`live / started / status / speech / planPosted / work / run / tasks / placed`，其中 `placed` 只保留产出的 id、标题、类型、版本与负责人）；
- `agents`：投影使用的 agent 身份与角色（来自 `RT.AGENTS`，不含配色）；
- `meetingDurationsMs`：每条会议发言的播放时长。

`pnpm verify:macos:turn-scenes` 以 `--check` 模式确认标准答案与当前 Web 投影一致，已接入 CI（`verify:macos:contracts` 同样包含）。Web 的投影逻辑一旦变更，必须重新生成标准答案并同步检查 Swift 投影器。

## 4. Swift 侧结构

```text
TurnSource (protocol)                 ← 唯一数据入口，产出 Turn 快照序列
├─ ReplayTurnSource                   ← 读取 TurnTimeline，支持暂停 / 倍速 / 跳帧 / gate
└─ HostRuntimeTurnSource（S3 之后）    ← 订阅 Swift 编排（RoundTableOrchestration）发布的 Turn 快照流
        │
        ▼
RoundtableTurn (Codable DTO)          ← 第 2 节第 2 点的字段子集；未知字段忽略，仅限 UI 层
        │
        ▼
SceneProjector                        ← 移植 buildLocalScene + 会议播放状态机
        │                                 （meetingMessageIndex / meetingComplete / planningMessageDuration）
        ▼
@MainActor RoundtableViewModel
├─ RoundtableStage   座位、发言气泡、依赖/交接连线、Run board 白板
├─ WorkflowStrip     workflow.stages + workflowRun.stageStates
├─ ChatThread        MissionHeader / 会议记录 / PlanCard / AgentChainCard / ResultCard(Delivery)
└─ Inspector         Files（artifacts，可渲染 markdown/code）、Notes、Skills、Memory
```

R1 实现位于 SwiftPM target `RoundTableScene`（`apps/macos/Sources/RoundTableScene`），测试位于 `RoundTableSceneTests`。### 有意偏离 Web 的产品决策（2026-09-20）

对齐 Web 是 S2 的基线，但以下两处由用户决定按原生形态做，不再与 Web 并排对齐；若 Web 后续跟进，可反向同步：

1. **Workflow 不再是顶栏切换器**，改为侧栏导航项。侧栏结构变为：导航区（New Mission / Roundtable / Workflow / Workspace）+ 工作台区（workbench 卡片、成员、mission 列表）+ 本地工作区行。顶栏整条删除：Replay 状态挪到侧栏底部（本地工作区行上方），设置入口与侧栏的 Workspace 导航项重复，直接去掉。
2. **首次进入不再浮欢迎卡片**，改为整页空态：`What should the table build?` + 模板卡片 + 带团队/模板 chip 的入口行。开始 mission 后才出现圆桌。空态整体在 composer 上方的剩余空间里垂直居中，composer 固定贴窗口底。入口行按 Codex 的 composer 形态做：上沿贴一条内容自适应的上下文条（团队 / 模板），正文是目标本身，底行左侧写明 "Goal fixed in replay"、右侧是圆形发送键。S2 只有 Feature Builder 有录制素材，另两张卡片显示为 Unavailable。
3. **中间是对话，圆桌是右侧面板**。默认不打开圆桌：mission 开始后中间显示 chat（Web 里 chat 是右侧抽屉），底部是统一的 composer；点 composer 上的 workbench chip 才在右侧展开圆桌（`DesktopPanel.roundtable`），template chip 跳 Workflow 视图。Inspector 因此去掉了 Chat 标签。Web dock 的三件东西重新安置：workflow strip 移到对话上方靠右（放不下时切 compact 变体，只剩阶段胶囊），左侧是 mission 简称；推荐横幅紧跟在这行下面，状态行移进圆桌面板底部（它描述的是房间），dock 自己的板子背景与分隔线去掉——composer 直接浮在对话背景上。窗口默认 1360×820，chat 最小 480pt——放不下的面板会撑宽窗口而不是压扁对话。
4. **侧栏 New Mission（⇧⌘N）等于回首页**：中间回到空态、关掉面板，但当前 mission 继续留在侧栏列表里（视图状态 `showingStarter`，不碰 `MissionReplayModel`），点它即可回到对话——和 Codex 的 New chat 一致。空态卡片点进去才在右侧展开预填好的 mission 详情。交付物文件、mission 详情都在右侧面板打开，不再整页替换中间。窗口结构固定为「侧栏 · 圆桌 · 右侧面板」；面板一次只显示一个（New Mission / Inspector / 文件），文件从 Inspector 打开时关闭会退回 Inspector。原先覆盖全屏的 `ArtifactDrawer` 改为常驻列 `ArtifactPanel`。Workflow 与 Workspace 仍是整页切换。

5. **Workflow 页从只读渲染变成可编辑，模板存在本机**。网页版的用户模板本来就存在 `localStorage["rt.workflows"]`，所以这条不依赖 Host Runtime：编辑只是写配置，跑起来才需要运行时。桌面端只有一种模式（没有 server/localStorage 双轨）：内置模板由 `scripts/extract-workflow-builtins.mjs` 从服务端 `BUILTIN_WORKFLOW_TEMPLATES` 抽成 `apps/macos/Resources/workflow-builtins.json` 打包进 app（带 `--check`），用户模板写 `~/Library/Application Support/com.roundtable.desktop/workflows.json`（同 id 覆盖内置，可“恢复内置”）。两处有意优于 Web：
   - Web 的编辑器只提供 3 种 gate，编辑真实模板会把 `plan_approval`、`handoff_acceptance` 静默降级，卡片上还显示成 “no gate”；原生提供编排器认识的全部 7 种，未知 kind 原样保留并提示。
   - Web 的校验只在保存时由服务端报错（stage id 重复、没有可执行阶段/座位等）；原生把这些规则搬到本地，保存前就列出来并禁用保存。

6. **圆桌房间里去掉 Breakout 门**。Web 的门打开 breakout 房间（agent 之间的旁聊，走 tRPC `breakouts.*`），回放里没有这类数据，门在原生里只是一件点不动的摆设；等 Host Runtime 能承载 breakout 时再放回来。白板右上角的放大按钮原来也只是一个 `Image`，现在是真的按钮，打开等价于 Web `WhiteboardZoom` 的灯箱——而且放大后 Run board 不裁切（房间里那块会从底部裁掉任务列表），内容超出时可以滚动。

7. **跟子 agent 对话的入口在 composer 的上下文条里**。Web 靠在输入框里打 `@` 弹出 “Mention an agent” 列表；原生把同一份列表做成上下文条的第三个 chip（默认 “Talk to an agent”，选中后显示该 agent 的头像与名字），这样当前在跟谁说话始终可见。只在对话页的 composer 出现，空态的 composer 始终对整张桌子。回放期选中 agent 时发送禁用，提示写明需要 Host Runtime。

与 Web 的已知差异（R1–R4 累计）：

- Workflow 视图显示模板里真实的 gate 名称（Plan approval、Delivery acceptance 等）。Web 的 `GATES` 表只认识 `user_approval`/`reviewer_signoff`，对编排模板的 gate 一律显示 "no gate"；这是 Web 端的缺陷，原生不复制。
- Web 顶栏右侧显示账号与主题切换；原生没有顶栏，侧栏底部依次是 "Replay · Host Runtime not connected" 与本地工作区行（Web 此处是账号行），桌面端没有账号概念。
- 模板推荐横幅保留 Web 的判断规则与文案，但 "Use it" 禁用：Web 只改前端全局的演示模板，不影响运行；回放无法切换已录制的模板。
- `roundtable-live-run.json` 的内容：Web 写入 dev server 地址与 UI 状态，原生写入 `source: replay` 与同样的 turn 摘要字段。


- `placed` 只移植身份与顺序；`bundlePreviewArtifacts` 的预览 HTML 内联属于 Inspector 预览，放到 R4。
- `workByAgent` 在 Web 按 `liveActivity` 的对象键顺序迭代；Swift 字典无序，改为先按计划任务顺序、再按键名排序。只有同一 agent 同时运行两个任务时结果可能不同，Phase 4 单 seat 串行调度下不会出现。
- 超过 520 个 UTF-16 单元的发言截断时，若恰好切在代理对中间，Swift 以替换字符解码，Web 保留孤立代理项。

约束：

- 视图只读 `SceneProjector` 输出与 `RoundtableTurn`，不自行推导状态，以便切换到 `HostRuntimeTurnSource` 时视图零改动。
- `RoundtableTurn` 在 S2 是 **UI 展示 DTO**，不是安全协议，也不进入 Host Runtime v1 的 exact-key validator。S3 起 Turn/Mission 纳入 canonical contract（见第 7 节），届时由生成类型替换手写 DTO。
- 删除主导航中的独立 Execution / Review 页面。S5 的可信 diff、apply 确认，改为从 Delivery 卡片打开的 sheet，与 Web 的交互位置一致。
- 回放模式下，`Start building` / `Accept delivery` 只推进回放到下一段，不产生任何执行语义；界面上保留一处不遮挡桌面的 fixture 标识。
- S2 的 New Mission 入口只读展示所选 fixture 的精确 goal 和 workflow。未接入 Host Runtime 前，自定义 goal、其他 workflow 模板和 AI polish 保留 Web 的信息结构但明确禁用；界面不得接受一个目标后播放另一个目标的录制。
- 停止或重新开始回放必须调用 `TurnSource.cancel()`。取消需要释放任何 gate continuation、封闭事件流，且不得发送 `.finished`，避免把用户停止误报为任务完成。

### 4.1 截图用的 Debug 开关

只在 Debug 构建（`SWIFT_ACTIVE_COMPILATION_CONDITIONS = DEBUG`）中生效，用于不向桌面注入输入事件的并排截图：

| 环境变量 | 作用 |
| --- | --- |
| `ROUNDTABLE_REPLAY_SPEED` | 回放与会议播放倍速（所有构建都读取） |
| `ROUNDTABLE_REPLAY_SOURCE` | 回放来源（`feature-builder-local-dispatch` 或 `feature-builder-synthetic-live`；所有构建都读取，默认取 Mission › Replay Source 的设置） |
| `-appearance light\|dark\|system`（启动参数） | 覆盖 View › Appearance 的设置 |
| `ROUNDTABLE_REPLAY_AUTOSTART=1` | 启动 1.5 s 后开始回放 |
| `ROUNDTABLE_REPLAY_AUTOAPPROVE=1` | gate 到达并可操作后自动 Start building / Accept delivery |
| `ROUNDTABLE_REPLAY_GATE_PAUSE` | 自动通过 gate 前的停顿秒数（默认 3） |
| `ROUNDTABLE_CHAT_ANCHOR=bottom` | Chat 保持滚动到最后一张卡片 |
| `ROUNDTABLE_DEBUG_SECTION=workflow\|workspace` | 回放产生文件后切到该视图 |
| `ROUNDTABLE_DEBUG_PANEL=mission\|roundtable` | 在右侧面板打开 New Mission 或圆桌 |
| `ROUNDTABLE_DEBUG_STARTER=1` | 回放开始后显示空态（等价于点 New Mission） |
| `ROUNDTABLE_DEBUG_CONFIGURE=<stageId>` | 打开该阶段的 Configure 浮层 |
| `ROUNDTABLE_DEBUG_ZOOM_WHITEBOARD=1` | 回放开始后打开白板灯箱 |
| `ROUNDTABLE_DEBUG_TARGET=<agentId>` | 让对话 composer 预选该 agent |
| `ROUNDTABLE_DEBUG_HOVER_TITLE=1` | 钉住标题的 hover 卡片 |
| `ROUNDTABLE_DEBUG_INSPECTOR=<tab>` | 在右侧面板打开指定标签（files/notes/skills/memory） |
| `ROUNDTABLE_DEBUG_OPEN_FILE=<name>` | 在右侧面板打开指定文件（按 Files 行显示的文件名） |

通过 `open -n --env …` 启动，用 `screencapture -l <windowID>` 截取 app 窗口。

## 5. 验收方式

1. **语义**：Swift `SceneProjector` 对全部 fixture 帧的输出等于 `*.scene.json`。
2. **视觉**：对同一 fixture 的关键状态做并排截图——空闲、会议第 1 条和最后 1 条、awaiting approval、running、delivery；Web 用无头 Chrome 截图，Swift 用 `screencapture -l <windowID>` 截图，窗口统一为 1120×760 与 1440×900 两档。
3. **交互**：gate 暂停与恢复、agent 头像点击、Files 打开产出、Workflow strip 跳转。
4. **可访问性**：保留 S2 已有的 VoiceOver 标签与 `accessibilityIdentifier`，并为新卡片补齐。

## 6. 里程碑

| 编号 | 内容 | 依赖 |
| --- | --- | --- |
| R0 | 采集脚本 + 一份 `local-dispatch` Feature Builder fixture + scene 黄金文件 | 无 |
| R1 | `RoundtableTurn` DTO、`ReplayTurnSource`、`SceneProjector` 与逐帧测试 | R0 |
| R2 | 舞台（座位布局、发言气泡、连线、Run board）+ WorkflowStrip | R1 |
| R3 | Chat 卡片序列与 gate 交互；移除 Execution/Review 独立页 | R1 |
| R4 | Inspector Files/Notes、侧栏 mission 列表、只读 Workflow 视图对齐 Web 阶段 | R1 |
| R5 | `agent-cli` 真实 fixture（覆盖 `liveActivity`），深色模式，默认窗口尺寸下的布局修复 | R2–R4 |

Workflow 编辑器、workbench/成员管理、agent 私聊、Breakout、Settings 等**写操作**界面不在本方案内，因为它们需要真实数据面，放到 Host Runtime 能承载编排之后再做。

## 7. 决策记录（2026-09-20）

1. **S2 完成定义**：已改为对标 Web 产品的 mission 运行体验。此前按 Electron 流程完成的原生壳保留为 S2 历史子项，不再作为完成依据。[迁移计划](./macos-native-swift-migration-plan.md) §S2、[Checklist](./macos-native-swift-checklist.md) 与 [实施日志](./phase4-implementation-log.md) 已同步。
2. **原生编排归属**：在三个候选（Swift 重写、保留 TS 本地编排服务、远端编排）中选择 Swift 重写：在 Swift Host Runtime 中新建 `RoundTableOrchestration`，重写 intake/clarify、planning meeting、plan、workflow run、dispatch、handoff 与 delivery；Web 的 TS 编排作为行为 oracle。落地约束（见迁移计划 §5.2）：
   - 每个 agent 任务都是独立 execution，走完整的 grant → execution → staging/review/apply 链；
   - Phase 4 单 seat 下，`parallel` 任务串行调度，UI 仍按 Web 语义展示并行关系；
   - handoff 只传递 Host Runtime 投影的已封存产出；
   - intake/planning 的模型调用留在 Host Runtime，凭据规则不变。
3. **`RoundtableTurn` 纳入 canonical contract**：随编排改用 Swift 确定。S3 由同一 machine-readable contract 生成 TS 与 Swift 的 Turn/Mission 类型；S2 期间手写的 UI DTO 届时被替换。
4. **未登录演示剧本**：不移植。原生 App 的空闲态直接显示真实 workbench。
