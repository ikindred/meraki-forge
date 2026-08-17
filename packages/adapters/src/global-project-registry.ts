import { randomUUID } from "node:crypto";
import {
  lstat,
  open,
  readFile,
  realpath,
  rename,
  unlink,
} from "node:fs/promises";
import { basename, dirname, isAbsolute, relative, resolve } from "node:path";
import { parse, stringify } from "yaml";
import { z } from "zod";
import {
  MasterProjectRegistrySchema,
  RegisteredProjectSchema,
  emptyMasterProjectRegistry,
  type MasterProjectRegistry,
  type RegisteredProject,
} from "../../kernel/src/master-registry.js";

const RegistrationInputSchema = RegisteredProjectSchema.unwrap()
  .omit({ registered_at: true, updated_at: true, record_version: true })
  .strict();
export type ProjectRegistrationInput = z.input<typeof RegistrationInputSchema>;

export class RegistryConflictError extends Error {
  readonly code = "PROJECT_REGISTRY_CONFLICT";
}
export class RegistryLockError extends Error {
  readonly code = "PROJECT_REGISTRY_LOCKED";
}

export class GlobalProjectRegistry {
  readonly #registryPath: string;
  readonly #now: () => Date;

  constructor(
    registryPath: string,
    options: Readonly<{ now?: () => Date }> = {},
  ) {
    if (!isAbsolute(registryPath))
      throw new Error("Registry path must be absolute");
    this.#registryPath = resolve(registryPath);
    this.#now = options.now ?? (() => new Date());
  }

  async load(): Promise<MasterProjectRegistry> {
    const path = await this.#validatedPath();
    return this.#read(path);
  }

  async register(
    input: ProjectRegistrationInput,
    options: Readonly<{ expectedRevision?: number }> = {},
  ): Promise<
    Readonly<{
      created: boolean;
      project: RegisteredProject;
      registry: MasterProjectRegistry;
    }>
  > {
    const path = await this.#validatedPath();
    const lockPath = `${path}.lock`;
    let lock: Awaited<ReturnType<typeof open>> | undefined;
    try {
      lock = await open(lockPath, "wx", 0o600).catch(
        (error: NodeJS.ErrnoException) => {
          if (error.code === "EEXIST")
            throw new RegistryLockError(
              "Project registry is locked by another writer",
            );
          throw error;
        },
      );
      await lock.writeFile(`${process.pid}\n`, "utf8");
      await lock.sync();
      const registry = await this.#read(path);
      if (
        options.expectedRevision !== undefined &&
        registry.revision !== options.expectedRevision
      )
        throw new RegistryConflictError(
          `Registry revision mismatch: expected ${options.expectedRevision}, found ${registry.revision}`,
        );
      const canonical = await canonicalRegistration(input);
      const projectsDirectory = dirname(canonical.obsidian_project_path);
      if (basename(projectsDirectory) !== "Projects")
        throw new RegistryConflictError(
          "Obsidian project path must be inside the shared vault Projects directory",
        );
      const sharedVault = dirname(projectsDirectory);
      if (
        registry.shared_vault_path &&
        registry.shared_vault_path !== sharedVault
      )
        throw new RegistryConflictError(
          "All registered projects must use the same shared Obsidian vault",
        );
      const byId = registry.projects.find(
        (project) => project.project_id === canonical.project_id,
      );
      const byRepo = registry.projects.find(
        (project) => project.repo_path === canonical.repo_path,
      );
      if (byId || byRepo) {
        if (byId && byRepo === byId && sameRegistration(byId, canonical))
          return Object.freeze({ created: false, project: byId, registry });
        throw new RegistryConflictError(
          byId
            ? `Project id is already registered: ${canonical.project_id}`
            : `Repository is already registered: ${canonical.repo_path}`,
        );
      }
      const timestamp = this.#now().toISOString();
      const project = RegisteredProjectSchema.parse({
        ...canonical,
        registered_at: timestamp,
        updated_at: timestamp,
        record_version: 1,
      });
      const next = MasterProjectRegistrySchema.parse({
        ...registry,
        revision: registry.revision + 1,
        updated_at: timestamp,
        shared_vault_path: registry.shared_vault_path ?? sharedVault,
        projects: [...registry.projects, project].sort((left, right) =>
          left.project_id.localeCompare(right.project_id),
        ),
      });
      await atomicWrite(path, stringify(next, { sortMapEntries: true }));
      return Object.freeze({ created: true, project, registry: next });
    } finally {
      await lock?.close();
      if (lock) await unlink(lockPath).catch(() => undefined);
    }
  }

  async unregister(
    projectId: string,
    options: Readonly<{ expectedRevision?: number }> = {},
  ): Promise<Readonly<{ removed: boolean; registry: MasterProjectRegistry }>> {
    const path = await this.#validatedPath();
    const lockPath = `${path}.lock`;
    let lock: Awaited<ReturnType<typeof open>> | undefined;
    try {
      lock = await open(lockPath, "wx", 0o600).catch(
        (error: NodeJS.ErrnoException) => {
          if (error.code === "EEXIST")
            throw new RegistryLockError(
              "Project registry is locked by another writer",
            );
          throw error;
        },
      );
      const registry = await this.#read(path);
      if (
        options.expectedRevision !== undefined &&
        registry.revision !== options.expectedRevision
      )
        throw new RegistryConflictError("Registry revision mismatch");
      if (
        !registry.projects.some((project) => project.project_id === projectId)
      )
        return Object.freeze({ removed: false, registry });
      const timestamp = this.#now().toISOString();
      const next = MasterProjectRegistrySchema.parse({
        ...registry,
        revision: registry.revision + 1,
        updated_at: timestamp,
        projects: registry.projects.filter(
          (project) => project.project_id !== projectId,
        ),
      });
      await atomicWrite(path, stringify(next, { sortMapEntries: true }));
      return Object.freeze({ removed: true, registry: next });
    } finally {
      await lock?.close();
      if (lock) await unlink(lockPath).catch(() => undefined);
    }
  }

  async update(
    projectId: string,
    patch: Readonly<{
      registration_status?: "ACTIVE" | "INACTIVE";
      stack_summary?: string;
    }>,
    options: Readonly<{ expectedRevision?: number }> = {},
  ): Promise<MasterProjectRegistry> {
    const path = await this.#validatedPath();
    const lockPath = `${path}.lock`;
    let lock: Awaited<ReturnType<typeof open>> | undefined;
    try {
      lock = await open(lockPath, "wx", 0o600).catch(
        (error: NodeJS.ErrnoException) => {
          if (error.code === "EEXIST")
            throw new RegistryLockError(
              "Project registry is locked by another writer",
            );
          throw error;
        },
      );
      const registry = await this.#read(path);
      if (
        options.expectedRevision !== undefined &&
        registry.revision !== options.expectedRevision
      )
        throw new RegistryConflictError("Registry revision mismatch");
      if (
        !registry.projects.some((project) => project.project_id === projectId)
      )
        throw new RegistryConflictError(
          `Project is not registered: ${projectId}`,
        );
      const timestamp = this.#now().toISOString();
      const next = MasterProjectRegistrySchema.parse({
        ...registry,
        revision: registry.revision + 1,
        updated_at: timestamp,
        projects: registry.projects.map((project) =>
          project.project_id === projectId
            ? {
                ...project,
                ...patch,
                updated_at: timestamp,
                record_version: project.record_version + 1,
              }
            : project,
        ),
      });
      await atomicWrite(path, stringify(next, { sortMapEntries: true }));
      return next;
    } finally {
      await lock?.close();
      if (lock) await unlink(lockPath).catch(() => undefined);
    }
  }

  async #validatedPath(): Promise<string> {
    const parentEntry = await lstat(dirname(this.#registryPath)).catch(
      () => undefined,
    );
    if (parentEntry?.isSymbolicLink())
      throw new Error("Registry parent must not be a symbolic link");
    const parent = await realpath(dirname(this.#registryPath)).catch(() => {
      throw new Error("Registry parent directory is missing or inaccessible");
    });
    const path = resolve(
      parent,
      this.#registryPath.slice(dirname(this.#registryPath).length + 1),
    );
    assertContained(parent, path);
    const entry = await lstat(path).catch((error: NodeJS.ErrnoException) =>
      error.code === "ENOENT" ? undefined : Promise.reject(error),
    );
    if (entry?.isSymbolicLink())
      throw new Error("Registry path must not be a symbolic link");
    if (entry && !entry.isFile())
      throw new Error("Registry path must be a regular file");
    const lock = await lstat(`${path}.lock`).catch(
      (error: NodeJS.ErrnoException) =>
        error.code === "ENOENT" ? undefined : Promise.reject(error),
    );
    if (lock?.isSymbolicLink())
      throw new Error("Registry lock must not be a symbolic link");
    return path;
  }

  async #read(path: string): Promise<MasterProjectRegistry> {
    const source = await readFile(path, "utf8").catch(
      (error: NodeJS.ErrnoException) => {
        if (error.code === "ENOENT") return undefined;
        throw error;
      },
    );
    if (source === undefined)
      return emptyMasterProjectRegistry(this.#now().toISOString());
    if (Buffer.byteLength(source, "utf8") > 4 * 1024 * 1024)
      throw new Error("Project registry exceeds 4 MiB");
    return MasterProjectRegistrySchema.parse(
      parse(source, { maxAliasCount: 0, uniqueKeys: true }),
    );
  }
}

async function canonicalRegistration(
  input: ProjectRegistrationInput,
): Promise<z.output<typeof RegistrationInputSchema>> {
  const parsed = RegistrationInputSchema.parse(input);
  const repo = await canonicalDirectory(parsed.repo_path, "Repository");
  const forgeConfig = await canonicalFile(
    parsed.forge_config_path,
    "Forge config",
  );
  const graphify = await canonicalDirectory(
    parsed.graphify_path,
    "Graphify index",
  );
  const obsidian = await canonicalDirectory(
    parsed.obsidian_project_path,
    "Obsidian project path",
  );
  assertContained(repo, forgeConfig);
  assertContained(repo, graphify);
  return RegistrationInputSchema.parse({
    ...parsed,
    repo_path: repo,
    forge_config_path: forgeConfig,
    graphify_path: graphify,
    obsidian_project_path: obsidian,
  });
}

async function canonicalDirectory(
  path: string,
  label: string,
): Promise<string> {
  const canonical = await realpath(path).catch(() => {
    throw new Error(`${label} is missing or inaccessible`);
  });
  if (!(await lstat(canonical)).isDirectory())
    throw new Error(`${label} must be a directory`);
  return canonical;
}
async function canonicalFile(path: string, label: string): Promise<string> {
  const canonical = await realpath(path).catch(() => {
    throw new Error(`${label} is missing or inaccessible`);
  });
  if (!(await lstat(canonical)).isFile())
    throw new Error(`${label} must be a regular file`);
  return canonical;
}
function assertContained(root: string, target: string): void {
  const path = relative(root, target);
  if (
    path === ".." ||
    path.startsWith(`..${process.platform === "win32" ? "\\" : "/"}`) ||
    isAbsolute(path)
  )
    throw new Error(`Path escapes repository: ${target}`);
}
function sameRegistration(
  existing: RegisteredProject,
  input: z.output<typeof RegistrationInputSchema>,
): boolean {
  return (
    (
      [
        "project_id",
        "display_name",
        "repo_path",
        "forge_config_path",
        "graphify_path",
        "obsidian_project_path",
        "stack_summary",
        "registration_status",
      ] as const
    ).every((key) => existing[key] === input[key]) &&
    JSON.stringify(existing.aliases) === JSON.stringify(input.aliases)
  );
}
async function atomicWrite(path: string, source: string): Promise<void> {
  const temporaryPath = `${path}.tmp.${randomUUID()}`;
  const temporary = await open(temporaryPath, "wx", 0o600);
  try {
    await temporary.writeFile(source, "utf8");
    await temporary.sync();
  } finally {
    await temporary.close();
  }
  try {
    await rename(temporaryPath, path);
    const directory = await open(dirname(path), "r");
    try {
      await directory.sync();
    } finally {
      await directory.close();
    }
  } catch (error) {
    await unlink(temporaryPath).catch(() => undefined);
    throw error;
  }
}
