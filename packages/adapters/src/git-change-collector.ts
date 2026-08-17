import { execFile as execFileCallback } from "node:child_process";
import { randomUUID } from "node:crypto";
import { chmod, lstat, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { promisify } from "node:util";
import { GitAdapter } from "./git-adapter.js";

const execFile = promisify(execFileCallback);
type IgnoredEntry = Readonly<{
  data: Buffer | null;
  mode: number;
}>;
const ARTIFACT_ROOTS = [
  ".forge/artifacts/",
  "test-results/",
  "playwright-report/",
] as const;

function matchesGrant(path: string, grant: readonly string[]): boolean {
  return grant.some((pattern) => {
    if (pattern.endsWith("/**")) {
      const root = pattern.slice(0, -3);
      return path === root || path.startsWith(`${root}/`);
    }
    return path === pattern;
  });
}

/** Serializes each modifying agent round around a clean commit baseline. */
export class GitChangeCollector {
  readonly #baselines = new Map<
    string,
    {
      commit: string;
      ignored: Map<string, IgnoredEntry>;
      grant: readonly string[];
      auditAllIgnored: boolean;
    }
  >();
  readonly #roundIgnored = new Map<string, readonly string[]>();
  async captureBaseline(
    worktree: string,
    grant: readonly string[],
    auditAllIgnored = false,
  ): Promise<string> {
    const git = new GitAdapter(worktree);
    if (!(await git.isClean()))
      throw new Error("Agent round requires a clean attributed baseline");
    const token = `round-${randomUUID()}`;
    this.#baselines.set(token, {
      commit: await git.candidateCommit(),
      ignored: await ignoredSnapshot(worktree, git, grant, auditAllIgnored),
      grant: [...grant],
      auditAllIgnored,
    });
    return token;
  }

  async collectChangedPaths(worktree: string, baseline: string) {
    const git = new GitAdapter(worktree);
    const snapshot = this.#baselines.get(baseline);
    if (!snapshot) throw new Error("Unknown or expired agent-round baseline");
    const changes = await git.changesSince(snapshot.commit);
    const gitlinks = changes.filter((change) => change.gitlink);
    if (gitlinks.length)
      throw new Error(
        `Gitlink changes require explicit human review: ${gitlinks.map((item) => item.path).join(", ")}`,
      );
    const currentIgnored = await ignoredSnapshot(
      worktree,
      git,
      snapshot.grant,
      snapshot.auditAllIgnored,
    );
    const ignoredChanges = [...currentIgnored]
      .filter(
        ([path, entry]) =>
          !sameEntry(snapshot.ignored.get(path), entry) &&
          !path.startsWith(".forge/tmp/") &&
          !path.startsWith(".forge/state/"),
      )
      .map(([path]) => path);
    for (const path of snapshot.ignored.keys()) {
      if (!currentIgnored.has(path)) ignoredChanges.push(path);
    }
    const unsafeIgnored = ignoredChanges.filter(
      (path) => !ARTIFACT_ROOTS.some((root) => path.startsWith(root)),
    );
    this.#roundIgnored.set(baseline, ignoredChanges);
    if (unsafeIgnored.length)
      throw new Error(
        `Ignored implementation/config changes are prohibited: ${unsafeIgnored.join(", ")}`,
      );
    const paths = [
      ...new Set([...git.boundaryPaths(changes), ...ignoredChanges]),
    ];
    await git.validateChangedPaths(paths);
    const collisions = await git.detectCaseCollisions();
    if (collisions.length)
      throw new Error(`Case-colliding paths: ${collisions.flat().join(", ")}`);
    return Object.freeze({
      paths,
      candidate_commit: await git.candidateCommit(),
    });
  }

  async rejectChanges(worktree: string, baseline: string): Promise<void> {
    const snapshot = this.#baselines.get(baseline);
    if (!snapshot) throw new Error("Unknown agent-round baseline");
    await execFile("git", ["reset", "--hard", snapshot.commit], {
      cwd: worktree,
    });
    for (const path of this.#roundIgnored.get(baseline) ?? []) {
      const original = snapshot.ignored.get(path);
      const absolute = resolve(worktree, path);
      if (!original) {
        await rm(absolute, { recursive: true, force: true });
      } else if (original.data) {
        await mkdir(resolve(absolute, ".."), { recursive: true });
        await writeFile(absolute, original.data);
        await chmod(absolute, original.mode);
      } else {
        throw new Error(`Cannot safely restore non-file ignored path: ${path}`);
      }
    }
    await execFile("git", ["clean", "-fd"], { cwd: worktree });
    this.#baselines.delete(baseline);
    this.#roundIgnored.delete(baseline);
  }

  async acceptChanges(
    worktree: string,
    baseline: string,
    nodeId: string,
  ): Promise<string> {
    const git = new GitAdapter(worktree);
    const snapshot = this.#baselines.get(baseline);
    if (!snapshot) throw new Error("Unknown agent-round baseline");
    if (
      (await git.candidateCommit()) !== snapshot.commit &&
      (await git.isClean())
    ) {
      const candidate = await git.candidateCommit();
      this.#baselines.delete(baseline);
      this.#roundIgnored.delete(baseline);
      return candidate;
    }
    // Ignored evidence remains an out-of-tree artifact. Never force-add ignored
    // files: doing so could commit credentials or local configuration.
    await execFile("git", ["add", "-A"], { cwd: worktree });
    const staged = await execFile("git", ["diff", "--cached", "--quiet"], {
      cwd: worktree,
    }).then(
      () => false,
      () => true,
    );
    if (staged)
      await execFile(
        "git",
        [
          "-c",
          "user.name=Meraki Forge",
          "-c",
          "user.email=forge@local.invalid",
          "-c",
          "core.hooksPath=/dev/null",
          "commit",
          "-m",
          `forge: accept ${nodeId}`,
        ],
        { cwd: worktree },
      );
    if (!(await git.isClean()))
      throw new Error("Accepted round did not produce a clean candidate");
    const candidate = await git.candidateCommit();
    this.#baselines.delete(baseline);
    this.#roundIgnored.delete(baseline);
    return candidate;
  }
}

async function ignoredSnapshot(
  worktree: string,
  git: GitAdapter,
  grant: readonly string[],
  auditAllIgnored: boolean,
): Promise<Map<string, IgnoredEntry>> {
  const result = new Map<string, IgnoredEntry>();
  for (const path of (await git.ignoredPaths()).filter(
    (item) => auditAllIgnored || matchesGrant(item, grant),
  )) {
    try {
      const absolute = resolve(worktree, path);
      const metadata = await lstat(absolute);
      result.set(path, {
        data: metadata.isFile() ? await readFile(absolute) : null,
        mode: metadata.mode,
      });
    } catch {
      continue;
    }
  }
  return result;
}

function sameEntry(
  left: IgnoredEntry | undefined,
  right: IgnoredEntry,
): boolean {
  if (!left || left.mode !== right.mode) return false;
  if (left.data === null || right.data === null)
    return left.data === right.data;
  return left.data.equals(right.data);
}
