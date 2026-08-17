import { isAbsolute } from "node:path";
import { stringify } from "yaml";
import type { ForgeBootstrapConfig } from "../../kernel/src/bootstrap-config.js";
import {
  applyManagedBootstrapFiles,
  type BootstrapApplyResult,
  type BootstrapEntry,
  type BootstrapFilePlan,
} from "../../adapters/src/bootstrap-files.js";

export type BootstrapPlanInput = Readonly<{
  repositoryRoot: string;
  vaultRoot: string;
  commandCenterName: string;
  projectName: string;
  managedFiles: Readonly<Record<string, string>>;
}>;

export type BootstrapPlan = BootstrapFilePlan;

export function planBootstrap(input: BootstrapPlanInput): BootstrapPlan {
  if (!isAbsolute(input.repositoryRoot) || !isAbsolute(input.vaultRoot))
    throw new Error("Bootstrap roots must be absolute");
  const center = safeSegment(input.commandCenterName);
  const engineering = `${center}/AI Engineering`;
  const directories = [
    ".forge/state",
    ".forge/artifacts",
    ".codex/agents",
    ".codex/agents/contracts",
    "docs/ai",
  ].map((path): BootstrapEntry => ({
    root: "repository",
    path,
    kind: "directory",
  }));
  const commandDirectories = [
    "Daily Plans",
    "Task State",
    "Parked Blockers",
    "Templates",
    "Daily PM",
    "End of Day Reports",
    "Guides",
  ].map((path): BootstrapEntry => ({
    root: "vault",
    path: `${engineering}/${path}`,
    kind: "directory",
  }));
  const managed = Object.entries(input.managedFiles)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([path, content]): BootstrapEntry => {
      if (
        path === ".git" ||
        path.startsWith(".git/") ||
        path === ".forge/state" ||
        path.startsWith(".forge/state/") ||
        path === ".forge/artifacts" ||
        path.startsWith(".forge/artifacts/")
      )
        throw new Error(
          `Managed bootstrap files cannot target protected state: ${path}`,
        );
      return { root: "repository", path, kind: "managed-file", content };
    });
  const contentEntries: readonly BootstrapEntry[] = [
    {
      root: "repository",
      path: "AGENTS.md",
      kind: "composed-markdown",
      content:
        "## Meraki Forge\n\nForge authority is defined by `.forge/ownership.yml`. Unknown paths are default deny. Forge stops at a verified PR for human review; it never auto-merges or deploys production.",
    },
    {
      root: "vault",
      path: `${engineering}/Tasks.md`,
      kind: "composed-markdown",
      content: `# ${input.projectName} Tasks\n\nHUMAN INTENT + HUMAN VISIBILITY + HUMAN DECISIONS. Machine execution truth remains in the repository's .forge/state directory.`,
    },
    {
      root: "vault",
      path: `${engineering}/_orchestrator.md`,
      kind: "composed-markdown",
      content: `# ${input.projectName} Orchestrator\n\nHuman-visible coordination only. This note is not canonical execution state.`,
    },
    {
      root: "vault",
      path: `${engineering}/Templates/Standard Task.md`,
      kind: "composed-markdown",
      content: standardTask("<Task title>", "AUTO"),
    },
    {
      root: "vault",
      path: `${engineering}/Templates/Hotfix Task.md`,
      kind: "composed-markdown",
      content: standardTask("<Hotfix title>", "HOTFIX"),
    },
    {
      root: "vault",
      path: `${engineering}/Templates/Meeting-Derived Task.md`,
      kind: "composed-markdown",
      content: standardTask("<Task from meeting>", "AUTO"),
    },
    {
      root: "vault",
      path: `${engineering}/Daily PM/DAILY_PM.md`,
      kind: "managed-file",
      content:
        "# Daily PM Contract\n\nWeekdays at 08:00 local project time. Review human intent and prepare plans; do not merge or deploy.\n",
    },
    {
      root: "vault",
      path: `${engineering}/Guides/ENGINEERING_COORDINATOR.md`,
      kind: "managed-file",
      content:
        "# Engineering Coordinator Contract\n\nPeriodically resume authorized local execution using durable leases and stop at verified PR review.\n",
    },
    {
      root: "vault",
      path: `${engineering}/End of Day Reports/END_OF_DAY_REPORT.md`,
      kind: "managed-file",
      content:
        "# End of Day Report Contract\n\nAt 19:15 local project time, report durable task state without inferring merge or deployment.\n",
    },
    ...[
      [
        "operating-contract.md",
        "# Operating Contract\n\nForge follows the repository constitution, default-deny ownership, and stops at a verified pull request for human review.",
      ],
      [
        "architecture.md",
        "# Architecture\n\nRepository evidence is authoritative. Record project-specific architecture here.",
      ],
      [
        "task-router.md",
        "# Task Router\n\nCross-domain work uses structured dependency requests; grants never expand implicitly.",
      ],
      [
        "module-ownership-map.md",
        "# Module Ownership Map\n\nUnowned or ambiguous paths remain default denied until explicitly assigned.",
      ],
      [
        "planning.md",
        "# Planning\n\nPlans are human-visible artifacts. Canonical execution state remains under `.forge/state`.",
      ],
      [
        "testing-strategy.md",
        "# Testing Strategy\n\nRecord project-native unit, integration, end-to-end, accessibility, and security validation here.",
      ],
      [
        "risk-register.md",
        "# Risk Register\n\nRecord known project risks and mitigations without weakening Forge safety floors.",
      ],
      [
        "pr-evidence.md",
        "# Pull Request Evidence\n\nEvidence is candidate-bound and digest-verified before delivery.",
      ],
    ].map(([name, content]): BootstrapEntry => ({
      root: "repository",
      path: `docs/ai/${name}`,
      kind: "managed-file",
      content: `${content}\n`,
    })),
  ];
  return Object.freeze({
    repositoryRoot: input.repositoryRoot,
    vaultRoot: input.vaultRoot,
    entries: Object.freeze([
      ...directories,
      ...commandDirectories,
      ...managed,
      ...contentEntries,
    ]),
  });
}

export async function applyBootstrapPlan(
  plan: BootstrapPlan,
  options: Readonly<{ dryRun?: boolean }> = {},
): Promise<BootstrapApplyResult> {
  return applyManagedBootstrapFiles(plan, options.dryRun === true);
}

export function renderBootstrapManagedFiles(
  config: ForgeBootstrapConfig,
): Readonly<Record<string, string>> {
  return Object.freeze({
    ".forge/config.yml": stringify(config),
    ".forge/project.yml": stringify({
      schema_version: "1",
      project: config.project,
      obsidian: config.obsidian,
    }),
    ".forge/ownership.yml": stringify({
      schema_version: "1",
      default_effect: "deny",
      rules: [],
      ambiguities: ["Initial ownership requires explicit review"],
    }),
    ".forge/providers.yml": stringify({
      schema_version: "1",
      github: {
        enabled: config.delivery.create_pr,
        remote_mutation_during_bootstrap: false,
      },
    }),
    ".forge/evidence.yml": stringify({
      schema_version: "1",
      ...config.evidence,
    }),
    ".forge/scheduler.yml": stringify({
      schema_version: "1",
      provider: "human-setup-required",
      contracts_only: true,
    }),
    ".forge/capabilities.yml": stringify({
      schema_version: "1",
      providers: [],
    }),
  });
}

function safeSegment(value: string): string {
  const trimmed = value.trim();
  if (
    !trimmed ||
    trimmed === "." ||
    trimmed === ".." ||
    /[\\/\0]/u.test(trimmed)
  )
    throw new Error("Command Center name must be one safe path segment");
  return trimmed;
}

function standardTask(title: string, mode: string): string {
  return `* [ ] ${title}\n\n  * Mode: ${mode}\n\n  * Priority: P2\n\n  * Outcome: <Observable desired result>\n\n  * Acceptance:\n\n    1. <Criterion>\n    2. <Criterion>\n\n  * Sources:\n\n    * <optional link/image/note/file>\n\n  * Constraints:\n\n    * <things that must not change>\n\n  * Known Dependencies: NONE\n\n  * Deadline: NONE\n\n  * Notes: NONE`;
}
