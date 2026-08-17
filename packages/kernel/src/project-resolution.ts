import type {
  MasterProjectRegistry,
  RegisteredProject,
} from "./master-registry.js";
import { normalizeProjectAlias } from "./master-registry.js";

export type ProjectResolution =
  | Readonly<{
      status: "RESOLVED";
      reference: string;
      project: RegisteredProject;
    }>
  | Readonly<{
      status: "NOT_FOUND" | "AMBIGUOUS";
      reference: string;
      candidate_project_ids: readonly string[];
    }>;

export function resolveProject(
  registry: MasterProjectRegistry,
  reference: string,
): ProjectResolution {
  const exactId = registry.projects.filter(
    (project) => project.project_id === reference.trim(),
  );
  const exactName = registry.projects.filter(
    (project) => project.display_name === reference.trim(),
  );
  const normalized = normalizeProjectAlias(reference);
  const aliases = registry.projects.filter((project) =>
    project.aliases.includes(normalized),
  );
  const candidates = exactId.length
    ? exactId
    : exactName.length
      ? exactName
      : aliases;
  if (candidates.length === 1)
    return Object.freeze({
      status: "RESOLVED",
      reference,
      project: candidates[0]!,
    });
  return Object.freeze({
    status: candidates.length ? "AMBIGUOUS" : "NOT_FOUND",
    reference,
    candidate_project_ids: Object.freeze(
      candidates.map((project) => project.project_id).sort(),
    ),
  });
}

export type ProjectSetResolution =
  | Readonly<{
      status: "RESOLVED";
      projects: readonly RegisteredProject[];
      project_ids: readonly string[];
    }>
  | Readonly<{ status: "UNRESOLVED"; results: readonly ProjectResolution[] }>
  | Readonly<{
      status: "DENIED";
      reason: "CROSS_PROJECT_WRITE_FORBIDDEN";
      project_ids: readonly string[];
    }>;

export function resolveProjectReferences(
  registry: MasterProjectRegistry,
  references: readonly string[],
  operation: "READ" | "WRITE",
): ProjectSetResolution {
  const results = references.map((reference) =>
    resolveProject(registry, reference),
  );
  if (results.some((result) => result.status !== "RESOLVED"))
    return Object.freeze({
      status: "UNRESOLVED",
      results: Object.freeze(results),
    });
  const projects = [
    ...new Map(
      results.map((result) => {
        const project = (
          result as Extract<ProjectResolution, { status: "RESOLVED" }>
        ).project;
        return [project.project_id, project] as const;
      }),
    ).values(),
  ];
  const projectIds = Object.freeze(
    projects.map((project) => project.project_id),
  );
  if (operation === "WRITE" && projects.length !== 1)
    return Object.freeze({
      status: "DENIED",
      reason: "CROSS_PROJECT_WRITE_FORBIDDEN",
      project_ids: projectIds,
    });
  return Object.freeze({
    status: "RESOLVED",
    projects: Object.freeze(projects),
    project_ids: projectIds,
  });
}
