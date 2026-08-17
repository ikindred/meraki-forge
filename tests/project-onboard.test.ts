import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import {
  onboardProject,
  type ProjectOnboardEffects,
} from "../packages/execution/src/project-onboard-service.js";

const repo = "/tmp/forge-onboard/existing";
const input = {
  project_id: "existing",
  display_name: "Existing",
  repository_path: repo,
  graphify_path: join(repo, "graphify-out"),
  obsidian_project_path: "/tmp/vault/Projects/Existing",
  stack: ["TypeScript"],
} as const;
function effects(
  result: "CHANGED" | "UNCHANGED" = "CHANGED",
): ProjectOnboardEffects {
  const mutation = vi.fn().mockResolvedValue(result);
  return {
    inspect: vi.fn().mockResolvedValue({ valid_git: true }),
    bootstrap: mutation,
    initializeGraphify: mutation,
    indexGraphify: mutation,
    proposeOwnership: mutation,
    register: mutation,
    createObsidianProject: mutation,
    validate: vi.fn().mockResolvedValue(true),
    doctor: vi.fn().mockResolvedValue(true),
  };
}

describe("existing project onboarding", () => {
  it("does not expose or execute a scaffold effect", async () => {
    const injected = effects();
    expect("scaffold" in injected).toBe(false);
    const result = await onboardProject(input, injected);
    expect(result.status).toBe("READY");
    expect(result.steps.some((step) => step.stage === "SCAFFOLD")).toBe(false);
  });

  it("plans dry-run without inspection or mutation", async () => {
    const injected = effects();
    const result = await onboardProject({ ...input, dry_run: true }, injected);
    expect(result.status).toBe("DRY_RUN");
    for (const effect of Object.values(injected))
      expect(effect).not.toHaveBeenCalled();
  });

  it("is idempotent and still validates an unchanged installation", async () => {
    const injected = effects("UNCHANGED");
    const result = await onboardProject(input, injected);
    expect(result.status).toBe("READY");
    expect(injected.validate).toHaveBeenCalledOnce();
    expect(
      result.steps.filter((step) => step.status === "UNCHANGED"),
    ).toHaveLength(6);
  });

  it("fails closed for a non-Git target before mutation", async () => {
    const base = effects();
    const injected: ProjectOnboardEffects = {
      ...base,
      inspect: vi.fn().mockResolvedValue({ valid_git: false }),
    };
    const result = await onboardProject(input, injected);
    expect(result.status).toBe("NOT_READY");
    expect(injected.bootstrap).not.toHaveBeenCalled();
  });
});
