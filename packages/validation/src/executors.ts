import { z } from "zod";

const SeveritySchema = z.enum(["info", "low", "medium", "high", "critical"]);
const ExecutionIdentitySchema = z
  .object({
    task_id: z.string().min(1),
    candidate_commit: z.string().regex(/^[0-9a-f]{40}$/),
    worktree: z.string().min(1),
  })
  .strict();

const AcceptanceCriterionSchema = z
  .object({ criterion_id: z.string().min(1), statement: z.string().min(1) })
  .strict();

const QaValidationInputSchema = ExecutionIdentitySchema.extend({
  acceptance_criteria: z.array(AcceptanceCriterionSchema),
  test_scope: z.array(z.string().min(1)),
}).strict();

const QaFindingSchema = z
  .object({
    finding_id: z.string().min(1),
    severity: SeveritySchema,
    acceptance_criterion: z.string().min(1),
    evidence: z.array(z.string().min(1)).min(1),
    expected_owner: z.string().min(1),
    blocking: z.boolean(),
    message: z.string().min(1),
  })
  .strict();

const QaResultSchema = z
  .object({
    status: z.enum(["PASS", "FAIL", "NOT_APPLICABLE"]),
    findings: z.array(QaFindingSchema),
    reason: z.string().min(1).optional(),
  })
  .strict()
  .superRefine((result, context) => {
    if (result.status === "NOT_APPLICABLE" && result.reason === undefined) {
      context.addIssue({
        code: "custom",
        message: "NOT_APPLICABLE requires a reason",
        path: ["reason"],
      });
    }
  });

const ReadOnlyAuditInputSchema = ExecutionIdentitySchema.extend({
  changed_files: z.array(z.string().min(1)),
}).strict();

const SecurityFindingSchema = z
  .object({
    finding_id: z.string().min(1),
    severity: SeveritySchema,
    category: z.string().min(1),
    affected_files: z.array(z.string().min(1)),
    evidence: z.array(z.string().min(1)).min(1),
    expected_owner: z.string().min(1),
    blocking: z.boolean(),
    recommendation: z.string().min(1),
  })
  .strict();

const AccessibilityFindingSchema = z
  .object({
    finding_id: z.string().min(1),
    severity: SeveritySchema,
    category: z.string().min(1),
    affected_files: z.array(z.string().min(1)),
    evidence: z.array(z.string().min(1)).min(1),
    expected_owner: z.enum(["frontend-engineer", "ui-ux-engineer"]),
    blocking: z.boolean(),
    message: z.string().min(1),
  })
  .strict();

function auditResultSchema<T extends z.ZodType>(finding: T) {
  return z
    .object({
      status: z.enum(["PASS", "FAIL", "NOT_APPLICABLE"]),
      findings: z.array(finding),
      reason: z.string().min(1).optional(),
    })
    .strict()
    .superRefine((result, context) => {
      if (result.status === "NOT_APPLICABLE" && result.reason === undefined) {
        context.addIssue({
          code: "custom",
          message: "NOT_APPLICABLE requires a reason",
          path: ["reason"],
        });
      }
    });
}

const SecurityResultSchema = auditResultSchema(SecurityFindingSchema);
const AccessibilityResultSchema = auditResultSchema(AccessibilityFindingSchema);

const AccessibilityAuditInputSchema = ReadOnlyAuditInputSchema.extend({
  viewports: z.array(z.enum(["desktop", "tablet", "mobile"])),
}).strict();

const ReviewFindingSchema = z
  .object({
    finding_id: z.string().min(1),
    severity: SeveritySchema,
    category: z.string().min(1),
    affected_files: z.array(z.string().min(1)),
    evidence: z.array(z.string().min(1)).min(1),
    expected_owner: z.string().min(1),
    blocking: z.boolean(),
    message: z.string().min(1),
  })
  .strict();

const CodeReviewResultSchema = z
  .object({
    decision: z.enum(["APPROVED", "CHANGES_REQUESTED"]),
    findings: z.array(ReviewFindingSchema),
  })
  .strict()
  .superRefine((result, context) => {
    if (
      result.decision === "APPROVED" &&
      result.findings.some((finding) => finding.blocking)
    ) {
      context.addIssue({
        code: "custom",
        message: "APPROVED cannot include blocking findings",
        path: ["findings"],
      });
    }
  });

export type QaValidationInput = z.infer<typeof QaValidationInputSchema>;
export type QaResult = z.infer<typeof QaResultSchema>;
export type SecurityAuditInput = z.infer<typeof ReadOnlyAuditInputSchema>;
export type SecurityResult = z.infer<typeof SecurityResultSchema>;
export type AccessibilityAuditInput = z.infer<
  typeof AccessibilityAuditInputSchema
>;
export type AccessibilityResult = z.infer<typeof AccessibilityResultSchema>;
export type CodeReviewInput = z.infer<typeof ReadOnlyAuditInputSchema>;
export type CodeReviewResult = z.infer<typeof CodeReviewResultSchema>;

export interface ScopedArtifactWriter {
  write(relativePath: string, content: string | Uint8Array): Promise<string>;
}

export interface QaCapabilities {
  readonly artifacts: ScopedArtifactWriter;
}

export interface QaDriver {
  execute(
    input: QaValidationInput,
    capabilities: QaCapabilities,
  ): Promise<unknown>;
}

export interface SecurityDriver {
  execute(input: SecurityAuditInput): Promise<unknown>;
}

export interface AccessibilityDriver {
  execute(input: AccessibilityAuditInput): Promise<unknown>;
}

export interface CodeReviewDriver {
  execute(input: CodeReviewInput): Promise<unknown>;
}

export class QaValidator {
  constructor(
    private readonly driver: QaDriver,
    private readonly artifacts: ScopedArtifactWriter,
  ) {}

  async run(input: QaValidationInput): Promise<QaResult> {
    const validatedInput = QaValidationInputSchema.parse(input);
    const output = await this.driver.execute(validatedInput, {
      artifacts: this.artifacts,
    });
    return QaResultSchema.parse(output);
  }
}

export class SecurityValidator {
  constructor(private readonly driver: SecurityDriver) {}

  async run(input: SecurityAuditInput): Promise<SecurityResult> {
    const validatedInput = ReadOnlyAuditInputSchema.parse(input);
    return SecurityResultSchema.parse(
      await this.driver.execute(validatedInput),
    );
  }
}

export class AccessibilityValidator {
  constructor(private readonly driver: AccessibilityDriver) {}

  async run(input: AccessibilityAuditInput): Promise<AccessibilityResult> {
    const validatedInput = AccessibilityAuditInputSchema.parse(input);
    return AccessibilityResultSchema.parse(
      await this.driver.execute(validatedInput),
    );
  }
}

export class CodeReviewValidator {
  constructor(private readonly driver: CodeReviewDriver) {}

  async run(input: CodeReviewInput): Promise<CodeReviewResult> {
    const validatedInput = ReadOnlyAuditInputSchema.parse(input);
    return CodeReviewResultSchema.parse(
      await this.driver.execute(validatedInput),
    );
  }
}
