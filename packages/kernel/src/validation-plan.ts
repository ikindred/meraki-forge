import type { RiskLevel } from "./risk.js";
import type { ValidationGate } from "./validation-contracts.js";

const GATE_ORDER: readonly ValidationGate[] = [
  "QA",
  "SECURITY",
  "ACCESSIBILITY",
  "CODE_REVIEW",
  "E2E",
  "RESPONSIVE",
  "EVIDENCE",
];
type ValidationDomain =
  "ui" | "backend" | "database" | "auth" | "mobile" | "documentation";

export interface ValidationPlanInput {
  readonly task_type: "FEATURE" | "BUGFIX" | "DOCUMENTATION" | "REFACTOR";
  readonly risk: RiskLevel;
  readonly changed_domains: readonly ValidationDomain[];
  readonly e2e_supported: boolean;
  readonly responsive_viewports: readonly ("desktop" | "tablet" | "mobile")[];
  readonly security_relevant: boolean;
}
export interface GateApplicability {
  readonly gate: ValidationGate;
  readonly applicable: boolean;
  readonly reason: string;
}

export function planValidationGates(input: ValidationPlanInput): {
  readonly required: readonly ValidationGate[];
  readonly applicability: readonly GateApplicability[];
} {
  const domains = new Set(input.changed_domains);
  const executable = [...domains].some((domain) => domain !== "documentation");
  const ui = domains.has("ui") || domains.has("mobile");
  const security =
    input.security_relevant ||
    domains.has("auth") ||
    input.risk === "HIGH" ||
    input.risk === "CRITICAL";
  const applicable = new Set<ValidationGate>(["CODE_REVIEW", "EVIDENCE"]);
  if (executable) applicable.add("QA");
  if (security) applicable.add("SECURITY");
  if (ui) applicable.add("ACCESSIBILITY");
  if (ui && input.e2e_supported) applicable.add("E2E");
  if (ui && input.responsive_viewports.length > 0) applicable.add("RESPONSIVE");

  const reason = (gate: ValidationGate): string => {
    if (applicable.has(gate)) return "Required by task impact and policy";
    if (gate === "E2E") return "E2E tooling is unavailable or inappropriate";
    if (gate === "RESPONSIVE")
      return "No responsive UI surface or configured viewports";
    if (gate === "ACCESSIBILITY") return "No user-interface surface changed";
    if (gate === "SECURITY") return "No security-sensitive impact identified";
    if (gate === "QA") return "No executable behavior changed";
    return "Not required";
  };
  return Object.freeze({
    required: GATE_ORDER.filter((gate) => applicable.has(gate)),
    applicability: GATE_ORDER.map((gate) =>
      Object.freeze({
        gate,
        applicable: applicable.has(gate),
        reason: reason(gate),
      }),
    ),
  });
}
