export type QueryProject = Readonly<{
  project_id: string;
  display_name: string;
  repo_path: string;
}>;

export type GraphQueryResult = Readonly<{
  status: "CURRENT" | "STALE" | "MISSING" | "UNAVAILABLE" | "INVALID";
  matches: readonly Readonly<{ path: string; symbol?: string }>[];
}>;

export interface MasterQueryAdapters {
  queryGraph(
    input: Readonly<{ projectId: string; repoPath: string; query: string }>,
  ): Promise<GraphQueryResult>;
  verifyLiveSource(
    input: Readonly<{
      projectId: string;
      repoPath: string;
      path: string;
      query: string;
    }>,
  ): Promise<Readonly<{ path: string; verified: boolean; excerpt: string }>>;
  readProjectContext(
    input: Readonly<{ projectId: string; repoPath: string; query: string }>,
  ): Promise<Readonly<{ projectId: string; summary: string }>>;
}

export type MasterQueryInput = Readonly<{
  operation: "READ" | "WRITE";
  kind: "CODE" | "PROJECT_CONTEXT";
  query: string;
  projects: readonly QueryProject[];
  missingGraphPolicy?: "FAIL_CLOSED" | "CONTEXT_ONLY_READ";
  limits?: Readonly<{
    maxProjects: number;
    maxGraphMatchesPerProject: number;
    maxExcerptBytes: number;
  }>;
}>;

const DEFAULT_LIMITS = Object.freeze({
  maxProjects: 10,
  maxGraphMatchesPerProject: 20,
  maxExcerptBytes: 16 * 1024,
});

export type MasterQueryResult = Readonly<{
  status: "COMPLETE" | "DEGRADED" | "BLOCKED" | "DENIED";
  degraded: boolean;
  projects: readonly Readonly<{
    project_id: string;
    context: Readonly<{ projectId: string; summary: string }>;
    evidence: readonly Readonly<{
      source: "LIVE_SOURCE";
      path: string;
      graph_path: string;
      verified: boolean;
      excerpt: string;
    }>[];
    warnings: readonly string[];
  }>[];
  error?: Readonly<{ code: string; message: string }>;
}>;

function boundedExcerpt(value: string, maxBytes: number): string {
  if (Buffer.byteLength(value, "utf8") <= maxBytes) return value;
  let result = "";
  for (const character of value) {
    if (Buffer.byteLength(result + character, "utf8") > maxBytes) break;
    result += character;
  }
  return result;
}

function assertSafeGraphPath(path: string): void {
  const normalized = path.replaceAll("\\", "/");
  if (
    !path ||
    normalized.startsWith("/") ||
    /^[A-Za-z]:\//u.test(normalized) ||
    normalized.split("/").includes("..") ||
    path.includes("\0")
  )
    throw new Error("QUERY_GRAPH_PATH_INVALID");
}

export async function executeMasterQuery(
  input: MasterQueryInput,
  adapters: MasterQueryAdapters,
): Promise<MasterQueryResult> {
  if (input.operation === "WRITE" && input.projects.length !== 1)
    return Object.freeze({
      status: "DENIED",
      degraded: false,
      projects: Object.freeze([]),
      error: Object.freeze({
        code: "CROSS_PROJECT_WRITE_DENIED",
        message: "Write operations must resolve to exactly one project",
      }),
    });
  if (input.operation === "WRITE")
    return Object.freeze({
      status: "DENIED",
      degraded: false,
      projects: Object.freeze([]),
      error: Object.freeze({
        code: "MASTER_QUERY_WRITE_DENIED",
        message:
          "The master query service is read-only; route writes to the project execution pipeline",
      }),
    });
  const limits = input.limits ?? DEFAULT_LIMITS;
  if (
    !Number.isInteger(limits.maxProjects) ||
    limits.maxProjects < 1 ||
    input.projects.length > limits.maxProjects
  )
    throw new Error("QUERY_PROJECT_LIMIT");
  if (
    !Number.isInteger(limits.maxGraphMatchesPerProject) ||
    limits.maxGraphMatchesPerProject < 1
  )
    throw new Error("QUERY_GRAPH_MATCH_LIMIT_INVALID");
  if (!Number.isInteger(limits.maxExcerptBytes) || limits.maxExcerptBytes < 1)
    throw new Error("QUERY_EXCERPT_LIMIT_INVALID");

  const results: Array<MasterQueryResult["projects"][number]> = [];
  let blocked = false;
  let degraded = false;
  for (const project of input.projects) {
    const context = await adapters.readProjectContext({
      projectId: project.project_id,
      repoPath: project.repo_path,
      query: input.query,
    });
    const warnings: string[] = [];
    const evidence: Array<
      MasterQueryResult["projects"][number]["evidence"][number]
    > = [];
    if (input.kind === "CODE") {
      const graph = await adapters.queryGraph({
        projectId: project.project_id,
        repoPath: project.repo_path,
        query: input.query,
      });
      if (graph.matches.length > limits.maxGraphMatchesPerProject)
        throw new Error(`QUERY_GRAPH_MATCH_LIMIT:${project.project_id}`);
      if (graph.status !== "CURRENT" && graph.status !== "STALE") {
        warnings.push(`Graphify ${graph.status} for ${project.project_id}`);
        if (input.missingGraphPolicy !== "CONTEXT_ONLY_READ") blocked = true;
        else degraded = true;
      } else {
        if (graph.status === "STALE")
          warnings.push(
            `Graphify STALE for ${project.project_id}; all matches require live verification`,
          );
        for (const match of graph.matches) {
          assertSafeGraphPath(match.path);
          const live = await adapters.verifyLiveSource({
            projectId: project.project_id,
            repoPath: project.repo_path,
            path: match.path,
            query: input.query,
          });
          evidence.push(
            Object.freeze({
              source: "LIVE_SOURCE",
              path: live.path,
              graph_path: match.path,
              verified: live.verified,
              excerpt: boundedExcerpt(live.excerpt, limits.maxExcerptBytes),
            }),
          );
        }
      }
    }
    results.push(
      Object.freeze({
        project_id: project.project_id,
        context: Object.freeze(context),
        evidence: Object.freeze(evidence),
        warnings: Object.freeze(warnings),
      }),
    );
  }
  return Object.freeze({
    status: blocked ? "BLOCKED" : degraded ? "DEGRADED" : "COMPLETE",
    degraded: degraded && !blocked,
    projects: Object.freeze(results),
  });
}
