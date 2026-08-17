/* eslint-disable @typescript-eslint/require-await */
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  ProjectPolicySchema,
  TaskContractSchema,
  TaskStateSchema,
} from "../packages/kernel/src/index.js";
import {
  ForgeDirector,
  type DirectorWorkspace,
} from "../packages/execution/src/director.js";
import { DurableDirectorRepository } from "../packages/execution/src/durable-director-repository.js";

describe("durable Director claiming", () => {
  it("allows only one persisted claim under a coordinator race", async () => {
    const root = await mkdtemp(join(tmpdir(), "forge-director-durable-"));
    const task = TaskContractSchema.parse({
      schema_version: "1",
      id: "MF-RACE",
      title: "Frontend feature",
      mode: "AUTO",
      priority: "P2",
      outcome: "Frontend works",
      acceptance_criteria: [{ id: "AC-1", text: "works" }],
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
    const repository = new DurableDirectorRepository(root);
    await repository.initialize(task, state);
    const workspace: DirectorWorkspace = {
      createOrReuse: async () => ({
        branch: "forge/race",
        path: "/tmp/race",
        baseCommit: "a".repeat(40),
        currentCommit: "a".repeat(40),
        reused: false,
      }),
    };
    const policy = ProjectPolicySchema.parse({
      schema_version: "1",
      autonomy_ceiling: "MEDIUM",
      auto_merge: false,
      production_deploy: false,
    });
    const input = {
      task_id: task.id,
      run_id: "RUN",
      lease_owner: "coordinator",
      now: "2026-08-11T00:00:00.000Z",
      lease_until: "2026-08-11T01:00:00.000Z",
      base_branch: "main",
      repository_files: [],
      configured_owners: ["frontend-engineer" as const],
      ownership_rules: [],
      grants: { "frontend-engineer": ["src/frontend/**"] },
      policy,
    };
    try {
      const results = await Promise.allSettled([
        new ForgeDirector(repository, workspace).start(input),
        new ForgeDirector(repository, workspace).start({
          ...input,
          lease_owner: "other",
          run_id: "RUN-2",
        }),
      ]);
      expect(
        results.filter((result) => result.status === "fulfilled"),
      ).toHaveLength(1);
      expect((await repository.loadTaskState(task.id)).status).toBe(
        "IN_PROGRESS",
      );
      expect(await repository.loadLease(task.id)).toBeDefined();
    } finally {
      await rm(root, { recursive: true });
    }
  });
});
