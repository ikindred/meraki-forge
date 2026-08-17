import { mkdtemp, mkdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  applyBootstrapPlan,
  planBootstrap,
} from "../packages/execution/src/bootstrap-service.js";

describe("bootstrap end to end", () => {
  it("is idempotent and preserves machine state, artifacts, and human content", async () => {
    const root = await mkdtemp(join(tmpdir(), "forge-bootstrap-e2e-"));
    const repository = join(root, "repo");
    const vault = join(root, "vault");
    await mkdir(join(repository, ".forge/state"), { recursive: true });
    await mkdir(join(repository, ".forge/artifacts"), { recursive: true });
    await mkdir(vault);
    await writeFile(join(repository, ".forge/state/task.json"), "truth\n");
    await writeFile(join(repository, ".forge/artifacts/proof.txt"), "proof\n");
    const plan = planBootstrap({
      repositoryRoot: repository,
      vaultRoot: vault,
      commandCenterName: "Forge",
      projectName: "Forge",
      managedFiles: {
        ".forge/project.yml": "schema_version: 1\nproject:\n  id: forge\n",
      },
    });
    const first = await applyBootstrapPlan(plan);
    const second = await applyBootstrapPlan(plan);
    expect(first.status).toBe("APPLIED");
    expect(second.status).toBe("UNCHANGED");
    expect(
      await readFile(join(repository, ".forge/state/task.json"), "utf8"),
    ).toBe("truth\n");
    expect(
      await readFile(join(repository, ".forge/artifacts/proof.txt"), "utf8"),
    ).toBe("proof\n");
    await writeFile(
      join(vault, "Forge/AI Engineering/Tasks.md"),
      "<!-- BEGIN MERAKI FORGE MANAGED -->\nmanaged\n<!-- END MERAKI FORGE MANAGED -->\n\nHuman task\n",
    );
    await applyBootstrapPlan(plan);
    expect(
      await readFile(join(vault, "Forge/AI Engineering/Tasks.md"), "utf8"),
    ).toContain("Human task");
  });
});
