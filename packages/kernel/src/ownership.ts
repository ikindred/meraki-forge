import type { Persona } from "./contracts.js";
import { isProductionReadOnlyPersona } from "./personas.js";

export interface OwnershipRule {
  readonly pattern: string;
  readonly owner: Persona;
  readonly effect: "allow" | "forbid";
}
export interface BoundaryViolation {
  readonly code: "AGENT_BOUNDARY_VIOLATION";
  readonly path: string;
  readonly reason: string;
  readonly expected_owner?: Persona;
}
export interface BoundaryResult {
  readonly ok: boolean;
  readonly violations: readonly BoundaryViolation[];
}

export function normalizeRepoPath(input: string): string {
  if (
    input.includes("\0") ||
    input.startsWith("/") ||
    /^[A-Za-z]:[\\/]/.test(input)
  )
    throw new Error("Path must be repository-relative");
  const normalized = input
    .replaceAll("\\", "/")
    .replace(/^\.\//, "")
    .replace(/\/+/g, "/");
  if (!normalized || normalized.split("/").includes(".."))
    throw new Error("Path escapes repository");
  return normalized;
}
function matches(pattern: string, path: string): boolean {
  const normalized = normalizeRepoPath(pattern);
  if (normalized.endsWith("/**")) {
    const prefix = normalized.slice(0, -3);
    return path === prefix || path.startsWith(`${prefix}/`);
  }
  if (normalized.endsWith("/*")) {
    const prefix = normalized.slice(0, -2);
    return (
      path.startsWith(`${prefix}/`) &&
      !path.slice(prefix.length + 1).includes("/")
    );
  }
  return normalized === path;
}
function specificity(pattern: string): number {
  return (
    pattern.replaceAll("*", "").length + (pattern.includes("*") ? 0 : 10000)
  );
}

export function resolveOwner(
  pathInput: string,
  rules: readonly OwnershipRule[],
): { owner?: Persona; forbidden: boolean; ambiguous: boolean } {
  const path = normalizeRepoPath(pathInput);
  const applicable = rules.filter((rule) => matches(rule.pattern, path));
  if (applicable.some((rule) => rule.effect === "forbid"))
    return { forbidden: true, ambiguous: false };
  const allows = applicable.filter((rule) => rule.effect === "allow");
  if (!allows.length) return { forbidden: false, ambiguous: false };
  const max = Math.max(...allows.map((rule) => specificity(rule.pattern)));
  const owners = [
    ...new Set(
      allows
        .filter((rule) => specificity(rule.pattern) === max)
        .map((rule) => rule.owner),
    ),
  ];
  const owner = owners[0];
  return owners.length === 1 && owner
    ? { owner, forbidden: false, ambiguous: false }
    : { forbidden: false, ambiguous: true };
}

export function validateBoundary(
  persona: Persona,
  changedPaths: readonly string[],
  rules: readonly OwnershipRule[],
  grant: readonly string[],
): BoundaryResult {
  if (isProductionReadOnlyPersona(persona) && changedPaths.length > 0) {
    return Object.freeze({
      ok: false,
      violations: changedPaths.map((path) => ({
        code: "AGENT_BOUNDARY_VIOLATION" as const,
        path,
        reason: "production-read-only-persona",
      })),
    });
  }
  const grantRules: OwnershipRule[] = grant.map((pattern) => ({
    pattern,
    owner: persona,
    effect: "allow",
  }));
  const violations = changedPaths.flatMap((raw): BoundaryViolation[] => {
    let path: string;
    try {
      path = normalizeRepoPath(raw);
    } catch {
      return [
        {
          code: "AGENT_BOUNDARY_VIOLATION",
          path: raw,
          reason: "invalid-or-escaping-path",
        },
      ];
    }
    const configured = resolveOwner(path, rules);
    const assigned = resolveOwner(path, grantRules);
    if (configured.forbidden)
      return [
        { code: "AGENT_BOUNDARY_VIOLATION", path, reason: "forbidden-path" },
      ];
    if (configured.ambiguous)
      return [
        { code: "AGENT_BOUNDARY_VIOLATION", path, reason: "ambiguous-owner" },
      ];
    if (!configured.owner)
      return [
        { code: "AGENT_BOUNDARY_VIOLATION", path, reason: "unowned-path" },
      ];
    if (configured.owner !== persona || assigned.owner !== persona)
      return [
        {
          code: "AGENT_BOUNDARY_VIOLATION",
          path,
          reason: "outside-assignment-grant",
          expected_owner: configured.owner,
        },
      ];
    return [];
  });
  return Object.freeze({ ok: violations.length === 0, violations });
}
