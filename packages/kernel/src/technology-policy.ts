import { deepFreeze } from "./contracts.js";

export const PROJECT_TYPES = [
  "frontend",
  "backend",
  "full-stack",
  "mobile",
  "database",
  "ai-integrations",
] as const;
export type ProjectType = (typeof PROJECT_TYPES)[number];

export interface TechnologyRequirements {
  readonly project_type: ProjectType;
  readonly scale?: "small" | "medium" | "large";
  readonly integrations?: readonly string[];
  readonly existing_ecosystem?: readonly string[];
  readonly deployment_model?:
    "serverless" | "container" | "managed" | "on-premise";
  readonly required_client?: "web" | "mobile" | "api" | "none";
  readonly security_sensitivity?: "standard" | "high";
  readonly maintenance_priority?: "standard" | "low-operations";
}

export interface TechnologyDecision {
  readonly policy_version: "1";
  readonly project_type: ProjectType;
  readonly stack: readonly string[];
  readonly rationale: readonly string[];
  readonly requires_human_approval: boolean;
}

const DEFAULTS: Readonly<Record<ProjectType, readonly string[]>> = deepFreeze({
  frontend: ["Next.js", "React", "TypeScript"],
  backend: ["Node.js", "TypeScript", "PostgreSQL"],
  "full-stack": ["Next.js", "React", "TypeScript", "PostgreSQL"],
  mobile: ["Flutter", "Dart"],
  database: ["PostgreSQL"],
  "ai-integrations": ["Node.js", "TypeScript", "PostgreSQL"],
});

/** Deterministic policy only: it recommends technology but grants no authority. */
export function recommendTechnology(
  requirements: TechnologyRequirements,
): TechnologyDecision {
  if (!PROJECT_TYPES.includes(requirements.project_type))
    throw new Error("Unsupported project type");
  const ecosystem = (requirements.existing_ecosystem ?? []).map((item) =>
    item.trim().toLowerCase(),
  );
  let stack = [...DEFAULTS[requirements.project_type]];
  const rationale = [
    `Approved ${requirements.project_type} baseline selected by policy version 1.`,
  ];
  if (
    ["backend", "full-stack"].includes(requirements.project_type) &&
    ecosystem.some((item) => item === "php" || item === "laravel")
  ) {
    stack =
      requirements.project_type === "backend"
        ? ["Laravel", "PHP", "PostgreSQL"]
        : ["Laravel", "PHP", "React", "TypeScript", "PostgreSQL"];
    rationale.push(
      "Existing Laravel/PHP ecosystem takes precedence over the default backend runtime.",
    );
  }
  if (requirements.security_sensitivity === "high")
    rationale.push(
      "High security sensitivity requires an explicit architecture review.",
    );
  if (requirements.deployment_model === "on-premise")
    rationale.push(
      "On-premise deployment requires an explicit operations review.",
    );
  return deepFreeze({
    policy_version: "1",
    project_type: requirements.project_type,
    stack,
    rationale,
    requires_human_approval:
      requirements.security_sensitivity === "high" ||
      requirements.deployment_model === "on-premise",
  });
}
