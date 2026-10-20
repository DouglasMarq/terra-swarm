# docs

Project documentation that doesn't belong in code comments: task plans and the demo media used by `README.md`.

## Layout

```
docs/
  README.md          this file
  media/             images and GIFs referenced by the root README
  plans/
    _template.md     copy this to start a new plan
    TASK<UnixTimestamp>-<branch-slug>.md one plan per task (replace `<UnixTimestamp>` with the output of `date +%s`)
```

## Task plans

Any task with more than one step gets a plan before coding starts. One-line fixes don't need one.

### Creating a plan

1. Create the branch from `development`, e.g. `feat/task-labels`.
2. Copy `plans/_template.md` to `plans/TASK<UnixTimestamp>-<branch-slug>.md`, replacing `/` with `-`:
   `feat/task-labels` → `plans/TASK1792512000-feat-task-labels.md`.
3. Fill in Goal, Context, Assumptions, Out of scope, Steps and Success criteria.
4. Ask a reviewer to approve it.

### Lifecycle

The `status` field in the frontmatter goes through these values:

| Status        | Meaning                                        | Who changes it |
| ------------- | ---------------------------------------------- | -------------- |
| `draft`       | Written, open questions not answered yet       | Author         |
| `approved`    | Scope and steps agreed, coding can start       | Reviewer/owner |
| `in-progress` | Being implemented; checkboxes are kept current | Implementer    |
| `done`        | Merged; the file is not edited anymore         | Implementer    |

### Rules

- **Every step needs a check**, e.g. `→ verify: cargo test --manifest-path src-tauri/Cargo.toml mcp::tools` or `→ verify: npx vitest run src/components/tasks/boardModel.test.ts`.
- **Name both sides of the IPC.** If the task adds or changes a Tauri command, an event or an MCP tool, list the Rust function, the `src/lib/tauri` wrapper, the `src/dev/mockBackend.ts` answer and the README section it touches.
- **Record changes of plan** under _Decisions / deviations_ with the date and the reason. Don't silently rewrite earlier steps.
- **Commit the plan in the same PR as the code** and link it in the PR description.
- **Leave finished plans alone.** They record why something was built the way it was. If the work changes later, write a new plan.
- **Use fictitious data only:** made-up paths (`/Users/me/projects/demo`), terminal ids (`t-1`), workspace ids (`ws-1`) and tokens. Never put real tokens, signing keys, user paths or agent transcripts in a plan.

### Success criteria checklist

Each plan's _Success criteria_ keeps the checklist from [`plans/_template.md`](plans/_template.md) unchanged and adds the task's Given-It cases. Run the checks with the commands in `.claude/CLAUDE.md` §6.

- [ ] `npm run build` succeeds (includes `tsc`)
- [ ] `npm test` passes
- [ ] `cargo fmt --manifest-path src-tauri/Cargo.toml -- --check` passes
- [ ] `cargo clippy --manifest-path src-tauri/Cargo.toml --all-targets` reports no new warnings
- [ ] `cargo test --manifest-path src-tauri/Cargo.toml` passes
- [ ] Every new or changed branch has a test
- [ ] Tests follow Given-It naming and cover the happy path, not-found/empty cases, invalid input and authorization boundaries (another workspace's token, a missing token, paths outside the workspace)
- [ ] New user-visible text exists in `en.ts` and `pt-BR.ts`
