import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  BrowserValidationAdapter,
  ResponsiveValidationRecordSchema,
  ScreenshotEvidenceSchema,
  VideoEvidenceSchema,
  type CommandRunner,
} from "../packages/adapters/src/browser-validation.js";

const repositories: string[] = [];

afterEach(async () => {
  await Promise.all(
    repositories.splice(0).map((path) => rm(path, { recursive: true })),
  );
});

async function fixture(files: Record<string, string>): Promise<string> {
  const repository = await mkdtemp(join(tmpdir(), "forge-browser-validation-"));
  repositories.push(repository);
  for (const [path, contents] of Object.entries(files)) {
    const absolute = join(repository, path);
    await mkdir(join(absolute, ".."), { recursive: true });
    await writeFile(absolute, contents, "utf8");
  }
  return repository;
}

function fakeRunner(
  implementation: CommandRunner["run"] = () =>
    Promise.resolve({
      exitCode: 0,
      stdout: "",
      stderr: "",
      evidenceRefs: ["playwright-report/index.html"],
    }),
): CommandRunner & {
  calls: Array<readonly [string, readonly string[], string]>;
} {
  const calls: Array<readonly [string, readonly string[], string]> = [];
  return {
    calls,
    run: async (command, args, cwd) => {
      calls.push([command, args, cwd]);
      return implementation(command, args, cwd);
    },
  };
}

describe("BrowserValidationAdapter", () => {
  it("detects and reuses the repository Playwright npm script", async () => {
    const repository = await fixture({
      "package.json": JSON.stringify({
        scripts: { "test:e2e": "playwright test" },
        devDependencies: { "@playwright/test": "1.55.0" },
      }),
      "playwright.config.ts": "export default {};",
    });
    const runner = fakeRunner();
    const adapter = new BrowserValidationAdapter(repository, runner);

    const capability = await adapter.detectPlaywright();
    const result = await adapter.runE2E({
      taskId: "MF-300",
      candidateCommit: "a".repeat(40),
      acceptanceCriteria: ["AC-001"],
    });

    expect(capability).toMatchObject({ available: true, source: "npm-script" });
    expect(result).toMatchObject({
      status: "PASS",
      candidate_commit: "a".repeat(40),
      acceptance_criteria: ["AC-001"],
      evidence_refs: ["playwright-report/index.html"],
    });
    expect(runner.calls).toEqual([
      ["npm", ["run", "test:e2e", "--"], repository],
    ]);
  });

  it("uses the local Playwright binary without a shell when config exists", async () => {
    const repository = await fixture({
      "package.json": JSON.stringify({
        devDependencies: { playwright: "1.55.0" },
      }),
      "playwright.config.mts": "export default {};",
      "node_modules/.bin/playwright": "fixture",
    });
    const runner = fakeRunner();
    const adapter = new BrowserValidationAdapter(repository, runner);

    await adapter.runE2E({
      taskId: "MF-301",
      candidateCommit: "b".repeat(40),
      acceptanceCriteria: ["AC-002"],
    });

    expect(runner.calls).toEqual([
      [join(repository, "node_modules/.bin/playwright"), ["test"], repository],
    ]);
  });

  it("returns explicit NOT_APPLICABLE when Playwright is absent", async () => {
    const repository = await fixture({ "package.json": "{}" });
    const runner = fakeRunner();
    const adapter = new BrowserValidationAdapter(repository, runner);

    const result = await adapter.runE2E({
      taskId: "MF-302",
      candidateCommit: "c".repeat(40),
      acceptanceCriteria: ["AC-003"],
    });
    expect(result.status).toBe("NOT_APPLICABLE");
    expect(result.reason).toContain("Playwright");
    expect(runner.calls).toHaveLength(0);
  });

  it("reports command failure without inventing evidence", async () => {
    const repository = await fixture({
      "package.json": JSON.stringify({ scripts: { e2e: "playwright test" } }),
      "playwright.config.js": "module.exports = {};",
    });
    const adapter = new BrowserValidationAdapter(
      repository,
      fakeRunner(() =>
        Promise.resolve({
          exitCode: 1,
          stdout: "",
          stderr: "failed",
          evidenceRefs: [],
        }),
      ),
    );

    await expect(
      adapter.runE2E({
        taskId: "MF-303",
        candidateCommit: "d".repeat(40),
        acceptanceCriteria: ["AC-004"],
      }),
    ).resolves.toMatchObject({ status: "FAIL", reason: "failed" });
  });

  it("does not claim E2E PASS when the runner produced no proof artifact", async () => {
    const repository = await fixture({
      "package.json": JSON.stringify({ scripts: { e2e: "playwright test" } }),
      "playwright.config.js": "module.exports = {};",
    });
    const adapter = new BrowserValidationAdapter(
      repository,
      fakeRunner(() =>
        Promise.resolve({ exitCode: 0, stdout: "", stderr: "" }),
      ),
    );
    await expect(
      adapter.runE2E({
        taskId: "MF-NO-PROOF",
        candidateCommit: "9".repeat(40),
        acceptanceCriteria: ["AC-NO-PROOF"],
      }),
    ).rejects.toThrow("E2E PASS requires actual");
  });

  it("creates candidate-bound screenshot and responsive evidence metadata", async () => {
    const repository = await fixture({});
    const adapter = new BrowserValidationAdapter(repository, fakeRunner(), {
      viewports: {
        desktop: { width: 1440, height: 900 },
        tablet: { width: 820, height: 1180 },
        mobile: { width: 375, height: 812 },
      },
    });
    const binding = {
      taskId: "MF-304",
      candidateCommit: "e".repeat(40),
      acceptanceCriteria: ["AC-005"],
    };

    const screenshot = adapter.screenshotRecord(binding, {
      path: ".forge/artifacts/MF-304/screenshots/ac-005-mobile.png",
      viewport: "mobile",
      digest: "sha256:" + "1".repeat(64),
    });
    const responsive = adapter.responsiveRecord(binding, [screenshot]);

    expect(ScreenshotEvidenceSchema.parse(screenshot)).toEqual(screenshot);
    expect(ResponsiveValidationRecordSchema.parse(responsive)).toEqual(
      responsive,
    );
    expect(responsive).toMatchObject({
      status: "PASS",
      candidate_commit: "e".repeat(40),
      acceptance_criteria: ["AC-005"],
      viewports: { mobile: { width: 375, height: 812 } },
    });
  });

  it("rejects screenshot paths outside the task evidence namespace", async () => {
    const adapter = new BrowserValidationAdapter(
      await fixture({}),
      fakeRunner(),
    );
    expect(() =>
      adapter.screenshotRecord(
        {
          taskId: "MF-305",
          candidateCommit: "f".repeat(40),
          acceptanceCriteria: ["AC-006"],
        },
        {
          path: ".forge/artifacts/OTHER/screenshots/fake.png",
          viewport: "desktop",
          digest: "sha256:" + "2".repeat(64),
        },
      ),
    ).toThrow(/evidence namespace/);
  });

  it("probes ffmpeg and truthfully retains native video when unavailable", async () => {
    const repository = await fixture({});
    const runner = fakeRunner((command) =>
      Promise.resolve({
        exitCode: command === "ffmpeg" ? 127 : 0,
        stdout: "",
        stderr: "not found",
      }),
    );
    const adapter = new BrowserValidationAdapter(repository, runner);
    const binding = {
      taskId: "MF-306",
      candidateCommit: "1".repeat(40),
      acceptanceCriteria: ["AC-007"],
    };

    const capability = await adapter.detectFfmpeg();
    const video = adapter.videoRecord(binding, capability, {
      nativePath: ".forge/artifacts/MF-306/ac-007.webm",
      nativeDigest: "sha256:" + "3".repeat(64),
      requestedFormat: "mp4",
      duration_ms: 30_000,
      timeline: [
        { acceptance_criterion: "AC-007", start_ms: 3000, end_ms: 15000 },
      ],
    });

    expect(capability).toEqual({ available: false, reason: "not found" });
    expect(VideoEvidenceSchema.parse(video)).toEqual(video);
    expect(video.format).toBe("webm");
    expect(video.conversion_status).toBe("NATIVE_RETAINED");
    expect(video.limitation).toContain("ffmpeg");
    expect(video.path.endsWith(".mp4")).toBe(false);
  });
});
