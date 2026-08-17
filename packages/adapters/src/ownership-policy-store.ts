import { randomUUID } from "node:crypto";
import { execFile as execFileCallback } from "node:child_process";
import { lstat, open, realpath, rename, rm } from "node:fs/promises";
import { dirname, join, relative, resolve } from "node:path";
import { promisify } from "node:util";
import { stringify } from "yaml";
import type {
  ApprovedOwnershipFile,
  OwnershipPolicyStore,
} from "../../execution/src/ownership-review.js";

const execFile = promisify(execFileCallback);

/** Persist approved ownership only inside a real repository-owned .forge directory. */
export class FileOwnershipPolicyStore implements OwnershipPolicyStore {
  async writeApprovedPolicy(
    repositoryPath: string,
    policy: ApprovedOwnershipFile,
  ): Promise<void> {
    const requestedRoot = resolve(repositoryPath);
    const canonicalRoot = await realpath(requestedRoot);
    if (canonicalRoot !== requestedRoot)
      throw new Error("Ownership repository path must be canonical");

    const forgeDirectory = join(canonicalRoot, ".forge");
    const forgeEntry = await lstat(forgeDirectory).catch(() => undefined);
    if (!forgeEntry?.isDirectory() || forgeEntry.isSymbolicLink())
      throw new Error("Ownership .forge directory must be a real directory");
    if ((await realpath(forgeDirectory)) !== forgeDirectory)
      throw new Error("Ownership .forge directory escapes the repository");

    const target = join(forgeDirectory, "ownership.yml");
    assertContained(canonicalRoot, target);
    const targetEntry = await lstat(target).catch(() => undefined);
    if (targetEntry?.isSymbolicLink())
      throw new Error("Ownership policy target must not be a symbolic link");
    if (targetEntry && !targetEntry.isFile())
      throw new Error("Ownership policy target must be a regular file");

    const [head, status] = await Promise.all([
      git(canonicalRoot, ["rev-parse", "HEAD"]),
      git(canonicalRoot, ["status", "--porcelain=v1", "-z"]),
    ]);
    if (head.trim() !== policy.review.candidate_commit)
      throw new Error("Repository HEAD changed before ownership persistence");
    if (status.length !== 0)
      throw new Error("Repository must be clean before ownership persistence");

    const temporary = join(
      forgeDirectory,
      `.ownership.yml.tmp-${randomUUID()}`,
    );
    const handle = await open(temporary, "wx", 0o600);
    try {
      await handle.writeFile(stringify(policy, { sortMapEntries: true }));
      await handle.sync();
    } finally {
      await handle.close();
    }
    try {
      await rename(temporary, target);
      const directoryHandle = await open(forgeDirectory, "r");
      try {
        await directoryHandle.sync();
      } finally {
        await directoryHandle.close();
      }
    } catch (error) {
      await rm(temporary, { force: true });
      throw error;
    }
  }
}

async function git(
  repository: string,
  args: readonly string[],
): Promise<string> {
  const result = await execFile("git", [...args], {
    cwd: repository,
    encoding: "utf8",
    timeout: 10_000,
    maxBuffer: 1024 * 1024,
  });
  return result.stdout;
}

function assertContained(root: string, target: string): void {
  const child = relative(root, target);
  if (!child || child === ".." || child.startsWith("../"))
    throw new Error("Ownership policy path escapes the repository");
  if (dirname(target) !== join(root, ".forge"))
    throw new Error("Ownership policy path is outside .forge");
}
