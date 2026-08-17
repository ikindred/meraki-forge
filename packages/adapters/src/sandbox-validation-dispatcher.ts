import { execFile as execFileCallback } from "node:child_process";
import { mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import {
  ValidatorResultSchema,
  type ValidatorDispatch,
  type ValidatorDispatcher,
  type ValidatorResult,
} from "../../execution/src/validation-orchestrator.js";
import { normalizeRepoPath } from "../../kernel/src/ownership.js";

const execFile = promisify(execFileCallback);

/** macOS validator sandbox: no network and no writes beyond the exact gate grant. */
export class SandboxValidationDispatcher implements ValidatorDispatcher {
  constructor(
    private readonly worktree: string,
    private readonly executable: string,
    private readonly argumentsFor: (
      record: ValidatorDispatch,
      resultDirectory: string,
    ) => readonly string[],
    private readonly runtimeReadRoots: readonly string[] = [],
  ) {}

  async dispatch(record: ValidatorDispatch): Promise<ValidatorResult> {
    if (process.platform !== "darwin")
      throw new Error("A platform validation sandbox is required");
    const resultDirectory = await mkdtemp(join(tmpdir(), "forge-validation-"));
    try {
      const canonicalWorktree = await realpath(this.worktree);
      const canonicalResult = await realpath(resultDirectory);
      const writable = record.allowed_write_paths.map((pattern) => {
        if (pattern.includes("*") && !pattern.endsWith("/**"))
          throw new Error(`Unsupported validation grant: ${pattern}`);
        const normalized = normalizeRepoPath(pattern.replace(/\/\*\*$/, ""));
        const path = quote(resolve(canonicalWorktree, normalized));
        return pattern.endsWith("/**")
          ? `(subpath "${path}")`
          : `(literal "${path}")`;
      });
      const readRoots = [
        "/System",
        "/usr",
        "/bin",
        "/sbin",
        "/Library",
        canonicalWorktree,
        canonicalResult,
        ...this.runtimeReadRoots.map((root) => resolve(root)),
      ].map((root) => `(subpath "${quote(root)}")`);
      const resultPath = quote(canonicalResult);
      const gitPath = quote(resolve(canonicalWorktree, ".git"));
      const statePath = quote(resolve(canonicalWorktree, ".forge", "state"));
      const profile = `(version 1) (deny default) (allow process*) (allow file-read* ${readRoots.join(" ")}) (deny file-read* (subpath "${gitPath}") (subpath "${statePath}")) (allow file-write* (subpath "${resultPath}") ${writable.join(" ")}) (deny network*)`;
      const { stdout } = await execFile(
        "/usr/bin/sandbox-exec",
        [
          "-p",
          profile,
          this.executable,
          ...this.argumentsFor(record, resultDirectory),
        ],
        {
          cwd: this.worktree,
          encoding: "utf8",
          maxBuffer: 16 * 1024 * 1024,
          env: {
            PATH: process.env.PATH,
            TMPDIR: resultDirectory,
            FORGE_VALIDATION_GATE: record.gate,
          },
        },
      );
      let value: unknown;
      try {
        value = JSON.parse(stdout);
      } catch {
        throw new Error("Validator returned invalid JSON");
      }
      const parsed = ValidatorResultSchema.safeParse(value);
      if (!parsed.success)
        throw new Error("Validator output does not match the strict schema");
      return parsed.data;
    } finally {
      await rm(resultDirectory, { recursive: true, force: true });
    }
  }
}

function quote(value: string): string {
  return value.replaceAll("\\", "\\\\").replaceAll('"', '\\"');
}
