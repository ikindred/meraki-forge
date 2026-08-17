import { parse } from "yaml";
import { z } from "zod";

const ContainedPathSchema = z
  .string()
  .min(1)
  .refine(
    (value) =>
      !value.startsWith("/") &&
      !/^[A-Za-z]:[\\/]/u.test(value) &&
      !value.replaceAll("\\", "/").split("/").includes(".."),
    "Graph path must be repository-relative and contained",
  );

export const GraphifyMetadataSchema = z
  .object({
    schema_version: z.literal("1"),
    graph_path: ContainedPathSchema,
    indexed_commit: z.string().regex(/^[0-9a-f]{40}$/u),
    graphify_version: z.string().trim().min(1),
    indexed_at: z.iso.datetime(),
  })
  .strict()
  .readonly();

export type GraphifyMetadata = z.infer<typeof GraphifyMetadataSchema>;
export const GRAPHIFY_METADATA_PATH = ".forge/graphify.yml";
export const GRAPHIFY_GRAPH_PATH = "graphify-out/graph.json";
export const GRAPHIFY_MISSING_ACTION = (repository: string): string =>
  `Initialize Graphify manually in ${repository}, then rerun forge graph refresh.`;

export type GraphifyStatus =
  "CURRENT" | "STALE" | "MISSING" | "UNAVAILABLE" | "INVALID";

export type GraphifyStatusResult = Readonly<{
  status: GraphifyStatus;
  head?: string;
  metadata?: GraphifyMetadata;
  reason?: string;
  action?: string;
}>;

export function parseGraphifyMetadataYaml(source: string): GraphifyMetadata {
  if (Buffer.byteLength(source, "utf8") > 64 * 1024)
    throw new Error("Graphify metadata exceeds 64 KiB");
  return GraphifyMetadataSchema.parse(
    parse(source, { maxAliasCount: 0, uniqueKeys: true }),
  );
}
