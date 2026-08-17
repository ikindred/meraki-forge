import { mkdtemp, mkdir, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  applyBootstrapPlan,
  planBootstrap,
} from "../packages/execution/src/bootstrap-service.js";

describe("multi-project bootstrap", () => {
  it("keeps simultaneous project outputs isolated", async () => {
    const root = await mkdtemp(join(tmpdir(), "forge-multi-"));
    const vault = join(root, "vault");
    await mkdir(vault);
    const repoA = join(root, "a");
    const repoB = join(root, "b");
    await mkdir(repoA);
    await mkdir(repoB);
    const a = planBootstrap({
      repositoryRoot: repoA,
      vaultRoot: vault,
      commandCenterName: "Alpha",
      projectName: "Alpha",
      managedFiles: { ".forge/project.yml": "id: alpha\n" },
    });
    const b = planBootstrap({
      repositoryRoot: repoB,
      vaultRoot: vault,
      commandCenterName: "Beta",
      projectName: "Beta",
      managedFiles: { ".forge/project.yml": "id: beta\n" },
    });
    await Promise.all([applyBootstrapPlan(a), applyBootstrapPlan(b)]);
    expect(await readFile(join(repoA, ".forge/project.yml"), "utf8")).toContain(
      "alpha",
    );
    expect(await readFile(join(repoB, ".forge/project.yml"), "utf8")).toContain(
      "beta",
    );
    expect(
      await readFile(join(vault, "Alpha/AI Engineering/Tasks.md"), "utf8"),
    ).toContain("Alpha");
    expect(
      await readFile(join(vault, "Beta/AI Engineering/Tasks.md"), "utf8"),
    ).toContain("Beta");
  });
});
