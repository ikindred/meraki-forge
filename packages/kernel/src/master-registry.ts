import { z } from "zod";
import { deepFreeze } from "./contracts.js";

const AbsolutePath = z
  .string()
  .min(1)
  .refine(
    (value) => value.startsWith("/") || /^[A-Za-z]:[\\/]/.test(value),
    "Path must be absolute",
  );
const ProjectId = z.string().regex(/^[a-z0-9][a-z0-9-]{0,62}$/);
const Alias = z.string().regex(/^[a-z0-9][a-z0-9-]{0,62}$/);

export const RegisteredProjectSchema = z
  .object({
    project_id: ProjectId,
    display_name: z.string().trim().min(1).max(120),
    repo_path: AbsolutePath,
    forge_config_path: AbsolutePath,
    graphify_path: AbsolutePath,
    obsidian_project_path: AbsolutePath,
    stack_summary: z.string().trim().min(1).max(1000),
    registration_status: z.enum(["ACTIVE", "INACTIVE"]),
    aliases: z.array(Alias).default([]),
    registered_at: z.iso.datetime(),
    updated_at: z.iso.datetime(),
    record_version: z.number().int().positive(),
  })
  .strict()
  .readonly();
export type RegisteredProject = z.infer<typeof RegisteredProjectSchema>;

export const MasterProjectRegistrySchema = z
  .object({
    schema_version: z.literal("1"),
    revision: z.number().int().nonnegative(),
    updated_at: z.iso.datetime(),
    shared_vault_path: AbsolutePath.nullable().default(null),
    projects: z.array(RegisteredProjectSchema),
  })
  .strict()
  .superRefine((registry, context) => {
    const ids = new Set<string>();
    const repos = new Set<string>();
    const obsidianPaths = new Set<string>();
    registry.projects.forEach((project, index) => {
      if (ids.has(project.project_id))
        context.addIssue({
          code: "custom",
          path: ["projects", index, "project_id"],
          message: "Duplicate project id",
        });
      if (repos.has(project.repo_path))
        context.addIssue({
          code: "custom",
          path: ["projects", index, "repo_path"],
          message: "Duplicate repository path",
        });
      if (obsidianPaths.has(project.obsidian_project_path))
        context.addIssue({
          code: "custom",
          path: ["projects", index, "obsidian_project_path"],
          message: "Duplicate Obsidian project path",
        });
      ids.add(project.project_id);
      repos.add(project.repo_path);
      obsidianPaths.add(project.obsidian_project_path);
    });
  })
  .readonly();
export type MasterProjectRegistry = z.infer<typeof MasterProjectRegistrySchema>;

export function emptyMasterProjectRegistry(
  at = new Date().toISOString(),
): MasterProjectRegistry {
  return deepFreeze(
    MasterProjectRegistrySchema.parse({
      schema_version: "1",
      revision: 0,
      updated_at: at,
      shared_vault_path: null,
      projects: [],
    }),
  );
}

/** Stable human-name normalization. Collisions are intentionally not disambiguated. */
export function normalizeProjectAlias(value: string): string {
  return value
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/gu, "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/gu, "-")
    .replace(/^-+|-+$/gu, "");
}

export function deterministicProjectId(displayName: string): string {
  const normalized = normalizeProjectAlias(displayName);
  if (!normalized)
    throw new Error("Project name cannot produce a safe project id");
  return ProjectId.parse(normalized.slice(0, 63).replace(/-+$/u, ""));
}
