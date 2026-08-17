import { z } from "zod";
import { SafeStateStore } from "../../adapters/src/safe-state-store.js";
import {
  ExecutionManifestSchema,
  TaskContractSchema,
  TaskLeaseSchema,
  TaskStateSchema,
  type TaskContract,
  type TaskLease,
  type TaskState,
} from "../../kernel/src/index.js";
import type { DirectorRepository } from "./director.js";

const DirectorRecordSchema = z.object({
  schema_version: z.literal("1"),
  revision: z.number().int().nonnegative(),
  task: TaskContractSchema,
  task_state: TaskStateSchema,
  manifest: ExecutionManifestSchema.nullable(),
  lease: TaskLeaseSchema.nullable(),
});
type DirectorRecord = z.infer<typeof DirectorRecordSchema>;

/** One CAS-protected record makes task claim + manifest + lease a single durable decision. */
export class DurableDirectorRepository implements DirectorRepository {
  readonly #records: SafeStateStore<DirectorRecord>;
  constructor(repositoryRoot: string) {
    this.#records = new SafeStateStore(repositoryRoot, DirectorRecordSchema);
  }
  async initialize(task: TaskContract, state: TaskState): Promise<void> {
    await this.#records.save(task.id, {
      schema_version: "1",
      revision: state.revision,
      task,
      task_state: state,
      manifest: null,
      lease: null,
    });
  }
  async loadTask(taskId: string): Promise<TaskContract> {
    return (await this.#records.load(taskId)).task;
  }
  async loadTaskState(taskId: string): Promise<TaskState> {
    return (await this.#records.load(taskId)).task_state;
  }
  async loadLease(taskId: string): Promise<TaskLease | undefined> {
    return (await this.#records.load(taskId)).lease ?? undefined;
  }
  async saveExecution(
    taskId: string,
    manifest: z.infer<typeof ExecutionManifestSchema>,
    lease: TaskLease,
    expectedRevision: number,
  ): Promise<void> {
    const current = await this.#records.load(taskId);
    const taskState = TaskStateSchema.parse({
      ...current.task_state,
      revision: expectedRevision + 1,
      status: "IN_PROGRESS",
      phase: "CLAIMED",
      branch: lease.branch,
      worktree: lease.worktree,
      base_sha: lease.base_commit,
      candidate_sha: lease.current_commit,
      manifest_revision: manifest.revision,
      updated_at: lease.updated_at,
      claim: {
        run_id: manifest.run_id,
        owner: lease.owner,
        lease_until: lease.lease_until,
      },
    });
    await this.#records.save(
      taskId,
      {
        ...current,
        revision: expectedRevision + 1,
        task_state: taskState,
        manifest,
        lease,
      },
      expectedRevision,
    );
  }
}
