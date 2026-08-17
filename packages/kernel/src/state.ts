import {
  GateResultSchema,
  PhaseSchema,
  RiskLevelSchema,
  TaskModeSchema,
  TaskStatusSchema,
} from "./contracts.js";
import { z } from "zod";
export const TransitionEventSchema = z
  .object({
    from: TaskStatusSchema,
    to: TaskStatusSchema,
    at: z.string().datetime(),
    actor: z.string(),
    reason: z.string(),
  })
  .readonly();
export const TaskStateSchema = z
  .object({
    schema_version: z.literal("1"),
    revision: z.number().int().nonnegative(),
    task_id: z.string(),
    mode: TaskModeSchema,
    status: TaskStatusSchema,
    phase: PhaseSchema,
    repair_attempt: z.number().int().min(0).max(3),
    manifest_revision: z.number().int().nonnegative().default(0),
    branch: z.string().nullable().default(null),
    worktree: z.string().nullable().default(null),
    base_sha: z.string().nullable().default(null),
    candidate_sha: z.string().nullable().default(null),
    risk: RiskLevelSchema.nullable().default(null),
    agents: z.array(z.string()).default([]),
    dependencies: z.array(z.string()).default([]),
    gates: z.array(GateResultSchema).default([]),
    evidence_ids: z.array(z.string()).default([]),
    pr: z
      .object({ number: z.number().int().positive(), url: z.string().url() })
      .nullable()
      .default(null),
    blocker_reason: z.string().nullable().default(null),
    updated_at: z.string().datetime(),
    transitions: z.array(TransitionEventSchema),
    claim: z
      .object({
        run_id: z.string(),
        owner: z.string(),
        lease_until: z.string().datetime(),
      })
      .optional(),
  })
  .readonly();
export type TaskState = z.infer<typeof TaskStateSchema>;
const transitions: Record<TaskState["status"], readonly TaskState["status"][]> =
  {
    READY: ["IN_PROGRESS", "DISCUSS", "BLOCKED"],
    IN_PROGRESS: ["BLOCKED", "DISCUSS", "REVIEW"],
    BLOCKED: ["READY", "IN_PROGRESS"],
    DISCUSS: ["READY", "IN_PROGRESS"],
    REVIEW: ["DONE", "READY"],
    DONE: [],
  };
export function transitionState(
  state: TaskState,
  to: TaskState["status"],
  actor: string,
  reason: string,
  at: string,
  human = false,
): TaskState {
  if (!transitions[state.status].includes(to))
    throw new Error(`Illegal transition ${state.status} -> ${to}`);
  if (state.status === "REVIEW" && to === "DONE" && !human)
    throw new Error("Only a human may accept REVIEW");
  return TaskStateSchema.parse({
    ...state,
    revision: state.revision + 1,
    status: to,
    phase: to === "BLOCKED" ? "BLOCKED" : state.phase,
    updated_at: at,
    transitions: [
      ...state.transitions,
      { from: state.status, to, at, actor, reason },
    ],
  });
}
export function startRepair(state: TaskState, at: string): TaskState {
  if (state.repair_attempt >= 3)
    return TaskStateSchema.parse({
      ...state,
      revision: state.revision + 1,
      status: "BLOCKED",
      phase: "BLOCKED",
      updated_at: at,
    });
  return TaskStateSchema.parse({
    ...state,
    revision: state.revision + 1,
    phase: "REPAIRING",
    repair_attempt: state.repair_attempt + 1,
    updated_at: at,
  });
}
