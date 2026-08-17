import type { Persona, TaskContract } from "./contracts.js";
import type { RiskAssessment } from "./risk.js";
import type { z } from "zod";
import type { ProjectPolicySchema } from "./policy.js";
export type Disposition =
  "IMPLEMENT" | "PLAN_ONLY" | "READ_ONLY_REVIEW" | "DISCUSS" | "BLOCKED";
export interface RoutingDecision {
  readonly disposition: Disposition;
  readonly owners: readonly Persona[];
  readonly required_gates: readonly string[];
  readonly reasons: readonly string[];
}
const domainOwners: readonly [RegExp, Persona][] = [
  [/frontend|react|next\.js|web ui/i, "frontend-engineer"],
  [/backend|api|server/i, "backend-engineer"],
  [/mobile|flutter|android|ios/i, "mobile-engineer"],
  [/database|schema|migration|rls|postgres/i, "database-architect"],
  [/design|user journey|interaction/i, "uiux-designer"],
];
const planOwners: readonly Persona[] = ["architect"];
const reviewOwners: readonly Persona[] = ["code-reviewer"];
export function routeTask(
  task: TaskContract,
  risk: RiskAssessment,
  configuredOwners: readonly Persona[],
  policy: z.infer<typeof ProjectPolicySchema>,
): RoutingDecision {
  if (risk.level === "CRITICAL")
    return Object.freeze({
      disposition: "DISCUSS",
      owners: [],
      required_gates: risk.required_gates,
      reasons: ["CRITICAL_REQUIRES_HUMAN"],
    });
  if (task.mode === "DISCUSS")
    return Object.freeze({
      disposition: "DISCUSS",
      owners: [],
      required_gates: [],
      reasons: ["TASK_MODE_DISCUSS"],
    });
  if (task.mode === "HOLD")
    return Object.freeze({
      disposition: "BLOCKED",
      owners: [],
      required_gates: [],
      reasons: ["TASK_MODE_HOLD"],
    });
  if (task.mode === "PLAN")
    return Object.freeze({
      disposition: "PLAN_ONLY",
      owners: planOwners,
      required_gates: [],
      reasons: ["TASK_MODE_PLAN"],
    });
  if (task.mode === "REVIEW")
    return Object.freeze({
      disposition: "READ_ONLY_REVIEW",
      owners: reviewOwners,
      required_gates: ["review"],
      reasons: ["TASK_MODE_REVIEW"],
    });
  if (risk.level === "HIGH" && policy.autonomy_ceiling !== "HIGH")
    return Object.freeze({
      disposition: "DISCUSS",
      owners: [],
      required_gates: risk.required_gates,
      reasons: ["HIGH_EXCEEDS_AUTONOMY_CEILING"],
    });
  const text = [
    task.title,
    task.outcome,
    task.notes,
    ...task.constraints,
    ...task.known_dependencies,
    ...task.acceptance_criteria.map((criterion) => criterion.text),
  ].join(" ");
  const needed = [
    ...new Set(
      domainOwners
        .filter(([pattern]) => pattern.test(text))
        .map(([, owner]) => owner),
    ),
  ];
  const missing = needed.filter((owner) => !configuredOwners.includes(owner));
  if (!needed.length || missing.length)
    return Object.freeze({
      disposition: "BLOCKED",
      owners: [],
      required_gates: risk.required_gates,
      reasons: [
        needed.length ? "OWNER_NOT_CONFIGURED" : "DOMAIN_OWNER_UNRESOLVED",
      ],
    });
  return Object.freeze({
    disposition: "IMPLEMENT",
    owners: needed,
    required_gates: risk.required_gates,
    reasons: [
      task.mode === "HOTFIX" ? "EXPEDITED_WITH_FULL_GATES" : "AUTHORIZED_AUTO",
    ],
  });
}
