# Roundtable 桌面版运行时改造路线

状态：阶段 3 已完成，阶段 4 隔离架构重构进行中
日期：2026-09-06

> 2026-09-13 目标更新：正式 macOS 产品采用 [原生 Swift 重构计划](./macos-native-swift-migration-plan.md)。本文中的 Electron 内容继续记录 Phase 1–3 的历史事实和迁移期基线；未完成的 Phase 4–7 按 Swift App/Host Runtime 目标拓扑实施。

## 当前进度

- [x] 阶段 1：冻结现状与定义边界。
- [x] 阶段 2：建立 Monorepo 骨架。
- [x] 阶段 3：建立安全的桌面壳。
- [ ] 阶段 4：建立本地 Agent Runtime（进行中）。
- [ ] 阶段 5：引入 SQLite 与崩溃恢复。
- [ ] 阶段 6：修正现有假闭环。
- [ ] 阶段 7：产品化与发行。

阶段 1 产物：

- [ADR-001：桌面端采用同仓库 Monorepo、Electron 安全壳与独立 Local Agent Runtime](./adr-001-desktop-local-runtime.md)
- [ADR-002：macOS Agent 使用独立低权限 UID 与签名 Broker 隔离](./adr-002-macos-service-uid-isolation.md)
- [Desktop Runtime 架构边界](./desktop-runtime-boundaries.md)
- [Desktop Migration 测试基线](./desktop-migration-test-baseline.md)

阶段 2 验证记录（Node 24、pnpm 9.0.0）：

- 4 个 workspace 的 frozen-lockfile 安装通过。
- `@roundtable/domain`、`@roundtable/protocol`、`@roundtable/desktop` 独立 typecheck、test、build 通过。
- Electron 43.4.1 二进制验证通过。
- Web typecheck、lint、293 个测试、生产 build 和 moderate audit 继续通过。

阶段 3 验证记录（Node 24、pnpm 9.0.0）：

- Electron Main、sandboxed CommonJS Preload 与 Renderer 已分离；Renderer 无 Node 全局，bridge 仅有 3 个固定 capability。
- 自定义 `roundtable://app` 协议只服务显式资源 allowlist，只接受 `GET/HEAD`，统一注入 CSP、`nosniff`、frame policy 与 no-store。
- IPC 同时绑定当前 `webContents`、主 Frame 与精确 document URL；子 Frame、外部导航、弹窗、权限、设备和 Renderer 外网请求默认拒绝。
- 原生 picker 生成 owner-bound opaque workspace grant；绝对路径不进入 Renderer；reload、窗口关闭、preload 失败、崩溃和卡死均撤销 capability。
- 相对路径协议拒绝 traversal、反斜杠、drive/UNC/ADS 和控制字符；目录枚举使用一次性受信任 Utility Process、固定 cwd、根/目标 bigint identity、500 项上限和稳定错误码。
- Utility Process 是固定代码的最小权限 broker，不是 OS sandbox，也不是 Phase 4 的 Agent Runtime；它不执行仓库代码或 Renderer 命令。
- `@roundtable/domain` 1 个、`@roundtable/protocol` 7 个、`@roundtable/desktop` 36 个测试全部通过；workspace typecheck、lint、build 与 frozen install 通过。
- 从不存在任何 `dist` 的状态可按 domain → protocol → desktop 重建；真实 Electron CDP smoke 验证 custom protocol、CSS、Renderer、Preload、Node 隔离和首个 IPC。
- Electron smoke 使用 loopback 动态端口、临时 profile、有界 CDP 命令、SIGINT/SIGTERM 与跨平台进程树清理；成功和中断路径均验证无残留进程/临时 profile。
- Web typecheck、40 个文件/293 个测试、生产 build 与 moderate audit 继续通过。

阶段 3 按最小能力原则没有预先暴露尚无业务调用方的通知或 OS deep-link IPC；这两项在阶段 7 随可验证的产品流程接入，不能以通用事件/导航能力占位。

阶段 4 当前状态（尚不构成阶段完成）：

- 第一版 Main → Utility Runtime 私有协议、有界进程内 queue、preparation token、固定 adapter、stdio 监督、环境 allowlist、workspace identity、输出去敏、超时、Artifact 扫描与停止 barrier 已有 deterministic 覆盖。这些可复用能力不等于安全隔离完成。
- 第一版 macOS 后端让 Provider 与 Desktop/Runtime 共享登录用户 UID，并依靠 Seatbelt、私有 coalition helper、用户 bootstrap domain 的 `launchd` watchdog、nonce 和 PID birth identity 约束进程。安全复核已直接证明同 UID `KERN_PROCARGS2` 和 `launchctl`/Unix socket 控制面不能由该组合可靠隔离，因此该后端不得启动真实 Provider，也不能用于阶段完成声明。
- 2026-09-06 已接受 [ADR-002](./adr-002-macos-service-uid-isolation.md)：阶段 4 改为单席独立低权限服务 UID、极窄签名 Privileged Broker 和 execution-scoped staging workspace。真实 Provider 最大并发固定为 1；Seatbelt 只保留为纵深防御。
- Provider 不再直接写真实用户仓库。目标链路是 workspace snapshot → staging execution → 真实文件扫描 → change set/diff → 再验证 grant/identity/冲突 → authorized apply。root Broker 不解析 Agent 数据，也不替用户静默回写。
- Secret、HOME、TMP、stdio 和进程生命周期全部绑定单个 seat lease。只有确认 Provider 全树退出且该 UID 下零残留进程，seat 才可复用；无法证明时必须 quarantine/fail closed。
- Catalog 对外部文件访问继续统一声明 `not-guaranteed`，Codex/Claude Code 的真实能力仍必须由宿主 canary 直接观测；OpenCode 在阶段 4 继续固定 unavailable。

截至 2026-08-23 的 deterministic 全量回归和 fixture Electron smoke 是旧同 UID 原型的历史验证记录，只证明功能回归与部分纵深防御，不再是当前 Phase 4 isolation gate。真实 Provider credential 可用性也只有在新 service-UID 后端通过后才有意义。

阶段 4 现在同时受实现和环境 gate 约束：新 Broker/seat/staging 后端尚未完成；当前开发机没有可用代码签名 identity，正式 Developer ID、公证和管理员安装流程也尚未具备。因此阶段 4 保持进行中，不得进入阶段 5。

## 决策

Roundtable 桌面版继续在当前仓库中开发，并逐步演进为 monorepo。正式 macOS 产品使用 SwiftUI/AppKit 和原生 Host Runtime；Electron 只保留为迁移期行为基线，不能进入最终发行包。桌面版不能只是现有网页的封装。

桌面化的核心目标是建立独立、可靠且权限受控的本地 Agent Runtime，让 Roundtable 能正确管理本地工作区、CLI/PTY 进程、Mission 生命周期、持久状态、密钥和系统能力。

在 macOS 上，“独立 Runtime 进程”不再被视为足够的权限边界。真实 Provider 必须进入独立低权限服务 UID，并只修改 staging workspace；签名 Privileged Broker 只拥有最小控制面能力。该决定由 ADR-002 固化。

现有 Web 版在改造期间必须保持可运行。共享领域模型、调度器、adapter 和 UI 应逐步抽取，避免形成 Web 与 Desktop 两套实现。

## 目标结构

```text
Round_Table/
├─ apps/
│  ├─ web/                 # 现有 Next.js 产品
│  ├─ desktop/             # Electron 历史基线与迁移期 fixture
│  └─ macos/               # SwiftUI/AppKit App、Host Runtime 与原生 targets
├─ packages/
│  ├─ domain/              # Mission、Turn、Task、Artifact 等类型与规则
│  ├─ protocol/            # IPC、事件和 RPC schema
│  ├─ orchestrator/        # Planning、scheduler、dispatch 状态机
│  ├─ runtime/             # CLI、PTY、进程管理和恢复
│  ├─ storage/             # SQLite、Postgres 和 migration
│  └─ ui/                  # 可复用圆桌 UI
└─ tooling/
```

不要求在第一步完成全部目录迁移。应先建立新增边界，再按依赖方向逐步抽取。

## 七阶段路线

### 1. 冻结现状与定义边界

- 用现有测试锁定 scheduler、workflow、adapter 和主要状态转换行为。
- 明确纯领域逻辑、Web API、本地 Runtime 和存储代码的边界。
- 定义 Renderer、Main、Runtime、Storage 的信任和权限边界。
- 定义统一的 Mission、Turn、Task、Dispatch 和 Artifact 事件协议。

完成标准：目标架构和事件契约可供实现与评审，现有行为有回归保护。

### 2. 建立 Monorepo 骨架

- 引入 workspace 结构。
- 新增 `apps/desktop` 和首批共享 package。
- 保持现有 Web 启动、构建和测试方式可用。
- 为 Web、Desktop 和共享 package 建立独立 CI 检查。

完成标准：Web 与空的 Desktop 应用可以在同一仓库独立构建。

### 3. 建立安全的桌面壳

- 分离 Electron Main、Preload 和 Renderer。
- Renderer 禁止 `nodeIntegration`，启用 `contextIsolation` 和严格 CSP。
- 只通过类型化、可校验的 IPC 暴露系统能力。
- 接入原生工作区选择、窗口、通知和深链接。
- 复用现有圆桌 UI，但不允许 Renderer 直接访问 Node、Shell 或密钥。

完成标准：桌面端能够选择本地仓库、创建工作区并展示真实文件，但尚不执行 Agent。

### 4. 建立本地 Agent Runtime

- 实现有界、进程内易失的 Mission admission/execution queue；持久 queue、lease 和恢复留到阶段 5。
- 实现 CLI/stdio 进程管理和统一 runtime adapter；只有在产品确实需要并具备同等隔离测试时才引入 PTY。
- 支持启动、事件流、超时、停止和进程树清理。
- 引入环境变量白名单、Secret broker、文件访问与命令执行审批。
- 首批启用 Codex 和 Claude Code；OpenCode 保留 catalog 位置，但在项目配置无法扩大权限前固定不可用。
- macOS 真实 Provider 只运行在一个专用、不可登录的低权限 service-UID seat 中；阶段 4 强制单并发，同 UID 原型只能运行 fixture。
- 引入固定、签名、可审计的 Privileged Broker；它只管理服务身份、staging root、seat 生命周期和兜底清理，绝不以 root 运行或解析 Provider/Node/仓库内容。
- Provider 只写 execution staging workspace；宿主扫描真实变更并生成 change set，经 grant、identity、冲突和 apply authority 重验后，再以登录用户 UID 回写真实仓库。
- Seatbelt 继续拒绝不必要的文件、Mach、signal、job 和网络能力，但只作为纵深防御；跨 UID canary 和 seat 零进程证明才是隔离与停止 gate。

完成标准：在受控 privileged test environment 中完成“打开仓库 → 创建 Mission → 审批 → snapshot 到 staging → 以独立 UID 执行至少一个已启用的真实 Agent → 扫描并生成 change set/Artifact → authorized apply → 真正停止并证明 seat UID 零残留”的纵向链路；跨 UID `KERN_PROCARGS2`、signal、用户 bootstrap control、私有 socket、外部文件读写、tool network 和 credential 投影 canary 必须直接证明声明。fixture、同 UID Seatbelt、catalog 探测或普通功能回归均不能替代该 gate。

阶段 4 的开发态隔离 gate 与阶段 7 的正式发行 gate 分开：本阶段允许使用明确标记的测试签名和受控管理员 harness，但仍必须真实跨 UID；Developer ID、公证、最终 `SMAppService` 安装/批准/升级/卸载矩阵在阶段 7 验收。没有测试签名或管理员测试环境时，阶段 4 仍未完成。

### 5. 引入 SQLite 与崩溃恢复

- 桌面端从 JSON store 迁移至 SQLite。
- Mission、Turn 和 Dispatch 状态转换使用事务。
- 增加 execution lease、幂等调度和持久任务队列。
- 持久化 Artifact、日志和 CLI session。
- 应用重启后能够恢复、重试或明确结算中断任务。
- 持久化 service-UID seat lease、staging snapshot/base manifest、change set、apply journal 和 quarantine 状态；重启时先结算残留 seat，再决定重试、拒绝或继续 apply。

完成标准：强制退出并重新打开应用后，不会产生永久 `running` 的幽灵任务，也不会复用仍有残留进程的 seat、遗失待处理 change set，或把部分回写误报为成功。

### 6. 修正现有假闭环

- `Request repair` 真正启动 Fixer。
- `Request tests` 真正创建并执行测试任务。
- Reject handoff 真正进入 repair 调度。
- Dispatch 强制 approval，并具备幂等性。
- Fixer 成功后重新计算和执行可恢复的下游任务。
- Safety 扫描实际变更文件，而不只扫描 Agent 返回文本。
- 明确区分真实执行成功与 deterministic fallback 成功。

完成标准：桌面 UI 中每个执行按钮都对应真实、可追踪、可中断和可恢复的行为。

### 7. 产品化与发行

- 优先完成 macOS 和 Windows 安装包，再评估 Linux。
- 建立代码签名、公证、自动更新和数据 migration 流程。
- macOS 对 `.app`、Broker、seat worker、native helper 和所有 nested code 完成 Developer ID 签名、Hardened Runtime、公证与 Gatekeeper 验证；通过 `SMAppService` 管理管理员批准的 LaunchDaemon。
- 验证服务账号和私有目录在安装、升级、降级、回滚、拒绝授权与卸载中的完整生命周期，不留下可登录账号、孤儿 daemon 或越权 ACL。
- 按“一条并发 execution 一个独立 UID”把 seat pool 扩展到产品需要的并发数；不得通过复用 UID 恢复阶段 4 旧的同 UID 风险。
- 将 Virtualization.framework per-execution VM 作为可选高隔离模式评估，不默认牺牲 macOS/Xcode 本机工作流。
- 补齐桌面 E2E、崩溃恢复、权限、升级和卸载测试。
- 完成托盘、系统通知、多窗口、最近项目、诊断和日志导出。
- 决定 Web 版继续作为独立产品，还是作为 Desktop Runtime 的远程协作入口。

完成标准：真实用户能够安全地安装、批准、升级、恢复数据和卸载产品；release signature 下的 XPC peer requirement、service UID 隔离、更新协议兼容与资源回收都通过攻击和恢复测试。

## 里程碑

- 阶段 1–3：Desktop Shell。
- 阶段 4–5：可实际使用、可恢复的 Desktop Runtime。
- 阶段 6–7：可信赖的正式桌面产品。

## 第一条必须打通的纵向切片

```text
选择本地仓库
→ 创建 Mission
→ 用户审批
→ 捕获仓库基线并创建 staging
→ Agent 以独立低权限 UID 真实执行
→ 扫描 change set 和 Artifact
→ 授权并回写真实仓库
→ 停止任务并证明 seat UID 零残留
→ 重启应用并恢复现场
```

这条链路是桌面改造方向是否成立的首要验证，不以“网页成功装入 Electron”作为 MVP 完成标准。

## 实施护栏

- 不进行一次性大搬迁；每个阶段都保持 Web 版可运行。
- 不在 Renderer 中暴露通用 Shell、文件系统或密钥访问能力。
- 不复制领域模型和 scheduler；优先抽取共享核心。
- 不把 Electron Main 变成新的业务代码单体；编排和 Runtime 保持为独立 package。
- 不在 root Broker 中运行 Node、Provider、shell 或解析任何仓库/Agent 数据；Broker API 不得演变成通用提权代理。
- 不允许真实 Provider 在登录用户 UID 下执行，也不允许两条同时存活的 execution 共享 service UID。
- 不允许 Provider 直接写真实用户仓库；staging、扫描、冲突检查和 authorized apply 是硬边界。
- 不把 Seatbelt、私有 coalition SPI、用户 `launchd` watchdog 或 fixture 通过描述成 UID 隔离。
- 不把桌面化视为现有安全问题的自动修复，权限、隔离和恢复能力必须显式实现并测试。
- 任何阶段都以可测试的纵向功能和明确完成标准收口。
