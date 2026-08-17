import { describe, expect, it } from "vitest";
import {
  ForgeBootstrapConfigSchema,
  ProjectBootstrapConfigSchema,
  parseBootstrapConfigYaml,
} from "../packages/kernel/src/index.js";

const valid = {
  schema_version: "1",
  project: {
    id: "meraki-forge",
    name: "Meraki Forge",
    repository_path: "/workspace/meraki-forge",
    repository_identity: "kindred/meraki-forge",
    default_branch: "main",
    stack_profile: "typescript-monorepo",
  },
  obsidian: {
    vault_path: "/vault",
    command_center_path: "Meraki Forge/AI Engineering",
  },
  delivery: {
    remote_push: true,
    create_pr: true,
    auto_merge: false,
    production_deploy: false,
  },
  autonomy: { allowed_risk: "MEDIUM", modes: ["AUTO", "PLAN"] },
  evidence: {
    ui_video_required: true,
    screenshots_required: true,
    responsive_viewports: ["375x812", "1440x900"],
  },
} as const;

describe("versioned bootstrap configuration", () => {
  it("accepts a strict version-one config and parses its YAML target", () => {
    expect(ForgeBootstrapConfigSchema.parse(valid)).toEqual(valid);
    expect(
      parseBootstrapConfigYaml(
        `schema_version: "1"\nproject:\n  id: meraki-forge\n  name: Meraki Forge\n  repository_path: /workspace/meraki-forge\n  repository_identity: kindred/meraki-forge\n  default_branch: main\n  stack_profile: typescript-monorepo\nobsidian:\n  vault_path: /vault\n  command_center_path: Meraki Forge/AI Engineering\ndelivery:\n  remote_push: true\n  create_pr: true\n  auto_merge: false\n  production_deploy: false\nautonomy:\n  allowed_risk: MEDIUM\n  modes: [AUTO, PLAN]\nevidence:\n  ui_video_required: true\n  screenshots_required: true\n  responsive_viewports: [375x812, 1440x900]\n`,
      ).project.id,
    ).toBe("meraki-forge");
  });

  it("rejects unknown versions and unknown keys", () => {
    expect(() =>
      ForgeBootstrapConfigSchema.parse({ ...valid, schema_version: "2" }),
    ).toThrow();
    expect(() =>
      ForgeBootstrapConfigSchema.parse({ ...valid, surprise: true }),
    ).toThrow();
  });

  it("makes merge and production deployment non-overridable safety floors", () => {
    expect(() =>
      ForgeBootstrapConfigSchema.parse({
        ...valid,
        delivery: { ...valid.delivery, auto_merge: true },
      }),
    ).toThrow();
    expect(() =>
      ForgeBootstrapConfigSchema.parse({
        ...valid,
        delivery: { ...valid.delivery, production_deploy: true },
      }),
    ).toThrow();
  });

  it("requires deterministic, absolute project mapping", () => {
    expect(() =>
      ProjectBootstrapConfigSchema.parse({
        ...valid.project,
        repository_path: "../another-project",
      }),
    ).toThrow();
    expect(() =>
      ProjectBootstrapConfigSchema.parse({
        ...valid.project,
        command_center_path: "wrong-layer",
      }),
    ).toThrow();
  });

  it("rejects credential-bearing repository identities", () => {
    expect(() =>
      ForgeBootstrapConfigSchema.parse({
        ...valid,
        project: {
          ...valid.project,
          repository_identity:
            "https://user:ghp_abcdefghijklmnopqrstuvwxyz@github.com/org/repo.git",
        },
      }),
    ).toThrow(/credentials/u);
    expect(() =>
      ForgeBootstrapConfigSchema.parse({
        ...valid,
        project: {
          ...valid.project,
          repository_identity: "user:plainpassword@github.com:org/repo.git",
        },
      }),
    ).toThrow(/credentials/u);
  });
});
