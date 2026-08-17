import { createHash } from "node:crypto";
import { z } from "zod";
import { TaskContractSchema } from "./contracts.js";
import type { ReleaseEligibility } from "./release.js";

const ShaSchema = z.string().regex(/^[a-f0-9]{40,64}$/);
export const DeliveryAuthorizationSchema = z
  .object({
    remote_push: z.boolean().default(false),
    create_pr: z.boolean().default(false),
    auto_merge: z.literal(false).default(false),
    production_deploy: z.literal(false).default(false),
  })
  .strict()
  .readonly();
export const DeliveryPolicySchema = DeliveryAuthorizationSchema;

export interface DeliveryEligibilityInput {
  readonly project_id: string;
  readonly repository_identity: string;
  readonly head_branch: string;
  readonly base_branch: string;
  readonly task: z.infer<typeof TaskContractSchema>;
  readonly autonomous_delivery_authorized: boolean;
  readonly candidate_frozen: boolean;
  readonly candidate_sha: string;
  readonly release: ReleaseEligibility;
  readonly ownership_clean: boolean;
  readonly required_gates_pass: boolean;
  readonly acceptance_proven: boolean;
  readonly blocking_findings_resolved: boolean;
  readonly evidence_manifest_valid: boolean;
  readonly evidence_candidate_sha: string;
  readonly documentation_exists: boolean;
  readonly known_limitations_recorded: boolean;
  readonly repair_loop_finished: boolean;
  readonly repository_clean: boolean;
}
export interface DeliveryEligibilityResult {
  readonly status: "ELIGIBLE" | "NOT_ELIGIBLE";
  readonly failures: readonly string[];
  readonly token: string | null;
  readonly input: DeliveryEligibilityInput;
}
export function evaluateDeliveryEligibility(
  input: DeliveryEligibilityInput,
): DeliveryEligibilityResult {
  TaskContractSchema.parse(input.task);
  for (const value of [
    input.project_id,
    input.repository_identity,
    input.head_branch,
    input.base_branch,
  ])
    if (!value.trim()) throw new Error("DELIVERY_IDENTITY_REQUIRED");
  ShaSchema.parse(input.candidate_sha);
  ShaSchema.parse(input.evidence_candidate_sha);
  const failures: string[] = [];
  if (!input.autonomous_delivery_authorized)
    failures.push("AUTONOMOUS_DELIVERY_NOT_AUTHORIZED");
  if (!input.candidate_frozen) failures.push("CANDIDATE_NOT_FROZEN");
  if (!input.release.eligible || !input.release.proof)
    failures.push("PHASE_3_RELEASE_NOT_ELIGIBLE");
  if (input.release.proof?.task_id !== input.task.id)
    failures.push("RELEASE_TASK_MISMATCH");
  if (input.release.proof?.candidate_sha !== input.candidate_sha)
    failures.push("RELEASE_CANDIDATE_MISMATCH");
  if (!input.ownership_clean) failures.push("OWNERSHIP_NOT_CLEAN");
  if (!input.required_gates_pass) failures.push("REQUIRED_GATES_NOT_PASSING");
  if (!input.acceptance_proven) failures.push("ACCEPTANCE_NOT_PROVEN");
  if (!input.blocking_findings_resolved)
    failures.push("BLOCKING_FINDINGS_UNRESOLVED");
  if (!input.evidence_manifest_valid)
    failures.push("EVIDENCE_MANIFEST_INVALID");
  if (input.evidence_candidate_sha !== input.candidate_sha)
    failures.push("EVIDENCE_NOT_BOUND_TO_CANDIDATE");
  if (!input.documentation_exists) failures.push("DOCUMENTATION_MISSING");
  if (!input.known_limitations_recorded)
    failures.push("KNOWN_LIMITATIONS_NOT_RECORDED");
  if (!input.repair_loop_finished) failures.push("REPAIR_LOOP_NOT_FINISHED");
  if (!input.repository_clean) failures.push("REPOSITORY_NOT_CLEAN");
  const unique = Object.freeze([...new Set(failures)]);
  return Object.freeze({
    status: unique.length ? "NOT_ELIGIBLE" : "ELIGIBLE",
    failures: unique,
    token: unique.length
      ? null
      : createHash("sha256")
          .update(
            JSON.stringify({
              task_id: input.task.id,
              project_id: input.project_id,
              repository_identity: input.repository_identity,
              head_branch: input.head_branch,
              base_branch: input.base_branch,
              candidate_sha: input.candidate_sha,
              manifest_revision: input.release.proof?.manifest_revision,
              release_digest: input.release.proof?.policy_digest,
            }),
          )
          .digest("hex"),
    input: Object.freeze({ ...input }),
  });
}

export interface RemotePushPolicyInput {
  readonly authorization: z.infer<typeof DeliveryAuthorizationSchema>;
  readonly repository_identity_verified: boolean;
  readonly local_branch: string;
  readonly remote_branch: string;
  readonly default_branch: string;
  readonly candidate_sha: string;
  readonly expected_candidate_sha: string;
  readonly force: boolean;
  readonly stale_base: boolean;
  readonly diverged: boolean;
}
export function evaluateRemotePushPolicy(input: RemotePushPolicyInput) {
  const authorization = DeliveryAuthorizationSchema.parse(input.authorization);
  const failures: string[] = [];
  if (!authorization.remote_push) failures.push("REMOTE_PUSH_NOT_AUTHORIZED");
  if (!input.repository_identity_verified)
    failures.push("REPOSITORY_IDENTITY_UNVERIFIED");
  if (input.local_branch !== input.remote_branch)
    failures.push("UNRELATED_REF_PUSH_DENIED");
  if (
    input.local_branch === input.default_branch ||
    input.remote_branch === input.default_branch
  )
    failures.push("DEFAULT_BRANCH_PUSH_DENIED");
  if (
    !/^forge\/[A-Za-z0-9][A-Za-z0-9._/-]*$/.test(input.local_branch) ||
    input.local_branch.includes("..")
  )
    failures.push("TASK_BRANCH_INVALID");
  if (input.candidate_sha !== input.expected_candidate_sha)
    failures.push("CANDIDATE_MISMATCH");
  if (input.force) failures.push("FORCE_PUSH_DENIED");
  if (input.stale_base) failures.push("STALE_BASE");
  if (input.diverged) failures.push("REMOTE_DIVERGED");
  return Object.freeze({
    allowed: failures.length === 0,
    failures: Object.freeze([...new Set(failures)]),
  });
}

const domainNames = {
  frontend: "Frontend",
  backend: "Backend",
  database: "Database",
  mobile: "Mobile",
  infrastructure: "Infrastructure",
} as const;
export interface PullRequestBodyInput {
  readonly objective: string;
  readonly candidate_sha: string;
  readonly evidence_manifest_digest: string;
  readonly task: z.infer<typeof TaskContractSchema>;
  readonly risk: string;
  readonly changed_domains: readonly (keyof typeof domainNames)[];
  readonly acceptance: readonly {
    criterion: string;
    status: "PASS" | "FAIL";
    verification_method: string;
    evidence: readonly EvidenceDeliveryReference[];
  }[];
  readonly implementation_summary: string;
  readonly architecture_impact: string;
  readonly tests: readonly string[];
  readonly qa: string;
  readonly security: string;
  readonly accessibility: string;
  readonly code_review: string;
  readonly evidence: {
    readonly manifest: EvidenceDeliveryReference;
    readonly screenshots: readonly EvidenceDeliveryReference[];
    readonly videos: readonly EvidenceDeliveryReference[];
    readonly reports: readonly EvidenceDeliveryReference[];
    readonly documentation: readonly EvidenceDeliveryReference[];
  };
  readonly known_limitations: readonly string[];
  readonly agent_execution_summary: readonly string[];
}
export interface EvidenceDeliveryReference {
  readonly label: string;
  readonly accessibility:
    "REVIEWER_ACCESSIBLE" | "LOCAL_ONLY" | "OMITTED_BY_POLICY";
  readonly location?: string;
}
const bullet = (items: readonly string[]) =>
  items.length
    ? items.map((item) => `- ${item}`).join("\n")
    : "- None recorded";
export function generatePullRequestBody(input: PullRequestBodyInput): string {
  TaskContractSchema.parse(input.task);
  ShaSchema.parse(input.candidate_sha);
  if (!/^[a-f0-9]{64}$/.test(input.evidence_manifest_digest))
    throw new Error("INVALID_EVIDENCE_MANIFEST_DIGEST");
  const evidenceReference = (reference: EvidenceDeliveryReference): string => {
    if (!reference.label.trim()) throw new Error("EVIDENCE_LABEL_REQUIRED");
    if (reference.accessibility === "REVIEWER_ACCESSIBLE") {
      if (!reference.location?.trim())
        throw new Error("ACCESSIBLE_EVIDENCE_LOCATION_REQUIRED");
      return `${reference.label}: ${reference.location}`;
    }
    if (reference.location)
      throw new Error("INACCESSIBLE_EVIDENCE_MUST_NOT_EXPOSE_LOCATION");
    return reference.accessibility === "LOCAL_ONLY"
      ? `${reference.label} (local-only; not attached)`
      : `${reference.label} (omitted by policy)`;
  };
  const evidence = [
    "## Screenshots",
    bullet(input.evidence.screenshots.map(evidenceReference)),
    "## Video",
    bullet(input.evidence.videos.map(evidenceReference)),
    "## Reports",
    bullet(input.evidence.reports.map(evidenceReference)),
    "## Manifest",
    `- ${evidenceReference(input.evidence.manifest)}`,
    "## Documentation",
    bullet(input.evidence.documentation.map(evidenceReference)),
  ].join("\n");
  const acceptance =
    input.acceptance
      .map(
        (item) =>
          `- ${item.criterion}\n  - ${item.status}\n  - Verification: ${item.verification_method}\n  - Evidence: ${item.evidence.map(evidenceReference).join(", ") || "None recorded"}`,
      )
      .join("\n") || "- None recorded";
  return (
    [
      "# Objective",
      input.objective,
      "# Task",
      `- Task ID: ${input.task.id}\n- Mode: ${input.task.mode}\n- Priority: ${input.task.priority}\n- Risk: ${input.risk}`,
      "# Acceptance Criteria",
      acceptance,
      "# Implementation Summary",
      input.implementation_summary,
      "# Changed Domains",
      bullet(input.changed_domains.map((domain) => domainNames[domain])),
      "# Architecture Impact",
      input.architecture_impact,
      "# Tests",
      bullet(input.tests),
      "# QA",
      input.qa,
      "# Security",
      input.security,
      "# Accessibility",
      input.accessibility,
      "# Code Review",
      input.code_review,
      "# Evidence",
      `- Candidate SHA: ${input.candidate_sha}\n- Manifest SHA-256: ${input.evidence_manifest_digest}`,
      evidence,
      "# Known Limitations",
      bullet(input.known_limitations),
      "# Agent Execution Summary",
      bullet(input.agent_execution_summary),
      "# Human Action Required",
      "Review this PR.\n\nChoose:\n\n- Merge\n- Request Changes\n- Reject",
    ].join("\n\n") + "\n"
  );
}

const prohibited =
  /(?:merge|deploy|production|secret|admin|protection|forcepush)/i;
export function listProhibitedDeliveryCapabilities(
  capabilities: readonly string[],
) {
  return Object.freeze(
    capabilities.filter((capability) => prohibited.test(capability)),
  );
}

export const NotificationEventSchema = z
  .object({
    type: z.enum(["PR_READY", "DECISION_REQUIRED", "AUTOMATION_FAILED"]),
    task_id: z.string().min(1),
    at: z.string().datetime(),
    message: z.string().min(1),
  })
  .strict()
  .readonly();
export function createDeliveryNotificationEvents(input: {
  readonly previous: {
    readonly pr_ready: boolean;
    readonly decision_required: boolean;
  };
  readonly current: {
    readonly pr_ready: boolean;
    readonly decision_required: boolean;
    readonly automation_failed: boolean;
  };
  readonly task_id: string;
  readonly pr_url?: string;
  readonly at: string;
}) {
  const events: z.infer<typeof NotificationEventSchema>[] = [];
  if (!input.previous.pr_ready && input.current.pr_ready)
    events.push({
      type: "PR_READY",
      task_id: input.task_id,
      at: input.at,
      message: input.pr_url
        ? `PR ready: ${input.pr_url}`
        : "PR ready for human review",
    });
  if (!input.previous.decision_required && input.current.decision_required)
    events.push({
      type: "DECISION_REQUIRED",
      task_id: input.task_id,
      at: input.at,
      message: "Human decision required",
    });
  if (input.current.automation_failed)
    events.push({
      type: "AUTOMATION_FAILED",
      task_id: input.task_id,
      at: input.at,
      message: "Delivery automation failed",
    });
  return Object.freeze(
    events.map((event) => NotificationEventSchema.parse(event)),
  );
}

export interface DeliveryTaskReport {
  readonly task_id: string;
  readonly title: string;
  readonly status:
    | "REVIEW"
    | "IN_PROGRESS"
    | "BLOCKED"
    | "DECISION_REQUIRED"
    | "FAILED"
    | "MERGED";
  readonly phase: string;
  readonly pr_url?: string;
  readonly blocker?: string;
  readonly attempted_repairs?: number;
  readonly required_action?: string;
}
export function buildBossReport(tasks: readonly DeliveryTaskReport[]): string {
  const groups: readonly [string, (task: DeliveryTaskReport) => boolean][] = [
    ["PR READY", (t) => t.status === "REVIEW"],
    ["IN PROGRESS", (t) => t.status === "IN_PROGRESS"],
    ["BLOCKED", (t) => t.status === "BLOCKED"],
    ["DECISION REQUIRED", (t) => t.status === "DECISION_REQUIRED"],
    ["FAILED", (t) => t.status === "FAILED"],
    ["COMPLETED / MERGED", (t) => t.status === "MERGED"],
  ];
  const render = (task: DeliveryTaskReport) =>
    `- ${task.task_id}: ${task.title}${task.pr_url ? ` — ${task.pr_url}` : ""}${task.blocker ? ` — Blocker: ${task.blocker}` : ""}${task.attempted_repairs !== undefined ? ` — Attempted repairs: ${task.attempted_repairs}` : ""}${task.required_action ? ` — Required action: ${task.required_action}` : ""}`;
  return (
    groups
      .map(
        ([title, predicate]) =>
          `# ${title}\n\n${
            tasks
              .filter(predicate)
              .sort((a, b) => a.task_id.localeCompare(b.task_id))
              .map(render)
              .join("\n") || "- None"
          }`,
      )
      .join("\n\n") + "\n"
  );
}

const DeliveryRecordSchema = z
  .object({
    eligibility: z.enum(["ELIGIBLE", "NOT_ELIGIBLE"]),
    remote_authorized: z.boolean(),
    push_status: z.enum(["NOT_PUSHED", "PUSHED", "FAILED"]),
    pushed_sha: ShaSchema.nullable(),
    pr_number: z.number().int().positive().nullable(),
    pr_url: z.string().url().nullable(),
    pr_status: z.enum(["NOT_CREATED", "OPEN", "CLOSED"]),
    delivery_revision: z.number().int().nonnegative(),
    obsidian_synced: z.boolean(),
    notified: z.boolean(),
    last_error: z.string().nullable(),
  })
  .strict()
  .superRefine((delivery, ctx) => {
    if (delivery.push_status === "PUSHED" && delivery.pushed_sha === null)
      ctx.addIssue({
        code: "custom",
        path: ["pushed_sha"],
        message: "PUSHED requires SHA",
      });
    if (
      delivery.pr_status === "OPEN" &&
      (!delivery.pr_number || !delivery.pr_url)
    )
      ctx.addIssue({
        code: "custom",
        path: ["pr_status"],
        message: "OPEN requires PR metadata",
      });
  })
  .readonly();
export const DeliveryStateSchema = z
  .object({
    schema_version: z.literal("1"),
    task_id: z.string().min(1),
    revision: z.number().int().nonnegative(),
    candidate_sha: ShaSchema,
    status: z.literal("REVIEW"),
    delivery: DeliveryRecordSchema,
    updated_at: z.string().datetime(),
  })
  .strict()
  .superRefine((state, ctx) => {
    if (
      state.delivery.pushed_sha !== null &&
      state.delivery.pushed_sha !== state.candidate_sha
    )
      ctx.addIssue({
        code: "custom",
        path: ["delivery", "pushed_sha"],
        message: "Pushed SHA must match candidate",
      });
  })
  .readonly();
