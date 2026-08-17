import { z } from "zod";

const AbsolutePath = z
  .string()
  .min(1)
  .refine((value) => value.startsWith("/"), "Path must be absolute");

export const MasterConfigSchema = z
  .object({
    schema_version: z.literal("1"),
    forge_root: AbsolutePath,
    projects_root: AbsolutePath,
    obsidian_vault: AbsolutePath,
    registry: z
      .object({ path: AbsolutePath, schema_version: z.literal("1") })
      .strict(),
    initialized_at: z.iso.datetime(),
    updated_at: z.iso.datetime(),
    safety: z
      .object({
        auto_merge: z.literal(false),
        production_deploy: z.literal(false),
        cross_project_writes: z.literal(false),
      })
      .strict(),
  })
  .strict()
  .readonly();

export type MasterConfig = z.infer<typeof MasterConfigSchema>;
