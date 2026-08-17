import {
  GRAPHIFY_GRAPH_PATH,
  GRAPHIFY_MISSING_ACTION,
  GraphifyMetadataSchema,
  type GraphifyStatusResult,
} from "../../kernel/src/graphify.js";
import { GraphifyAdapter } from "../../adapters/src/graphify-adapter.js";

export class GraphifyService {
  constructor(private readonly adapter: GraphifyAdapter) {}

  async inspect(): Promise<GraphifyStatusResult> {
    const probe = await this.adapter.probe();
    if (probe.status === "UNAVAILABLE" || probe.status === "INVALID")
      return probe;
    return this.adapter.status();
  }

  async refresh(): Promise<GraphifyStatusResult> {
    const before = await this.adapter.status();
    if (before.status === "INVALID") return before;
    const probe = await this.adapter.probe();
    if (probe.status === "UNAVAILABLE" || probe.status === "INVALID")
      return probe;
    if (before.status === "MISSING") {
      try {
        const headBefore = await this.adapter.head();
        const guardBefore = await this.adapter.mutationGuard();
        await this.adapter.validateConfiguredGraph(GRAPHIFY_GRAPH_PATH);
        await this.adapter.update();
        const headAfter = await this.adapter.head();
        if (headAfter !== headBefore)
          throw new Error(
            "Repository HEAD changed during initial Graphify update",
          );
        const guardAfter = await this.adapter.mutationGuard();
        if (guardAfter !== guardBefore)
          throw new Error("Graphify update modified production files");
        await this.adapter.validateConfiguredGraph(GRAPHIFY_GRAPH_PATH);
        await this.adapter.writeMetadata(
          GraphifyMetadataSchema.parse({
            schema_version: "1",
            graph_path: GRAPHIFY_GRAPH_PATH,
            indexed_commit: headAfter,
            graphify_version: (probe.reason ?? "unknown")
              .replace(/^graphify\s+/iu, "")
              .trim(),
            indexed_at: new Date().toISOString(),
          }),
        );
        return this.adapter.status();
      } catch (error) {
        return {
          status: "MISSING",
          reason:
            error instanceof Error
              ? error.message
              : "Graphify index cannot be adopted",
          action: GRAPHIFY_MISSING_ACTION(this.adapter.repository),
        };
      }
    }
    const graphPath = before.metadata?.graph_path ?? GRAPHIFY_GRAPH_PATH;
    let metadataBefore: string;
    try {
      metadataBefore = await this.adapter.readMetadataSource();
    } catch (error) {
      return {
        status: "INVALID",
        reason:
          error instanceof Error ? error.message : "Invalid Graphify metadata",
      };
    }
    let headBefore: string;
    let guardBefore: string;
    try {
      headBefore = await this.adapter.head();
      guardBefore = await this.adapter.mutationGuard();
      await this.adapter.update();
    } catch (error) {
      await this.adapter.restoreMetadata(metadataBefore);
      return {
        status: "UNAVAILABLE",
        reason:
          error instanceof Error ? error.message : "Graphify update failed",
      };
    }
    try {
      const headAfter = await this.adapter.head();
      if (headAfter !== headBefore)
        throw new Error("Repository HEAD changed during Graphify update");
      const guardAfter = await this.adapter.mutationGuard();
      if (guardAfter !== guardBefore)
        throw new Error("Graphify update modified production files");
      await this.adapter.validateConfiguredGraph(graphPath);
      const version = probe.reason ?? "unknown";
      await this.adapter.writeMetadata(
        GraphifyMetadataSchema.parse({
          schema_version: "1",
          graph_path: graphPath,
          indexed_commit: headAfter,
          graphify_version: version.replace(/^graphify\s+/iu, "").trim(),
          indexed_at: new Date().toISOString(),
        }),
      );
      return this.adapter.status();
    } catch (error) {
      await this.adapter.restoreMetadata(metadataBefore);
      return {
        status: "INVALID",
        reason:
          error instanceof Error ? error.message : "Invalid Graphify update",
      };
    }
  }
}
