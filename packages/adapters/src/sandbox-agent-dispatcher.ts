import { execFile as execFileCallback } from "node:child_process";
import { mkdir, rm } from "node:fs/promises";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import {
  AgentResultSchema,
  type AgentDispatcher,
  type DispatchRecord,
  type DispatchResult,
} from "../../execution/src/coordinator.js";
import { normalizeRepoPath } from "../../kernel/src/ownership.js";

const execFile = promisify(execFileCallback);

/** macOS local executor: reads system-wide, writes only inside the assigned worktree, no network. */
export class SandboxAgentDispatcher implements AgentDispatcher {
  constructor(
    private readonly executable: string,
    private readonly argumentsFor: (
      record: DispatchRecord,
    ) => readonly string[],
  ) {}

  async dispatch(record: DispatchRecord): Promise<DispatchResult> {
    if (process.platform !== "darwin")
      throw new Error(
        "A platform sandbox adapter is required for this operating system",
      );
    const worktree = resolve(record.repository_worktree_path);
    const temporary = join(worktree, ".forge", "tmp", record.dispatch_id);
    await mkdir(temporary, { recursive: true, mode: 0o700 });
    const writable = record.allowed_ownership_scope.map((pattern) => {
      if (pattern.includes("*") && !pattern.endsWith("/**"))
        throw new Error(
          `Sandbox supports only exact paths or recursive /** grants: ${pattern}`,
        );
      const normalized = normalizeRepoPath(pattern.replace(/\/\*\*?$/, ""));
      const target = join(worktree, normalized)
        .replaceAll("\\", "\\\\")
        .replaceAll('"', '\\"');
      return pattern.endsWith("/**")
        ? `(subpath "${target}")`
        : `(literal "${target}")`;
    });
    const temporaryQuoted = temporary
      .replaceAll("\\", "\\\\")
      .replaceAll('"', '\\"');
    const profile = `(version 1) (deny default) (allow process*) (allow file-read*) (allow file-write* (subpath "${temporaryQuoted}") ${writable.join(" ")}) (deny network*)`;
    let stdout: string;
    try {
      ({ stdout } = await execFile(
        "/usr/bin/sandbox-exec",
        ["-p", profile, this.executable, ...this.argumentsFor(record)],
        {
          cwd: worktree,
          env: {
            PATH: process.env.PATH,
            TMPDIR: temporary,
            FORGE_DISPATCH_ID: record.dispatch_id,
          },
          encoding: "utf8",
          maxBuffer: 16 * 1024 * 1024,
        },
      ));
    } finally {
      await rm(temporary, { recursive: true, force: true });
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(stdout);
    } catch {
      throw new Error("Sandboxed agent returned invalid JSON");
    }
    const validated = AgentResultSchema.safeParse(parsed);
    if (!validated.success)
      throw new Error("Sandboxed agent result does not match AgentResult/v1");
    return validated.data as DispatchResult;
  }
}
