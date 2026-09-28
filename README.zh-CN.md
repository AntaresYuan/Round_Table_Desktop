<div align="center">

<img src="docs/assets/readme/logo.svg" alt="Roundtable logo" width="140" />

# Roundtable

**一张圆桌,一支 AI 开发小队。**

用一句话描述你要做什么——然后*亲眼看着*一支常驻的 AI 智能体小队完成规划、
并行实现、审查把关、直至交付。每一个文件、diff、预览和决策都留在桌面上。

[![CI](https://github.com/EdwinjJ1/roundtable/actions/workflows/ci.yml/badge.svg)](https://github.com/EdwinjJ1/roundtable/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)
[![PRs Welcome](https://img.shields.io/badge/PRs-welcome-brightgreen.svg)](CONTRIBUTING.md)
[![Next.js](https://img.shields.io/badge/Next.js-15-black?logo=next.js&logoColor=white)](https://nextjs.org)
[![TypeScript](https://img.shields.io/badge/TypeScript-strict-3178c6?logo=typescript&logoColor=white)](https://www.typescriptlang.org)
[![GitHub stars](https://img.shields.io/github/stars/EdwinjJ1/roundtable?style=social)](https://github.com/EdwinjJ1/roundtable/stargazers)

[English](README.md) | **简体中文**

<img src="docs/assets/readme/roundtable-workbench.png" alt="Roundtable 工作台——围坐在圆桌旁的智能体小队" width="100%" />

</div>

## 为什么是 Roundtable?

大多数多智能体工具是个黑箱:输入一个 prompt,吐出一大段文本,中间发生的一切
都不可见。Roundtable 把“运行过程”本身做成了产品:

- 👀 **看见工作过程,而不只是结果。** 智能体围坐在一张实时圆桌旁,交接、
  审查状态、产物和讨论都发生在你眼前。
- 🧭 **值得信任的计划。** 规划者把你的需求拆解成带依赖关系的任务图——
  哪些并行执行、哪些在等待,一目了然。
- 🧾 **什么都不会丢。** 文件、diff、实时预览、审查评论和修复轮次都附着在
  对话上,随时可以回放。
- 🔁 **质量是关卡,不是运气。** 审查者会拦下不合格的工作;失败的任务进入
  有上限的修复循环,而不是无限打转。

## ✨ 亮点

- **常驻智能体小队** —— 规划、实现、审查、架构、修复等角色跨任务常驻于你的
  工作台。
- **可视化圆桌** —— 实时运行、交接、产物、审查状态和聊天集中在一个视图,
  还有 breakout 分组讨论间。
- **真实计划会议** —— 在任何编码运行时启动前,先记录 Planner 主持的“产品 →
  架构 → 执行 → 审查”接力。每个席位都有字数限制和互不重复的职责,确定性代码
  仍掌控分工与依赖。
- **依赖感知调度器** —— 相互独立的任务按并行波次执行;被阻塞的任务只等它
  真正依赖的东西。
- **有上限的审查 → 修复循环** —— 审查不通过或安全扫描发现阻塞问题时,触发
  有次数上限的修复轮次(`ROUNDTABLE_MAX_FIX_ROUNDS`)。
- **内置安全扫描** —— 智能体产物落地前自动检查密钥泄露和危险代码。
- **可插拔的智能体运行时** —— CI 用确定性本地分发,真实工作可切换 Claude
  Code / Codex / OpenCode 等 CLI、E2B 沙箱或 MiniMax 模型。
- **随规模生长的存储** —— 原型用本地 JSON,生产共享运行用规范化 Postgres。
- **统一动作层** —— 同一套业务工作流同时驱动 Next.js 应用、REST 路由、
  tRPC 和 CLI。

## 🪑 认识这支小队

<div align="center">

| <img src="public/avatars/planning.png" width="64" alt="Planning" /> | <img src="public/avatars/mira.png" width="64" alt="Mira" /> | <img src="public/avatars/nova.png" width="64" alt="Nova" /> | <img src="public/avatars/atlas.png" width="64" alt="Atlas" /> | <img src="public/avatars/beam.png" width="64" alt="Beam" /> | <img src="public/avatars/vera.png" width="64" alt="Vera" /> | <img src="public/avatars/fixer.png" width="64" alt="Fixer" /> | <img src="public/avatars/you.png" width="64" alt="You" /> |
| :---: | :---: | :---: | :---: | :---: | :---: | :---: | :---: |
| **Planning** | **Mira** | **Nova** | **Atlas** | **Beam** | **Vera** | **Fixer** | **你** |
| 主持人 | @pm | @architect | @implementer | @implementer | @reviewer | @fixer | 主席 |

</div>

## 🎬 实际效果

<div align="center">

*一次实时任务:共享白板上的架构草图、并行开工的实现者、守在关卡前的审查者。*

<img src="docs/assets/readme/live-roundtable.png" alt="智能体正在工作的实时圆桌" width="70%" />

*计划与产物:并行任务、带版本的文件、按作者着色的 diff、实时预览——全部
附着在这次运行上。*

<img src="docs/assets/readme/parallel-plan-artifacts.png" alt="并行任务计划与文件、diff、预览产物" width="55%" />

</div>

## 🚀 快速开始

```bash
git clone https://github.com/EdwinjJ1/roundtable.git
cd roundtable
corepack pnpm install
corepack pnpm dev
```

打开 [http://localhost:3000](http://localhost:3000) 就可以发起一个任务。
如果端口被占用,Next.js 会打印备用地址。

常用检查:

```bash
corepack pnpm typecheck
corepack pnpm test
corepack pnpm cli workflow smoke --message "Build a waitlist page"
```

> **零密钥体验:** 默认的 `local-dispatch` 适配器是确定性的,不需要任何
> API key——先把工作台、CI 和黄金路径演示玩起来,再接入真实的智能体运行时。

## ⚙️ 工作原理

```mermaid
flowchart LR
    U["🧑 你<br/>描述目标"] --> P["📋 规划者<br/>带依赖的任务图"]
    P --> S{"⚡ 调度器<br/>并行波次"}
    S --> A["🔨 Atlas<br/>实现 T1"]
    S --> B["🔨 Beam<br/>实现 T2"]
    A --> R["🔍 Vera<br/>审查关卡"]
    B --> R
    R -- 通过 --> OK["🚢 交付<br/>文件 · diff · 预览"]
    R -- 不通过 --> F["🛠️ 修复者<br/>有上限的修复轮次"]
    F --> S
```

1. 你用自然语言描述目标。
2. 计划会议读取紧凑的代码库上下文,依次接力产品、架构、执行和审查视角,
   然后锁定执行计划。
3. 用户批准后,调度器按并行波次执行所有解锁的任务。
4. 智能体产出文件、diff、预览、审查评论和交接。
5. 安全或审查未通过会触发有上限的修复轮次。
6. 运行结束时,所有产物和决策都保留在工作台中。

配置对话模型 Provider 后,计划会议会在 Claude Code/Codex/OpenCode 执行前先走
普通 API。可用 `ROUNDTABLE_PLANNING_MEETING_MODEL` 指定同一 Provider 下更便宜的
模型,或设为 `local` 使用零 Key 的确定性会议。调用量固定为两个并行专业视角、
一次执行回应、一次审查和一次 Planner 收敛。

## 🔌 智能体适配器

`local-dispatch` 是开发和 CI 的默认确定性适配器。需要干真活时换成真实运行时:

| `ROUNDTABLE_AGENT_ADAPTER` | 行为 | 依赖 |
| --- | --- | --- |
| `local-dispatch`*(默认)* | 确定性模板输出;devrt/CI 使用。 | — |
| `agent-cli` / `claude-cli` / `opencode` | 在工作区内启动所选的本地 CLI 运行时(`claude-code`、`codex`、`opencode`、router 或自定义命令)。执行前会报告命令路径、检测到的版本和凭证来源。 | `ROUNDTABLE_ENABLE_EXTERNAL_AGENT=1`;对应 CLI 的登录态或 API key |
| `e2b` | 在 E2B 沙箱中运行智能体 CLI。缺少 key 时回退到 `local-dispatch`(有日志)。 | `E2B_API_KEY` |
| `minimax` | 每个智能体调用真实的 MiniMax 对话模型(M3/M2.7)。自动剥离 `<think>` 推理;缺少 key 时回退到 `local-dispatch`。 | `MINIMAX_API_KEY` |
| `a2a` | 发现并调用每个席位配置的远程 A2A v1.0 Agent，把任务状态和产物流式回传到 Mission。 | 每个 Agent 的 A2A URL；Bearer Token 可选 |

### A2A 远程 Agent

在设置页把默认执行方式选为 `A2A Remote Agents`，再在 `A2A Agents`
区域为每个席位配置地址。也可以使用环境变量：

```bash
ROUNDTABLE_AGENT_ADAPTER=a2a
ROUNDTABLE_A2A_URL_ATLAS=https://atlas-agent.example
ROUNDTABLE_A2A_TOKEN_ATLAS=replace-with-remote-agent-token
ROUNDTABLE_A2A_CARD_PATH_ATLAS=/.well-known/agent-card.json
```

其他席位可把 `ATLAS` 换成对应 Agent id。同一席位同时存在两种配置时，
设置页保存的配置优先。Mission、DAG、Review/Fix 仍由 Roundtable 本地编排；
远程 Task ID 会映射回本地 PlanTask，支持的文本产物只会写入
`.roundtable/runs/a2a/`。当前版本不会把本地 `workspace://` 文件暴露给
远程 Agent，也不会直接把远程补丁应用到源码。

## 🔧 配置

把 `.env.example` 复制为 `.env.local` 按需修改。默认配置完全本地运行、
零密钥。

<details>
<summary><b>存储 —— 本地 JSON 或 Postgres</b></summary>

Roundtable 默认把数据存在 `.roundtable/data.json`。设置 `DATABASE_URL`
即可切换到 Postgres。存在数据库地址时,生产默认使用规范化驱动:

```bash
DATABASE_URL=postgres://roundtable:roundtable@localhost:5432/roundtable \
ROUNDTABLE_STORE_DRIVER=postgres_normalized \
corepack pnpm dev
```

使用本地 Docker 数据库:

```bash
corepack pnpm db:up
corepack pnpm db:migrate:local
corepack pnpm db:smoke:local
corepack pnpm dev:postgres
```

把已有的本地 JSON 数据迁移到 Postgres:

```bash
DATABASE_URL=postgres://roundtable:roundtable@localhost:5432/roundtable \
corepack pnpm migrate:postgres
```

</details>

<details>
<summary><b>认证 —— NextAuth + Google OAuth</b></summary>

Roundtable 使用 NextAuth。生产环境应使用已验证 Google 邮箱的 Google
OAuth 登录;credentials provider 仅作为本地开发兜底。

生产环境必需的配置:

```bash
GOOGLE_CLIENT_ID=...
GOOGLE_CLIENT_SECRET=...
NEXTAUTH_URL=https://your-domain.com
NEXTAUTH_SECRET=...
```

需要授权的 Google 回调地址:

- `http://localhost:3000/api/auth/callback/google`
- `https://your-domain.com/api/auth/callback/google`

</details>

<details>
<summary><b>工作区与安全</b></summary>

生产工作台默认位于
`ROUNDTABLE_WORKSPACE_ROOT/{ownerId}/{workbenchId}`。除非显式设置
`ROUNDTABLE_ALLOW_CUSTOM_WORKSPACE_PATH=1`,生产环境会忽略自定义工作区路径。

智能体产物的安全扫描(密钥 + 危险代码)默认开启;仅在测试时才应设置
`ROUNDTABLE_SAFETY_ENABLED=false`。

</details>

## 🗂 项目结构

```
src/
├── app/                # Next.js 应用路由
├── ui/components/      # 圆桌、工作流、聊天、画廊、检查器 UI
├── server/
│   ├── actions/        # tRPC、REST 和 CLI 共享的业务工作流
│   └── store.ts        # 本地 JSON 或 Postgres 持久化
└── cli/                # 冒烟测试、迁移助手、本地数据库工具
```

**技术栈:** Next.js 15 · React 18 · tRPC · NextAuth · Postgres · Vitest · pnpm

## 🤝 参与贡献

欢迎贡献!请先阅读[贡献指南](CONTRIBUTING.md)——最简版本:

```bash
corepack pnpm typecheck && corepack pnpm lint && corepack pnpm test
```

如果 Roundtable 对你有帮助,点个 ⭐ 能让更多人发现它。

## 📄 许可证

[MIT](LICENSE) © Evanlin

## ⭐ Star 趋势

[![Star History Chart](https://api.star-history.com/svg?repos=EdwinjJ1/roundtable&type=Date)](https://star-history.com/#EdwinjJ1/roundtable&Date)
