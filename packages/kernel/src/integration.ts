import { ForgeMessageSchema } from "./contracts.js";

export const MECHANICAL_INTEGRATION_KINDS = [
  "CONFLICT_MARKER_RESOLUTION",
  "LOCKFILE_REGENERATION",
  "IMPORT_ORDERING",
  "FORMATTING",
] as const;
type MechanicalKind = (typeof MECHANICAL_INTEGRATION_KINDS)[number];
type IntegrationKind =
  MechanicalKind | "PRODUCT_BEHAVIOR" | "CONTRACT_CHANGE" | "BUSINESS_LOGIC";

export function classifyIntegrationChanges(
  changes: readonly { readonly path: string; readonly kind: IntegrationKind }[],
): {
  readonly ok: boolean;
  readonly reason?: "semantic-change-required";
  readonly disallowed_paths?: readonly string[];
} {
  const mechanical = new Set<string>(MECHANICAL_INTEGRATION_KINDS);
  const disallowed = changes
    .filter((change) => !mechanical.has(change.kind))
    .map((change) => change.path);
  return disallowed.length === 0
    ? Object.freeze({ ok: true })
    : Object.freeze({
        ok: false,
        reason: "semantic-change-required",
        disallowed_paths: disallowed,
      });
}

interface SemanticConflictInput {
  readonly id: string;
  readonly task_id: string;
  readonly run_id: string;
  readonly created_at: string;
  readonly affected_paths: readonly string[];
  readonly reason: string;
  readonly alternatives: readonly string[];
}

export function createSemanticConflict(input: SemanticConflictInput) {
  return ForgeMessageSchema.parse({
    kind: "SEMANTIC_CONFLICT",
    schema_version: "1",
    id: input.id,
    task_id: input.task_id,
    run_id: input.run_id,
    from: "integration-agent",
    to: "architect",
    created_at: input.created_at,
    payload: {
      reason: input.reason,
      affected_paths: [...input.affected_paths],
      blocking: true,
      alternatives: [...input.alternatives],
    },
  });
}
