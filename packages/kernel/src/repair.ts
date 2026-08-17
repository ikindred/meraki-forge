import type { Persona } from "./contracts.js";

export interface RepairFinding {
  readonly id: string;
  readonly expected_owner: Persona;
  readonly summary: string;
  readonly affected_paths: readonly string[];
}
export interface RepairResult {
  readonly attempt: number;
  readonly successful: boolean;
  readonly result: string;
  readonly at: string;
}
export interface RepairState {
  readonly task_id: string;
  readonly attempts: number;
  readonly status: "REPAIRING" | "COMPLETED" | "BLOCKED";
  readonly findings: readonly RepairFinding[];
  readonly owners: readonly Persona[];
  readonly results: readonly RepairResult[];
  readonly remaining_blocker: string | null;
}

export function createRepairState(
  taskId: string,
  findings: readonly RepairFinding[],
): RepairState {
  return Object.freeze({
    task_id: taskId,
    attempts: 0,
    status: findings.length === 0 ? "COMPLETED" : "REPAIRING",
    findings: [...findings],
    owners: [...new Set(findings.map((finding) => finding.expected_owner))],
    results: [],
    remaining_blocker: findings[0]?.id ?? null,
  });
}

export function nextRepairDispatch(state: RepairState) {
  if (state.status !== "REPAIRING" || state.attempts >= 3) return null;
  const finding =
    state.findings.find((item) => item.id === state.remaining_blocker) ??
    state.findings[0];
  if (!finding) return null;
  return Object.freeze({
    persona_id: finding.expected_owner,
    finding_id: finding.id,
    attempt: state.attempts + 1,
    allowed_paths: [...finding.affected_paths],
    recheck_required: true,
  });
}

export function applyRepairResult(
  state: RepairState,
  result: {
    readonly successful: boolean;
    readonly result: string;
    readonly remaining_blocker: string | null;
  },
  at: string,
): RepairState {
  if (state.status !== "REPAIRING") throw new Error("Repair is not active");
  if (state.attempts >= 3) throw new Error("Repair attempt ceiling reached");
  const attempts = state.attempts + 1;
  const status = result.successful
    ? "COMPLETED"
    : attempts >= 3
      ? "BLOCKED"
      : "REPAIRING";
  return Object.freeze({
    ...state,
    attempts,
    status,
    results: [
      ...state.results,
      {
        attempt: attempts,
        successful: result.successful,
        result: result.result,
        at,
      },
    ],
    remaining_blocker: result.successful ? null : result.remaining_blocker,
  });
}
