import { describe, expect, it, vi } from "vitest";
import { execFile as execFileCallback } from "node:child_process";
import { access, mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { stringify } from "yaml";
import {
  createDefaultCliServices,
  runCli,
  type CliServices,
} from "../packages/cli/src/main.js";

const execFile = promisify(execFileCallback);

function harness(overrides: Partial<CliServices> = {}) {
  const out: string[] = [];
  const err: string[] = [];
  const result = {
    status: "READY_WITH_WARNINGS" as const,
    summary: "Forge is ready with warnings",
    checks: [
      { status: "PASS" as const, name: "Git", message: "available" },
      { status: "WARNING" as const, name: "ffmpeg", message: "unavailable" },
    ],
  };
  const services: CliServices = {
    init: vi.fn(() => Promise.resolve({ ...result, status: "READY" as const })),
    bootstrap: vi.fn(() => Promise.resolve(result)),
    doctor: vi.fn(() => Promise.resolve(result)),
    validate: vi.fn(() =>
      Promise.resolve({ ...result, status: "READY" as const }),
    ),
    upgrade: vi.fn(() =>
      Promise.resolve({ ...result, status: "READY" as const }),
    ),
    ...overrides,
  };
  return {
    out,
    err,
    services,
    io: {
      stdout: (text: string) => out.push(text),
      stderr: (text: string) => err.push(text),
      cwd: "/repo",
    },
  };
}

describe("Forge CLI", () => {
  it("has deterministic help and usage errors", async () => {
    const h = harness();
    expect(await runCli(["--help"], h.services, h.io)).toBe(0);
    expect(h.out.join("\n")).toContain("forge bootstrap");
    for (const command of [
      "init",
      "bootstrap",
      "doctor",
      "validate",
      "upgrade",
    ])
      expect(await runCli([command, "--help"], h.services, h.io)).toBe(0);
    expect(await runCli(["unknown"], h.services, h.io)).toBe(2);
    expect(h.err.at(-1)).toContain("Unknown command");
  });

  it("renders human and JSON results with deterministic status exits", async () => {
    const human = harness();
    expect(await runCli(["doctor"], human.services, human.io)).toBe(0);
    expect(human.out.join("\n")).toContain("WARNING  ffmpeg — unavailable");
    const machine = harness();
    expect(
      await runCli(["validate", "--json"], machine.services, machine.io),
    ).toBe(0);
    expect(JSON.parse(machine.out[0]!)).toMatchObject({
      command: "validate",
      status: "READY",
    });
  });

  it("passes safe bootstrap options and rejects unknown or incomplete flags", async () => {
    const h = harness();
    expect(
      await runCli(
        [
          "bootstrap",
          "--dry-run",
          "--non-interactive",
          "--config",
          "setup.yml",
        ],
        h.services,
        h.io,
      ),
    ).toBe(0);
    expect(h.services.bootstrap).toHaveBeenCalledWith({
      cwd: "/repo",
      dryRun: true,
      nonInteractive: true,
      configPath: "setup.yml",
    });
    expect(await runCli(["doctor", "--config"], h.services, h.io)).toBe(2);
    expect(
      await runCli(["doctor", "--evil=$(touch nope)"], h.services, h.io),
    ).toBe(2);
  });

  it("reports service failures without leaking stacks", async () => {
    const h = harness({
      doctor: vi.fn(() => Promise.reject(new Error("configuration invalid"))),
    });
    expect(await runCli(["doctor"], h.services, h.io)).toBe(1);
    expect(h.err).toEqual(["FAIL  doctor — configuration invalid"]);
  });

  it("runs bootstrap dry-run, installation, validate, doctor, and upgrade locally", async () => {
    const root = await mkdtemp(join(tmpdir(), "forge-cli-"));
    const repository = join(root, "repo");
    const vault = join(root, "vault");
    await mkdir(repository);
    await mkdir(vault);
    await execFile("git", ["init", "-b", "main", repository]);
    await writeFile(
      join(repository, "package.json"),
      JSON.stringify({ dependencies: { next: "1" } }),
    );
    const config = join(root, "bootstrap.yml");
    await writeFile(
      config,
      stringify({
        schema_version: "1",
        project: {
          id: "demo",
          name: "Demo",
          repository_path: repository,
          repository_identity: "local/demo",
          default_branch: "main",
          stack_profile: "Next.js",
        },
        obsidian: {
          vault_path: vault,
          command_center_path: "Demo/AI Engineering",
        },
        delivery: {
          remote_push: false,
          create_pr: false,
          auto_merge: false,
          production_deploy: false,
        },
        autonomy: { allowed_risk: "MEDIUM", modes: ["AUTO"] },
        evidence: {
          ui_video_required: false,
          screenshots_required: true,
          responsive_viewports: ["390x844"],
        },
      }),
    );
    const output: string[] = [];
    const io = {
      cwd: repository,
      stdout: (text: string) => output.push(text),
      stderr: (text: string) => output.push(text),
    };
    const services = createDefaultCliServices();

    expect(
      await runCli(
        ["bootstrap", "--config", config, "--dry-run"],
        services,
        io,
      ),
    ).toBe(0);
    await expect(
      access(join(repository, ".forge/config.yml")),
    ).rejects.toThrow();
    expect(await runCli(["bootstrap", "--config", config], services, io)).toBe(
      0,
    );
    expect(await runCli(["validate"], services, io)).toBe(0);
    expect(await runCli(["doctor"], services, io)).toBe(0);
    await writeFile(
      join(repository, ".forge/capabilities.yml"),
      "schema_version: '1'\nproviders:\n  - id: db\n    server: https://user:plainpassword@example.test/mcp\n    environment: development\n    capabilities: [READ]\n    secret:\n      source: environment\n      key: DATABASE_URL\n    persona_grants: []\n",
    );
    output.length = 0;
    expect(await runCli(["doctor"], services, io)).toBe(0);
    expect(output.join("\n")).toContain("Plaintext secret detected");
    expect(output.join("\n")).not.toContain("plainpassword");
    await writeFile(
      join(repository, ".forge/ownership.yml"),
      "schema_version: '1'\ndefault_effect: deny\nrules:\n  - pattern: src/**\n    owner: qa-engineer\n    effect: allow\nambiguities: []\n",
    );
    expect(await runCli(["validate"], services, io)).toBe(1);
    expect(await runCli(["upgrade", "--dry-run"], services, io)).toBe(0);
  });
});
