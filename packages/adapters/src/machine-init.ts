import { randomUUID } from "node:crypto";
import {
  lstat,
  mkdir,
  open,
  readFile,
  realpath,
  rename,
  unlink,
} from "node:fs/promises";
import { dirname, join, parse as parsePath, resolve, sep } from "node:path";
import { parse, stringify } from "yaml";
import {
  MasterConfigSchema,
  type MasterConfig,
} from "../../kernel/src/master-config.js";
import {
  emptyMasterProjectRegistry,
  MasterProjectRegistrySchema,
} from "../../kernel/src/master-registry.js";

const BEGIN = "<!-- BEGIN MERAKI FORGE MANAGED -->";
const END = "<!-- END MERAKI FORGE MANAGED -->";

export type MachineInitInput = Readonly<{
  forgeRoot: string;
  masterHome: string;
  documentsRoot?: string;
  projectsRoot?: string;
  obsidianVault?: string;
  now?: string;
}>;
export type MachineInitPlan = Readonly<{
  schema_version: "1";
  forge_root: string;
  master_home: string;
  projects_root: string;
  obsidian_vault: string;
  config_path: string;
  registry_path: string;
  config: MasterConfig;
  writes: readonly Readonly<{
    path: string;
    source: string;
    existing?: string;
  }>[];
  directories: readonly string[];
  changes: readonly string[];
}>;

export async function planMachineInit(
  input: MachineInitInput,
): Promise<MachineInitPlan> {
  const forgeRoot = await canonicalExistingDirectory(
    input.forgeRoot,
    "Forge root",
  );
  const masterHome = await canonicalPlannedPath(input.masterHome);
  const configPath = join(masterHome, "config.yml");
  const registryPath = join(masterHome, "projects.yml");
  const existingConfigSource = await optionalRegularFile(configPath);
  const existingConfig = existingConfigSource
    ? MasterConfigSchema.parse(
        parse(existingConfigSource, { maxAliasCount: 0, uniqueKeys: true }),
      )
    : undefined;
  const registrySource = await optionalRegularFile(registryPath);
  const existingRegistry = registrySource
    ? MasterProjectRegistrySchema.parse(
        parse(registrySource, { maxAliasCount: 0, uniqueKeys: true }),
      )
    : undefined;
  const legacyRegistryVault = inferLegacyRegistryVault(existingRegistry);
  const documents = await canonicalPlannedPath(
    input.documentsRoot ?? dirname(forgeRoot),
  );
  const projectsRoot = await canonicalPlannedPath(
    input.projectsRoot ??
      existingConfig?.projects_root ??
      join(documents, "Meraki Forge Projects"),
  );
  const obsidianVault = await canonicalPlannedPath(
    input.obsidianVault ??
      existingConfig?.obsidian_vault ??
      existingRegistry?.shared_vault_path ??
      legacyRegistryVault ??
      join(documents, "Meraki Forge Vault"),
  );
  for (const path of [masterHome, projectsRoot, obsidianVault])
    await rejectSymlinkAncestors(path);
  if (new Set([masterHome, projectsRoot, obsidianVault]).size !== 3)
    throw new Error("Machine root paths conflict");
  if (
    existingConfig &&
    (existingConfig.forge_root !== forgeRoot ||
      existingConfig.projects_root !== projectsRoot ||
      existingConfig.obsidian_vault !== obsidianVault ||
      existingConfig.registry.path !== registryPath)
  )
    throw new Error(
      "Existing master configuration conflicts with requested paths",
    );
  const at =
    input.now ?? existingConfig?.updated_at ?? new Date().toISOString();
  const config = MasterConfigSchema.parse(
    existingConfig ?? {
      schema_version: "1",
      forge_root: forgeRoot,
      projects_root: projectsRoot,
      obsidian_vault: obsidianVault,
      registry: { path: registryPath, schema_version: "1" },
      initialized_at: at,
      updated_at: at,
      safety: {
        auto_merge: false,
        production_deploy: false,
        cross_project_writes: false,
      },
    },
  );
  const directories = [
    masterHome,
    projectsRoot,
    obsidianVault,
    join(obsidianVault, "Projects"),
    join(obsidianVault, "Cross Project"),
    join(obsidianVault, "Boss Reports"),
  ];
  const desired = new Map<string, string>([
    [configPath, stringify(config, { sortMapEntries: true })],
    ...(registrySource
      ? []
      : [
          [
            registryPath,
            stringify(emptyMasterProjectRegistry(at), { sortMapEntries: true }),
          ] as [string, string],
        ]),
    [
      join(obsidianVault, "Dashboard.md"),
      managed(
        "# Meraki Forge Dashboard\n\nMaster project status, work, blockers, and reviews live here.",
      ),
    ],
    [
      join(obsidianVault, "Cross Project/Active Work.md"),
      managed("# Active Work\n\nCross-project work summary."),
    ],
    [
      join(obsidianVault, "Cross Project/Blockers.md"),
      managed("# Blockers\n\nCross-project blockers."),
    ],
    [
      join(obsidianVault, "Cross Project/Reviews.md"),
      managed("# Reviews\n\nCross-project review queue."),
    ],
  ]);
  const writes = [] as Array<{
    path: string;
    source: string;
    existing?: string;
  }>;
  for (const [path, generated] of desired) {
    const existing = await optionalRegularFile(path);
    const source = path.endsWith(".md")
      ? composeMarkdown(existing, generated)
      : generated;
    if (existing !== source)
      writes.push({
        path,
        source,
        ...(existing === undefined ? {} : { existing }),
      });
  }
  const missingDirectories = [] as string[];
  for (const path of directories)
    if (!(await existingDirectory(path))) missingDirectories.push(path);
  return Object.freeze({
    schema_version: "1",
    forge_root: forgeRoot,
    master_home: masterHome,
    projects_root: projectsRoot,
    obsidian_vault: obsidianVault,
    config_path: configPath,
    registry_path: registryPath,
    config,
    writes: Object.freeze(writes),
    directories: Object.freeze(directories),
    changes: Object.freeze([
      ...missingDirectories.map((path) => `${path}/`),
      ...writes.map(({ path }) => path),
    ]),
  });
}

export async function applyMachineInit(
  plan: MachineInitPlan,
): Promise<
  Readonly<{ status: "APPLIED" | "UNCHANGED"; changes: readonly string[] }>
> {
  validateMachineInitPlan(plan);
  if (plan.changes.length === 0) return { status: "UNCHANGED", changes: [] };
  const lockPath = `${plan.master_home}.init.lock`;
  await mkdir(dirname(plan.master_home), { recursive: true, mode: 0o700 });
  const lock = await open(lockPath, "wx", 0o600).catch(
    (error: NodeJS.ErrnoException) => {
      if (error.code === "EEXIST")
        throw new Error("Machine initialization is locked by another process");
      throw error;
    },
  );
  try {
    for (const path of plan.directories) await safeMkdir(path);
    for (const write of plan.writes) {
      const current = await optionalRegularFile(write.path);
      if (current !== write.existing)
        throw new Error(
          `Initialization target changed concurrently: ${write.path}`,
        );
      await atomicWrite(write.path, write.source);
    }
    return { status: "APPLIED", changes: plan.changes };
  } finally {
    await lock.close();
    await unlink(lockPath).catch(() => undefined);
  }
}

export async function loadMasterConfig(
  masterHome: string,
): Promise<MasterConfig> {
  const requestedHome = resolve(masterHome);
  await rejectSymlinkAncestors(requestedHome);
  const homeEntry = await lstat(requestedHome).catch(() => undefined);
  if (!homeEntry)
    throw new Error("Forge machine is not initialized; run forge init");
  if (!homeEntry.isDirectory() || homeEntry.isSymbolicLink())
    throw new Error("Forge master home must be a real directory");
  const canonicalHome = await realpath(requestedHome);
  if (canonicalHome !== requestedHome)
    throw new Error("Forge master home identity changed");
  await rejectSymlinkAncestors(canonicalHome);
  const source = await optionalRegularFile(join(canonicalHome, "config.yml"));
  if (!source)
    throw new Error("Forge machine is not initialized; run forge init");
  const config = MasterConfigSchema.parse(
    parse(source, { maxAliasCount: 0, uniqueKeys: true }),
  );
  if (config.registry.path !== join(canonicalHome, "projects.yml"))
    throw new Error("Master registry path does not match Forge master home");
  const roots = await Promise.all(
    [config.forge_root, config.projects_root, config.obsidian_vault].map(
      async (path) => {
        await rejectSymlinkAncestors(path);
        const entry = await lstat(path);
        if (!entry.isDirectory() || entry.isSymbolicLink())
          throw new Error("Master configuration root must be a real directory");
        const canonical = await realpath(path);
        if (canonical !== path)
          throw new Error("Master configuration root identity changed");
        return canonical;
      },
    ),
  );
  assertDistinctRoots([canonicalHome, ...roots]);
  return config;
}

function validateMachineInitPlan(plan: MachineInitPlan): void {
  const config = MasterConfigSchema.parse(plan.config);
  if (
    plan.config_path !== join(plan.master_home, "config.yml") ||
    plan.registry_path !== join(plan.master_home, "projects.yml") ||
    config.registry.path !== plan.registry_path ||
    config.forge_root !== plan.forge_root ||
    config.projects_root !== plan.projects_root ||
    config.obsidian_vault !== plan.obsidian_vault
  )
    throw new Error("Machine initialization plan topology is invalid");
  assertDistinctRoots([
    plan.master_home,
    plan.forge_root,
    plan.projects_root,
    plan.obsidian_vault,
  ]);
  const allowedDirectories = new Set([
    plan.master_home,
    plan.projects_root,
    plan.obsidian_vault,
    join(plan.obsidian_vault, "Projects"),
    join(plan.obsidian_vault, "Cross Project"),
    join(plan.obsidian_vault, "Boss Reports"),
  ]);
  if (
    plan.directories.length !== allowedDirectories.size ||
    plan.directories.some((path) => !allowedDirectories.has(path))
  )
    throw new Error(
      "Machine initialization plan contains an unauthorized directory",
    );
  const allowedWrites = new Set([
    plan.config_path,
    plan.registry_path,
    join(plan.obsidian_vault, "Dashboard.md"),
    join(plan.obsidian_vault, "Cross Project/Active Work.md"),
    join(plan.obsidian_vault, "Cross Project/Blockers.md"),
    join(plan.obsidian_vault, "Cross Project/Reviews.md"),
  ]);
  const writePaths = plan.writes.map(({ path }) => path);
  if (new Set(writePaths).size !== writePaths.length)
    throw new Error("Machine initialization plan contains duplicate writes");
  if (plan.writes.some(({ path }) => !allowedWrites.has(path)))
    throw new Error(
      "Machine initialization plan contains an unauthorized write",
    );
  const configWrite = plan.writes.find(({ path }) => path === plan.config_path);
  if (configWrite) {
    const parsed = MasterConfigSchema.parse(
      parse(configWrite.source, { maxAliasCount: 0, uniqueKeys: true }),
    );
    if (JSON.stringify(parsed) !== JSON.stringify(config))
      throw new Error(
        "Machine initialization config write does not match plan",
      );
  }
  const registryWrite = plan.writes.find(
    ({ path }) => path === plan.registry_path,
  );
  if (registryWrite) {
    const registry = MasterProjectRegistrySchema.parse(
      parse(registryWrite.source, { maxAliasCount: 0, uniqueKeys: true }),
    );
    if (registry.projects.length !== 0 || registry.revision !== 0)
      throw new Error("Initialization may only create an empty registry");
  }
  const managedSources = new Map<string, string>([
    [
      join(plan.obsidian_vault, "Dashboard.md"),
      managed(
        "# Meraki Forge Dashboard\n\nMaster project status, work, blockers, and reviews live here.",
      ),
    ],
    [
      join(plan.obsidian_vault, "Cross Project/Active Work.md"),
      managed("# Active Work\n\nCross-project work summary."),
    ],
    [
      join(plan.obsidian_vault, "Cross Project/Blockers.md"),
      managed("# Blockers\n\nCross-project blockers."),
    ],
    [
      join(plan.obsidian_vault, "Cross Project/Reviews.md"),
      managed("# Reviews\n\nCross-project review queue."),
    ],
  ]);
  for (const write of plan.writes) {
    const generated = managedSources.get(write.path);
    if (
      generated &&
      write.source !== composeMarkdown(write.existing, generated)
    )
      throw new Error("Machine initialization managed Markdown is invalid");
  }
  const changeSet = new Set(plan.changes);
  if (
    changeSet.size !== plan.changes.length ||
    writePaths.some((path) => !changeSet.has(path)) ||
    plan.changes.some(
      (change) =>
        !writePaths.includes(change) &&
        !plan.directories.some((directory) => change === `${directory}/`),
    )
  )
    throw new Error("Machine initialization changes do not match the plan");
}

function inferLegacyRegistryVault(
  registry: ReturnType<typeof MasterProjectRegistrySchema.parse> | undefined,
): string | undefined {
  if (!registry || registry.projects.length === 0) return undefined;
  const roots = new Set<string>();
  for (const project of registry.projects) {
    const projectsDirectory = dirname(project.obsidian_project_path);
    if (parsePath(projectsDirectory).base !== "Projects")
      throw new Error(
        "Legacy registry project path is not inside a Projects directory",
      );
    roots.add(dirname(projectsDirectory));
  }
  if (roots.size !== 1)
    throw new Error("Legacy registry projects do not share one Obsidian vault");
  return [...roots][0];
}

function assertDistinctRoots(roots: readonly string[]): void {
  for (let index = 0; index < roots.length; index += 1)
    for (let other = index + 1; other < roots.length; other += 1) {
      const left = resolve(roots[index]!);
      const right = resolve(roots[other]!);
      if (
        left === right ||
        left.startsWith(`${right}${sep}`) ||
        right.startsWith(`${left}${sep}`)
      )
        throw new Error("Machine authority roots must not overlap");
    }
}

function managed(content: string): string {
  return `${BEGIN}\n${content}\n${END}\n`;
}
function composeMarkdown(
  existing: string | undefined,
  generated: string,
): string {
  if (!existing) return generated;
  const begin = existing.indexOf(BEGIN),
    end = existing.indexOf(END);
  if (
    (begin >= 0 && existing.indexOf(BEGIN, begin + 1) >= 0) ||
    (end >= 0 && existing.indexOf(END, end + 1) >= 0)
  )
    throw new Error("Duplicate managed Markdown markers conflict");
  if (begin < 0 !== end < 0 || (begin >= 0 && end < begin))
    throw new Error("Managed Markdown markers conflict");
  if (begin < 0) return `${existing.trimEnd()}\n\n${generated}`;
  return `${existing.slice(0, begin)}${generated.trimEnd()}${existing.slice(end + END.length)}`;
}
async function canonicalExistingDirectory(
  path: string,
  label: string,
): Promise<string> {
  const canonical = await realpath(resolve(path));
  if (!(await lstat(canonical)).isDirectory())
    throw new Error(`${label} must be a directory`);
  return canonical;
}
async function canonicalPlannedPath(path: string): Promise<string> {
  const requested = resolve(path);
  const missing: string[] = [];
  let ancestor = requested;
  while (true) {
    try {
      const entry = await lstat(ancestor);
      if (entry.isSymbolicLink())
        throw new Error(
          `Initialization path contains a symbolic link: ${ancestor}`,
        );
      if (!entry.isDirectory())
        throw new Error(
          `Initialization ancestor is not a directory: ${ancestor}`,
        );
      return join(await realpath(ancestor), ...missing.reverse());
    } catch (error) {
      if (!isNodeError(error, "ENOENT")) throw error;
      const parent = dirname(ancestor);
      if (parent === ancestor) throw error;
      missing.push(ancestor.slice(parent.length + 1));
      ancestor = parent;
    }
  }
}
async function rejectSymlinkAncestors(path: string): Promise<void> {
  const absolute = resolve(path),
    root = parsePath(absolute).root;
  let current = root;
  for (const part of absolute.slice(root.length).split(sep).filter(Boolean)) {
    current = join(current, part);
    try {
      if ((await lstat(current)).isSymbolicLink())
        throw new Error(
          `Initialization path contains a symbolic link: ${current}`,
        );
    } catch (error) {
      if (isNodeError(error, "ENOENT")) return;
      throw error;
    }
  }
}
async function existingDirectory(path: string): Promise<boolean> {
  try {
    const item = await lstat(path);
    if (item.isSymbolicLink() || !item.isDirectory())
      throw new Error(`Initialization directory conflicts: ${path}`);
    return true;
  } catch (error) {
    if (isNodeError(error, "ENOENT")) return false;
    throw error;
  }
}
async function optionalRegularFile(path: string): Promise<string | undefined> {
  try {
    const item = await lstat(path);
    if (item.isSymbolicLink() || !item.isFile())
      throw new Error(`Initialization file conflicts: ${path}`);
    if (item.size > 4 * 1024 * 1024)
      throw new Error(`Initialization file exceeds 4 MiB: ${path}`);
    return readFile(path, "utf8");
  } catch (error) {
    if (isNodeError(error, "ENOENT")) return undefined;
    throw error;
  }
}
async function safeMkdir(path: string): Promise<void> {
  await rejectSymlinkAncestors(path);
  await mkdir(path, { recursive: true, mode: 0o700 });
  if ((await realpath(path)) !== resolve(path))
    throw new Error(`Initialization directory identity changed: ${path}`);
}
async function atomicWrite(path: string, source: string): Promise<void> {
  const canonicalParent = await realpath(dirname(path));
  if (canonicalParent !== dirname(path))
    throw new Error(`Initialization parent identity changed: ${dirname(path)}`);
  await rejectSymlinkAncestors(dirname(path));
  const temporary = join(dirname(path), `.${randomUUID()}.tmp`);
  const handle = await open(temporary, "wx", 0o600);
  try {
    await handle.writeFile(source);
    await handle.sync();
  } finally {
    await handle.close();
  }
  try {
    await rename(temporary, path);
  } finally {
    await unlink(temporary).catch(() => undefined);
  }
  const directory = await open(dirname(path), "r");
  try {
    await directory.sync();
  } finally {
    await directory.close();
  }
}
function isNodeError(
  error: unknown,
  code: string,
): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error && error.code === code;
}
