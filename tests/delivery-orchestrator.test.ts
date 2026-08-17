import { describe, expect, it } from "vitest";
import {
  DeliveryOrchestrator,
  type DeliveryPorts,
  type DeliveryRequest,
  type DeliveryState,
  type DeliveryStore,
  type TrustedDeliveryConfig,
} from "../packages/execution/src/delivery-orchestrator.js";

class MemoryStore implements DeliveryStore {
  state?: DeliveryState;
  load() {
    return Promise.resolve(this.state);
  }
  save(state: DeliveryState, expected: number | null) {
    expect(this.state?.revision ?? null).toBe(expected);
    this.state = state;
    return Promise.resolve();
  }
}
const request: DeliveryRequest = {
  task_id: "TASK-4",
  candidate_sha: "a".repeat(40),
  project_id: "meraki-forge",
  repository_identity: "kindred/meraki-forge",
  manifest_revision: 4,
  head_branch: "forge/task-4",
  base_branch: "main",
};
const config: TrustedDeliveryConfig = {
  project_id: request.project_id,
  repository_identity: request.repository_identity,
  remote_push: true,
  create_pr: true,
  auto_merge: false,
  production_deploy: false,
};
function fixture(overrides: Partial<DeliveryPorts> = {}) {
  const calls = { push: 0, pr: 0, sync: 0, notify: 0 };
  const ports: DeliveryPorts = {
    eligibility: {
      evaluate: () =>
        Promise.resolve({
          status: "ELIGIBLE",
          token: {
            task_id: request.task_id,
            project_id: request.project_id,
            repository_identity: request.repository_identity,
            candidate_sha: request.candidate_sha,
            head_branch: request.head_branch,
            base_branch: request.base_branch,
            manifest_revision: request.manifest_revision,
            digest: "d".repeat(64),
          },
        }),
    },
    candidate: { assertCurrentAndClean: () => Promise.resolve() },
    remote: {
      ensureTaskBranchPushed: () => {
        calls.push++;
        return Promise.resolve({ pushed_sha: request.candidate_sha });
      },
    },
    github: {
      ensurePullRequest: () => {
        calls.pr++;
        return Promise.resolve({
          number: 42,
          url: "https://github.com/acme/forge/pull/42",
        });
      },
    },
    obsidian: {
      ensureReview: () => {
        calls.sync++;
        return Promise.resolve();
      },
    },
    notifications: {
      ensureDelivered: () => {
        calls.notify++;
        return Promise.resolve();
      },
    },
    ...overrides,
  };
  return { ports, calls };
}
describe("delivery orchestrator", () => {
  it("takes remote authority only from trusted default-deny config", async () => {
    const store = new MemoryStore();
    const { ports, calls } = fixture();
    const orchestrator = new DeliveryOrchestrator(store, ports, undefined, {
      ...config,
      remote_push: false,
      create_pr: false,
    });
    const malicious = {
      ...request,
      autonomous_delivery_authorized: true,
      policy: { remote_push: true, create_pr: true },
    } as DeliveryRequest;
    await expect(orchestrator.start(malicious)).resolves.toMatchObject({
      remote_authorized: false,
      last_error: "REMOTE_DELIVERY_NOT_AUTHORIZED",
    });
    expect(calls).toEqual({ push: 0, pr: 0, sync: 0, notify: 0 });
  });
  it("rejects unsafe trusted floors before eligibility", () => {
    const { ports } = fixture();
    expect(
      () =>
        new DeliveryOrchestrator(new MemoryStore(), ports, undefined, {
          ...config,
          auto_merge: true,
        } as unknown as TrustedDeliveryConfig),
    ).toThrow("DELIVERY_SAFETY_FLOOR_VIOLATION");
  });
  it("fails closed on cross-project or repository identity mismatch", async () => {
    for (const mismatch of [
      { project_id: "other" },
      { repository_identity: "attacker/repo" },
    ]) {
      const { ports, calls } = fixture();
      const orchestrator = new DeliveryOrchestrator(
        new MemoryStore(),
        ports,
        undefined,
        config,
      );
      await expect(
        orchestrator.start({ ...request, ...mismatch }),
      ).rejects.toThrow("DELIVERY_PROJECT_BINDING_MISMATCH");
      expect(calls).toEqual({ push: 0, pr: 0, sync: 0, notify: 0 });
    }
  });
  it("persists proof binding and completes REVIEW delivery idempotently", async () => {
    const store = new MemoryStore();
    const { ports, calls } = fixture();
    const orchestrator = new DeliveryOrchestrator(
      store,
      ports,
      () => "2026-08-17T00:00:00.000Z",
      config,
    );
    await expect(orchestrator.start(request)).resolves.toMatchObject({
      project_id: config.project_id,
      repository_identity: config.repository_identity,
      eligibility_digest: "d".repeat(64),
    });
    await orchestrator.resume(request.task_id);
    await orchestrator.resume(request.task_id);
    expect(store.state).toMatchObject({
      push_status: "PUSHED",
      pr_status: "READY",
      obsidian_synced: true,
      notified: true,
      completed: true,
    });
    expect(calls).toEqual({ push: 1, pr: 1, sync: 1, notify: 1 });
    expect("merge" in ports.github).toBe(false);
    expect("deploy" in ports).toBe(false);
  });
  it("recovers after partial failures without repeating completed effects", async () => {
    const store = new MemoryStore();
    let fail = true;
    const { ports, calls } = fixture({
      github: {
        ensurePullRequest: () => {
          calls.pr++;
          if (fail) {
            fail = false;
            return Promise.reject(new Error("token=secret"));
          }
          return Promise.resolve({
            number: 7,
            url: "https://github.com/acme/forge/pull/7",
          });
        },
      },
    });
    const orchestrator = new DeliveryOrchestrator(
      store,
      ports,
      undefined,
      config,
    );
    await orchestrator.start(request);
    await expect(orchestrator.resume(request.task_id)).rejects.toThrow(
      "DELIVERY_PR_FAILED",
    );
    expect(JSON.stringify(store.state)).not.toContain("secret");
    await expect(orchestrator.resume(request.task_id)).resolves.toMatchObject({
      completed: true,
    });
    expect(calls).toEqual({ push: 1, pr: 2, sync: 1, notify: 1 });
  });
  it("does not deliver missing or invalid eligibility proof", async () => {
    for (const eligibility of [
      { status: "NOT_ELIGIBLE" as const, failures: ["PROOF_INCOMPLETE"] },
      {
        status: "ELIGIBLE" as const,
        token: {
          task_id: "other",
          project_id: request.project_id,
          repository_identity: request.repository_identity,
          candidate_sha: request.candidate_sha,
          head_branch: request.head_branch,
          base_branch: request.base_branch,
          manifest_revision: request.manifest_revision,
          digest: "d".repeat(64),
        },
      },
    ]) {
      const store = new MemoryStore();
      const { ports, calls } = fixture({
        eligibility: { evaluate: () => Promise.resolve(eligibility) },
      });
      const orchestrator = new DeliveryOrchestrator(
        store,
        ports,
        undefined,
        config,
      );
      await expect(orchestrator.start(request)).resolves.toMatchObject({
        eligibility: "NOT_ELIGIBLE",
      });
      expect(calls).toEqual({ push: 0, pr: 0, sync: 0, notify: 0 });
    }
  });
});
