import { describe, expect, it, vi } from "vitest";
import {
  executeMasterQuery,
  type MasterQueryAdapters,
} from "../packages/execution/src/master-query-service.js";

const projects = [
  { project_id: "kyra", display_name: "Kyra", repo_path: "/repos/kyra" },
  { project_id: "dlsu", display_name: "DLSU", repo_path: "/repos/dlsu" },
] as const;

function adapters(
  overrides: Partial<MasterQueryAdapters> = {},
): MasterQueryAdapters {
  return {
    queryGraph: vi.fn(({ projectId }: { projectId: string }) =>
      Promise.resolve({
        status: "CURRENT" as const,
        matches: [{ path: `src/${projectId}.ts`, symbol: "authenticate" }],
      }),
    ),
    verifyLiveSource: vi.fn(({ path }: { path: string }) =>
      Promise.resolve({
        path,
        verified: true,
        excerpt: "export function authenticate() {}",
      }),
    ),
    readProjectContext: vi.fn(({ projectId }: { projectId: string }) =>
      Promise.resolve({
        projectId,
        summary: "READY",
      }),
    ),
    ...overrides,
  };
}

describe("master cross-project query", () => {
  it("allows bounded cross-project reads and verifies graph matches against live source", async () => {
    const io = adapters();
    const result = await executeMasterQuery(
      {
        operation: "READ",
        kind: "CODE",
        query: "compare authentication",
        projects,
        limits: {
          maxProjects: 2,
          maxGraphMatchesPerProject: 3,
          maxExcerptBytes: 100,
        },
      },
      io,
    );
    expect(result.status).toBe("COMPLETE");
    expect(result.projects).toHaveLength(2);
    expect(
      result.projects.every((project) => project.evidence.length === 1),
    ).toBe(true);
    expect(result.projects[0]?.evidence[0]).toMatchObject({
      source: "LIVE_SOURCE",
      graph_path: "src/kyra.ts",
    });
  });

  it("denies cross-project writes before invoking any adapter", async () => {
    const deniedAdapter = (): never => {
      throw new Error("adapter must not be invoked");
    };
    const io = adapters({
      queryGraph: deniedAdapter,
      verifyLiveSource: deniedAdapter,
      readProjectContext: deniedAdapter,
    });
    const result = await executeMasterQuery(
      { operation: "WRITE", kind: "CODE", query: "edit auth", projects },
      io,
    );
    expect(result).toMatchObject({
      status: "DENIED",
      error: { code: "CROSS_PROJECT_WRITE_DENIED" },
    });
  });

  it("uses only explicit read-only degraded policy when Graphify is missing", async () => {
    const missing = adapters({
      queryGraph: vi.fn(() =>
        Promise.resolve({
          status: "MISSING" as const,
          matches: [],
        }),
      ),
      verifyLiveSource: () =>
        Promise.reject(new Error("live scan without Graphify denied")),
    });
    const denied = await executeMasterQuery(
      {
        operation: "READ",
        kind: "CODE",
        query: "auth",
        projects: [projects[0]],
      },
      missing,
    );
    expect(denied).toMatchObject({ status: "BLOCKED", degraded: false });
    expect(denied.projects[0]?.evidence).toEqual([]);

    const degraded = await executeMasterQuery(
      {
        operation: "READ",
        kind: "CODE",
        query: "auth",
        projects: [projects[0]],
        missingGraphPolicy: "CONTEXT_ONLY_READ",
      },
      missing,
    );
    expect(degraded).toMatchObject({ status: "DEGRADED", degraded: true });
    expect(degraded.projects[0]?.warnings[0]).toMatch(/Graphify MISSING/u);
  });

  it("rejects unbounded requests instead of silently truncating project scope", async () => {
    await expect(
      executeMasterQuery(
        {
          operation: "READ",
          kind: "CODE",
          query: "auth",
          projects,
          limits: {
            maxProjects: 1,
            maxGraphMatchesPerProject: 2,
            maxExcerptBytes: 100,
          },
        },
        adapters(),
      ),
    ).rejects.toThrow(/QUERY_PROJECT_LIMIT/u);
  });

  it("rejects escaping Graphify paths before live-source access", async () => {
    const io = adapters({
      queryGraph: () =>
        Promise.resolve({
          status: "CURRENT",
          matches: [{ path: "../other-project/secret.ts" }],
        }),
      verifyLiveSource: () =>
        Promise.reject(new Error("unsafe live-source access")),
    });
    await expect(
      executeMasterQuery(
        {
          operation: "READ",
          kind: "CODE",
          query: "secret",
          projects: [projects[0]],
        },
        io,
      ),
    ).rejects.toThrow(/QUERY_GRAPH_PATH_INVALID/u);
  });
});
