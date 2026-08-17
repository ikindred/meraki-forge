import { isAbsolute, relative, resolve } from "node:path";
import { deepFreeze } from "./contracts.js";

export const PROJECT_OPERATION_STAGES = [
  "INSPECT",
  "CREATE_DIRECTORY",
  "SCAFFOLD",
  "INITIALIZE_GIT",
  "BASELINE_COMMIT",
  "BOOTSTRAP",
  "GRAPHIFY_INITIALIZE",
  "GRAPHIFY_INDEX",
  "OWNERSHIP_PROPOSAL",
  "REGISTER",
  "OBSIDIAN_PROJECT",
  "TOOLING",
  "VALIDATE",
  "DOCTOR",
] as const;
export type ProjectOperationStage = (typeof PROJECT_OPERATION_STAGES)[number];
export type ProjectOperationKind = "CREATE" | "ONBOARD";

export interface ProjectOperationStep {
  readonly stage: ProjectOperationStage;
  readonly status: "PLANNED" | "COMPLETED" | "UNCHANGED" | "FAILED";
  readonly detail: string;
}
export interface ProjectOperationResult {
  readonly schema_version: "1";
  readonly kind: ProjectOperationKind;
  readonly status: "DRY_RUN" | "READY" | "NOT_READY";
  readonly project_id: string;
  readonly repository_path: string;
  readonly steps: readonly ProjectOperationStep[];
  readonly next_actions: readonly string[];
}

export function assertSingleProjectWrite(
  registeredRepository: string,
  requestedRepository: string,
): void {
  if (!isAbsolute(registeredRepository) || !isAbsolute(requestedRepository))
    throw new Error("Project write paths must be absolute");
  if (resolve(registeredRepository) !== resolve(requestedRepository))
    throw new Error("CROSS_PROJECT_WRITE_FORBIDDEN");
}

export function assertContainedProjectPath(
  repositoryRoot: string,
  target: string,
): void {
  if (!isAbsolute(repositoryRoot) || !isAbsolute(target))
    throw new Error("Project paths must be absolute");
  const rel = relative(resolve(repositoryRoot), resolve(target));
  if (rel.startsWith("..") || isAbsolute(rel))
    throw new Error("PROJECT_PATH_ESCAPE");
}

export function projectOperationResult(
  value: ProjectOperationResult,
): ProjectOperationResult {
  return deepFreeze(value);
}
