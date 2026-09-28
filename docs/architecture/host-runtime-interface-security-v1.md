# Host Runtime v1 接口与安全规则

状态：Sol 决策基线；S1 canonical contract 输入
日期：2026-09-19
适用边界：`RoundTable.app`（登录用户 UID）↔ `RoundTableHostRuntime.xpc`（同一登录用户 UID）

## 1. 决策范围

本文冻结三项此前缺失的设计输入：`system.status.runtimeAvailability`、XPC peer/session/dispatch 规则，以及 Host Runtime 持久状态的版本与恢复规则。本文不声称 XPC endpoint、SQLite store、迁移器或产品 `.app` 已实现。

协议的 machine-readable source of truth 仍是 `packages/protocol/contracts/macos-host-runtime-v1/contract.json`。Swift 和 TypeScript validator 必须从同一字段集合与枚举验证，不允许产品代码用宽松字典替代。

## 2. `runtimeAvailability`

`runtimeAvailability` 只回答 Host Runtime 的安全状态和是否接受新的 execution。Provider 是否安装、版本和能力继续由 `runtime.catalog` 表达，不能从 availability 推断。

```json
{
  "state": "ready",
  "reason": "ready",
  "admission": "open",
  "supportedStateVersion": 1
}
```

字段是 exact-key：

| 字段 | 取值 | 语义 |
|---|---|---|
| `state` | `initializing`、`ready`、`unavailable`、`quarantined` | Host Runtime 的安全状态 |
| `reason` | canonical reason enum | 稳定、无敏感数据的原因码 |
| `admission` | `closed`、`open`、`busy` | 是否接受新 execution；不是 Provider 能力声明 |
| `supportedStateVersion` | 当前固定为 `1` | 当前程序能读写的 Host Runtime state schema；不是磁盘上观察到的版本 |

只允许以下组合：

- `initializing / initializing / closed`；
- `ready / ready / open`；
- `ready / ready / busy`；
- `unavailable / {state_migration_required, state_version_unsupported, broker_unavailable, broker_identity_unverified, service_identity_unavailable} / closed`；
- `quarantined / {state_migration_failed, state_quarantined, seat_cleanup_unconfirmed} / closed`。

任何未知字段、未知枚举或非法组合必须拒绝整个 response。`ready` 是 Host Runtime 自身的准入结论，不是跨 UID 隔离、Broker 身份或零进程事实的独立安全证明；真正开始 execution 时仍要重新验证 grant、broker、seat、lease 和 staging 前置条件。

## 3. XPC 连接身份

Host Runtime 在读取 handshake 或 operation payload 前完成 peer 验证。授权事实只来自操作系统提供的连接上下文：

1. audit token 可解析且 token 中 EUID 等于当前登录用户；
2. audit session ID 等于 App 启动时冻结的登录 session；
3. token 对应 code object 满足当前 build profile 的 designated requirement、Team ID、App bundle identifier 和主 executable identifier；
4. development profile 与 release profile 分离。Release 不接受 ad-hoc/CDHash development identity，development 也不能伪装为 release evidence；
5. 连接的 PID、路径、请求体中的 UID、bundle ID 或自报身份只能用于诊断，不能参与授权；
6. 身份获取失败、字段缺失或彼此矛盾时立即 invalidate connection，不返回可继续使用的 session。

Host Runtime 到 Privileged Broker 使用另一套独立 requirement。App 身份通过不代表 Broker 身份通过，二者不得共享“已验证”布尔值或缓存。

## 4. Transport handshake 与 session

每条 XPC connection 必须先调用固定的 `openSession` transport method；该 method 不是可扩展 operation dispatcher。

请求 exact keys：

```json
{"protocolVersion":1,"clientNonce":"client_0123456789abcdef0123456789abcdef"}
```

成功响应 exact keys：

```json
{"protocolVersion":1,"sessionNonce":"session_0123456789abcdef0123456789abcdef"}
```

失败响应 exact keys：

```json
{"error":"unsupported_protocol_version"}
```

畸形但已完成 peer identity 校验的 handshake 使用 `{"error":"invalid_handshake"}`。Host 必须先完成 bounded reply，再 invalidate 当前 connection；若无法确认 reply 完成，直接 invalidate 并保持 session 未建立。失败响应不创建 session nonce，也不得进入 operation dispatcher。

- client/host nonce 均为 128-bit CSPRNG 值的小写十六进制编码；Host 不回显 client nonce作为 session nonce。
- `protocolVersion` 必须在 operation dispatch 前精确等于当前版本。版本不匹配返回本地稳定错误 `unsupported_protocol_version`，随后 invalidate connection；禁止协商或 fallback。
- session nonce 只绑定当前经过身份验证的 connection generation；连接关闭、endpoint 崩溃、App 重新连接或身份重验后立即失效。
- 每个 operation request 的 `sessionNonce` 必须等于当前 connection session；event 也必须携带同一 nonce。
- `requestId` 在一个 session 内只能使用一次。Host Runtime 保存有界 replay window；重复、窗口溢出或无法确认唯一性时拒绝并关闭 session。
- handshake 使用 canonical contract 中独立的 256-byte request 与 128-byte response 上限；operation 的速率和 request/response/event 大小采用外层 canonical 上限。先做对应长度和 handshake/session 检查，再解析 payload。

## 5. Operation dispatch

允许顺序固定为：

```text
OS connection facts
→ code/audit-session identity
→ exact-version handshake
→ session/replay/rate/size checks
→ envelope exact-key validation
→ operation-specific payload validation
→ authority/admission/state checks
→ handler
```

任何前置步骤失败都不得调用 handler。Dispatcher 只接受 canonical 13 个 operation；不存在通用 selector、command、environment、任意路径、任意文件操作或任意 Broker passthrough。

`system.status` 可以在 `initializing`、`unavailable` 和 `quarantined` 状态读取。其他 operation 使用显式 allowlist：只读诊断是否可用由各 operation 定义；创建 mission、approve、review prepare 和 apply 在非 `ready` 时一律拒绝。`ready/busy` 时不得接收第二个 execution，但允许查询和停止当前 execution。

稳定错误码不能包含输入、路径、prompt、credential、签名细节或任意底层错误文本。详细错误仅进入经过脱敏的本地诊断记录。

## 6. 持久状态版本

Host Runtime state schema 与 wire protocol 独立编号。v1 只冻结兼容性 envelope 和决策，不提前冻结 Phase 5 SQLite 表：

```text
store identifier
schemaVersion
store generation
migration journal state
content/integrity evidence
payload owned by that schema version
```

打开 store 前先验证 identifier、版本、generation、journal 和完整性。兼容性决策固定为：

| 观察结果 | 行为 |
|---|---|
| 无 store | 创建 v1 store；提交完成前 availability 保持 `initializing/closed` |
| 完整 v1 | 读写打开 |
| 已知且可迁移的旧版本 | `state_migration_required/closed`，进入显式迁移事务 |
| 高于支持版本 | 只读保留，`state_version_unsupported/closed`；禁止覆盖或降级解析 |
| 损坏、版本缺失、generation 回退或证据矛盾 | `state_quarantined/closed` |
| migration journal 存在 | 先恢复或回滚；在结论确定前不得开放 admission |

## 7. 迁移事务和崩溃恢复

迁移不得原地修改唯一副本。固定阶段为：

1. `observed`：只读冻结源 store identity、schema version、generation 和 hash；
2. `copying`：在同一受控父目录创建新 generation；
3. `validating`：按目标 schema 全量验证，禁止容忍未知字段或丢弃无法解释的数据；
4. `prepared`：fsync 新 store、journal 和父目录；
5. `committed`：原子切换 current pointer；
6. `verified`：重新打开并验证目标 generation；
7. `retired`：仅在 verified 后将旧 generation 标为可清理。

每次阶段变化先写 journal 再产生对应副作用。超时、进程退出或崩溃恢复规则：

- `observed/copying/validating`：丢弃未发布目标副本，源 store保持 current；
- `prepared`：验证目标和源 identity 后继续原子提交，或回滚到源；无法唯一判断则 quarantine；
- `committed`：只允许验证已提交 generation；验证失败回切源，回切证据不足则 quarantine；
- `verified`：继续使用目标，旧 store保持只读直到后续有界清理；
- journal 缺失、重复、倒退、hash 不符或 current pointer 与 journal 不一致：fail closed/quarantine。

降级默认不支持。旧程序观察到未来版本时必须保留数据并拒绝启动写路径；不得通过删除版本字段、复制已知列或新建空 store绕过。

## 8. 验收边界

S1 可以通过共享 corpus 证明 schema、枚举、非法组合和单端点版本拒绝一致。只有真实 `.app`/XPC endpoint 存在后，才能证明 audit-token 身份、connection generation、两端 N/N-1 pairing 和崩溃重连。只有持久 store 与 migration journal 实现后，才能证明迁移、回滚和 power-loss 等价恢复。

因此本文和 validator 完成后可以关闭“接口/安全规则未定义”缺口，不能关闭 XPC build、live endpoint、持久迁移或 Phase 4 security gate。
