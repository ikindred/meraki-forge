import {
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rename,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";
import { MasterProjectRegistrySchema } from "../packages/kernel/src/master-registry.js";
import { MasterConfigSchema } from "../packages/kernel/src/master-config.js";
import {
  applyMachineInit,
  loadMasterConfig,
  planMachineInit,
} from "../packages/adapters/src/machine-init.js";

async function fixture() {
  const root = await realpath(
    await mkdtemp(join(tmpdir(), "forge-machine-init-")),
  );
  const documents = join(root, "Documents");
  const forge = join(documents, "Meraki Forge");
  await mkdir(forge, { recursive: true });
  return { root, documents, forge };
}

describe("machine initialization", () => {
  it("plans without mutation, then initializes config, registry, roots, and vault", async () => {
    const f = await fixture();
    const home = join(f.root, ".meraki-forge");
    const plan = await planMachineInit({
      forgeRoot: f.forge,
      masterHome: home,
    });
    const documents = await realpath(f.documents);
    expect(plan.projects_root).toBe(join(documents, "Meraki Forge Projects"));
    expect(plan.obsidian_vault).toBe(join(documents, "Meraki Forge Vault"));
    expect(plan.changes.length).toBeGreaterThan(0);
    await expect(lstat(home)).rejects.toThrow();

    const first = await applyMachineInit(plan);
    expect(first.status).toBe("APPLIED");
    expect(
      MasterConfigSchema.parse(parse(await readFile(plan.config_path, "utf8"))),
    ).toMatchObject({
      forge_root: await realpath(f.forge),
      projects_root: plan.projects_root,
      obsidian_vault: plan.obsidian_vault,
      safety: { auto_merge: false, production_deploy: false },
    });
    expect(
      MasterProjectRegistrySchema.parse(
        parse(await readFile(plan.registry_path, "utf8")),
      ).projects,
    ).toEqual([]);
    await expect(
      readFile(join(plan.obsidian_vault, "Dashboard.md"), "utf8"),
    ).resolves.toMatch(/Meraki Forge Dashboard/u);
    await expect(
      readFile(
        join(plan.obsidian_vault, "Cross Project/Active Work.md"),
        "utf8",
      ),
    ).resolves.toMatch(/Active Work/u);

    const secondPlan = await planMachineInit({
      forgeRoot: f.forge,
      masterHome: home,
    });
    const second = await applyMachineInit(secondPlan);
    expect(second.status).toBe("UNCHANGED");
  });

  it("preserves existing registry projects and human vault content", async () => {
    const f = await fixture();
    const home = join(f.root, ".meraki-forge");
    const plan = await planMachineInit({
      forgeRoot: f.forge,
      masterHome: home,
    });
    await applyMachineInit(plan);
    await writeFile(join(plan.obsidian_vault, "Personal.md"), "keep me\n");
    const registry = MasterProjectRegistrySchema.parse(
      parse(await readFile(plan.registry_path, "utf8")),
    );
    const project = {
      project_id: "existing",
      display_name: "Existing",
      repo_path: join(f.root, "existing"),
      forge_config_path: join(f.root, "existing/.forge/config.yml"),
      graphify_path: join(f.root, "existing/graphify-out"),
      obsidian_project_path: join(plan.obsidian_vault, "Projects/Existing"),
      stack_summary: "TypeScript",
      registration_status: "ACTIVE",
      aliases: [],
      registered_at: "2026-08-17T00:00:00.000Z",
      updated_at: "2026-08-17T00:00:00.000Z",
      record_version: 1,
    };
    await writeFile(
      plan.registry_path,
      `${JSON.stringify({ ...registry, revision: 7, projects: [project] })}\n`,
    );
    await applyMachineInit(
      await planMachineInit({ forgeRoot: f.forge, masterHome: home }),
    );
    const preserved = MasterProjectRegistrySchema.parse(
      parse(await readFile(plan.registry_path, "utf8")),
    );
    expect(preserved.revision).toBe(7);
    expect(preserved.projects).toEqual([project]);
    expect(
      await readFile(join(plan.obsidian_vault, "Personal.md"), "utf8"),
    ).toBe("keep me\n");
  });

  it("serializes concurrent initialization without corrupting state", async () => {
    const f = await fixture();
    const home = join(f.root, ".meraki-forge");
    const plan = await planMachineInit({
      forgeRoot: f.forge,
      masterHome: home,
    });
    const results = await Promise.allSettled([
      applyMachineInit(plan),
      applyMachineInit(plan),
    ]);
    expect(
      results.filter((result) => result.status === "fulfilled"),
    ).toHaveLength(1);
    expect(
      MasterConfigSchema.parse(parse(await readFile(plan.config_path, "utf8")))
        .schema_version,
    ).toBe("1");
    expect(
      MasterProjectRegistrySchema.parse(
        parse(await readFile(plan.registry_path, "utf8")),
      ).schema_version,
    ).toBe("1");
  });

  it("supports custom roots and rejects conflicting config or symlink escapes", async () => {
    const f = await fixture();
    const home = join(f.root, ".meraki-forge");
    const projects = join(f.root, "custom-projects");
    const vault = join(f.root, "custom-vault");
    const plan = await planMachineInit({
      forgeRoot: f.forge,
      masterHome: home,
      projectsRoot: projects,
      obsidianVault: vault,
    });
    await applyMachineInit(plan);
    await expect(
      planMachineInit({
        forgeRoot: f.forge,
        masterHome: home,
        projectsRoot: join(f.root, "different"),
        obsidianVault: vault,
      }),
    ).rejects.toThrow(/conflict/iu);

    const outside = join(f.root, "outside");
    await mkdir(outside);
    const linked = join(f.root, "linked");
    await symlink(outside, linked);
    await expect(
      planMachineInit({
        forgeRoot: f.forge,
        masterHome: join(linked, "home"),
        projectsRoot: projects,
        obsidianVault: vault,
      }),
    ).rejects.toThrow(/symbolic link/iu);
  });

  it("rejects forged plans and tampered master topology", async () => {
    const f = await fixture();
    const home = join(f.root, ".meraki-forge");
    const plan = await planMachineInit({
      forgeRoot: f.forge,
      masterHome: home,
    });
    const outside = join(f.root, "outside.txt");
    await writeFile(outside, "keep\n");
    await expect(
      applyMachineInit({
        ...plan,
        writes: [
          ...plan.writes,
          { path: outside, source: "overwrite\n", existing: "keep\n" },
        ],
        changes: [...plan.changes, outside],
      }),
    ).rejects.toThrow(/unauthorized write/iu);
    expect(await readFile(outside, "utf8")).toBe("keep\n");
    const configWrite = plan.writes.find(
      ({ path }) => path === plan.config_path,
    )!;
    await expect(
      applyMachineInit({
        ...plan,
        writes: [
          ...plan.writes,
          { ...configWrite, source: "not: the config\n" },
        ],
      }),
    ).rejects.toThrow(/duplicate writes/iu);
    const dashboard = plan.writes.find(({ path }) =>
      path.endsWith("Dashboard.md"),
    )!;
    await expect(
      applyMachineInit({
        ...plan,
        writes: plan.writes.map((write) =>
          write.path === dashboard.path
            ? { ...write, source: "erase human content\n" }
            : write,
        ),
      }),
    ).rejects.toThrow(/managed Markdown/iu);

    await applyMachineInit(plan);
    const source = parse(await readFile(plan.config_path, "utf8")) as Record<
      string,
      unknown
    >;
    source.registry = { path: join(f.root, "other.yml"), schema_version: "1" };
    await writeFile(plan.config_path, JSON.stringify(source));
    await expect(loadMasterConfig(home)).rejects.toThrow(/registry path/iu);
  });

  it("rejects a master home reached through a symlinked ancestor", async () => {
    const f = await fixture();
    const realParent = join(f.root, "real-parent");
    const linkedParent = join(f.root, "linked-parent");
    const realHome = join(realParent, "home");
    await mkdir(realParent);
    await symlink(realParent, linkedParent);
    const plan = await planMachineInit({
      forgeRoot: f.forge,
      masterHome: realHome,
    });
    await applyMachineInit(plan);
    await expect(loadMasterConfig(join(linkedParent, "home"))).rejects.toThrow(
      /symbolic link|identity/iu,
    );
  });

  it("rejects a replaced configured root and recovers one vault from a legacy registry", async () => {
    const f = await fixture();
    const home = join(f.root, ".meraki-forge");
    const plan = await planMachineInit({
      forgeRoot: f.forge,
      masterHome: home,
    });
    await applyMachineInit(plan);
    const moved = `${plan.projects_root}-moved`;
    await rename(plan.projects_root, moved);
    await symlink(moved, plan.projects_root);
    await expect(loadMasterConfig(home)).rejects.toThrow(/symbolic link/iu);

    const legacyRoot = await realpath(
      await mkdtemp(join(tmpdir(), "forge-legacy-registry-")),
    );
    const legacyDocuments = join(legacyRoot, "Documents");
    const legacyForge = join(legacyDocuments, "Meraki Forge");
    const legacyHome = join(legacyRoot, ".meraki-forge");
    const legacyVault = join(legacyDocuments, "Legacy Vault");
    await mkdir(legacyForge, { recursive: true });
    await mkdir(legacyHome);
    await writeFile(
      join(legacyHome, "projects.yml"),
      JSON.stringify({
        schema_version: "1",
        revision: 1,
        updated_at: "2026-08-17T00:00:00.000Z",
        shared_vault_path: null,
        projects: [
          {
            project_id: "legacy",
            display_name: "Legacy",
            repo_path: join(legacyRoot, "repo"),
            forge_config_path: join(legacyRoot, "repo/.forge/config.yml"),
            graphify_path: join(legacyRoot, "repo/graphify-out"),
            obsidian_project_path: join(legacyVault, "Projects/Legacy"),
            stack_summary: "TypeScript",
            registration_status: "INACTIVE",
            aliases: [],
            registered_at: "2026-08-17T00:00:00.000Z",
            updated_at: "2026-08-17T00:00:00.000Z",
            record_version: 1,
          },
        ],
      }),
    );
    const recovered = await planMachineInit({
      forgeRoot: legacyForge,
      masterHome: legacyHome,
      documentsRoot: legacyDocuments,
    });
    expect(recovered.obsidian_vault).toBe(
      join(await realpath(legacyDocuments), "Legacy Vault"),
    );
  });
});
