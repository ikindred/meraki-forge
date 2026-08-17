import { mkdtemp, mkdir, readFile, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  applySharedVaultProject,
  planSharedVaultProject,
} from "../packages/adapters/src/shared-vault.js";

describe("shared Obsidian vault", () => {
  it("creates an idempotent Projects/<Name> memory area and concise Project.md", async () => {
    const root = await mkdtemp(join(tmpdir(), "forge-shared-vault-"));
    const repository = join(root, "repo");
    const vault = join(root, "vault");
    await mkdir(repository);
    await mkdir(vault);
    const plan = planSharedVaultProject(repository, vault, {
      projectId: "kyra",
      displayName: "Kyra",
      purpose: "Inventory management",
      repositoryPath: repository,
      stackSummary: "Next.js / PostgreSQL",
      graphifyStatus: "fresh at abc123",
      forgeStatus: "READY",
    });
    expect(plan.projectPath).toBe("Projects/Kyra");
    expect(await applySharedVaultProject(plan)).toMatchObject({
      status: "APPLIED",
    });
    expect(await applySharedVaultProject(plan)).toMatchObject({
      status: "UNCHANGED",
    });
    const entry = await readFile(
      join(vault, "Projects/Kyra/Project.md"),
      "utf8",
    );
    expect(entry).toContain("Inventory management");
    expect(entry).toContain(repository);
    expect(entry).toContain("[[Tasks]]");
    expect(entry.length).toBeLessThan(1_500);
  });

  it("rejects traversal and symlink destinations", async () => {
    const root = await mkdtemp(join(tmpdir(), "forge-shared-vault-safe-"));
    const repository = join(root, "repo");
    const vault = join(root, "vault");
    const outside = join(root, "outside");
    await Promise.all([mkdir(repository), mkdir(vault), mkdir(outside)]);
    expect(() =>
      planSharedVaultProject(repository, vault, {
        projectId: "bad",
        displayName: "../bad",
        purpose: "bad",
        repositoryPath: repository,
        stackSummary: "unknown",
        graphifyStatus: "missing",
        forgeStatus: "NOT READY",
      }),
    ).toThrow(/safe path segment/u);
    await mkdir(join(vault, "Projects"));
    await symlink(outside, join(vault, "Projects/Kyra"));
    const plan = planSharedVaultProject(repository, vault, {
      projectId: "kyra",
      displayName: "Kyra",
      purpose: "safe",
      repositoryPath: repository,
      stackSummary: "TypeScript",
      graphifyStatus: "fresh",
      forgeStatus: "READY",
    });
    await expect(applySharedVaultProject(plan)).rejects.toThrow(
      /symbolic link/u,
    );
  });
});
