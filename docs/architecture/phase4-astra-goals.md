# Round_Table Desktop Phase 4：Astra 目标基线

状态：目标记录。本文记录 Astra handoff 中已经确定的产品目标、边界和禁止事项，不把设计意图写成实现事实。

> 2026-09-13 后续产品决策：Phase 4 的安全目标和禁止事项不变；其中 Electron 入口只作为历史/迁移基线，正式 macOS 产品按 [Swift 原生重构计划](./macos-native-swift-migration-plan.md) 实施。

## 产品目标

Round_Table Desktop 是当前仓库中的独立桌面产品形态，继续采用 monorepo，共享领域模型和协议，但拥有独立的 Electron 入口、Local Runtime、测试和发布边界。Electron 是安全壳和系统集成层，不是把 Web 页面简单包进窗口。

## Phase 4 目标

Phase 4 要建立一条可以被操作系统事实验证的本地执行闭环：

```text
workspace grant
→ 用户审批
→ 捕获真实 workspace identity 与 baseline
→ 创建 execution-scoped staging
→ 独立低权限 service UID 执行 provider
→ 停止 provider 及全部后代并证明 UID 无残留
→ 封存 staging、扫描真实变化并生成 diff
→ 用户明确授权 apply
→ 重新验证 grant、identity、冲突和 change set
→ 由登录用户 UID 应用变更
→ 清理 secret、FD、staging 和 seat
```

Phase 4 的架构约束：

1. 真实 provider 及后代使用独立、不可登录、非管理员的 service UID；一个 seat 同时最多一条 execution。
2. Privileged Broker 只负责固定身份、固定目录、seat 生命周期、停止和有限的残留事实；它不执行 Node、shell、provider、prompt、diff 或 apply。
3. Provider 只能写当前 execution 的 staging，不能直接写真实 workspace。
4. 真实 workspace 的修改必须经过真实文件扫描、diff/review、grant/identity/conflict 重验和 authorized apply。
5. Seatbelt 只作纵深防御；它不能替代跨 UID 的身份和进程边界。Seatbelt capability attestation 失败时必须 fail closed。
6. Phase 7 才评估多 UID seat pool、Developer ID/公证、SMAppService 产品安装和可选 VM 隔离。

## 明确非目标

- 不以 Electron wrapper 或网页成功装载作为桌面产品完成标准。
- 不在 Phase 4 恢复共享 UID 并发，不把 VM 作为默认后端。
- 不读取或复用 `~/.codex/auth.json`。
- 不把同 UID fixture、Seatbelt 名称、bootstrap ping、codesign 成功或 provider 自报结果当作隔离完成证明。
- 不为旧残留流程设计多次管理员授权；恢复遗留对象和重新运行 gate 必须属于一次有界、可审计事务。
- 不自动清理无法证明归属的账户、组、job、目录或其他系统对象。
- 不因为 CI、单元测试或历史记录通过就宣称 Phase 4 完成。

## 阶段边界

- Phase 1–3：桌面壳、monorepo、Electron 安全边界和已有回归，属于历史完成范围。
- Phase 4：service UID、窄 broker、staging、真实 provider 纵向链路、攻击和故障 gate。
- Phase 5：持久队列、lease、outbox、完整重启恢复；但 Phase 4 已执行的特权修改和 apply 必须具备最低崩溃安全记录。
- Phase 6：业务 repair/tests/reject 等真实闭环。
- Phase 7：发行签名、公证、SMAppService、升级卸载、多 UID 和 VM 评估。

## 完成声明条件

只有无特权验证、development native gate、真实 provider 端到端验证、攻击与故障注入四类证据全部通过，且 host/root 最终残留检查一致，才能宣称 Phase 4 完成。
