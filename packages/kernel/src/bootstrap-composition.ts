import type { Persona } from "./contracts.js";
import { deepFreeze } from "./contracts.js";
import { normalizeRepoPath, type OwnershipRule } from "./ownership.js";
import {
  composePersona,
  type PersonaDefinition,
  type RuntimePersona,
} from "./personas.js";
import type { StackProfile } from "./stack.js";

export interface OwnershipCandidate {
  readonly pattern: string;
  readonly owner: Persona;
  readonly evidence: readonly string[];
}
export interface OwnershipAmbiguity {
  readonly pattern: string;
  readonly reason:
    "AMBIGUOUS_OWNER" | "INSUFFICIENT_EVIDENCE" | "UNSAFE_PATTERN";
  readonly proposed_owners: readonly Persona[];
}
export interface OwnershipProposal {
  readonly default_effect: "deny";
  readonly rules: readonly OwnershipRule[];
  readonly ambiguities: readonly OwnershipAmbiguity[];
}

function safeNarrowPattern(pattern: string): boolean {
  try {
    const normalized = normalizeRepoPath(pattern);
    return (
      normalized === pattern.replaceAll("\\", "/") &&
      normalized.endsWith("/**") &&
      normalized !== "**" &&
      normalized.slice(0, -3).length > 0
    );
  } catch {
    return false;
  }
}

export function proposeOwnership(
  candidates: readonly OwnershipCandidate[],
): OwnershipProposal {
  const grouped = new Map<string, OwnershipCandidate[]>();
  for (const candidate of candidates)
    grouped.set(candidate.pattern, [
      ...(grouped.get(candidate.pattern) ?? []),
      candidate,
    ]);
  const rules: OwnershipRule[] = [];
  const ambiguities: OwnershipAmbiguity[] = [];
  for (const [pattern, entries] of [...grouped].sort(([a], [b]) =>
    a.localeCompare(b),
  )) {
    const owners = [...new Set(entries.map((entry) => entry.owner))].sort();
    const hasEvidence = entries.every((entry) => entry.evidence.length > 0);
    const reason = !safeNarrowPattern(pattern)
      ? "UNSAFE_PATTERN"
      : !hasEvidence
        ? "INSUFFICIENT_EVIDENCE"
        : owners.length !== 1
          ? "AMBIGUOUS_OWNER"
          : undefined;
    if (reason) {
      ambiguities.push({ pattern, reason, proposed_owners: owners });
      continue;
    }
    const owner = owners[0];
    if (owner) rules.push({ pattern, owner, effect: "allow" });
  }
  return deepFreeze({ default_effect: "deny", rules, ambiguities });
}

const ROLE_LABELS: Partial<Record<Persona, string>> = {
  "frontend-engineer": "Frontend Engineer",
  "backend-engineer": "Backend Engineer",
  "mobile-engineer": "Mobile Engineer",
  "database-architect": "Database Architect",
};

export function composeBootstrapPersona(
  definition: PersonaDefinition,
  stack: StackProfile,
  projectGrant: readonly string[],
  taskScope: readonly string[],
): RuntimePersona {
  const runtime = composePersona(definition, stack, projectGrant, taskScope);
  const expertise = runtime.expertise.join(" / ");
  const role = ROLE_LABELS[definition.role] ?? definition.title;
  return deepFreeze({
    ...runtime,
    title: expertise ? `Principal ${expertise} ${role}` : definition.title,
    // Authority is copied exclusively from the existing ownership intersection.
    write_grant: [...runtime.write_grant],
  });
}
