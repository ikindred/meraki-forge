import { access, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { SandboxAgentDispatcher } from "../packages/adapters/src/sandbox-agent-dispatcher.js";
import type { DispatchRecord } from "../packages/execution/src/coordinator.js";

const run = process.platform === "darwin" ? it : it.skip;
run("mechanically denies writes outside the assigned worktree", async () => {
  const worktree = await mkdtemp(join(tmpdir(), "forge-sandbox-worktree-"));
  const outside = join(tmpdir(), `forge-sandbox-outside-${Date.now()}`);
  const record: DispatchRecord = {
    task_id: "MF-1",
    persona_id: "frontend-engineer",
    execution_node_id: "front",
    dispatch_id: "D1",
    manifest_revision: 1,
    allowed_ownership_scope: ["src/frontend/**"],
    repository_worktree_path: worktree,
    stack_profile: {},
    relevant_contracts: [],
    acceptance_criteria: [],
    dependencies: [],
    expected_output_schema: "AgentResult/v1",
    stop_conditions: ["COMPLETE"],
  };
  const dispatcher = new SandboxAgentDispatcher("/bin/sh", () => [
    "-c",
    `echo forbidden > '${outside}'; echo '{"output_ref":"ok"}'`,
  ]);
  try {
    // A denied write may either terminate sandbox-exec or be handled by the
    // child process. The invariant is that the external effect never occurs.
    await dispatcher.dispatch(record).catch(() => undefined);
    await expect(access(outside)).rejects.toThrow();
  } finally {
    await rm(worktree, { recursive: true });
    await rm(outside, { force: true });
  }
});
