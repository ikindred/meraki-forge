import { createHash } from "node:crypto";
import { ForgeMessageSchema, deepFreeze, type Persona } from "./contracts.js";
import type { BoundaryResult } from "./ownership.js";
import type { z } from "zod";
type DependencyRequest = Extract<
  z.infer<typeof ForgeMessageSchema>,
  { kind: "DEPENDENCY_REQUEST" }
>;

export interface DependencyRequestContext {
  readonly task_id: string;
  readonly run_id: string;
  readonly from: Persona;
  readonly created_at: string;
  readonly acceptance_ids: readonly string[];
  readonly required_output: string;
}

export function createDependencyRequests(
  context: DependencyRequestContext,
  boundary: BoundaryResult,
): readonly DependencyRequest[] {
  const crossDomain = boundary.violations.filter(
    (violation) => violation.reason === "outside-assignment-grant",
  );
  if (
    boundary.violations.length > 0 &&
    crossDomain.some((violation) => !violation.expected_owner)
  )
    throw new Error("Cross-domain violation has no expected owner");
  if (
    boundary.violations.some((violation) => violation.reason === "unowned-path")
  )
    throw new Error(
      "Cannot create dependency request without an expected owner",
    );
  return deepFreeze(
    crossDomain.map((violation) => {
      const parsed = ForgeMessageSchema.parse({
        kind: "DEPENDENCY_REQUEST",
        schema_version: "1",
        id: `DEP-${createHash("sha256").update(`${context.task_id}:${context.run_id}:${context.from}:${violation.path}`).digest("hex").slice(0, 16)}`,
        task_id: context.task_id,
        run_id: context.run_id,
        from: context.from,
        to: "engineering-coordinator",
        created_at: context.created_at,
        payload: {
          reason: `Change required outside ${context.from} ownership`,
          affected_paths: [violation.path],
          blocking: true,
          requested_owner: violation.expected_owner,
          domain: violation.expected_owner,
          required_output: context.required_output,
          acceptance_ids: [...context.acceptance_ids],
        },
      });
      if (parsed.kind !== "DEPENDENCY_REQUEST")
        throw new Error("Dependency request schema mismatch");
      return parsed;
    }),
  );
}
