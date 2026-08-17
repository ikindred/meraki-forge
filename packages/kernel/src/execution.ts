import { z } from "zod";
import { PersonaSchema, type Persona } from "./contracts.js";
import {
  normalizeRepoPath,
  resolveOwner,
  validateBoundary,
  type BoundaryResult,
  type BoundaryViolation,
  type OwnershipRule,
} from "./ownership.js";

export const ExecutionNodeStatusSchema = z.enum([
  "PENDING",
  "RUNNABLE",
  "RUNNING",
  "BLOCKED",
  "COMPLETED",
  "FAILED",
]);

export const ExecutionNodeSchema = z
  .object({
    id: z.string().min(1),
    persona_id: PersonaSchema,
    dependencies: z.array(z.string()),
    ownership_scope: z.array(z.string()),
    acceptance_ids: z.array(z.string()),
    status: ExecutionNodeStatusSchema,
  })
  .readonly();

export const ExecutionManifestSchema = z
  .object({
    schema_version: z.literal("1"),
    revision: z.number().int().nonnegative(),
    task_id: z.string().min(1),
    run_id: z.string().min(1),
    created_at: z.string().datetime(),
    stack_profile: z.array(z.string()),
    nodes: z.array(ExecutionNodeSchema),
  })
  .superRefine((manifest, ctx) => {
    const ids = manifest.nodes.map((node) => node.id);
    if (new Set(ids).size !== ids.length)
      ctx.addIssue({
        code: "custom",
        path: ["nodes"],
        message: "Duplicate execution node",
      });
    const known = new Set(ids);
    manifest.nodes.forEach((node, index) => {
      if (node.dependencies.some((id) => !known.has(id)))
        ctx.addIssue({
          code: "custom",
          path: ["nodes", index, "dependencies"],
          message: "Unknown dependency",
        });
    });
  })
  .readonly();

export const DispatchRecordSchema = z
  .object({
    schema_version: z.literal("1"),
    id: z.string().min(1),
    task_id: z.string().min(1),
    run_id: z.string().min(1),
    persona_id: PersonaSchema,
    execution_node_id: z.string().min(1),
    ownership_scope: z.array(z.string()),
    repository_path: z.string().min(1),
    worktree_path: z.string().min(1),
    stack_profile: z.array(z.string()),
    relevant_contracts: z.array(z.string()),
    acceptance_criteria: z.array(z.string()),
    dependencies: z.array(z.string()),
    expected_output_schema: z.string().min(1),
    stop_conditions: z.array(z.string()).min(1),
  })
  .readonly();

const QA_ARTIFACT_ROOTS = [
  "tests/",
  "e2e/",
  ".forge/artifacts/",
  "test-results/",
  "playwright-report/",
] as const;
const EVIDENCE_ARTIFACT_ROOT = ".forge/artifacts/";

function violation(path: string, reason: string): BoundaryViolation {
  return { code: "AGENT_BOUNDARY_VIOLATION", path, reason };
}

export function validateExecutionBoundary(
  persona: Persona,
  changedPaths: readonly string[],
  ownershipRules: readonly OwnershipRule[],
  grant: readonly string[],
): BoundaryResult {
  if (persona === "qa-engineer" || persona === "evidence-agent") {
    const grantRules: OwnershipRule[] = grant.map((pattern) => ({
      pattern,
      owner: persona,
      effect: "allow",
    }));
    const violations = changedPaths.flatMap((rawPath) => {
      let path: string;
      try {
        path = normalizeRepoPath(rawPath);
      } catch {
        return [violation(rawPath, "invalid-or-escaping-path")];
      }
      const isAllowedArtifact =
        persona === "qa-engineer"
          ? QA_ARTIFACT_ROOTS.some((root) => path.startsWith(root))
          : path.startsWith(EVIDENCE_ARTIFACT_ROOT);
      if (!isAllowedArtifact)
        return [
          violation(
            path,
            persona === "qa-engineer"
              ? "qa-production-write"
              : "evidence-agent-non-artifact-write",
          ),
        ];
      const configured = resolveOwner(path, ownershipRules);
      const assigned = resolveOwner(path, grantRules);
      return configured.owner === persona && assigned.owner === persona
        ? []
        : [
            violation(
              path,
              persona === "qa-engineer"
                ? "qa-artifact-not-owned-or-granted"
                : "evidence-artifact-not-owned-or-granted",
            ),
          ];
    });
    return Object.freeze({ ok: violations.length === 0, violations });
  }
  const writePersonas: readonly Persona[] = [
    "frontend-engineer",
    "backend-engineer",
    "mobile-engineer",
    "database-architect",
  ];
  if (writePersonas.includes(persona))
    return validateBoundary(persona, changedPaths, ownershipRules, grant);
  const violations = changedPaths.map((path) =>
    violation(path, "execution-read-only-persona"),
  );
  return Object.freeze({ ok: violations.length === 0, violations });
}
