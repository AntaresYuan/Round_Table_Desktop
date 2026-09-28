# Roundtable 架构决策与改造基线

本目录保存 Roundtable 桌面化期间的正式架构决策、阶段路线和验证基线。实现、评审和阶段验收以这些文档为共同依据。

## 当前基线

1. [桌面版运行时改造路线](./desktop-runtime-migration.md)：七阶段路线、里程碑、纵向切片和实施护栏。
2. [ADR-001：Desktop Local Runtime](./adr-001-desktop-local-runtime.md)：同仓库 Monorepo、Electron 安全壳与独立 Runtime 的正式决策。
3. [ADR-002：macOS Service-UID Isolation](./adr-002-macos-service-uid-isolation.md)：单席低权限 UID、极窄签名 Broker、staging/diff apply 与开发/发行 gate。
4. [Desktop Runtime 架构边界](./desktop-runtime-boundaries.md)：Renderer、Main、Runtime、Broker、service-UID seat、Orchestrator、Storage 的职责、依赖和权限边界。
5. [Desktop Migration 测试基线](./desktop-migration-test-baseline.md)：迁移必须保持的契约、必须修复的缺陷和后续测试分层。
6. [macOS 原生 Swift 重构计划](./macos-native-swift-migration-plan.md)：以 SwiftUI/AppKit、原生 XPC 和 Swift Host Runtime 取代正式 Electron/Node 桌面运行时，并映射到现有 Phase 4 gate。
7. [macOS Swift S0 事实基线](./macos-swift-s0-baseline.md)：冻结 dirty tree、工具链、迁移输入和既有 Phase 4 事实。
8. [macOS 原生 Swift Checklist](./macos-native-swift-checklist.md)：跟踪 S0–S8 的可执行进度与阶段门。
9. [macOS 原生 UI 对齐：Turn 快照回放方案](./macos-native-ui-parity-replay.md)（提案）：S2 与 Web 的实测差距、以 Turn 快照回放驱动原生 UI 对齐的方案，以及原生编排归属等待决策问题。

## 当前阶段

阶段 1、阶段 2 和阶段 3 已完成。当前进行阶段 4：把旧同 UID 原型替换为单席 service-UID Runtime、签名 Broker 与 staging/diff apply，并通过真实跨 UID 隔离和 Provider 纵向 gate。正式 macOS 产品方向已调整为原生 Swift；Electron 仅作为迁移期行为基线，待原生纵向链路通过后退出正式构建。
