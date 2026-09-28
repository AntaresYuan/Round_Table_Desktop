# Round_Table macOS 原生 Swift 重构 Checklist

状态：S0–S2 已完成（S2 尚余可访问性/窗口类人工验收）；S3 core、authenticated request/reply 与 deterministic Turn stream 已完成，workspace bookmark live gate 尚未关闭；S4–S7 尚未开始  
更新日期：2026-09-28

## S0：事实与边界

- [x] 冻结分支、HEAD、dirty tree 类别和保护规则
- [x] 记录 Swift、架构、macOS 和 Xcode 可用性
- [x] 标记 ADR-001 Electron 长期决策被取代
- [x] 冻结 P4-0/P4-1 既有事实与 P4-2–P4-6 缺口
- [x] 明确正式产物不得包含 Electron/Chromium/Node host

## S1：Canonical contract 与 Swift workspace

- [x] 建立 `apps/macos` SwiftPM workspace
- [x] 建立 `RoundTableContracts` target
- [x] 建立可编译的 SwiftUI bootstrap executable（不等同于 `.app`/签名验证）
- [x] service-uid-v1 generator 同时生成 TS/C/Swift mirror
- [x] Swift exact-key contract decoder
- [x] 重复字段、未知字段、嵌套字段、值漂移、digest 回归
- [x] macOS CI 加入 Swift contract tests
- [x] macOS CI 加入 TypeScript/Swift 共享 Host Runtime payload fixture tests
- [x] 完整 Xcode 27.0（build 27A266a）已安装并接受许可；使用 scoped `DEVELOPER_DIR`，不修改全局 `xcode-select`
- [x] 建立 SwiftUI `.app` Xcode target（含 bundle identifier、macOS 13 deployment target、App entry point；Xcode 27/Swift 6.4 universal build 通过）
- [x] 建立 Host Runtime bootstrap XPC service target（独立 executable/bundle 与服务入口；只返回 `unavailable`，不提供 operation endpoint）
- [x] 配置 App/XPC target 的最小必要 entitlements、Info.plist、嵌入关系与共享 scheme；不配置发布签名
- [x] 无特权构建并运行空 App、启动/停止空 XPC service 的 smoke test；App/XPC ad-hoc signature、bundle ID、arm64+x86_64 架构与退出后零 XPC 进程均通过
- [x] 制定 live wire protocol N/N-1 fail-closed policy（详见 Host Runtime Protocol Compatibility Policy）
- [x] 冻结 transport handshake：peer identity 先于解析、exact version、128-bit client/host nonce、connection-scoped session、失败断开
- [x] 增加 TS/Swift handshake 与未知版本、nonce、unknown/duplicate field fail-closed 合同测试
- [x] 冻结 Host Runtime state version、迁移检查点、回滚、未来版本与 quarantine 规则
- [x] **S3 request/reply 集成 gate**：2026-09-27 sandboxed signed development build 已可重复通过 exact v1、未知/降级版本拒绝、连接替换、request replay 拒绝和重连；服务端改为在 resume 前验证 App bundle id + Debug entitlement，App 端精确 pin 嵌入 XPC designated requirement，消除了沙盒读取外层 App 签名的 `EPERM` 路径。此项只关闭 development S3 gate，Developer ID/release gate 仍属于 S8
- [ ] **S8/Phase 5 集成 gate**：真实持久 store 的迁移、回滚和崩溃恢复验证
- [x] 提取 Desktop App ↔ Host Runtime canonical contract（13 个操作、request/response/event envelope、大小/速率上限、operation 绑定的 workspace/catalog/policy/mission/execution/review/apply 校验；真实 XPC service 仍未完成）
- [x] 提取 workspace/review/apply canonical contract（Swift 内部 DTO、精确字段与跨字段校验已完成）
- [x] 共享合同语料跨语言验证（service UID canonical mirror 覆盖 TS/C/Swift；Host Runtime fixtures 由 TS Zod 与 Swift strict decoder 共用验证，覆盖 workspace/catalog/mission/execution/review/apply/state/output/artifact）
- [x] 收紧并对齐 TS/Swift 嵌套约束：runtime policy、portable path/name、execution timestamps/error/summary/log 与 artifact size，并为拒绝路径增加负例
- [x] 冻结 `system.status.runtimeAvailability` exact nested schema、合法状态组合和 TS/Swift 共用 fixture；Provider 可用性继续由 `runtime.catalog` 表达
- [x] 将合法 availability tuples 纳入 canonical contract 并生成 Swift mirror；TS/Swift 都从同一 tuples 集合验证，覆盖全部合法组合与拒绝样例
- [x] Swift request envelope keys、provider 列表、速率与传输常量均由 canonical contract 生成；generator 对 operation maps、重复值和 availability tuple 引用做完整性检查
- [x] handshake 成功/失败 exact shapes、稳定错误码和 reply 后断开顺序进入 canonical contract 与 TS/Swift decoder tests

**当前进度：S1 已完成。** Xcode 27/Swift 6.4 下 Swift 32/32、Protocol 21/21、generator checks、protocol typecheck/ESLint、universal `.app`/嵌入式 `.xpc` build、ad-hoc signature、bundle identity、真实 bootstrap XPC 请求与退出后零 XPC 进程均通过。TypeScript Zod 校验标准 JSON 解析后的语义对象，Swift strict decoder 校验原始 wire bytes；共享 payload fixture 不代表两种解析器对所有 JSON 字节表示完全同判。bootstrap XPC 固定返回 `unavailable`，不能推出 authenticated endpoint 或 Phase 4 安全边界成立；真实 endpoint 配对继续属于 S3，持久 store 迁移属于 S8/Phase 5。

## S2：Swift 原生产品壳

2026-09-20 决策：S2 对标 Web 产品的 mission 运行体验，不再以 Electron 流程为完成依据。方案见 [原生 UI 对齐：Turn 快照回放方案](./macos-native-ui-parity-replay.md)。

### S2 重开范围（对标 Web）

- [x] R0：TurnTimeline 采集脚本、首份 `local-dispatch` Feature Builder fixture（已脱敏）与逐帧 `buildLocalScene` 黄金文件（`scripts/capture-turn-timeline.mjs`、`scripts/generate-turn-scenes.mjs`、`apps/macos/Tests/Fixtures/TurnTimelines/`；CI 检查 `verify:macos:turn-scenes`）
- [x] R1：`RoundtableTurn` DTO、`TurnSource`/`ReplayTurnSource`（倍速、gate 暂停）、`SceneProjector` 与会议播放状态机，逐帧等于黄金文件（SwiftPM `RoundTableScene` + `RoundTableSceneTests`；跳帧留到 R2 接入 UI 时按需补）
- [x] R2：舞台（全部座位含 facilitator/chair、发言气泡与 step/steps、依赖/交接连线、Run board 白板）与 WorkflowStrip（`workflow.stages` + `workflowRun.stageStates`）；Dock 状态行；回放 fixture 打包进 app（遗留：模板推荐横幅随 R4 Workflow 目录，IBM Plex 字体，白板放大、座位私聊、Breakout 等交互）
- [x] R3：Chat 卡片序列（Mission、Plan + Start building、agent 结果、阶段卡、Delivery 的 Accept/Repair/Tests）与 gate 交互；移除独立审批、Execution、Review 页与 fixture 状态机（`MissionThread` + `MissionChatView`；Repair/Tests 在录制回放中禁用；可信 diff/apply 的 sheet 随 S5 接入）
- [x] R4：Inspector Files（按版本列出，抽屉打开原文）/Notes，顶栏与侧栏（workbench 卡片、7 名成员、mission 列表）按 Web 结构，Workflow 只读视图与模板阶段一致，模板推荐横幅（`Workbench.swift` + `WorkbenchChrome.swift`；Skills/Memory、workbench 与成员管理、Workflow 编辑随 Host Runtime 编排与持久化）
- [x] R5a：深色模式（Web neutral dark token，跟随系统，View › Appearance 可选 System/Light/Dark）、IBM Plex 字体随 app 打包（OFL）、1120×760 默认窗口布局修复（R2–R3 已处理舞台与 Chat 窄面板）
- [x] R5b：`liveActivity` 用合成 fixture 覆盖（`scripts/synthesize-live-activity.mjs` → `feature-builder-synthetic-live`，标注 `synthetic: true`；舞台 now-doing 气泡、Chat/阶段卡 `LiveTranscriptFeed`；Mission › Replay Source 可选）
- [x] fixture 入口语义收口：New Mission 只读显示所选 fixture 的精确 goal 和 workflow；自定义 goal、Bug Fixer、Codebase Onboarding 明确禁用并标注依赖 Host Runtime；启动后的 Chat goal 与入口逐字一致
- [x] 回放取消收口：`TurnSource.cancel()` 可释放暂停在 gate 的 continuation，取消不发送 `.finished`；有 Swift 回归测试覆盖
- [ ] 真实 `agent-cli` 录制：用户决定推迟到 S6 隔离 seat 可用后（当前每个任务会以 `claude -p --permission-mode auto` 在同 UID 下无隔离运行）
- [x] 验收（视觉）：空闲、会议、awaiting approval、running、delivery 在 1120×760 下与 Web 并排截图核对；深浅色均已截图核对
- [ ] 验收（其余）：1440×900 并排截图、VoiceOver 走查、键盘导航、缩放、窗口恢复的明确测试（本轮 AX 树已确认只读 goal、禁用模板和入口/Chat goal 一致，但不替代这些验收）

### S2 历史子项（按 Electron 流程完成，保留为基础，不再作为 S2 完成依据）

- [x] workspace 与 Mission UI（NSOpenPanel 只选路径并保存在窗口内存；不可用 Host Runtime 时不读取目录、不创建 bookmark/grant）
- [x] 可信 approval UI（明确显示并冻结 workspace、provider、prompt 快照；批准动作仅记录 fixture，不启动进程）
- [x] execution、log、Artifact UI（明确标记 simulated/synthetic；不声称真实执行或扫描）
- [x] diff/review/apply/reject UI（可查看并拒绝 synthetic diff；Apply 明确禁用，等待 S3 authenticated runtime 与 authorized apply）
- [x] AppKit picker、原生菜单/快捷键、窗口布局、用户主动启用的完成通知、VoiceOver labels/hints/identifiers
- [x] 手动原生 fixture 流程：打开 Mission → prepare → 检查冻结审批摘要 → approve → 检查执行/日志/artifact → 查看 diff → reject；Apply 显示 disabled。全程没有 provider、文件读取或 workspace 写入
- [x] 原生默认首页对齐 Web Roundtable 的信息层级：workbench switcher、成员、New Mission、workbench mission list、workspace/account area、中心团队舞台、Plan/Build/Review/Ship 与底部 mission entry；保持 native SwiftUI 实现
- [x] New Mission 从首页、侧栏和底部输入入口统一创建空白 fixture draft；Reset Mission 回到 mission 草稿态，不再跳离任务流程

Web 参考源：`src/ui/components/chat.jsx` 的 `ConversationRail`、`src/ui/components/app-root.jsx` 的初始 welcome overlay/底部 Dock，以及 `src/ui/styles/tokens.css` 的 `neutral` light tokens。此为 S2 原生壳的信息架构和视觉语言对齐，不代表复制 Web Roundtable 的实时 agent scene、持久化、多 workbench 数据或 provider 能力。

## S3：Swift Host Runtime

- [x] 纯 Swift core：有界 admission queue、approval TTL/owner/single-use、Phase 4 单 execution、严格状态/事件序列与 shutdown barrier
- [x] 将 admission/execution core 接入 authenticated live XPC dispatcher；S3 的 worker 是不启动进程的 deterministic adapter
- [x] 纯 Swift session core：connection generation、openSession owner、CSPRNG nonce、requestId replay window、速率限制与 fail-closed connection replacement
- [x] 纯 Swift dispatcher core：13 项 operation 穷举、session gate 先于 handler、canonical response 自校验；workspace/status/catalog/mission/execution 已启用，review/apply 保持稳定 unavailable
- [x] development live XPC peer admission：服务端在 resume 前要求 App bundle id + Debug `get-task-allow` entitlement，并绑定 OS EUID/peer ASID；App 端从自身 sealed bundle 取得并精确 pin 嵌入 XPC designated requirement。沙盒内不再读取外层 App executable，`EPERM` 阻塞已消除。此项仅为 development assurance，不能替代发行签名边界
- [x] release peer attestation 代码：Release 要求 Apple generic anchor + App bundle id + 10 位 Team ID，缺失 Team ID 时初始化 fail closed；Debug/Release entitlements 已分离。真实 Developer ID 构建、公证和对抗证据仍属于 S8 发行 gate
- [x] live request/reply compatibility gate：v1 exact-match、未知/降级版本拒绝、连接替换、request replay 拒绝和重连均在 sandboxed signed smoke 通过；当前 policy 明确不宣称 N-1 兼容
- [x] workspace identity core：canonical root、device/inode、grant generation、session owner、替换/软链接 fail-closed
- [ ] security-scoped bookmark transfer、单次 transferId 消费、scope lifetime 与 live workspace.register/list：纯 Swift core 已覆盖；2026-09-28 ad-hoc sandbox App 创建的 bookmark 在 App 内可解析，但跨 bundle 到 XPC 时 `URL(resolvingBookmarkData:)` 返回 Cocoa 259，live gate 仍 fail closed
- [x] provider catalog/fingerprint/capability core：仅接受显式 canonical executable，拒绝 symlink、非普通/不可执行、group/world-writable，冻结并复验 SHA-256 + device/inode/size
- [x] S3 不启动 Provider：deterministic adapter 明确只消费 committed TS oracle；实际 provider 配置、service-UID worker launch、stdio/process tree 属于 S4/S6
- [x] 纯 Swift core：state/output 共用序列、有界 event replay、UTF-8 输出上限、日志背压/丢弃计数与 shutdown barrier
- [x] live Turn event transport：有界 response、严格递增 sequence、connection-session owner、afterSequence replay、断线 owner 撤销；Provider 日志诊断与 tree/stdio settlement 随 S4 worker 接入
- [x] TS oracle 行为等价验证：Swift 对相同 `feature-builder-local-dispatch` oracle 逐 Turn 做结构等价比较；TS Zod 同时验证相同 oracle frames
- [x] `RoundTableOrchestration` deterministic FSM：规划会议、plan approval、串行 dependency dispatch、delivery decision 与 terminal/stop 状态均由 Host Runtime 持有；无网络、无 Provider、无 workspace 写入
- [x] 编排 dispatch：oracle 的每个 task 唯一完成且依赖先行；`parallel` 标记在 Phase 4 单 seat 下仍按记录顺序串行；不接受缺任务、重复任务或越过 dependency 的 oracle
- [x] 确定性适配器：Swift 输出与 TS `local-dispatch` 三个 Turn 快照逐对象等价，恶意/超限 oracle fail closed
- [x] Host Runtime → App 的有界 Turn 快照流（序号、断线重放）；recorded mission 已使用 `HostRuntimeTurnSource`，synthetic Debug fixture 继续使用 `ReplayTurnSource`
- [x] Turn stream 纳入 canonical contract：actions/gates/大小与 replay ownership 由同一 JSON 生成 TS/Swift constants；TS Zod 与 Swift strict duplicate-key decoder 共用边界，App 仅消费有界 display DTO

**2026-09-28 验证快照：** session registry 增加“verified candidate 只有在 strict handshake 成功后才晋升”的两阶段 replacement，防止旧 `NSXPCConnection` 透明重连抢占 active authority；新增回归测试后该 suite 8/8，完整 `swift test` 111/111、Protocol Vitest 24/24、typecheck、ESLint、generator drift check、Debug/Release build通过，`live`、downgrade/replay/reconnect `security` 与 Turn `orchestration` smoke 通过。`workspace` live smoke 当前返回 `workspace_transfer_invalid`（Cocoa 259），不得沿用 2026-09-27 的通过判断。真实 Developer ID/release attack gate、service UID worker、Provider、staging/review/apply 均未由这些结果证明。已安装的 `/Users/yuanchenjie/Applications/Round Table.app` 未被替换。

**S3 当前边界：** Swift Host Runtime 基础、authenticated request/reply 与 deterministic mission 闭环已完成；S3 仍等待真实 user-selected workspace capability 跨 App/XPC 的 live 证明。该 gate 关闭后才进入 S4。即使 S3 关闭，也不等于 Phase 4 完成；真实 Provider/process tree、service UID、staging、可信 review/apply、发行签名与攻击/故障矩阵继续由 S4–S7/S8 关闭。

## S4–S7：Phase 4 安全闭环

- [ ] S4 / P4-2 真实 native service UID lifecycle
- [ ] S5 / P4-3/P4-4 staging、review、authorized apply
- [ ] S6 / P4-5 真实 Provider E2E（含一个多 agent mission：计划批准 → 两个依赖任务经同一 seat 串行执行与 handoff → delivery → review/apply）
- [ ] S7 / P4-6 攻击与故障 gate
- [ ] 集成后一次管理员事务重验
- [ ] host/root 最终残留证据一致

## S8：退役与发行

- [ ] Swift SQLite 和唯一持久状态写入方
- [ ] 按冻结的 state version/journal 规则实现迁移、回滚、未来版本拒绝与崩溃恢复测试
- [ ] Phase 6 业务闭环
- [ ] Phase 7 Developer ID、公证、更新、升级/卸载
- [ ] 正式 bundle 扫描确认无 Electron/Chromium/Node host
- [ ] Electron 从 release target 和 release CI 删除
