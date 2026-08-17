import type { TaskContract } from "./contracts.js";
export type RiskLevel = "LOW" | "MEDIUM" | "HIGH" | "CRITICAL";
export interface RiskAssessment {
  readonly level: RiskLevel;
  readonly reason_codes: readonly string[];
  readonly prohibited_actions: readonly string[];
  readonly required_gates: readonly string[];
}
const rank: Record<RiskLevel, number> = {
  LOW: 0,
  MEDIUM: 1,
  HIGH: 2,
  CRITICAL: 3,
};
const rules: readonly [RegExp, RiskLevel, string][] = [
  [/copy|typo|small ui|minor isolated/i, "LOW", "ISOLATED_PRESENTATION"],
  [
    /api|business logic|feature|non-destructive migration/i,
    "MEDIUM",
    "APPLICATION_CHANGE",
  ],
  [
    /auth(?:entication|orization)?|sensitive data|infrastructure|substantial schema|tenant isolation/i,
    "HIGH",
    "SENSITIVE_OR_HIGH_BLAST_RADIUS",
  ],
  [
    /destructive production|(?:delete|remove|erase|truncate|drop|destroy).{0,40}production|production.{0,40}(?:delete|remove|erase|truncate|drop|destroy)|(?:mutate|rotate|replace|expose).{0,30}(?:production )?(?:secret|credential)|production secret|destroy infrastructure|bypass security|destructive billing|destructive payment/i,
    "CRITICAL",
    "PROHIBITED_CRITICAL_ACTION",
  ],
];
export function classifyRisk(task: TaskContract): RiskAssessment {
  const text = [
    task.title,
    task.outcome,
    task.notes,
    ...task.constraints,
    ...task.acceptance_criteria.map((item) => item.text),
  ].join(" ");
  const matched = rules.filter(([pattern]) => pattern.test(text));
  const level = matched.reduce<RiskLevel>(
    (current, [, candidate]) =>
      rank[candidate] > rank[current] ? candidate : current,
    "MEDIUM",
  );
  const reasonCodes = [...new Set(matched.map(([, , code]) => code))];
  const gates = ["ownership", "build", "tests", "qa", "review"];
  if (level === "HIGH" || level === "CRITICAL") gates.push("security");
  return Object.freeze({
    level,
    reason_codes: reasonCodes.length
      ? reasonCodes
      : ["UNCLASSIFIED_IMPACT_CONSERVATIVE_MEDIUM"],
    prohibited_actions:
      level === "CRITICAL"
        ? ["IMPLEMENT", "EXTERNAL_MUTATION", "CREATE_PR"]
        : [],
    required_gates: gates,
  });
}
