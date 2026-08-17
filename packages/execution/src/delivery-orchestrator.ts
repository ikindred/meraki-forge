export type DeliveryEligibility = "ELIGIBLE" | "NOT_ELIGIBLE";
export type DeliveryStep = "PUSH" | "PR" | "OBSIDIAN" | "NOTIFICATION";

export interface DeliveryRequest {
  readonly task_id: string;
  readonly candidate_sha: string;
  readonly project_id: string;
  readonly repository_identity: string;
  readonly manifest_revision: number;
  readonly head_branch: string;
  readonly base_branch: string;
}

export interface TrustedDeliveryConfig {
  readonly project_id: string;
  readonly repository_identity: string;
  readonly remote_push: boolean;
  readonly create_pr: boolean;
  readonly auto_merge: false;
  readonly production_deploy: false;
}

export interface DeliveryState {
  readonly schema_version: "1";
  readonly task_id: string;
  readonly revision: number;
  readonly candidate_sha: string;
  readonly project_id: string;
  readonly repository_identity: string;
  readonly manifest_revision: number;
  readonly eligibility_digest: string | null;
  readonly eligibility: DeliveryEligibility;
  readonly remote_authorized: boolean;
  readonly push_status: "NOT_STARTED" | "PUSHING" | "PUSHED" | "FAILED";
  readonly pushed_sha: string | null;
  readonly pr_status: "NOT_STARTED" | "CREATING" | "READY" | "FAILED";
  readonly pr_number: number | null;
  readonly pr_url: string | null;
  readonly head_branch: string;
  readonly base_branch: string;
  readonly delivery_revision: number;
  readonly obsidian_synced: boolean;
  readonly notified: boolean;
  readonly completed: boolean;
  readonly running_step: DeliveryStep | null;
  readonly last_error: string | null;
  readonly created_at: string;
  readonly updated_at: string;
}

export interface DeliveryStore {
  load(taskId: string): Promise<DeliveryState | undefined>;
  save(state: DeliveryState, expectedRevision: number | null): Promise<void>;
}

export interface DeliveryPorts {
  readonly eligibility: {
    evaluate(request: DeliveryRequest): Promise<{
      readonly status: DeliveryEligibility;
      readonly failures?: readonly string[];
      readonly token?: {
        readonly task_id: string;
        readonly project_id: string;
        readonly repository_identity: string;
        readonly candidate_sha: string;
        readonly head_branch: string;
        readonly base_branch: string;
        readonly manifest_revision: number;
        readonly digest: string;
      };
    }>;
  };
  readonly candidate: {
    assertCurrentAndClean(candidateSha: string): Promise<void>;
  };
  readonly remote: {
    /** Must inspect/reuse an already-pushed identical ref; force push is not exposed. */
    ensureTaskBranchPushed(input: {
      readonly task_id: string;
      readonly candidate_sha: string;
      readonly head_branch: string;
      readonly base_branch: string;
      readonly idempotency_key: string;
      readonly repository_identity: string;
    }): Promise<{ readonly pushed_sha: string }>;
  };
  readonly github: {
    /** Must find and reuse a matching Forge PR before creating one. */
    ensurePullRequest(input: {
      readonly task_id: string;
      readonly candidate_sha: string;
      readonly head_branch: string;
      readonly base_branch: string;
      readonly idempotency_key: string;
      readonly repository_identity: string;
    }): Promise<{ readonly number: number; readonly url: string }>;
  };
  readonly obsidian: {
    /** Writes REVIEW only. This interface deliberately has no DONE operation. */
    ensureReview(input: DeliveryReadyRecord): Promise<void>;
  };
  readonly notifications: {
    /** Delivers only the structured PR_READY event, idempotently. */
    ensureDelivered(
      input: DeliveryReadyRecord & {
        readonly event: "PR_READY";
        readonly idempotency_key: string;
      },
    ): Promise<void>;
  };
}

interface DeliveryReadyRecord {
  readonly task_id: string;
  readonly candidate_sha: string;
  readonly pr_number: number;
  readonly pr_url: string;
}

const FAILURE_BY_STEP: Readonly<Record<DeliveryStep, string>> = Object.freeze({
  PUSH: "DELIVERY_PUSH_FAILED",
  PR: "DELIVERY_PR_FAILED",
  OBSIDIAN: "DELIVERY_OBSIDIAN_FAILED",
  NOTIFICATION: "DELIVERY_NOTIFICATION_FAILED",
});

export class DeliveryOrchestrator {
  private readonly config: Readonly<TrustedDeliveryConfig>;

  constructor(
    private readonly store: DeliveryStore,
    private readonly ports: DeliveryPorts,
    private readonly now: () => string = () => new Date().toISOString(),
    config: TrustedDeliveryConfig = {
      project_id: "UNCONFIGURED",
      repository_identity: "unconfigured/unconfigured",
      remote_push: false,
      create_pr: false,
      auto_merge: false,
      production_deploy: false,
    },
  ) {
    assertTrustedConfig(config);
    this.config = Object.freeze({ ...config });
  }

  async start(request: DeliveryRequest): Promise<DeliveryState> {
    assertRequest(request);
    if (
      request.project_id !== this.config.project_id ||
      request.repository_identity !== this.config.repository_identity
    )
      throw new Error("DELIVERY_PROJECT_BINDING_MISMATCH");
    if (await this.store.load(request.task_id))
      throw new Error("DELIVERY_ALREADY_INITIALIZED");

    const remoteAuthorized = this.config.remote_push && this.config.create_pr;
    let status: DeliveryEligibility = "NOT_ELIGIBLE";
    let failure: string | null = "REMOTE_DELIVERY_NOT_AUTHORIZED";
    let eligibilityDigest: string | null = null;
    if (remoteAuthorized) {
      try {
        const result = await this.ports.eligibility.evaluate(request);
        if (
          result.status === "ELIGIBLE" &&
          validEligibilityToken(result.token, request)
        ) {
          status = "ELIGIBLE";
          failure = null;
          eligibilityDigest = result.token.digest;
        } else {
          status = "NOT_ELIGIBLE";
          failure =
            result.status === "ELIGIBLE"
              ? "DELIVERY_ELIGIBILITY_PROOF_INVALID"
              : sanitizeEligibilityFailure(result.failures?.[0]);
        }
      } catch {
        failure = "DELIVERY_ELIGIBILITY_FAILED";
      }
      if (status === "ELIGIBLE") {
        try {
          await this.ports.candidate.assertCurrentAndClean(
            request.candidate_sha,
          );
        } catch {
          status = "NOT_ELIGIBLE";
          failure = "DELIVERY_CANDIDATE_INVALID";
          eligibilityDigest = null;
        }
      }
    }
    const at = this.now();
    const state: DeliveryState = Object.freeze({
      schema_version: "1",
      task_id: request.task_id,
      revision: 0,
      candidate_sha: request.candidate_sha,
      project_id: this.config.project_id,
      repository_identity: this.config.repository_identity,
      manifest_revision: request.manifest_revision,
      eligibility_digest: eligibilityDigest,
      eligibility: status,
      remote_authorized: remoteAuthorized,
      push_status: "NOT_STARTED",
      pushed_sha: null,
      pr_status: "NOT_STARTED",
      pr_number: null,
      pr_url: null,
      head_branch: request.head_branch,
      base_branch: request.base_branch,
      delivery_revision: 0,
      obsidian_synced: false,
      notified: false,
      completed: false,
      running_step: null,
      last_error: failure,
      created_at: at,
      updated_at: at,
    });
    await this.store.save(state, null);
    return state;
  }

  async resume(taskId: string): Promise<DeliveryState> {
    let state = await this.requireState(taskId);
    if (
      state.project_id !== this.config.project_id ||
      state.repository_identity !== this.config.repository_identity
    )
      throw new Error("DELIVERY_PROJECT_BINDING_MISMATCH");
    if (state.eligibility === "ELIGIBLE" && !state.eligibility_digest)
      throw new Error("DELIVERY_ELIGIBILITY_PROOF_INVALID");
    if (state.completed || state.eligibility !== "ELIGIBLE") return state;
    try {
      await this.ports.candidate.assertCurrentAndClean(state.candidate_sha);
    } catch {
      state = await this.checkpoint(state, {
        eligibility: "NOT_ELIGIBLE",
        last_error: "DELIVERY_CANDIDATE_INVALID",
        running_step: null,
      });
      throw new Error("DELIVERY_CANDIDATE_INVALID");
    }

    if (state.push_status !== "PUSHED") {
      state = await this.claim(state, "PUSH");
      try {
        const pushed = await this.ports.remote.ensureTaskBranchPushed({
          task_id: state.task_id,
          candidate_sha: state.candidate_sha,
          head_branch: state.head_branch,
          base_branch: state.base_branch,
          idempotency_key: key(state, "push"),
          repository_identity: state.repository_identity,
        });
        if (pushed.pushed_sha !== state.candidate_sha)
          throw new Error("PUSHED_CANDIDATE_MISMATCH");
        state = await this.checkpoint(state, {
          push_status: "PUSHED",
          pushed_sha: pushed.pushed_sha,
          running_step: null,
        });
      } catch {
        await this.fail(state, "PUSH");
        throw stableFailure("PUSH");
      }
    }

    if (state.pr_status !== "READY") {
      state = await this.claim(state, "PR");
      try {
        const pr = await this.ports.github.ensurePullRequest({
          task_id: state.task_id,
          candidate_sha: state.candidate_sha,
          head_branch: state.head_branch,
          base_branch: state.base_branch,
          idempotency_key: key(state, "pr"),
          repository_identity: state.repository_identity,
        });
        assertPr(pr);
        state = await this.checkpoint(state, {
          pr_status: "READY",
          pr_number: pr.number,
          pr_url: pr.url,
          running_step: null,
        });
      } catch {
        await this.fail(state, "PR");
        throw stableFailure("PR");
      }
    }

    const ready = readyRecord(state);
    if (!state.obsidian_synced) {
      state = await this.claim(state, "OBSIDIAN");
      try {
        await this.ports.obsidian.ensureReview(ready);
        state = await this.checkpoint(state, {
          obsidian_synced: true,
          running_step: null,
        });
      } catch {
        await this.fail(state, "OBSIDIAN");
        throw stableFailure("OBSIDIAN");
      }
    }

    if (!state.notified) {
      state = await this.claim(state, "NOTIFICATION");
      try {
        await this.ports.notifications.ensureDelivered({
          ...ready,
          event: "PR_READY",
          idempotency_key: key(state, "notification"),
        });
        state = await this.checkpoint(state, {
          notified: true,
          completed: true,
          running_step: null,
        });
      } catch {
        await this.fail(state, "NOTIFICATION");
        throw stableFailure("NOTIFICATION");
      }
    }
    return state;
  }

  private async requireState(taskId: string): Promise<DeliveryState> {
    const state = await this.store.load(taskId);
    if (!state) throw new Error("DELIVERY_NOT_INITIALIZED");
    return state;
  }

  private claim(
    state: DeliveryState,
    step: DeliveryStep,
  ): Promise<DeliveryState> {
    const patch =
      step === "PUSH"
        ? { push_status: "PUSHING" as const }
        : step === "PR"
          ? { pr_status: "CREATING" as const }
          : {};
    return this.checkpoint(state, {
      ...patch,
      running_step: step,
      last_error: null,
    });
  }

  private async fail(state: DeliveryState, step: DeliveryStep): Promise<void> {
    const patch =
      step === "PUSH"
        ? { push_status: "FAILED" as const }
        : step === "PR"
          ? { pr_status: "FAILED" as const }
          : {};
    await this.checkpoint(state, {
      ...patch,
      running_step: null,
      last_error: FAILURE_BY_STEP[step],
    });
  }

  private async checkpoint(
    state: DeliveryState,
    patch: Partial<DeliveryState>,
  ): Promise<DeliveryState> {
    const next = Object.freeze({
      ...state,
      ...patch,
      revision: state.revision + 1,
      delivery_revision: state.delivery_revision + 1,
      updated_at: this.now(),
    });
    await this.store.save(next, state.revision);
    return next;
  }
}

function assertRequest(request: DeliveryRequest): void {
  if (
    !Number.isSafeInteger(request.manifest_revision) ||
    request.manifest_revision < 0
  )
    throw new Error("INVALID_MANIFEST_REVISION");
  if (!/^[a-f0-9]{40,64}$/.test(request.candidate_sha))
    throw new Error("INVALID_DELIVERY_CANDIDATE");
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(request.task_id))
    throw new Error("INVALID_DELIVERY_TASK");
  for (const branch of [request.head_branch, request.base_branch]) {
    if (
      !/^[A-Za-z0-9][A-Za-z0-9._/-]{0,199}$/.test(branch) ||
      branch.includes("..")
    )
      throw new Error("INVALID_DELIVERY_BRANCH");
  }
  if (request.head_branch === request.base_branch)
    throw new Error("PROTECTED_BRANCH_PUSH_REJECTED");
}

function assertTrustedConfig(config: TrustedDeliveryConfig): void {
  if (config.auto_merge || config.production_deploy)
    throw new Error("DELIVERY_SAFETY_FLOOR_VIOLATION");
  if (
    !/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(config.project_id) ||
    !/^[A-Za-z0-9._-]+\/[A-Za-z0-9._-]+$/.test(config.repository_identity)
  )
    throw new Error("INVALID_TRUSTED_DELIVERY_CONFIG");
}

function validEligibilityToken(
  token:
    | {
        readonly task_id: string;
        readonly project_id: string;
        readonly repository_identity: string;
        readonly candidate_sha: string;
        readonly head_branch: string;
        readonly base_branch: string;
        readonly manifest_revision: number;
        readonly digest: string;
      }
    | undefined,
  request: DeliveryRequest,
): token is {
  readonly task_id: string;
  readonly project_id: string;
  readonly repository_identity: string;
  readonly candidate_sha: string;
  readonly head_branch: string;
  readonly base_branch: string;
  readonly manifest_revision: number;
  readonly digest: string;
} {
  return (
    token?.task_id === request.task_id &&
    token.project_id === request.project_id &&
    token.repository_identity === request.repository_identity &&
    token.candidate_sha === request.candidate_sha &&
    token.head_branch === request.head_branch &&
    token.base_branch === request.base_branch &&
    token.manifest_revision === request.manifest_revision &&
    /^[a-f0-9]{64}$/.test(token.digest)
  );
}

function readyRecord(state: DeliveryState): DeliveryReadyRecord {
  if (state.pr_number === null || state.pr_url === null)
    throw new Error("DELIVERY_PR_NOT_READY");
  return {
    task_id: state.task_id,
    candidate_sha: state.candidate_sha,
    pr_number: state.pr_number,
    pr_url: state.pr_url,
  };
}

function assertPr(pr: { readonly number: number; readonly url: string }): void {
  if (!Number.isSafeInteger(pr.number) || pr.number <= 0)
    throw new Error("INVALID_PR_METADATA");
  const url = new URL(pr.url);
  if (url.protocol !== "https:" || url.username || url.password)
    throw new Error("INVALID_PR_METADATA");
}

function key(state: DeliveryState, operation: string): string {
  return `${state.task_id}:${state.candidate_sha}:${state.head_branch}:${operation}`;
}

function sanitizeEligibilityFailure(value: string | undefined): string {
  return value && /^[A-Z][A-Z0-9_]{0,127}$/.test(value)
    ? value
    : "RELEASE_NOT_ELIGIBLE";
}

function stableFailure(step: DeliveryStep): Error {
  return new Error(FAILURE_BY_STEP[step]);
}
