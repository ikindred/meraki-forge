import { describe, expect, it } from "vitest";
import {
  deterministicProjectId,
  MasterProjectRegistrySchema,
  resolveProject,
  resolveProjectReferences,
} from "../packages/kernel/src/index.js";

const registry = MasterProjectRegistrySchema.parse({
  schema_version: "1",
  revision: 2,
  updated_at: "2026-08-17T00:00:00.000Z",
  projects: [
    project("kyra", "Kyra", "/repos/kyra", ["kyra-app"]),
    project("valet-master", "Valet Master", "/repos/valet", ["valet"]),
    project("valet-mobile", "Valet Mobile", "/repos/mobile", ["valet"]),
  ],
});

describe("project resolver", () => {
  it("resolves deterministically by id, exact display name, or normalized alias", () => {
    expect(resolveProject(registry, "kyra")).toMatchObject({
      status: "RESOLVED",
      project: { project_id: "kyra" },
    });
    expect(resolveProject(registry, "Valet Master")).toMatchObject({
      status: "RESOLVED",
      project: { project_id: "valet-master" },
    });
    expect(resolveProject(registry, " KYRA APP ")).toMatchObject({
      status: "RESOLVED",
      project: { project_id: "kyra" },
    });
  });

  it("never guesses ambiguous or missing references", () => {
    expect(resolveProject(registry, "valet")).toEqual({
      status: "AMBIGUOUS",
      reference: "valet",
      candidate_project_ids: ["valet-master", "valet-mobile"],
    });
    expect(resolveProject(registry, "unknown")).toEqual({
      status: "NOT_FOUND",
      reference: "unknown",
      candidate_project_ids: [],
    });
  });

  it("allows multi-project reads but denies cross-project writes structurally", () => {
    expect(
      resolveProjectReferences(registry, ["kyra", "Valet Master"], "READ"),
    ).toMatchObject({
      status: "RESOLVED",
      project_ids: ["kyra", "valet-master"],
    });
    expect(
      resolveProjectReferences(registry, ["kyra", "Valet Master"], "WRITE"),
    ).toEqual({
      status: "DENIED",
      reason: "CROSS_PROJECT_WRITE_FORBIDDEN",
      project_ids: ["kyra", "valet-master"],
    });
  });

  it("rejects names that cannot produce a safe deterministic id", () => {
    expect(() => deterministicProjectId("---")).toThrow(/safe project id/u);
  });

  it("rejects duplicate repository and Obsidian identities in registry input", () => {
    const duplicate = {
      ...project("duplicate", "Duplicate", "/repos/kyra", []),
      obsidian_project_path: "/vault/Projects/Kyra",
    };
    expect(() =>
      MasterProjectRegistrySchema.parse({
        ...registry,
        projects: [...registry.projects, duplicate],
      }),
    ).toThrow(/Duplicate/u);
  });
});

function project(
  project_id: string,
  display_name: string,
  repo_path: string,
  aliases: string[],
) {
  return {
    project_id,
    display_name,
    repo_path,
    aliases,
    forge_config_path: `${repo_path}/.forge/config.yml`,
    graphify_path: `${repo_path}/graphify-out`,
    obsidian_project_path: `/vault/Projects/${display_name}`,
    stack_summary: "TypeScript",
    registration_status: "ACTIVE",
    registered_at: "2026-08-17T00:00:00.000Z",
    updated_at: "2026-08-17T00:00:00.000Z",
    record_version: 1,
  };
}
