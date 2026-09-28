# Round_Table Desktop Phase 4：Sol 执行链路

状态：实施顺序基线。本文记录 Sol handoff 已确定的执行次序；后续实现不得跳过阶段门。

> 2026-09-13 平台映射：P4-0 至 P4-6 的顺序和 gate 不变。新实现中 `Main` 映射为 Swift App/Host Runtime 的受信任职责，`Utility Runtime` 映射为 Swift Host Runtime XPC service，`Renderer` 映射为 SwiftUI 只读投影和用户意图层；完整迁移步骤见 [Swift 原生重构计划](./macos-native-swift-migration-plan.md)。

## 总原则

先解决确定性阻塞，再建立可恢复的单管理员事务，然后实现 native 生命周期，最后接入 staging/review/apply 和真实 provider。管理员事务只允许一次授权调用；未知状态、证据不一致、超时和崩溃均进入 fail-closed/quarantine。

## P4-0：无特权确定性阻塞

### P4-0A：pinned bootstrap 协议

- 让 `development-adhoc-pinned` 在 native protocol 编码、解析和 self-test 中与 build script 一致。
- 保持 bootstrap-probe-v0 与 service-uid-v1 的名称和完成声明隔离。
- 增加错误 CDHash、错误身份和 live response 的回归向量。

### P4-0B：Directory Service parser

- 接受本机实际的 inline、multiline 和 `dsAttrTypeNative:<name>` 输出。
- 拒绝重复属性、多个 continuation、混合冲突格式和无法唯一解释的输出。
- 用真实 `dscl` 输出形态增加无特权回归测试。

### P4-0C：硬性关闭旧同 UID 真实执行

- Desktop catalog 和 launch path 在 service UID backend 尚未通过前，真实 provider 必须 unavailable。
- 旧同 UID runtime 只能保留为显式 fixture/回归路径。
- 不得依赖本机 Seatbelt probe 结果偶然失败来提供安全边界。

### P4-0D：报告语义

- 区分 `absent`、`present`、`unknown`、`cleanup-incomplete` 和 `quarantined`。
- root helper 未明确退出、host 未收到完整结果、查询失败时不能写成 finished 或 no residual。

P4-0 全部通过前不得运行管理员 gate。

## P4-1：一次管理员事务与遗留恢复

1. host 无特权预检并冻结旧 run 指纹、新 runId、资源清单、artifact hash、deadline 和测试集合。
2. 一次管理员授权进入固定 native transaction helper。
3. root 重新验证旧账户、组、UID/GID、GeneratedUID、RealName、shell、HOME、hidden、成员关系、job 和进程。
4. 仅当 host 与 root 证据逐项一致时恢复/删除旧残留；任何不一致立即 fail closed。
5. 通过持久检查点创建新 topology、运行预定 gate、停止全部进程、封存 staging 并回收资源。
6. 超时由 root 侧单调 deadline 和独立停止逻辑处理；不能只终止 `osascript`。
7. 崩溃、SIGKILL 或断电留下 journal；下一次明确授权先恢复未完成事务，不能自动多弹一次授权。
8. 所有资源、账户、组、job、FD、secret、staging 和 root transaction helper 都通过最终 host/root 双侧检查后，才删除 ownership marker。

## P4-2：native service UID lifecycle

- 以一个 machine-readable v1 corpus 同时生成 TypeScript 和 C validators。
- 实现固定签名 peer、audit token、EUID/ASID、单 seat lease、一次性 secret FD、prepare/start/stop/cleanup。
- Broker 不接收任意 command、path、UID、signal target、launchd label、环境变量或 provider data。
- development-test-double、development-native 和 production-attested 三种 assurance 必须分开；fixture 不能启用真实 provider。
- 停止必须同时证明 provider tree、service UID 进程、stdout/stderr 和 staging 状态；仅 status response 不足以升级为 stopped。
- 任何 broker timeout、身份变化、lease mismatch 或状态矛盾都 quarantine。

## P4-3：staging、review 与 authorized apply

1. Main 捕获真实 workspace identity 和 baseline。
2. Broker 在固定 execution 根中建立 staging；service UID 只获得当前 execution 的最小访问。
3. Provider 退出并通过 stop barrier 后，冻结 staging。
4. 宿主扫描 staging 全部真实变化，生成 immutable/content-addressed review bundle。
5. 用户审批绑定 review bundle hash、baseline hash、grant revision、workspace identity 和一次性 apply nonce。
6. apply 前重验 source、grant、identity、conflict 和 bundle 内容；只由 host UID 写真实 workspace。
7. apply 的部分失败、并发编辑、崩溃和恢复目录都必须保留可验证事实；无法确认时 quarantine。

## P4-4：Desktop 集成

- Main/Utility Runtime 使用真实 service UID control plane；旧同 UID provider launch path 不得被生产组合根调用。
- Renderer 只收到状态、diff、artifact 和去敏日志。
- Secret Broker 只接受显式 scoped credential；Codex 不读取 `auth.json`。
- execution、provider、workspace、grant、approval、lease 和 apply state 必须形成单一可验证状态链。

## P4-5：真实 provider 纵向切片

- 首先选择依赖边界可明确验证的 Codex 原生 CLI；不先开放任意 PATH CLI 或脚本解释器闭包。
- 真实 provider 使用 service UID、staging、execution HOME/TMP 和一次性 credential。
- 完成正常运行、停止、review、拒绝、批准 apply、冲突和第二条 execution 的隔离验证。

## P4-6：攻击与故障 gate

在同一受控管理员事务中覆盖：错误签名、错误 audit context、重放、越权 lease、procargs、signal、launchd、socket、HOME/Keychain、链接/挂载/ACL、double-fork、持有 FD、broker/provider/host 崩溃、apply 竞争和恢复。任何 inconclusive 都不得转为 pass。

## 阶段门与责任

| 阶段 | 允许交付 | 禁止结论 |
|---|---|---|
| P4-0 | parser、协议、旧路径关闭、报告语义 | 不得运行特权 gate |
| P4-1 | 一次授权事务和遗留恢复方案 | 不得宣称 native lifecycle 完成 |
| P4-2 | live broker/seat lifecycle | 不得宣称真实 provider E2E 完成 |
| P4-3 | staging/review/apply 闭环 | 不得跳过 source/conflict 重验 |
| P4-5/P4-6 | 真实 provider 与攻击/故障证据 | 证据缺失时保持 unavailable/quarantine |

Sol ultra 负责威胁模型、native broker、事务恢复、staging/apply authority、真实 provider 接入和最终 gate。Luna 只能在接口冻结后处理测试向量、机械文档、报告整理、格式检查和低风险 UI 文案；不得自行放宽安全边界或决定残留删除条件。
