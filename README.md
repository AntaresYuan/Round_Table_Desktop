<div align="center">

<img src="docs/assets/readme/logo.svg" alt="Roundtable logo" width="140" />

# Roundtable

**Your AI dev squad, around one table.**

Describe what to build — then *watch* a persistent squad of AI agents plan it,
implement it in parallel, review it, and ship it. Every file, diff, preview,
and decision stays on the table.

[![CI](https://github.com/EdwinjJ1/roundtable/actions/workflows/ci.yml/badge.svg)](https://github.com/EdwinjJ1/roundtable/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)
[![PRs Welcome](https://img.shields.io/badge/PRs-welcome-brightgreen.svg)](CONTRIBUTING.md)
[![Next.js](https://img.shields.io/badge/Next.js-15-black?logo=next.js&logoColor=white)](https://nextjs.org)
[![TypeScript](https://img.shields.io/badge/TypeScript-strict-3178c6?logo=typescript&logoColor=white)](https://www.typescriptlang.org)
[![GitHub stars](https://img.shields.io/github/stars/EdwinjJ1/roundtable?style=social)](https://github.com/EdwinjJ1/roundtable/stargazers)

**English** | [简体中文](README.zh-CN.md)

<img src="docs/assets/readme/roundtable-workbench.png" alt="The Roundtable workbench — a live agent squad around the table" width="100%" />

</div>

## Why Roundtable?

Most multi-agent tools are a black box: a prompt goes in, a wall of text comes
out, and everything in between is invisible. Roundtable makes the run itself
the product:

- 👀 **See the work, not just the output.** Agents sit around a live table.
  Handoffs, review states, artifacts, and chat happen in front of you.
- 🧭 **Plans you can trust.** A planner turns your request into a
  dependency-aware task graph — you see what runs in parallel and what waits.
- 🧾 **Nothing gets lost.** Files, diffs, live previews, review comments, and
  fixer rounds stay attached to the conversation, forever replayable.
- 🔁 **Quality is a gate, not a hope.** Reviewers block bad work; failed tasks
  get bounded fixer rounds instead of infinite loops.

## ✨ Highlights

- **Persistent agent squad** — planner, implementers, reviewer, architect, and
  fixer roles that stay with your workbench across missions.
- **Visual roundtable** — live runs, handoffs, artifacts, review state, and
  chat in one view, plus breakout side rooms.
- **Real planning meeting** — a planner-led product → architecture → execution
  → review relay is persisted before any coding runtime starts. Each seat has a
  bounded, non-overlapping mandate; deterministic code remains authoritative
  for ownership and dependencies.
- **Dependency-aware scheduler** — independent tasks run in parallel waves;
  blocked tasks wait for exactly what they need.
- **Bounded review → fix loop** — failed reviews or blocking safety findings
  trigger capped fixer rounds (`ROUNDTABLE_MAX_FIX_ROUNDS`).
- **Built-in safety scan** — agent artifacts are checked for secrets and
  dangerous code before they land.
- **Pluggable agent runtimes** — deterministic local dispatch for CI, real
  CLIs (Claude Code, Codex, OpenCode), E2B sandboxes, or MiniMax models.
- **Storage that grows with you** — local JSON for prototypes, normalized
  Postgres for shared production runs.
- **One action layer** — the same business workflows power the Next.js app,
  REST routes, tRPC, and the CLI.

## 🪑 Meet the squad

<div align="center">

| <img src="public/avatars/planning.png" width="64" alt="Planning" /> | <img src="public/avatars/mira.png" width="64" alt="Mira" /> | <img src="public/avatars/nova.png" width="64" alt="Nova" /> | <img src="public/avatars/atlas.png" width="64" alt="Atlas" /> | <img src="public/avatars/beam.png" width="64" alt="Beam" /> | <img src="public/avatars/vera.png" width="64" alt="Vera" /> | <img src="public/avatars/fixer.png" width="64" alt="Fixer" /> | <img src="public/avatars/you.png" width="64" alt="You" /> |
| :---: | :---: | :---: | :---: | :---: | :---: | :---: | :---: |
| **Planning** | **Mira** | **Nova** | **Atlas** | **Beam** | **Vera** | **Fixer** | **You** |
| facilitator | @pm | @architect | @implementer | @implementer | @reviewer | @fixer | chair |

</div>

## 🎬 See it in action

<div align="center">

*A live mission: architecture sketch on the shared board, implementers working
in parallel, a reviewer waiting at the gate.*

<img src="docs/assets/readme/live-roundtable.png" alt="A live roundtable run with agents working" width="70%" />

*The plan and its artifacts: parallel tasks, versioned files, author-tinted
diffs, and live previews — all attached to the run.*

<img src="docs/assets/readme/parallel-plan-artifacts.png" alt="Parallel task plan with file, diff, and preview artifacts" width="55%" />

</div>

## 🚀 Quick start

```bash
git clone https://github.com/EdwinjJ1/roundtable.git
cd roundtable
corepack pnpm install
corepack pnpm dev
```

Open [http://localhost:3000](http://localhost:3000) and start a mission. If
the port is busy, Next.js prints the alternate URL.

Useful checks:

```bash
corepack pnpm typecheck
corepack pnpm test
corepack pnpm cli workflow smoke --message "Build a waitlist page"
```

> **Zero-key demo:** the default `local-dispatch` adapter is deterministic and
> needs no API keys — perfect for trying the workbench, CI, and the golden-path
> demo before wiring up a real agent runtime.

## ⚙️ How it works

```mermaid
flowchart LR
    U["🧑 You<br/>describe a goal"] --> P["📋 Planner<br/>task graph with dependencies"]
    P --> S{"⚡ Scheduler<br/>parallel waves"}
    S --> A["🔨 Atlas<br/>implements T1"]
    S --> B["🔨 Beam<br/>implements T2"]
    A --> R["🔍 Vera<br/>review gate"]
    B --> R
    R -- pass --> OK["🚢 Ship<br/>files · diffs · previews"]
    R -- fail --> F["🛠️ Fixer<br/>bounded fix rounds"]
    F --> S
```

1. You describe a goal in plain language.
2. A bounded planning meeting reads compact repo context, relays product,
   architecture, execution, and review perspectives, then locks the plan.
3. After approval, the scheduler runs every unlocked task in parallel waves.
4. Agents produce files, diffs, previews, review comments, and handoffs.
5. Safety or review failures create bounded fixer rounds.
6. The run finishes with artifacts and decisions preserved in the workbench.

When a chat-model provider is configured, planning meetings use its ordinary
API before Claude Code/Codex/OpenCode dispatch. Set
`ROUNDTABLE_PLANNING_MEETING_MODEL` to a cheaper provider-compatible model, or
to `local` for the deterministic zero-key meeting. Calls are bounded to two
parallel perspectives, one implementation response, one review, and one
planner synthesis.

## 🔌 Agent adapters

`local-dispatch` is the default deterministic adapter for development and CI.
Swap in a real runtime when you want real work:

| `ROUNDTABLE_AGENT_ADAPTER` | Behavior | Requires |
| --- | --- | --- |
| `local-dispatch` *(default)* | Deterministic template output; used by devrt/CI. | — |
| `agent-cli` / `claude-cli` / `opencode` | Spawns the selected local CLI runtime (`claude-code`, `codex`, `opencode`, router, or custom command) in the workspace. Runtime status reports command path, detected version, and credential source before execution. | `ROUNDTABLE_ENABLE_EXTERNAL_AGENT=1`; CLI login or API key |
| `e2b` | Runs the agent CLI inside an E2B sandbox. Falls back to `local-dispatch` (logged) if the key is missing. | `E2B_API_KEY` |
| `minimax` | Runs each agent against the real MiniMax chat model (M3/M2.7). Strips `<think>` reasoning; falls back to `local-dispatch` if the key is missing. | `MINIMAX_API_KEY` |
| `a2a` | Discovers and dispatches each seat to a remote A2A v1.0 agent, streaming task state and artifacts back into the mission. | Per-agent A2A URL; optional Bearer token |

### A2A remote agents

Choose `A2A Remote Agents` under Settings → Default execution, then configure
the URL for each seat under Settings → A2A Agents. The equivalent environment
configuration is:

```bash
ROUNDTABLE_AGENT_ADAPTER=a2a
ROUNDTABLE_A2A_URL_ATLAS=https://atlas-agent.example
ROUNDTABLE_A2A_TOKEN_ATLAS=replace-with-remote-agent-token
ROUNDTABLE_A2A_CARD_PATH_ATLAS=/.well-known/agent-card.json
```

Replace `ATLAS` with another Roundtable agent id for per-seat routing. Saved
settings take precedence over environment values for the same seat. Roundtable
keeps Mission/DAG/review orchestration locally, maps remote task ids to local
plan tasks, and materializes supported text artifacts below
`.roundtable/runs/a2a/`. The first release sends text and structured handoff
context; it does not expose local `workspace://` files or apply remote patches
directly to source files.

## 🔧 Configuration

Copy `.env.example` to `.env.local` and adjust as needed. The defaults run
entirely locally with zero keys.

<details>
<summary><b>Storage — local JSON or Postgres</b></summary>

Roundtable stores data in `.roundtable/data.json` by default. Set
`DATABASE_URL` to use Postgres. When a database URL is present, the production
default is the normalized driver:

```bash
DATABASE_URL=postgres://roundtable:roundtable@localhost:5432/roundtable \
ROUNDTABLE_STORE_DRIVER=postgres_normalized \
corepack pnpm dev
```

For a local Docker-backed database:

```bash
corepack pnpm db:up
corepack pnpm db:migrate:local
corepack pnpm db:smoke:local
corepack pnpm dev:postgres
```

To migrate existing local JSON data into Postgres:

```bash
DATABASE_URL=postgres://roundtable:roundtable@localhost:5432/roundtable \
corepack pnpm migrate:postgres
```

</details>

<details>
<summary><b>Auth — Google OAuth via NextAuth</b></summary>

Roundtable uses NextAuth. Production sign-in should use Google OAuth with a
verified Google email. The credentials provider is a local developer fallback.

Required production values:

```bash
GOOGLE_CLIENT_ID=...
GOOGLE_CLIENT_SECRET=...
NEXTAUTH_URL=https://your-domain.com
NEXTAUTH_SECRET=...
```

Authorized Google redirect URIs:

- `http://localhost:3000/api/auth/callback/google`
- `https://your-domain.com/api/auth/callback/google`

</details>

<details>
<summary><b>Workspaces & safety</b></summary>

Production workbenches default to
`ROUNDTABLE_WORKSPACE_ROOT/{ownerId}/{workbenchId}`. Custom workspace paths
are ignored in production unless `ROUNDTABLE_ALLOW_CUSTOM_WORKSPACE_PATH=1`
is set deliberately.

The safety scan of agent artifacts (secrets + dangerous code) is on by
default; set `ROUNDTABLE_SAFETY_ENABLED=false` only for testing.

</details>

## 🗂 Project structure

```
src/
├── app/                # Next.js app routes
├── ui/components/      # roundtable, workflow, chat, gallery, inspector UI
├── server/
│   ├── actions/        # business workflows shared by tRPC, REST, and CLI
│   └── store.ts        # local JSON or Postgres persistence
└── cli/                # smoke tests, migration helpers, local DB tools
```

**Tech stack:** Next.js 15 · React 18 · tRPC · NextAuth · Postgres · Vitest · pnpm

## 🤝 Contributing

Contributions are welcome! Check out the
[contributing guide](CONTRIBUTING.md) to get started — the short version:

```bash
corepack pnpm typecheck && corepack pnpm lint && corepack pnpm test
```

If Roundtable is useful to you, a ⭐ helps others find it.

## 📄 License

[MIT](LICENSE) © Evanlin

## ⭐ Star history

[![Star History Chart](https://api.star-history.com/svg?repos=EdwinjJ1/roundtable&type=Date)](https://star-history.com/#EdwinjJ1/roundtable&Date)
