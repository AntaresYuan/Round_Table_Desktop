# Host Runtime Protocol Compatibility Policy

状态：S1 policy 与 handshake contract 已冻结；live endpoint 与迁移实现尚未完成  
更新日期：2026-09-19

## 目的

Swift App 与登录用户 UID 下的 Host Runtime XPC service 必须使用可预测、fail-closed 的 wire protocol 版本。严格 exact-key 解码意味着任何不兼容字段变化都必须经过显式版本升级，不能靠忽略未知字段或静默降级继续执行。

## Live App ↔ Host Runtime 矩阵

| App protocol | Host protocol | 结果 |
|---|---|---|
| N | N | 允许进入 operation dispatch；仍须通过 peer 身份、审计上下文、session nonce 和 payload 校验 |
| N | N-1 | 握手拒绝，返回稳定 `unsupported_protocol_version`；不协商、不降级、不派发 operation |
| N-1 | N | 握手拒绝，返回稳定 `unsupported_protocol_version`；不协商、不降级、不派发 operation |
| 任意 | 未知/高于当前版本 | fail closed，保持 Runtime unavailable，不猜测兼容性 |

App 与 XPC service 随同一个签名 `.app` bundle 发布，正常安装/升级应原子替换。仍存活的旧 service 或旧 client 不得跨版本继续执行；更新启动时若不能确认双方版本一致，应停止新请求，并按 execution/seat 状态规则收敛或 quarantine，不能仅为升级而丢弃停止证明。

## 版本规则

- 每个端点必须在解析 operation payload 前校验精确 `protocolVersion`。
- v1 transport handshake、nonce 和 connection/session 规则由 [Host Runtime v1 接口与安全规则](./host-runtime-interface-security-v1.md) 定义并进入 canonical contract。
- v1 exact-key schema 中新增、删除或改变字段语义，新增 operation/event、改变身份/authorization 绑定，均视为 wire breaking change，发布新协议版本。
- 不允许“尝试 N，失败后重试 N-1”，也不允许由 Renderer 或 Provider 指定协商版本。
- 稳定错误码不得包含输入内容、credential、路径敏感细节或任意错误文本。

## 持久状态升级与降级

Host Runtime 持久状态 schema 版本与 XPC wire protocol 版本分别编号，不得混为一个版本。

- 从 N-1 升级到 N：必须先备份/记录迁移检查点，使用事务迁移；只有迁移验证通过后才允许写入 N 状态。
- 遇到高于当前程序支持的状态版本：只读诊断并 fail closed；禁止尝试降级解析或覆盖数据。
- N 状态降级到 N-1：默认不支持。只有定义并测试了显式反向迁移、保留未知数据且可回滚时才可放行；否则阻止降级启动并保留数据。
- 迁移中断或校验失败：恢复原子备份，或进入只读/quarantine；不得把部分迁移状态报告为成功。

## 发布前必需验证

- N App ↔ N Host：完整成功流程。
- N App ↔ N-1 Host、N-1 App ↔ N Host：均在 dispatch 前稳定拒绝。
- 未知/更高 wire version：稳定拒绝且无状态副作用。
- N-1 persisted-state fixture → N：成功迁移、幂等重试、迁移中断恢复。
- N persisted state → N-1：确认默认拒绝；若未来支持反向迁移，必须覆盖未知字段保留和失败回滚。

当前已有 v1 handshake/request/response/event strict decoder、共享 corpus 与 unsupported-version 单元测试，没有旧版 XPC service、持久状态迁移实现或 release upgrade evidence；因此合同层已冻结，但 live compatibility gate 尚未通过。
