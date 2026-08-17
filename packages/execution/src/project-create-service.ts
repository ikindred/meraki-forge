import {
  assertContainedProjectPath,
  projectOperationResult,
  type ProjectOperationResult,
  type ProjectOperationStage,
} from "../../kernel/src/project-operation.js";
import type { TechnologyDecision } from "../../kernel/src/technology-policy.js";

export type ProjectMutationResult = "CHANGED" | "UNCHANGED";
export interface ProjectCreateInput {
  readonly project_id: string;
  readonly display_name: string;
  readonly repository_path: string;
  readonly graphify_path: string;
  readonly obsidian_project_path: string;
  readonly technology: TechnologyDecision;
  readonly architecture_approved: boolean;
  readonly dry_run?: boolean;
}
export interface ProjectCreateEffects {
  readonly createDirectory: (path: string) => Promise<ProjectMutationResult>;
  readonly scaffold: (
    input: Readonly<{ repository_path: string; stack: readonly string[] }>,
  ) => Promise<ProjectMutationResult>;
  readonly initializeGit: (path: string) => Promise<ProjectMutationResult>;
  readonly createBaselineCommit: (
    path: string,
  ) => Promise<ProjectMutationResult>;
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
  readonly configureTooling: (path: string) => Promise<ProjectMutationResult>;
  readonly validate: (path: string) => Promise<boolean>;
  readonly doctor: (path: string) => Promise<boolean>;
}

const CREATE_STAGES: readonly ProjectOperationStage[] = [
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
];

export async function createProject(
  input: ProjectCreateInput,
  effects: ProjectCreateEffects,
): Promise<ProjectOperationResult> {
  validateInput(input);
  if (input.technology.requires_human_approval && !input.architecture_approved)
    return projectOperationResult({
      schema_version: "1",
      kind: "CREATE",
      status: "NOT_READY",
      project_id: input.project_id,
      repository_path: input.repository_path,
      steps: [],
      next_actions: [
        "Approve the proposed architecture before project creation.",
      ],
    });
  if (input.dry_run)
    return projectOperationResult({
      schema_version: "1",
      kind: "CREATE",
      status: "DRY_RUN",
      project_id: input.project_id,
      repository_path: input.repository_path,
      steps: CREATE_STAGES.map((stage) => ({
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
    await mutate("CREATE_DIRECTORY", () =>
      effects.createDirectory(input.repository_path),
    );
    await mutate("SCAFFOLD", () =>
      effects.scaffold({
        repository_path: input.repository_path,
        stack: input.technology.stack,
      }),
    );
    await mutate("INITIALIZE_GIT", () =>
      effects.initializeGit(input.repository_path),
    );
    await mutate("BASELINE_COMMIT", () =>
      effects.createBaselineCommit(input.repository_path),
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
        stack: input.technology.stack,
      }),
    );
    await mutate("OBSIDIAN_PROJECT", () =>
      effects.createObsidianProject(input.obsidian_project_path),
    );
    await mutate("TOOLING", () =>
      effects.configureTooling(input.repository_path),
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
        "Resolve Forge validation failures, then rerun project create.",
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
        "Resolve forge doctor failures, then rerun project create.",
      );
    return projectOperationResult({
      schema_version: "1",
      kind: "CREATE",
      status: "READY",
      project_id: input.project_id,
      repository_path: input.repository_path,
      steps,
      next_actions: [],
    });
  } catch (error) {
    const message =
      error instanceof Error
        ? error.message
        : "Unknown project creation failure";
    return notReady(input, steps, message);
  }
}

function validateInput(input: ProjectCreateInput): void {
  if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/u.test(input.project_id))
    throw new Error("Invalid deterministic project ID");
  if (!input.display_name.trim()) throw new Error("Display name is required");
  assertContainedProjectPath(input.repository_path, input.graphify_path);
}
function notReady(
  input: ProjectCreateInput,
  steps: ProjectOperationResult["steps"],
  action: string,
): ProjectOperationResult {
  return projectOperationResult({
    schema_version: "1",
    kind: "CREATE",
    status: "NOT_READY",
    project_id: input.project_id,
    repository_path: input.repository_path,
    steps,
    next_actions: [action],
  });
}
