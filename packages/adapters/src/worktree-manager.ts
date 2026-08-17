import { execFile as execFileCallback } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, readFile, realpath, writeFile } from "node:fs/promises";
import { isAbsolute, join, relative, resolve } from "node:path";
import { promisify } from "node:util";
import { GitAdapter } from "./git-adapter.js";

const execFile = promisify(execFileCallback);

export interface TaskWorktree {
  readonly taskId: string;
  readonly branch: string;
  readonly path: string;
  readonly baseCommit: string;
  readonly currentCommit: string;
  readonly reused: boolean;
}

export class WorktreeManager {
  private readonly repository: string;
  private readonly worktreeRoot: string;
  constructor(
    repository: string,
    worktreeRoot = join(repository, ".forge", "worktrees"),
  ) {
    this.repository = resolve(repository);
    this.worktreeRoot = resolve(worktreeRoot);
    const relation = relative(this.repository, this.worktreeRoot);
    if (relation.startsWith("..") || isAbsolute(relation))
      throw new Error("Worktree root must be inside repository");
  }

  identity(taskId: string): { readonly branch: string; readonly path: string } {
    const slug = taskId
      .normalize("NFKD")
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-|-$/g, "");
    if (!slug) throw new Error("Task id has no safe branch representation");
    const key = `${slug}-${createHash("sha256").update(taskId).digest("hex").slice(0, 10)}`;
    return Object.freeze({
      branch: `forge/${key}`,
      path: join(this.worktreeRoot, key),
    });
  }

  async createOrReuse(
    taskId: string,
    baseBranch = "main",
  ): Promise<TaskWorktree> {
    const source = new GitAdapter(this.repository);
    const baseCommit = await source.baseCommit(baseBranch);
    const identity = this.identity(taskId);
    let reused = false;
    let existingPath: string | undefined;
    try {
      existingPath = await realpath(identity.path);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    if (existingPath) {
      const existingBranch = await new GitAdapter(existingPath).currentBranch();
      if (existingBranch !== identity.branch)
        throw new Error(`Worktree path is registered to ${existingBranch}`);
      const marker = await this.taskMarker(existingPath);
      if ((await readFile(marker, "utf8")).trim() !== taskId)
        throw new Error("Worktree task identity mismatch");
      reused = true;
    } else {
      await mkdir(this.worktreeRoot, { recursive: true });
      const branchExists = await this.branchExists(identity.branch);
      const args = branchExists
        ? ["worktree", "add", identity.path, identity.branch]
        : ["worktree", "add", "-b", identity.branch, identity.path, baseCommit];
      await execFile("git", args, { cwd: this.repository });
      await writeFile(await this.taskMarker(identity.path), `${taskId}\n`, {
        flag: "wx",
        mode: 0o600,
      });
    }
    const canonical = await realpath(identity.path);
    const worktree = new GitAdapter(canonical);
    if ((await worktree.currentBranch()) !== identity.branch)
      throw new Error("Worktree branch mismatch");
    return Object.freeze({
      taskId,
      ...identity,
      path: canonical,
      baseCommit,
      currentCommit: await worktree.candidateCommit(),
      reused,
    });
  }

  private async taskMarker(worktree: string): Promise<string> {
    const { stdout } = await execFile("git", ["rev-parse", "--git-dir"], {
      cwd: worktree,
      encoding: "utf8",
    });
    return resolve(worktree, stdout.trim(), "forge-task-id");
  }

  private async branchExists(branch: string): Promise<boolean> {
    try {
      await execFile(
        "git",
        ["show-ref", "--verify", "--quiet", `refs/heads/${branch}`],
        { cwd: this.repository },
      );
      return true;
    } catch {
      return false;
    }
  }
}
