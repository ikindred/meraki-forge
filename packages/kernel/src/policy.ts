import { z } from "zod";
import type { RiskLevel } from "./risk.js";

export const ProjectPolicySchema = z
  .object({
    schema_version: z.literal("1"),
    autonomy_ceiling: z.enum(["LOW", "MEDIUM", "HIGH"]),
    auto_create_pr: z.boolean().default(false),
    auto_merge: z.literal(false),
    production_deploy: z.literal(false),
    ui_video: z.enum(["required", "optional", "disabled"]).default("required"),
  })
  .strict()
  .readonly();

export type ChangeImpact = "ui" | "backend" | "database" | "auth" | "mobile";
export interface GatePlan {
  readonly required: readonly string[];
  readonly evidence: readonly string[];
}
export function planGates(
  impacts: readonly ChangeImpact[],
  risk: RiskLevel,
): GatePlan {
  const gates = new Set(["ownership", "build", "tests", "qa", "review"]);
  const evidence = new Set([
    "acceptance-mapping",
    "test-report",
    "implementation-summary",
    "known-limitations",
  ]);
  if (impacts.includes("ui") || impacts.includes("mobile")) {
    gates.add("accessibility");
    evidence.add("screenshots");
    evidence.add("responsive-validation");
    evidence.add("demo-video");
  }
  if (impacts.includes("database")) {
    gates.add("migration-validation");
    gates.add("rollback-review");
    evidence.add("integrity-report");
  }
  if (impacts.includes("auth") || risk === "HIGH" || risk === "CRITICAL") {
    gates.add("security");
    evidence.add("negative-access-tests");
  }
  return Object.freeze({
    required: [...gates].sort(),
    evidence: [...evidence].sort(),
  });
}
