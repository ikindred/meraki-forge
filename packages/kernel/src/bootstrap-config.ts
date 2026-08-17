import { parse } from "yaml";
import { z } from "zod";
import { PERSONAS, TaskModeSchema, deepFreeze } from "./contracts.js";

const NonEmptySchema = z.string().trim().min(1);
const AbsolutePathSchema = NonEmptySchema.refine(
  (value) => value.startsWith("/") || /^[A-Za-z]:[\\/]/.test(value),
  "Path must be absolute",
);
const RelativeContainedPathSchema = NonEmptySchema.refine(
  (value) =>
    !value.startsWith("/") &&
    !/^[A-Za-z]:[\\/]/.test(value) &&
    !value.replaceAll("\\", "/").split("/").includes(".."),
  "Path must be a contained relative path",
);

export const ProjectBootstrapConfigSchema = z
  .object({
    id: z.string().regex(/^[a-z0-9][a-z0-9-]*$/),
    name: NonEmptySchema,
    repository_path: AbsolutePathSchema,
    repository_identity: NonEmptySchema.refine((value) => {
      if (
        /(?:gh[pousr]_[A-Za-z0-9]{20,}|AKIA[0-9A-Z]{16}|-----BEGIN [A-Z ]*PRIVATE KEY-----|(?:token|password|passwd|secret)\s*[=:]|^[^/\s]+:[^@\s]+@)/iu.test(
          value,
        )
      )
        return false;
      try {
        const url = new URL(value);
        return !url.username && !url.password;
      } catch {
        return !/^[a-z][a-z0-9+.-]*:\/\//iu.test(value);
      }
    }, "Repository identity must not contain credentials"),
    default_branch: z
      .string()
      .regex(/^(?![./])(?!.*(?:\.\.|[~^:?*[\]\\]))[^\s]+$/),
    stack_profile: NonEmptySchema,
  })
  .strict()
  .readonly();

export const ForgeBootstrapConfigSchema = z
  .object({
    schema_version: z.literal("1"),
    project: ProjectBootstrapConfigSchema,
    obsidian: z
      .object({
        vault_path: AbsolutePathSchema,
        command_center_path: RelativeContainedPathSchema,
      })
      .strict()
      .readonly(),
    delivery: z
      .object({
        remote_push: z.boolean().default(false),
        create_pr: z.boolean().default(false),
        auto_merge: z.literal(false).default(false),
        production_deploy: z.literal(false).default(false),
      })
      .strict()
      .readonly(),
    autonomy: z
      .object({
        allowed_risk: z.enum(["LOW", "MEDIUM", "HIGH"]),
        modes: z.array(TaskModeSchema).min(1),
      })
      .strict()
      .readonly(),
    evidence: z
      .object({
        ui_video_required: z.boolean(),
        screenshots_required: z.boolean(),
        responsive_viewports: z
          .array(z.string().regex(/^[1-9]\d{1,4}x[1-9]\d{1,4}$/))
          .min(1),
      })
      .strict()
      .readonly(),
  })
  .strict()
  .readonly();
export type ForgeBootstrapConfig = z.infer<typeof ForgeBootstrapConfigSchema>;

export const SecretReferenceSchema = z
  .object({
    source: z.enum(["environment", "keychain", "secret-manager"]),
    key: z.string().regex(/^[A-Za-z][A-Za-z0-9_./:-]{1,255}$/),
  })
  .strict()
  .readonly();

const McpOperationSchema = z.enum([
  "READ",
  "QUERY",
  "SCHEMA_INTROSPECTION",
  "MUTATE",
  "DESTRUCTIVE",
]);
const McpProviderSchema = z
  .object({
    id: z.string().regex(/^[a-z0-9][a-z0-9-]*$/),
    server: NonEmptySchema,
    environment: z.enum(["development", "test", "staging", "production"]),
    capabilities: z.array(McpOperationSchema),
    secret: SecretReferenceSchema,
    persona_grants: z.array(
      z
        .object({
          persona: z.enum(PERSONAS),
          operations: z.array(McpOperationSchema).min(1),
          approval: z.enum(["NONE", "HUMAN_EACH_USE"]),
        })
        .strict()
        .readonly(),
    ),
  })
  .strict()
  .superRefine((provider, ctx) => {
    if (new Set(provider.capabilities).size !== provider.capabilities.length)
      ctx.addIssue({
        code: "custom",
        path: ["capabilities"],
        message: "Duplicate capabilities",
      });
    if (provider.capabilities.includes("DESTRUCTIVE"))
      ctx.addIssue({
        code: "custom",
        path: ["capabilities"],
        message: "Destructive MCP operations are outside autonomous authority",
      });
    if (
      provider.environment === "production" &&
      provider.capabilities.includes("MUTATE")
    )
      ctx.addIssue({
        code: "custom",
        path: ["capabilities"],
        message: "Production MCP is read-only",
      });
    const personas = new Set<string>();
    provider.persona_grants.forEach((grant, index) => {
      if (personas.has(grant.persona))
        ctx.addIssue({
          code: "custom",
          path: ["persona_grants", index, "persona"],
          message: "Duplicate persona grant",
        });
      personas.add(grant.persona);
      for (const operation of grant.operations)
        if (!provider.capabilities.includes(operation))
          ctx.addIssue({
            code: "custom",
            path: ["persona_grants", index, "operations"],
            message: "Operation is not declared by provider",
          });
      if (grant.operations.includes("DESTRUCTIVE"))
        ctx.addIssue({
          code: "custom",
          path: ["persona_grants", index, "operations"],
          message: "Destructive MCP operations are forbidden",
        });
      if (
        grant.operations.includes("MUTATE") &&
        grant.approval !== "HUMAN_EACH_USE"
      )
        ctx.addIssue({
          code: "custom",
          path: ["persona_grants", index, "approval"],
          message: "Mutation requires human approval for every use",
        });
      if (
        provider.environment === "production" &&
        grant.operations.includes("MUTATE")
      )
        ctx.addIssue({
          code: "custom",
          path: ["persona_grants", index, "operations"],
          message: "Production MCP is read-only",
        });
    });
  })
  .readonly();

export const McpCapabilitiesConfigSchema = z
  .object({
    schema_version: z.literal("1"),
    providers: z.array(McpProviderSchema),
  })
  .strict()
  .superRefine((config, ctx) => {
    const ids = new Set<string>();
    config.providers.forEach((provider, index) => {
      if (ids.has(provider.id))
        ctx.addIssue({
          code: "custom",
          path: ["providers", index, "id"],
          message: "Duplicate provider id",
        });
      ids.add(provider.id);
    });
  })
  .readonly();

export function authorizeMcpOperation(
  configInput: unknown,
  request: Readonly<{
    provider_id: string;
    persona: (typeof PERSONAS)[number];
    operation: z.infer<typeof McpOperationSchema>;
  }>,
): Readonly<{ allowed: boolean; reason: string; approval_required: boolean }> {
  const config = McpCapabilitiesConfigSchema.parse(configInput);
  const provider = config.providers.find(
    (item) => item.id === request.provider_id,
  );
  if (!provider)
    return Object.freeze({
      allowed: false,
      reason: "UNKNOWN_PROVIDER",
      approval_required: false,
    });
  const grant = provider.persona_grants.find(
    (item) => item.persona === request.persona,
  );
  if (!grant || !grant.operations.includes(request.operation))
    return Object.freeze({
      allowed: false,
      reason: "DEFAULT_DENY",
      approval_required: false,
    });
  if (
    request.operation === "DESTRUCTIVE" ||
    (provider.environment === "production" && request.operation === "MUTATE")
  )
    return Object.freeze({
      allowed: false,
      reason: "SAFETY_FLOOR",
      approval_required: false,
    });
  return Object.freeze({
    allowed: true,
    reason: "EXPLICIT_GRANT",
    approval_required: request.operation === "MUTATE",
  });
}

export function parseBootstrapConfigYaml(source: string): ForgeBootstrapConfig {
  if (Buffer.byteLength(source, "utf8") > 1024 * 1024)
    throw new Error("Bootstrap configuration exceeds 1 MiB");
  const document: unknown = parse(source, {
    maxAliasCount: 0,
    uniqueKeys: true,
  });
  assertBoundedDocument(document);
  return deepFreeze(ForgeBootstrapConfigSchema.parse(document));
}

function assertBoundedDocument(value: unknown, depth = 0): void {
  if (depth > 32)
    throw new Error("Bootstrap configuration is too deeply nested");
  if (Array.isArray(value)) {
    if (value.length > 10_000)
      throw new Error("Bootstrap configuration contains too many items");
    for (const item of value) assertBoundedDocument(item, depth + 1);
    return;
  }
  if (value && typeof value === "object") {
    const entries = Object.entries(value);
    if (entries.length > 10_000)
      throw new Error("Bootstrap configuration contains too many fields");
    for (const [key, item] of entries) {
      if (["__proto__", "prototype", "constructor"].includes(key))
        throw new Error("Unsafe configuration key");
      assertBoundedDocument(item, depth + 1);
    }
  }
}
