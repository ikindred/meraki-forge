import { access, mkdir, mkdtemp, realpath } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { createDefaultCliServices, runCli } from "../packages/cli/src/main.js";
import { runMasterCommand } from "../packages/cli/src/master-commands.js";

describe("forge init CLI", () => {
  it("dry-runs without mutation, initializes idempotently, and enables machine doctor", async () => {
    const root = await realpath(
      await mkdtemp(join(tmpdir(), "forge-init-cli-")),
    );
    const forge = join(root, "Documents/Meraki Forge");
    const home = join(root, "home");
    await mkdir(forge, { recursive: true });
    const previous = process.env.MERAKI_FORGE_HOME;
    const previousDocuments = process.env.MERAKI_FORGE_DOCUMENTS_ROOT;
    process.env.MERAKI_FORGE_HOME = home;
    process.env.MERAKI_FORGE_DOCUMENTS_ROOT = join(root, "Documents");
    const output: string[] = [];
    const io = {
      cwd: forge,
      stdout: (text: string) => output.push(text),
      stderr: (text: string) => output.push(text),
    };
    const services = createDefaultCliServices();
    try {
      expect(await runCli(["init", "--dry-run", "--json"], services, io)).toBe(
        0,
      );
      await expect(access(home)).rejects.toThrow();
      expect(await runCli(["doctor", "--json"], services, io)).toBe(1);
      expect(output.at(-1)).toMatch(/run forge init/u);

      expect(await runCli(["init", "--json"], services, io)).toBe(0);
      expect(await runCli(["init", "--json"], services, io)).toBe(0);
      expect(await runCli(["doctor", "--json"], services, io)).toBe(0);
      expect(output.at(-1)).toMatch(/MACHINE READY/u);
    } finally {
      if (previous === undefined) delete process.env.MERAKI_FORGE_HOME;
      else process.env.MERAKI_FORGE_HOME = previous;
      if (previousDocuments === undefined)
        delete process.env.MERAKI_FORGE_DOCUMENTS_ROOT;
      else process.env.MERAKI_FORGE_DOCUMENTS_ROOT = previousDocuments;
    }
  });

  it("uses initialized projects and vault roots for project creation by default", async () => {
    const root = await realpath(
      await mkdtemp(join(tmpdir(), "forge-init-defaults-")),
    );
    const forge = join(root, "Documents/Meraki Forge");
    const home = join(root, "home");
    const projects = join(root, "Projects");
    const vault = join(root, "Vault");
    await mkdir(forge, { recursive: true });
    const previous = process.env.MERAKI_FORGE_HOME;
    const previousDocuments = process.env.MERAKI_FORGE_DOCUMENTS_ROOT;
    process.env.MERAKI_FORGE_HOME = home;
    process.env.MERAKI_FORGE_DOCUMENTS_ROOT = join(root, "Documents");
    const output: string[] = [];
    const io = {
      cwd: forge,
      stdout: (text: string) => output.push(text),
      stderr: (text: string) => output.push(text),
    };
    try {
      expect(
        await runCli(
          ["init", "--projects-root", projects, "--vault", vault, "--json"],
          createDefaultCliServices(),
          io,
        ),
      ).toBe(0);
      expect(
        await runMasterCommand(
          [
            "project",
            "create",
            "--name",
            "Forge Calculator",
            "--dry-run",
            "--json",
          ],
          io,
        ),
      ).toBe(0);
      expect(JSON.parse(output.at(-1)!)).toMatchObject({
        data: {
          repository: join(
            await import("node:fs/promises").then(({ realpath }) =>
              realpath(projects),
            ),
            "forge-calculator",
          ),
        },
      });
    } finally {
      if (previous === undefined) delete process.env.MERAKI_FORGE_HOME;
      else process.env.MERAKI_FORGE_HOME = previous;
      if (previousDocuments === undefined)
        delete process.env.MERAKI_FORGE_DOCUMENTS_ROOT;
      else process.env.MERAKI_FORGE_DOCUMENTS_ROOT = previousDocuments;
    }
  });

  it("requires machine initialization before a default project dry-run", async () => {
    const root = await realpath(
      await mkdtemp(join(tmpdir(), "forge-create-before-init-")),
    );
    const home = join(root, "home");
    const previous = process.env.MERAKI_FORGE_HOME;
    process.env.MERAKI_FORGE_HOME = home;
    const output: string[] = [];
    try {
      expect(
        await runMasterCommand(
          [
            "project",
            "create",
            "--name",
            "Uninitialized",
            "--dry-run",
            "--json",
          ],
          {
            cwd: root,
            stdout: (text) => output.push(text),
            stderr: (text) => output.push(text),
          },
        ),
      ).toBe(1);
      expect(output.at(-1)).toMatch(/run forge init/u);
    } finally {
      if (previous === undefined) delete process.env.MERAKI_FORGE_HOME;
      else process.env.MERAKI_FORGE_HOME = previous;
    }
  });
});
