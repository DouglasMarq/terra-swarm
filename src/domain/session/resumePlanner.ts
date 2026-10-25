export type ResumeCandidate = {
  terminalId?: string;
  id?: string;
  projectId?: string;
  projectName?: string;
  workspaceId?: string;
  workspaceName?: string;
  wsId?: string;
  wsName?: string;
  groupId?: string;
  groupName?: string;
  cwd?: string;
  command?: string;
  agentId?: string;
  resumeCommand?: string;
  [key: string]: unknown;
};

export type NormalizedResumeCandidate = ResumeCandidate & {
  key: string;
  terminalId: string;
  projectId: string;
  projectName: string;
  groupId: string;
  groupName: string;
};

export type ResumeGroupPlan = {
  projectId: string;
  projectName: string;
  groupId: string;
  groupName: string;
  items: readonly NormalizedResumeCandidate[];
};

export type ResumeProjectPlan = {
  projectId: string;
  projectName: string;
  groups: readonly ResumeGroupPlan[];
};

export type ResumeDuplicate = {
  key: string;
  kept: NormalizedResumeCandidate;
  skipped: ResumeCandidate;
};

export type ResumePlan = {
  projects: readonly ResumeProjectPlan[];
  groups: readonly ResumeGroupPlan[];
  items: readonly NormalizedResumeCandidate[];
  duplicates: readonly ResumeDuplicate[];
};

export type ResumePlannerOptions = {
  keyOf?: (candidate: ResumeCandidate) => string | null | undefined;
  defaultProjectId?: string;
  defaultProjectName?: string;
  defaultGroupId?: string;
  defaultGroupName?: string;
};

type MutableResumeGroup = {
  projectId: string;
  projectName: string;
  groupId: string;
  groupName: string;
  items: NormalizedResumeCandidate[];
};

type MutableResumeProject = {
  projectId: string;
  projectName: string;
  groups: MutableResumeGroup[];
};

function text(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const normalized = value.trim();
  return normalized.length > 0 ? normalized : undefined;
}

function fallbackId(value: string, fallback: string): string {
  return text(value) ?? fallback;
}

export function resumeCandidateKey(candidate: ResumeCandidate): string {
  const explicit = text(candidate.terminalId) ?? text(candidate.id);
  if (explicit) return `terminal:${explicit}`;
  return [
    text(candidate.projectId) ??
      text(candidate.workspaceId) ??
      text(candidate.wsId) ??
      text(candidate.projectName) ??
      text(candidate.workspaceName) ??
      text(candidate.wsName) ??
      "default-project",
    text(candidate.groupId) ?? text(candidate.groupName) ?? "default-group",
    text(candidate.cwd) ?? "",
    text(candidate.agentId) ?? "",
    text(candidate.command) ?? "",
    text(candidate.resumeCommand) ?? "",
  ].join("\u001f");
}

function normalizeResumeCandidate(
  candidate: ResumeCandidate,
  options: ResumePlannerOptions = {},
): NormalizedResumeCandidate {
  const projectId = fallbackId(
    candidate.projectId ?? candidate.workspaceId ?? candidate.wsId ?? "",
    options.defaultProjectId ?? "default-project",
  );
  const projectName = fallbackId(
    candidate.projectName ?? candidate.workspaceName ?? candidate.wsName ?? "",
    options.defaultProjectName ?? projectId,
  );
  const groupId = fallbackId(
    candidate.groupId ?? "",
    options.defaultGroupId ?? "default-group",
  );
  const groupName = fallbackId(
    candidate.groupName ?? "",
    options.defaultGroupName ?? groupId,
  );
  const terminalId = fallbackId(
    candidate.terminalId ?? candidate.id ?? "",
    resumeCandidateKey(candidate),
  );
  const customKey = options.keyOf?.(candidate);
  return {
    ...candidate,
    key: text(customKey) ?? resumeCandidateKey(candidate),
    terminalId,
    projectId,
    projectName,
    groupId,
    groupName,
  };
}

export function planResume(
  candidates: readonly ResumeCandidate[],
  options: ResumePlannerOptions = {},
): ResumePlan {
  const projects: MutableResumeProject[] = [];
  const groups: MutableResumeGroup[] = [];
  const items: NormalizedResumeCandidate[] = [];
  const duplicates: ResumeDuplicate[] = [];
  const seen = new Map<string, NormalizedResumeCandidate>();
  const projectsById = new Map<string, MutableResumeProject>();
  const groupsByKey = new Map<string, MutableResumeGroup>();

  for (const candidate of candidates) {
    const normalized = normalizeResumeCandidate(candidate, options);
    const kept = seen.get(normalized.key);
    if (kept) {
      duplicates.push({ key: normalized.key, kept, skipped: candidate });
      continue;
    }
    seen.set(normalized.key, normalized);
    items.push(normalized);

    let project = projectsById.get(normalized.projectId);
    if (!project) {
      const mutableGroups: MutableResumeGroup[] = [];
      project = {
        projectId: normalized.projectId,
        projectName: normalized.projectName,
        groups: mutableGroups,
      };
      projectsById.set(normalized.projectId, project);
      projects.push(project);
    }

    const groupKey = `${normalized.projectId}\u001f${normalized.groupId}`;
    let group = groupsByKey.get(groupKey);
    if (!group) {
      const mutableItems: NormalizedResumeCandidate[] = [];
      group = {
        projectId: normalized.projectId,
        projectName: normalized.projectName,
        groupId: normalized.groupId,
        groupName: normalized.groupName,
        items: mutableItems,
      };
      groupsByKey.set(groupKey, group);
      project.groups.push(group);
      groups.push(group);
    }
    group.items.push(normalized);
  }

  const stableGroups: ResumeGroupPlan[] = groups.map((group) => ({
    ...group,
    items: [...group.items],
  }));
  const stableGroupsByKey = new Map(
    stableGroups.map((group) => [`${group.projectId}\u001f${group.groupId}`, group]),
  );
  const stableProjects: ResumeProjectPlan[] = projects.map((project) => ({
    ...project,
    groups: project.groups.map(
      (group) => stableGroupsByKey.get(`${group.projectId}\u001f${group.groupId}`) ?? group,
    ),
  }));

  return {
    projects: stableProjects,
    groups: stableGroups,
    items: [...items],
    duplicates,
  };
}

