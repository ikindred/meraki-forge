import { createHash } from "node:crypto";
import type { Persona } from "./contracts.js";

export interface GraphNode {
  readonly id: string;
  readonly dependencies: readonly string[];
  readonly status:
    "PENDING" | "RUNNABLE" | "RUNNING" | "BLOCKED" | "COMPLETED" | "FAILED";
}

export interface DependencyNode extends GraphNode {
  readonly persona_id: Persona;
  readonly request_id: string;
  readonly required_output: string;
}

export function runnableNodes<T extends GraphNode>(
  nodes: readonly T[],
  dispatched: ReadonlySet<string> = new Set(),
): readonly T[] {
  const completed = new Set(
    nodes.filter((node) => node.status === "COMPLETED").map((node) => node.id),
  );
  return [...nodes]
    .filter(
      (node) =>
        (node.status === "PENDING" || node.status === "RUNNABLE") &&
        !dispatched.has(node.id) &&
        node.dependencies.every((id) => completed.has(id)),
    )
    .sort((a, b) => a.id.localeCompare(b.id));
}

function hasPath(
  nodes: readonly GraphNode[],
  from: string,
  to: string,
): boolean {
  const byId = new Map(nodes.map((node) => [node.id, node]));
  const seen = new Set<string>();
  const visit = (id: string): boolean => {
    if (id === to) return true;
    if (seen.has(id)) return false;
    seen.add(id);
    return byId.get(id)?.dependencies.some(visit) ?? false;
  };
  return visit(from);
}

export function addDependencyEdge<T extends GraphNode>(
  nodes: readonly T[],
  nodeId: string,
  dependencyId: string,
): readonly T[] {
  if (nodeId === dependencyId || hasPath(nodes, dependencyId, nodeId))
    throw new Error("Dependency edge would create cycle");
  if (
    !nodes.some((node) => node.id === nodeId) ||
    !nodes.some((node) => node.id === dependencyId)
  )
    throw new Error("Dependency edge references unknown node");
  return nodes.map((node) =>
    node.id === nodeId && !node.dependencies.includes(dependencyId)
      ? { ...node, dependencies: [...node.dependencies, dependencyId].sort() }
      : node,
  );
}

type DependencyMessage = {
  readonly kind: "DEPENDENCY_REQUEST";
  readonly id: string;
  readonly payload: {
    readonly requested_owner: Persona;
    readonly required_output: string;
  };
};

export function createDependencyNode(
  message: DependencyMessage,
): DependencyNode {
  return Object.freeze({
    id: `dependency-${createHash("sha256").update(message.id).digest("hex").slice(0, 16)}`,
    persona_id: message.payload.requested_owner,
    request_id: message.id,
    required_output: message.payload.required_output,
    dependencies: [],
    status: "PENDING",
  });
}

export function routeDependencyMessage(
  message: DependencyMessage,
  requesterNodeId: string,
  nodes: readonly GraphNode[],
) {
  if (!nodes.some((node) => node.id === requesterNodeId))
    throw new Error("Dependency requester node is unknown");
  return Object.freeze({
    blocked_node_id: requesterNodeId,
    specialist_node: createDependencyNode(message),
  });
}
