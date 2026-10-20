---
paths:
  - "src/**"
  - "src-tauri/src/**"
  - "src-tauri/build.rs"
  - "index.html"
  - "vite.config.ts"
  - "vitest.config.ts"
---

## Language

- !IMPORTANT: Code, comments, doc comments, log messages and commit messages are written in English. User-visible text goes through i18n (§i18n).

## General

- !IMPORTANT: Follow idiomatic modern TypeScript/React and Rust. Rust is formatted with `cargo fmt` (default config) — never hand-format against it. TypeScript has no formatter configured: match the surrounding file (double quotes, semicolons, 2-space indent).
- Prefer small, single-purpose functions and explicit types at module boundaries (exported functions, IPC wrappers, `pub` Rust items).
- NEVER mix responsibilities. Each module, type and function owns a single concern and must not take on work that belongs to another or depend on its internals. For example, a SQL query belongs in `mcp/repo.rs`, never in a tool handler, a Tauri command or a React component.
- NEVER create Magic Numbers — define named constants for values with special meaning (`MAX_EDIT_BYTES`, `MAX_FILE_LIST_LIMIT`, `PANEL_EVENTS`, `MAX_MESSAGE_LENGTH`).
- Avoid Side Effects — `src/domain/`, `src/lib/` helpers and `*Model.ts` files are pure: no IPC, no stores, no `Date.now()` or timers inside the rule itself (take the time as a parameter). I/O belongs in app hooks, stores, `lib/tauri` and backend modules.
- NEVER use `any` — prefer explicit types, or `unknown` narrowed at the boundary (see `errorModel.ts`).
- Avoid Regex — prefer built-in string and array methods for clarity and maintainability. Existing sanitizers and URL detection are the exception, not the model.
- !IMPORTANT: Verify if a helper already exists before implementing a new one: `src/lib/` (`async/debounce`, `platform/shortcuts`, `session/*`), `src/domain/` (`formatTokens`, `agentLabels`, `selectors`), `src/components/ui/`, `src-tauri/src/sync.rs` (`LockExt::lock_or_recover`), `workspace::safe_relative_path`, `mcp::launch::quote`.
- NEVER implement helpers or utilities outside `src/lib/<area>/`, `src/domain/` or the feature/module that uses them.

## TypeScript and React

- !IMPORTANT: `tsconfig` is strict with `noUnusedLocals` and `noUnusedParameters`; `npm run build` (tsc) must stay clean. NEVER weaken the config.
- Function components and hooks only. Shared state lives in Zustand stores (`create` from `zustand`), read with selectors; local UI state stays in `useState`.
- Shapes crossing IPC are declared in `src/types.ts` and the `IpcCommandContract`; NEVER pass untyped records to `invokeCommand`.
- Closed sets are string-literal unions or `as const` arrays with a derived type (`FEATURE_FLAG_IDS` → `FeatureFlagId`), not free strings.
- Icons come from `lucide-react`, re-exported by `src/components/icons` (add new ones there); primitives from `src/components/ui` and Radix (`Dialog`, `Tabs`) before writing new ones.

## Rust

- !IMPORTANT: NEVER `unwrap()`, `expect()` or index out of bounds in non-test code on anything that can fail at runtime — use `?`, `.get()`, `let ... else` or combinators. The only accepted panics are startup invariants already documented in place (no OS randomness for tokens, compiled-in `agents.json`, building the Tauri app).
- !IMPORTANT: Lock shared state with `LockExt::lock_or_recover` (`sync.rs`), never `lock().unwrap()`.
- Tauri commands return `Result<T, String>` with a short English message the UI can show; module internals use typed errors (`StoreError`, `ToolError`, `std::io::Result`) and convert at the command boundary.
- Serialize IPC structs with `#[serde(rename_all = "camelCase")]` so they match `src/types.ts`.
- Deserialize external JSON (MCP tool arguments, hook payloads, persisted files) into typed structs at the boundary (`tools::parse<T>`). `serde_json::Value` stays at the edges: raw payloads, forgiving decode of persisted files, MCP results.
- Blocking work (SQLite, git, file I/O) never runs on the async runtime: use `#[tauri::command(async)]` or `tokio::task::spawn_blocking`, as `mcp/server.rs` does.
- Platform differences go behind `#[cfg(unix)]` / `#[cfg(windows)]` / `#[cfg(target_os = "macos")]`, and a change on one side is checked against the others (POSIX `sh -c`, PowerShell, `cmd /C`).

## i18n

- !IMPORTANT: Every user-visible string goes through `src/i18n`: `useT()` in components, `t()` outside React, `{name}` placeholders for values and `{ one, other }` leaves for plurals. NEVER concatenate translated fragments or hard-code UI text.
- Every key exists in `locales/en.ts` (source) and `locales/pt-BR.ts`; the `Dictionary<typeof en>` type fails the build when one is missing.
- Backend messages, logs, ids and agent output stay untranslated.

## Styling

- !IMPORTANT: Colours, surfaces, borders and status colours come from the `--terra-*` tokens in `src/styles/tokens.css` (documented in `.impeccable/design.json`). NEVER hard-code a colour in a component stylesheet.
- Status vocabulary: green = running, amber = attention, red = failure; nothing else uses those colours.
- Styles live next to the component (`<feature>.css` or `<Component>.module.css`, following the folder's existing choice).

## Naming

- !IMPORTANT: Names describe intent, not implementation (`planResume`, `claimTask`, not `doResume2`).
- !IMPORTANT: New boolean variables, functions and props use an `is`/`has`/`can` prefix (`is_`/`has_`/`can_` in Rust). Fields of the existing IPC contract (`available`, `binary`, `truncated`, `suspended` in `src/types.ts` and the Rust structs) keep their names; a new field in those structs follows the struct's existing style.
- !IMPORTANT: Numbers that carry a unit include it in the name (`timeoutMs`, `sizeBytes`, `MAX_BODY_BYTES`), or use `Duration`.
- Avoid abbreviations. Use full, descriptive names (`error`, `workspace`, `terminal`), except the language's idiomatic short names (`ctx`, `tx` for a SQLite transaction, `id`).

| Element | Convention | Example |
| --- | --- | --- |
| React component / file | PascalCase | `TaskBoard.tsx` |
| Hook | `use<Flow>` in `src/app/` | `useResumeQueue.ts` |
| Store | `<area>Store.ts`, `use<Area>Store` | `mcpStore.ts` |
| Pure model next to a component | `<name>Model.ts` | `boardModel.ts` |
| IPC command (Rust / TS key) | `snake_case` fn / camelCase key in `IPC_COMMANDS` | `mcp_list_tasks` / `mcpListTasks` |
| Tauri event | kebab-case, prefixed by area | `mcp-tasks-changed`, `voice-recording-error` |
| MCP tool | `snake_case` verb_noun | `claim_task` |
| Constants | `UPPER_SNAKE_CASE` | `MAX_EDIT_BYTES` |

## Comments

- NEVER add explanatory comments or commented-out code inside function bodies. Exception (as the codebase does): module doc comments (`//!`, a file-level `/** */`) and doc comments on exported/`pub` items stating what they guarantee, and a short comment for a non-obvious constraint (platform quirk, security reason, ordering requirement).

## Error handling

- NEVER swallow errors silently. A `catch` / `Err` arm must handle the error, return it, or convert it to a typed error. `let _ = app.emit(...)` is accepted only for best-effort UI notifications.
- !IMPORTANT: Preserve the original cause when wrapping (`map_err(|error| format!("...: {error}"))`, `cause` in TypeScript).
- !IMPORTANT: There is no logging crate or frontend logger. Errors that cannot reach the UI are reported through the existing channels: `eprintln!` in the backend, `console.error` / `console.warn` in the frontend, and the UI error paths (`AppErrorBoundary` + `errorModel.ts`, notifications, `voice-recording-error`). Adding a logger is a dependency decision to raise with the user.
- NEVER leave `println!`, `dbg!` or `console.log` debug output in committed code.

## Anti-patterns

- NEVER suppress compiler, type-checker or Clippy errors (`@ts-ignore`, `@ts-expect-error`, `#[allow(...)]`) without a comment explaining why — fix the cause instead.
- NEVER leave commented-out code or debug output in committed code.

## Conventions

- NEVER implement features beyond what was asked.
- NEVER create abstractions for single-use code.
- NEVER add "flexibility" or "configurability" that wasn't requested.
- NEVER add error handling for impossible scenarios.
- If you write 200 lines and it could be 50, rewrite it.
- NEVER "improve" adjacent code, comments, or formatting.
- NEVER refactor things that aren't broken.
- !IMPORTANT: Match existing style, even if you'd do it differently.
- !IMPORTANT: If you notice unrelated dead code, mention it - don't delete it.
- !IMPORTANT: Remove imports/variables/functions that YOUR changes made unused.
- NEVER remove pre-existing dead code unless asked.
- !IMPORTANT: If you notice that a well-maintained library would simplify your code, you should suggest using it.

!IMPORTANT: Ask yourself: "Would a senior engineer say this is overcomplicated?" If yes, simplify.
