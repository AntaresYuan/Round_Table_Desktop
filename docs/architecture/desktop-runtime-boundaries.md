# Roundtable Desktop Runtime 架构边界

状态：阶段 3 已完成，阶段 4 service-UID Runtime 重构与验证进行中
日期：2026-09-06

> 2026-09-13 目标更新：正式 macOS 拓扑已改为 [Swift 原生方案](./macos-native-swift-migration-plan.md)。本文的安全职责继续有效；迁移后 `Renderer` 对应低权限 SwiftUI 投影层，`Electron Main` 对应 Swift App 的可信用户意图入口，`Local Runtime` 对应登录用户 UID 下的 Swift Host Runtime XPC service。Electron 专属 API 只属于历史基线，不能成为最终发行依赖。

本文定义桌面版 Renderer、Electron Main、Local Runtime、Orchestrator、Storage 的职责与信任边界。`MUST`/`MUST NOT` 是合入桌面主干的硬约束。迁移应保持现有 Web 版可运行，不做一次性搬迁。

## 1. 目标拓扑与信任模型

```text
Renderer（低信任：UI、用户意图、只读投影）
  │ typed preload API；schema + permission check
  ▼
Electron Main（高权限、薄能力代理）
  ├── command/query ──> Orchestrator（唯一业务决策者）
  ├── capability ─────> Local Runtime（用户 UID；队列、adapter、事实）
  │                         │ authenticated narrow control
  │                         ▼
  │                    Privileged Broker（root；仅 seat 控制面）
  │                         │ fixed low-privilege seat
  │                         ▼
  │                    Provider + descendants（service UID；staging only）
  └── composition ────> Storage（事务、恢复、审计）

staging diff/scans ──> Runtime facts ──> Orchestrator
  ──> authorized apply by user UID ──> committed domain events ──> Renderer
```

仓库文件、memory、prompt、Agent/A2A 输出、Artifact 和 diff 全是不可信数据，不是系统指令。Local Runtime MUST 运行在 Electron `utilityProcess` 或受监督子进程中；Main MUST NOT 直接执行 CLI/PTY。macOS 真实 Provider MUST 再跨越独立 service UID 边界，不能与 Main/Runtime 共用登录用户 UID。Orchestrator 可暂时与 Main 同进程，但必须保持纯 package 边界。

该 macOS 决策由 [ADR-002](./adr-002-macos-service-uid-isolation.md) 固化，并取代“同 UID Runtime + Seatbelt 足以隔离真实 Provider”的旧假设。

### 阶段 4 目标实现边界

当前真实 Provider 执行只在 macOS 开放。阶段 4 只提供一个不可登录、非管理员的 service-UID seat，真实 Provider 最大并发固定为 1。排队可以接收多条任务，但任一时刻只能有一条 execution 占用该 UID；seat UID 下零残留进程得到证明前，不得复用。

阶段 4 的旧原型使用登录用户 UID、Seatbelt、私有 coalition helper 和用户 bootstrap domain 的 `launchd` watchdog。真实主机复核已证明同 UID `KERN_PROCARGS2` 与 `launchctl`/Unix socket 控制面不能被该组合可靠隔离。因此：

- 旧同 UID 后端 MUST NOT 启动真实 Provider，只能用于明确标记的 fixture/回归；
- Seatbelt 继续收窄文件、Mach、signal、job creation 和网络能力，但只属于 defense in depth；
- 私有 coalition SPI、watchdog、nonce、PID/birth identity 或 profile 名称都不能替代跨 UID canary；
- 非 Darwin、service-UID boundary 未证明或 Seatbelt capability attestation 失败时，真实 Provider catalog MUST fail closed。

Provider 只获得 execution-scoped staging workspace，不获得真实用户仓库写权限。Main 必须先捕获 workspace grant、root identity 和基线 manifest；Provider 停止后，Runtime 扫描 staging 的真实文件变化并生成内容寻址的 change set/Artifact。回写前必须重验 grant、源 identity、基线/冲突和 apply authority，并由登录用户 UID 应用；root Broker MUST NOT 解释 diff 或静默回写。

### Provider 与 Credential 披露

| Provider | 当前启动条件与 credential 边界 | 对外披露 |
|---|---|---|
| Codex | service-UID boundary、固定 adapter 与受信任 executable probe 通过；仅接受专用于 Desktop Runtime 的 `OPENAI_API_KEY`，不读取或复制 `~/.codex/auth.json` | Codex workspace-write 仅指 staging；忽略用户配置/规则、tool network 配置为关闭；广义外部文件访问仍为 `not-guaranteed`，跨 UID 与真实 canary 未通过前不能扩大声明 |
| Claude Code | service-UID boundary 与固定 safe-mode adapter 通过；接受显式 token/key，或由 Main 从 Keychain 读取的未过期 access token；不读取/下发 refresh token | 私有 settings/MCP、project customization 关闭；workspace-write 仅指 staging；catalog 保守声明 `externalFileAccess: not-guaranteed`、`network: provider-and-tools` |
| OpenCode | 可以探测 executable，但 Phase 4 catalog 无条件标为 unavailable；项目配置无法证明不会扩大权限前不得启动 | 不作为已接入或已验证 provider 计数 |

上述 catalog 值是能力披露，不是安全测试的替代品。宿主进程 argv/environment、用户 bootstrap control、私有 socket、外部读取、外部写入、tool network 和 credential 投影都必须由独立 canary 的直接结果及宿主侧观测确认，不能仅依赖 Agent 在 prompt 中自报 `BLOCKED`。

## 2. 分层职责

### Renderer

- 渲染 Mission、Plan、Task、Artifact 和已去敏日志；提交用户意图；消费有序事件。
- MUST NOT 访问 Node、Electron Main 对象、文件系统、数据库、Keychain、`process.env`。
- MUST NOT 获得通用 `exec/readFile/writeFile/ipc.send` 能力、绝对路径、secret 或 runtime session token。
- MUST NOT 直接导入 `src/server/**`、runtime、storage、orchestrator implementation。
- 未扫描内容不得展示；HTML 预览必须独立 origin、禁 Node、严格 CSP/sandbox。
- 最终状态只取自 Orchestrator 已提交事件，不能由 stdout 或 UI 自行推断。

### Electron Main

- 配置 `nodeIntegration: false`、`contextIsolation: true`、sandbox 和 CSP。
- preload 只暴露版本化、逐项声明、schema 校验的命令/查询/订阅 API。
- 拥有窗口、原生目录选择、通知、更新、深链接、Keychain 和 IPC 授权。
- 作为 Secret Broker，按 provider 和 seat lease 下发单个最小 credential；当前 Codex 只接受显式 `OPENAI_API_KEY`，Claude 只接受显式 token/key 或 Keychain 中未过期的当前 access token；不投影宿主 auth 文件，不向 Renderer 回传值。
- 启动、监控、重启和终止用户 UID Runtime；通过窄协议请求 Broker 管理 service-UID seat，不能直接以登录用户 UID 启动真实 Provider。
- 捕获真实 workspace identity/base manifest，协调 staging snapshot、change set 扫描、冲突重验和 authorized apply；绝不让 root Broker 代替它解释或写入 diff。
- 仅作为 composition root；MUST NOT 复制 scheduler、Mission 状态机或直接承载 Agent。
- MUST NOT 把 Renderer 字符串直接传给 shell、路径 API 或网络，也不能传递完整宿主环境。

### Local Runtime

- 探测 Claude Code、Codex、OpenCode，但只把 catalog 明确可用的 Codex/Claude 交给 service-UID seat；OpenCode 当前固定不可用。阶段 4 验收受监督 stdio、超时、心跳、背压和 seat 全树停止，PTY 尚未计入完成能力。
- 只接受 Main 授权并捕获 identity 的 `workspaceId/root` 来生成 staging snapshot；Provider cwd 必须是该 execution 的 staging root，而不是真实 workspace root。所有路径必须防 `..`、symlink/hardlink escape 和特殊文件。
- 通过 allowlist 构造环境，按单活 seat lease 向 Secret Broker 请求短生命周期秘密；Runtime/Broker 不得把完整宿主环境或 credential 投影到另一条 execution。
- 只产生执行事实：process started/output/exited/stopped、file changed、scan result。
- 对 staging 的真实变更文件、change set 和所有 A2A Artifact 做扫描，再允许 Orchestrator 请求 apply/publish。
- MUST NOT 决定 Task/Mission 成功、直接写业务表、接受任意 cwd、拼接 shell command。
- MUST NOT 默认关闭 sandbox/approval，或继承完整 `process.env`。

### macOS Privileged Broker

- 是固定、签名、可单独审计的 native LaunchDaemon；正式发行由 `SMAppService` 注册并由管理员批准。
- 只管理 Roundtable 专用服务身份、私有 execution root、固定 seat worker 的生命周期、停止和兜底清理。
- 接受的每个请求都必须通过双向 XPC code-signing requirement、audit token、登录用户、协议版本、execution id、lease 和幂等校验。
- 正式 plist 不携带登录 UID 或任何 execution 运行态参数；精确 Main 签名、连接 audit token 与 root-owned enrollment 共同决定授权用户。通过 argv 固定测试 EUID 的 daemon 只能属于明确标记的开发 bootstrap fixture。
- MUST NOT 运行 Node、Provider、任意 shell/command，或解析仓库、prompt、stdout、Artifact、diff 和 credential 内容。
- MUST NOT 接受任意 path、UID、signal target、launchd label、环境变量，或暴露通用 root 文件/进程/账号代理。

### macOS Service-UID Seat

- 阶段 4 只有一个不可登录、非管理员 seat；一条 UID 同时最多对应一条活 execution。
- 只访问当前 staging、私有 HOME/TMP、固定 Provider executable 和明确允许的系统资源；不能读取登录用户 HOME、其他 staging 或 Broker 私有状态。
- 所有 Provider 后代必须留在同一 seat 身份；Provider 不能选择 UID、逃逸到用户 session，或向其他 execution 传递 credential。
- Seatbelt 继续执行最小文件/Mach/signal/job/network policy，但其失败只会使 catalog fail closed，不会把同 UID fixture 升格为安全运行。
- 停止后必须证明 Provider 全树退出、stdio 结算且该 UID 零进程；失败时 seat quarantine，不能报告已停止或继续调度。

### Staging 与 Apply Boundary

- Snapshot 必须绑定源 workspace grant、捕获的 root identity、base manifest 和 execution id。
- Staging 必须是 execution-scoped，不得通过 symlink、hardlink、mount、socket 或特殊文件反向暴露宿主资源。
- Provider 结束后先封存 staging，再由受信任代码扫描变化并生成内容寻址 change set；Agent 自报文件名不能作为 Artifact 事实。
- Apply 前再次验证 grant、root identity、base/冲突、扫描状态和 apply authority；由登录用户 UID 执行最小文件操作，并记录逐步结果。
- 部分 apply、冲突、拒绝和崩溃必须显式结算，不能以 `exitCode === 0` 或 diff 生成成功替代真实仓库结果。

### Orchestrator

- 唯一拥有 Mission、Turn、Plan、Task、Checkpoint、Handoff、Delivery 状态机。
- 执行 clarification、planning、approval gate、DAG scheduling、review/fix、delivery、取消和恢复决策。
- 校验 actor、当前状态、幂等键和 execution lease；提交 `execution.requested` 后才调用 Runtime。
- 将 Runtime facts 转为领域事件；仅在真实 repair/test 有执行证据后宣布成功。
- 通过 repository/UoW/outbox 端口持久化，事务提交后才发布领域事件。
- MUST NOT 导入 Electron、Next、React、`fs`、`child_process`、PTY、数据库 driver 或读取 secret/env。
- adapter 失败的 deterministic fallback MUST 与真实执行分开结算。

### Storage

- 实现 repository、unit-of-work、lease、idempotency、outbox 和 migration。
- 桌面默认 SQLite；Web 可保留 Postgres adapter。
- aggregate 变更、sequence、dispatch record 和 outbox 必须一次事务提交。
- 保存恢复所需的 Mission/Task/Execution/Artifact metadata；启动时结算过期 lease。
- Artifact 文件保存 hash、size、mime、scan status、provenance；secret 只能在 OS Keychain。
- MUST NOT 自行改变领域状态、启动 Agent，或继续每次读写完整 `RoundtableData`。

## 3. 命令与事件所有权

跨边界消息统一放在 `packages/protocol`，用 Zod schema 定义并推导 TS 类型。所有 envelope 至少包含 `protocolVersion`、`messageId`、`correlationId`、`occurredAt` 和相关 aggregate/execution ID；命令另含 `idempotencyKey`，领域事件另含单调 `sequence`。协议只传 workspace-relative path 或 opaque ID。

| 命令族 | 唯一所有者 | 约束 |
|---|---|---|
| `workspace.select/create/forget` | Main | 只能由原生 picker 产生授权 `workspaceId` |
| `mission.create`、`clarification.answer` | Orchestrator | 原子创建/更新 aggregate |
| `plan.approve/reject` | Orchestrator | approval 是 dispatch 硬前置 |
| `run.dispatch/retry/interrupt` | Orchestrator | 单活 lease；interrupt 等待 Runtime 停止事实 |
| `handoff.reject`、`repair.request`、`tests.request` | Orchestrator | 必须创建并执行真实任务 |
| `runtime.probe/config.update` | Main + Runtime | Main 授权，Runtime 执行；返回去敏结果 |
| `runtime.execute/stop` | Runtime | 仅接受 Orchestrator + 有效 lease；执行必须占用独立 UID seat，不暴露给 Renderer |
| `runtime.seat.prepare/stop/release` | Broker | 只接受已认证 Runtime/Main 的固定请求；绑定 execution/lease，不接受通用 UID、path、command 或 signal target |
| `workspace.snapshot/diff/apply` | Main + Runtime | Snapshot/diff 绑定 grant、identity 和 base；apply 必须有扫描通过、冲突重验与明确 authority |
| `secret.set/delete` | Main Secret Broker | UI 只能看到 configured 状态 |
| `artifact.open/reveal/export` | Main | 以 ID 解析并再次校验 workspace containment |

| 事件族 | 唯一生产者 | 持久性 |
|---|---|---|
| `mission/turn/plan/task/approval/handoff/repair/delivery.*` | Orchestrator | durable + outbox |
| `execution.requested` | Orchestrator | durable + outbox |
| `runtime.seat.prepared/quarantined/released` | Broker → Runtime fact | 阶段 4 为审计事实；阶段 5 起 durable |
| `runtime.process.started/exited/stopped` | Runtime | durable fact |
| `runtime.process.output` | Runtime | ephemeral 或受控日志 |
| `runtime.file.changed/scanned` | Runtime | durable fact，仅 staging metadata/hash |
| `workspace.snapshot.created/change-set.created/apply.*` | Runtime/Main | 阶段 5 起 durable；包含 base、hash、冲突与逐步 apply 结果，不含 secret |
| `artifact.discovered/quarantined/published` | Orchestrator | durable |
| `storage.recovery.*` | Orchestrator 基于 Storage 恢复结果 | durable |
| `window/update/notification.*` | Main | 非领域事件 |

`exitCode === 0` 只是 Runtime fact，不等于 Task 完成；Task 状态由 Orchestrator 结合期望产物、safety、review/test 证据决定。

## 4. 依赖方向

```text
packages/domain        -> 无内部/平台依赖
packages/protocol      -> domain
packages/orchestrator  -> domain, protocol, 自己定义的 ports
packages/runtime       -> domain, protocol
packages/storage       -> domain, orchestrator/ports
packages/ui            -> protocol, React

desktop/renderer -> ui + protocol
desktop/preload  -> protocol
desktop/main     -> protocol + orchestrator + runtime client + storage（组合根）
desktop/native-broker -> 固定 native protocol + ServiceManagement/XPC（无 Node/业务依赖）
runtime/macos-seat-worker -> 固定 native protocol + runtime launch contract（service UID）
web/cli          -> protocol + orchestrator + storage（transport/组合根）
```

禁止反向依赖：orchestrator 不导入 runtime/storage 实现；runtime 不导入 storage/UI/Electron window；storage 不导入 runtime/UI/routes；renderer/UI 不导入 Node/runtime/storage/orchestrator implementation。Broker 不链接 Node/Electron、Provider SDK、仓库解析或业务状态机；seat worker 不依赖 Renderer/Main 实现。用 package `exports`、独立 tsconfig、native target allowlist、链接检查和 CI 自动执行。

## 5. 现有源码映射

| 当前源码 | 目标 | 处理 |
|---|---|---|
| `src/server/types.ts` | `domain` + `protocol` | 拆领域类型与 API/runtime DTO |
| `actions/turns/planning.ts` | `domain/orchestrator` | 复用纯规则；模型调用改 port |
| `actions/scheduler.ts` | `orchestrator` | 复用 DAG/wave；补 lease、abort、恢复 |
| `turns/fix-loop.ts`、`handoffs.ts`、`doc-policy.ts` | `domain/orchestrator` | 保留纯判断/格式化 |
| `turns/create-turn.ts`、`dispatch.ts`、`final-delivery.ts` | `orchestrator` | 改 command handlers，删除旁路与合成成功 |
| `mission-actions.ts`、`clarify-actions.ts` | `orchestrator` | 拆除直接 `mutateData`，改 UoW |
| `turns/artifacts.ts`、`safety.ts` | `orchestrator` + runtime scan port | 规则复用，真实文件读取归 Runtime |
| `agent-runner.ts`、`cli-runtimes/*` | `runtime` | 拆业务落库；重做 env、sandbox、PTY、stop |
| `actions/adapters/*` | `runtime/adapters` | 加 URL policy、secret scope、cancel、错误分类 |
| `actions/a2a/*` | `protocol/a2a` + `runtime/adapters` + storage | schema、transport、持久化拆分 |
| `turns/workspace*.ts`、`agent-memory.ts` | `runtime/workspace|memory` | 全部绑定 workspace capability |
| `src/server/store.ts` | `storage` | repository/UoW；禁止全聚合 mutation |
| `runtime-actions.ts`、`settings-actions.ts` | Main capability + runtime/storage adapters | 拆配置、secret、probe、conversation scope |
| `root.ts`、`trpc.ts`、`app/api/**`、`auth.ts` | `apps/web` | 仅 transport/auth/composition |
| `src/cli/*` | `apps/cli`/`tooling` | 不得直调 store 或绕过 approval |
| `src/ui/components/**`、styles | `packages/ui` | 只留纯展示；tRPC/fixture 放 app 层 |

可复用：领域形状、planning 纯规则、DAG 算法、handoff/provenance、A2A allowlist/映射、artifact 纯规则、workflow 验证、memory 预算/提取纯逻辑和展示组件。

不可原样复用：`mutateData` 全聚合存储、`void dispatchTurn`、进程内锁/active Map、全量 env、任意 command/cwd、Codex bypass 参数、fallback 假成功、合成 repair/tests、只扫 `result.text`、以关键字推断测试证据。

绝不能进入 Renderer：store/driver/migration、agent runner/CLI/A2A/模型 transport、workspace/fs/path/process/env、command/args/绝对路径/session/secret、未去敏日志、未扫描内容、状态转换实现。

## 6. 抽取顺序与完成门槛

1. **冻结行为**：为 planning、scheduler、A2A、artifact 建 characterization tests；已知错误用目标语义测试标记，不能固化假闭环。
2. **抽 domain/protocol**：协议版本、command/event/query schema；domain 无平台依赖，protocol 可双端构建。
3. **建 ports/storage**：现有 store 先适配端口，再加 SQLite；收敛 Mission/LocalTurn 双份写模型；状态与 outbox 原子提交。
4. **抽 orchestrator**：所有 Web/API/CLI 统一走 command handler；用 fake ports 跑完整状态机测试。
5. **抽 runtime**：用户 UID 控制 Runtime、env allowlist、Secret Broker、staging snapshot/diff、service-UID seat、全树停止和崩溃结算。
6. **建 Main/preload/native broker**：最小 IPC、XPC peer requirement、audit token、schema/authorization/rate-size limit、Keychain/native picker；Broker 无数据面，Renderer 无平台 import。
7. **抽 UI/接桌面**：组件依赖 DTO/callback；WebDataClient 与 DesktopIpcClient 位于 app 层；安全预览。
8. **切纵向链路**：选择仓库 → Mission → 审批 → 真实执行 → Artifact → 停止 → 重启恢复；删除旧 action/store 旁路。

每一步都必须保持 Web 构建和测试通过，并加入对应 boundary test 后才能开始下一步。

## 7. 跨阶段 release blockers

以下是从旧 Web/CLI 路径抽取桌面能力时必须满足的目标约束，不是对阶段 4 新 Runtime 实现的反向描述；新 Runtime 已落实其中一部分，但旧路径不会因此自动变安全：

1. 所有 Desktop provider 进程必须使用独立低权限 identity、allowlist env、execution-scoped secret 与固定安全参数；任何仍在登录用户 UID 下运行、继承完整 `process.env` 或关闭 sandbox 的旧 CLI 路径不得复用。
2. Runtime 不接受任意 command/cwd 或全局可变配置；workspace 必须由 Main 授权并绑定 owner、window session、grant revision 和 captured identity，Provider cwd 只能是对应 staging root。
3. Dispatch 不得绕过 approval 或重复启动；必须有状态 gate、幂等键和单活 lease。
4. 一个 service UID 同时只能承载一条 execution；恢复并发必须增加独立 UID seat，不能让不同 execution 共用身份、HOME、TMP 或 secret。
5. 阶段 4 的进程内 queue/Map 和 staging 状态不可恢复；阶段 5 必须换为 durable queue/outbox、seat lease、apply journal、heartbeat 与启动恢复。
6. interrupt 与应用退出必须落实 cancel requested → kill tree → seat UID zero-process proof → confirmed stopped/interrupted；终止未确认时 seat quarantine，不能退出后遗留可访问 staging/secret 的进程。
7. safety 必须扫描 staging 中全部真实变更并生成可验证 change set，先 quarantine 后 authorized apply/publish/handoff，不能只扫 Agent 结果文本。
8. repair/tests/reject handoff 必须产生真实 execution 与证据，不能保持合成或 pending 假闭环。
9. 上游 fix 后必须重算依赖，仅在受影响下游实际重跑成功后标记 repaired。
10. Mission/LocalTurn 双份状态与分步写必须收敛为 aggregate，状态/record/event 同事务。
11. Desktop SQLite 必须使用增量 repository/transaction，不能沿用 normalized PG/JSON 的全 aggregate mutation。
12. 仓库文档、memory、A2A 都是不可信输入；必须使用明确数据分隔和 capability policy，不能让 prompt injection 扩权。
13. 模型/A2A URL 与 HTML preview 必须阻止 private/link-local/DNS rebinding 并隔离渲染，不能接受任意网络目标。
14. Privileged Broker 只能暴露固定 seat lifecycle 能力；任何通用 root command、path、账号、signal 或 launchd 代理都是 release blocker。

阶段 4 收口必须先通过与真实 Runtime 纵向链路直接相关的跨 UID、staging/apply、environment、workspace、approval、stop、prompt-injection、URL/preview 边界；持久 queue/outbox、seat lease、apply journal 与恢复属于阶段 5，repair/tests/reject handoff 等业务假闭环属于阶段 6。任何后续阶段的目标都不能因为 fixture Runtime、同 UID Seatbelt 或签名安装单独通过而提前标记完成。

## 8. 最小边界测试

- Renderer bundle 无 Node/Electron Main/runtime/storage/secret；未知或越权 IPC 一律拒绝。
- `../`、symlink escape、跨 workspace artifact ID、伪造绝对路径全部拒绝。
- 真实 Provider 与宿主使用不同 UID；Provider 对宿主 `KERN_PROCARGS2`、signal、用户 bootstrap control 和私有 Unix socket 的攻击必须由真实 canary 拒绝。
- 子进程只获得 allowlist env；secret 不出现在 argv、plist、日志、事件、数据库、Artifact 和 Renderer，也不进入另一条 execution。
- 由宿主创建并检查独立 canary：staging 写成功、真实 workspace 在 apply 前不变、workspace 外写失败；已声明拒绝的 user-data 读取失败；tool network 的实际请求与 loopback 服务观测一致。
- Snapshot 捕获 identity/base；symlink、hardlink、socket、device、超限树和源目录竞争均 fail closed。Artifact 必须来自 staging 扫描投影而不是 Agent 自报。
- 未审批、重复 key、过期 lease、第二条并发 dispatch 均不启动第二个真实进程；队列中的等待任务不能获得 seat secret 或 staging 权限。
- interrupt 在时限内杀死完整进程树，证明 seat UID 零进程并提交唯一终态；证明失败必须 quarantine。
- Change set 在 apply 前扫描并重验 grant、identity 和冲突；partial apply、拒绝和崩溃均有可恢复事实，恶意 README/memory/A2A 不能扩大 capability。
- 未签名/签名不匹配的 Main 或 Broker、伪造 audit token 上下文、越权 path/UID/label/command 请求全部被 Broker 拒绝。
- repair/tests/reject handoff 都有真实 runtime execution；上游 fix 后受影响下游真实重跑。
- Storage sequence 单调、outbox 不丢、command 幂等，且不做全聚合读写。

所有 Desktop PR 必须回答：命令和事件由谁拥有、需要何种 capability、崩溃/取消/重启如何结算、Renderer 获得的最小安全 DTO 是什么。无法回答则不得通过架构评审。

## 9. 阶段 4 gate 状态

### 普通 CI

普通 CI 不携带真实 Provider credential 或管理员权限，负责：协议/schema、queue、adapter、Secret Broker 去敏、snapshot/diff/apply 纯逻辑、Broker/seat native build、静态链接/依赖边界、非 Darwin fail-closed、Electron fixture smoke 和 Web 回归。它可以证明实现可重建，但不能证明 macOS UID 隔离或正式安装。

### 阶段 4 开发态隔离 Gate

受控 macOS 测试机使用明确标记的测试签名和 privileged integration harness，真实创建不同 UID 的 seat，运行本节列出的跨 UID、staging/apply、secret、停止、Broker crash 和残留清理 canary。随后至少一个 credentialed、已启用的真实 Provider 必须完成纵向链路。测试可以要求开发者显式管理员认证；同 UID fixture 或仅 Seatbelt integration 不可替代。

当前新 service-UID Broker、seat worker 与 staging/apply 链路尚未实现，开发机也没有可用 code-signing identity，因此该 gate 未通过。阶段 4 保持进行中。

### 阶段 7 正式发行 Gate

Developer ID、Hardened Runtime、公证、Gatekeeper、`SMAppService` 注册与管理员批准、release-signature XPC peer requirement、更新/回滚/卸载、服务账号资源回收和 Apple silicon/Intel 兼容矩阵是独立发行 gate。它们不得被 Phase 4 的测试签名/harness 结果替代；反之，签名和公证成功也不能替代运行时攻击 canary。
