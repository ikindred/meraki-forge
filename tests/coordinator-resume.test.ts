/* eslint-disable @typescript-eslint/require-await */
import { describe, expect, it } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  EngineeringCoordinator,
  type AgentDispatcher,
  type ChangeCollector,
  type CoordinatorManifest,
  type CoordinatorState,
  type CoordinatorStore,
  type DispatchRecord,
} from "../packages/execution/src/coordinator.js";
import {
  ForgeMessageSchema,
  type OwnershipRule,
} from "../packages/kernel/src/index.js";
import { DurableCoordinatorStore } from "../packages/execution/src/durable-coordinator-store.js";

class MemoryStore implements CoordinatorStore {
  saves = 0;
  constructor(public state: CoordinatorState) {}
  async load() {
    return structuredClone(this.state);
  }
  async save(state: CoordinatorState, expectedRevision: number) {
    if (this.state.revision !== expectedRevision)
      throw new Error("revision conflict");
    this.state = structuredClone(state);
    this.saves += 1;
  }
}
class FakeDispatcher implements AgentDispatcher {
  records: DispatchRecord[] = [];
  async dispatch(record: DispatchRecord) {
    this.records.push(record);
    return { output_ref: `output:${record.execution_node_id}` };
  }
}
class FakeChanges implements ChangeCollector {
  queue: string[][] = [];
  rejected = 0;
  async captureBaseline() {
    return "baseline";
  }
  async collectChangedPaths() {
    return { paths: this.queue.shift() ?? [], candidate_commit: "candidate" };
  }
  async rejectChanges() {
    this.rejected += 1;
  }
  async acceptChanges() {
    return "accepted-candidate";
  }
}
const ownership: readonly OwnershipRule[] = [
  { pattern: "src/frontend/**", owner: "frontend-engineer", effect: "allow" },
  { pattern: "src/backend/**", owner: "backend-engineer", effect: "allow" },
];
const manifest: CoordinatorManifest = {
  task_id: "MF-2",
  revision: 1,
  worktree: "/tmp/worktree",
  stack_profile: { evidence: [] },
  acceptance_criteria: [{ id: "AC-1", text: "works" }],
  nodes: [
    {
      id: "frontend",
      persona_id: "frontend-engineer",
      grant: ["src/frontend/**"],
      dependencies: [],
      status: "PENDING",
    },
    {
      id: "backend",
      persona_id: "backend-engineer",
      grant: ["src/backend/**"],
      dependencies: ["frontend"],
      status: "PENDING",
    },
  ],
};
function initial(): CoordinatorState {
  return {
    schema_version: "1",
    task_id: "MF-2",
    revision: 0,
    manifest_revision: 1,
    lease_id: "lease",
    lease_owner: "coordinator",
    lease_until: "2026-08-11T01:00:00.000Z",
    heartbeat_at: "2026-08-11T00:00:00.000Z",
    worktree: "/tmp/worktree",
    nodes: manifest.nodes,
    messages: [],
    events: [],
    candidate_commit: null,
    blocker_reason: null,
  };
}

describe("resumable coordinator", () => {
  it("persists one completed node and a separate invocation skips it", async () => {
    const store = new MemoryStore(initial());
    const dispatcher = new FakeDispatcher();
    const changes = new FakeChanges();
    changes.queue.push(["src/frontend/a.ts"], ["src/backend/a.ts"]);
    expect(
      await new EngineeringCoordinator(
        store,
        dispatcher,
        changes,
        ownership,
        () => "2026-08-11T00:00:00.000Z",
      ).tick("MF-2", "lease", "coordinator", manifest),
    ).toBe("PROGRESSED");
    expect(
      store.state.nodes.find((node) => node.id === "frontend")?.status,
    ).toBe("COMPLETED");
    expect(
      await new EngineeringCoordinator(
        store,
        dispatcher,
        changes,
        ownership,
        () => "2026-08-11T00:01:00.000Z",
      ).tick("MF-2", "lease", "coordinator", manifest),
    ).toBe("PROGRESSED");
    expect(
      dispatcher.records.map((record) => record.execution_node_id),
    ).toEqual(["frontend", "backend"]);
    expect(
      await new EngineeringCoordinator(
        store,
        dispatcher,
        changes,
        ownership,
        () => "2026-08-11T00:02:00.000Z",
      ).tick("MF-2", "lease", "coordinator", manifest),
    ).toBe("COMPLETE");
  });
  it("routes a real boundary violation to the expected specialist then resumes the dependent", async () => {
    const onlyFrontend: CoordinatorManifest = {
      ...manifest,
      nodes: [manifest.nodes[0]!],
    };
    const store = new MemoryStore({ ...initial(), nodes: onlyFrontend.nodes });
    const dispatcher = new FakeDispatcher();
    const changes = new FakeChanges();
    changes.queue.push(
      ["src/backend/payment.ts"],
      ["src/backend/payment.ts"],
      ["src/frontend/a.ts"],
    );
    const coordinator = new EngineeringCoordinator(
      store,
      dispatcher,
      changes,
      ownership,
      () => "2026-08-11T00:00:00.000Z",
    );
    expect(
      await coordinator.tick("MF-2", "lease", "coordinator", onlyFrontend),
    ).toBe("PROGRESSED");
    expect(changes.rejected).toBe(1);
    expect(store.state.messages[0]?.kind).toBe("DEPENDENCY_REQUEST");
    expect(
      await coordinator.tick("MF-2", "lease", "coordinator", onlyFrontend),
    ).toBe("PROGRESSED");
    expect(dispatcher.records[1]?.persona_id).toBe("backend-engineer");
    expect(
      await coordinator.tick("MF-2", "lease", "coordinator", onlyFrontend),
    ).toBe("PROGRESSED");
    expect(
      store.state.nodes.find((node) => node.id === "frontend")?.status,
    ).toBe("COMPLETED");
  });
  it("does not duplicate an in-flight dispatch after a crash", async () => {
    const store = new MemoryStore({
      ...initial(),
      nodes: [
        { ...manifest.nodes[0]!, status: "RUNNING", dispatch_id: "existing" },
      ],
    });
    const dispatcher = new FakeDispatcher();
    const result = await new EngineeringCoordinator(
      store,
      dispatcher,
      new FakeChanges(),
      ownership,
      () => "2026-08-11T00:00:00.000Z",
    ).tick("MF-2", "lease", "coordinator", manifest);
    expect(result).toBe("BLOCKED");
    expect(dispatcher.records).toHaveLength(0);
  });
  it("stops when the durable lease does not match", async () => {
    const dispatcher = new FakeDispatcher();
    expect(
      await new EngineeringCoordinator(
        new MemoryStore(initial()),
        dispatcher,
        new FakeChanges(),
        ownership,
        () => "2026-08-11T00:00:00.000Z",
      ).tick("MF-2", "foreign", "coordinator", manifest),
    ).toBe("LEASE_LOST");
    expect(dispatcher.records).toHaveLength(0);
  });
  it("stops on an expired lease or mismatched manifest before dispatch", async () => {
    const dispatcher = new FakeDispatcher();
    const expired = new MemoryStore({
      ...initial(),
      lease_until: "2026-08-10T00:00:00.000Z",
    });
    const coordinator = new EngineeringCoordinator(
      expired,
      dispatcher,
      new FakeChanges(),
      ownership,
      () => "2026-08-11T00:00:00.000Z",
    );
    expect(
      await coordinator.tick("MF-2", "lease", "coordinator", manifest),
    ).toBe("LEASE_LOST");
    const active = new EngineeringCoordinator(
      new MemoryStore(initial()),
      dispatcher,
      new FakeChanges(),
      ownership,
      () => "2026-08-11T00:00:00.000Z",
    );
    expect(
      await active.tick("MF-2", "lease", "coordinator", {
        ...manifest,
        worktree: "/wrong",
      }),
    ).toBe("BLOCKED");
    expect(dispatcher.records).toHaveLength(0);
  });
  it("cleans and blocks when a dispatcher crashes", async () => {
    const store = new MemoryStore(initial());
    const changes = new FakeChanges();
    const dispatcher: AgentDispatcher = {
      dispatch: async () => {
        throw new Error("crash");
      },
    };
    expect(
      await new EngineeringCoordinator(
        store,
        dispatcher,
        changes,
        ownership,
        () => "2026-08-11T00:00:00.000Z",
      ).tick("MF-2", "lease", "coordinator", manifest),
    ).toBe("BLOCKED");
    expect(changes.rejected).toBe(1);
    expect(store.state.blocker_reason).toContain("crash");
  });
  it("resumes from canonical disk state across separate store/coordinator instances", async () => {
    const root = await mkdtemp(join(tmpdir(), "forge-coordinator-disk-"));
    const dispatcher = new FakeDispatcher();
    const changes = new FakeChanges();
    changes.queue.push(["src/frontend/a.ts"], ["src/backend/a.ts"]);
    try {
      const firstStore = new DurableCoordinatorStore(root);
      await firstStore.initialize(initial());
      expect(
        await new EngineeringCoordinator(
          firstStore,
          dispatcher,
          changes,
          ownership,
          () => "2026-08-11T00:00:00.000Z",
        ).tick("MF-2", "lease", "coordinator", manifest),
      ).toBe("PROGRESSED");
      const secondStore = new DurableCoordinatorStore(root);
      expect(
        await new EngineeringCoordinator(
          secondStore,
          dispatcher,
          changes,
          ownership,
          () => "2026-08-11T00:01:00.000Z",
        ).tick("MF-2", "lease", "coordinator", manifest),
      ).toBe("PROGRESSED");
      expect(
        dispatcher.records.map((record) => record.execution_node_id),
      ).toEqual(["frontend", "backend"]);
    } finally {
      await rm(root, { recursive: true });
    }
  });
  it.each([
    "CONTRACT_CHANGE_REQUEST",
    "SEMANTIC_CONFLICT",
    "BLOCKER_REPORT",
  ] as const)("persists and blocks on returned %s", async (kind) => {
    const store = new MemoryStore(initial());
    const changes = new FakeChanges();
    changes.queue.push(["src/frontend/a.ts"]);
    const base = {
      schema_version: "1" as const,
      id: `M-${kind}`,
      task_id: "MF-2",
      run_id: "lease",
      from: "frontend-engineer" as const,
      to: "engineering-coordinator" as const,
      created_at: "2026-08-11T00:00:00.000Z",
    };
    const message =
      kind === "CONTRACT_CHANGE_REQUEST"
        ? ForgeMessageSchema.parse({
            ...base,
            kind,
            payload: {
              reason: "change",
              affected_paths: [],
              blocking: true,
              proposed_revision: 2,
              change: "contract",
            },
          })
        : kind === "SEMANTIC_CONFLICT"
          ? ForgeMessageSchema.parse({
              ...base,
              kind,
              payload: {
                reason: "conflict",
                affected_paths: [],
                blocking: true,
                alternatives: ["A", "B"],
              },
            })
          : ForgeMessageSchema.parse({
              ...base,
              kind,
              payload: {
                reason: "blocked",
                affected_paths: [],
                blocking: true,
                recommended_action: "human",
              },
            });
    const dispatcher: AgentDispatcher = {
      dispatch: async () => ({ output_ref: "out", contracts: [message] }),
    };
    expect(
      await new EngineeringCoordinator(
        store,
        dispatcher,
        changes,
        ownership,
        () => "2026-08-11T00:00:00.000Z",
      ).tick("MF-2", "lease", "coordinator", manifest),
    ).toBe("BLOCKED");
    expect(store.state.messages[0]?.kind).toBe(kind);
  });
  it("rejects integration-agent authored production changes regardless of self-label", async () => {
    const integrationManifest: CoordinatorManifest = {
      ...manifest,
      nodes: [
        {
          id: "integrate",
          persona_id: "integration-agent",
          grant: ["package-lock.json"],
          dependencies: [],
          status: "PENDING",
        },
      ],
    };
    const accepted = new MemoryStore({
      ...initial(),
      nodes: integrationManifest.nodes,
    });
    const changes = new FakeChanges();
    changes.queue.push(["package-lock.json"]);
    const mechanical: AgentDispatcher = {
      dispatch: async () => ({
        output_ref: "integrated",
        integration_changes: [
          { path: "package-lock.json", kind: "LOCKFILE_REGENERATION" },
        ],
      }),
    };
    expect(
      await new EngineeringCoordinator(
        accepted,
        mechanical,
        changes,
        ownership,
        () => "2026-08-11T00:00:00.000Z",
      ).tick("MF-2", "lease", "coordinator", integrationManifest),
    ).toBe("BLOCKED");
    expect(changes.rejected).toBe(1);
    const rejected = new MemoryStore({
      ...initial(),
      nodes: integrationManifest.nodes,
    });
    const unsafeChanges = new FakeChanges();
    unsafeChanges.queue.push(["src/product.ts"]);
    const semantic: AgentDispatcher = {
      dispatch: async () => ({ output_ref: "bad" }),
    };
    expect(
      await new EngineeringCoordinator(
        rejected,
        semantic,
        unsafeChanges,
        ownership,
        () => "2026-08-11T00:00:00.000Z",
      ).tick("MF-2", "lease", "coordinator", integrationManifest),
    ).toBe("BLOCKED");
    expect(unsafeChanges.rejected).toBe(1);
  });
});
