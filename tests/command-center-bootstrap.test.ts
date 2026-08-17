import { mkdtemp, mkdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  applyBootstrapPlan,
  planBootstrap,
} from "../packages/execution/src/bootstrap-service.js";
import { parseTaskMarkdown } from "../packages/adapters/src/task-markdown.js";

describe("Command Center bootstrap", () => {
  it("creates the human visibility tree and composes AGENTS.md without erasing human instructions", async () => {
    const root = await mkdtemp(join(tmpdir(), "forge-command-center-"));
    const repository = join(root, "repo");
    const vault = join(root, "vault");
    await mkdir(repository);
    await mkdir(vault);
    await writeFile(
      join(repository, "AGENTS.md"),
      "# Team\n\nKeep this instruction.\n",
    );
    const plan = planBootstrap({
      repositoryRoot: repository,
      vaultRoot: vault,
      commandCenterName: "My Project",
      projectName: "My Project",
      managedFiles: {},
    });
    await applyBootstrapPlan(plan);
    expect(await readFile(join(repository, "AGENTS.md"), "utf8")).toContain(
      "Keep this instruction.",
    );
    expect(await readFile(join(repository, "AGENTS.md"), "utf8")).toContain(
      "BEGIN MERAKI FORGE MANAGED",
    );
    const tasks = await readFile(
      join(vault, "My Project/AI Engineering/Tasks.md"),
      "utf8",
    );
    expect(tasks).toContain("HUMAN INTENT");
    const template = await readFile(
      join(vault, "My Project/AI Engineering/Templates/Standard Task.md"),
      "utf8",
    );
    expect(template).toContain("Known Dependencies: NONE");
    expect(parseTaskMarkdown(template)).toMatchObject({
      mode: "AUTO",
      priority: "P2",
      acceptance_criteria: [{ id: "AC-1" }, { id: "AC-2" }],
    });
    await expect(
      readFile(join(vault, "My Project/AI Engineering/state.json")),
    ).rejects.toMatchObject({ code: "ENOENT" });
  });
});
