import { describe, expect, it } from "vitest";
import {
  DeliveryAuthorizationSchema,
  DeliveryStateSchema,
  buildBossReport,
  createDeliveryNotificationEvents,
  evaluateDeliveryEligibility,
  evaluateRemotePushPolicy,
  generatePullRequestBody,
  listProhibitedDeliveryCapabilities,
  type DeliveryTaskReport,
} from "../packages/kernel/src/delivery.js";
import type { TaskContract } from "../packages/kernel/src/index.js";

const sha = "a".repeat(40);
const at = "2026-08-17T00:00:00.000Z";

const task: TaskContract = {
  schema_version: "1",
  id: "MF-400",
  title: "Deliver verified PR",
  mode: "AUTO",
  priority: "P1",
  outcome: "A human-reviewable PR exists",
  acceptance_criteria: [
    { id: "AC-1", text: "PR contains candidate-bound evidence" },
  ],
  constraints: [],
  known_dependencies: [],
  notes: "",
};

describe("delivery kernel policy", () => {
  it("defaults remote delivery to deny and keeps merge/deploy impossible", () => {
    expect(DeliveryAuthorizationSchema.parse({})).toEqual({
      remote_push: false,
      create_pr: false,
      auto_merge: false,
      production_deploy: false,
    });
    expect(
      DeliveryAuthorizationSchema.safeParse({ auto_merge: true }).success,
    ).toBe(false);
    expect(
      DeliveryAuthorizationSchema.safeParse({
        production_deploy: true,
      }).success,
    ).toBe(false);
  });

  it("requires Phase 3 release proof and candidate-bound evidence", () => {
    const eligible = evaluateDeliveryEligibility({
      project_id: "meraki-forge",
      repository_identity: "kindred/meraki-forge",
      head_branch: "forge/MF-400",
      base_branch: "main",
      task,
      autonomous_delivery_authorized: true,
      candidate_frozen: true,
      candidate_sha: sha,
      release: {
        eligible: true,
        failures: [],
        proof: {
          task_id: task.id,
          manifest_revision: 4,
          candidate_sha: sha,
          policy_digest: "d".repeat(64),
        },
      },
      ownership_clean: true,
      required_gates_pass: true,
      acceptance_proven: true,
      blocking_findings_resolved: true,
      evidence_manifest_valid: true,
      evidence_candidate_sha: sha,
      documentation_exists: true,
      known_limitations_recorded: true,
      repair_loop_finished: true,
      repository_clean: true,
    });
    expect(eligible.status).toBe("ELIGIBLE");
    expect(eligible.token).toMatch(/^[a-f0-9]{64}$/);
    expect(
      evaluateDeliveryEligibility({
        ...eligible.input,
        repository_identity: "other/repository",
      }).token,
    ).not.toBe(eligible.token);

    const denied = evaluateDeliveryEligibility({
      ...eligible.input,
      repository_clean: false,
      evidence_candidate_sha: "b".repeat(40),
    });
    expect(denied.status).toBe("NOT_ELIGIBLE");
    expect(denied.failures).toEqual(
      expect.arrayContaining([
        "REPOSITORY_NOT_CLEAN",
        "EVIDENCE_NOT_BOUND_TO_CANDIDATE",
      ]),
    );
  });

  it("allows only non-force task-branch pushes after identity verification", () => {
    const authorization = DeliveryAuthorizationSchema.parse({
      remote_push: true,
    });
    expect(
      evaluateRemotePushPolicy({
        authorization,
        repository_identity_verified: true,
        local_branch: "main",
        remote_branch: "main",
        default_branch: "main",
        candidate_sha: sha,
        expected_candidate_sha: sha,
        force: false,
        stale_base: false,
        diverged: false,
      }).failures,
    ).toContain("DEFAULT_BRANCH_PUSH_DENIED");
    expect(
      evaluateRemotePushPolicy({
        authorization,
        repository_identity_verified: true,
        local_branch: "forge/MF-400",
        remote_branch: "forge/MF-400",
        default_branch: "main",
        candidate_sha: sha,
        expected_candidate_sha: sha,
        force: true,
        stale_base: false,
        diverged: false,
      }).failures,
    ).toContain("FORCE_PUSH_DENIED");
  });

  it("reports every fail-closed eligibility and push-policy reason deterministically", () => {
    const denied = evaluateDeliveryEligibility({
      project_id: "meraki-forge",
      repository_identity: "kindred/meraki-forge",
      head_branch: "forge/MF-400",
      base_branch: "main",
      task,
      autonomous_delivery_authorized: false,
      candidate_frozen: false,
      candidate_sha: sha,
      release: { eligible: false, failures: ["missing"] },
      ownership_clean: false,
      required_gates_pass: false,
      acceptance_proven: false,
      blocking_findings_resolved: false,
      evidence_manifest_valid: false,
      evidence_candidate_sha: "b".repeat(40),
      documentation_exists: false,
      known_limitations_recorded: false,
      repair_loop_finished: false,
      repository_clean: false,
    });
    expect(denied.token).toBeNull();
    expect(denied.failures).toEqual([
      "AUTONOMOUS_DELIVERY_NOT_AUTHORIZED",
      "CANDIDATE_NOT_FROZEN",
      "PHASE_3_RELEASE_NOT_ELIGIBLE",
      "RELEASE_TASK_MISMATCH",
      "RELEASE_CANDIDATE_MISMATCH",
      "OWNERSHIP_NOT_CLEAN",
      "REQUIRED_GATES_NOT_PASSING",
      "ACCEPTANCE_NOT_PROVEN",
      "BLOCKING_FINDINGS_UNRESOLVED",
      "EVIDENCE_MANIFEST_INVALID",
      "EVIDENCE_NOT_BOUND_TO_CANDIDATE",
      "DOCUMENTATION_MISSING",
      "KNOWN_LIMITATIONS_NOT_RECORDED",
      "REPAIR_LOOP_NOT_FINISHED",
      "REPOSITORY_NOT_CLEAN",
    ]);

    expect(
      evaluateRemotePushPolicy({
        authorization: DeliveryAuthorizationSchema.parse({}),
        repository_identity_verified: false,
        local_branch: "bad/../branch",
        remote_branch: "different",
        default_branch: "main",
        candidate_sha: sha,
        expected_candidate_sha: "b".repeat(40),
        force: true,
        stale_base: true,
        diverged: true,
      }).failures,
    ).toEqual([
      "REMOTE_PUSH_NOT_AUTHORIZED",
      "REPOSITORY_IDENTITY_UNVERIFIED",
      "UNRELATED_REF_PUSH_DENIED",
      "TASK_BRANCH_INVALID",
      "CANDIDATE_MISMATCH",
      "FORCE_PUSH_DENIED",
      "STALE_BASE",
      "REMOTE_DIVERGED",
    ]);
  });
});

describe("delivery presentation contracts", () => {
  it("generates a PR body from supplied Forge state only", () => {
    const body = generatePullRequestBody({
      objective: "Create human review boundary",
      candidate_sha: sha,
      evidence_manifest_digest: "e".repeat(64),
      task,
      risk: "MEDIUM",
      changed_domains: ["backend"],
      acceptance: [
        {
          criterion: "PR contains candidate-bound evidence",
          status: "PASS",
          verification_method: "QA",
          evidence: [
            {
              label: "QA result",
              accessibility: "REVIEWER_ACCESSIBLE",
              location: "https://artifacts.example/MF-400/qa.json",
            },
          ],
        },
      ],
      implementation_summary: "Added controlled delivery contracts.",
      architecture_impact: "Delivery remains default deny.",
      tests: ["npm test"],
      qa: "PASS",
      security: "PASS",
      accessibility: "NOT_APPLICABLE",
      code_review: "PASS",
      evidence: {
        manifest: {
          label: "Candidate evidence manifest",
          accessibility: "REVIEWER_ACCESSIBLE",
          location: "https://artifacts.example/MF-400/manifest.json",
        },
        screenshots: [],
        videos: [{ label: "UI walkthrough", accessibility: "LOCAL_ONLY" }],
        reports: [
          {
            label: "Testing report",
            accessibility: "REVIEWER_ACCESSIBLE",
            location: "docs/TESTING.md",
          },
        ],
        documentation: [
          {
            label: "Summary",
            accessibility: "REVIEWER_ACCESSIBLE",
            location: "docs/SUMMARY.md",
          },
        ],
      },
      known_limitations: ["No provider upload adapter configured."],
      agent_execution_summary: ["release-agent packaged metadata"],
    });
    expect(body).toContain("# Objective");
    expect(body).toContain("Task ID: MF-400");
    expect(body).toContain(`Candidate SHA: ${sha}`);
    expect(body).toContain("- Backend");
    expect(body).not.toContain("- Frontend");
    expect(body).toContain("UI walkthrough (local-only; not attached)");
    expect(body).toContain("Review this PR.");
  });

  it("refuses evidence claims that are not truthfully accessible", () => {
    const invalid = {
      label: "private screenshot",
      accessibility: "LOCAL_ONLY" as const,
      location: "/private/screenshot.png",
    };
    expect(() =>
      generatePullRequestBody({
        objective: "Review",
        candidate_sha: sha,
        evidence_manifest_digest: "e".repeat(64),
        task,
        risk: "LOW",
        changed_domains: [],
        acceptance: [],
        implementation_summary: "None",
        architecture_impact: "None",
        tests: [],
        qa: "PASS",
        security: "NOT_APPLICABLE",
        accessibility: "NOT_APPLICABLE",
        code_review: "PASS",
        evidence: {
          manifest: invalid,
          screenshots: [],
          videos: [],
          reports: [],
          documentation: [],
        },
        known_limitations: [],
        agent_execution_summary: [],
      }),
    ).toThrow("INACCESSIBLE_EVIDENCE_MUST_NOT_EXPOSE_LOCATION");
  });

  it("detects forbidden delivery capability names", () => {
    expect(
      listProhibitedDeliveryCapabilities([
        "inspectRepository",
        "createPullRequest",
        "mergePullRequest",
        "deployProduction",
      ]),
    ).toEqual(["mergePullRequest", "deployProduction"]);
  });
});

describe("notification and report contracts", () => {
  it("emits only important human-facing notification events", () => {
    expect(
      createDeliveryNotificationEvents({
        previous: { pr_ready: false, decision_required: false },
        current: {
          pr_ready: true,
          decision_required: true,
          automation_failed: false,
        },
        task_id: "MF-400",
        pr_url: "https://github.example/pr/1",
        at,
      }).map((event) => event.type),
    ).toEqual(["PR_READY", "DECISION_REQUIRED"]);
  });

  it("emits a stable failure event without inventing routine notifications", () => {
    expect(
      createDeliveryNotificationEvents({
        previous: { pr_ready: true, decision_required: true },
        current: {
          pr_ready: true,
          decision_required: true,
          automation_failed: true,
        },
        task_id: "MF-400",
        at,
      }).map((event) => event.type),
    ).toEqual(["AUTOMATION_FAILED"]);
  });

  it("builds a deterministic End-of-Day Boss Report from durable state", () => {
    const tasks: readonly DeliveryTaskReport[] = [
      {
        task_id: "MF-2",
        title: "Blocked task",
        status: "BLOCKED",
        phase: "REPAIRING",
        blocker: "Security finding",
        attempted_repairs: 2,
        required_action: "Review auth design",
      },
      {
        task_id: "MF-1",
        title: "Ready task",
        status: "REVIEW",
        phase: "DELIVERED",
        pr_url: "https://github.example/pr/1",
      },
    ];
    const report = buildBossReport(tasks);
    expect(report).toContain("PR READY");
    expect(report.indexOf("MF-1")).toBeLessThan(report.indexOf("MF-2"));
    expect(report).not.toContain("DONE");
  });

  it("renders every Boss Report state without treating PR creation as merged", () => {
    const report = buildBossReport([
      { task_id: "2", title: "working", status: "IN_PROGRESS", phase: "QA" },
      {
        task_id: "3",
        title: "decision",
        status: "DECISION_REQUIRED",
        phase: "INTAKE",
        required_action: "Choose",
      },
      { task_id: "4", title: "failed", status: "FAILED", phase: "DELIVERY" },
      {
        task_id: "5",
        title: "merged",
        status: "MERGED",
        phase: "EXTERNAL_CONFIRMED",
      },
    ]);
    expect(report).toContain("# IN PROGRESS\n\n- 2: working");
    expect(report).toContain("# DECISION REQUIRED\n\n- 3: decision");
    expect(report).toContain("# FAILED\n\n- 4: failed");
    expect(report).toContain("# COMPLETED / MERGED\n\n- 5: merged");
  });
});

describe("delivery REVIEW state schema", () => {
  it("persists resumable delivery side effects without marking DONE", () => {
    expect(
      DeliveryStateSchema.parse({
        schema_version: "1",
        task_id: "MF-400",
        revision: 1,
        candidate_sha: sha,
        status: "REVIEW",
        delivery: {
          eligibility: "ELIGIBLE",
          remote_authorized: true,
          push_status: "PUSHED",
          pushed_sha: sha,
          pr_number: 12,
          pr_url: "https://github.example/pr/12",
          pr_status: "OPEN",
          delivery_revision: 2,
          obsidian_synced: true,
          notified: true,
          last_error: null,
        },
        updated_at: at,
      }).status,
    ).toBe("REVIEW");
    expect(
      DeliveryStateSchema.safeParse({
        schema_version: "1",
        task_id: "MF-400",
        revision: 1,
        candidate_sha: sha,
        status: "DONE",
        delivery: {},
        updated_at: at,
      }).success,
    ).toBe(false);
  });
});
