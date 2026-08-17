import {
  assertContainedProjectPath,
  projectOperationResult,
  type ProjectOperationResult,
  type ProjectOperationStage,
} from "../../kernel/src/project-operation.js";
import type { ProjectMutationResult } from "./project-create-service.js";

export interface ProjectOnboardInput {
  readonly project_id: string;
  readonly display_name: string;
  readonly repository_path: string;
  readonly graphify_path: string;
  readonly obsidian_project_path: string;
  readonly stack: readonly string[];
  readonly dry_run?: boolean;
}
export interface ProjectOnboardEffects {
  readonly inspect: (path: string) => Promise<Readonly<{ valid_git: boolean }>>;
  readonly bootstrap: (path: string) => Promise<ProjectMutationResult>;
  readonly initializeGraphify: (
    input: Readonly<{ repository_path: string; graphify_path: string }>,
  ) => Promise<ProjectMutationResult>;
  readonly indexGraphify: (path: string) => Promise<ProjectMutationResult>;
  readonly proposeOwnership: (path: string) => Promise<ProjectMutationResult>;
  readonly register: (
    input: Readonly<{
      project_id: string;
      display_name: string;
      repository_path: string;
      graphify_path: string;
      obsidian_project_path: string;
      stack: readonly string[];
    }>,
  ) => Promise<ProjectMutationResult>;
  readonly createObsidianProject: (
    path: string,
  ) => Promise<ProjectMutationResult>;
  readonly validate: (path: string) => Promise<boolean>;
  readonly doctor: (path: string) => Promise<boolean>;
}
const ONBOARD_STAGES: readonly ProjectOperationStage[] = [
  "INSPECT",
  "BOOTSTRAP",
  "GRAPHIFY_INITIALIZE",
  "GRAPHIFY_INDEX",
  "OWNERSHIP_PROPOSAL",
  "REGISTER",
  "OBSIDIAN_PROJECT",
  "VALIDATE",
  "DOCTOR",
];

export async function onboardProject(
  input: ProjectOnboardInput,
  effects: ProjectOnboardEffects,
): Promise<ProjectOperationResult> {
  if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/u.test(input.project_id))
    throw new Error("Invalid deterministic project ID");
  if (!input.display_name.trim()) throw new Error("Display name is required");
  assertContainedProjectPath(input.repository_path, input.graphify_path);
  if (input.dry_run)
    return projectOperationResult({
      schema_version: "1",
      kind: "ONBOARD",
      status: "DRY_RUN",
      project_id: input.project_id,
      repository_path: input.repository_path,
      steps: ONBOARD_STAGES.map((stage) => ({
        stage,
        status: "PLANNED",
        detail: `Would run ${stage}`,
      })),
      next_actions: [],
    });
  const steps: Array<ProjectOperationResult["steps"][number]> = [];
  const mutate = async (
    stage: ProjectOperationStage,
    action: () => Promise<ProjectMutationResult>,
  ) => {
    const state = await action();
    steps.push({
      stage,
      status: state === "CHANGED" ? "COMPLETED" : "UNCHANGED",
      detail: state,
    });
  };
  try {
    const inspection = await effects.inspect(input.repository_path);
    steps.push({
      stage: "INSPECT",
      status: inspection.valid_git ? "COMPLETED" : "FAILED",
      detail: inspection.valid_git
        ? "Git repository inspected"
        : "Git repository is invalid",
    });
    if (!inspection.valid_git)
      return notReady(
        input,
        steps,
        "Provide an accessible existing Git repository.",
      );
    await mutate("BOOTSTRAP", () => effects.bootstrap(input.repository_path));
    await mutate("GRAPHIFY_INITIALIZE", () =>
      effects.initializeGraphify({
        repository_path: input.repository_path,
        graphify_path: input.graphify_path,
      }),
    );
    await mutate("GRAPHIFY_INDEX", () =>
      effects.indexGraphify(input.repository_path),
    );
    await mutate("OWNERSHIP_PROPOSAL", () =>
      effects.proposeOwnership(input.repository_path),
    );
    await mutate("REGISTER", () =>
      effects.register({
        project_id: input.project_id,
        display_name: input.display_name,
        repository_path: input.repository_path,
        graphify_path: input.graphify_path,
        obsidian_project_path: input.obsidian_project_path,
        stack: input.stack,
      }),
    );
    await mutate("OBSIDIAN_PROJECT", () =>
      effects.createObsidianProject(input.obsidian_project_path),
    );
    const valid = await effects.validate(input.repository_path);
    steps.push({
      stage: "VALIDATE",
      status: valid ? "COMPLETED" : "FAILED",
      detail: valid ? "Validation passed" : "Validation failed",
    });
    if (!valid)
      return notReady(
        input,
        steps,
        "Resolve Forge validation failures, then rerun project onboard.",
      );
    const healthy = await effects.doctor(input.repository_path);
    steps.push({
      stage: "DOCTOR",
      status: healthy ? "COMPLETED" : "FAILED",
      detail: healthy ? "Doctor passed" : "Doctor reported not ready",
    });
    if (!healthy)
      return notReady(
        input,
        steps,
        "Resolve forge doctor failures, then rerun project onboard.",
      );
    return projectOperationResult({
      schema_version: "1",
      kind: "ONBOARD",
      status: "READY",
      project_id: input.project_id,
      repository_path: input.repository_path,
      steps,
      next_actions: [],
    });
  } catch (error) {
    return notReady(
      input,
      steps,
      error instanceof Error ? error.message : "Unknown onboarding failure",
    );
  }
}
function notReady(
  input: ProjectOnboardInput,
  steps: ProjectOperationResult["steps"],
  action: string,
): ProjectOperationResult {
  return projectOperationResult({
    schema_version: "1",
    kind: "ONBOARD",
    status: "NOT_READY",
    project_id: input.project_id,
    repository_path: input.repository_path,
    steps,
    next_actions: [action],
  });
}
