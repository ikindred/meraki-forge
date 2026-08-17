import { createHash } from "node:crypto";
import {
  ForgeMessageSchema,
  createDependencyRequests,
  validateExecutionBoundary,
  type OwnershipRule,
  type Persona,
} from "../../kernel/src/index.js";
import type { z } from "zod";
import { z as zod } from "zod";
type ForgeMessage = z.infer<typeof ForgeMessageSchema>;

export type ExecutionNodeStatus =
  "PENDING" | "RUNNING" | "COMPLETED" | "BLOCKED" | "REJECTED";
export interface CoordinatorNode {
  readonly id: string;
  readonly persona_id: Persona;
  readonly grant: readonly string[];
  readonly dependencies: readonly string[];
  readonly status: ExecutionNodeStatus;
  readonly dispatch_id?: string | undefined;
  readonly output_ref?: string | undefined;
}
export interface CoordinatorManifest {
  readonly task_id: string;
  readonly revision: number;
  readonly worktree: string;
  readonly stack_profile: unknown;
  readonly acceptance_criteria: readonly {
    readonly id: string;
    readonly text: string;
  }[];
  readonly nodes: readonly CoordinatorNode[];
}
export interface CoordinatorEvent {
  readonly id: string;
  readonly type: string;
  readonly node_id?: string | undefined;
  readonly at: string;
  readonly detail: string;
}
export interface CoordinatorState {
  readonly schema_version: "1";
  readonly task_id: string;
  readonly revision: number;
  readonly manifest_revision: number;
  readonly lease_id: string;
  readonly lease_owner: string;
  readonly lease_until: string;
  readonly heartbeat_at: string;
  readonly worktree: string;
  readonly nodes: readonly CoordinatorNode[];
  readonly messages: readonly ForgeMessage[];
  readonly events: readonly CoordinatorEvent[];
  readonly candidate_commit: string | null;
  readonly blocker_reason: string | null;
}
const CoordinatorNodeSchema = zod.object({
  id: zod.string(),
  persona_id: zod.enum([
    "forge-director",
    "engineering-coordinator",
    "architect",
    "frontend-engineer",
    "backend-engineer",
    "mobile-engineer",
    "database-architect",
    "uiux-designer",
    "qa-engineer",
    "security-auditor",
    "accessibility-auditor",
    "code-reviewer",
    "integration-agent",
    "evidence-agent",
    "release-agent",
  ]),
  grant: zod.array(zod.string()),
  dependencies: zod.array(zod.string()),
  status: zod.enum(["PENDING", "RUNNING", "COMPLETED", "BLOCKED", "REJECTED"]),
  dispatch_id: zod.string().optional(),
  output_ref: zod.string().optional(),
});
export const CoordinatorStateSchema: zod.ZodType<CoordinatorState> = zod.object(
  {
    schema_version: zod.literal("1"),
    task_id: zod.string(),
    revision: zod.number().int().nonnegative(),
    manifest_revision: zod.number().int().nonnegative(),
    lease_id: zod.string(),
    lease_owner: zod.string(),
    lease_until: zod.string().datetime(),
    heartbeat_at: zod.string().datetime(),
    worktree: zod.string(),
    nodes: zod.array(CoordinatorNodeSchema),
    messages: zod.array(ForgeMessageSchema),
    events: zod.array(
      zod.object({
        id: zod.string(),
        type: zod.string(),
        node_id: zod.string().optional(),
        at: zod.string(),
        detail: zod.string(),
      }),
    ),
    candidate_commit: zod.string().nullable(),
    blocker_reason: zod.string().nullable(),
  },
);
export interface CoordinatorStore {
  load(taskId: string): Promise<CoordinatorState>;
  save(state: CoordinatorState, expectedRevision: number): Promise<void>;
}
export interface DispatchResult {
  readonly output_ref: string;
  readonly contracts?: readonly ForgeMessage[];
  readonly integration_changes?: readonly {
    readonly path: string;
    readonly kind:
      | "CONFLICT_MARKER_RESOLUTION"
      | "LOCKFILE_REGENERATION"
      | "IMPORT_ORDERING"
      | "FORMATTING"
      | "PRODUCT_BEHAVIOR"
      | "CONTRACT_CHANGE"
      | "BUSINESS_LOGIC";
  }[];
}
export const AgentResultSchema = zod
  .object({
    output_ref: zod.string().min(1),
    contracts: zod.array(ForgeMessageSchema).optional(),
    integration_changes: zod
      .array(
        zod.object({
          path: zod.string(),
          kind: zod.enum([
            "CONFLICT_MARKER_RESOLUTION",
            "LOCKFILE_REGENERATION",
            "IMPORT_ORDERING",
            "FORMATTING",
            "PRODUCT_BEHAVIOR",
            "CONTRACT_CHANGE",
            "BUSINESS_LOGIC",
          ]),
        }),
      )
      .optional(),
  })
  .strict();
export interface AgentDispatcher {
  dispatch(record: DispatchRecord): Promise<DispatchResult>;
}
export interface DispatchRecord {
  readonly task_id: string;
  readonly persona_id: Persona;
  readonly execution_node_id: string;
  readonly dispatch_id: string;
  readonly manifest_revision: number;
  readonly allowed_ownership_scope: readonly string[];
  readonly repository_worktree_path: string;
  readonly stack_profile: unknown;
  readonly relevant_contracts: readonly ForgeMessage[];
  readonly acceptance_criteria: readonly {
    readonly id: string;
    readonly text: string;
  }[];
  readonly dependencies: readonly string[];
  readonly expected_output_schema: string;
  readonly stop_conditions: readonly string[];
}
export interface ChangeCollector {
  captureBaseline(worktree: string, grant: readonly string[]): Promise<string>;
  collectChangedPaths(
    worktree: string,
    baseline: string,
  ): Promise<{
    readonly paths: readonly string[];
    readonly candidate_commit: string;
  }>;
  rejectChanges(worktree: string, baseline: string): Promise<void>;
  acceptChanges(
    worktree: string,
    baseline: string,
    nodeId: string,
  ): Promise<string>;
}
export type CoordinatorStop =
  "PROGRESSED" | "COMPLETE" | "BLOCKED" | "NO_RUNNABLE_NODES" | "LEASE_LOST";

function event(
  type: string,
  at: string,
  detail: string,
  nodeId?: string,
): CoordinatorEvent {
  return {
    id: createHash("sha256")
      .update(`${type}:${at}:${detail}:${nodeId ?? ""}`)
      .digest("hex")
      .slice(0, 20),
    type,
    at,
    detail,
    ...(nodeId ? { node_id: nodeId } : {}),
  };
}
function replaceNode(
  nodes: readonly CoordinatorNode[],
  id: string,
  update: Partial<CoordinatorNode>,
): readonly CoordinatorNode[] {
  return nodes.map((node) =>
    node.id === id ? Object.freeze({ ...node, ...update }) : node,
  );
}
function runnable(
  nodes: readonly CoordinatorNode[],
): CoordinatorNode | undefined {
  const completed = new Set(
    nodes.filter((node) => node.status === "COMPLETED").map((node) => node.id),
  );
  return [...nodes]
    .filter(
      (node) =>
        node.status === "PENDING" &&
        node.dependencies.every((id) => completed.has(id)),
    )
    .sort((a, b) => a.id.localeCompare(b.id))[0];
}

export class EngineeringCoordinator {
  constructor(
    private readonly store: CoordinatorStore,
    private readonly dispatcher: AgentDispatcher,
    private readonly changes: ChangeCollector,
    private readonly ownership: readonly OwnershipRule[],
    private readonly now: () => string,
  ) {}

  async tick(
    taskId: string,
    leaseId: string,
    leaseOwner: string,
    manifest: CoordinatorManifest,
  ): Promise<CoordinatorStop> {
    const state = await this.store.load(taskId);
    const now = this.now();
    if (
      state.lease_id !== leaseId ||
      state.lease_owner !== leaseOwner ||
      Date.parse(state.lease_until) <= Date.parse(now)
    )
      return "LEASE_LOST";
    if (
      manifest.task_id !== state.task_id ||
      manifest.revision !== state.manifest_revision ||
      manifest.worktree !== state.worktree ||
      manifest.nodes.some(
        (item) =>
          !state.nodes.some(
            (stored) =>
              stored.id === item.id &&
              stored.persona_id === item.persona_id &&
              JSON.stringify(stored.grant) === JSON.stringify(item.grant),
          ),
      )
    )
      return "BLOCKED";
    if (state.blocker_reason) return "BLOCKED";
    const stranded = state.nodes.find((node) => node.status === "RUNNING");
    if (stranded) {
      const next = {
        ...state,
        revision: state.revision + 1,
        nodes: replaceNode(state.nodes, stranded.id, { status: "BLOCKED" }),
        blocker_reason: `Unreconciled dispatch ${stranded.dispatch_id ?? stranded.id}`,
        events: [
          ...state.events,
          event(
            "NODE_BLOCKED",
            this.now(),
            "unreconciled-running-dispatch",
            stranded.id,
          ),
        ],
      };
      await this.store.save(next, state.revision);
      return "BLOCKED";
    }
    const node = runnable(state.nodes);
    if (!node)
      return state.nodes.every((item) => item.status === "COMPLETED")
        ? "COMPLETE"
        : "NO_RUNNABLE_NODES";
    const dispatchId = createHash("sha256")
      .update(`${taskId}:${manifest.revision}:${node.id}`)
      .digest("hex")
      .slice(0, 24);
    if (
      state.events.some(
        (item) => item.type === "NODE_COMPLETED" && item.node_id === node.id,
      )
    )
      return "NO_RUNNABLE_NODES";
    const baseline = await this.changes.captureBaseline(
      state.worktree,
      node.grant,
    );
    const running: CoordinatorState = {
      ...state,
      revision: state.revision + 1,
      nodes: replaceNode(state.nodes, node.id, {
        status: "RUNNING",
        dispatch_id: dispatchId,
      }),
      events: [
        ...state.events,
        event("NODE_DISPATCHED", this.now(), dispatchId, node.id),
      ],
    };
    await this.store.save(running, state.revision);
    const record: DispatchRecord = {
      task_id: taskId,
      persona_id: node.persona_id,
      execution_node_id: node.id,
      dispatch_id: dispatchId,
      manifest_revision: manifest.revision,
      allowed_ownership_scope: node.grant,
      repository_worktree_path: state.worktree,
      stack_profile: manifest.stack_profile,
      relevant_contracts: state.messages,
      acceptance_criteria: manifest.acceptance_criteria,
      dependencies: node.dependencies,
      expected_output_schema: "AgentResult/v1",
      stop_conditions: [
        "BOUNDARY_VIOLATION",
        "DEPENDENCY_REQUIRED",
        "BLOCKED",
        "COMPLETE",
      ],
    };
    let result: DispatchResult;
    try {
      result = AgentResultSchema.parse(
        await this.dispatcher.dispatch(Object.freeze(record)),
      ) as DispatchResult;
    } catch (error) {
      await this.changes.rejectChanges(state.worktree, baseline);
      const blocked: CoordinatorState = {
        ...running,
        revision: running.revision + 1,
        nodes: replaceNode(running.nodes, node.id, { status: "BLOCKED" }),
        blocker_reason: `Dispatch failed: ${error instanceof Error ? error.message : String(error)}`,
        events: [
          ...running.events,
          event(
            "NODE_BLOCKED",
            this.now(),
            "dispatcher-error-cleaned",
            node.id,
          ),
        ],
      };
      await this.store.save(blocked, running.revision);
      return "BLOCKED";
    }
    let changed: Awaited<ReturnType<ChangeCollector["collectChangedPaths"]>>;
    try {
      changed = await this.changes.collectChangedPaths(
        state.worktree,
        baseline,
      );
    } catch (error) {
      await this.changes.rejectChanges(state.worktree, baseline);
      const blocked: CoordinatorState = {
        ...running,
        revision: running.revision + 1,
        nodes: replaceNode(running.nodes, node.id, { status: "BLOCKED" }),
        blocker_reason: `Change collection failed: ${error instanceof Error ? error.message : String(error)}`,
        events: [
          ...running.events,
          event(
            "NODE_BLOCKED",
            this.now(),
            "unsafe-change-set-cleaned",
            node.id,
          ),
        ],
      };
      await this.store.save(blocked, running.revision);
      return "BLOCKED";
    }
    const boundary = validateExecutionBoundary(
      node.persona_id,
      changed.paths,
      this.ownership,
      node.grant,
    );
    if (!boundary.ok) {
      const requests = createDependencyRequests(
        {
          task_id: taskId,
          run_id: leaseId,
          from: node.persona_id,
          created_at: this.now(),
          acceptance_ids: manifest.acceptance_criteria.map(
            (criterion) => criterion.id,
          ),
          required_output:
            "Complete cross-domain changes within the expected owner scope",
        },
        boundary,
      );
      await this.changes.rejectChanges(state.worktree, baseline);
      const dependencyNodes: CoordinatorNode[] = requests.map((request) => ({
        id: `dependency:${request.id}`,
        persona_id: request.payload.requested_owner,
        grant: request.payload.affected_paths,
        dependencies: [],
        status: "PENDING",
      }));
      const dependencyIds = dependencyNodes.map((item) => item.id);
      const routedNodes = replaceNode(running.nodes, node.id, {
        status: requests.length ? "PENDING" : "REJECTED",
        dependencies: [...node.dependencies, ...dependencyIds],
      });
      const rejected: CoordinatorState = {
        ...running,
        revision: running.revision + 1,
        nodes: [...routedNodes, ...dependencyNodes],
        messages: [...running.messages, ...requests],
        blocker_reason: requests.length ? null : "agent-boundary-violation",
        events: [
          ...running.events,
          event(
            "NODE_REJECTED",
            this.now(),
            boundary.violations.map((item) => item.path).join(","),
            node.id,
          ),
          ...requests.map((request) =>
            event("HANDOFF_CREATED", this.now(), request.id, node.id),
          ),
        ],
      };
      await this.store.save(rejected, running.revision);
      return requests.length ? "PROGRESSED" : "BLOCKED";
    }
    const acceptedCommit = await this.changes.acceptChanges(
      state.worktree,
      baseline,
      node.id,
    );
    const returned = result.contracts ?? [];
    const dependencyContracts = returned.filter(
      (
        message,
      ): message is Extract<ForgeMessage, { kind: "DEPENDENCY_REQUEST" }> =>
        message.kind === "DEPENDENCY_REQUEST",
    );
    const blockingContracts = returned.filter(
      (message) =>
        message.kind === "CONTRACT_CHANGE_REQUEST" ||
        message.kind === "SEMANTIC_CONFLICT" ||
        message.kind === "BLOCKER_REPORT",
    );
    if (blockingContracts.length) {
      const blocked: CoordinatorState = {
        ...running,
        revision: running.revision + 1,
        nodes: replaceNode(running.nodes, node.id, {
          status: "BLOCKED",
          output_ref: result.output_ref,
        }),
        messages: [...running.messages, ...returned],
        candidate_commit: acceptedCommit,
        blocker_reason: blockingContracts.map((item) => item.kind).join(","),
        events: [
          ...running.events,
          event(
            "NODE_BLOCKED",
            this.now(),
            "blocking-contract-returned",
            node.id,
          ),
        ],
      };
      await this.store.save(blocked, running.revision);
      return "BLOCKED";
    }
    if (dependencyContracts.length) {
      const dependencyNodes: CoordinatorNode[] = dependencyContracts.map(
        (request) => ({
          id: `dependency:${request.id}`,
          persona_id: request.payload.requested_owner,
          grant: request.payload.affected_paths,
          dependencies: [],
          status: "PENDING",
        }),
      );
      const dependencyIds = dependencyNodes.map((item) => item.id);
      const waiting: CoordinatorState = {
        ...running,
        revision: running.revision + 1,
        nodes: [
          ...replaceNode(running.nodes, node.id, {
            status: "PENDING",
            dependencies: [...node.dependencies, ...dependencyIds],
            output_ref: result.output_ref,
          }),
          ...dependencyNodes,
        ],
        messages: [...running.messages, ...returned],
        candidate_commit: acceptedCommit,
        events: [
          ...running.events,
          ...dependencyContracts.map((request) =>
            event("HANDOFF_CREATED", this.now(), request.id, node.id),
          ),
        ],
      };
      await this.store.save(waiting, running.revision);
      return "PROGRESSED";
    }
    const completed: CoordinatorState = {
      ...running,
      revision: running.revision + 1,
      nodes: replaceNode(running.nodes, node.id, {
        status: "COMPLETED",
        output_ref: result.output_ref,
      }),
      messages: [...running.messages, ...returned],
      candidate_commit: acceptedCommit,
      events: [
        ...running.events,
        event("NODE_COMPLETED", this.now(), result.output_ref, node.id),
      ],
    };
    await this.store.save(completed, running.revision);
    return "PROGRESSED";
  }
}
