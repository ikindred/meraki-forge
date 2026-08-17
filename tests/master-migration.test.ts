import { describe, expect, it } from "vitest";
import {
  applyMasterMigration,
  planMasterMigration,
  type MasterMigrationAdapter,
} from "../packages/execution/src/master-migration.js";

const legacy = {
  schema_version: "1" as const,
  project_id: "kyra",
  display_name: "Kyra",
  repo_path: "/repos/kyra",
  forge_config_path: "/repos/kyra/.forge/config.yml",
  graphify_path: "/repos/kyra/graphify-out",
  stack_summary: "TypeScript",
  command_center: {
    vault_path: "/vault",
    command_center_path: "Kyra/AI Engineering",
  },
};

describe("master architecture migration", () => {
  it("proposes registry/shared-vault mappings without moving or deleting legacy content", () => {
    const plan = planMasterMigration({ legacy, sharedVaultPath: "/vault" });
    expect(plan.status).toBe("READY");
    expect(plan.registry_project.obsidian_project_path).toBe(
      "/vault/Projects/Kyra",
    );
    expect(plan.actions).toEqual([
      expect.objectContaining({
        action: "CREATE",
        target: "/vault/Projects/Kyra",
      }),
      expect.objectContaining({ action: "REGISTER", target: "kyra" }),
      expect.objectContaining({
        action: "REFERENCE_LEGACY",
        source: "/vault/Kyra/AI Engineering",
      }),
    ]);
    expect(JSON.stringify(plan)).not.toMatch(/"(MOVE|DELETE)"/u);
  });

  it("is dry-run/idempotent and applies only an explicitly approved proposal", async () => {
    const calls: string[] = [];
    const adapter: MasterMigrationAdapter = {
      inspect: () =>
        Promise.resolve({ registryMatch: false, workspaceExists: false }),
      apply: () => {
        calls.push("apply");
        return Promise.resolve();
      },
    };
    const plan = await planMasterMigration(
      { legacy, sharedVaultPath: "/vault" },
      adapter,
    );
    expect(
      await applyMasterMigration(plan, adapter, { dryRun: true }),
    ).toMatchObject({ status: "DRY_RUN" });
    expect(calls).toEqual([]);
    expect(
      await applyMasterMigration(plan, adapter, { approved: true }),
    ).toMatchObject({ status: "APPLIED" });
    expect(calls).toEqual(["apply"]);

    const unchangedAdapter: MasterMigrationAdapter = {
      inspect: () =>
        Promise.resolve({ registryMatch: true, workspaceExists: true }),
      apply: () => {
        calls.push("unexpected");
        return Promise.resolve();
      },
    };
    const unchanged = await planMasterMigration(
      { legacy, sharedVaultPath: "/vault" },
      unchangedAdapter,
    );
    expect(unchanged.status).toBe("UNCHANGED");
    expect(
      await applyMasterMigration(unchanged, unchangedAdapter, {
        approved: true,
      }),
    ).toMatchObject({ status: "UNCHANGED" });
  });

  it("reports conflicts and never silently overwrites a registry/workspace mapping", async () => {
    const adapter: MasterMigrationAdapter = {
      inspect: () =>
        Promise.resolve({
          registryMatch: false,
          workspaceExists: true,
          conflict: "Project workspace is owned by another registration",
        }),
      apply: () => Promise.resolve(),
    };
    const plan = await planMasterMigration(
      { legacy, sharedVaultPath: "/vault" },
      adapter,
    );
    expect(plan).toMatchObject({
      status: "CONFLICT",
      conflicts: [expect.stringMatching(/another registration/u)],
    });
    await expect(
      applyMasterMigration(plan, adapter, { approved: true }),
    ).rejects.toThrow(/MIGRATION_CONFLICT/u);
  });

  it("requires explicit approval and rejects traversal-like project names", async () => {
    const plan = planMasterMigration({ legacy, sharedVaultPath: "/vault" });
    await expect(
      applyMasterMigration(plan, {
        inspect: () => Promise.resolve({}),
        apply: () => Promise.resolve(),
      }),
    ).rejects.toThrow(/MIGRATION_APPROVAL_REQUIRED/u);
    expect(() =>
      planMasterMigration({
        legacy: { ...legacy, display_name: "../Kyra" },
        sharedVaultPath: "/vault",
      }),
    ).toThrow(/MIGRATION_PROJECT_NAME_INVALID/u);
  });
});
