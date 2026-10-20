---
paths:
  - "src/**/*.test.ts"
  - "src/**/*.test.tsx"
  - "src/test/**"
  - "src-tauri/src/**"
  - "vitest.config.ts"
---

## Stack

- Frontend: Vitest (`vitest.config.ts`, files `src/**/*.test.ts(x)` next to the code) with `@testing-library/react`, `@testing-library/user-event` and `@testing-library/jest-dom`. The default environment is `node`; DOM tests start with `// @vitest-environment jsdom`.
- `src/test/setup.ts` runs before every file: it sets the locale to `pt-BR` (component tests assert the Portuguese copy; `i18n.test.ts` covers English), cleans up the DOM and shims `ResizeObserver`, `matchMedia` and `scrollIntoView`.
- Backend: Rust `#[cfg(test)] mod tests` inside each module (or a `tests.rs` sibling, as in `workspace/`). Use `tauri::test::mock_app()` (the `test` feature) for code that needs an `AppHandle`, `mcp::test_support` (`hub`, `identity`, `RecordingHost`) for the MCP hub, `db::open_in_memory()` for SQLite and `worktree::test_repo` (`init`, `cleanup`) for real git repositories.
- The MCP server is tested over real HTTP on `127.0.0.1` (`server.rs` `TestServer`), tools directly through `tools::call` without HTTP.

## Naming

- !IMPORTANT: Use BDD Given-It style — each test reads as a sentence: given <condition> → <observable outcome>.
  - Rust: `given_<condition>_<outcome>`, e.g. `given_a_token_of_another_workspace_lists_no_tasks`, `given_a_symlink_outside_the_workspace_refuses_to_open_it`.
  - Vitest: `it("given <condition>, <outcome>")` inside a `describe("<unit>")`, e.g. `describe("shouldNotify")` → `it("given the app is focused, stays quiet")`.
- Existing tests use sentence names without `given` (`requests_without_a_valid_token_get_401`, `it("stays quiet while the app is focused")`). NEVER rename them just for style; new tests follow Given-It.
- Describe the observable behavior, not the implementation step.

## Data

- Each test creates and cleans up its own data: its own in-memory database, its own temp directory or git repo (removed at the end), its own store state. NEVER share mutable data between tests.
- Reset Zustand stores a test touches (`useXStore.setState(...)`) in `beforeEach`; NEVER rely on state left by another test.
- Create test data with small factories in the test file or the module's `test_support`, never with the code under test.
- Use fictitious values only (see `.claude/rules/security.md`): `/Users/me/...`, terminal ids `t-1`, workspace ids `ws-1`.

## Dependencies

- Prefer real dependencies over mocks: in-memory SQLite, real temp files, real git repos, the real axum router.
  Mock only what the test cannot control: the Tauri IPC (`vi.mock("../lib/tauri/<area>")` or `vi.mock("../../api")`), xterm.js, timers (`vi.useFakeTimers()`), the clock and randomness.
- NEVER call `invoke` in frontend tests; mock the `lib/tauri` wrapper the code uses.
- The browser preview (`?mock`, `src/dev/mockBackend.ts`) is for looking at the UI, not a test fixture; keep it answering every IPC command when you add one.

## Coverage of behavior

- Every bug fix comes with a test that reproduces the bug.
- Every new or changed branch has a test (no coverage tool is configured).
- Cover the happy path, not-found/empty cases, invalid input and authorization boundaries: for MCP code, another workspace's token, a missing or wrong token (`401`), a non-orchestrator calling `assign_task`; for file access, paths with `..`, absolute paths and symlinks out of the workspace.
- Platform-specific code (`#[cfg(unix)]` / `#[cfg(windows)]`, quoting for POSIX vs PowerShell/`cmd`) is tested for each flavor it supports.
- Pure logic (`src/domain`, `src/lib`, `*Model.ts`) is tested without rendering.

## Anti-patterns

- NEVER disable, skip (`it.skip`, `#[ignore]`) or weaken a failing test to make the suite pass.
- NEVER depend on test execution order.
- Avoid fixed sleeps to wait for async work in new tests — prefer fake timers, `waitFor`, or polling with a bounded deadline. Real PTY and process tests that already sleep briefly are the exception.
