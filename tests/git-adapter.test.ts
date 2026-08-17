import {
  access,
  mkdtemp,
  mkdir,
  readFile,
  symlink,
  unlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { execFile as execFileCallback } from "node:child_process";
import { describe, expect, it } from "vitest";
import { GitAdapter } from "../packages/adapters/src/git-adapter.js";
import { GitChangeCollector } from "../packages/adapters/src/git-change-collector.js";
import { WorktreeManager } from "../packages/adapters/src/worktree-manager.js";
import {
  createDependencyRequests,
  validateBoundary,
  type OwnershipRule,
} from "../packages/kernel/src/index.js";

const execFile = promisify(execFileCallback);

async function repository(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "forge-git-"));
  await execFile("git", ["init", "-b", "main", root]);
  await execFile("git", ["config", "user.email", "forge@example.test"], {
    cwd: root,
  });
  await execFile("git", ["config", "user.name", "Forge Tests"], { cwd: root });
  await writeFile(join(root, "tracked.txt"), "base\n");
  await writeFile(
    join(root, "delete-me.txt"),
    "delete this distinct content\n",
  );
  await writeFile(join(root, ".gitignore"), "*.env\n");
  await execFile("git", ["add", "."], { cwd: root });
  await execFile("git", ["commit", "-m", "base"], { cwd: root });
  return root;
}

describe("GitAdapter", () => {
  it("inspects branch and candidate identity", async () => {
    const root = await repository();
    const git = new GitAdapter(root);
    expect(await git.currentBranch()).toBe("main");
    expect(await git.baseCommit("main")).toMatch(/^[a-f0-9]{40}$/);
    expect(await git.candidateCommit()).toBe(await git.baseCommit("main"));
  });
  it("reconciles local main with a locally known origin/main without fetching", async () => {
    const root = await repository();
    await execFile("git", ["update-ref", "refs/remotes/origin/main", "HEAD"], {
      cwd: root,
    });
    await expect(new GitAdapter(root).reconcileBase()).resolves.toMatchObject({
      relation: "equal",
    });
  });

  it("feeds real Git changes into ownership rejection and dependency routing", async () => {
    const root = await repository();
    await mkdir(join(root, "src", "backend"), { recursive: true });
    const collector = new GitChangeCollector();
    const baseline = await collector.captureBaseline(root, ["src/frontend/**"]);
    await writeFile(join(root, "src", "backend", "payment.ts"), "export {}\n");
    const changed = await collector.collectChangedPaths(root, baseline);
    const rules: readonly OwnershipRule[] = [
      {
        pattern: "src/frontend/**",
        owner: "frontend-engineer",
        effect: "allow",
      },
      { pattern: "src/backend/**", owner: "backend-engineer", effect: "allow" },
    ];
    const boundary = validateBoundary(
      "frontend-engineer",
      changed.paths,
      rules,
      ["src/frontend/**"],
    );
    expect(boundary.violations).toContainEqual(
      expect.objectContaining({
        code: "AGENT_BOUNDARY_VIOLATION",
        path: "src/backend/payment.ts",
        expected_owner: "backend-engineer",
      }),
    );
    expect(
      createDependencyRequests(
        {
          task_id: "MF-9",
          run_id: "RUN-1",
          from: "frontend-engineer",
          created_at: "2026-08-11T00:00:00.000Z",
          acceptance_ids: ["AC-1"],
          required_output: "Backend implementation",
        },
        boundary,
      )[0]?.payload.requested_owner,
    ).toBe("backend-engineer");
    await collector.rejectChanges(root, baseline);
    expect(await new GitAdapter(root).isClean()).toBe(true);
  });

  it("restores pre-existing ignored files and never accepts ignored config", async () => {
    const root = await repository();
    const localConfig = join(root, "local.env");
    await writeFile(localConfig, "SECRET=original\n", { mode: 0o600 });
    const collector = new GitChangeCollector();
    const baseline = await collector.captureBaseline(root, ["local.env"]);
    await writeFile(localConfig, "SECRET=modified\n");
    await expect(collector.collectChangedPaths(root, baseline)).rejects.toThrow(
      "Ignored implementation/config changes are prohibited",
    );
    await collector.rejectChanges(root, baseline);
    await expect(readFile(localConfig, "utf8")).resolves.toBe(
      "SECRET=original\n",
    );
    await expect(access(localConfig)).resolves.toBeUndefined();
  });

  it("collects tracked, untracked, deletion, and both sides of a rename NUL-safely", async () => {
    const root = await repository();
    const base = await new GitAdapter(root).baseCommit("main");
    await execFile("git", ["mv", "tracked.txt", "renamed name.txt"], {
      cwd: root,
    });
    await writeFile(join(root, "odd\nname.txt"), "untracked");
    await writeFile(join(root, "ignored.env"), "ignored but attributable\n");
    await unlink(join(root, "delete-me.txt"));
    const changes = await new GitAdapter(root).changesSince(base);
    expect(changes).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          kind: "rename",
          oldPath: "tracked.txt",
          path: "renamed name.txt",
        }),
        expect.objectContaining({ kind: "untracked", path: "odd\nname.txt" }),
        expect.objectContaining({ kind: "delete", path: "delete-me.txt" }),
      ]),
    );
    expect(new GitAdapter(root).boundaryPaths(changes)).toEqual(
      expect.arrayContaining([
        "tracked.txt",
        "renamed name.txt",
        "odd\nname.txt",
      ]),
    );
  });

  it("reports symlink escapes, case collisions, and gitlinks", async () => {
    const root = await repository();
    const outside = await mkdtemp(join(tmpdir(), "forge-outside-"));
    await symlink(join(outside, "secret"), join(root, "escape"));
    await symlink(join(outside, "deep-secret"), join(root, "link-b"));
    await symlink("link-b", join(root, "link-a"));
    await execFile("git", ["config", "core.ignorecase", "false"], {
      cwd: root,
    });
    await writeFile(join(root, "Case.txt"), "a");
    const { stdout: blob } = await execFile(
      "git",
      ["hash-object", "-w", "Case.txt"],
      { cwd: root },
    );
    await execFile(
      "git",
      [
        "update-index",
        "--add",
        "--cacheinfo",
        `100644,${blob.trim()},case.txt`,
      ],
      { cwd: root },
    );
    const git = new GitAdapter(root);
    await expect(git.validateChangedPaths(["escape"])).rejects.toThrow(
      "Symlink escapes repository",
    );
    await expect(git.validateChangedPaths(["link-a"])).rejects.toThrow(
      "Symlink escapes repository",
    );
    await expect(git.detectCaseCollisions()).resolves.toEqual([
      expect.arrayContaining(["Case.txt", "case.txt"]),
    ]);

    const child = await repository();
    await execFile(
      "git",
      [
        "-c",
        "protocol.file.allow=always",
        "submodule",
        "add",
        child,
        "vendor/sub",
      ],
      { cwd: root },
    );
    const entries = await git.changesSince(await git.baseCommit("main"));
    expect(entries).toContainEqual(
      expect.objectContaining({ path: "vendor/sub", gitlink: true }),
    );
  });
});

describe("WorktreeManager", () => {
  it("creates and deterministically reuses one task worktree", async () => {
    const root = await repository();
    const location = join(root, ".forge", "worktrees");
    await mkdir(location, { recursive: true });
    const manager = new WorktreeManager(root, location);
    const first = await manager.createOrReuse("MF 42", "main");
    const second = await manager.createOrReuse("MF 42", "main");
    expect(second).toEqual({ ...first, reused: true });
    expect(first.branch).toMatch(/^forge\/mf-42-[a-f0-9]{10}$/);
    expect(first.baseCommit).toMatch(/^[a-f0-9]{40}$/);
    expect(first.currentCommit).toBe(first.baseCommit);
    expect(await new GitAdapter(first.path).currentBranch()).toBe(first.branch);
  });
});
