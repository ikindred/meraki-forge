import { execFile as execFileCallback } from "node:child_process";
import {
  access,
  lstat,
  mkdir,
  readFile,
  realpath,
  rm,
  writeFile,
} from "node:fs/promises";
import { homedir } from "node:os";
import {
  basename,
  dirname,
  join,
  parse as parsePath,
  resolve,
  sep,
} from "node:path";
import { promisify } from "node:util";
import { parse, stringify } from "yaml";
import { z } from "zod";
import { GlobalProjectRegistry } from "../../adapters/src/global-project-registry.js";
import { GraphifyAdapter } from "../../adapters/src/graphify-adapter.js";
import {
  planSharedVaultProject,
  applySharedVaultProject,
} from "../../adapters/src/shared-vault.js";
import { inspectProjectRepository } from "../../adapters/src/project-inspector.js";
import { FileOwnershipPolicyStore } from "../../adapters/src/ownership-policy-store.js";
import { loadMasterConfig } from "../../adapters/src/machine-init.js";
import { GraphifyService } from "../../execution/src/graphify-service.js";
import {
  createOwnershipReview,
  approveAndPersistOwnershipReview,
  type ApprovedOwnershipFile,
  verifyApprovedOwnershipPolicy,
} from "../../execution/src/ownership-review.js";
import {
  deterministicProjectId,
  emptyMasterProjectRegistry,
  type MasterProjectRegistry,
} from "../../kernel/src/master-registry.js";
import { resolveProject } from "../../kernel/src/project-resolution.js";
import {
  recommendTechnology,
  type ProjectType,
} from "../../kernel/src/technology-policy.js";
import {
  ForgeBootstrapConfigSchema,
  parseBootstrapConfigYaml,
} from "../../kernel/src/bootstrap-config.js";
import {
  applyBootstrapPlan,
  planBootstrap,
  renderBootstrapManagedFiles,
} from "../../execution/src/bootstrap-service.js";

const execFile = promisify(execFileCallback);
export interface MasterCommandIo {
  readonly cwd: string;
  readonly stdout: (text: string) => void;
  readonly stderr: (text: string) => void;
}

export async function runMasterCommand(
  argv: readonly string[],
  io: MasterCommandIo,
): Promise<number> {
  const json = argv.includes("--json");
  const args = argv.filter((item) => item !== "--json");
  try {
    const result =
      args[0] === "project"
        ? await projectCommand(args.slice(1), io.cwd)
        : await ownershipCommand(args.slice(1), io.cwd);
    io.stdout(json ? JSON.stringify(result) : render(result));
    return result.status === "NOT_READY" ? 1 : 0;
  } catch (error) {
    const message =
      error instanceof Error ? error.message : "Master command failed";
    io.stderr(
      json
        ? JSON.stringify({ status: "NOT_READY", error: message })
        : `FAIL  ${message}`,
    );
    return 1;
  }
}

type MasterResult = Readonly<{
  status: "READY" | "READY_WITH_WARNINGS" | "NOT_READY";
  summary: string;
  data?: unknown;
  next_actions?: readonly string[];
}>;

async function projectCommand(
  args: readonly string[],
  cwd: string,
): Promise<MasterResult> {
  const [action, ...rest] = args;
  if (!action || action === "--help" || action === "help")
    return ready(
      "Project commands: create, onboard, list, inspect, status, activate, remove, graph",
    );
  if (rest.includes("--help") || rest.includes("-h"))
    return ready(
      action === "create"
        ? "Usage: forge project create --name <name> [--repo <path>] [--type <type>] [--dry-run]"
        : action === "onboard"
          ? "Usage: forge project onboard [--repo <path>] --vault <path> [--dry-run]"
          : action === "graph"
            ? "Usage: forge project graph <project> status|refresh"
            : action === "activate"
              ? "Usage: forge project activate <project>"
              : `Usage: forge project ${action} <project>`,
    );
  const registry = await loadRegistry();
  if (action === "list")
    return ready(
      `${registry.projects.length} registered project(s)`,
      registry.projects,
    );
  if (action === "inspect" || action === "status") {
    if (!rest[0] && action === "status")
      return ready("All project statuses", registry.projects.map(summary));
    const project = requireResolved(registry, rest[0]);
    return ready(
      `${project.display_name} is ${project.registration_status}`,
      action === "status" ? summary(project) : project,
    );
  }
  if (action === "remove") {
    const project = requireResolved(registry, rest[0]);
    if (!rest.includes("--confirm"))
      return notReady("Removal requires --confirm", [
        "Rerun with --confirm. No repository or Obsidian content will be deleted.",
      ]);
    const store = await writableRegistry();
    const removed = await store.unregister(project.project_id, {
      expectedRevision: registry.revision,
    });
    return ready(
      removed.removed
        ? `Unregistered ${project.display_name}; project files were preserved`
        : "Project was already unregistered",
    );
  }
  if (action === "graph") return graphCommand(registry, rest);
  if (action === "activate") return activateCommand(registry, rest, cwd);
  if (action === "onboard") return onboardCommand(rest, cwd);
  if (action === "create") return createCommand(rest, cwd);
  return notReady(`Unknown project command: ${action}`);
}

async function activateCommand(
  registry: MasterProjectRegistry,
  args: readonly string[],
  cwd: string,
): Promise<MasterResult> {
  const project = requireResolved(registry, args[0]);
  const ownershipPath = join(project.repo_path, ".forge/ownership.yml");
  if (!(await exists(ownershipPath)))
    return notReady("Ownership approval is required before activation", [
      `Run forge ownership review ${project.project_id}.`,
    ]);
  const ownershipSchema = z
    .object({
      schema_version: z.literal("1"),
      default_effect: z.literal("deny"),
      rules: z.array(z.unknown()),
      ambiguities: z.array(z.string()).max(0),
      review: z
        .object({
          approved_by: z.string().trim().min(1),
          approved_at: z.iso.datetime(),
          repository_path: z.string(),
          candidate_commit: z.string().regex(/^[a-f0-9]{40}$/u),
          proposal_digest: z.string().regex(/^[a-f0-9]{64}$/u),
          policy_digest: z.string().regex(/^[a-f0-9]{64}$/u),
        })
        .strict(),
    })
    .passthrough();
  const ownershipEntry = await lstat(ownershipPath);
  if (!ownershipEntry.isFile() || ownershipEntry.isSymbolicLink())
    return notReady("Ownership approval file must be a real repository file");
  const ownership = ownershipSchema.parse(
    parse(await readFile(ownershipPath, "utf8")),
  ) as unknown as ApprovedOwnershipFile;
  const canonical = await realpath(project.repo_path);
  const head = (
    await runExecutable("git", ["rev-parse", "HEAD"], { cwd: canonical })
  ).stdout.trim();
  if (
    ownership.review.repository_path !== canonical ||
    ownership.review.candidate_commit !== head
  )
    return notReady(
      "Ownership approval is stale or bound to another repository",
    );
  if (!verifyApprovedOwnershipPolicy(ownership, canonical, head))
    return notReady("Ownership approval integrity verification failed");
  const graph = await new GraphifyService(
    new GraphifyAdapter(project.repo_path, runExecutable),
  ).inspect();
  if (graph.status !== "CURRENT")
    return notReady(`Graphify must be CURRENT before activation`, [
      `Run forge project graph ${project.project_id} refresh.`,
    ]);
  const outputs: string[] = [];
  const validationIo = {
    cwd: project.repo_path,
    stdout: (text: string) => outputs.push(text),
    stderr: (text: string) => outputs.push(text),
  };
  const { createDefaultCliServices, runCli } = await import("./main.js");
  const services = createDefaultCliServices();
  const configArgs = ["--config", project.forge_config_path, "--json"];
  const validateExit = await runCli(
    ["validate", ...configArgs],
    services,
    validationIo,
  );
  const doctorExit = await runCli(
    ["doctor", ...configArgs],
    services,
    validationIo,
  );
  if (validateExit !== 0 || doctorExit !== 0)
    return notReady(
      "Validation or doctor checks failed; project remains INACTIVE",
      [...outputs],
    );
  const current = await loadRegistry();
  requireResolved(current, project.project_id);
  await (
    await writableRegistry()
  ).update(
    project.project_id,
    { registration_status: "ACTIVE" },
    { expectedRevision: current.revision },
  );
  return ready(`${project.display_name} is ACTIVE`, {
    validation: "PASS",
    doctor: "PASS",
    invoked_from: cwd,
  });
}

async function graphCommand(
  registry: MasterProjectRegistry,
  args: readonly string[],
): Promise<MasterResult> {
  const project = requireResolved(registry, args[0]);
  const operation = args[1] ?? "status";
  if (operation !== "status" && operation !== "refresh")
    throw new Error(`Unknown graph operation: ${operation}`);
  const adapter = new GraphifyAdapter(project.repo_path, runExecutable);
  const service = new GraphifyService(adapter);
  const result =
    operation === "refresh" ? await service.refresh() : await service.inspect();
  return result.status === "CURRENT"
    ? ready(`Graphify is current for ${project.display_name}`, result)
    : {
        status: "NOT_READY",
        summary: `Graphify is ${result.status}`,
        data: result,
        next_actions: result.action ? [result.action] : [],
      };
}

async function onboardCommand(
  args: readonly string[],
  cwd: string,
): Promise<MasterResult> {
  const repository = resolve(option(args, "--repo") ?? cwd);
  const vault =
    option(args, "--vault") ??
    (await loadMasterConfig(dirname(registryPath()))).obsidian_vault;
  const dryRun = args.includes("--dry-run");
  const inspection = await inspectProjectRepository(repository);
  const installedConfig = join(repository, ".forge/config.yml");
  const configSource = await readFile(installedConfig, "utf8").catch(
    async (error: NodeJS.ErrnoException) => {
      if (error.code !== "ENOENT") throw error;
      const path = option(args, "--config");
      if (!path)
        throw new Error(
          "Existing projects without Forge require --config <bootstrap.yml>",
        );
      return readFile(resolve(path), "utf8");
    },
  );
  const config = parseBootstrapConfigYaml(configSource);
  if (resolve(config.project.repository_path) !== inspection.repositoryRoot)
    throw new Error("Bootstrap config repository does not match target");
  const graph = await new GraphifyService(
    new GraphifyAdapter(repository, runExecutable),
  ).inspect();
  const projectPath = join(resolve(vault), "Projects", config.project.name);
  const plan = planSharedVaultProject(repository, resolve(vault), {
    projectId: config.project.id,
    displayName: config.project.name,
    purpose: "Project memory workspace managed by Meraki Forge.",
    repositoryPath: repository,
    stackSummary: config.project.stack_profile,
    graphifyStatus: graph.status,
    forgeStatus: "BOOTSTRAPPED",
  });
  if (dryRun)
    return ready("Project onboarding dry-run completed with zero writes", {
      project_id: config.project.id,
      repository,
      graphify: graph,
      workspace: plan.projectPath,
    });
  if (!(await exists(installedConfig))) {
    const bootstrap = planBootstrap({
      repositoryRoot: repository,
      vaultRoot: resolve(vault),
      commandCenterName: config.project.name,
      projectName: config.project.name,
      managedFiles: renderBootstrapManagedFiles(config),
    });
    await applyBootstrapPlan({
      ...bootstrap,
      entries: bootstrap.entries.filter((entry) => entry.root === "repository"),
    });
  }
  if (graph.status !== "CURRENT")
    return notReady(
      `Graphify is required before registration (${graph.status})`,
      [graph.action ?? `Initialize Graphify in ${repository}.`],
    );
  await applySharedVaultProject(plan);
  const store = await writableRegistry();
  const registered = await store.register({
    project_id: config.project.id,
    display_name: config.project.name,
    repo_path: inspection.repositoryRoot,
    forge_config_path: join(repository, ".forge/config.yml"),
    graphify_path: join(repository, "graphify-out"),
    obsidian_project_path: projectPath,
    stack_summary: config.project.stack_profile,
    registration_status: "INACTIVE",
    aliases: [deterministicProjectId(config.project.name)],
  });
  return {
    status: "READY_WITH_WARNINGS",
    summary: registered.created
      ? `Registered ${config.project.name}; ownership approval and final validation remain required`
      : `${config.project.name} was already registered`,
    data: registered.project,
    next_actions: [`Run forge ownership review ${config.project.id}.`],
  };
}

async function createCommand(
  args: readonly string[],
  cwd: string,
): Promise<MasterResult> {
  const name = option(args, "--name");
  if (!name) return notReady("Project creation requires --name <display name>");
  const explicitRepository = option(args, "--repo");
  const explicitVault = option(args, "--vault");
  const dryRun = args.includes("--dry-run");
  const master =
    explicitRepository && explicitVault
      ? undefined
      : await loadMasterConfig(dirname(registryPath()));
  const repository = resolve(
    explicitRepository ??
      join(master!.projects_root, deterministicProjectId(name ?? "project")),
  );
  const type = (option(args, "--type") ?? "full-stack") as ProjectType;
  const technology = recommendTechnology({
    project_type: type,
    scale: "medium",
    integrations: [],
    deployment_model: "managed",
    security_sensitivity: "standard",
  });
  if (dryRun)
    return ready("Project creation dry-run completed with zero writes", {
      project_id: deterministicProjectId(name),
      repository,
      vault: resolve(explicitVault ?? master!.obsidian_vault),
      forge_path: join(repository, ".forge"),
      graphify_path: join(repository, "graphify-out"),
      registry_path: master?.registry.path ?? registryPath(),
      obsidian_project_path: join(
        resolve(explicitVault ?? master!.obsidian_vault),
        "Projects",
        name,
      ),
      technology,
    });
  const vault = explicitVault ?? master?.obsidian_vault;
  if (!vault)
    return notReady("Forge machine is not initialized; run forge init");
  if (
    technology.requires_human_approval &&
    !args.includes("--approve-architecture")
  )
    return notReady("Architecture approval requires --approve-architecture");
  if (await exists(join(repository, ".git")))
    return onboardCommand(["--repo", repository, "--vault", vault], cwd);
  await createMinimalProject(repository, name, type, technology.stack);
  const config = ForgeBootstrapConfigSchema.parse({
    schema_version: "1",
    project: {
      id: deterministicProjectId(name),
      name,
      repository_path: repository,
      repository_identity: repository,
      default_branch: "main",
      stack_profile: technology.stack.join(" + "),
    },
    obsidian: {
      vault_path: resolve(vault),
      command_center_path: `${name}/AI Engineering`,
    },
    delivery: {
      remote_push: false,
      create_pr: false,
      auto_merge: false,
      production_deploy: false,
    },
    autonomy: { allowed_risk: "MEDIUM", modes: ["AUTO"] },
    evidence: {
      ui_video_required: type === "frontend" || type === "full-stack",
      screenshots_required: true,
      responsive_viewports: ["390x844", "1440x900"],
    },
  });
  const configPath = join(repository, ".forge-bootstrap.yml");
  await writeFile(configPath, stringify(config), { flag: "wx", mode: 0o600 });
  try {
    return await onboardCommand(
      ["--repo", repository, "--vault", vault, "--config", configPath],
      cwd,
    );
  } finally {
    await rm(configPath, { force: true });
  }
}

async function createMinimalProject(
  repository: string,
  name: string,
  type: ProjectType,
  stack: readonly string[],
): Promise<void> {
  const requestedParent = dirname(repository);
  await assertNoSymlinkAncestors(requestedParent);
  const parent = await realpath(requestedParent);
  if (await exists(repository))
    throw new Error(
      "Project destination already exists and is not initialized",
    );
  await mkdir(repository, { mode: 0o755 });
  const expectedRepository = join(parent, basename(repository));
  if ((await realpath(repository)) !== expectedRepository)
    throw new Error("Created project repository identity is unsafe");
  await writeFile(
    join(repository, "README.md"),
    `# ${name}\n\nScaffolded from the approved Forge technology policy.\n`,
  );
  const files = scaffoldFiles(deterministicProjectId(name), type, stack);
  for (const [path, source] of Object.entries(files)) {
    await mkdir(dirname(join(repository, path)), { recursive: true });
    await writeFile(join(repository, path), source, { flag: "wx" });
  }
  await writeFile(
    join(repository, ".gitignore"),
    "node_modules/\n.env\n.env.*\n!.env.example\n.forge/state/\n.forge/artifacts/\n",
  );
  await runExecutable("git", ["init", "-b", "main"], { cwd: repository });
  await runExecutable("git", ["add", "."], { cwd: repository });
  await runExecutable(
    "git",
    [
      "-c",
      "core.hooksPath=/dev/null",
      "-c",
      "user.name=Meraki Forge",
      "-c",
      "user.email=forge@localhost",
      "commit",
      "-m",
      "chore: establish project baseline",
    ],
    { cwd: repository },
  );
}

async function assertNoSymlinkAncestors(path: string): Promise<void> {
  const absolute = resolve(path);
  const root = parsePath(absolute).root;
  let current = root;
  for (const component of absolute
    .slice(root.length)
    .split(sep)
    .filter(Boolean)) {
    current = join(current, component);
    if ((await lstat(current)).isSymbolicLink())
      throw new Error("Project path must not contain symbolic links");
  }
}

function scaffoldFiles(
  id: string,
  type: ProjectType,
  stack: readonly string[],
): Readonly<Record<string, string>> {
  if (type === "mobile")
    return {
      "pubspec.yaml": `name: ${id.replaceAll("-", "_")}\nenvironment:\n  sdk: '>=3.0.0 <4.0.0'\ndev_dependencies:\n  test: any\n`,
      "lib/main.dart": "void main() {}\n",
      "test/smoke_test.dart":
        "import 'package:test/test.dart';\nvoid main() { test('scaffold', () => expect(true, isTrue)); }\n",
      "forge-architecture.json": `${JSON.stringify({ project_type: type, stack }, null, 2)}\n`,
    };
  if (type === "database")
    return {
      "database/migrations/001_initial.sql":
        "-- Initial migration intentionally empty; add reviewed schema changes here.\n",
      "database/README.md":
        "# Database\n\nPostgreSQL migrations are owned by the database persona.\n",
      "forge-architecture.json": `${JSON.stringify({ project_type: type, stack }, null, 2)}\n`,
    };
  const next = type === "frontend" || type === "full-stack";
  return {
    "package.json": `${JSON.stringify(
      {
        name: id,
        private: true,
        version: "0.1.0",
        scripts: { test: "node --test" },
        dependencies: next
          ? { next: "^15.0.0", react: "^19.0.0", "react-dom": "^19.0.0" }
          : {},
        devDependencies: { typescript: "^5.0.0" },
        forge_stack: stack,
      },
      null,
      2,
    )}\n`,
    "src/index.ts": next
      ? "export const projectReady = true;\n"
      : "export const serviceReady = true;\n",
    "test/smoke.test.js":
      "import test from 'node:test';\nimport assert from 'node:assert/strict';\ntest('scaffold', () => assert.equal(true, true));\n",
    "forge-architecture.json": `${JSON.stringify({ project_type: type, stack }, null, 2)}\n`,
  };
}

async function ownershipCommand(
  args: readonly string[],
  cwd: string,
): Promise<MasterResult> {
  if (args.includes("--help") || args.includes("-h"))
    return ready(
      "Usage: forge ownership review [project] [--approve --approved-by <name> --proposal-digest <sha256>]",
    );
  if (args[0] !== "review")
    return notReady(
      "Usage: forge ownership review [project] [--approve --approved-by <name> --proposal-digest <sha256>]",
    );
  const registry = await loadRegistry();
  const project =
    args[1] && !args[1].startsWith("-")
      ? requireResolved(registry, args[1])
      : requireResolved(registry, deterministicProjectId(basename(cwd)));
  const inspection = await inspectProjectRepository(project.repo_path);
  const head = (
    await runExecutable("git", ["rev-parse", "HEAD"], {
      cwd: project.repo_path,
    })
  ).stdout.trim();
  const tracked = (
    await runExecutable("git", ["ls-files"], { cwd: project.repo_path })
  ).stdout
    .split(/\r?\n/u)
    .filter(Boolean);
  const candidates = ownershipCandidates([...inspection.manifests, ...tracked]);
  const review = createOwnershipReview({
    repositoryPath: project.repo_path,
    candidateCommit: head,
    candidates,
  });
  if (!args.includes("--approve"))
    return {
      status: "READY_WITH_WARNINGS",
      summary: "Ownership proposal awaits explicit human approval",
      data: review,
    };
  const approvedBy = option(args, "--approved-by");
  if (!approvedBy)
    return notReady("Approval requires --approved-by <human name>");
  const approvedDigest = option(args, "--proposal-digest");
  if (!approvedDigest)
    return notReady(
      "Approval requires --proposal-digest from a separately reviewed proposal",
    );
  if (approvedDigest !== review.proposal_digest)
    return notReady("Proposal digest is stale or does not match this proposal");

  // Re-read the authoritative registry and repository immediately before the
  // write. Approval never expands to a moved, replaced, or dirty repository.
  const currentRegistry = await loadRegistry();
  const currentProject = requireResolved(currentRegistry, project.project_id);
  const currentCanonical = await realpath(currentProject.repo_path);
  if (
    currentCanonical !== project.repo_path ||
    currentProject.repo_path !== project.repo_path
  )
    return notReady("Registered repository changed after proposal creation");
  const currentInspection = await inspectProjectRepository(currentCanonical);
  const currentHead = (
    await runExecutable("git", ["rev-parse", "HEAD"], {
      cwd: currentCanonical,
    })
  ).stdout.trim();
  if (currentHead !== review.candidate_commit)
    return notReady("Repository HEAD changed after proposal creation");
  if (!currentInspection.git.clean)
    return notReady("Repository must be clean before ownership persistence");
  const policy = await approveAndPersistOwnershipReview(
    review,
    {
      approved: true,
      approved_by: approvedBy,
      approved_at: new Date().toISOString(),
      repository_path: review.repository_path,
      candidate_commit: review.candidate_commit,
      proposal_digest: approvedDigest,
    },
    new FileOwnershipPolicyStore(),
  );
  return ready("Ownership review approved and persisted", policy);
}

function ownershipCandidates(paths: readonly string[]) {
  const roots = [
    ["app/api/**", "backend-engineer"],
    ["src/frontend/**", "frontend-engineer"],
    ["src/backend/**", "backend-engineer"],
    ["database/migrations/**", "database-architect"],
    ["tests/**", "qa-engineer"],
    ["e2e/**", "qa-engineer"],
  ] as const;
  return roots
    .filter(([pattern]) =>
      paths.some((path) => path.startsWith(pattern.slice(0, -3))),
    )
    .map(([pattern, owner]) => ({
      pattern,
      owner,
      evidence: [`Repository contains ${pattern.slice(0, -3)}`],
    }));
}

async function loadRegistry(): Promise<MasterProjectRegistry> {
  const path = registryPath();
  try {
    await access(dirname(path));
  } catch {
    return emptyMasterProjectRegistry();
  }
  return new GlobalProjectRegistry(path).load();
}
async function writableRegistry(): Promise<GlobalProjectRegistry> {
  const path = registryPath();
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  return new GlobalProjectRegistry(path);
}
function registryPath(): string {
  const root = process.env.MERAKI_FORGE_HOME
    ? resolve(process.env.MERAKI_FORGE_HOME)
    : join(homedir(), ".meraki-forge");
  return join(root, "projects.yml");
}
function requireResolved(registry: MasterProjectRegistry, reference?: string) {
  if (!reference) throw new Error("A project reference is required");
  const result = resolveProject(registry, reference);
  if (result.status !== "RESOLVED")
    throw new Error(
      result.status === "AMBIGUOUS"
        ? `Ambiguous project: ${result.candidate_project_ids.join(", ")}`
        : `Project not found: ${reference}`,
    );
  return result.project;
}
function option(args: readonly string[], name: string): string | undefined {
  const index = args.indexOf(name);
  if (index < 0) return undefined;
  const value = args[index + 1];
  if (!value || value.startsWith("--"))
    throw new Error(`${name} requires a value`);
  return value;
}
function summary(project: MasterProjectRegistry["projects"][number]) {
  return {
    project_id: project.project_id,
    display_name: project.display_name,
    status: project.registration_status,
    stack: project.stack_summary,
  };
}
function ready(summaryText: string, data?: unknown): MasterResult {
  return {
    status: "READY",
    summary: summaryText,
    ...(data === undefined ? {} : { data }),
  };
}
function notReady(
  summaryText: string,
  next_actions: readonly string[] = [],
): MasterResult {
  return { status: "NOT_READY", summary: summaryText, next_actions };
}
async function exists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}
function render(result: MasterResult): string {
  return `${result.status.replaceAll("_", " ")}\n${result.summary}${result.data ? `\n${stringify(result.data)}` : ""}${result.next_actions?.length ? `\nNext: ${result.next_actions.join("; ")}` : ""}`;
}
async function runExecutable(
  executable: string,
  args: readonly string[],
  options?: Readonly<{ cwd: string }>,
) {
  const cwd = options?.cwd ?? process.cwd();
  const result = await execFile(executable, [...args], {
    cwd,
    timeout: 120_000,
    maxBuffer: 4 * 1024 * 1024,
    env: { PATH: process.env.PATH ?? "", HOME: process.env.HOME ?? "" },
  });
  return { stdout: result.stdout, stderr: result.stderr };
}
