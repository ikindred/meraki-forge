import { access, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { SandboxValidationDispatcher } from "../packages/adapters/src/sandbox-validation-dispatcher.js";
import type { ValidatorDispatch } from "../packages/execution/src/validation-orchestrator.js";

const run = process.platform === "darwin" ? it : it.skip;

run(
  "mechanically prevents read-only validators from writing outside their result channel",
  async () => {
    const worktree = await mkdtemp(join(tmpdir(), "forge-validator-worktree-"));
    const outside = join(tmpdir(), `forge-validator-outside-${Date.now()}`);
    const record: ValidatorDispatch = {
      task_id: "MF-3",
      candidate_sha: "a".repeat(40),
      gate: "SECURITY",
      persona_id: "security-auditor",
      read_only: true,
      allowed_write_paths: [],
      acceptance_criteria: [{ id: "AC-1", text: "Secure" }],
      expected_result: "STRUCTURED_VALIDATION_RESULT",
    };
    const dispatcher = new SandboxValidationDispatcher(
      worktree,
      "/bin/sh",
      () => ["-c", `echo forbidden > '${outside}'; exit 1`],
    );
    try {
      await expect(dispatcher.dispatch(record)).rejects.toThrow();
      await expect(access(outside)).rejects.toThrow();
    } finally {
      await rm(worktree, { recursive: true, force: true });
      await rm(outside, { force: true });
    }
  },
);

run("denies validators read access to unrelated user files", async () => {
  const worktree = await mkdtemp(join(tmpdir(), "forge-validator-read-"));
  const outside = join(tmpdir(), `forge-validator-secret-${Date.now()}`);
  await writeFile(outside, "private-user-data\n");
  const record: ValidatorDispatch = {
    task_id: "MF-READ",
    candidate_sha: "b".repeat(40),
    gate: "CODE_REVIEW",
    persona_id: "code-reviewer",
    read_only: true,
    allowed_write_paths: [],
    acceptance_criteria: [{ id: "AC-1", text: "Review" }],
    expected_result: "STRUCTURED_VALIDATION_RESULT",
  };
  const dispatcher = new SandboxValidationDispatcher(
    worktree,
    "/bin/sh",
    () => ["-c", `cat '${outside}'`],
  );
  try {
    await expect(dispatcher.dispatch(record)).rejects.toThrow();
  } finally {
    await rm(worktree, { recursive: true, force: true });
    await rm(outside, { force: true });
  }
});
