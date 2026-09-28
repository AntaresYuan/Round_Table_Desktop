# Contributing to Roundtable

Thanks for your interest in contributing! This guide keeps things short and
practical.

## Getting started

```bash
git clone https://github.com/EdwinjJ1/roundtable.git
cd roundtable
corepack pnpm install
corepack pnpm dev
```

The default `local-dispatch` agent adapter is deterministic and needs no API
keys, so you can develop and test every feature locally without secrets.

## Before you open a PR

Run the full check suite — CI runs the same commands:

```bash
corepack pnpm typecheck
corepack pnpm lint
corepack pnpm test
```

For store or scheduler changes, also run the smoke workflow:

```bash
corepack pnpm cli workflow smoke --message "Build a waitlist page"
```

## Commit messages

Use [Conventional Commits](https://www.conventionalcommits.org/):

```
<type>: <description>
```

Types: `feat`, `fix`, `refactor`, `docs`, `test`, `chore`, `perf`, `ci`.

## Pull requests

- Keep PRs focused — one change per PR is easier to review and ship.
- Include tests for new behavior (unit tests live in `tests/`, run by Vitest).
- Describe *why* the change is needed, not just what it does.
- Screenshots or short clips are appreciated for UI changes.

## Reporting bugs & proposing features

Open a [GitHub issue](https://github.com/EdwinjJ1/roundtable/issues) with:

- What you expected and what actually happened.
- Steps to reproduce (adapter, store driver, and OS help a lot).
- For features: the problem you're trying to solve, before any specific design.

## Code style

- TypeScript strict; avoid `any` where practical.
- Prefer immutable patterns — return new objects instead of mutating.
- Many small focused files over few large ones.
- No hardcoded secrets — configuration goes through environment variables
  (see `.env.example`).

## License

By contributing, you agree that your contributions will be licensed under the
[MIT License](LICENSE).
