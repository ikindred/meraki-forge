import { validateExecutionBoundary } from "../../kernel/src/execution.js";
import type { OwnershipRule } from "../../kernel/src/ownership.js";
import type { Persona } from "../../kernel/src/contracts.js";
import type { ValidationBoundaryVerifier } from "../../execution/src/validation-orchestrator.js";

export class OwnershipValidationBoundary implements ValidationBoundaryVerifier {
  constructor(private readonly ownership: readonly OwnershipRule[]) {}

  assertAllowed(
    persona: Persona,
    changedPaths: readonly string[],
    grant: readonly string[],
  ): Promise<void> {
    const result = validateExecutionBoundary(
      persona,
      changedPaths,
      this.ownership,
      grant,
    );
    if (!result.ok)
      return Promise.reject(
        new Error(
          `VALIDATOR_WRITE_VIOLATION:${result.violations.map((item) => item.path).join(",")}`,
        ),
      );
    return Promise.resolve();
  }
}
