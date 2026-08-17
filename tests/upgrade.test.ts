import { mkdtemp, mkdir, readFile, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  planUpgrade,
  applyUpgrade,
} from "../packages/execution/src/upgrade-service.js";

describe("forge upgrade", () => {
  it("dry-runs bundled migrations without mutation and preserves overrides/user files", async () => {
    const root = await mkdtemp(join(tmpdir(), "forge-upgrade-"));
    await mkdir(join(root, ".forge"));
    await writeFile(
      join(root, ".forge/config.yml"),
      "schema_version: '1'\ncustom: yes\n",
    );
    await writeFile(join(root, "README.md"), "human\n");
    const plan = await planUpgrade(root, "2", [
      {
        path: ".forge/config.yml",
        classification: "PROJECT_OVERRIDE",
        content: "schema_version: '2'\n",
      },
      {
        path: "contracts/core.md",
        classification: "FORGE_MANAGED",
        content: "v2\n",
      },
    ]);
    expect(plan.status).toBe("CONFLICT");
    expect(await readFile(join(root, ".forge/config.yml"), "utf8")).toContain(
      "'1'",
    );
    expect(await readFile(join(root, "README.md"), "utf8")).toBe("human\n");
  });

  it("atomically applies only safe Forge-managed updates and is idempotent", async () => {
    const root = await mkdtemp(join(tmpdir(), "forge-upgrade-"));
    const templates = [
      {
        path: ".forge/contracts/core.md",
        classification: "FORGE_MANAGED" as const,
        content: "v2\n",
      },
    ];
    const first = await applyUpgrade(root, "2", templates);
    const second = await applyUpgrade(root, "2", templates);
    expect(first.status).toBe("APPLIED");
    expect(second.status).toBe("UNCHANGED");
    expect(await readFile(join(root, ".forge/contracts/core.md"), "utf8")).toBe(
      "v2\n",
    );
  });

  it("rejects escaping template paths", async () => {
    const root = await mkdtemp(join(tmpdir(), "forge-upgrade-"));
    await expect(
      applyUpgrade(root, "2", [
        { path: "../escape", classification: "FORGE_MANAGED", content: "bad" },
      ]),
    ).rejects.toThrow("UPGRADE_PATH_ESCAPE");
  });

  it("rejects symlinked upgrade parents", async () => {
    const root = await mkdtemp(join(tmpdir(), "forge-upgrade-"));
    const outside = await mkdtemp(join(tmpdir(), "forge-outside-"));
    await symlink(outside, join(root, ".forge"));
    await expect(
      applyUpgrade(root, "2", [
        {
          path: ".forge/core.md",
          classification: "FORGE_MANAGED",
          content: "bad",
        },
      ]),
    ).rejects.toThrow("UPGRADE_SYMLINK_DENIED");
  });

  it("rejects duplicate paths and invalid migration versions", async () => {
    const root = await mkdtemp(join(tmpdir(), "forge-upgrade-"));
    const template = {
      path: ".forge/core.md",
      classification: "FORGE_MANAGED" as const,
      content: "v2",
    };
    await expect(planUpgrade(root, "next", [template])).rejects.toThrow(
      "UPGRADE_VERSION_INVALID",
    );
    await expect(planUpgrade(root, "2", [template, template])).rejects.toThrow(
      "UPGRADE_DUPLICATE_PATH",
    );
  });
});
