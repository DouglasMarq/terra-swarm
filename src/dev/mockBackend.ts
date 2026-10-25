/**
 * Browser preview of the app without the Rust backend.
 *
 * Loaded only in `vite dev` when the URL carries `?mock` and no Tauri runtime
 * is present. It answers every IPC command with sample data and emits a few
 * terminal events so the Workbench, Fleet, notifications and inspector have
 * something to show. Never shipped: the import is behind import.meta.env.DEV.
 */
import { emit } from "@tauri-apps/api/event";
import { mockIPC, mockWindows } from "@tauri-apps/api/mocks";
import type { AgentInfo, McpAgentStatus, McpTask, McpTaskPatch, Workspace, WorkspaceGitStatus, WorkspaceGroup, WorkspaceSnapshotTransfer } from "../types";

const workspaces: Workspace[] = [
  {
    id: "ws-terra",
    name: "terra-swarm",
    cwd: "/Users/me/projects/terra-swarm",
    terminals: [
      { id: "pty-claude-1", command: "claude", width: null, role: "orchestrator" },
      { id: "pty-claude-2", command: "claude", width: null, role: "executor", worktree: { path: "/tmp/wt/pty-claude-2", cwd: "/tmp/wt/pty-claude-2", branch: "terra/pty-claude-2", base: "main", repo: "/Users/me/projects/terra-swarm" } },
      { id: "pty-codex", command: "codex", width: null, role: "reviewer" },
      { id: "pty-shell", command: "zsh", width: null },
    ],
  },
  {
    id: "ws-docs",
    name: "site-docs",
    cwd: "/Users/me/projects/site-docs",
    terminals: [
      { id: "pty-kimi", command: "kimi", width: null },
      { id: "pty-claude-docs", command: "claude", width: null },
    ],
  },
  {
    id: "ws-cli",
    name: "cli-tools",
    cwd: "/Users/me/projects/cli-tools",
    terminals: [{ id: "pty-opencode", command: "opencode", width: null, suspended: true }],
  },
];

const groups: WorkspaceGroup[] = [];

const agents: AgentInfo[] = [
  { id: "claude", label: "Claude Code", available: true },
  { id: "codex", label: "Codex", available: true },
  { id: "opencode", label: "OpenCode", available: true },
  { id: "kimi", label: "Kimi", available: true },
  { id: "copilot", label: "GitHub Copilot", available: true },
  { id: "gemini", label: "Gemini", available: false },
  { id: "grok", label: "Grok", available: false },
  { id: "deepseek", label: "DeepSeek", available: false },
  { id: "shell", label: "Shell", available: true },
];

const now = Date.now();
let nextTaskNumber = 6;
const mockTask = (id: number, title: string, extra: Partial<McpTask> = {}): McpTask => ({
  id: `T-${id}`,
  workspace_id: "ws-terra",
  title,
  description: "",
  status: "todo",
  assignee: null,
  created_by: "pty-claude-1",
  priority: "medium",
  labels: [],
  position: id,
  depends_on: [],
  blocked_by: [],
  created_at: now - (10 - id) * 60_000,
  updated_at: now - (10 - id) * 30_000,
  events: [{ actor: "pty-claude-1", kind: "created", body: "", created_at: now - (10 - id) * 60_000 }],
  ...extra,
});
const mcpTasks: McpTask[] = [
  mockTask(1, "Refatorar resumePlanner para grupos suspensos", {
    status: "in_progress",
    assignee: "pty-claude-1",
    priority: "high",
    description: "Aceitar grupos suspensos sem perder a ordem das abas.",
    events: [
      { actor: "pty-claude-1", kind: "created", body: "", created_at: now - 500_000 },
      { actor: "pty-claude-1", kind: "claimed", body: "", created_at: now - 400_000 },
    ],
  }),
  mockTask(2, "Cobrir layout.ts com testes", { status: "in_progress", assignee: "pty-codex" }),
  mockTask(3, "Revisar animações do Workbench", { status: "review", assignee: "pty-claude-2", labels: ["ui"] }),
  mockTask(4, "Documentar atalhos de voz", { priority: "low" }),
  mockTask(5, "Publicar a documentação", { depends_on: ["T-4"], blocked_by: ["T-4"] }),
];
const mcpStatuses: McpAgentStatus[] = [
  { terminal_id: "pty-claude-1", workspace_id: "ws-terra", state: "working", summary: "Editando resumePlanner.ts", updated_at: now },
  { terminal_id: "pty-codex", workspace_id: "ws-terra", state: "needs_input", summary: "Posso rodar npm test?", updated_at: now },
];
let mcpEnabled = true;
const mockFiles: Record<string, string> = {};
const mcpInfo = () => ({
  enabled: mcpEnabled,
  available: true,
  running: true,
  url: "http://127.0.0.1:52817/mcp",
  port: 52817,
  db_path: "/Users/me/Library/Application Support/com.terra-swarm.app/mcp.db",
  error: null,
});

function mcpUpdate(id: string, patch: McpTaskPatch): McpTask {
  const task = mcpTasks.find((candidate) => candidate.id === id);
  if (!task) throw new Error(`task ${id} not found in this workspace`);
  const at = Date.now();
  const events = task.events ?? (task.events = []);
  if (patch.status && patch.status !== task.status) {
    events.push({ actor: "user", kind: "status", body: `${task.status} → ${patch.status}`, created_at: at });
  }
  if (patch.assignee !== undefined && patch.assignee !== task.assignee) {
    events.push({ actor: "user", kind: "assigned", body: patch.assignee ?? "", created_at: at });
  }
  if (patch.note) events.push({ actor: "user", kind: "note", body: patch.note, created_at: at });
  Object.assign(task, Object.fromEntries(Object.entries(patch).filter(([key]) => key !== "note")), { updated_at: at });
  return task;
}

const ESC = "\u001b";
function snapshotTransfer(path: string, backupPath: string | null): WorkspaceSnapshotTransfer {
  const terminals = workspaces.flatMap((workspace) => workspace.terminals);
  return {
    version: 2,
    path,
    backupPath,
    workspaceCount: workspaces.length,
    groupCount: groups.length,
    terminalCount: terminals.length,
    suspendedTerminalCount: terminals.filter((terminal) => terminal.suspended).length,
  };
}

const gitStatus: WorkspaceGitStatus = {
  branch: "main",
  ahead: 1,
  behind: 0,
  staged: ["src/App.tsx"],
  modified: ["README.md", "src/styles/motion.css"],
  untracked: ["notes/todo.md"],
  conflicted: [],
};

const backlog: Record<string, string> = {
  "pty-claude-1": `${ESC}[2m> Refatore resumePlanner para aceitar grupos suspensos${ESC}[0m\r\n\r\n● Lendo src/lib/session/resumePlanner.ts\r\n● Lendo src/lib/session/resumeSelection.ts\r\n● Editando resumePlanner.ts  ${ESC}[32m+18${ESC}[0m ${ESC}[31m-6${ESC}[0m\r\n`,
  "pty-claude-2": `● Editando src/styles/motion.css\r\n● Editando src/components/shell/shell.css\r\n${ESC}[2m  12 arquivos verificados${ESC}[0m\r\n`,
  "pty-codex": `› vitest run src/components/workbench\r\n\r\n ${ESC}[32m✓${ESC}[0m layout.test.ts\r\n ${ESC}[32m✓${ESC}[0m projection.test.ts\r\n ${ESC}[2m◌${ESC}[0m workbench.test.tsx\r\n`,
  "pty-shell": "$ npm run tauri dev\r\n\r\nerror: port 1420 is already in use\r\n",
  "pty-kimi": "Revisando docs/install.md…\r\n",
  "pty-claude-docs": "● Gerando exemplos de atalhos\r\n",
};

export function installMockBackend(): void {
  // ?mock=resume: nothing is running, so every agent lands in the resume queue.
  const scenario = new URLSearchParams(window.location.search).get("mock");
  mockWindows("main");
  mockIPC((cmd, payload) => {
    const args = (payload ?? {}) as Record<string, unknown>;
    switch (cmd) {
      case "list_workspaces": return workspaces;
      case "list_groups": return groups;
      case "create_workspace": {
        const workspace: Workspace = { id: `ws-${Date.now()}`, name: String(args.name), cwd: String(args.cwd || "/Users/me/projects/new-project"), terminals: [] };
        workspaces.push(workspace);
        return workspace;
      }
      case "create_group": {
        const group: WorkspaceGroup = { id: `group-${Date.now()}`, name: String(args.name), collapsed: false, projectIds: [], parentGroupId: null, suspended: false };
        groups.push(group);
        return group;
      }
      case "export_workspace_snapshot": return snapshotTransfer(String(args.path), null);
      case "import_workspace_snapshot": return snapshotTransfer(String(args.path), "/Users/me/.terra-swarm/backups/workspaces.json");
      case "git_status": return gitStatus;
      case "detect_agents": return agents;
      case "running_terminals": return scenario === "resume" ? [] : workspaces.flatMap((ws) => ws.terminals.filter((t) => !t.suspended).map((t) => ({ id: t.id, seq: 1 })));
      case "terminal_backlog": {
        const data = backlog[String(args.id)] ?? "";
        return { data, total: data.length };
      }
      case "terminal_runtime_info":
        return { id: args.id, pid: 48213, cols: 132, rows: 38, running: true, reaped: false, generation: 1 };
      case "git_branch": return "main";
      case "store_saved_at": return Date.now() - 86_400_000;
      case "list_available_shells": return ["/bin/zsh", "/bin/bash"];
      case "list_system_fonts":
        return [
          ["Andale Mono", true], ["Arial", false], ["Avenir Next", false], ["Courier New", true], ["Fira Code", true],
          ["Georgia", false], ["Helvetica Neue", false], ["JetBrains Mono", true], ["Menlo", true], ["Monaco", true],
          ["PT Mono", true], ["SF Mono", true], ["Times New Roman", false], ["Verdana", false],
        ].map(([name, monospace]) => ({ name, monospace }));
      case "voice_list_models":
        return [
          { id: "base", display_name: "Base", size_label: "142 MB", description: "", downloaded: true, active: false },
          { id: "small", display_name: "Small", size_label: "466 MB", description: "", downloaded: true, active: true },
        ];
      case "voice_list_input_devices": return ["MacBook Pro Microphone"];
      case "voice_mic_available": return true;
      case "plugin:app|version": return "2.2.0";
      case "plugin:updater|check": return null;
      case "spawn_terminal": return { meta: { id: String(args.terminalId ?? `pty-${Date.now()}`), command: String(args.command ?? "claude"), width: null }, seq: 1 };
      case "worktree_status":
        return args.terminalId === "pty-claude-2"
          ? { branch: "terra/pty-claude-2", base: "main", path: "/tmp/wt/pty-claude-2", dirty: ["src/styles/motion.css", "src/components/shell/shell.css"], ahead: 1, behind: 0, exists: true }
          : null;
      case "worktree_remove": return undefined;
      case "list_workspace_files":
        return args.relativePath
          ? { path: String(args.relativePath), entries: [{ name: "main.ts", path: `${String(args.relativePath)}/main.ts`, kind: "file", size: 40 }], truncated: false, limit: 200 }
          : { path: "", entries: [{ name: "src", path: "src", kind: "directory", size: null }, { name: "README.md", path: "README.md", kind: "file", size: 120 }], truncated: false, limit: 200 };
      case "read_workspace_file":
        return { path: String(args.relativePath), content: mockFiles[String(args.relativePath)] ?? (String(args.relativePath).endsWith(".md") ? "# terra-swarm\n\nMission control for AI coding agents.\n\n## Getting started\n\n```sh\nnpm install\nnpm run tauri dev\n```\n" : `// ${String(args.relativePath)}\nexport const answer = 42;\n`), binary: false, size: 40, modified: 1 };
      case "write_workspace_file":
        mockFiles[String(args.relativePath)] = String(args.content);
        return { size: String(args.content).length, modified: 2 };
      case "agent_usage":
        return [{ terminal_id: "pty-claude-2", agent: "claude", input_tokens: 1260, output_tokens: 62_150, cache_read_tokens: 2_947_189, cache_write_tokens: 152_904, turns: 63, model: "claude-opus-5-5" }];
      case "probe_dev_servers": return (args.ports as number[]).filter((port) => port === 8000);
      case "worktree_diff":
        return {
          status: { branch: "terra/pty-claude-2", base: "main", path: "/tmp/wt/pty-claude-2", dirty: ["src/styles/motion.css"], ahead: 1, behind: 0, exists: true },
          files: [
            { path: "src/styles/motion.css", change: "modified", additions: 2, deletions: 1 },
            { path: "src/components/shell/shell.css", change: "untracked", additions: 3, deletions: 0 },
          ],
          patch: "diff --git a/src/styles/motion.css b/src/styles/motion.css\n--- a/src/styles/motion.css\n+++ b/src/styles/motion.css\n@@ -10,3 +10,4 @@\n .terra-anim-rise {\n-  animation: terra-rise 320ms;\n+  animation: terra-rise 240ms var(--terra-ease-out);\n+  will-change: transform;\n }\ndiff --git a/src/components/shell/shell.css b/src/components/shell/shell.css\nnew file mode 100644\n--- /dev/null\n+++ b/src/components/shell/shell.css\n@@ -0,0 +1,3 @@\n+.terra-shell {\n+  display: grid;\n+}\n",
          truncated: false,
        };
      case "worktree_commit":
      case "worktree_merge":
        return { branch: "terra/pty-claude-2", base: "main", path: "/tmp/wt/pty-claude-2", dirty: [], ahead: 1, behind: 0, exists: true };
      case "worktree_open_pr": return "https://github.com/example/terra-swarm/pull/42";
      case "mcp_server_info": return mcpInfo();
      case "mcp_set_enabled": mcpEnabled = Boolean(args.enabled); return mcpInfo();
      case "mcp_list_tasks": return mcpTasks.filter((task) => task.workspace_id === args.workspaceId);
      case "mcp_agent_statuses": return mcpStatuses.filter((status) => status.workspace_id === args.workspaceId);
      case "mcp_create_task": {
        const task = mockTask(nextTaskNumber++, String(args.title), {
          workspace_id: String(args.workspaceId),
          created_by: "user",
          created_at: Date.now(),
          updated_at: Date.now(),
          ...(args.priority ? { priority: args.priority as McpTask["priority"] } : {}),
        });
        mcpTasks.push(task);
        return task;
      }
      case "mcp_update_task": return mcpUpdate(String(args.id), args.patch as McpTaskPatch);
      case "mcp_delete_task": {
        const index = mcpTasks.findIndex((task) => task.id === args.id);
        if (index >= 0) mcpTasks.splice(index, 1);
        return undefined;
      }
      default: return undefined;
    }
  }, { shouldMockEvents: true });

  // Signals that arrive after the app has mounted.
  window.setTimeout(() => {
    void emit("terminal-title", { id: "pty-claude-1", workspace_id: "ws-terra", title: "✳ Refatorar planejador de retomada" });
    void emit("terminal-title", { id: "pty-claude-2", workspace_id: "ws-terra", title: "✳ Animações do Workbench" });
    void emit("terminal-title", { id: "pty-codex", workspace_id: "ws-terra", title: "Testes do layout" });
    void emit("terminal-context", { id: "pty-claude-1", workspace_id: "ws-terra", used: 64 });
    void emit("terminal-context", { id: "pty-claude-2", workspace_id: "ws-terra", used: 22 });
    void emit("terminal-context", { id: "pty-codex", workspace_id: "ws-terra", used: 31 });
    void emit("terminal-context", { id: "pty-kimi", workspace_id: "ws-docs", used: 88 });
    void emit("terminal-notification", { id: "pty-claude-1", workspace_id: "ws-terra", count: 1, messages: ["Posso rodar npm test?"] });
    void emit("terminal-exit", { id: "pty-shell", workspace_id: "ws-terra", code: 1, seq: 1 });
  }, 1200);

  // An agent claims a task a few seconds in, so the Tasks panel updates live.
  window.setTimeout(() => {
    const task = mcpTasks.find((candidate) => candidate.id === "T-4");
    if (task && !task.assignee) {
      Object.assign(task, { assignee: "pty-claude-2", status: "in_progress", updated_at: Date.now() });
      task.events?.push({ actor: "pty-claude-2", kind: "claimed", body: "", created_at: Date.now() });
      void emit("mcp-tasks-changed", { workspace_id: "ws-terra" });
    }
  }, 5000);
}
