import { mkdir, mkdtemp, readFile, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  GlobalProjectRegistry,
  RegistryConflictError,
} from "../packages/adapters/src/global-project-registry.js";

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "forge-registry-"));
  const home = join(root, "home");
  const repo = join(root, "repo");
  const vault = join(root, "vault");
  await mkdir(home);
  await mkdir(join(repo, ".forge"), { recursive: true });
  await mkdir(join(repo, "graphify-out"));
  await mkdir(join(vault, "Projects", "Kyra"), { recursive: true });
  await writeFile(join(repo, ".forge", "config.yml"), "schema_version: 1\n");
  return { root, home, repo, vault };
}

describe("global project registry", () => {
  it("registers canonical paths atomically and treats an identical registration as idempotent", async () => {
    const f = await fixture();
    const store = new GlobalProjectRegistry(join(f.home, "projects.yml"));
    const input = registration(f.repo, f.vault);
    const first = await store.register(input);
    const second = await store.register(input);
    expect(first.created).toBe(true);
    expect(second.created).toBe(false);
    expect(second.registry.revision).toBe(1);
    expect(second.project.repo_path).toBe(
      await import("node:fs/promises").then(({ realpath }) => realpath(f.repo)),
    );
    expect(await readFile(join(f.home, "projects.yml"), "utf8")).toContain(
      'schema_version: "1"',
    );
  });

  it("denies duplicate ids, repos, stale CAS revisions, and live locks", async () => {
    const f = await fixture();
    const path = join(f.home, "projects.yml");
    const store = new GlobalProjectRegistry(path);
    await store.register(registration(f.repo, f.vault));
    const repo2 = join(f.root, "repo2");
    await mkdir(join(repo2, ".forge"), { recursive: true });
    await mkdir(join(repo2, "graphify-out"));
    await writeFile(join(repo2, ".forge/config.yml"), "x");
    await expect(
      store.register({ ...registration(repo2, f.vault), project_id: "kyra" }),
    ).rejects.toBeInstanceOf(RegistryConflictError);
    await expect(
      store.register({
        ...registration(f.repo, f.vault),
        project_id: "other",
        display_name: "Other",
      }),
    ).rejects.toBeInstanceOf(RegistryConflictError);
    await expect(
      store.register(
        {
          ...registration(repo2, f.vault),
          project_id: "other",
          display_name: "Other",
        },
        { expectedRevision: 0 },
      ),
    ).rejects.toThrow(/revision/i);
    await writeFile(`${path}.lock`, "live");
    await expect(
      store.register({
        ...registration(repo2, f.vault),
        project_id: "other",
        display_name: "Other",
      }),
    ).rejects.toThrow(/locked/i);
  });

  it("fails closed for missing repos and symlinked registry paths", async () => {
    const f = await fixture();
    await expect(
      new GlobalProjectRegistry(join(f.home, "projects.yml")).register(
        registration(join(f.root, "missing"), f.vault),
      ),
    ).rejects.toThrow(/repository/i);
    const outside = join(f.root, "outside.yml");
    await writeFile(outside, "outside");
    await symlink(outside, join(f.home, "linked.yml"));
    await expect(
      new GlobalProjectRegistry(join(f.home, "linked.yml")).load(),
    ).rejects.toThrow(/symbolic link/i);
  });
});

function registration(repo: string, vault: string) {
  return {
    project_id: "kyra",
    display_name: "Kyra",
    repo_path: repo,
    forge_config_path: join(repo, ".forge/config.yml"),
    graphify_path: join(repo, "graphify-out"),
    obsidian_project_path: join(vault, "Projects/Kyra"),
    stack_summary: "TypeScript",
    aliases: ["kyra-app"],
    registration_status: "ACTIVE" as const,
  };
}
