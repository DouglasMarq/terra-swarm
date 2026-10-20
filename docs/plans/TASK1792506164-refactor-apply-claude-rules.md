---
status: in-progress # draft | approved | in-progress | done
branch: refactor/apply-claude-rules
ticket: n/a (audit of the codebase against .claude/rules)
---

# Bring the codebase in line with `.claude/CLAUDE.md` and `.claude/rules/*.md`

## Context

`.claude/` (commit 4523412) introduced the project rules. An audit by three read-only agents (CSS tokens, frontend TS, Rust backend) plus a baseline run found that the hard rules already hold (no `invoke` outside `lib/tauri`, no `any`, no `@ts-ignore`, no `console.log`/`println!`/`dbg!`, every IPC path validated, MCP server bound to `127.0.0.1` with every route behind auth, en/pt-BR keys in sync, `IPC_COMMANDS` ≡ `invoke_handler`), but the "Before Finishing" gate is red and there are real bugs and rule gaps.

Baseline (development @ 4523412):

| Check | Result |
| --- | --- |
| `npm run build` | ok |
| `npm test` | **exit 1**: 269 tests pass, 20 unhandled rejections from `visual-shell.smoke.test.tsx` (real `listen` from `@tauri-apps/api/event` via `startMcpEventBridge`, not mocked) |
| `cargo fmt -- --check` | **fails** in 20 files |
| `cargo clippy --all-targets` | 3 warnings (`too_many_arguments` at `pty/mod.rs:275`, `:612`; `field_reassign_with_default` at `mcp/server.rs:74`) |
| `cargo test` | ok (127) |

Surfaces touched: frontend, backend, CSS tokens, `src/dev/mockBackend.ts`, IPC error shapes (only if Q5 is accepted). No persisted format changes, no `mcp.db` migration, no change to how agent CLIs are launched or resumed.

## Assumptions

- "Apply the best practices" means: fix rule violations that are bugs, security gaps or hard (`!IMPORTANT`/`NEVER`) rules, and the soft rules where the fix is mechanical and local. It does **not** mean a style sweep: the rules themselves forbid renaming existing tests, "improving" adjacent code and refactoring what isn't broken.
- Behaviour stays the same except where a step names a bug fix; each bug fix gets a Given-It test that reproduces it.
- Work runs on `refactor/apply-claude-rules` cut from `development`, one Conventional Commit per step/area, merged back into `development` at the end (no push, no PR unless asked).
- Parallel agents each work in their own git worktree on disjoint file sets and are merged into the branch one at a time, re-running the gate after each merge.

## Out of scope (unless the user asks)

- Renaming abbreviated identifiers (~150 uses: `e`, `ws`, `buf`, `pct`, ...) — rule "match existing style" / "never refactor what isn't broken". New code follows the naming rules.
- Renaming existing tests to Given-It (explicitly forbidden by `testing.md`).
- Splitting `spawn_terminal_inner` (315 lines) and moving `demo_seed` / `TauriHost` to their own files beyond what the clippy fix needs.
- Moving all business logic out of `App.tsx` and `VisualShellSurface.tsx` (large refactor; see Q6).
- Replacing the 38 direct `lucide-react` imports with the `components/icons` barrel and the 19 raw `terra-button` buttons with `ui/Button`.
- Per-locale search keywords in `settingsModel.ts` / `commandModel.ts`.

## Steps

Agents: **W0** runs first in this checkout; then **B1**, **B2**, **B3**, **F1**, **F2**, **C1** run in parallel in their own worktrees (file sets listed per step do not overlap); **F3** runs after F1/F2 are merged because it touches the same components.

### Wave 0 — green gate (W0, sequential, here)

- [x] 0.1 `cargo fmt` the backend → verify: `cargo fmt -- --check` passes. Commit `style(backend): apply cargo fmt`.
- [x] 0.2 Fix the 3 clippy warnings: `OutputPump`-style params struct for `pty/output.rs:47` (drops its `#[allow]`) and `spawn_terminal_inner`/`pty/mod.rs:612`; struct-init at `mcp/server.rs:74` → verify: clippy reports 0 warnings, `cargo test` passes.
- [x] 0.3 Mock `@tauri-apps/api/event` (or `startMcpEventBridge`) in `visual-shell.smoke.test.tsx` → verify: `npm test` exits 0 with 0 unhandled errors.

### Wave 1 — backend (parallel)

**B1 — `workspace/`, `worktree/`, `cli/`, `lib.rs`, `sync.rs`, `scrollback.rs`**

- [ ] 1.1 **Bug (high):** `persistence.rs:321` treats any read error as "no store", so the next save overwrites `workspaces.json`. Only `NotFound` starts empty; other errors log, back up and disable saving → verify: `given_an_unreadable_store_keeps_the_file_and_does_not_save`.
- [ ] 1.2 `persistence.rs:371-372`: log serialization and save-channel failures (`eprintln!`).
- [ ] 1.3 **Security:** validate `workspace_id` / `terminal_id` as plain path components before `root.join(..)` in `worktree/mod.rs:97` and check `starts_with(root)`; validate `WorktreeInfo.branch` (prefix `terra/`, no leading `-`) on load/import and pass refs safely to `push`/`merge`/`branch -D`/`merge-base`/`worktree remove` → verify: tests with `..`, absolute ids and a `--receive-pack=` branch.
- [ ] 1.4 **Bug:** `worktree::status` hides git errors as "clean, 0/0", which lets `merge` and `open_pull_request` skip the uncommitted-changes guard. Return `Result` and refuse on error → verify: test with a broken worktree path.
- [ ] 1.5 `review.rs:157`: report a failed `merge --abort` instead of "nothing was changed" → verify: test.
- [ ] 1.6 `workspace/git.rs`: run git through `worktree::git` (sets `GIT_TERMINAL_PROMPT=0`).
- [ ] 1.7 **Bug:** `cli/stdio.rs:115`: a non-JSON server reply produces no answer and hangs the client; return the `-32603` error → verify: test.
- [ ] 1.8 `workspace/store.rs:137,157`: `rename`/`set_width` return `Result` so the commands stop reporting success for an unknown workspace → verify: tests.
- [ ] 1.9 Locks: replace the 9 copies of `unwrap_or_else(|e| e.into_inner())`, the ~49 `lock().map_err(..)?` and the silent `if let Ok(lock)` skips (exit-time `save_now`, `lib.rs:183`) with `lock_or_recover` in these files.
- [ ] 1.10 `groups.rs:39,51`: `expect` → `let ... else`; preserve causes in `map_err(|_| ..)` (`worktree/mod.rs:89`); named constants for magic numbers (`clamp(1,128)`, `clamp(0.0,100.0)`, 8192 sniff, 150 ms debounce, 800 ms, CLI sizes/timeouts, JSON-RPC codes); remove explanatory in-body comments listed in the audit; comment or drop the `#[allow]`s.
- [ ] 1.11 Dead code `workspace/mod.rs:124,220-226` (`Project`, `SubTab`, `PaneMeta`, `SubtabMeta`): **only if Q4 = remove**.

**B2 — `mcp/`**

- [ ] 2.1 Defense in depth: add `AND workspace_id = ?` to the ~15 statements on `tasks`/`messages`/`notes` that filter by id only (`repo.rs` `load_task`, `update_task`, `complete_task`, `delete_task`, `load_message`, `load_note`, dependency join, claim fallback) → verify: tests with another workspace's id for each tool.
- [ ] 2.2 Move the `claim_task` `blocked_by` check, the `complete_task` owner/status checks and `update_task`'s `before` read inside their transaction.
- [ ] 2.3 `assign_task`: move the rules and the task-update + message write into `Repo::assign_task` in one transaction → verify: existing orchestrator tests + a non-orchestrator test.
- [ ] 2.4 Remove N+1 queries in `list_tasks`, `read_inbox`, `search_notes`, dependency lookups (set-based queries) → verify: existing tests unchanged.
- [ ] 2.5 Replace `mcp::guard` with `lock_or_recover`; log `StoreError`/`JoinError` in `hooks.rs:116-120,162`; keep the cause at `repo.rs:573`; named constants for label/key/summary lengths, busy timeout, worker threads, `/hooks/claude`, and reuse them in the tool JSON schemas (`tools.rs:106,190,222,253`); fix the `assign_task` description missing `\` continuations.

**B3 — `pty/`, `voice/`, `voice.rs`, `usage.rs`, `fonts.rs`**

- [ ] 3.1 **Bug:** poisoned locks make `kill_terminal_inner`, `kill_terminal_inner_destructive` and `kill_all` return without killing (process leak); use `lock_or_recover` everywhere in `pty/` and `voice/audio.rs`.
- [ ] 3.2 Blocking I/O: `download_model_impl` (file writes on the async runtime) → `spawn_blocking`/`tokio::fs`; `voice_list_models` → `#[tauri::command(async)]`.
- [ ] 3.3 `output_scan.rs:338` `unwrap` and `output.rs:98` `Instant` underflow → non-panicking forms.
- [ ] 3.4 Preserve causes (`audio.rs:271,801`), log where `unwrap_or_default` hides real failures (`agents.rs:100`, `fonts.rs:51`, `pty/mod.rs:517`); named constants (`MIN_PTY_DIMENSION`, channel sizes, buffer sizes with `_BYTES`, flush intervals, `ESC`/`BEL`, dev-server probe, transcriber params, reuse `TARGET_SAMPLE_RATE`); remove explanatory in-body comments; comment the legitimate `cfg_attr(.., allow)`s, remove the stale one on `PtyEntry`, mark `mcp_lease` as RAII.
- [ ] 3.5 `agents.rs:21`: quote the id in `command -v` (or restrict to catalog ids).

### Wave 1 — frontend (parallel)

**F1 — correctness, i18n, types (`src/app/`, `src/stores/`, `src/lib/`, `src/domain/`, `src/dev/`, `src/i18n/`, tests, and the component `.tsx` files that only need string/`useT` changes)**

- [ ] 4.1 **Bug:** `useWorktreeClose.ts:43` closes an agent as if it had no worktree when `worktreeStatus` fails; notify and keep it open → verify: test.
- [ ] 4.2 Report failures instead of swallowing them: workspace creation (`App.tsx:500`), clipboard (`WorktreeReviewDialog.tsx:128`, `VisualShellSurface.tsx:705`), `listSystemFonts` fallback, unlisten catches.
- [ ] 4.3 i18n: hard-coded PT/EN text (`errorModel.ts:38`, `SettingsDialog.tsx:88-94`, `NavigatorFilesView.tsx:60,61,80`, `App.tsx:486`, `fleet/model.ts:120-126,347-349`, `SubTabLane.tsx:7`, `AgentInspector.tsx:136-143`, "Terra Swarm" → `common.appName`, `"Auto"`, `"[...output dropped...]"`) into `en.ts` + `pt-BR.ts`; the ~22 components using `t()` switch to `useT()`; concatenated fragments become one key with `{placeholders}`; drop the `as MessageKey`/`as never` casts → verify: build + component tests in pt-BR, `i18n.test.ts`.
- [ ] 4.4 **Bug (Windows/Linux):** hard-coded `⌘`/`⌃` glyphs (`VisualShellSurface.tsx`, `WindowChrome.tsx:49`, `ProjectContainer.tsx:116`) → `formatShortcut` → verify: test per platform.
- [ ] 4.5 Closed sets: `VoiceStatus`, `RightDock` tab union, `HotkeyActionId` from `HOTKEY_ACTIONS`, `VoiceLanguage` from `VOICE_LANGUAGES`; `Hotkey` reuses `ShortcutDefinition`.
- [ ] 4.6 `mockBackend.ts`: answers for `create_workspace`, `create_group`, `export/import_workspace_snapshot`, `git_status`; `spawn_terminal` reads `args.terminalId`.
- [ ] 4.7 Test isolation: reset `useLibraryStore` + localStorage in `libraryStore.test.ts`, `useEditorStore` in `navigation.test.tsx` (`beforeEach`).
- [ ] 4.8 Remove the 4 `eslint-disable` comments (no ESLint) and replace with a short reason where the dependency choice is intentional.

**F2 — shared helpers and purity (`src/lib/`, `src/domain/`, `*Model.ts`, callers)**

- [ ] 5.1 One `CONTEXT_ATTENTION_PERCENT` in `domain/agentStatus.ts` (7 copies of `85`); reuse `agentKind` (6 copies), `promptPayload`, one accent-folding `normalizeSearchText` in `src/lib/text/` (7 copies), one `errorMessage(unknown)` (10 copies), `taskNumber`, `STATUS_PRIORITY`, `byId`, `fallbackProfile`.
- [ ] 5.2 Purity: `lib/terminalFonts.ts` keeps `terminalFontStack`/`filterFonts`, the IPC + canvas probe move to an app hook; `lib/session/sendPrompt.ts` keeps `promptPayload`, `sendPromptToTerminal` moves to `src/app/`; `settingsModel.ts` keeps icon ids, not components; clock passed in instead of `Date.now()` defaults.
- [ ] 5.3 Magic numbers → named constants with units (timeouts, poll intervals, `maxLength`s, scrollback, sizes listed in the audit).

**C1 — stylesheets only (`src/**/*.css`, `src/styles/tokens.css`, `.impeccable/design.json`, `src/styles/README.md`)**

- [ ] 6.1 Point the legacy palette in `App.css` (`--bg`, `--red`, `--green`, `--accent`, ...) at `--terra-*` tokens, or replace its uses.
- [ ] 6.2 Delete the 258 `var(--terra-x, #literal)` fallbacks (tokens always load; 18 of them don't even match the token).
- [ ] 6.3 Replace the 64 literals that map to existing tokens (or `color-mix` over a token); define `--terra-shell-popover` or use `--terra-shadow-popover`.
- [ ] 6.4 Add the missing tokens (`--terra-red-line`, `--terra-red-line-strong`, `--terra-scrim`, `--terra-amber-wash`, `--terra-border-hover`, `--terra-bg-menu-hover`, `--terra-wash-subtle`, ...) to `tokens.css` and `design.json`; single-use variants use `color-mix`.
- [ ] 6.5 Status-colour misuse, per Q2/Q3: focused pane amber ring → neutral focus ring (design.json); green "available/active/level" chips and amber "selected/in progress" → neutral or accent; priority, diff and destructive red per the answer.
- [ ] 6.6 Delete the dead Navigator rules overridden by the v3 block (`Navigator.module.css:544-638`).
→ verify: `?mock` preview screenshots of Workbench, Fleet, Settings, Navigator, dialogs before/after; no visual change except 6.5.

### Wave 2 — frontend structure (F3, after F1/F2 merge)

- [ ] 7.1 IPC out of components: `WorktreeReviewDialog` → `useWorktreeReview`, `FileEditorDialog` → hook/store, `VisualShellSurface` runtime polling → `useInspectorRuntime`; `usageStore` gets a `lib/tauri` wrapper and its hook moves to `src/app/`; `api.ts` re-exports `mcpApi`/`previewApi`.
- [ ] 7.2 Break the `inspector` ↔ `integration` cycle (move `inspectorModel.ts`/`inspectorRuntime.ts` into `components/inspector/`); `useVoiceCapture` imports `voiceModel.ts`; snapshot types out of `SettingsPanels.tsx`.
- [ ] 7.3 Pure derivations from `VisualShellSurface.tsx` (`visibleSnapshot`, context alerts, attention messages) and `TasksPanel.tsx` (`describeEvent`, `statusLabel`) into models with tests.
- [ ] 7.4 Explanatory in-body comments listed in the audit removed.
- [ ] 7.5 Typed errors instead of matching message text (`"changed on disk"`, `"busy"`, `mcpStore.error` after `update`) — **only if Q5 = yes** (touches backend error shape + IPC types).

### Wave 3 — integrate

- [ ] 8.1 Merge each worktree branch into `refactor/apply-claude-rules` one at a time; after each merge run the full gate.
- [ ] 8.2 README still true (no tool/env/shortcut change expected); update this plan's checkboxes and status.

## Success criteria

- Tests: Given-It tests for every bug fix above (1.1, 1.3, 1.4, 1.5, 1.7, 1.8, 2.1, 2.3, 3.1, 4.1, 4.4) and for every moved pure function.
- [ ] `npm run build` succeeds (includes `tsc`)
- [ ] `npm test` passes with 0 unhandled errors
- [ ] `cargo fmt -- --check` passes and `cargo clippy --all-targets` reports 0 warnings (`--manifest-path src-tauri/Cargo.toml`)
- [ ] `cargo test --manifest-path src-tauri/Cargo.toml` passes
- [ ] Every new or changed branch has a test
- [ ] Tests follow Given-It naming and cover the happy path, not-found/empty cases, invalid input and authorization boundaries
- [ ] New user-visible text exists in `en.ts` and `pt-BR.ts`
- [ ] `grep` finds no hex/rgb literal in component stylesheets outside `tokens.css` (except documented exceptions such as the preview canvas `#fff`)

## Open questions

- Q1. Scope: full plan (waves 0–3) or only the gate + bugs + security (wave 0, B1/B2/B3 bug/security items, F1)?
- Q2. Status colours in git diff (added green / deleted red), task priority (urgent red / high amber) and destructive actions (delete in red): document as exceptions with their own tokens, or switch to neutrals?
- Q3. Voice panel blue (`--voice-blue #7ea6ff`, 15 uses): approve as a `--terra-voice` token or switch to neutrals/accent?
- Q4. Dead code found: `Project`, `SubTab`, `PaneMeta`, `SubtabMeta` (Rust), `modeLabel` (`workbench/layout.ts:198`), the ignored `label` props of the loading components. Remove or leave?
- Q5. Replace message-text matching between backend and frontend with typed error codes (changes `Result<T, String>` for `write_file`/`write_terminal`)?
- Q6. Move `App.tsx` workspace/grid/agent-action logic into app hooks (large, out of scope by default)?

## Decisions / deviations

- 2026-10-20: plan drafted from the audit.
- 2026-10-20: approved by the user. Q1 = full plan (waves 0–3, App.tsx refactor stays out). Q2 = status colours outside status keep their hue through dedicated tokens (`--terra-diff-add`, `--terra-diff-del`, `--terra-priority-urgent`, `--terra-priority-high`, `--terra-danger*`) documented in `design.json`; the other misuses become neutral. Q3 = the voice blue becomes accent/neutrals. Q4 = remove the listed dead code. Q5 = typed IPC errors (step 7.5) are in. Q6 = out.
- 2026-10-20: 0.2 — `spawn_terminal_inner` takes a `SpawnRequest`, `spawn_output_pump` a `DurableScrollback`; the `spawn_terminal` Tauri command keeps its arguments (they are the IPC contract) with a commented `#[allow(clippy::too_many_arguments)]`.
