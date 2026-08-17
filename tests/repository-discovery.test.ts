import { execFile as execFileCallback } from "node:child_process";
import { mkdtemp, mkdir, realpath, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";
import { inspectProjectRepository } from "../packages/adapters/src/project-inspector.js";

const execFile = promisify(execFileCallback);

describe("repository inspection", () => {
  it("finds the canonical root and bounded multi-stack evidence", async () => {
    const root = await mkdtemp(join(tmpdir(), "forge-inspect-"));
    await execFile("git", ["init", "-b", "main", root]);
    await mkdir(join(root, "web"));
    await writeFile(
      join(root, "web", "package.json"),
      JSON.stringify({
        dependencies: { next: "1", react: "1" },
        devDependencies: { "@playwright/test": "1" },
      }),
    );
    await writeFile(join(root, "go.mod"), "module example.test/service\n");
    await writeFile(join(root, "Dockerfile"), "FROM scratch\n");
    await writeFile(join(root, "AGENTS.md"), "project instructions\n");
    await execFile("git", [
      "-C",
      root,
      "remote",
      "add",
      "origin",
      "https://github.com/acme/example.git",
    ]);

    const result = await inspectProjectRepository(join(root, "web"));

    expect(result.repositoryRoot).toBe(await realpath(root));
    expect(result.branch.current).toBe("main");
    expect(result.remotes).toEqual([
      { name: "origin", url: "https://github.com/acme/example.git" },
    ]);
    expect(result.stack.evidence.map((item) => item.name)).toEqual(
      expect.arrayContaining([
        "Next.js",
        "React",
        "Playwright",
        "Go",
        "Docker",
      ]),
    );
    expect(result.existing.agents).toBe(true);
    expect(result.git.clean).toBe(false);
  });

  it("fails closed outside Git and rejects invalid resource limits", async () => {
    const directory = await mkdtemp(join(tmpdir(), "forge-inspect-"));
    await expect(inspectProjectRepository(directory)).rejects.toThrow(
      "not a Git repository",
    );
    await expect(
      inspectProjectRepository(directory, { maxFiles: 0 }),
    ).rejects.toThrow("Invalid inspection limits");
  });
});
