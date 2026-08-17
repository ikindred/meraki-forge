import { access, readFile } from "node:fs/promises";
import { basename, isAbsolute, relative, resolve } from "node:path";
import { z } from "zod";

const GateStatusSchema = z.enum(["PASS", "FAIL", "NOT_APPLICABLE"]);
const CandidateCommitSchema = z.string().regex(/^[0-9a-f]{40,64}$/i);
const AcceptanceCriterionSchema = z.string().min(1);
const DigestSchema = z.string().regex(/^sha256:[0-9a-f]{64}$/i);
const ViewportSchema = z.object({
  width: z.number().int().positive(),
  height: z.number().int().positive(),
});

const EvidenceBindingSchema = z.object({
  task_id: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]*$/),
  candidate_commit: CandidateCommitSchema,
  acceptance_criteria: z.array(AcceptanceCriterionSchema).min(1),
});

export const ScreenshotEvidenceSchema = EvidenceBindingSchema.extend({
  kind: z.literal("screenshot"),
  path: z.string().regex(/\.png$/i),
  digest: DigestSchema,
  viewport: z.enum(["desktop", "tablet", "mobile"]),
  dimensions: ViewportSchema,
  producing_gate: z.literal("RESPONSIVE"),
});
export type ScreenshotEvidence = z.infer<typeof ScreenshotEvidenceSchema>;

export const VideoEvidenceSchema = EvidenceBindingSchema.extend({
  kind: z.literal("video"),
  path: z.string().regex(/\.(?:webm|mp4)$/i),
  digest: DigestSchema,
  format: z.enum(["webm", "mp4"]),
  conversion_status: z.enum(["NOT_REQUESTED", "CONVERTED", "NATIVE_RETAINED"]),
  limitation: z.string().min(1).optional(),
  producing_gate: z.literal("E2E"),
  duration_ms: z.number().int().positive(),
  timeline: z
    .array(
      z.object({
        acceptance_criterion: AcceptanceCriterionSchema,
        start_ms: z.number().int().nonnegative(),
        end_ms: z.number().int().positive(),
      }),
    )
    .min(1),
}).superRefine((record, context) => {
  for (const segment of record.timeline) {
    if (segment.end_ms <= segment.start_ms) {
      context.addIssue({
        code: "custom",
        path: ["timeline"],
        message: "Video timeline end must be after its start.",
      });
    }
    if (!record.acceptance_criteria.includes(segment.acceptance_criterion)) {
      context.addIssue({
        code: "custom",
        path: ["timeline"],
        message: "Video timeline references an unbound acceptance criterion.",
      });
    }
    if (segment.end_ms > record.duration_ms)
      context.addIssue({
        code: "custom",
        path: ["timeline"],
        message: "Video timeline exceeds the recorded duration.",
      });
  }
});
export type VideoEvidence = z.infer<typeof VideoEvidenceSchema>;

export const ResponsiveValidationRecordSchema = EvidenceBindingSchema.extend({
  gate: z.literal("RESPONSIVE"),
  status: GateStatusSchema,
  reason: z.string().min(1).optional(),
  viewports: z.partialRecord(
    z.enum(["desktop", "tablet", "mobile"]),
    ViewportSchema,
  ),
  screenshots: z.array(ScreenshotEvidenceSchema),
});
export type ResponsiveValidationRecord = z.infer<
  typeof ResponsiveValidationRecordSchema
>;

export const E2EValidationRecordSchema = EvidenceBindingSchema.extend({
  gate: z.literal("E2E"),
  status: GateStatusSchema,
  reason: z.string().min(1).optional(),
  evidence_refs: z.array(z.string().min(1)),
}).superRefine((record, context) => {
  if (record.status === "PASS" && record.evidence_refs.length === 0)
    context.addIssue({
      code: "custom",
      path: ["evidence_refs"],
      message:
        "E2E PASS requires actual report, trace, screenshot, or video evidence.",
    });
});
export type E2EValidationRecord = z.infer<typeof E2EValidationRecordSchema>;

export interface CommandResult {
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
  readonly evidenceRefs?: readonly string[] | undefined;
}

export interface CommandRunner {
  run(
    command: string,
    args: readonly string[],
    cwd: string,
  ): Promise<CommandResult>;
}

export interface EvidenceBinding {
  readonly taskId: string;
  readonly candidateCommit: string;
  readonly acceptanceCriteria: readonly string[];
}

export interface BrowserValidationOptions {
  readonly viewports?: Readonly<
    Record<"desktop" | "tablet" | "mobile", z.infer<typeof ViewportSchema>>
  >;
}

export interface PlaywrightCapability {
  readonly available: boolean;
  readonly source?: "npm-script" | "local-binary";
  readonly command?: string;
  readonly args?: readonly string[];
  readonly reason?: string;
}

export interface FfmpegCapability {
  readonly available: boolean;
  readonly reason?: string;
}

const DEFAULT_VIEWPORTS = Object.freeze({
  desktop: Object.freeze({ width: 1440, height: 900 }),
  tablet: Object.freeze({ width: 768, height: 1024 }),
  mobile: Object.freeze({ width: 375, height: 812 }),
});

const PLAYWRIGHT_CONFIGS = [
  "playwright.config.ts",
  "playwright.config.js",
  "playwright.config.mts",
  "playwright.config.mjs",
  "playwright.config.cts",
  "playwright.config.cjs",
] as const;
const E2E_SCRIPTS = ["test:e2e", "e2e", "playwright"] as const;

export class BrowserValidationAdapter {
  readonly repository: string;
  readonly viewports: Readonly<
    Record<"desktop" | "tablet" | "mobile", z.infer<typeof ViewportSchema>>
  >;

  constructor(
    repository: string,
    private readonly runner: CommandRunner,
    options: BrowserValidationOptions = {},
  ) {
    this.repository = resolve(repository);
    this.viewports = Object.freeze(options.viewports ?? DEFAULT_VIEWPORTS);
  }

  async detectPlaywright(): Promise<PlaywrightCapability> {
    const packageJson = await this.readPackageJson();
    const scripts = isRecord(packageJson.scripts) ? packageJson.scripts : {};
    const script = E2E_SCRIPTS.find(
      (name) =>
        typeof scripts[name] === "string" &&
        scripts[name].includes("playwright"),
    );
    if (script) {
      return Object.freeze({
        available: true,
        source: "npm-script" as const,
        command: "npm",
        args: Object.freeze(["run", script, "--"]),
      });
    }

    const dependencies = {
      ...(isRecord(packageJson.dependencies) ? packageJson.dependencies : {}),
      ...(isRecord(packageJson.devDependencies)
        ? packageJson.devDependencies
        : {}),
    };
    const packageMarker =
      typeof dependencies["@playwright/test"] === "string" ||
      typeof dependencies.playwright === "string";
    const binary = resolve(this.repository, "node_modules/.bin/playwright");
    const [hasConfig, hasBinary] = await Promise.all([
      anyExists(
        PLAYWRIGHT_CONFIGS.map((name) => resolve(this.repository, name)),
      ),
      exists(binary),
    ]);
    if (packageMarker && hasConfig && hasBinary) {
      return Object.freeze({
        available: true,
        source: "local-binary" as const,
        command: binary,
        args: Object.freeze(["test"]),
      });
    }
    return Object.freeze({
      available: false,
      reason:
        "Playwright is not available from an existing repository script, configuration, and local installation.",
    });
  }

  async runE2E(binding: EvidenceBinding): Promise<E2EValidationRecord> {
    const normalized = bindingFields(binding);
    const capability = await this.detectPlaywright();
    if (!capability.available) {
      return Object.freeze(
        E2EValidationRecordSchema.parse({
          gate: "E2E",
          status: "NOT_APPLICABLE",
          ...normalized,
          reason: capability.reason,
          evidence_refs: [],
        }),
      );
    }
    const result = await this.runner.run(
      capability.command!,
      capability.args!,
      this.repository,
    );
    return Object.freeze(
      E2EValidationRecordSchema.parse({
        gate: "E2E",
        status: result.exitCode === 0 ? "PASS" : "FAIL",
        ...normalized,
        evidence_refs: [...(result.evidenceRefs ?? [])],
        ...(result.exitCode === 0
          ? {}
          : {
              reason:
                result.stderr.trim() || `Playwright exited ${result.exitCode}.`,
            }),
      }),
    );
  }

  async detectFfmpeg(): Promise<FfmpegCapability> {
    try {
      const result = await this.runner.run(
        "ffmpeg",
        ["-version"],
        this.repository,
      );
      return result.exitCode === 0
        ? Object.freeze({ available: true })
        : Object.freeze({
            available: false,
            reason: result.stderr.trim() || `ffmpeg exited ${result.exitCode}.`,
          });
    } catch (error) {
      return Object.freeze({
        available: false,
        reason:
          error instanceof Error ? error.message : "ffmpeg is unavailable.",
      });
    }
  }

  screenshotRecord(
    binding: EvidenceBinding,
    input: {
      readonly path: string;
      readonly viewport: "desktop" | "tablet" | "mobile";
      readonly digest: string;
    },
  ): ScreenshotEvidence {
    this.assertEvidencePath(binding.taskId, input.path, "screenshots");
    return Object.freeze(
      ScreenshotEvidenceSchema.parse({
        kind: "screenshot",
        ...bindingFields(binding),
        path: input.path,
        digest: input.digest,
        viewport: input.viewport,
        dimensions: this.viewports[input.viewport],
        producing_gate: "RESPONSIVE",
      }),
    );
  }

  responsiveRecord(
    binding: EvidenceBinding,
    screenshots: readonly ScreenshotEvidence[],
  ): ResponsiveValidationRecord {
    const normalized = bindingFields(binding);
    const matching = screenshots.filter(
      (item) =>
        item.candidate_commit === normalized.candidate_commit &&
        item.task_id === normalized.task_id &&
        sameValues(item.acceptance_criteria, normalized.acceptance_criteria),
    );
    if (matching.length !== screenshots.length)
      throw new Error(
        "Responsive evidence must match the candidate and task binding.",
      );
    const viewports = Object.fromEntries(
      matching.map((item) => [item.viewport, item.dimensions]),
    );
    return Object.freeze(
      ResponsiveValidationRecordSchema.parse({
        gate: "RESPONSIVE",
        status: matching.length > 0 ? "PASS" : "NOT_APPLICABLE",
        ...normalized,
        ...(matching.length > 0
          ? {}
          : { reason: "No responsive screenshots were produced." }),
        viewports,
        screenshots: matching,
      }),
    );
  }

  videoRecord(
    binding: EvidenceBinding,
    ffmpeg: FfmpegCapability,
    input: {
      readonly nativePath: string;
      readonly nativeDigest: string;
      readonly requestedFormat: "webm" | "mp4";
      readonly duration_ms: number;
      readonly convertedPath?: string;
      readonly convertedDigest?: string;
      readonly timeline: readonly {
        readonly acceptance_criterion: string;
        readonly start_ms: number;
        readonly end_ms: number;
      }[];
    },
  ): VideoEvidence {
    const canUseMp4 =
      input.requestedFormat === "mp4" &&
      ffmpeg.available &&
      input.convertedPath !== undefined &&
      input.convertedDigest !== undefined;
    const path = canUseMp4 ? input.convertedPath : input.nativePath;
    this.assertEvidencePath(binding.taskId, path);
    return Object.freeze(
      VideoEvidenceSchema.parse({
        kind: "video",
        ...bindingFields(binding),
        path,
        digest: canUseMp4 ? input.convertedDigest : input.nativeDigest,
        format: canUseMp4 ? "mp4" : "webm",
        conversion_status: canUseMp4
          ? "CONVERTED"
          : input.requestedFormat === "mp4"
            ? "NATIVE_RETAINED"
            : "NOT_REQUESTED",
        ...(!canUseMp4 && input.requestedFormat === "mp4"
          ? {
              limitation: `MP4 was not produced; native video retained because ffmpeg ${ffmpeg.reason ?? "conversion output was unavailable"}.`,
            }
          : {}),
        producing_gate: "E2E",
        duration_ms: input.duration_ms,
        timeline: input.timeline,
      }),
    );
  }

  private async readPackageJson(): Promise<Record<string, unknown>> {
    try {
      const value: unknown = JSON.parse(
        await readFile(resolve(this.repository, "package.json"), "utf8"),
      );
      return isRecord(value) ? value : {};
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return {};
      throw new Error(
        "Unable to inspect package.json for Playwright capability.",
        {
          cause: error,
        },
      );
    }
  }

  private assertEvidencePath(
    taskId: string,
    path: string,
    child?: string,
  ): void {
    if (isAbsolute(path))
      throw new Error("Evidence path must be repository-relative.");
    const root = resolve(
      this.repository,
      ".forge",
      "artifacts",
      taskId,
      child ?? ".",
    );
    const target = resolve(this.repository, path);
    const relation = relative(root, target);
    if (
      relation.startsWith("..") ||
      isAbsolute(relation) ||
      basename(target) === ""
    )
      throw new Error(
        `Evidence path is outside the task evidence namespace: ${path}`,
      );
  }
}

function bindingFields(
  binding: EvidenceBinding,
): z.infer<typeof EvidenceBindingSchema> {
  return EvidenceBindingSchema.parse({
    task_id: binding.taskId,
    candidate_commit: binding.candidateCommit,
    acceptance_criteria: [...binding.acceptanceCriteria],
  });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

async function exists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

async function anyExists(paths: readonly string[]): Promise<boolean> {
  const values = await Promise.all(paths.map(exists));
  return values.some(Boolean);
}

function sameValues(
  left: readonly string[],
  right: readonly string[],
): boolean {
  return (
    left.length === right.length &&
    left.every((value, index) => value === right[index])
  );
}
