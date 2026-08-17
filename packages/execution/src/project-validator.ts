import { isAbsolute, relative, resolve } from "node:path";

export type OperationalCheckStatus = "PASS" | "WARNING" | "FAIL";
export interface OperationalCheck {
  readonly id: string;
  readonly status: OperationalCheckStatus;
  readonly message: string;
}
export interface ValidationReport {
  readonly schema_version: "1";
  readonly kind: "FORGE_VALIDATION";
  readonly status: "PASS" | "FAIL";
  readonly exit_code: 0 | 1;
  readonly checks: readonly OperationalCheck[];
}

export interface ProjectValidationInput {
  readonly schema_versions: Readonly<Record<string, string>>;
  readonly supported_schema_versions: Readonly<Record<string, string>>;
  readonly repository_path: string;
  readonly state_root: string;
  readonly artifact_root: string;
  readonly command_center_path: string;
  readonly other_command_centers: readonly string[];
  readonly ownership: {
    readonly default_deny: boolean;
    readonly ambiguous_paths: readonly string[];
  };
  readonly personas: Readonly<
    Record<
      "qa" | "security" | "accessibility" | "reviewer" | "evidence" | "release",
      readonly string[]
    >
  >;
  readonly delivery: {
    readonly auto_merge: boolean;
    readonly production_deploy: boolean;
  };
  readonly stack_composition_widens_ownership: boolean;
  readonly dependency_handoffs_valid: boolean;
  readonly evidence_policy_valid: boolean;
  readonly provider_config_valid: boolean;
  readonly scheduler_contracts_valid: boolean;
  readonly mcp: {
    readonly enabled: boolean;
    readonly plaintext_secret: boolean;
    readonly production_write: boolean;
    readonly default_read_only: boolean;
  };
}

const productionPattern =
  /^(?:src|app|packages|lib|server|client|database|migrations)(?:\/|\/\*\*)/;
const check = (
  id: string,
  ok: boolean,
  pass: string,
  fail: string,
): OperationalCheck =>
  Object.freeze({
    id,
    status: ok ? "PASS" : "FAIL",
    message: ok ? pass : fail,
  });
const within = (root: string, child: string): boolean => {
  if (!isAbsolute(root) || !isAbsolute(child)) return false;
  const rel = relative(resolve(root), resolve(child));
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
};

export function validateProject(
  input: ProjectValidationInput,
): ValidationReport {
  const schemasMatch =
    Object.entries(input.supported_schema_versions).every(
      ([name, version]) => input.schema_versions[name] === version,
    ) &&
    Object.keys(input.schema_versions).every(
      (name) => name in input.supported_schema_versions,
    );
  const readOnly = [
    "security",
    "accessibility",
    "reviewer",
    "release",
  ] as const;
  const personaFloors =
    readOnly.every((persona) => input.personas[persona].length === 0) &&
    !input.personas.qa.some((path) => productionPattern.test(path)) &&
    input.personas.evidence.every((path) =>
      path.startsWith(".forge/artifacts/"),
    );
  const checks = [
    check(
      "schemas",
      schemasMatch,
      "All schema versions are supported",
      "Unknown, missing, or stale schema version",
    ),
    check(
      "repo-containment",
      within(input.repository_path, input.state_root) &&
        within(input.repository_path, input.artifact_root),
      "State and artifacts are repository-contained",
      "State or artifact root escapes the repository",
    ),
    check(
      "command-center-isolation",
      !input.other_command_centers.some(
        (path) => resolve(path) === resolve(input.command_center_path),
      ),
      "Command Center mapping is isolated",
      "Command Center collides with another project",
    ),
    check(
      "default-deny",
      input.ownership.default_deny,
      "Ownership is default deny",
      "Ownership must be default deny",
    ),
    check(
      "ownership-ambiguity",
      input.ownership.ambiguous_paths.length === 0,
      "Ownership is unambiguous",
      "Ambiguous paths remain default-denied",
    ),
    check(
      "persona-floors",
      personaFloors,
      "Persona write floors are enforced",
      "A read-only persona or QA/evidence owns production source",
    ),
    check(
      "delivery-safety",
      !input.delivery.auto_merge && !input.delivery.production_deploy,
      "Delivery stops at human review",
      "Auto-merge and production deployment must remain false",
    ),
    check(
      "stack-authority",
      !input.stack_composition_widens_ownership,
      "Stack composition does not grant authority",
      "Stack composition widens ownership",
    ),
    check(
      "dependency-handoffs",
      input.dependency_handoffs_valid,
      "Dependency handoffs are valid",
      "Dependency handoff contracts are invalid",
    ),
    check(
      "evidence-policy",
      input.evidence_policy_valid,
      "Evidence policy is valid",
      "Evidence policy is invalid",
    ),
    check(
      "provider-config",
      input.provider_config_valid,
      "Provider configuration is valid",
      "Provider configuration is invalid",
    ),
    check(
      "scheduler-contracts",
      input.scheduler_contracts_valid,
      "Scheduler contracts are valid",
      "Scheduler contracts are missing or unsafe",
    ),
    check(
      "mcp-safety",
      !input.mcp.plaintext_secret &&
        !input.mcp.production_write &&
        (!input.mcp.enabled || input.mcp.default_read_only),
      "MCP is governed and secret-free",
      "MCP permits production writes, plaintext secrets, or permissive defaults",
    ),
  ] as const;
  const failed = checks.some((item) => item.status === "FAIL");
  return Object.freeze({
    schema_version: "1",
    kind: "FORGE_VALIDATION",
    status: failed ? "FAIL" : "PASS",
    exit_code: failed ? 1 : 0,
    checks: Object.freeze([...checks]),
  });
}
