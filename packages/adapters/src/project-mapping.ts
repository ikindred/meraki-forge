import { lstat, realpath } from "node:fs/promises";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import { z } from "zod";

export class ProjectMappingError extends Error {
  override readonly name = "ProjectMappingError";
}

const SafeRelativePath = z
  .string()
  .min(1)
  .refine(
    (value) =>
      !isAbsolute(value) &&
      !value.split(/[\\/]/u).some((part) => part === ".." || part === ""),
    "Path must be a normalized relative path",
  );
const ForgeRelativePath = SafeRelativePath.refine(
  (value) => value !== ".",
  "Forge roots must not be the repository root",
);

export const ProjectMappingConfigSchema = z
  .object({
    project: z
      .object({
        id: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]*$/u),
        name: z.string().min(1),
        repository_path: z.string().min(1),
        default_branch: z
          .string()
          .regex(/^(?!.*(?:\.\.|@\{|[~^:?*\x5b\\]))(?!\/)(?!.*\/$).+$/u),
      })
      .strict(),
    obsidian: z
      .object({
        vault_path: z.string().min(1),
        command_center_path: SafeRelativePath,
        tasks: SafeRelativePath,
        orchestrator: SafeRelativePath,
        daily_plans: SafeRelativePath,
        reports: SafeRelativePath,
      })
      .strict(),
    forge: z
      .object({
        state_root: ForgeRelativePath,
        artifact_root: ForgeRelativePath,
      })
      .strict(),
  })
  .strict();

export type ProjectMappingConfig = z.infer<typeof ProjectMappingConfigSchema>;
export type ResolvedProjectMapping = Readonly<{
  project: Readonly<
    Omit<ProjectMappingConfig["project"], "repository_path"> & {
      repository_path: string;
    }
  >;
  obsidian: Readonly<{
    vault_path: string;
    command_center_path: string;
    tasks: string;
    orchestrator: string;
    daily_plans: string;
    reports: string;
  }>;
  forge: Readonly<{ state_root: string; artifact_root: string }>;
}>;

/** Resolve the configured command center once; task content cannot select a repository. */
export async function resolveProjectMapping(
  input: unknown,
): Promise<ResolvedProjectMapping> {
  try {
    const config = ProjectMappingConfigSchema.parse(input);
    if (
      !isAbsolute(config.project.repository_path) ||
      !isAbsolute(config.obsidian.vault_path)
    ) {
      throw new ProjectMappingError(
        "Repository and vault paths must be absolute",
      );
    }
    const repository = await realDirectory(
      config.project.repository_path,
      "repository",
    );
    const vault = await realDirectory(config.obsidian.vault_path, "vault");
    const commandCandidate = contained(
      vault,
      config.obsidian.command_center_path,
    );
    await rejectSymlinkComponents(vault, commandCandidate);
    const commandCenter = await realDirectory(
      commandCandidate,
      "command center",
    );
    assertContained(vault, commandCenter);
    const child = (path: string): string => contained(commandCenter, path);
    const stateRoot = contained(repository, config.forge.state_root);
    const artifactRoot = contained(repository, config.forge.artifact_root);
    if (stateRoot === artifactRoot) {
      throw new ProjectMappingError(
        "State and artifact roots must be distinct",
      );
    }
    return deepFreeze({
      project: { ...config.project, repository_path: repository },
      obsidian: {
        vault_path: vault,
        command_center_path: commandCenter,
        tasks: child(config.obsidian.tasks),
        orchestrator: child(config.obsidian.orchestrator),
        daily_plans: child(config.obsidian.daily_plans),
        reports: child(config.obsidian.reports),
      },
      forge: { state_root: stateRoot, artifact_root: artifactRoot },
    });
  } catch (error) {
    if (error instanceof ProjectMappingError) throw error;
    throw new ProjectMappingError(`Invalid project mapping: ${message(error)}`);
  }
}

async function realDirectory(path: string, label: string): Promise<string> {
  const canonical = await realpath(resolve(path));
  const entry = await lstat(canonical);
  if (!entry.isDirectory())
    throw new ProjectMappingError(`${label} must be a directory`);
  return canonical;
}

async function rejectSymlinkComponents(
  root: string,
  target: string,
): Promise<void> {
  let current = root;
  for (const part of relative(root, target).split(sep).filter(Boolean)) {
    current = join(current, part);
    const entry = await lstat(current);
    if (entry.isSymbolicLink())
      throw new ProjectMappingError(
        "Mapping paths must not contain symbolic links",
      );
  }
}

function contained(root: string, path: string): string {
  const candidate = resolve(root, path);
  assertContained(root, candidate);
  return candidate;
}

function assertContained(root: string, candidate: string): void {
  const rel = relative(root, candidate);
  if (rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel)) {
    throw new ProjectMappingError("Configured path escapes its owning root");
  }
}

function deepFreeze<T>(value: T): T {
  if (value && typeof value === "object") {
    for (const child of Object.values(value)) deepFreeze(child);
    Object.freeze(value);
  }
  return value;
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
