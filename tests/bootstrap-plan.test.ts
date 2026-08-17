import { mkdtemp, mkdir, readFile, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  applyBootstrapPlan,
  planBootstrap,
} from "../packages/execution/src/bootstrap-service.js";

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "forge-bootstrap-"));
  const repository = join(root, "repo");
  const vault = join(root, "vault");
  await mkdir(repository);
  await mkdir(vault);
  return { root, repository, vault };
}

describe("bootstrap plan", () => {
  it("has a dry run that performs zero writes", async () => {
    const { repository, vault } = await fixture();
    const plan = planBootstrap({
      repositoryRoot: repository,
      vaultRoot: vault,
      commandCenterName: "Kyra",
      projectName: "Kyra",
      managedFiles: { ".forge/config.yml": "schema_version: 1\n" },
    });
    const result = await applyBootstrapPlan(plan, { dryRun: true });
    expect(result.status).toBe("DRY_RUN");
    await expect(
      readFile(join(repository, ".forge/config.yml")),
    ).rejects.toMatchObject({ code: "ENOENT" });
    await expect(
      readFile(join(vault, "Kyra/AI Engineering/Tasks.md")),
    ).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("fails closed on unmanaged conflicts and symlinked destinations", async () => {
    const { root, repository, vault } = await fixture();
    await mkdir(join(repository, ".forge"));
    await writeFile(join(repository, ".forge/config.yml"), "human: true\n");
    const plan = planBootstrap({
      repositoryRoot: repository,
      vaultRoot: vault,
      commandCenterName: "Kyra",
      projectName: "Kyra",
      managedFiles: { ".forge/config.yml": "schema_version: 1\n" },
    });
    await expect(applyBootstrapPlan(plan)).rejects.toThrow(/conflict/i);
    expect(await readFile(join(repository, ".forge/config.yml"), "utf8")).toBe(
      "human: true\n",
    );

    const outside = join(root, "outside");
    await mkdir(outside);
    await symlink(outside, join(vault, "Kyra"));
    await expect(applyBootstrapPlan(plan)).rejects.toThrow(/symbolic link/i);
  });

  it("never allows generated files to target machine truth or Git internals", async () => {
    const { repository, vault } = await fixture();
    for (const path of [
      ".forge/state/task.json",
      ".forge/artifacts/proof.txt",
      ".git/config",
    ]) {
      expect(() =>
        planBootstrap({
          repositoryRoot: repository,
          vaultRoot: vault,
          commandCenterName: "Kyra",
          projectName: "Kyra",
          managedFiles: { [path]: "overwrite\n" },
        }),
      ).toThrow(/protected state/i);
    }
  });
});
