import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import {
  createProject,
  type ProjectCreateEffects,
} from "../packages/execution/src/project-create-service.js";
import { recommendTechnology } from "../packages/kernel/src/technology-policy.js";

const repo = "/tmp/forge-create/inventory";
const input = {
  project_id: "inventory",
  display_name: "Inventory",
  repository_path: repo,
  graphify_path: join(repo, "graphify-out"),
  obsidian_project_path: "/tmp/vault/Projects/Inventory",
  technology: recommendTechnology({ project_type: "full-stack" }),
  architecture_approved: false,
} as const;

function effects(
  result: "CHANGED" | "UNCHANGED" = "CHANGED",
): ProjectCreateEffects {
  const mutation = vi.fn().mockResolvedValue(result);
  return {
    createDirectory: mutation,
    scaffold: mutation,
    initializeGit: mutation,
    createBaselineCommit: mutation,
    bootstrap: mutation,
    initializeGraphify: mutation,
    indexGraphify: mutation,
    proposeOwnership: mutation,
    register: mutation,
    createObsidianProject: mutation,
    configureTooling: mutation,
    validate: vi.fn().mockResolvedValue(true),
    doctor: vi.fn().mockResolvedValue(true),
  };
}

describe("project creation workflow", () => {
  it("has a deterministic approved stack recommendation and rationale", () => {
    expect(input.technology.stack).toEqual([
      "Next.js",
      "React",
      "TypeScript",
      "PostgreSQL",
    ]);
    expect(input.technology.rationale[0]).toContain("policy version 1");
    expect(
      recommendTechnology({
        project_type: "backend",
        existing_ecosystem: ["Laravel"],
      }).stack,
    ).toEqual(["Laravel", "PHP", "PostgreSQL"]);
  });

  it("plans a dry run with exactly zero effects", async () => {
    const injected = effects();
    const result = await createProject({ ...input, dry_run: true }, injected);
    expect(result.status).toBe("DRY_RUN");
    expect(result.steps.map((step) => step.stage)).toContain("GRAPHIFY_INDEX");
    for (const effect of Object.values(injected))
      expect(effect).not.toHaveBeenCalled();
  });

  it("executes all local stages and becomes ready", async () => {
    const result = await createProject(input, effects());
    expect(result.status).toBe("READY");
    expect(result.steps.at(-1)).toMatchObject({
      stage: "DOCTOR",
      status: "COMPLETED",
    });
  });

  it("is idempotent when effect adapters report unchanged", async () => {
    const result = await createProject(input, effects("UNCHANGED"));
    expect(result.status).toBe("READY");
    expect(
      result.steps.filter((step) => step.status === "UNCHANGED"),
    ).toHaveLength(11);
  });

  it("requires approval for architecture decisions selected by policy", async () => {
    const injected = effects();
    const technology = recommendTechnology({
      project_type: "backend",
      security_sensitivity: "high",
    });
    const result = await createProject({ ...input, technology }, injected);
    expect(result).toMatchObject({
      status: "NOT_READY",
      next_actions: [expect.stringContaining("Approve")],
    });
    for (const effect of Object.values(injected))
      expect(effect).not.toHaveBeenCalled();
  });

  it("returns not ready with an exact recovery action", async () => {
    const base = effects();
    const injected: ProjectCreateEffects = {
      ...base,
      validate: vi.fn().mockResolvedValue(false),
    };
    const result = await createProject(input, injected);
    expect(result.status).toBe("NOT_READY");
    expect(result.next_actions).toEqual([
      "Resolve Forge validation failures, then rerun project create.",
    ]);
    expect(injected.doctor).not.toHaveBeenCalled();
  });
});
