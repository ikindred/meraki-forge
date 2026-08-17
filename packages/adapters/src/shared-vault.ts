import { isAbsolute } from "node:path";
import {
  applyManagedBootstrapFiles,
  type BootstrapApplyResult,
  type BootstrapEntry,
  type BootstrapFilePlan,
} from "./bootstrap-files.js";

export type SharedVaultProject = Readonly<{
  projectId: string;
  displayName: string;
  purpose: string;
  repositoryPath: string;
  stackSummary: string;
  graphifyStatus: string;
  forgeStatus: string;
}>;

export type SharedVaultProjectPlan = BootstrapFilePlan &
  Readonly<{ projectPath: string }>;

/** Materialize one project's human-memory area in the single shared vault. */
export function planSharedVaultProject(
  repositoryRoot: string,
  vaultRoot: string,
  project: SharedVaultProject,
): SharedVaultProjectPlan {
  if (!isAbsolute(repositoryRoot) || !isAbsolute(vaultRoot))
    throw new Error("Shared vault roots must be absolute");
  const folder = safeSegment(project.displayName);
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/u.test(project.projectId))
    throw new Error("Project ID is unsafe");
  if (!isAbsolute(project.repositoryPath))
    throw new Error("Project repository path must be absolute");
  const projectPath = `Projects/${folder}`;
  const entries: readonly BootstrapEntry[] = [
    ...["Projects", "Cross Project", "Boss Reports"].map(
      (path): BootstrapEntry => ({
        root: "vault",
        path,
        kind: "directory",
      }),
    ),
    {
      root: "vault",
      path: "Dashboard.md",
      kind: "composed-markdown",
      content:
        "# Meraki Forge Dashboard\n\nMaster human control and memory entry point. Project code and Graphify indexes remain in their repositories.",
    },
    ...["Decisions", "Notes", "Reports"].map((name): BootstrapEntry => ({
      root: "vault",
      path: `${projectPath}/${name}`,
      kind: "directory",
    })),
    {
      root: "vault",
      path: `${projectPath}/Project.md`,
      kind: "composed-markdown",
      content: projectMarkdown(project),
    },
    {
      root: "vault",
      path: `${projectPath}/Tasks.md`,
      kind: "composed-markdown",
      content: `# ${project.displayName} Tasks\n\nHuman-visible task context only. Canonical execution state remains in \`${project.repositoryPath}/.forge/state\`.`,
    },
  ];
  return Object.freeze({ repositoryRoot, vaultRoot, projectPath, entries });
}

export function applySharedVaultProject(
  plan: SharedVaultProjectPlan,
  dryRun = false,
): Promise<BootstrapApplyResult> {
  return applyManagedBootstrapFiles(plan, dryRun);
}

function projectMarkdown(project: SharedVaultProject): string {
  return `# ${project.displayName}\n\n${project.purpose}\n\n- Project ID: \`${project.projectId}\`\n- Repository: \`${project.repositoryPath}\`\n- Stack: ${project.stackSummary}\n- Graphify: ${project.graphifyStatus}\n- Forge: ${project.forgeStatus}\n\n## Links\n\n- [[Tasks]]\n- [[Decisions]]\n- [[Notes]]\n- [[Reports]]\n\nArchitecture remains in the live repository; this note is a concise human-memory entry point.`;
}

function safeSegment(value: string): string {
  const trimmed = value.trim();
  if (
    !trimmed ||
    trimmed === "." ||
    trimmed === ".." ||
    /[\\/\0]/u.test(trimmed)
  )
    throw new Error("Obsidian project folder must be one safe path segment");
  return trimmed;
}
