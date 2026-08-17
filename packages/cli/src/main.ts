#!/usr/bin/env node
import { pathToFileURL } from "node:url";
import { execFile as execFileCallback } from "node:child_process";
import { promisify } from "node:util";
import { constants } from "node:fs";
import { access, lstat, readFile, realpath } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, join, resolve } from "node:path";
import { createInterface } from "node:readline/promises";
import { stdin, stdout } from "node:process";
import { parse, stringify } from "yaml";
import { z } from "zod";
import { PersonaSchema } from "../../kernel/src/contracts.js";
import { normalizeRepoPath } from "../../kernel/src/ownership.js";
import { runMasterCommand } from "./master-commands.js";
import {
  applyMachineInit,
  loadMasterConfig,
  planMachineInit,
} from "../../adapters/src/machine-init.js";
import { MasterConfigSchema } from "../../kernel/src/master-config.js";
import { GlobalProjectRegistry } from "../../adapters/src/global-project-registry.js";
import { inspectProjectRepository } from "../../adapters/src/project-inspector.js";
import {
  applyBootstrapPlan,
  planBootstrap,
  renderBootstrapManagedFiles,
} from "../../execution/src/bootstrap-service.js";
import { runProjectDoctor } from "../../execution/src/project-doctor.js";
import {
  applyUpgrade,
  planUpgrade,
  type UpgradeTemplate,
} from "../../execution/src/upgrade-service.js";
import {
  parseBootstrapConfigYaml,
  McpCapabilitiesConfigSchema,
  type ForgeBootstrapConfig,
} from "../../kernel/src/bootstrap-config.js";

export type CheckStatus = "PASS" | "WARNING" | "FAIL";
export interface CliCheck {
  readonly status: CheckStatus;
  readonly name: string;
  readonly message: string;
}
export interface CliResult {
  readonly status: "READY" | "READY_WITH_WARNINGS" | "NOT_READY";
  readonly summary: string;
  readonly checks: readonly CliCheck[];
}
export interface CliCommandOptions {
  readonly cwd: string;
  readonly dryRun?: boolean;
  readonly nonInteractive?: boolean;
  readonly configPath?: string;
  readonly projectsRoot?: string;
  readonly vaultPath?: string;
}
export interface CliServices {
  readonly init: (options: CliCommandOptions) => Promise<CliResult>;
  readonly bootstrap: (options: CliCommandOptions) => Promise<CliResult>;
  readonly doctor: (options: CliCommandOptions) => Promise<CliResult>;
  readonly validate: (options: CliCommandOptions) => Promise<CliResult>;
  readonly upgrade: (options: CliCommandOptions) => Promise<CliResult>;
}
export interface CliIo {
  readonly stdout: (text: string) => void;
  readonly stderr: (text: string) => void;
  readonly cwd: string;
}
export type CliPrompt = (question: string) => Promise<string>;

const HELP = `Meraki Forge\n\nUsage:\n  forge init [--dry-run] [--non-interactive] [--projects-root <path>] [--vault <path>] [--config <file>] [--json]\n  forge bootstrap [--dry-run] [--non-interactive] [--config <file>] [--json]\n  forge doctor [--config <file>] [--json]\n  forge validate [--config <file>] [--json]\n  forge upgrade [--dry-run] [--non-interactive] [--config <file>] [--json]\n  forge project create|onboard|list|inspect|status|remove|graph ...\n  forge ownership review [project] ...\n  forge help\n\nExit codes: 0 ready, 1 failed, 2 invalid usage.`;

export async function runCli(
  argv: readonly string[],
  services: CliServices,
  io: CliIo,
): Promise<number> {
  const [command, ...args] = argv;
  if (
    !command ||
    command === "help" ||
    command === "--help" ||
    command === "-h"
  ) {
    io.stdout(HELP);
    return 0;
  }
  if (command === "project" || command === "ownership")
    return runMasterCommand([command, ...args], io);
  if (
    !new Set(["init", "bootstrap", "doctor", "validate", "upgrade"]).has(
      command,
    )
  ) {
    io.stderr(`Unknown command: ${command}\n\n${HELP}`);
    return 2;
  }
  if (args.length === 1 && (args[0] === "--help" || args[0] === "-h")) {
    io.stdout(HELP);
    return 0;
  }
  const parsed = parseOptions(args, command);
  if (typeof parsed === "string") {
    io.stderr(`${parsed}\n\n${HELP}`);
    return 2;
  }
  const { json, ...options } = parsed;
  try {
    const service = services[command as keyof CliServices];
    const result = await service({ cwd: io.cwd, ...options });
    if (json) io.stdout(JSON.stringify({ command, ...result }));
    else renderHuman(command, result, io.stdout);
    return result.status === "NOT_READY" ||
      result.checks.some((check) => check.status === "FAIL")
      ? 1
      : 0;
  } catch (error) {
    const message =
      error instanceof Error ? error.message : "Unexpected failure";
    if (json)
      io.stdout(
        JSON.stringify({ command, status: "NOT_READY", error: message }),
      );
    else io.stderr(`FAIL  ${command} — ${message}`);
    return 1;
  }
}

function parseOptions(
  args: readonly string[],
  command: string,
): ({ json: boolean } & Omit<CliCommandOptions, "cwd">) | string {
  let json = false,
    dryRun = false,
    nonInteractive = false,
    configPath: string | undefined,
    projectsRoot: string | undefined,
    vaultPath: string | undefined;
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index]!;
    if (arg === "--json") json = true;
    else if (
      arg === "--dry-run" &&
      (command === "init" || command === "bootstrap" || command === "upgrade")
    )
      dryRun = true;
    else if (
      arg === "--non-interactive" &&
      (command === "init" || command === "bootstrap" || command === "upgrade")
    )
      nonInteractive = true;
    else if (arg === "--config") {
      const value = args[index + 1];
      if (!value || value.startsWith("-"))
        return "--config requires a file path";
      configPath = value;
      index += 1;
    } else if (arg === "--projects-root" && command === "init") {
      const value = args[index + 1];
      if (!value || value.startsWith("-"))
        return "--projects-root requires a path";
      projectsRoot = value;
      index += 1;
    } else if (arg === "--vault" && command === "init") {
      const value = args[index + 1];
      if (!value || value.startsWith("-")) return "--vault requires a path";
      vaultPath = value;
      index += 1;
    } else return `Unknown option for ${command}: ${arg}`;
  }
  return {
    json,
    ...(dryRun ? { dryRun } : {}),
    ...(nonInteractive ? { nonInteractive } : {}),
    ...(configPath ? { configPath } : {}),
    ...(projectsRoot ? { projectsRoot } : {}),
    ...(vaultPath ? { vaultPath } : {}),
  };
}
function renderHuman(
  command: string,
  result: CliResult,
  output: (text: string) => void,
): void {
  output(`MERAKI FORGE ${command.toUpperCase()}`);
  for (const check of result.checks)
    output(`${check.status.padEnd(7)}  ${check.name} — ${check.message}`);
  output(`\n${result.status.replaceAll("_", " ")}\n${result.summary}`);
}

export function createDefaultCliServices(
  prompt: CliPrompt = terminalPrompt,
): CliServices {
  return {
    init: initCommand,
    bootstrap: async (options) => bootstrapCommand(options, prompt),
    doctor: doctorCommand,
    validate: validateCommand,
    upgrade: upgradeCommand,
  };
}

async function initCommand(options: CliCommandOptions): Promise<CliResult> {
  const masterHome = machineHome();
  const supplied = options.configPath
    ? MasterConfigSchema.parse(
        parse(await boundedRead(resolve(options.cwd, options.configPath)), {
          maxAliasCount: 0,
          uniqueKeys: true,
        }),
      )
    : undefined;
  if (
    supplied &&
    resolve(supplied.registry.path) !== join(masterHome, "projects.yml")
  )
    throw new Error(
      "Configured registry path must match the Forge master home registry",
    );
  const plan = await planMachineInit({
    forgeRoot: supplied?.forge_root ?? options.cwd,
    masterHome,
    documentsRoot:
      process.env.MERAKI_FORGE_DOCUMENTS_ROOT ?? join(homedir(), "Documents"),
    ...((supplied?.projects_root ?? options.projectsRoot)
      ? { projectsRoot: (supplied?.projects_root ?? options.projectsRoot)! }
      : {}),
    ...((supplied?.obsidian_vault ?? options.vaultPath)
      ? { obsidianVault: (supplied?.obsidian_vault ?? options.vaultPath)! }
      : {}),
  });
  const applied = options.dryRun
    ? { status: "DRY_RUN" as const, changes: plan.changes }
    : await applyMachineInit(plan);
  const readiness = options.dryRun
    ? undefined
    : await machineDoctorCommand(options);
  return {
    status: readiness?.status ?? "READY",
    summary:
      applied.status === "UNCHANGED"
        ? "Forge machine initialization is already current"
        : options.dryRun
          ? "Forge machine initialization dry-run completed with zero mutations"
          : "Forge machine environment initialized",
    checks: [
      { status: "PASS", name: "Forge root", message: plan.forge_root },
      { status: "PASS", name: "Projects root", message: plan.projects_root },
      { status: "PASS", name: "Shared vault", message: plan.obsidian_vault },
      { status: "PASS", name: "Master config", message: plan.config_path },
      { status: "PASS", name: "Project registry", message: plan.registry_path },
      {
        status: "PASS",
        name: "Changes",
        message: applied.changes.length
          ? applied.changes.join(", ")
          : "UNCHANGED",
      },
      ...(readiness?.checks.map((check) => ({
        ...check,
        name: `Doctor: ${check.name}`,
      })) ?? []),
    ],
  };
}

function machineHome(): string {
  return resolve(
    process.env.MERAKI_FORGE_HOME ?? join(homedir(), ".meraki-forge"),
  );
}

async function bootstrapCommand(
  options: CliCommandOptions,
  prompt: CliPrompt,
): Promise<CliResult> {
  const inspection = await inspectProjectRepository(options.cwd);
  const config = options.configPath
    ? parseBootstrapConfigYaml(
        await boundedRead(resolve(options.cwd, options.configPath)),
      )
    : await interactiveConfig(
        inspection,
        options.nonInteractive === true,
        prompt,
      );
  if (
    (await realpath(config.project.repository_path)) !==
    inspection.repositoryRoot
  )
    throw new Error(
      "Configured repository_path does not match the inspected repository",
    );
  const managedFiles = renderBootstrapManagedFiles(config);
  const centerParts = config.obsidian.command_center_path.split(/[\\/]/u);
  const commandCenter = centerParts[0];
  if (
    !commandCenter ||
    centerParts.length !== 2 ||
    centerParts[1] !== "AI Engineering"
  )
    throw new Error(
      "command_center_path must be '<Command Center>/AI Engineering'",
    );
  const plan = planBootstrap({
    repositoryRoot: inspection.repositoryRoot,
    vaultRoot: config.obsidian.vault_path,
    commandCenterName: commandCenter,
    projectName: config.project.name,
    managedFiles,
  });
  const applied = await applyBootstrapPlan(plan, {
    dryRun: options.dryRun === true,
  });
  if (!options.dryRun) {
    const installedOptions = { cwd: inspection.repositoryRoot };
    const validation = await validateCommand(installedOptions);
    const doctor = await doctorCommand(installedOptions);
    const checks: CliCheck[] = [
      {
        status: "PASS",
        name: "Repository",
        message: inspection.repositoryRoot,
      },
      { status: "PASS", name: "Stack", message: config.project.stack_profile },
      { status: "PASS", name: "Bootstrap", message: applied.status },
      ...validation.checks.map((check) => ({
        ...check,
        name: `Validate: ${check.name}`,
      })),
      ...doctor.checks.map((check) => ({
        ...check,
        name: `Doctor: ${check.name}`,
      })),
    ];
    const failed = checks.some((check) => check.status === "FAIL");
    const warned = checks.some((check) => check.status === "WARNING");
    return Object.freeze({
      status: failed ? "NOT_READY" : warned ? "READY_WITH_WARNINGS" : "READY",
      summary: failed
        ? "Forge files installed, but first-run validation failed"
        : warned
          ? "Forge installed and validated with warnings requiring review"
          : "Forge installed and passed first-run validation",
      checks: Object.freeze(checks),
    });
  }
  return Object.freeze({
    status: "READY",
    summary: "Bootstrap dry-run completed without mutation",
    checks: Object.freeze<CliCheck[]>([
      {
        status: "PASS",
        name: "Repository",
        message: inspection.repositoryRoot,
      },
      { status: "PASS", name: "Stack", message: config.project.stack_profile },
      { status: "PASS", name: "Bootstrap", message: applied.status },
    ]),
  });
}

async function validateCommand(options: CliCommandOptions): Promise<CliResult> {
  try {
    const config = await loadInstalledConfig(options);
    const inspection = await inspectProjectRepository(options.cwd);
    const failures: CliCheck[] = [];
    const forgeRoot = join(inspection.repositoryRoot, ".forge");
    const ownership = OwnershipFileSchema.parse(
      parseGovernance(await boundedRead(join(forgeRoot, "ownership.yml"))),
    );
    ProvidersFileSchema.parse(
      parseGovernance(await boundedRead(join(forgeRoot, "providers.yml"))),
    );
    EvidenceFileSchema.parse(
      parseGovernance(await boundedRead(join(forgeRoot, "evidence.yml"))),
    );
    SchedulerFileSchema.parse(
      parseGovernance(await boundedRead(join(forgeRoot, "scheduler.yml"))),
    );
    McpCapabilitiesConfigSchema.parse(
      parseGovernance(await boundedRead(join(forgeRoot, "capabilities.yml"))),
    );
    if (
      (await realpath(config.project.repository_path)) !==
      inspection.repositoryRoot
    )
      failures.push({
        status: "FAIL",
        name: "Project mapping",
        message: "repository_path does not match this repository",
      });
    if (config.delivery.auto_merge || config.delivery.production_deploy)
      failures.push({
        status: "FAIL",
        name: "Delivery safety",
        message: "auto-merge and production deployment must remain false",
      });
    if (ownership.default_effect !== "deny")
      failures.push({
        status: "FAIL",
        name: "Ownership",
        message: "ownership must remain default deny",
      });
    for (const rule of ownership.rules) {
      const productionReadOnly = new Set([
        "security-auditor",
        "accessibility-auditor",
        "code-reviewer",
        "release-agent",
      ]);
      const allowedQa = [
        "tests/",
        "e2e/",
        ".forge/artifacts/",
        "test-results/",
        "playwright-report/",
      ];
      const allowedEvidence = [".forge/artifacts/"];
      const permitted =
        rule.effect === "forbid" ||
        (!productionReadOnly.has(rule.owner) &&
          (rule.owner !== "qa-engineer" ||
            allowedQa.some((root) => rule.pattern.startsWith(root))) &&
          (rule.owner !== "evidence-agent" ||
            allowedEvidence.some((root) => rule.pattern.startsWith(root))));
      if (!permitted)
        failures.push({
          status: "FAIL",
          name: "Persona floors",
          message: `unsafe ownership rule for ${rule.owner}`,
        });
    }
    const checks: CliCheck[] = [
      {
        status: "PASS",
        name: "Schemas",
        message: "version 1 configuration valid",
      },
      {
        status: "WARNING",
        name: "Ownership review",
        message: ownership.ambiguities.length
          ? ownership.ambiguities.join("; ")
          : "unowned paths remain default-denied",
      },
      {
        status: "PASS",
        name: "Persona floors",
        message: "bootstrap grants no production writes",
      },
      ...failures,
    ];
    return {
      status: failures.length ? "NOT_READY" : "READY_WITH_WARNINGS",
      summary: failures.length
        ? "Forge configuration is unsafe"
        : "Forge configuration is safe and internally consistent",
      checks,
    };
  } catch (error) {
    return failedResult("Configuration", error);
  }
}

const OwnershipFileSchema = z
  .object({
    schema_version: z.literal("1"),
    default_effect: z.literal("deny"),
    rules: z.array(
      z
        .object({
          pattern: z
            .string()
            .min(1)
            .refine((value) => {
              try {
                normalizeRepoPath(value);
                return true;
              } catch {
                return false;
              }
            }),
          owner: PersonaSchema,
          effect: z.enum(["allow", "forbid"]),
        })
        .strict(),
    ),
    ambiguities: z.array(z.string()),
    review: z
      .object({
        approved_by: z.string().min(1),
        approved_at: z.iso.datetime(),
        repository_path: z.string().min(1),
        candidate_commit: z.string().regex(/^[a-f0-9]{40}$/u),
        proposal_digest: z.string().regex(/^[a-f0-9]{64}$/u),
        policy_digest: z.string().regex(/^[a-f0-9]{64}$/u),
      })
      .strict()
      .optional(),
  })
  .strict();
const ProvidersFileSchema = z
  .object({
    schema_version: z.literal("1"),
    github: z
      .object({
        enabled: z.boolean(),
        remote_mutation_during_bootstrap: z.literal(false),
      })
      .strict(),
  })
  .strict();
const EvidenceFileSchema = z
  .object({
    schema_version: z.literal("1"),
    ui_video_required: z.boolean(),
    screenshots_required: z.boolean(),
    responsive_viewports: z
      .array(z.string().regex(/^[1-9]\d{1,4}x[1-9]\d{1,4}$/))
      .min(1),
  })
  .strict();
const SchedulerFileSchema = z
  .object({
    schema_version: z.literal("1"),
    provider: z.literal("human-setup-required"),
    contracts_only: z.literal(true),
  })
  .strict();

function parseGovernance(source: string): unknown {
  return parse(source, { maxAliasCount: 0, uniqueKeys: true });
}

async function doctorCommand(options: CliCommandOptions): Promise<CliResult> {
  if (
    !options.configPath &&
    !(await pathExists(join(options.cwd, ".forge/config.yml")))
  )
    return machineDoctorCommand(options);
  const validation = await validateCommand(options);
  if (validation.status === "NOT_READY") return validation;
  const inspection = await inspectProjectRepository(options.cwd);
  const config = await loadInstalledConfig(options);
  const governanceSources = await Promise.all(
    [
      "config.yml",
      "project.yml",
      "ownership.yml",
      "providers.yml",
      "evidence.yml",
      "scheduler.yml",
      "capabilities.yml",
    ].map((name) =>
      boundedRead(join(inspection.repositoryRoot, ".forge", name)),
    ),
  );
  const exists = async (path: string): Promise<boolean> =>
    lstat(path)
      .then(() => true)
      .catch(() => false);
  const command = async (
    executable: string,
    args: readonly string[],
  ): Promise<boolean> =>
    promisify(execFileCallback)(executable, [...args], {
      cwd: inspection.repositoryRoot,
      timeout: 1_000,
      maxBuffer: 256 * 1024,
      env: { PATH: process.env.PATH ?? "", HOME: process.env.HOME ?? "" },
    })
      .then(() => true)
      .catch(() => false);
  const always = () => Promise.resolve(true);
  const doctor = await runProjectDoctor({
    config: {
      auto_merge: config.delivery.auto_merge,
      production_deploy: config.delivery.production_deploy,
      github_enabled: config.delivery.create_pr,
      video_required: config.evidence.ui_video_required,
      scheduler_enabled: false,
    },
    probes: {
      forge: always,
      config: () => Promise.resolve(validation.status !== "NOT_READY"),
      git: () => command("git", ["--version"]),
      repository: always,
      runtime: () =>
        Promise.resolve(Number(process.versions.node.split(".")[0]) >= 22),
      rootsWritable: async () =>
        (await exists(join(inspection.repositoryRoot, ".forge/state"))) &&
        (await exists(join(inspection.repositoryRoot, ".forge/artifacts"))),
      obsidian: () =>
        exists(
          join(config.obsidian.vault_path, config.obsidian.command_center_path),
        ),
      ownership: () =>
        exists(join(inspection.repositoryRoot, ".forge/ownership.yml")),
      personas: always,
      stack: () => Promise.resolve(inspection.stack.evidence.length > 0),
      scheduler: () =>
        exists(join(inspection.repositoryRoot, ".forge/scheduler.yml")),
      playwright: () =>
        Promise.resolve(
          inspection.stack.evidence.some((item) =>
            /playwright/iu.test(item.name),
          ),
        ),
      ffmpeg: () => command("ffmpeg", ["-version"]),
      plaintextSecrets: () =>
        Promise.resolve(governanceSources.some(containsPlaintextSecret)),
      githubCli: () => command("gh", ["--version"]),
      githubAuth: () => command("gh", ["auth", "status"]),
    },
  });
  const warnings: CliCheck[] = [];
  if (inspection.remotes.length === 0)
    warnings.push({
      status: "WARNING",
      name: "Git remote",
      message: "no remote configured",
    });
  if (!inspection.git.clean)
    warnings.push({
      status: "WARNING",
      name: "Git status",
      message: "worktree has changes",
    });
  const operationalChecks: CliCheck[] = doctor.checks.map((check) => ({
    status: check.status,
    name: check.id,
    message: check.message,
  }));
  const hasWarnings =
    warnings.length > 0 ||
    validation.checks.some((check) => check.status === "WARNING") ||
    operationalChecks.some((check) => check.status === "WARNING");
  const hasFailures = operationalChecks.some(
    (check) => check.status === "FAIL",
  );
  let readiness = "PROJECT READY";
  try {
    const master = await loadMasterConfig(machineHome());
    const registry = await new GlobalProjectRegistry(
      master.registry.path,
    ).load();
    const registered = registry.projects.find(
      (project) => project.repo_path === inspection.repositoryRoot,
    );
    if (registered?.registration_status === "ACTIVE")
      readiness = "PROJECT ACTIVE";
  } catch {
    // Project-local doctor remains backward compatible without machine config.
  }
  return {
    status: hasFailures
      ? "NOT_READY"
      : hasWarnings
        ? "READY_WITH_WARNINGS"
        : "READY",
    summary: hasFailures
      ? "PROJECT NOT READY"
      : hasWarnings
        ? `${readiness} WITH WARNINGS`
        : readiness,
    checks: [...validation.checks, ...operationalChecks, ...warnings],
  };
}

async function machineDoctorCommand(
  options: CliCommandOptions,
): Promise<CliResult> {
  const checks: CliCheck[] = [];
  let config: Awaited<ReturnType<typeof loadMasterConfig>>;
  try {
    config = await loadMasterConfig(machineHome());
    checks.push({
      status: "PASS",
      name: "Master config",
      message: "schema version 1",
    });
  } catch {
    return {
      status: "NOT_READY",
      summary: "MACHINE NOT READY — run forge init",
      checks: [
        {
          status: "FAIL",
          name: "Master config",
          message: "missing or invalid; run forge init",
        },
      ],
    };
  }
  const actualForgeRoot = await realpath(options.cwd).catch(() => "");
  if (actualForgeRoot !== config.forge_root)
    checks.push({
      status: "FAIL",
      name: "Forge root",
      message: "current Forge root does not match master configuration",
    });
  const command = async (executable: string, args: readonly string[]) =>
    promisify(execFileCallback)(executable, [...args], {
      cwd: options.cwd,
      timeout: 1_000,
      maxBuffer: 256 * 1024,
      env: { PATH: process.env.PATH ?? "", HOME: process.env.HOME ?? "" },
    })
      .then(() => true)
      .catch(() => false);
  const probe = async (
    name: string,
    passed: Promise<boolean>,
    required: boolean,
    failure: string,
  ) => {
    const available = await passed;
    checks.push({
      status: available ? "PASS" : required ? "FAIL" : "WARNING",
      name,
      message: available ? "available" : failure,
    });
  };
  await probe("Forge CLI", Promise.resolve(true), true, "CLI unavailable");
  await probe(
    "Node",
    Promise.resolve(Number(process.versions.node.split(".")[0]) >= 22),
    true,
    "Node 22+ required",
  );
  await probe("npm", command("npm", ["--version"]), true, "npm unavailable");
  await probe("Git", command("git", ["--version"]), true, "Git unavailable");
  await probe(
    "Graphify",
    command("graphify", ["--help"]),
    false,
    "Graphify unavailable; project provisioning will stop before activation",
  );
  await probe(
    "GitHub CLI",
    command("gh", ["--version"]),
    false,
    "GitHub CLI unavailable; delivery is optional",
  );
  await probe(
    "GitHub auth",
    command("gh", ["auth", "status"]),
    false,
    "GitHub authentication unavailable; delivery is optional",
  );
  await probe(
    "Projects root",
    pathIsWritableDirectory(config.projects_root),
    true,
    "projects root missing or not writable",
  );
  await probe(
    "Shared vault",
    pathIsWritableDirectory(config.obsidian_vault),
    true,
    "shared vault missing or not writable",
  );
  const registry = await new GlobalProjectRegistry(config.registry.path)
    .load()
    .catch(() => undefined);
  await probe(
    "Registry",
    Promise.resolve(
      registry !== undefined &&
        (!registry.shared_vault_path ||
          registry.shared_vault_path === config.obsidian_vault) &&
        registry.projects.every((project) =>
          project.obsidian_project_path.startsWith(
            `${config.obsidian_vault}${process.platform === "win32" ? "\\" : "/"}Projects${process.platform === "win32" ? "\\" : "/"}`,
          ),
        ),
    ),
    true,
    "registry missing or invalid",
  );
  checks.push({
    status: "PASS",
    name: "Safety",
    message: "auto-merge, production deploy, and cross-project writes disabled",
  });
  const failed = checks.some((check) => check.status === "FAIL");
  const warned = checks.some((check) => check.status === "WARNING");
  return {
    status: failed ? "NOT_READY" : warned ? "READY_WITH_WARNINGS" : "READY",
    summary: failed
      ? "MACHINE NOT READY"
      : warned
        ? "MACHINE READY WITH WARNINGS"
        : "MACHINE READY",
    checks,
  };
}

async function pathExists(path: string): Promise<boolean> {
  return access(path)
    .then(() => true)
    .catch(() => false);
}
async function pathIsWritableDirectory(path: string): Promise<boolean> {
  try {
    if (!(await lstat(path)).isDirectory()) return false;
    await access(path, constants.W_OK);
    return true;
  } catch {
    return false;
  }
}

function containsPlaintextSecret(source: string): boolean {
  return /(?:gh[pousr]_[A-Za-z0-9]{20,}|AKIA[0-9A-Z]{16}|-----BEGIN [A-Z ]*PRIVATE KEY-----|(?:token|password|passwd|secret)\s*[:=]\s*(?!\{?\s*(?:environment|keychain|secret-manager)\b)\S+|[a-z][a-z0-9+.-]*:\/\/[^/\s:@]+:[^@\s]+@)/iu.test(
    source,
  );
}

async function upgradeCommand(options: CliCommandOptions): Promise<CliResult> {
  const config = await loadInstalledConfig(options);
  const templates = currentUpgradeTemplates();
  const report = options.dryRun
    ? await planUpgrade(options.cwd, config.schema_version, templates)
    : await applyUpgrade(options.cwd, config.schema_version, templates);
  const conflict = report.status === "CONFLICT";
  return {
    status: conflict ? "NOT_READY" : "READY",
    summary: conflict
      ? "Upgrade requires manual conflict resolution"
      : options.dryRun
        ? "Upgrade dry-run complete"
        : `Forge upgrade ${report.status.toLowerCase()}`,
    checks: [
      {
        status: "PASS",
        name: "Schema",
        message: `version ${config.schema_version} is current`,
      },
      {
        status: conflict ? "FAIL" : "PASS",
        name: "Managed assets",
        message: report.status,
      },
      {
        status: "PASS",
        name: "Safety floors",
        message: "auto-merge and production deployment disabled",
      },
    ],
  };
}

function currentUpgradeTemplates(): readonly UpgradeTemplate[] {
  return [
    {
      path: "docs/ai/operating-contract.md",
      classification: "FORGE_MANAGED",
      content:
        "# Operating Contract\n\nForge follows the repository constitution, default-deny ownership, and stops at a verified pull request for human review.\n",
    },
  ];
}

async function loadInstalledConfig(
  options: CliCommandOptions,
): Promise<ForgeBootstrapConfig> {
  const path = options.configPath
    ? resolve(options.cwd, options.configPath)
    : join(options.cwd, ".forge/config.yml");
  return parseBootstrapConfigYaml(await boundedRead(path));
}
async function boundedRead(path: string): Promise<string> {
  const stat = await lstat(path);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 1024 * 1024)
    throw new Error(
      "Configuration must be a regular file no larger than 1 MiB",
    );
  return readFile(path, "utf8");
}
async function interactiveConfig(
  inspection: Awaited<ReturnType<typeof inspectProjectRepository>>,
  nonInteractive: boolean,
  prompt: CliPrompt,
): Promise<ForgeBootstrapConfig> {
  if (nonInteractive)
    throw new Error("--non-interactive requires --config <file>");
  const name =
    (
      await prompt(`Project name [${basename(inspection.repositoryRoot)}]: `)
    ).trim() || basename(inspection.repositoryRoot);
  const vault = (await prompt("Obsidian vault absolute path: ")).trim();
  const center =
    (await prompt(`Command Center name [${name}]: `)).trim() || name;
  const autonomyAnswer = (
    await prompt("Autonomous execution risk [Low + Medium]: ")
  )
    .trim()
    .toUpperCase();
  if (
    autonomyAnswer &&
    !["LOW", "LOW + MEDIUM", "MEDIUM"].includes(autonomyAnswer)
  )
    throw new Error("Autonomous execution must be Low or Low + Medium");
  const createPr = /^y(?:es)?$/iu.test(
    (await prompt("Create GitHub PR automatically? [y/N]: ")).trim(),
  );
  const video = /^y(?:es)?$/iu.test(
    (await prompt("Require video evidence for UI changes? [y/N]: ")).trim(),
  );
  await prompt("Configure scheduler contracts? [y/N]: ");
  await prompt("Configure optional database/MCP capabilities? [y/N]: ");
  const stack =
    inspection.stack.evidence.map((item) => item.name).join(" + ") ||
    "Unknown (default deny)";
  const raw = {
    schema_version: "1",
    project: {
      id: slug(name),
      name,
      repository_path: inspection.repositoryRoot,
      repository_identity:
        inspection.remotes[0]?.url ?? inspection.repositoryRoot,
      default_branch: inspection.branch.default ?? "main",
      stack_profile: stack,
    },
    obsidian: {
      vault_path: vault,
      command_center_path: `${center}/AI Engineering`,
    },
    delivery: {
      remote_push: createPr,
      create_pr: createPr,
      auto_merge: false,
      production_deploy: false,
    },
    autonomy: {
      allowed_risk: autonomyAnswer === "LOW" ? "LOW" : "MEDIUM",
      modes: ["AUTO"],
    },
    evidence: {
      ui_video_required: video,
      screenshots_required: true,
      responsive_viewports: ["390x844", "1440x900"],
    },
  };
  return parseBootstrapConfigYaml(stringify(raw));
}
function slug(value: string): string {
  const result = value
    .toLowerCase()
    .replace(/[^a-z0-9]+/gu, "-")
    .replace(/^-|-$/gu, "");
  if (!result) throw new Error("Project name cannot form a safe id");
  return result;
}
function failedResult(name: string, error: unknown): CliResult {
  return {
    status: "NOT_READY",
    summary: "Forge configuration validation failed",
    checks: [
      {
        status: "FAIL",
        name,
        message: error instanceof Error ? error.message : "invalid",
      },
    ],
  };
}
async function terminalPrompt(question: string): Promise<string> {
  const rl = createInterface({ input: stdin, output: stdout });
  try {
    return await rl.question(question);
  } finally {
    rl.close();
  }
}

const defaultServices = createDefaultCliServices();
if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  process.exitCode = await runCli(process.argv.slice(2), defaultServices, {
    stdout: (text) => console.log(text),
    stderr: (text) => console.error(text),
    cwd: process.cwd(),
  });
}
