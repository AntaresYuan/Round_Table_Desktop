# Round_Table macOS Swift S0 事实基线

状态：S0、S1 已完成；S2 待开始  
冻结日期：2026-09-16  
仓库：`/Users/yuanchenjie/Round_Table`  
分支：`codex/desktop-runtime`  
HEAD：`7ce7e20`

## 1. 工作区保护事实

- 工作区包含大量用户未提交和未跟踪内容；`apps/`、`packages/` 和 `docs/architecture/` 在本次基线中均属于未跟踪集合的一部分。
- 已跟踪修改至少包含 `.github/workflows/ci.yml`、`.gitignore`、`README.md`、`eslint.config.js`、`package.json`、`pnpm-lock.yaml` 和 `pnpm-workspace.yaml`。
- Swift 重构只能做增量修改；禁止 `reset`、`clean`、覆盖 checkout、批量重生成或删除未知文件。
- HEAD 和 tracked diff 不能代表当前桌面实现；实施和评审必须读取 working tree。

本基线记录状态类别和关键路径，不复制整份易过期的 `git status`。每个实施批次仍需在开始和结束时重新读取 dirty tree，并把新增变化与本基线区分。

## 2. 工具链事实

| 项目 | 2026-09-16 实测 |
|---|---|
| 主机 | Apple silicon `arm64` |
| macOS | 26.6.2（build 25G83） |
| Command Line Tools Swift | Apple Swift 6.0.3 |
| Xcode | 27.0（build 27A266a），Apple Swift 6.4 |
| Developer directory policy | 全局仍为 `/Library/Developer/CommandLineTools`；验证使用 scoped `DEVELOPER_DIR=/Applications/Xcode.app/Contents/Developer` |
| 无特权 SwiftPM | 可用，`swift build/test` 可执行 |

完整 Xcode 环境 gate 已解除；S1 `.app` 与嵌入式 bootstrap XPC 已完成无特权构建和 lifecycle smoke。验证使用局部 `DEVELOPER_DIR`，没有运行 `sudo` 或修改全局 developer directory。

## 3. 已冻结的迁移输入

| 边界 | 当前 working-tree 实现 | Swift 目标 |
|---|---|---|
| 产品壳 | `apps/desktop/src/main.mts`、Renderer、Preload、Electron IPC | SwiftUI/AppKit App |
| UI/Host 协议 | `packages/protocol` 与 `apps/desktop/src/runtime-private-protocol.ts` | canonical schema 生成 Swift/TS/C |
| 执行 authority | `apps/desktop/src/execution-authority.ts` | Swift actor/state machine |
| workspace grant | `apps/desktop/src/workspace-grants.ts` | Swift capability registry |
| staging/review/apply | `apps/desktop/src/staging-execution.ts`、`review-*`、`packages/runtime/src/staging-workspace.ts` | Swift Host Runtime |
| Host runtime | Electron `utilityProcess` 与 TypeScript child | 登录用户 UID Swift XPC service |
| service UID control plane | TS adapter + C native v1 protocol/lifecycle | Swift adapter；已验证 C 核心默认保留 |
| Provider | 当前 production backend fail closed；legacy 仅 fixture | service UID Seat Worker 真实启动 |

## 4. 既有阶段事实

- Phase 1–3 是 Electron 历史基线；迁移不改写其历史验证结果。
- P4-0 和 P4-1 已完成。P4-1 development gate 的最终成功 runId 为 `d5f00c79145df6567a85e2847015e3cd`。
- P4-2 只有 protocol/FSM/validator 等基础；真实 launcher、staging ACL、live attestation 和安装态 Mach service 尚未完成。
- P4-3/P4-4 的 TypeScript staging/review/apply 可作行为 oracle，但没有真实 service UID Provider 数据源。
- P4-5 真实 Provider E2E 和 P4-6 完整攻击/故障 gate 未完成。
- 不得读取或复用 `~/.codex/auth.json`。

## 5. S0 决策冻结

1. 正式 macOS `.app` 最终不包含 Electron、Chromium 或 Node host runtime。
2. SwiftUI/AppKit 负责产品层；登录用户 UID 下的 Swift Host Runtime 负责执行、staging、review/apply 和后续持久恢复。
3. C 安全核心不因语言统一自动重写；替换必须具备同一 corpus、攻击和故障证据。
4. Web 保持 TypeScript，跨语言共享通过 canonical contract，不通过运行时共享。
5. Swift 迁移保持 Sol 的 P4-0→P4-6 顺序；UI 进度不能升级安全完成声明。
6. P4-1 证据继续作为输入；改变集成路径后重跑相关 gate，但不重复设计多次管理员授权。

## 6. S1 初始落地状态

- 最近更新：2026-09-19。已建立 `apps/macos/Package.swift`、`RoundTableContracts` target、SwiftUI bootstrap executable，以及 `RoundTableMacOS.xcodeproj` 中的 App 与嵌入式 bootstrap XPC target；本机与 CI 路径共用同一 build/smoke gate，本机已取得 bundle lifecycle 证据。
- service UID canonical JSON 由同一 generator 生成 TS/C/Swift mirror；macOS Host Runtime v1 canonical contract 冻结 13 个操作、envelope、限制、事件和 forbidden payload keys。
- Swift handshake/request/response/event strict decoder、operation-specific DTO validation、forbidden-key 递归拒绝和 structural operation coverage 已落地。Swift tests：32/32。
- Host Runtime 共享 payload fixture 同时由 TS Zod 和 Swift strict decoder 读取验证；最近一次已记录 Protocol tests：21/21（4 files），typecheck、针对性 ESLint 通过。CI 和根级 `verify:macos:contracts` 已包含共享 fixture 验证。`runtimeAvailability` exact schema、canonical tuple 和 transport handshake 已进入 TS/Swift 同源合同。TS fixture 验证的是标准 JSON 解析后的语义对象；Swift strict decoder 额外保留 duplicate-key 与数字 token 的 wire-level 拒绝能力。
- service UID generator、Host Runtime generator `--check` 已通过；service UID control/build tests 历史基线为 20/20。
- S1 已完成：Xcode 27/Swift 6.4 universal `.app` 与嵌入式 XPC bundle 构建、ad-hoc signature、bundle identity、启动/请求/停止和零残留进程验证通过。bootstrap XPC 固定返回 `unavailable`，不是 authenticated Host Runtime endpoint；真实 endpoint 属于 S3，持久 store migration 属于 S8/Phase 5，Phase 4 仍未完成。
