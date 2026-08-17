/* eslint-disable @typescript-eslint/require-await */
import { describe, expect, it } from "vitest";
import {
  ProjectPolicySchema,
  TaskContractSchema,
  TaskStateSchema,
  type TaskLease,
} from "../packages/kernel/src/index.js";
import {
  ForgeDirector,
  type DirectorRepository,
  type DirectorWorkspace,
} from "../packages/execution/src/director.js";
import type { ExecutionManifestSchema } from "../packages/kernel/src/execution.js";
import type { z } from "zod";

const task = TaskContractSchema.parse({
  schema_version: "1",
  id: "MF-20",
  title: "Add frontend account feature",
  mode: "AUTO",
  priority: "P2",
  outcome: "Frontend account UI works",
  acceptance_criteria: [{ id: "AC-1", text: "User sees account" }],
});
const state = TaskStateSchema.parse({
  schema_version: "1",
  revision: 0,
  task_id: task.id,
  mode: "AUTO",
  status: "READY",
  phase: "AUTHORIZED",
  repair_attempt: 0,
  updated_at: "2026-08-11T00:00:00.000Z",
  transitions: [],
});
class Repo implements DirectorRepository {
  saved?: {
    manifest: z.infer<typeof ExecutionManifestSchema>;
    lease: TaskLease;
    revision: number;
  };
  async loadTask() {
    return task;
  }
  async loadTaskState() {
    return state;
  }
  async loadLease(): Promise<TaskLease | undefined> {
    return undefined;
  }
  async saveExecution(
    _taskId: string,
    manifest: z.infer<typeof ExecutionManifestSchema>,
    lease: TaskLease,
    expectedRevision: number,
  ) {
    this.saved = { manifest, lease, revision: expectedRevision };
  }
}
class Workspace implements DirectorWorkspace {
  calls = 0;
  async createOrReuse() {
    this.calls++;
    return {
      branch: "forge/mf-20",
      path: "/tmp/mf-20",
      baseCommit: "a".repeat(40),
      currentCommit: "a".repeat(40),
      reused: false,
    };
  }
}
const policy = ProjectPolicySchema.parse({
  schema_version: "1",
  autonomy_ceiling: "MEDIUM",
  auto_merge: false,
  production_deploy: false,
});

describe("Forge Director", () => {
  it("reconciles stack/routing, claims, creates manifest, and persists before coordinator handoff", async () => {
    const repo = new Repo();
    const workspace = new Workspace();
    const result = await new ForgeDirector(repo, workspace).start({
      task_id: task.id,
      run_id: "RUN-1",
      lease_owner: "director",
      now: "2026-08-11T00:00:00.000Z",
      lease_until: "2026-08-11T01:00:00.000Z",
      base_branch: "main",
      repository_files: [
        { path: "package.json", content: '{"dependencies":{"next":"16"}}' },
      ],
      configured_owners: ["frontend-engineer"],
      ownership_rules: [
        {
          pattern: "src/frontend/**",
          owner: "frontend-engineer",
          effect: "allow",
        },
      ],
      grants: { "frontend-engineer": ["src/frontend/**"] },
      policy,
    });
    expect(result.manifest.nodes[0]?.persona_id).toBe("frontend-engineer");
    expect(result.manifest.stack_profile).toContain(".:Next.js");
    expect(repo.saved?.lease.worktree).toBe("/tmp/mf-20");
    expect(workspace.calls).toBe(1);
  });
  it("does not claim non-executable critical work", async () => {
    const criticalRepo = new Repo();
    criticalRepo.loadTask = async () =>
      TaskContractSchema.parse({
        ...task,
        outcome: "Delete production customer records",
      });
    const workspace = new Workspace();
    await expect(
      new ForgeDirector(criticalRepo, workspace).start({
        task_id: task.id,
        run_id: "RUN-1",
        lease_owner: "director",
        now: "2026-08-11T00:00:00.000Z",
        lease_until: "2026-08-11T01:00:00.000Z",
        base_branch: "main",
        repository_files: [],
        configured_owners: ["frontend-engineer"],
        ownership_rules: [],
        grants: { "frontend-engineer": ["src/frontend/**"] },
        policy,
      }),
    ).rejects.toThrow("not executable");
    expect(workspace.calls).toBe(0);
  });
  it("rejects an active durable lease before worktree side effects", async () => {
    const repo = new Repo();
    repo.loadLease = async () => ({
      schema_version: "1",
      task_id: task.id,
      lease_id: "active",
      owner: "other",
      started_at: "2026-08-11T00:00:00.000Z",
      heartbeat_at: "2026-08-11T00:00:00.000Z",
      updated_at: "2026-08-11T00:00:00.000Z",
      lease_until: "2026-08-11T01:00:00.000Z",
      branch: "forge/mf",
      worktree: "/tmp/mf",
      base_commit: "a".repeat(40),
      current_commit: "a".repeat(40),
      revision: 0,
    });
    const workspace = new Workspace();
    await expect(
      new ForgeDirector(repo, workspace).start({
        task_id: task.id,
        run_id: "RUN-2",
        lease_owner: "director-2",
        now: "2026-08-11T00:10:00.000Z",
        lease_until: "2026-08-11T01:10:00.000Z",
        base_branch: "main",
        repository_files: [],
        configured_owners: ["frontend-engineer"],
        ownership_rules: [],
        grants: { "frontend-engineer": ["src/frontend/**"] },
        policy,
      }),
    ).rejects.toThrow("active lease");
    expect(workspace.calls).toBe(0);
  });
});
