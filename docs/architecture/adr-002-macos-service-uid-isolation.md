# ADR-002：macOS Agent 使用独立低权限 UID 与签名 Broker 隔离

- 状态：已接受
- 日期：2026-09-06
- 适用范围：Roundtable Desktop 在 macOS 上执行本地 Agent 的权限、工作区和进程生命周期边界
- 关联文档：[桌面版运行时改造路线](./desktop-runtime-migration.md)、[Desktop Runtime 架构边界](./desktop-runtime-boundaries.md)
- 取代范围：取代 ADR-001 中“首个 Runtime MVP 不安装系统服务”以及“Provider 可在用户 UID 下直接写获批仓库”的假设；ADR-001 的同仓库 Monorepo、Electron 安全壳和独立 Runtime 决策继续有效

## 背景

阶段 4 的首个 macOS 原型让 Provider 与 Electron、Utility Runtime 运行在同一个登录用户 UID 下，并尝试通过 Seatbelt、私有进程 coalition helper、`launchd` watchdog、一次性 nonce 和进程 birth identity 建立隔离及停止证明。

这些机制改善了文件写入、已知 Mach service、进程树停止和协议伪造风险，但安全复核在真实主机上证明了两个不能继续忽略的边界缺口：

1. 同 UID Provider 可以通过 `KERN_PROCARGS2` 观察其他同 UID 进程的参数；在已验证的系统上，Seatbelt/App Sandbox 规则不能作为阻止该读取的可靠契约。
2. 同 UID Provider 可以观察或干扰用户 bootstrap domain 中的 `launchctl` 控制面及 Unix socket。继续增加 nonce、watchdog 或未公开 Seatbelt 规则，不能把同 UID 进程变成独立安全主体。

因此，旧原型的 deterministic tests 只能证明其功能、文件策略和清理逻辑，不能证明恶意或被 prompt injection 控制的 Provider 无法攻击宿主或另一条 execution。阶段 4 不能在该前提下完成。

## 决策驱动因素

- Provider 及其子进程必须被当作可能执行不可信仓库指令的低信任代码，而不是与 Desktop Main 等价的受信任进程。
- 隔离边界必须阻止 Provider 读取宿主/其他 execution 的 argv、environment、控制 socket 和 secret，并阻止其向宿主进程发送 signal 或控制用户 `launchd` domain。
- 首个可用版本仍需执行 macOS 本机 CLI 和工具链；把所有任务改到 Linux guest 会改变 Xcode、Simulator 和平台相关构建的产品语义。
- Root 代码面必须足够小，可独立审计，且永远不能加载 Node、Provider、仓库代码、prompt 或 Agent 输出。
- 阶段 4 需要可重复的开发态隔离证明；Developer ID、公证、正式管理员安装、升级与卸载属于阶段 7 的发行证明，两者不能互相替代。

## 决策

### 1. UID 是 macOS Provider 的一级隔离边界

Desktop Main、Utility Runtime 和用户会话继续运行在登录用户 UID 下。真实 Provider 及其全部后代 MUST 运行在一个无登录能力、无管理员组、无宿主 HOME 权限的专用服务 UID 下。

阶段 4 只提供一个 service-UID seat，并将真实 Provider 的最大并发数固定为 1。一个 seat 在任何时刻最多拥有一条 execution；在证明该 UID 下没有残留进程前，seat MUST NOT 被复用。排队可以并发接收，但不能并发启动真实 Provider。

阶段 7 如需恢复最多 4 个真实并发 execution，必须提供 4 个互不相同的服务 UID；不得让两条同时存活的 execution 共享 UID。每个 seat 仍是一条单活 lease。

### 2. 使用极窄的签名 Privileged Broker

macOS 发行拓扑使用由 `SMAppService` 管理的签名 LaunchDaemon 作为 Privileged Broker。Broker 只拥有以下固定能力：

- 验证并管理 Roundtable 专用服务身份及私有目录；
- 创建、封存和回收 execution-scoped staging root；
- 启动或唤醒固定、受信任的低权限 seat worker；
- 请求停止并在必要时清理该 seat UID 下的全部进程；
- 返回有界、版本化、可审计的生命周期事实。

Broker MUST NOT：

- 以 root 身份运行 Node、shell、Provider 或任何用户选择的 executable；
- 解析或执行仓库文件、prompt、stdout、Artifact 或 diff；
- 接受任意 path、command、UID、signal target、launchd label 或环境变量；
- 持久化、记录或向 Renderer 返回 credential；
- 提供通用文件系统、进程、账号或 `launchctl` 代理。

Main 与 Broker 的 XPC 连接必须双向约束代码签名 requirement；服务端还要从连接的 audit token 绑定调用者身份和登录用户，不能以可复用 PID 作为授权依据。所有方法都必须有精确 schema、大小/频率限制、execution/lease 绑定和幂等语义。

正式 LaunchDaemon 的 plist 与 app bundle 都是静态、签名的安装资产，不得把登录用户 UID、workspace、execution 或其他运行态值写入 `ProgramArguments`。登录用户注册由精确的 Main designated requirement、XPC audit token 和管理员授权的 root-owned enrollment record 共同绑定；Broker 从连接事实取得 EUID/ASID，不能信任请求体自报的 UID。开发 gate 可以给一次性测试 daemon 注入固定 EUID，但该 argv 形态必须命名为 bootstrap fixture，不能作为生产 `SMAppService` 协议或安装设计。反向验证 Broker 时以 root EUID 与精确代码签名身份为授权条件；system LaunchDaemon 的默认 audit session 可以作为诊断事实，但不能因其 ASID 为 0 而误拒合法 Broker。

Broker 只属于控制面。Provider 的 stdin/stdout、事件和业务协议仍由低权限 Runtime/seat worker 处理，root 进程不进入数据面。

### 3. Provider 只修改 staging workspace

Provider MUST NOT 直接获得真实用户仓库的写权限。每条 execution 使用独立 staging workspace：

1. Main 用仍然有效的 workspace grant 捕获源仓库 identity 和基线 manifest。
2. 受信任代码把获批内容复制或克隆到 execution staging root；staging root 只授予当前 seat UID 和最小宿主读取方。
3. Provider 只在 staging root 中执行。其私有 HOME、TMP、配置和输出也全部绑定该 execution。
4. Provider 退出且 seat 停止得到确认后，受信任的宿主扫描 staging 中的真实变化，生成内容寻址的 change set/diff 和 Artifact。
5. 回写前再次验证 workspace grant、源 identity、基线/冲突和 change set；只有经过明确的 apply authority 后，才由登录用户 UID 将变更应用到真实仓库。
6. Apply、拒绝、冲突或清理都产生审计事实。Broker 不以 root 身份替用户静默回写仓库。

实现可以用 APFS clone 或安全复制优化性能，但优化不得跳过 symlink/hardlink escape、特殊文件、大小/数量上限、源身份重验、冲突检查和 Artifact 扫描。阶段 4 不承诺无冲突自动合并。

### 4. Seatbelt 是纵深防御，不是 UID 隔离证明

现有 macOS Seatbelt 策略继续用于收窄 seat worker 的文件、Mach、signal、job creation 和网络能力，并继续运行 capability attestation。但它只能作为 defense in depth：

- catalog 和 UI MUST NOT 以 Seatbelt profile 名称宣称已实现完整主机隔离；
- `sandbox-exec` 或私有 policy rule 的存在不能替代跨 UID canary；
- 私有 coalition SPI、用户 domain `launchctl` job、watchdog socket 和 nonce 不能作为正式发行的根信任或唯一进程清理证明；
- Seatbelt 能力证明失败时仍然 fail closed。

### 5. Secret 和进程生命周期绑定到 seat lease

Secret Broker 每次只下发 Provider 所需的单个 execution-scoped credential。值不得出现在 argv、plist、持久配置、日志、事件、Artifact 或 Renderer DTO 中。传输必须发生在 seat 已降权之后，通过一次性继承 channel 或已认证的窄协议完成；Privileged Broker 不解释 credential 内容。

停止语义为：取消请求已登记，Provider 及全部后代已退出，stdout/stderr 已结算，staging 已封存，且 seat UID 的零进程证明通过。若任一步无法证明，execution 与 seat 都进入 quarantine/fail-closed 状态，不能报告 `stopped` 或启动下一条 execution。

## 开发态与发行 Gate

### 阶段 4：开发态隔离 Gate

阶段 4 可以使用明确标记的测试签名、fixture broker 和受控 privileged test harness，在专用开发机或 disposable VM 上验证目标拓扑。该 gate 至少包括：

- Broker、seat worker 和协议均从固定源码可重建，签名/哈希/权限检查可重复；
- 真实不同 UID 的 canary 证明 Provider 不能读取宿主 `KERN_PROCARGS2`、不能 signal 宿主、不能控制用户 bootstrap domain、不能连接私有控制 socket；
- execution 之间不共享 UID、HOME、TMP、credential 或 staging，且 seat 复用前有零进程证明；
- staging → scan → diff → authorized apply → cleanup 的成功、冲突、中断和 Broker 崩溃路径通过；
- 至少一个已启用的真实 Provider 完成审批、输出、Artifact、停止和外部能力 canary 的纵向链路。

测试 harness 可以要求开发者显式输入管理员凭据，但不得把未经签名的普通用户进程、`sudo` shell 脚本或同 UID fixture 结果描述成隔离通过。没有可用测试签名或管理员测试环境时，Phase 4 保持未完成。

### 阶段 7：正式发行与管理员安装 Gate

正式 macOS 交付还必须独立通过：

- `.app`、Broker、seat worker、native helper 和所有 nested code 使用正确 Developer ID 签名、Hardened Runtime，并完成公证与 Gatekeeper 验证；
- `SMAppService` 注册、管理员批准、拒绝后恢复、应用搬移和重注册流程通过；
- XPC 双向代码签名 requirement 在 release signature 下通过攻击测试；
- 服务账号、目录、LaunchDaemon 在安装、升级、降级、回滚和卸载中保持一致，且只删除确属当前产品的资源；
- Apple silicon、Intel（若仍支持）和目标 macOS 最低/最高版本矩阵通过；
- 自动更新不能造成旧 Broker、新 Main 或旧协议之间的提权与 fail-open 窗口。

阶段 4 的开发态 gate 不能替代这些发行 gate；阶段 7 也不能用签名、公证成功掩盖阶段 4 的运行时隔离失败。

## 考虑过的替代方案

### 继续强化同 UID Seatbelt 和 launchd Watchdog

该方案改动最小，但无法建立独立安全主体。已观察到的 `KERN_PROCARGS2` 和用户 bootstrap control 问题不是增加 nonce 或 watchdog 数量可以消除的，因此拒绝作为真实 Provider 的安全后端。相关代码可暂留为 fixture 或研究资产，但不得进入完成声明。

### Virtualization.framework Linux VM

VM 能提供更强的宿主进程和内核命名空间隔离，也支持多个并行 VM；但当前产品需要 macOS 本机 CLI、Xcode 和平台工具链。把默认 Runtime 改为 Linux guest 会改变任务兼容性，并引入 guest image 供应链、架构镜像、virtiofs、网络代理、资源调度和升级成本。

阶段 7 可以把 per-execution VM 或 warm VM pool 作为高隔离可选模式重新评估。它不能在没有产品决策的情况下静默替代本机 Runtime；若 VM 内多 execution 共享同一 guest UID，也仍需额外隔离。

### 降低威胁模型并信任 Provider

这可以保留同 UID 原型，但与“仓库、prompt 和 Agent 输出均不可信”的既定边界冲突。若未来提供明确的 Developer Preview，可以把 Provider 及其命令列为用户信任前提、强制单并发并清楚显示风险；该模式不满足阶段 4 的正式安全完成标准。

## 后果

### 正面后果

- Provider 与宿主、不同 execution 之间获得内核可识别的身份边界。
- service UID 同时提供自然的进程清理域；单 seat 失败不会要求信任 Provider 自报退出。
- staging 使残留进程无法继续改写真实仓库，并为扫描、冲突检查、审计和阶段 5 恢复提供明确中间态。
- 保留 macOS 本机 Provider 和工具链语义，不把 Phase 4 扩大为 Linux 虚拟机产品。

### 成本与风险

- Phase 4 增加 native Broker、服务身份、privileged integration test 和 staging/diff apply 工作。
- 首次启用真实 Provider 需要明确的管理员参与；企业无人值守安装另需正式安装策略。
- Broker 成为高价值攻击面，任何通用命令、路径或 root 数据面扩张都必须被拒绝。
- staging 会增加磁盘、复制和冲突处理成本；直接依赖真实仓库外部状态的任务需要显式 capability，不能自动继承用户 HOME。
- 本地开发若没有签名身份或管理员测试环境，只能运行非特权单元/fixture 测试，不能宣布 Phase 4 完成。

## 重新评估条件

- macOS 本机工具链不再是产品要求，且 VM 的性能、镜像供应链和网络控制均有可验证实现；此时可用新 ADR 将 VM 升为默认后端。
- 单 seat 吞吐成为已测量的主要瓶颈；此时按“一并发一 UID”扩展 seat pool，而不是放松 UID 隔离。
- Apple 移除或实质改变 Service Management、XPC peer requirement 或服务账号能力；此时在继续发行前重新评估平台后端。
- 产品明确选择只信任 Provider 的 Preview 威胁模型；该选择必须独立命名、显式告知用户，且不能覆盖本 ADR 的安全模式。
