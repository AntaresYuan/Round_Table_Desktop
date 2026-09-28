# Desktop Migration Test Baseline

状态：阶段 3 验证基线  
日期：2026-08-23

## 1. 目的与判定原则

桌面迁移必须先区分两类现状：

- **应冻结的正确行为**：迁移后仍必须成立，用回归测试保护。
- **不应固化的现有缺陷**：假交互、弱约束和验证盲区，只记录并改正，不能用 snapshot 或兼容层永久保留。

本基线冻结可观察的领域行为，不冻结当前文件路径、REST/tRPC 划分、JSON store、轮询实现或 fixture 数据。迁移总路线见 `desktop-runtime-migration.md`。

## 2. 现有测试与 CI

- Vitest 使用 `node` 环境，只收集 `tests/**/*.test.ts`，timeout 为 30 秒。
- 当前有 40 个测试文件；2026-08-23 实际执行收集并通过 293 个测试。
- 强项是 server action、scheduler、adapter、CLI runtime、memory、workspace 与纯函数测试。
- 没有 React Testing Library、jsdom、Playwright、Cypress 或 Electron E2E，也没有 coverage threshold。
- `.github/workflows/ci.yml` 在 Ubuntu / Node 24 上依次执行 install、typecheck、lint、test、audit、Next build。
- CI 只证明当前 Web/shared 的最低回归，不证明桌面壳、真实 PTY、进程树停止、崩溃恢复或安装包。

### 2026-08-23 本地验证记录

本次在 Node 22.9.0、项目声明的 pnpm 9.0.0 下按 CI 顺序验证：

- `typecheck`：通过。
- `lint`：通过。
- `test`：40 个文件、293 个测试全部通过。
- `audit --audit-level moderate`：未发现已知漏洞。
- `build`：生产构建通过；Next.js 报告现有 ESLint 配置未检测到 Next plugin 的警告。

CI 的规范环境仍是 Node 24；本地 Node 22 结果不能替代 Node 24 CI。并行同时运行 typecheck、lint、test 时曾使 500ms idle-timeout fixture 因资源竞争失败，按 CI 顺序单独执行完整测试后通过。该信号用于后续 Runtime 测试去除墙钟脆弱性，不用 retry 或放宽业务断言掩盖。

### 当前静态检查盲区

- `tsconfig.json` 有 `allowJs`，但没有 `checkJs`。
- `eslint.config.js` 的 glob 为 `**/*.{ts,tsx,js,mjs,cjs}`，漏掉 `.jsx`。
- `src/ui/components` 的 18 个组件文件中有 16 个是 `.jsx`。

因此当前 CI 全绿也不能代表主 UI 已被完整 typecheck/lint；这属于必须消除的缺陷。

## 3. 应冻结的正确行为契约

| 契约 | 必须保持的行为 | 当前证据 |
| --- | --- | --- |
| 审批先于执行 | Create Turn 只规划；未批准不得启动 Agent，批准后才 dispatch。 | `workflow.test.ts`、`turn-actions.test.ts` |
| 所有权隔离 | 用户不能读写、批准、删除或继续他人的 chat/turn/workbench。 | `turn-actions.test.ts`、`delete-turn.test.ts`、`auth.test.ts` |
| DAG 语义 | 拒绝环和未知依赖；线性、并行、菱形依赖正确；失败只阻塞下游。 | `scheduler.test.ts` |
| 状态可观察 | running 必须先于 terminal；失败、阻塞、中断、完成均落为明确状态。 | `scheduler.test.ts`、`turn-actions.test.ts` |
| Mission 连续性 | 同 chat 的 build turn 延续 Mission；问题 turn 不劫持；不同 chat 隔离。 | `mission-continuity.test.ts`、`question-intent.test.ts` |
| 澄清与意图 | 模糊 build 可停在 clarification；明确请求直达计划；问题不制造 build 流水线。 | `clarify-actions.test.ts`、`question-intent.test.ts` |
| Workflow 决定任务链 | 阶段顺序、seat、能力和显式 mention 决定计划；无效 template 被拒绝。 | `workflow-templates.test.ts`、`agent-roster.test.ts` |
| Scheduler 故障隔离 | 独立分支继续，异常转为失败记录，fix round 有上限。 | `scheduler.test.ts`、`dispatch-repair.test.ts` |
| Adapter 统一结果 | CLI/A2A/E2B/MiniMax 的事件、artifact、取消和错误映射到统一运行记录。 | `runtime-actions.test.ts`、`a2a-*.test.ts`、各 adapter test |
| CLI session 连续性 | 支持 resume 的 runtime 按 chat/agent 保存 session；损坏 registry 可恢复。 | `cli-sessions.test.ts` |
| Secret 不外泄 | API key、A2A token、runtime env 不从状态响应原样返回；生产敏感 API 鉴权。 | `settings-actions.test.ts`、`a2a-config.test.ts`、`production-api-auth.test.ts` |
| Workspace 边界 | 应用源码树不可作为工作区；扫描忽略系统/二进制/超限文件；删除限于受管范围。 | `workspace-scan.test.ts`、`delete-turn.test.ts` |
| Artifact 可追踪 | owner、版本、变更量可靠；同 identity 更新 bump version，无变化不伪造版本。 | `artifact-attribution.test.ts`、`deliverable.test.ts` |
| Memory 范围 | 用户偏好、workbench pin、agent project memory 正确隔离；导入防路径逃逸。 | `agent-memory*.test.ts`、`skill-actions.test.ts` |
| Web 持续可用 | 每个迁移阶段保留现有 Next 页面、API、认证、测试和 production build。 | 当前 CI |

迁移测试应断言状态、事件、权限和持久结果，不断言内部目录或 timer。旧测试只有在等价测试已运行于目标 package 后才能删除。deterministic fixture 可用于 unit test，但不能作为“真实 Agent 已执行”的验收证据。

## 4. 不应冻结、必须改掉的缺陷

| 现状 | 迁移后的期望 |
| --- | --- |
| Add Agent 只改 `RT.AGENTS`/`memberIds` 并写 localStorage | 通过受校验 command 持久化 roster 与 workbench 归属 |
| DM “Steer/Chat” 发送只清空输入 | 产生可追踪 command，并明确成功、拒绝或失败 |
| Breakout UI 只有 list/post，没有 `createRoom` wiring | 创建、参与、关闭和恢复都走真实协议与持久状态 |
| Request repair/tests 只改变交付决定 | 创建并执行真实 Fixer/test Task，支持审计、中断和恢复 |
| Reject handoff/fixer 下游闭环不完整 | 重算可恢复下游并重新验证交付 |
| 可绕过 approval 直接 dispatch，幂等边界不足 | 事务内校验 approval、lease 与 idempotency key |
| Safety 主要扫描 Agent 返回文本 | 扫描真实 diff/changed files，并保存扫描证据 |
| fallback 成功可看起来像真实执行 | UI/事件明确区分 simulated、fallback 与 real execution |
| 登录后 sidebar 状态硬编码 `idle` | 使用统一持久状态投影 |
| New Workbench workflow/team 仍依赖 fixture | 持久记录 roster、template/version 和 workspace policy |
| Workflow 推荐只改浏览器内 `RT` | 通过真实 command 保存，并能验证 createTurn 使用结果 |
| JSON store/进程内轮询被当作永久模型 | Desktop 使用 SQLite、事务、lease、持久队列和恢复 |
| `.jsx` 不在完整 typecheck/lint 中 | 转 TSX，或过渡期启用 `checkJs` 并覆盖 `.jsx` |
| 无组件、IPC、桌面 E2E | 建立下述分层测试 |

禁止为这些缺陷编写“当前就是这样”的通过测试。应先为期望行为增加失败测试，再替换旧实现。

## 5. 当前覆盖矩阵

| 能力 | 状态 | 缺口 |
| --- | --- | --- |
| Scheduler/planning/workflow/mission | 已覆盖 | 抽包后需改为 public API contract test |
| CLI 与远程 adapter | 已覆盖 | 尚无统一 conformance suite 和真实 PTY |
| Artifact/workspace/safety/memory/settings | 已覆盖 | 尚未接 Desktop watcher/SQLite/secret broker |
| API auth | 部分 | 只直接覆盖部分 settings/runtime/diagnostics route |
| tRPC/REST transport | 未覆盖 | 无 caller、schema、状态码、重试 contract matrix |
| UI pure projection | 部分 | 仅 live-scene、plan-presentation、preview-html、speech helper |
| React 组件和浏览器主链路 | 未覆盖 | 无 DOM/component/Web E2E |
| Accessibility/响应式 | 部分 | Desktop workspace flow 已覆盖 busy、Up、focus、live region；完整圆桌 UI/viewport 尚未覆盖 |
| Main/Preload/Renderer IPC | 已覆盖最小壳 | 36 个 Desktop tests + 真实 Electron smoke；Mission/Runtime IPC 待阶段 4 |
| PTY/进程树/审批/env 白名单 | 不存在 | 现有 child-process test 不足 |
| SQLite migration/lease/崩溃恢复 | 不存在 | Desktop storage 尚未建立 |
| macOS/Windows 安装升级卸载 | 不存在 | CI 目前只有 Ubuntu |

## 6. Desktop Runtime 新测试层次

1. **Domain unit**：Mission/Turn/Task/Artifact 状态机、scheduler；纯函数、注入 clock/ID，毫秒级跨平台运行。
2. **Protocol contract**：Renderer command、Runtime event、IPC schema 的正反例、版本兼容和 encode/decode round trip；拒绝任意 shell、绝对路径和原始 secret。
3. **Storage integration**：临时 SQLite、transaction、migration、并发 lease、幂等 queue；故障后不得留下幽灵 `running`。
4. **Runtime integration**：fixture executable/PTY 验证 stdout/stderr、JSONL、交互、timeout、异常退出、artifact watcher；Stop 必须在时限内终止完整进程树。
5. **Main/Preload security**：断言 `nodeIntegration=false`、`contextIsolation=true`、严格 CSP；bridge 不暴露 `ipcRenderer`、fs、child_process 或通用 shell。
6. **Renderer component**：用 fake typed bridge 测 Mission、审批、live status、Stop、artifact、repair/tests、breakout、roster；覆盖 loading/error/retry/reconnect/restored、键盘和 focus。
7. **Desktop E2E**：临时仓库 → Mission → approval → fixture Agent 改真实文件 → Artifact/diff → Stop → 强退 → 重启恢复；补重复审批、CLI crash、磁盘失败和旧库升级。
8. **Cross-platform release**：Ubuntu 跑 Web/shared；macOS/Windows 跑 Desktop build、最小 E2E、签名配置与安装/卸载 smoke。

## 7. 阶段 1 验收命令

在干净 checkout、Node 24 下执行 CI 等价检查：

```bash
corepack enable
corepack pnpm install --frozen-lockfile
corepack pnpm typecheck
corepack pnpm lint
corepack pnpm test
corepack pnpm audit --audit-level moderate
NEXTAUTH_SECRET=ci-nextauth-secret NEXTAUTH_URL=http://localhost:3000 corepack pnpm build
git diff --check
```

涉及 scheduler、store、workflow 或 runtime 时额外执行：

```bash
corepack pnpm cli workflow smoke --message "Build a waitlist page"
```

阶段 1 关闭还要求：冻结/不冻结清单经评审；不得跳过旧测试；移动测试先有等价替代；Web build 通过；为后续 `test:domain`、`test:protocol`、`test:runtime`、`test:ui`、`test:desktop:e2e` 确定 script/CI 归属；修复 `.jsx` 检查盲区或明确负责人和截止阶段。

## 8. 迁移期治理

- 每个 PR 标注为行为冻结、缺陷修正或纯结构迁移；行为变化与搬目录分开提交。
- Runtime 测试必须有硬 timeout 和 teardown assertion，不遗留进程、PTY、临时库或工作区。
- Flaky test 不得只靠 retry 掩盖；必须定位 timer、process、network 或 storage 来源。
- E2E 失败保留结构化 event log、main log、runtime transcript、截图和数据库副本。
- Coverage 只看趋势；阶段 gate 以关键契约、故障注入和纵向链路是否被验证为准。
