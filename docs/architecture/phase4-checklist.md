# Round_Table Desktop Phase 4 执行清单

状态以代码、测试和无特权构建证据为准；没有管理员事务或真实 provider 证据的项目保持未完成。

| 阶段 | 项目 | 状态 | 当前证据/缺口 |
|---|---|---|---|
| P4-0A | bootstrap-probe-v0 与 service-uid-v1 协议隔离、development CDHash pinning | ✅ 已落地 | `build-service-uid-xpc.mjs`、native protocol self-test；仍不是 Phase 4 gate |
| P4-0B | `dscl` inline/multiline/native 属性解析与 fail-closed | ✅ 已测试 | `service-uid-development-gate.test.ts`、真实 host 输出与最终通过的 development gate |
| P4-0C | 旧同 UID 真实 provider 路径关闭 | ✅ 已测试 | 默认 child catalog 全部 unavailable，prepare/launch 硬拒绝；live service backend 尚未接通 |
| P4-0D | residual/quarantine 报告语义 | ✅ 已实机验证 | 报告区分 `unknown`、`absent`、`present`、`cleanup-incomplete`、`quarantined`；跨 run journal/SIGKILL 恢复和最终零残留均有实机证据 |
| P4-1 | 单次管理员事务与 development native gate | ✅ 已完成 | run `d5f00c79145df6567a85e2847015e3cd` 在一次 Authorization 请求内通过全部 crash recovery、低权限身份、null-bootstrap canary、CDHash-pinned XPC、host 不变性与清理检查；退出码 0，`residualState=absent`。这只完成 development bootstrap fixture，不代表真实 provider 或整个 Phase 4 完成 |
| P4-2 | native service UID lifecycle | 🟡 部分完成 | listener 已接 broker-core FSM，并在成功操作上发送经 operation-response validator 校验的严格 success envelope；新增严格 operation request builders、bounded operation client 与一次性 secret FD handoff，validator 已覆盖 cleanup 成功后的 idle seat，拒绝路径会关闭 secret FD，corpus 已覆盖各操作 success response；缺真实 prepare/start/stop/cleanup callbacks、live attestation、service UID staging ACL |
| P4-3 | staging/review/authorized apply | 🟡 部分完成 | staging registry、private owner/mode-checked staging parent、prepare 前创建并在 approve 时 rekey 的 pre-launch transaction、strict immutable bundle schema、challenge、authorize/reject/revoke、并发 workspace 冲突测试、稳定 recovery/quarantine 错误码、renderer review/apply/reject 状态；ReviewAuthority 现在强制校验 session nonce 与 bundle workspace device/inode/root 对应实时 grant；缺 service UID staging ACL、真实 provider 来源 |
| P4-4 | Desktop 集成 | 🟡 部分完成 | main 已创建并注入 `DesktopReviewCoordinator`，IPC/preload 固定覆盖 begin/inspect/prepare/authorize/reject，renderer 在 confirmed termination 后自动 inspect 并要求显式 apply/reject；quit cleanup 对 review/runtime 清理失败 fail closed；service UID backend 与真实 provider 仍保持 unavailable |
| P4-5 | 真实 provider 纵向切片 | ⬜ 未开始 | 必须等待 P4-2 live lifecycle 与 secret/staging 链路 |
| P4-6 | 攻击与故障注入 gate | ⬜ 未开始 | 必须在同一受控管理员事务中执行，任何 inconclusive 保持 quarantine |

## 当前已验证

- Runtime/desktop TypeScript `tsc --noEmit` 通过。
- 以 `umask 077` 执行当前 runtime 完整回归为 15/15 文件、133/133 tests 通过；P4-1 focused regression 为 29/29，native build smoke 6/6，runtime lint、typecheck、JS syntax 和 `git diff --check` 通过。
- x64/arm64 native Authorization launcher 与 admin helper 均通过 self-test；launcher 缺失/畸形固定参数以 64 拒绝，admin helper 非 root 以 77 拒绝。生成 manifest 同时绑定两种架构的 size/SHA-256；gate 按 `process.arch` 读取 `native/bin/<arch>`。
- review coordinator、staging execution、local child、IPC focused tests 共 25/25 通过。
- native v1 uninstalled artifact build、七类 self-test、arm64 manifest/hash verifier 通过。
- 未运行 sudo，未修改 TCC、Full Disk Access 或系统信任库。最终实机 run `d5f00c…` 只请求一次授权并完成；没有 UID 498/499、service-UID 进程、broker/canary job、plist、安装目录、journal 或 sealed package 残留。
- 本次新增的 ReviewAuthority 回归覆盖尚未在当前工作树执行：本机 Vitest 启动被缺失的 `@rollup/rollup-darwin-x64` 可选依赖阻塞；`tsc -p apps/desktop/tsconfig.json --noEmit` 已通过。

## Sol 交付物逐项 checklist

图例：✅ 已有代码且有相称验证；🟡 已有部分代码或仅有无特权证据；⬜ 尚未开始；⛔ 当前约束禁止执行。

### P4-1 一次管理员事务

- [✅] 单次 native Authorization 入口、固定六输入/哈希协议、私有管道授权句柄传递、固定 transaction flag、sealed root helper
- [✅] host/root 双侧旧身份 fingerprint、UID/GID 唯一性、零进程、job/path 事实与 fail-closed 谓词
- [✅] 新 service identity 的 user/group GeneratedUID 在 manifest、journal、ownership marker 和删除谓词中冻结
- [✅] 固定 active journal 原子排他；完整旧 manifest/hash 支持跨 run 恢复，partial legacy deletion 有专门恢复谓词；host manifest 冻结 journal 是否存在，root 恢复结果必须与之相等
- [✅] host 绝对 deadline 与 root 单调 deadline、显式阶段转换、回滚与 quarantine 状态
- [✅] `unknown` / `cleanup-incomplete` / `quarantined` 残留语义
- [✅] root cleanup response 使用 exact-key/类型/一致性校验；host 独立检查 sealed package 与全部固定资源
- [✅] x64/arm64 launcher/helper 构建、hash、self-test；当前 P4-1 focused regression 29/29，完整 runtime 133/133
- [✅] 原 UID 499、GeneratedUID 覆盖中断、`sysadminctl` UID/GID 异步部分提交三种遗留均已由 host/root 双重证据恢复；run `d5f00c…` 前后无遗留
- [✅] 同一次管理员事务内真实子进程 `SIGKILL`、PID/phase/manifest 绑定、短 deadline、跨 run recovery、quarantine 与最终 journal 删除均有实机证据
- [✅] journal 使用 canonical `/private/var/db/roundtable`；精确 root-owned 0700 空骨架、合法 `.next` forward transition 与 user-only legacy state 均有 fail-closed 恢复谓词
- [✅] development native gate：run `d5f00c…` 的全部 required checks、cleanup checks 均为 true，`fixture_gate_passed`，零残留
- [✅] 开发态 native Authorization 路径只执行 sealed helper；用户通过同步 `dscl` 字段事务创建，系统生成 UUID 被 marker/journal/精确属性与唯一性证据绑定；不再使用不确定的 `sysadminctl -addUser`
- [✅] 部分创建恢复谓词冻结 runId、ownership token、旧 manifest hash、预期/实际 GeneratedUID、完整 group 字段、缺失 user 字段、UID/GID 唯一性、零进程、job/path 和 marker；host/root 任一不一致均 fail closed
- [✅] run `b378f3…` 暴露并验证了 interrupted recovery 的嵌套 legacy 判定缺陷；已要求被 `root-published` journal 绑定的 UID 498 当前身份不得再次作为内嵌 UID 499 遗留恢复，四分支回归已通过
- [✅] run `2b2e…` 已实机精确删除部分 UID/GID 498 identity 与 installation root；probe 使用事务起点过期 interrupted evidence 的缺陷已改为使用 probe journal 冻结的清理后状态，并有 interrupted→absent 回归
- [✅] run `305f9d…` 已证明无身份残留时可恢复前一 probe journal；新 probe 的 in-memory `path` exact-key 缺陷已修复为 canonical path 校验后剥离，替换 path 会 fail closed
- [✅] run `3fe139…` 已证明 `sysadminctl -roleAccount` 创建/删除、broker/canary bootstrap、SIGKILL recovery 与完整零残留 cleanup；canary 的 service-UID stdout/stderr 已改为 UID/GID-owned 0600，root cleanup 精确验证 owner/mode
- [✅] run `c776…` 的 UID 499/GID 20 异步部分身份已由专用 recovery profile 精确恢复；字段、UUID、补充组、marker、journal、零进程、job/path 任一不一致即 fail closed
- [⬜] 产品安装态长期 service identity、升级/卸载与 release attestation 仍属于后续 native lifecycle/release 工作，不是 development bootstrap fixture 的完成条件
- [✅] host 最终资源审计保留 root 已验证的 `quarantined`/`cleanup-incomplete` 状态，不再降级成普通 `present`
- [✅] canary worker 由可信 native 父进程强制置空 `TASK_BOOTSTRAP_PORT`；实机证明 procargs、signal、launchd control、host socket/file 均被拒绝，staging 写入成功，host LaunchAgent PID/runs 不变

### P4-2 Native service UID lifecycle

- [✅] machine-readable corpus、TS/C mirror、严格 request/response codec
- [✅] 单 seat FSM、lease/execution/preparation 绑定、secret FD 一次性消费
- [✅] peer code validity、audit session、client UID、broker/execution UID 绑定接口
- [✅] workspace grant 与 workload/provider authorization callbacks；拒绝时关闭 FD
- [✅] bounded operation client、prepare/start/stop/cleanup response validator
- [🟡] listener 接入 broker core；callbacks 当前为空并明确 fail closed
- [⬜] 真实 workload launcher、provider tree/UID 进程证明、staging ACL
- [⬜] live attestation 与已安装 Mach service lifecycle

### P4-3/P4-4 Staging、Review、Desktop

- [✅] host UID 私有 staging parent、canonical identity、mode/owner 检查
- [✅] prepare 前 staging、approve 时 mission→execution rekey、失败清理
- [✅] immutable/content-hashed review bundle、grant/session/device/inode 重验
- [✅] authorized apply、reject、conflict、recovery/quarantine 错误码
- [✅] main/preload/renderer review/apply/reject IPC 与 quit fail-closed cleanup
- [🟡] staging 目前由 host 创建；缺 service UID ACL 证据
- [⬜] provider 在 service UID staging 中真实写入并完成 stop barrier

### P4-5/P4-6 Provider 与攻击 gate

- [⬜] 真实 Codex CLI、scoped credential、service UID execution HOME/TMP
- [⬜] 正常运行、停止、review、拒绝、批准 apply、冲突、第二 execution 隔离
- [⬜] 错误签名/audit/lease/replay、procargs/signal/launchd/socket 攻击
- [⬜] double-fork、持有 FD、broker/provider/host 崩溃及 apply 竞争恢复
- [⬜] 同一受控管理员事务中的最终验收与残留证明
