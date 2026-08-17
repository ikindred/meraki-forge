import { describe, expect, it } from "vitest";
import {
  McpCapabilitiesConfigSchema,
  authorizeMcpOperation,
} from "../packages/kernel/src/index.js";

describe("governed MCP capability configuration", () => {
  it("is default deny when no persona grants are configured", () => {
    const config = McpCapabilitiesConfigSchema.parse({
      schema_version: "1",
      providers: [
        {
          id: "dev-db",
          server: "provider-neutral-db",
          environment: "development",
          capabilities: ["READ", "QUERY"],
          secret: { source: "environment", key: "DEV_DATABASE_URL" },
          persona_grants: [],
        },
      ],
    });
    expect(config.providers[0]?.persona_grants).toEqual([]);
    expect(
      authorizeMcpOperation(config, {
        provider_id: "dev-db",
        persona: "frontend-engineer",
        operation: "READ",
      }),
    ).toMatchObject({ allowed: false, reason: "DEFAULT_DENY" });
  });

  it("allows explicit read-only persona grants", () => {
    const config = McpCapabilitiesConfigSchema.parse({
      schema_version: "1",
      providers: [
        {
          id: "dev-db",
          server: "database-mcp",
          environment: "development",
          capabilities: ["READ", "QUERY", "SCHEMA_INTROSPECTION"],
          secret: { source: "environment", key: "DEV_DATABASE_URL" },
          persona_grants: [
            {
              persona: "backend-engineer",
              operations: ["READ", "QUERY"],
              approval: "NONE",
            },
          ],
        },
      ],
    });
    expect(config.providers[0]?.persona_grants[0]?.operations).toEqual([
      "READ",
      "QUERY",
    ]);
    expect(
      authorizeMcpOperation(config, {
        provider_id: "dev-db",
        persona: "backend-engineer",
        operation: "READ",
      }),
    ).toMatchObject({ allowed: true, approval_required: false });
  });

  it("rejects plaintext secrets and undeclared operations", () => {
    const base = {
      schema_version: "1",
      providers: [
        {
          id: "db",
          server: "database-mcp",
          environment: "development",
          capabilities: ["READ"],
          secret: "postgres://user:password@host/db",
          persona_grants: [],
        },
      ],
    };
    expect(() => McpCapabilitiesConfigSchema.parse(base)).toThrow();
    expect(() =>
      McpCapabilitiesConfigSchema.parse({
        ...base,
        providers: [
          {
            ...base.providers[0],
            secret: { source: "environment", key: "DATABASE_URL" },
            persona_grants: [
              {
                persona: "backend-engineer",
                operations: ["QUERY"],
                approval: "NONE",
              },
            ],
          },
        ],
      }),
    ).toThrow();
  });

  it("forbids production mutation and destructive autonomous operations", () => {
    expect(() =>
      McpCapabilitiesConfigSchema.parse({
        schema_version: "1",
        providers: [
          {
            id: "prod-db",
            server: "database-mcp",
            environment: "production",
            capabilities: ["READ", "MUTATE"],
            secret: { source: "environment", key: "PROD_DATABASE_URL" },
            persona_grants: [
              {
                persona: "database-architect",
                operations: ["MUTATE"],
                approval: "HUMAN_EACH_USE",
              },
            ],
          },
        ],
      }),
    ).toThrow();
    expect(() =>
      McpCapabilitiesConfigSchema.parse({
        schema_version: "1",
        providers: [
          {
            id: "dev-db",
            server: "database-mcp",
            environment: "development",
            capabilities: ["DESTRUCTIVE"],
            secret: { source: "environment", key: "DEV_DATABASE_URL" },
            persona_grants: [],
          },
        ],
      }),
    ).toThrow();
  });
});
