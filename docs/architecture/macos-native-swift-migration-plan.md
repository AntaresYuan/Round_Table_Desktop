# Round_Table macOS 原生 Swift 重构计划

状态：已接受的目标方向，实施计划待逐阶段验收  
日期：2026-09-13  
适用范围：Round_Table Desktop 的 macOS 产品壳、宿主运行时、原生服务与发行链路

本文根据现有七阶段路线、Astra Phase 4 目标和 Sol Phase 4 执行链路，定义 macOS 优先且最终移除 Electron/Chromium/内置 Node 桌面运行时的重构方案。它取代 ADR-001 中“Electron 作为正式 macOS 产品壳”的长期决策，但不改写 Phase 1–3 的历史完成事实，也不降低 ADR-002 的 service UID、窄 Broker、staging 和 authorized apply 安全要求。

> 2026-09-20 决策更新（依据 [原生 UI 对齐：Turn 快照回放方案](./macos-native-ui-parity-replay.md) 的并排实测）：
>
> 1. **S2 重开**，对标对象由“现有 Electron 用户流程”改为“Web 产品的 mission 运行体验”。此前按 Electron 流程完成的原生壳保留为 S2 的历史子项，不再作为 S2 完成依据。
> 2. **多 agent 编排用 Swift 重写**，归属 Swift Host Runtime。Web `src/server` 中的 TypeScript 编排作为行为 oracle；Web 产品本身继续使用 TypeScript。

## 1. 最终目标

Round_Table 的正式 macOS 产品采用 SwiftUI 和 AppKit，使用原生进程、XPC、Service Management、SQLite 与 macOS 签名/公证链路。正式 `.app` 不包含 Electron、Chromium 或作为宿主运行时的 Node.js。

现有 Web 产品继续使用 TypeScript。Web 与 macOS 通过语言中立的领域/协议定义共享语义，不要求两端共享同一运行时或 UI 实现。

最终产品拓扑：

```text
RoundTable.app（登录用户 UID）
├─ SwiftUI/AppKit UI
│  ├─ workspace picker / security-scoped access
│  ├─ mission、可信审批、diff/review、apply 确认
│  └─ 菜单、窗口、通知、设置、诊断
├─ RoundTableHostRuntime.xpc（登录用户 UID）
│  ├─ admission、execution FSM、provider adapter
│  ├─ workspace baseline、staging scan、review bundle
│  ├─ apply authority、artifact、日志、secret projection
│  └─ Phase 5 SQLite、journal、恢复
├─ 原生窄协议
│  ├─ App ↔ Host Runtime：用户意图和数据面
│  └─ Host Runtime ↔ Privileged Broker：固定生命周期控制面
├─ RoundTablePrivilegedBroker（root，SMAppService LaunchDaemon）
│  └─ service identity、固定目录、seat、停止、清理与证明
└─ RoundTableSeatWorker（专用 service UID）
   └─ 在 execution HOME/TMP/staging 中启动真实 Provider 及其后代
```

Swift 是产品层和受信任宿主运行时的主语言。现有 C 代码是原生代码，不因语言统一而自动重写。凡涉及 audit token、CDHash、Mach/XPC wire、`posix_spawn`、bootstrap port、进程枚举或 canary 的小型 C 模块，只有在 Swift 替代实现具备相同可审计性、共享语料和攻击证据后才能替换。最终目标是没有 Electron/Node 桌面运行时，而不是追求 100% Swift 源文件。

## 2. 不变量与非目标

Swift 重构不得改变以下 Phase 4 不变量：

1. Provider 及全部后代运行在独立、不可登录、非管理员的 service UID；Phase 4 只有一个 seat 和一个真实并发 execution。
2. root Broker 不运行或解析 Node、shell、Provider、仓库内容、prompt、stdout、Artifact、diff 或 apply 数据。
3. Provider 只能写 execution-scoped staging，不能直接写真实 workspace。
4. 真实 workspace 只有在 diff/review、grant/identity/conflict 重验和一次性 authorized apply 后，才由登录用户 UID 修改。
5. Seatbelt 只是纵深防御；跨 UID 事实、完整进程树退出和 service UID 零进程证明才是一级边界。
6. Secret 不进入 argv、plist、日志、Artifact、Renderer/UI DTO 或 root Broker；不得读取或复用 `~/.codex/auth.json`。
7. 未知、超时、崩溃、协议矛盾、身份矛盾和残留证据不一致均 fail closed，并在需要时 quarantine。
8. 开发 gate 的一次管理员授权语义不变；Swift 重构不能引入常规多次授权流程。

本计划不把以下事项混入 Phase 4 完成声明：

- 多 UID seat pool、默认 VM 隔离、正式 Developer ID/公证和完整升级/卸载矩阵；这些仍属于 Phase 7。
- Web 端重写为 Swift 或废弃 Web 产品。原生编排用 Swift 重写（见 §3），但 Web 的 TypeScript 编排继续服务 Web，两者以共享 fixture 和 oracle 约束语义。
- 以 Swift 类型安全、App Sandbox、codesign 成功或 XPC 可连接替代攻击验证。
- 为了迁移方便恢复同 UID 真实 Provider fallback。

## 3. 现有实现的处置

| 现有资产 | 最终处置 | 迁移期间用途 |
|---|---|---|
| `apps/desktop` Electron Main/Preload/Renderer | 等价验证完成后从正式 macOS 构建移除 | 行为 oracle、fixture UI、回归对照 |
| `apps/desktop/src/execution-authority.ts` | 以 Swift actor/state machine 重建 | 冻结 approval、execution、owner 语义 |
| `apps/desktop/src/workspace-grants.ts` | 以 Swift capability registry 重建 | 冻结路径、identity、generation 语义 |
| `apps/desktop/src/staging-execution.ts`、`review-*` | 移入 Swift Host Runtime | 用共享 fixture 验证 manifest/diff/apply 等价性 |
| `apps/desktop/src/utility-agent-runtime.ts` | 由 Swift XPC Host Runtime 取代 | 仅保留到原生 host lifecycle 通过 |
| `packages/runtime` 平台无关规则 | 按功能迁移到 Swift package；TS 版本服务 Web/测试 | 作为输入输出 oracle，禁止双写长期状态 |
| `packages/runtime/native/service-uid` | 默认保留并封装；逐文件决定是否迁移 Swift | Phase 4 安全核心和攻击 gate |
| `packages/protocol` Zod DTO | 改由 canonical schema 生成 TS 与 Swift | 迁移期跨语言一致性验证 |
| `packages/domain` | 保留 TS Web 实现，新增生成的 Swift model | 以 canonical schema 消除手工漂移 |
| `src/server` 编排（turn、intake/clarify、planning meeting、plan、workflow run、dispatch、handoff、delivery） | 在 Swift Host Runtime 的 `RoundTableOrchestration` 中重写；Web 继续使用 TS 实现 | 行为 oracle：相同输入与确定性适配器下，Swift 产出的 Turn 快照与 TS 等价 |

Electron 退出条件是原生纵向链路和恢复/攻击 gate 全部通过，不是 Swift 窗口能够打开。退出后不得在正式 target、签名嵌套代码、更新包或安装清单中继续包含 Electron、Chromium、Electron preload 或本地 Node host。

## 4. 目标模块与权限矩阵

| 模块 | 身份 | 可读 | 可写 | 明确禁止 |
|---|---|---|---|---|
| Swift App | 登录用户 UID | UI DTO、用户选择结果、review bundle | UI state；通过 Host Runtime 请求 apply | Provider secret、root 目录、任意 Broker 命令 |
| Swift Host Runtime XPC | 登录用户 UID | grant 后 workspace、staging 封存结果、scoped credential source | 私有状态、SQLite、host staging 元数据、mission 编排状态与 Turn 快照、authorized apply | root 执行、未审批回写、直接以 service UID 冒充执行、绕过 execution 链直接运行 agent 任务 |
| Privileged Broker | root | 固定 manifest、签名身份、seat/进程事实 | 固定系统目录、service identity、seat lifecycle journal | prompt、diff、Provider stdout、任意 path/command/UID |
| Seat Worker | service UID | 当前 execution 配置、一次性 secret FD、staging | 当前 execution HOME/TMP/staging | 登录用户 HOME、真实 workspace、用户 bootstrap control |
| Provider tree | service UID | 被批准且投影到 execution 的最小输入 | staging | Host Runtime/Broker secret、其他 execution、真实 workspace |

Swift App 不直接拥有 root 能力。Host Runtime 是登录用户侧的唯一执行协调者，也是 mission 编排的唯一执行者；App 只提交用户意图（创建 mission、回答澄清、批准计划、交付决定），并订阅 Turn 快照。Broker 仍是窄控制面，Seat Worker 才是 Provider 数据面的父进程。UI、Host Runtime、Broker、Seat Worker 四者使用不同 DTO 集合，避免一个“万能协议”扩大权限。

## 5. 协议与状态模型

### 5.1 Canonical contract

建立单一 machine-readable contract，至少生成：

- Swift `Codable` request/response/event 类型；
- TypeScript/Zod validator，供 Web、迁移 oracle 和 fixture 使用；
- C 常量/枚举/边界检查，供窄 native 模块使用；
- 正常、边界、未知字段、重复字段、超限、重放和版本错配语料。

协议必须使用 exact-key、显式版本、固定大小上限、稳定错误码和请求关联 ID。Swift `Decodable` 默认忽略未知字段，不能直接作为安全协议 validator；生成层必须显式拒绝未知字段和非 canonical 表示。

### 5.2 三条状态链

实现必须分别保存并关联：

1. `workspace grant → mission → approval → preparation`；
2. `execution → lease → seat → provider tree → stop proof`；
3. `baseline → staging seal → review hash → apply challenge → apply journal`。

三条链通过不可混淆的 typed ID 和内容摘要连接。任何连接缺失、代际不一致或恢复后无法唯一解释时，保持 unavailable/quarantined。

编排层在三条链之上增加 mission 链：`mission → intake/clarify → planning → plan approval → task dispatch → delivery decision`。约束：

- plan approval 冻结任务集合、负责人、依赖与每个任务的输入摘要；计划变更（repair、新增任务）必须重新批准。
- 每个 agent 任务都是一次独立的链 1→链 2→链 3，不能共享 execution、seat lease 或 staging。
- Phase 4 只有一个 seat（§2 不变量 1）：workflow 中标记为 `parallel` 的任务在 Phase 4 **串行**调度，UI 仍按 Web 语义展示并行关系；真实并发属于 Phase 7 的 seat pool。
- 任务间 handoff 只传递已封存的 staging 产出摘要和内容，不传递 seat、路径或凭据；下游任务看到的是经 Host Runtime 投影的只读输入。
- planning meeting、intake 等模型调用在 Host Runtime（登录用户 UID）内进行，凭据遵守 §2 不变量 6；不进入 App、Broker 或 Seat Worker 的 DTO。

### 5.3 XPC 身份

- App ↔ Host Runtime：限制为当前签名 App 启动和拥有的 XPC service；绑定 audit token、bundle designated requirement、EUID、ASID、连接 generation 和随机 session nonce。
- Host Runtime ↔ Broker：双向代码身份验证；Broker 从 audit token 获取调用者事实，不信任请求体中的 UID/PID/身份声明。
- 请求完成与 event stream 必须处理连接重建、重复响应、乱序、迟到消息和对端崩溃。
- XPC interface 只传递有界 value object 或 canonical bytes；不暴露任意 selector、路径、command、environment 或 file operation。

## 6. Swift 工程结构

目标目录：

```text
apps/macos/
├─ RoundTable.xcworkspace
├─ RoundTableApp/                 # SwiftUI/AppKit app target
├─ RoundTableHostRuntime/         # 登录用户 XPC service target
├─ RoundTablePrivilegedBroker/    # root daemon target / C interop
├─ RoundTableSeatWorker/          # service UID 固定 worker
├─ Packages/
│  ├─ RoundTableDomain/
│  ├─ RoundTableContracts/
│  ├─ RoundTableWorkspace/
│  ├─ RoundTableExecution/
│  ├─ RoundTableOrchestration/    # mission 编排：intake、meeting、plan、workflow run、dispatch、delivery
│  ├─ RoundTableReview/
│  ├─ RoundTableStorage/
│  └─ RoundTableNativeBoundary/
└─ Tests/
   ├─ ContractCorpusTests/
   ├─ StateMachineTests/
   ├─ WorkspaceSecurityTests/
   ├─ RuntimeIntegrationTests/
   └─ AppUITests/
```

仓库仍使用 monorepo。根级 CI 同时运行 pnpm/Web checks、Swift Package/Xcode checks 和 native gate。Swift 版本、Xcode 版本、macOS deployment target 和 architecture matrix 必须从本机/CI 实际工具链验证后固定，不能仅按计划文本假定。

## 7. 分阶段实施链路

### S0：重新冻结事实与迁移边界

- 记录 dirty tree，保护全部未提交/未跟踪用户工作。
- 冻结当前 Electron 行为、公共 DTO、状态转换、错误码和 Phase 4 gate 证据。
- 新增本 ADR/计划对应的 decision record，标记 ADR-001 的 Electron 长期决策被取代。
- 明确正式产物中 Electron/Node 的零包含验收方法。

完成条件：迁移资产表、保留/重写/删除清单和行为基线可审查；不执行破坏性目录移动。

### S1：Canonical contract 与 Swift workspace

- 建立 `apps/macos` 和独立可构建的 Swift targets。
- 从现有 protocol、runtime-private protocol 和 service-uid-v1 corpus 提取 canonical contract。
- 生成 Swift/TS/C 类型并运行共用 corpus。
- 建立 protocol compatibility policy：开发期允许同版本 fail closed；发行前定义 N/N-1 升级矩阵。

完成条件：Swift、TS、C 对同一语料给出相同接受/拒绝和稳定错误码；空 App 与 XPC service 可无特权构建测试。

### S2：Swift 原生产品壳（2026-09-20 重开）

对标对象是 Web 产品的 mission 运行体验，不是 Electron 流程。方案见 [原生 UI 对齐：Turn 快照回放方案](./macos-native-ui-parity-replay.md)。

- 以 `TurnSource` 为唯一数据入口；S2 使用读取 `TurnTimeline` fixture 的 `ReplayTurnSource`，S3 之后换成 Host Runtime 编排产出的 Turn 快照，视图不改。
- 移植 Web 的场景投影（`buildLocalScene` 与会议逐条播放），用 Web 生成的逐帧 scene 黄金文件验证等价。
- 还原运行中的桌面：座位与发言、依赖/交接连线、Run board、workflow strip、Chat 卡片序列（Mission、会议、Plan + Start building、agent 结果、Delivery 决定）、Inspector 产出。
- 批准与交付决定留在桌面流程内；可信 diff 与 apply 确认从 Delivery 卡片以 sheet 打开，不再是独立页面。
- 用 AppKit 补齐窗口生命周期、文件选择、菜单、快捷键、通知、最近项目和可访问性。
- 所有事件更新进入 `@MainActor`；I/O、hash、diff、扫描和进程等待不得阻塞主线程。
- UI 只显示 Host Runtime 返回的有界 DTO，不接触路径映射、credential 或 Broker。

完成条件：同一 fixture 下，原生 UI 的 scene 投影逐帧等于 Web 黄金文件；空闲、会议、awaiting approval、running、delivery 五个关键状态在 1120×760 与 1440×900 两档窗口下与 Web 并排截图对齐；VoiceOver、键盘导航、深浅色、缩放和窗口恢复有明确测试。Workflow 编辑、workbench/成员管理、agent 私聊、Breakout 和设置等写操作界面随编排与持久化落地，不属于 S2。

### S3：Swift Host Runtime 基础

- 用 Swift actor 实现有界 queue、approval TTL、单 execution admission、事件序列和 shutdown barrier。
- 重建 workspace grant：bookmark/canonical path/device/inode/generation 绑定，并明确 security-scoped bookmark 与普通本地路径的差异。
- 将 provider catalog、executable fingerprint 和 capability declaration 移入 Host Runtime。
- 建立结构化日志、去敏、背压、输出上限和诊断导出。
- 建立 `RoundTableOrchestration`：Turn/Mission 模型、workflow 模板与 stage FSM、intake/clarify、planning meeting、计划生成与批准、按 §5.2 串行调度的 dispatch、handoff 投影和 delivery 决定。首个适配器是与 TS `local-dispatch` 等价的确定性适配器，只产出 staging 内的 fixture 产出，不启动 Provider。
- 通过 Host Runtime 向 App 发布有界的 Turn 快照流（带序号，可断线重放），替换 S2 的 `ReplayTurnSource`。

完成条件：用现有 TS 行为 oracle 和恶意 fixture 做等价测试；同一输入与确定性适配器下，Swift 编排产出的 Turn 快照序列与 TS 编排等价（时间戳与随机 ID 归一化后）；Swift Host Runtime 崩溃、连接断开和重复请求均 fail closed。

### S4：完成 P4-2 原生 service UID lifecycle

- 将当前 native listener 的空 callbacks 接到真实 workspace/provider authorization。
- 实现真实 Seat Worker launcher、一次性 secret FD、execution HOME/TMP、staging ACL。
- Host Runtime 使用正式 v1 control-plane adapter；不存在 legacy same-UID fallback。
- 停止同时验证 provider tree、UID 零进程、stdio settlement 和 staging seal。

完成条件：P4-2 所有 checklist 项由 live native 证据关闭；fixture 和 development native assurance 保持严格区分。

### S5：完成 P4-3/P4-4 staging、review 与 apply

- Swift Host Runtime 捕获 baseline，Broker 只创建固定 staging root/ACL。
- Swift 扫描器拒绝 symlink/hardlink/special-file/mount escape，并执行数量、大小和时间上限。
- review bundle 内容寻址且不可变；Swift App 展示可信摘要和 diff。
- apply challenge 绑定 grant generation、workspace identity、baseline hash、review hash 和单次 nonce。
- apply 通过 journal 支持部分失败、冲突、App/Host 崩溃和恢复；root 不参与 apply。

完成条件：正常、reject、conflict、并发编辑、崩溃恢复和 cleanup/quarantine 全部有确定性与实机验证。

### S6：完成 P4-5 真实 Provider 纵向切片

- 首个真实 Provider 使用明确配置的 scoped credential；禁止读取 `~/.codex/auth.json`。
- 完成 `picker → mission → approval → staging → service UID provider → stop proof → review → authorized apply → cleanup`。
- 在该单任务链路之上完成一个多 agent mission：planning → 计划批准 → 至少两个依赖任务经同一 seat 串行执行并完成 handoff → delivery 决定 → review/apply。
- 覆盖主动停止、超时、Provider 失败、第二 execution 隔离和 credential 销毁。
- Provider 的工具能力以实机 canary 观测为准，UI 不根据配置名推断安全性。

完成条件：至少一个真实 Provider 完成全链路，真实 workspace 只出现经批准的 change set，seat 可在零进程证明后安全复用。

### S7：完成 P4-6 攻击与故障 gate

- 复用 P4-1 的一次管理员事务与残留恢复机制。
- 覆盖错误签名/audit context、协议重放、lease 越权、procargs、signal、launchd、socket、HOME/Keychain、链接/挂载/ACL、double-fork、持有 FD 和进程崩溃。
- 覆盖 App、Host Runtime、Broker、Seat Worker、Provider 在每个持久检查点崩溃。
- 最终 host/root 残留报告逐项一致；任何 inconclusive 都不转为 pass。

完成条件：无特权、development native、真实 Provider E2E、攻击/故障四类证据全部通过，才能声明重构后的 Phase 4 完成。

### S8：Electron 退役和 Phase 5–7 衔接

- 将 SQLite、persistent queue、lease/outbox、review/apply journal 和恢复的唯一写入实现放入 Swift Host Runtime。
- 完成 Phase 6 的 repair/tests/reject 真实业务闭环。
- Phase 7 使用 `SMAppService`、Developer ID、Hardened Runtime、公证、Gatekeeper、更新/降级/卸载矩阵完成发行。
- 原生路径通过功能、安全、恢复和发行 gate 后，从正式构建、CI release job、签名清单和安装包删除 Electron。
- 保留必要的历史 fixture 一段明确期限；不得让 fixture 被正式 product target 引用。

完成条件：正式 `.app` 的嵌套代码清单证明不含 Electron/Chromium/Node host；安装、运行、更新、恢复和卸载均只依赖原生 macOS 链路。

## 8. 与现有 Phase 4 的映射

| 现有阶段 | Swift 计划 | 当前事实 |
|---|---|---|
| P4-0 | S0–S1 保留所有 fail-closed 语义 | 已完成，不因语言迁移重开安全结论 |
| P4-1 | S7 复用一次管理员事务和开发 gate | 已完成的 gate 是输入证据；集成后需重跑，不宣称发行完成 |
| P4-2 | S3–S4 | protocol/FSM 部分存在；真实 launcher、ACL、live lifecycle 未完成 |
| P4-3/P4-4 | S3–S5 | TS staging/review/apply 可作 oracle；真实 service UID 数据源未闭环 |
| P4-5 | S6 | 未完成 |
| P4-6 | S7 | 未完成 |

迁移不会把 P4-1 改写为未完成，也不会把开发 gate 自动升级为 Swift 集成 gate。凡代码路径或签名产物发生变化，相关组件级证据必须重跑；没有被改变的账户恢复语义和攻击语料继续作为输入基线。

## 9. 验收矩阵

### 无特权验证

- SwiftFormat/SwiftLint 规则、编译器 warning-as-error、XCTest、TS/C contract corpus。
- actor isolation、Sendable、取消、deadline、backpressure、exact decoder 测试。
- workspace traversal、Unicode、大小写、symlink/hardlink、特殊文件和 TOCTOU fixture。
- approval/review/apply FSM property tests；任何未知状态不能被映射为成功。
- `.app` 产物扫描：禁止 Electron/Chromium/Node host、开发 fixture、未声明可执行文件和宽 entitlement。

### Development native gate

- 只允许一次有界管理员授权。
- App/Host/Broker/Worker 的实际签名身份、audit token、EUID/ASID 和协议版本验证。
- service UID 创建/恢复/删除、staging ACL、启动、停止、零进程、最终零残留。
- P4-1 既有恢复与 canary 必须继续通过。

### 真实 Provider E2E

- 真实 scoped credential 和真实 Provider，不使用 fixture 代替。
- 正常执行、输出、Artifact、stop、review、reject、apply、conflict、第二 execution。
- Provider 无法写真实 workspace；未经批准或过期 challenge 永远不能 apply。

### 攻击与故障注入

- 四个进程边界的伪造身份、错序、重放、超限和连接替换。
- Provider 对 host、用户 bootstrap、socket、HOME/Keychain 和其他 execution 的攻击。
- kill/crash/power-loss 等价故障覆盖每个 journal checkpoint。
- 最终残留为三态事实；unknown/inconsistent 必须 fail closed/quarantine。

### 原生产品质量

- 基于固定硬件/OS 建立 Electron 基线，再冻结原生冷启动、空闲内存、窗口响应和安装体积预算。
- 主线程不得执行 workspace 扫描、hash、diff、Provider I/O 或进程等待。
- 支持目标 macOS 的深浅色、键盘、VoiceOver、窗口恢复、休眠/唤醒和多显示器。
- 崩溃日志和诊断导出不得包含 prompt、secret、完整 HOME path 或未批准内容。

## 10. 风险与控制

1. **双实现漂移**：迁移期 TS 与 Swift 会短期共存。控制方式是 canonical contract、共享 corpus 和单向行为 oracle；禁止长期双写持久状态。
2. **Swift 重写造成安全回归**：类型安全不能替代 OS 证据。每个替换组件必须复跑对应攻击和故障 gate。
3. **XPC 权限扩大**：拆分进程会增加协议面。每个 service 单独定义有限方法、DTO、身份 requirement、频率和大小上限。
4. **root Swift/C 运行时复杂度**：Broker 继续保持无 Foundation 数据模型或使用最小受控子集；不引入第三方依赖、动态脚本或通用文件/命令 API。
5. **Provider CLI 行为差异**：Swift launcher 必须固定 executable fingerprint、cwd、environment、FD 和 signal/stop 语义，并用真实 CLI 验证。
6. **计划范围吞噬 Phase 4**：S2 UI 可以使用 fixture 并行验证，但安全完成声明严格按 S4→S7 顺序；UI 完成不能越过 lifecycle gate。
7. **发行过早**：ad-hoc 签名和 development daemon 只用于 Phase 4；正式安装仍需 Phase 7 独立证明。
8. **编排双实现漂移**：Web 的 TS 编排会继续演进。控制方式是 Turn/Mission 进入 canonical contract、共享 TurnTimeline fixture，以及 Swift 对 TS oracle 的逐帧快照等价测试；Web 编排的语义变更必须同步更新 fixture。
9. **编排扩大安全面**：多 agent 调度、handoff 和模型调用会增加数据流。每个任务仍是独立 execution，handoff 只经 Host Runtime 投影，编排层不得获得绕过 approval/staging/apply 的捷径。

## 11. 实施纪律

- 每一步先记录 dirty tree 和受影响文件，禁止 reset/clean/checkout 覆盖用户工作。
- 每个迁移 PR 只改变一个边界，并包含旧行为对照、失败语义和对应 gate。
- 任何阶段都不得读取、复制或复用 `~/.codex/auth.json`。
- 不用 root 运行 Swift Host Runtime、Provider、仓库代码、diff 或 apply。
- 不以名称前缀、固定 UID、单次进程快照或 Agent 自报决定系统对象归属和删除。
- 不为方便测试放宽协议、签名、ACL、workspace identity 或授权链。
- 不在常规流程中设计多次管理员授权；需要恢复时与下一次 gate 合并为一次可审计事务。
- 遇到未知或证据矛盾，保持功能 unavailable 或 seat quarantined，并保留诊断事实。

## 12. 当前进度与下一项实施工作

截至 2026-09-20：S0、S1 已完成（S1 证据见 [Checklist](./macos-native-swift-checklist.md) 与 [实施日志](./phase4-implementation-log.md)）。S2 曾按 Electron 流程以 fixture 完成原生壳，2026-09-20 按本文开头的决策重开，改为对标 Web 的 mission 运行体验。

S2 的 R0 已完成：采集脚本、首份 `local-dispatch` Feature Builder fixture 与逐帧 scene 黄金文件已就位，CI 检查标准答案与 Web 投影一致。R1 已完成：SwiftPM `RoundTableScene` 提供 `RoundtableTurn`、`ReplayTurnSource` 与 `SceneProjector`，逐帧等于黄金文件。R2 已完成：app 通过回放驱动舞台、workflow strip 与 Dock 状态行，并与 Web 在同尺寸窗口下并排截图核对。R3 已完成：Chat 由 `MissionThread` 驱动，按 Web 的卡片序列展示 Mission、Plan、agent 结果、阶段与 Delivery，旧的审批、Execution、Review 页已移除。R4 已完成：顶栏、侧栏、Inspector Files/Notes、产出抽屉、只读 Workflow 视图与模板推荐横幅按 Web 结构移植。R5 已完成：深色模式、外观选项、IBM Plex 字体，以及覆盖 `liveActivity` 的合成 fixture（真实 `agent-cli` 录制按用户决定推迟到 S6 隔离 seat 可用后）。S2 余下的是 1440×900 并排截图与可访问性、键盘、缩放、窗口恢复的明确测试；之后进入 S3（Swift Host Runtime 与 `RoundTableOrchestration`）。S3 在原计划之外增加 `RoundTableOrchestration`；真实 Host Runtime producer、peer attestation、dispatcher 和 N/N-1 live pairing 仍属于 S3，真实持久 store 与迁移/回滚属于 S8/Phase 5。P4-0→P4-6 gate 顺序不变。
