import {
  access,
  mkdir,
  mkdtemp,
  realpath,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { stringify } from "yaml";
import { GlobalProjectRegistry } from "../packages/adapters/src/global-project-registry.js";
import { runMasterCommand } from "../packages/cli/src/master-commands.js";

describe("master project CLI", () => {
  it("provides nested project and ownership help", async () => {
    const output: string[] = [];
    const io = {
      cwd: "/tmp",
      stdout: (text: string) => output.push(text),
      stderr: (text: string) => output.push(text),
    };
    expect(await runMasterCommand(["project", "create", "--help"], io)).toBe(0);
    expect(await runMasterCommand(["ownership", "review", "--help"], io)).toBe(
      0,
    );
  });

  it("requires a separately reviewed proposal digest for ownership approval", async () => {
    const root = await realpath(
      await mkdtemp(join(tmpdir(), "forge-owner-cli-")),
    );
    const home = join(root, "home");
    const repo = join(root, "repo");
    const workspace = join(root, "vault/Projects/Owner");
    await mkdir(join(repo, ".forge"), { recursive: true });
    await mkdir(join(repo, "graphify-out"));
    await mkdir(workspace, { recursive: true });
    await mkdir(home);
    await writeFile(join(repo, "package.json"), "{}\n");
    await writeFile(join(repo, ".forge/config.yml"), "schema_version: '1'\n");
    const { execFile } = await import("node:child_process");
    const { promisify } = await import("node:util");
    const exec = promisify(execFile);
    await exec("git", ["init"], { cwd: repo });
    await exec("git", ["config", "user.email", "test@example.com"], {
      cwd: repo,
    });
    await exec("git", ["config", "user.name", "Test"], { cwd: repo });
    await exec("git", ["add", "."], { cwd: repo });
    await exec("git", ["commit", "-m", "fixture"], { cwd: repo });
    const previous = process.env.MERAKI_FORGE_HOME;
    process.env.MERAKI_FORGE_HOME = home;
    try {
      await writeFile(
        join(home, "projects.yml"),
        stringify({
          schema_version: "1",
          revision: 1,
          updated_at: "2026-08-17T00:00:00.000Z",
          shared_vault_path: join(root, "vault"),
          projects: [
            {
              project_id: "owner",
              display_name: "Owner",
              repo_path: repo,
              forge_config_path: join(repo, ".forge/config.yml"),
              graphify_path: join(repo, "graphify-out"),
              obsidian_project_path: workspace,
              stack_summary: "Node.js",
              registration_status: "ACTIVE",
              aliases: [],
              registered_at: "2026-08-17T00:00:00.000Z",
              updated_at: "2026-08-17T00:00:00.000Z",
              record_version: 1,
            },
          ],
        }),
      );
      const output: string[] = [];
      const io = {
        cwd: root,
        stdout: (text: string) => output.push(text),
        stderr: (text: string) => output.push(text),
      };
      expect(
        await runMasterCommand(
          [
            "ownership",
            "review",
            "owner",
            "--approve",
            "--approved-by",
            "Operator",
            "--json",
          ],
          io,
        ),
      ).toBe(1);
      const result = z
        .object({ summary: z.string() })
        .parse(JSON.parse(output.at(-1)!));
      expect(result.summary).toMatch(/proposal-digest/u);

      expect(
        await runMasterCommand(["ownership", "review", "owner", "--json"], io),
      ).toBe(0);
      const proposal = z
        .object({ data: z.object({ proposal_digest: z.string() }) })
        .parse(JSON.parse(output.at(-1)!));
      await writeFile(join(repo, "package.json"), '{"dirty":true}\n');
      expect(
        await runMasterCommand(
          [
            "ownership",
            "review",
            "owner",
            "--approve",
            "--approved-by",
            "Operator",
            "--proposal-digest",
            proposal.data.proposal_digest,
            "--json",
          ],
          io,
        ),
      ).toBe(1);
      expect(
        z.object({ summary: z.string() }).parse(JSON.parse(output.at(-1)!))
          .summary,
      ).toMatch(/clean/u);

      await writeFile(join(repo, "package.json"), "{}\n");
      expect(
        await runMasterCommand(
          [
            "ownership",
            "review",
            "owner",
            "--approve",
            "--approved-by",
            "Operator",
            "--proposal-digest",
            proposal.data.proposal_digest,
            "--json",
          ],
          io,
        ),
      ).toBe(0);
      expect(await realpath(join(repo, ".forge/ownership.yml"))).toBe(
        join(repo, ".forge/ownership.yml"),
      );
    } finally {
      if (previous === undefined) delete process.env.MERAKI_FORGE_HOME;
      else process.env.MERAKI_FORGE_HOME = previous;
    }
  });
  it("lists, resolves, reports graph status, and non-destructively unregisters", async () => {
    const root = await mkdtemp(join(tmpdir(), "forge-master-cli-"));
    const home = join(root, "home");
    const repo = join(root, "repo");
    const workspace = join(root, "vault/Projects/Kyra");
    await mkdir(join(repo, ".forge"), { recursive: true });
    await mkdir(join(repo, "graphify-out"));
    await mkdir(workspace, { recursive: true });
    await mkdir(home);
    await writeFile(join(repo, ".forge/config.yml"), "schema_version: '1'\n");
    const previous = process.env.MERAKI_FORGE_HOME;
    process.env.MERAKI_FORGE_HOME = home;
    try {
      await new GlobalProjectRegistry(join(home, "projects.yml")).register({
        project_id: "kyra",
        display_name: "Kyra",
        repo_path: repo,
        forge_config_path: join(repo, ".forge/config.yml"),
        graphify_path: join(repo, "graphify-out"),
        obsidian_project_path: workspace,
        stack_summary: "Next.js",
        registration_status: "ACTIVE",
        aliases: ["kyra"],
      });
      const output: string[] = [];
      const io = {
        cwd: root,
        stdout: (text: string) => output.push(text),
        stderr: (text: string) => output.push(text),
      };
      expect(await runMasterCommand(["project", "list", "--json"], io)).toBe(0);
      expect(
        z
          .object({ data: z.array(z.object({ project_id: z.string() })) })
          .parse(JSON.parse(output.pop()!)).data[0]?.project_id,
      ).toBe("kyra");
      expect(
        await runMasterCommand(["project", "inspect", "Kyra", "--json"], io),
      ).toBe(0);
      expect(
        await runMasterCommand(
          ["project", "remove", "Kyra", "--confirm", "--json"],
          io,
        ),
      ).toBe(0);
      expect(await runMasterCommand(["project", "list", "--json"], io)).toBe(0);
      expect(
        z
          .object({ data: z.array(z.unknown()) })
          .parse(JSON.parse(output.pop()!)).data,
      ).toEqual([]);
    } finally {
      if (previous === undefined) delete process.env.MERAKI_FORGE_HOME;
      else process.env.MERAKI_FORGE_HOME = previous;
    }
  });

  it("plans project creation without effects", async () => {
    const output: string[] = [];
    const io = {
      cwd: "/tmp",
      stdout: (text: string) => output.push(text),
      stderr: (text: string) => output.push(text),
    };
    expect(
      await runMasterCommand(
        [
          "project",
          "create",
          "--name",
          "Inventory",
          "--type",
          "full-stack",
          "--repo",
          "/tmp/inventory",
          "--vault",
          "/tmp/forge-vault",
          "--dry-run",
          "--json",
        ],
        io,
      ),
    ).toBe(0);
    expect(
      z.object({ data: z.unknown() }).parse(JSON.parse(output[0]!)).data,
    ).toMatchObject({
      project_id: "inventory",
    });
  });

  it("rejects missing option values and unknown graph operations", async () => {
    const output: string[] = [];
    const io = {
      cwd: "/tmp",
      stdout: (text: string) => output.push(text),
      stderr: (text: string) => output.push(text),
    };
    expect(
      await runMasterCommand(
        ["project", "create", "--name", "--dry-run", "--json"],
        io,
      ),
    ).toBe(1);
    expect(output.at(-1)).toMatch(/--name requires a value/u);
  });

  it("rejects a symlinked project parent before creating files", async () => {
    const root = await mkdtemp(join(tmpdir(), "forge-create-link-"));
    const realParent = join(root, "real");
    const linkedParent = join(root, "linked");
    const vault = join(root, "vault");
    await mkdir(realParent);
    await mkdir(join(realParent, "nested"));
    await mkdir(vault);
    await symlink(realParent, linkedParent);
    const output: string[] = [];
    const io = {
      cwd: root,
      stdout: (text: string) => output.push(text),
      stderr: (text: string) => output.push(text),
    };
    expect(
      await runMasterCommand(
        [
          "project",
          "create",
          "--name",
          "Escaped",
          "--repo",
          join(linkedParent, "nested", "escaped"),
          "--vault",
          vault,
        ],
        io,
      ),
    ).toBe(1);
    await expect(
      access(join(realParent, "nested", "escaped")),
    ).rejects.toThrow();
  });
});
