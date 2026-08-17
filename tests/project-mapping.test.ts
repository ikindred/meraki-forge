import { mkdtemp, mkdir, realpath, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  ProjectMappingError,
  resolveProjectMapping,
} from "../packages/adapters/src/project-mapping.js";

describe("project mapping", () => {
  it("canonically binds one command center to one repository", async () => {
    const root = await mkdtemp(join(tmpdir(), "forge-map-"));
    const repository = join(root, "repository");
    const vault = join(root, "vault");
    await mkdir(repository);
    await mkdir(join(vault, "Command Center", "Tasks"), { recursive: true });

    const mapping = await resolveProjectMapping({
      project: {
        id: "forge",
        name: "Meraki Forge",
        repository_path: repository,
        default_branch: "main",
      },
      obsidian: {
        vault_path: vault,
        command_center_path: "Command Center",
        tasks: "Tasks",
        orchestrator: "Orchestrator",
        daily_plans: "Daily Plans",
        reports: "Reports",
      },
      forge: { state_root: ".forge/state", artifact_root: ".forge/artifacts" },
    });

    expect(mapping.project.repository_path).toBe(await realpath(repository));
    expect(mapping.obsidian.command_center_path).toBe(
      join(await realpath(vault), "Command Center"),
    );
    expect(mapping.obsidian.tasks).toBe(
      join(await realpath(vault), "Command Center", "Tasks"),
    );
  });

  it("rejects command-center escape and symlink isolation bypass", async () => {
    const root = await mkdtemp(join(tmpdir(), "forge-map-"));
    const repository = join(root, "repository");
    const vault = join(root, "vault");
    const outside = join(root, "outside");
    await mkdir(repository);
    await mkdir(vault);
    await mkdir(outside);
    await symlink(outside, join(vault, "linked"));
    const base = {
      project: {
        id: "a",
        name: "A",
        repository_path: repository,
        default_branch: "main",
      },
      forge: { state_root: ".forge/state", artifact_root: ".forge/artifacts" },
    } as const;

    await expect(
      resolveProjectMapping({
        ...base,
        obsidian: {
          vault_path: vault,
          command_center_path: "../outside",
          tasks: "Tasks",
          orchestrator: "Orchestrator",
          daily_plans: "Daily",
          reports: "Reports",
        },
      }),
    ).rejects.toBeInstanceOf(ProjectMappingError);
    await expect(
      resolveProjectMapping({
        ...base,
        obsidian: {
          vault_path: vault,
          command_center_path: "linked",
          tasks: "Tasks",
          orchestrator: "Orchestrator",
          daily_plans: "Daily",
          reports: "Reports",
        },
      }),
    ).rejects.toBeInstanceOf(ProjectMappingError);
  });
});
