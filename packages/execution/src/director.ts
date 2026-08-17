import {
  ExecutionManifestSchema,
  ProjectPolicySchema,
  TaskContractSchema,
  claimLease,
  classifyRisk,
  detectStack,
  routeTask,
  takeOverStaleLease,
  type OwnershipRule,
  type Persona,
  type TaskContract,
  type TaskLease,
  type TaskState,
} from "../../kernel/src/index.js";
import type { RepoFile } from "../../kernel/src/stack.js";
import type { z } from "zod";

export interface DirectorWorkspace {
  createOrReuse(
    taskId: string,
    baseBranch: string,
  ): Promise<{
    readonly branch: string;
    readonly path: string;
    readonly baseCommit: string;
    readonly currentCommit: string;
    readonly reused: boolean;
  }>;
}
export interface DirectorRepository {
  loadTask(taskId: string): Promise<TaskContract>;
  loadTaskState(taskId: string): Promise<TaskState>;
  loadLease(taskId: string): Promise<TaskLease | undefined>;
  saveExecution(
    taskId: string,
    manifest: z.infer<typeof ExecutionManifestSchema>,
    lease: TaskLease,
    expectedRevision: number,
  ): Promise<void>;
}
export interface DirectorInput {
  readonly task_id: string;
  readonly run_id: string;
  readonly lease_owner: string;
  readonly now: string;
  readonly lease_until: string;
  readonly base_branch: string;
  readonly repository_files: readonly RepoFile[];
  readonly configured_owners: readonly Persona[];
  readonly ownership_rules: readonly OwnershipRule[];
  readonly grants: Readonly<Record<string, readonly string[]>>;
  readonly policy: z.infer<typeof ProjectPolicySchema>;
  readonly stale_takeover_revision?: number;
}
export interface DirectorResult {
  readonly manifest: z.infer<typeof ExecutionManifestSchema>;
  readonly lease: TaskLease;
  readonly worktree_reused: boolean;
}

export class ForgeDirector {
  constructor(
    private readonly repository: DirectorRepository,
    private readonly workspace: DirectorWorkspace,
  ) {}

  async start(input: DirectorInput): Promise<DirectorResult> {
    const task = TaskContractSchema.parse(
      await this.repository.loadTask(input.task_id),
    );
    const state = await this.repository.loadTaskState(input.task_id);
    const existingLease = await this.repository.loadLease(input.task_id);
    const initialClaim =
      state.status === "READY" && state.phase === "AUTHORIZED";
    const explicitTakeover =
      existingLease !== undefined &&
      input.stale_takeover_revision !== undefined;
    if (!initialClaim && !explicitTakeover)
      throw new Error("Director may claim only READY authorized tasks");
    if (existingLease && !explicitTakeover)
      claimLease({
        task_id: task.id,
        status: state.status,
        authorized: true,
        owner: input.lease_owner,
        now: input.now,
        lease_until: input.lease_until,
        branch: existingLease.branch,
        worktree: existingLease.worktree,
        base_commit: existingLease.base_commit,
        current_commit: existingLease.current_commit,
        revision: state.revision,
        existing: existingLease,
      });
    const validatedTakeover = existingLease
      ? takeOverStaleLease(existingLease, {
          owner: input.lease_owner,
          now: input.now,
          lease_until: input.lease_until,
          expected_revision: input.stale_takeover_revision!,
        })
      : undefined;
    const risk = classifyRisk(task);
    const route = routeTask(task, risk, input.configured_owners, input.policy);
    if (route.disposition !== "IMPLEMENT")
      throw new Error(`Task is not executable: ${route.disposition}`);
    const stack = detectStack(input.repository_files);
    const worktree = await this.workspace.createOrReuse(
      task.id,
      input.base_branch,
    );
    const lease = validatedTakeover
      ? {
          ...validatedTakeover,
          branch: worktree.branch,
          worktree: worktree.path,
          base_commit: worktree.baseCommit,
          current_commit: worktree.currentCommit,
        }
      : claimLease({
          task_id: task.id,
          status: state.status,
          authorized: state.phase === "AUTHORIZED",
          owner: input.lease_owner,
          now: input.now,
          lease_until: input.lease_until,
          branch: worktree.branch,
          worktree: worktree.path,
          base_commit: worktree.baseCommit,
          current_commit: worktree.currentCommit,
          revision: state.revision,
        });
    const nodes = route.owners.map((owner, index) => ({
      id: `${String(index + 1).padStart(2, "0")}-${owner}`,
      persona_id: owner,
      dependencies: [],
      ownership_scope: [...(input.grants[owner] ?? [])],
      acceptance_ids: task.acceptance_criteria.map((criterion) => criterion.id),
      status: "PENDING" as const,
    }));
    if (nodes.some((node) => node.ownership_scope.length === 0))
      throw new Error("Executable owner has no resolved ownership grant");
    const manifest = ExecutionManifestSchema.parse({
      schema_version: "1",
      revision: state.manifest_revision + 1,
      task_id: task.id,
      run_id: input.run_id,
      created_at: input.now,
      stack_profile: stack.evidence.map(
        (entry) => `${entry.module}:${entry.name}`,
      ),
      nodes,
    });
    await this.repository.saveExecution(
      task.id,
      manifest,
      lease,
      state.revision,
    );
    return Object.freeze({ manifest, lease, worktree_reused: worktree.reused });
  }
}
