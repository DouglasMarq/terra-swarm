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
import type { AgentInfo, Workspace, WorkspaceGroup } from "../types";

const workspaces: Workspace[] = [
  {
    id: "ws-terra",
    name: "terra-swarm",
    cwd: "~/Documents/projects/terra-swarm",
    terminals: [
      { id: "pty-claude-1", command: "claude", width: null },
      { id: "pty-claude-2", command: "claude", width: null },
      { id: "pty-codex", command: "codex", width: null },
      { id: "pty-shell", command: "zsh", width: null },
    ],
  },
  {
    id: "ws-docs",
    name: "site-docs",
    cwd: "~/Documents/projects/site-docs",
    terminals: [
      { id: "pty-kimi", command: "kimi", width: null },
      { id: "pty-claude-docs", command: "claude", width: null },
    ],
  },
  {
    id: "ws-cli",
    name: "cli-tools",
    cwd: "~/Documents/projects/cli-tools",
    terminals: [{ id: "pty-opencode", command: "opencode", width: null, suspended: true }],
  },
];

const groups: WorkspaceGroup[] = [];

const agents: AgentInfo[] = [
  { id: "claude", label: "Claude Code", available: true },
  { id: "codex", label: "Codex", available: true },
  { id: "opencode", label: "OpenCode", available: true },
  { id: "kimi", label: "Kimi", available: true },
  { id: "gemini", label: "Gemini", available: false },
];

const ESC = "\u001b";
const backlog: Record<string, string> = {
  "pty-claude-1": `${ESC}[2m> Refatore resumePlanner para aceitar grupos suspensos${ESC}[0m\r\n\r\n● Lendo src/lib/session/resumePlanner.ts\r\n● Lendo src/lib/session/resumeSelection.ts\r\n● Editando resumePlanner.ts  ${ESC}[32m+18${ESC}[0m ${ESC}[31m-6${ESC}[0m\r\n`,
  "pty-claude-2": `● Editando src/styles/motion.css\r\n● Editando src/components/shell/shell.css\r\n${ESC}[2m  12 arquivos verificados${ESC}[0m\r\n`,
  "pty-codex": `› vitest run src/components/workbench\r\n\r\n ${ESC}[32m✓${ESC}[0m layout.test.ts\r\n ${ESC}[32m✓${ESC}[0m projection.test.ts\r\n ${ESC}[2m◌${ESC}[0m workbench.test.tsx\r\n`,
  "pty-shell": "$ npm run tauri dev\r\n\r\nerror: port 1420 is already in use\r\n",
  "pty-kimi": "Revisando docs/install.md…\r\n",
  "pty-claude-docs": "● Gerando exemplos de atalhos\r\n",
};

export function installMockBackend(): void {
  mockWindows("main");
  mockIPC((cmd, payload) => {
    const args = (payload ?? {}) as Record<string, unknown>;
    switch (cmd) {
      case "list_workspaces": return workspaces;
      case "list_groups": return groups;
      case "detect_agents": return agents;
      case "running_terminals": return workspaces.flatMap((ws) => ws.terminals.filter((t) => !t.suspended).map((t) => ({ id: t.id, seq: 1 })));
      case "terminal_backlog": {
        const data = backlog[String(args.id)] ?? "";
        return { data, total: data.length };
      }
      case "terminal_runtime_info":
        return { id: args.id, pid: 48213, cols: 132, rows: 38, running: true, reaped: false, generation: 1 };
      case "git_branch": return "main";
      case "store_saved_at": return Date.now() - 86_400_000;
      case "list_available_shells": return ["/bin/zsh", "/bin/bash"];
      case "voice_list_models":
        return [
          { id: "base", display_name: "Base", size_label: "142 MB", description: "", downloaded: true, active: false },
          { id: "small", display_name: "Small", size_label: "466 MB", description: "", downloaded: true, active: true },
        ];
      case "voice_list_input_devices": return ["MacBook Pro Microphone"];
      case "voice_mic_available": return true;
      case "plugin:app|version": return "2.0.3";
      case "plugin:updater|check": return null;
      case "spawn_terminal": return { meta: { id: String(args.id ?? `pty-${Date.now()}`), command: String(args.command ?? "claude"), width: null }, seq: 1 };
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
}
