import { deriveSnapshot } from "../domain/workspaceProjection";
import { uniqueStrings } from "../lib/collections/uniqueStrings";
import { workspaceApi } from "../lib/tauri/workspace";
import type { Group, Workspace, WorkspaceSnapshotV2 } from "../domain/workspace.model";

export interface OrchestrationProjection {
  snapshot: WorkspaceSnapshotV2 | null;
  groups: Group[];
  containerVisibility: Record<string, boolean>;
  detachedTerminalIds: string[];
  isHydrated: boolean;
}

export interface PersistenceEngineDeps {
  read: () => OrchestrationProjection;
  apply: (projection: OrchestrationProjection) => void;
  reportError: (operation: string, error: unknown) => void;
}

export interface PersistenceEngine {
  persistCommand: (command: Promise<void>, operation: string, targets: readonly string[]) => void;
  markNewerProjection: () => void;
}

type PersistenceTransaction = {
  version: number;
  targets: readonly string[];
  before: OrchestrationProjection;
};

function backendContainerVisibility(workspaces: readonly Workspace[]): Record<string, boolean> {
  const backendVisibility: Record<string, boolean> = {};
  for (const workspace of workspaces) {
    for (const container of workspace.containers ?? []) {
      backendVisibility[container.id] =
        container.isVisible !== false && container.isClosed !== true;
    }
  }
  return backendVisibility;
}

function snapshotContainerVisibility(snapshot: WorkspaceSnapshotV2): Record<string, boolean> {
  const containerVisibility: Record<string, boolean> = {};
  for (const container of snapshot.containers) {
    containerVisibility[container.id] = container.isVisible;
  }
  return containerVisibility;
}

function liveDetachedTerminalIds(workspaces: readonly Workspace[], detachedTerminalIds: readonly string[]): string[] {
  const terminalIds = new Set(
    workspaces.flatMap((workspace) =>
      workspace.terminals.map((terminal) => terminal.id),
    ),
  );
  return detachedTerminalIds.filter((id) => terminalIds.has(id));
}

export function createPersistenceEngine({ read, apply, reportError }: PersistenceEngineDeps): PersistenceEngine {
  let persistenceVersion = 0;
  const targetVersions = new Map<string, number>();
  let reconciliationChain: Promise<void> = Promise.resolve();

  const beginPersistence = (targets: readonly string[]): PersistenceTransaction => {
    const normalizedTargets = uniqueStrings(targets);
    const version = ++persistenceVersion;
    normalizedTargets.forEach((target) => targetVersions.set(target, version));
    const state = read();
    return {
      version,
      targets: normalizedTargets,
      before: {
        snapshot: state.snapshot,
        groups: [...state.groups],
        containerVisibility: { ...state.containerVisibility },
        detachedTerminalIds: [...state.detachedTerminalIds],
        isHydrated: state.isHydrated,
      },
    };
  };

  const markNewerProjection = (): void => {
    persistenceVersion += 1;
  };

  const isCurrentPersistence = (transaction: PersistenceTransaction): boolean =>
    transaction.version === persistenceVersion &&
    transaction.targets.every(
      (target) => targetVersions.get(target) === transaction.version,
    );

  const loadBackendProjection = async (transaction: PersistenceTransaction): Promise<OrchestrationProjection | null> => {
    const workspaces = await workspaceApi.listWorkspaces();
    const loadedGroups = await workspaceApi.listGroups();
    if (!Array.isArray(workspaces) || !isCurrentPersistence(transaction)) return null;
    const sourceGroups = Array.isArray(loadedGroups) ? loadedGroups : [];
    const derived = deriveSnapshot({ workspaces, groups: sourceGroups }, backendContainerVisibility(workspaces), null);
    if (!isCurrentPersistence(transaction)) return null;
    return {
      snapshot: derived.snapshot,
      groups: derived.groups,
      containerVisibility: snapshotContainerVisibility(derived.snapshot),
      detachedTerminalIds: liveDetachedTerminalIds(workspaces, read().detachedTerminalIds),
      isHydrated: true,
    };
  };

  const reconcilePersistence = (transaction: PersistenceTransaction, operation: string): void => {
    if (isCurrentPersistence(transaction)) apply(transaction.before);
    const run = async (): Promise<void> => {
      if (!isCurrentPersistence(transaction)) return;
      try {
        const projection = await loadBackendProjection(transaction);
        if (projection) apply(projection);
      } catch (reconciliationError) {
        if (!isCurrentPersistence(transaction)) return;
        apply(transaction.before);
        reportError(`${operation} reconciliation`, reconciliationError);
      }
    };

    const next = reconciliationChain.then(run, run);
    reconciliationChain = next.catch(() => undefined);
  };

  const persistCommand = (command: Promise<void>, operation: string, targets: readonly string[]): void => {
    const transaction = beginPersistence(targets);
    void command.catch((error) => {
      reportError(operation, error);
      reconcilePersistence(transaction, operation);
    });
  };

  return { persistCommand, markNewerProjection };
}
