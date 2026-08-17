import type { Persona } from "./contracts.js";
import type { StackProfile } from "./stack.js";

export interface PersonaDefinition {
  readonly role: Persona;
  readonly title: string;
  readonly capabilities: readonly string[];
  readonly read_only: boolean;
}
export interface RuntimePersona extends PersonaDefinition {
  readonly expertise: readonly string[];
  readonly write_grant: readonly string[];
}

const PRODUCTION_READ_ONLY_PERSONAS: readonly Persona[] = [
  "forge-director",
  "engineering-coordinator",
  "architect",
  "uiux-designer",
  "qa-engineer",
  "security-auditor",
  "accessibility-auditor",
  "code-reviewer",
  "integration-agent",
  "evidence-agent",
  "release-agent",
];

export function isProductionReadOnlyPersona(persona: Persona): boolean {
  return PRODUCTION_READ_ONLY_PERSONAS.includes(persona);
}

export function composePersona(
  role: PersonaDefinition,
  stack: StackProfile,
  projectGrant: readonly string[],
  taskScope: readonly string[],
): RuntimePersona {
  const scope = new Set(taskScope);
  const readOnly = role.read_only || isProductionReadOnlyPersona(role.role);
  const writeGrant = readOnly
    ? []
    : projectGrant.filter((path) => scope.has(path));
  const expertise = [
    ...new Set(stack.evidence.map((entry) => entry.name)),
  ].sort();
  return Object.freeze({
    ...role,
    read_only: readOnly,
    capabilities: [...role.capabilities],
    expertise,
    write_grant: writeGrant,
  });
}
