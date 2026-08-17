import { z } from "zod";
import { SafeStateStore } from "../../adapters/src/safe-state-store.js";
import type { DeliveryState, DeliveryStore } from "./delivery-orchestrator.js";

const sha = z.string().regex(/^[a-f0-9]{40,64}$/);
const branch = z
  .string()
  .regex(/^[A-Za-z0-9][A-Za-z0-9._/-]{0,199}$/)
  .refine((value) => !value.includes(".."));

export const DeliveryStateSchema: z.ZodType<DeliveryState> = z
  .object({
    schema_version: z.literal("1"),
    task_id: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/),
    revision: z.number().int().nonnegative(),
    candidate_sha: sha,
    project_id: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/),
    repository_identity: z.string().regex(/^[A-Za-z0-9._-]+\/[A-Za-z0-9._-]+$/),
    manifest_revision: z.number().int().nonnegative(),
    eligibility_digest: z
      .string()
      .regex(/^[a-f0-9]{64}$/)
      .nullable(),
    eligibility: z.enum(["ELIGIBLE", "NOT_ELIGIBLE"]),
    remote_authorized: z.boolean(),
    push_status: z.enum(["NOT_STARTED", "PUSHING", "PUSHED", "FAILED"]),
    pushed_sha: sha.nullable(),
    pr_status: z.enum(["NOT_STARTED", "CREATING", "READY", "FAILED"]),
    pr_number: z.number().int().positive().nullable(),
    pr_url: z
      .string()
      .url()
      .startsWith("https://")
      .refine((value) => {
        const url = new URL(value);
        return url.username === "" && url.password === "";
      })
      .nullable(),
    head_branch: branch,
    base_branch: branch,
    delivery_revision: z.number().int().nonnegative(),
    obsidian_synced: z.boolean(),
    notified: z.boolean(),
    completed: z.boolean(),
    running_step: z.enum(["PUSH", "PR", "OBSIDIAN", "NOTIFICATION"]).nullable(),
    last_error: z
      .string()
      .regex(/^[A-Z][A-Z0-9_]{0,127}$/)
      .nullable(),
    created_at: z.string().datetime(),
    updated_at: z.string().datetime(),
  })
  .strict()
  .superRefine((state, context) => {
    if (state.head_branch === state.base_branch)
      context.addIssue({
        code: "custom",
        path: ["head_branch"],
        message: "Task branch must differ from base branch",
      });
    if (
      state.push_status === "PUSHED" &&
      state.pushed_sha !== state.candidate_sha
    )
      context.addIssue({
        code: "custom",
        path: ["pushed_sha"],
        message: "Pushed SHA must match candidate",
      });
    if (
      state.pr_status === "READY" &&
      (state.pr_number === null || state.pr_url === null)
    )
      context.addIssue({
        code: "custom",
        path: ["pr_status"],
        message: "Ready PR requires metadata",
      });
    if (
      state.completed &&
      (!state.obsidian_synced || !state.notified || state.pr_status !== "READY")
    )
      context.addIssue({
        code: "custom",
        path: ["completed"],
        message: "Delivery cannot complete before review sync and notification",
      });
    if (state.eligibility === "ELIGIBLE" && state.eligibility_digest === null)
      context.addIssue({
        code: "custom",
        path: ["eligibility_digest"],
        message: "Eligible delivery requires proof digest",
      });
  });

export class DurableDeliveryStore implements DeliveryStore {
  readonly #store: SafeStateStore<DeliveryState>;

  constructor(repositoryRoot: string) {
    this.#store = new SafeStateStore(
      repositoryRoot,
      DeliveryStateSchema,
      "delivery",
    );
  }

  async load(taskId: string): Promise<DeliveryState | undefined> {
    try {
      return await this.#store.load(taskId);
    } catch (error) {
      if (isMissing(error)) return undefined;
      throw error;
    }
  }

  save(state: DeliveryState, expectedRevision: number | null): Promise<void> {
    return expectedRevision === null
      ? this.#store.save(state.task_id, state, undefined, true)
      : this.#store.save(state.task_id, state, expectedRevision);
  }
}

function isMissing(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    error.code === "ENOENT"
  );
}
