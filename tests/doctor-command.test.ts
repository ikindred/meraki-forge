import { describe, expect, it } from "vitest";
import { runProjectDoctor } from "../packages/execution/src/project-doctor.js";

describe("forge doctor", () => {
  it("uses injected probes and reports ready with warnings deterministically", async () => {
    const report = await runProjectDoctor({
      config: {
        auto_merge: false,
        production_deploy: false,
        github_enabled: false,
        video_required: true,
        scheduler_enabled: true,
      },
      probes: {
        forge: () => Promise.resolve(true),
        config: () => Promise.resolve(true),
        git: () => Promise.resolve(true),
        repository: () => Promise.resolve(true),
        runtime: () => Promise.resolve(true),
        rootsWritable: () => Promise.resolve(true),
        obsidian: () => Promise.resolve(true),
        ownership: () => Promise.resolve(true),
        personas: () => Promise.resolve(true),
        stack: () => Promise.resolve(true),
        scheduler: () => Promise.resolve(true),
        playwright: () => Promise.resolve(true),
        ffmpeg: () => Promise.resolve(false),
        plaintextSecrets: () => Promise.resolve(false),
      },
    });
    expect(report.status).toBe("READY_WITH_WARNINGS");
    expect(report.exit_code).toBe(0);
    expect(report.checks.find((check) => check.id === "ffmpeg")?.status).toBe(
      "WARNING",
    );
    expect(report.checks.map((check) => check.id)).toEqual(
      expect.arrayContaining([
        "schema-versions",
        "repository-root",
        "git-state",
        "remote",
        "repository-identity",
        "attachments",
        "mcp",
      ]),
    );
  });

  it("fails for unsafe settings and required environment failures", async () => {
    const yes = () => Promise.resolve(true);
    const report = await runProjectDoctor({
      config: {
        auto_merge: true,
        production_deploy: false,
        github_enabled: true,
        video_required: false,
        scheduler_enabled: false,
      },
      probes: {
        forge: yes,
        config: yes,
        git: yes,
        repository: () => Promise.resolve(false),
        runtime: yes,
        rootsWritable: yes,
        obsidian: yes,
        ownership: yes,
        personas: yes,
        stack: yes,
        scheduler: yes,
        playwright: yes,
        ffmpeg: yes,
        githubCli: yes,
        githubAuth: () => Promise.resolve(false),
        plaintextSecrets: () => Promise.resolve(true),
      },
    });
    expect(report.status).toBe("NOT_READY");
    expect(report.exit_code).toBe(1);
    expect(
      report.checks
        .filter((check) => check.status === "FAIL")
        .map((check) => check.id),
    ).toEqual(
      expect.arrayContaining([
        "repository",
        "github-auth",
        "dangerous-settings",
      ]),
    );
    expect(
      report.checks.find((check) => check.id === "plaintext-secrets")?.status,
    ).toBe("WARNING");
  });
});
