# devrt Agent Instructions

- Read the task with `devrt task show <taskId>` before changing code.
- Treat `.devrt/tasks/<taskId>/task.md` as the user's original request. Do not rewrite it.
- Put any derived acceptance criteria in `.devrt/tasks/<taskId>/acceptance.json`.
- Only call actions listed by `devrt actions list`.
- Before adding new wrappers, run `devrt doctor` and inspect existing project CLI/tools/actions for reuse.
- Prefer a real workflow scenario over a generic typecheck: create resource, pass ids forward, wait/read result, and cleanup when possible.
- After code changes, run `devrt verify --task <taskId>` or `devrt verify scenario <name> --task <taskId>`.
- Continue fixing while status is `needs_action` or `needs_fix`.
- Stop only when `devrt status --task <taskId>` returns `verified`.
