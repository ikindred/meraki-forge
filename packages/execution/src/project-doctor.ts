import type { OperationalCheck } from "./project-validator.js";

type Probe = () => Promise<boolean>;
export interface DoctorProbes {
  readonly forge: Probe;
  readonly config: Probe;
  readonly git: Probe;
  readonly repository: Probe;
  readonly runtime: Probe;
  readonly rootsWritable: Probe;
  readonly obsidian: Probe;
  readonly ownership: Probe;
  readonly personas: Probe;
  readonly stack: Probe;
  readonly scheduler: Probe;
  readonly playwright: Probe;
  readonly ffmpeg: Probe;
  readonly plaintextSecrets: Probe;
  readonly githubCli?: Probe;
  readonly githubAuth?: Probe;
  readonly schemaVersions?: Probe;
  readonly repositoryRoot?: Probe;
  readonly gitState?: Probe;
  readonly remote?: Probe;
  readonly repositoryIdentity?: Probe;
  readonly attachments?: Probe;
  readonly mcp?: Probe;
}
export interface DoctorInput {
  readonly config: {
    readonly auto_merge: boolean;
    readonly production_deploy: boolean;
    readonly github_enabled: boolean;
    readonly video_required: boolean;
    readonly scheduler_enabled: boolean;
  };
  readonly probes: DoctorProbes;
}
export interface DoctorReport {
  readonly schema_version: "1";
  readonly kind: "FORGE_DOCTOR";
  readonly status: "READY" | "READY_WITH_WARNINGS" | "NOT_READY";
  readonly exit_code: 0 | 1;
  readonly checks: readonly OperationalCheck[];
}

export async function runProjectDoctor(
  input: DoctorInput,
): Promise<DoctorReport> {
  const probe = async (
    id: string,
    fn: Probe,
    severity: "WARNING" | "FAIL",
    failure: string,
  ): Promise<OperationalCheck> => {
    try {
      const passed = await fn();
      return Object.freeze({
        id,
        status: passed ? "PASS" : severity,
        message: passed ? `${id} available` : failure,
      });
    } catch {
      return Object.freeze({ id, status: severity, message: failure });
    }
  };
  const checks: OperationalCheck[] = await Promise.all([
    probe(
      "forge",
      input.probes.forge,
      "FAIL",
      "Forge installation unavailable",
    ),
    probe(
      "config",
      input.probes.config,
      "FAIL",
      "Project configuration invalid",
    ),
    probe(
      "schema-versions",
      input.probes.schemaVersions ?? input.probes.config,
      "FAIL",
      "Schema versions are unsupported",
    ),
    probe("git", input.probes.git, "FAIL", "Git unavailable"),
    probe("repository", input.probes.repository, "FAIL", "Repository invalid"),
    probe(
      "repository-root",
      input.probes.repositoryRoot ?? input.probes.repository,
      "FAIL",
      "Repository root mismatch",
    ),
    probe(
      "git-state",
      input.probes.gitState ?? input.probes.repository,
      "WARNING",
      "Git state is not clean or expected",
    ),
    probe(
      "remote",
      input.probes.remote ?? input.probes.repository,
      input.config.github_enabled ? "FAIL" : "WARNING",
      "Configured remote unavailable",
    ),
    probe(
      "repository-identity",
      input.probes.repositoryIdentity ?? input.probes.repository,
      input.config.github_enabled ? "FAIL" : "WARNING",
      "Repository identity unavailable",
    ),
    probe(
      "runtime",
      input.probes.runtime,
      "FAIL",
      "Runtime requirements unmet",
    ),
    probe(
      "roots-writable",
      input.probes.rootsWritable,
      "FAIL",
      "State or artifact roots are not writable",
    ),
    probe(
      "obsidian",
      input.probes.obsidian,
      "FAIL",
      "Command Center mapping unavailable",
    ),
    probe(
      "attachments",
      input.probes.attachments ?? input.probes.obsidian,
      "FAIL",
      "Attachment roots are invalid",
    ),
    probe(
      "ownership",
      input.probes.ownership,
      "FAIL",
      "Ownership configuration invalid",
    ),
    probe(
      "personas",
      input.probes.personas,
      "FAIL",
      "Persona definitions invalid",
    ),
    probe("stack", input.probes.stack, "FAIL", "Stack profile invalid"),
    probe(
      "scheduler",
      input.probes.scheduler,
      input.config.scheduler_enabled ? "FAIL" : "WARNING",
      "Scheduler contracts unavailable",
    ),
    probe(
      "playwright",
      input.probes.playwright,
      "WARNING",
      "Playwright unavailable",
    ),
    probe(
      "ffmpeg",
      input.probes.ffmpeg,
      "WARNING",
      "ffmpeg unavailable — WebM will be retained",
    ),
    probe(
      "mcp",
      input.probes.mcp ?? (() => Promise.resolve(true)),
      "WARNING",
      "Configured MCP provider unavailable",
    ),
    probe(
      "plaintext-secrets",
      async () => !(await input.probes.plaintextSecrets()),
      "WARNING",
      "Plaintext secret detected",
    ),
  ]);
  if (input.config.github_enabled) {
    checks.push(
      await probe(
        "github-cli",
        input.probes.githubCli ?? (() => Promise.resolve(false)),
        "FAIL",
        "GitHub CLI unavailable",
      ),
    );
    checks.push(
      await probe(
        "github-auth",
        input.probes.githubAuth ?? (() => Promise.resolve(false)),
        "FAIL",
        "GitHub authentication unavailable",
      ),
    );
  }
  checks.push(
    Object.freeze({
      id: "dangerous-settings",
      status:
        !input.config.auto_merge && !input.config.production_deploy
          ? "PASS"
          : "FAIL",
      message:
        !input.config.auto_merge && !input.config.production_deploy
          ? "Safety floors enforced"
          : "Auto-merge or production deployment enabled",
    }),
  );
  const fail = checks.some((item) => item.status === "FAIL");
  const warning = checks.some((item) => item.status === "WARNING");
  return Object.freeze({
    schema_version: "1",
    kind: "FORGE_DOCTOR",
    status: fail ? "NOT_READY" : warning ? "READY_WITH_WARNINGS" : "READY",
    exit_code: fail ? 1 : 0,
    checks: Object.freeze(checks),
  });
}

export async function createSchedulerBootstrap(input: {
  readonly provider: string;
  readonly timezone: string;
  readonly automatic_writer?: () => Promise<{ readonly configured: boolean }>;
}): Promise<{
  readonly status: "CONFIGURED" | "HUMAN_SETUP_REQUIRED" | "FAILED";
  readonly mutated: boolean;
  readonly instructions: string;
}> {
  const instructions = `Configure ${input.provider} in ${input.timezone}: DAILY_PM weekdays 08:00; ENGINEERING_COORDINATOR periodically; END_OF_DAY_REPORT weekdays 19:15. Use repository-managed contracts and stop at PR REVIEW.`;
  if (!input.automatic_writer)
    return Object.freeze({
      status: "HUMAN_SETUP_REQUIRED",
      mutated: false,
      instructions,
    });
  try {
    const result = await input.automatic_writer();
    return Object.freeze({
      status: result.configured ? "CONFIGURED" : "FAILED",
      mutated: result.configured,
      instructions,
    });
  } catch {
    return Object.freeze({ status: "FAILED", mutated: false, instructions });
  }
}
