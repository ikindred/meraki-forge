import { execFile as execFileCallback } from "node:child_process";
import { lstat, readlink, realpath } from "node:fs/promises";
import { dirname, isAbsolute, relative, resolve } from "node:path";
import { promisify } from "node:util";
import { normalizeRepoPath } from "../../kernel/src/ownership.js";

const execFile = promisify(execFileCallback);

export type ChangeKind =
  "add" | "modify" | "delete" | "rename" | "copy" | "type-change" | "untracked";
export interface GitChange {
  readonly kind: ChangeKind;
  readonly path: string;
  readonly oldPath?: string;
  readonly gitlink: boolean;
}
export interface BaseReconciliation {
  readonly localCommit: string;
  readonly remoteCommit?: string;
  readonly relation:
    "equal" | "ahead" | "behind" | "diverged" | "remote-unavailable";
}

export class GitAdapter {
  readonly repository: string;
  constructor(repository: string) {
    this.repository = resolve(repository);
  }

  private async raw(args: readonly string[]): Promise<string> {
    const result = await execFile("git", [...args], {
      cwd: this.repository,
      encoding: "utf8",
      maxBuffer: 16 * 1024 * 1024,
    });
    return result.stdout;
  }
  private async text(args: readonly string[]): Promise<string> {
    return (await this.raw(args)).trim();
  }

  async currentBranch(): Promise<string> {
    return this.text(["symbolic-ref", "--quiet", "--short", "HEAD"]);
  }
  async baseCommit(reference = "origin/main"): Promise<string> {
    return this.text(["rev-parse", "--verify", `${reference}^{commit}`]);
  }
  async candidateCommit(): Promise<string> {
    return this.baseCommit("HEAD");
  }
  async isClean(): Promise<boolean> {
    return (await this.raw(["status", "--porcelain=v1", "-z"])).length === 0;
  }

  async reconcileBase(
    local = "main",
    remote = "origin/main",
  ): Promise<BaseReconciliation> {
    const localCommit = await this.baseCommit(local);
    let remoteCommit: string;
    try {
      remoteCommit = await this.baseCommit(remote);
    } catch {
      return Object.freeze({ localCommit, relation: "remote-unavailable" });
    }
    if (localCommit === remoteCommit)
      return Object.freeze({ localCommit, remoteCommit, relation: "equal" });
    const base = await this.text(["merge-base", localCommit, remoteCommit]);
    const relation =
      base === remoteCommit
        ? "ahead"
        : base === localCommit
          ? "behind"
          : "diverged";
    return Object.freeze({ localCommit, remoteCommit, relation });
  }

  async changesSince(baseCommit: string): Promise<readonly GitChange[]> {
    await this.baseCommit(baseCommit);
    const raw = await this.raw([
      "diff",
      "--name-status",
      "-z",
      "--find-renames",
      "--find-copies",
      baseCommit,
      "--",
    ]);
    const fields = raw ? raw.split("\0") : [];
    const changes: GitChange[] = [];
    for (let index = 0; index < fields.length;) {
      const status = fields[index++]!;
      if (!status) continue;
      if (status.startsWith("R") || status.startsWith("C")) {
        const oldPath = normalizeRepoPath(fields[index++]!);
        const path = normalizeRepoPath(fields[index++]!);
        changes.push({
          kind: status[0] === "R" ? "rename" : "copy",
          oldPath,
          path,
          gitlink: await this.isGitlink(path),
        });
      } else {
        const path = normalizeRepoPath(fields[index++]!);
        changes.push({
          kind: mapStatus(status[0]!),
          path,
          gitlink: await this.isGitlink(path),
        });
      }
    }
    const untrackedRaw = await this.raw([
      "ls-files",
      "--others",
      "--exclude-standard",
      "-z",
    ]);
    for (const value of untrackedRaw.split("\0").filter(Boolean)) {
      const path = normalizeRepoPath(value);
      changes.push({ kind: "untracked", path, gitlink: false });
    }
    return Object.freeze(changes);
  }

  async ignoredPaths(): Promise<readonly string[]> {
    const raw = await this.raw([
      "ls-files",
      "--others",
      "--ignored",
      "--exclude-standard",
      "-z",
    ]);
    return Object.freeze(
      raw.split("\0").filter(Boolean).map(normalizeRepoPath),
    );
  }

  boundaryPaths(changes: readonly GitChange[]): readonly string[] {
    return Object.freeze([
      ...new Set(
        changes.flatMap((change) =>
          change.oldPath ? [change.oldPath, change.path] : [change.path],
        ),
      ),
    ]);
  }

  async validateChangedPaths(
    paths: readonly string[],
  ): Promise<readonly string[]> {
    const root = await realpath(this.repository);
    const normalized = paths.map(normalizeRepoPath);
    for (const path of normalized) {
      let cursor = resolve(root, path);
      if (
        relative(root, cursor).startsWith("..") ||
        isAbsolute(relative(root, cursor))
      )
        throw new Error(`Path escapes repository: ${path}`);
      while (cursor !== root) {
        try {
          const stat = await lstat(cursor);
          if (stat.isSymbolicLink()) {
            const target = await resolveLinkTarget(cursor);
            const relation = relative(root, target);
            if (relation.startsWith("..") || isAbsolute(relation))
              throw new Error(`Symlink escapes repository: ${path}`);
          }
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
        }
        cursor = dirname(cursor);
      }
    }
    return Object.freeze(normalized);
  }

  async detectCaseCollisions(): Promise<readonly (readonly string[])[]> {
    const tracked = await this.raw(["ls-files", "-z"]);
    const untracked = await this.raw([
      "ls-files",
      "--others",
      "--exclude-standard",
      "-z",
    ]);
    const groups = new Map<string, string[]>();
    for (const path of `${tracked}\0${untracked}`
      .split("\0")
      .filter(Boolean)
      .map(normalizeRepoPath)) {
      const key = path.normalize("NFC").toLocaleLowerCase("en-US");
      groups.set(key, [...(groups.get(key) ?? []), path]);
    }
    return Object.freeze(
      [...groups.values()]
        .filter((paths) => new Set(paths).size > 1)
        .map((paths): readonly string[] => Object.freeze([...paths])),
    );
  }

  private async isGitlink(path: string): Promise<boolean> {
    try {
      return (await this.text(["ls-files", "--stage", "--", path])).startsWith(
        "160000 ",
      );
    } catch {
      return false;
    }
  }
}

async function resolveLinkTarget(link: string): Promise<string> {
  let current = link;
  const seen = new Set<string>();
  for (;;) {
    if (seen.has(current)) throw new Error(`Symlink cycle: ${link}`);
    seen.add(current);
    const target = resolve(dirname(current), await readlink(current));
    let stat;
    try {
      stat = await lstat(target);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return target;
      throw error;
    }
    if (!stat.isSymbolicLink()) return target;
    current = target;
  }
}

function mapStatus(status: string): ChangeKind {
  if (status === "A") return "add";
  if (status === "D") return "delete";
  if (status === "T") return "type-change";
  return "modify";
}
