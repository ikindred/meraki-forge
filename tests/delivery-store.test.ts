import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  DeliveryStateSchema,
  DurableDeliveryStore,
} from "../packages/execution/src/durable-delivery-store.js";

const state = {
  schema_version: "1" as const,
  task_id: "TASK-4",
  revision: 0,
  candidate_sha: "a".repeat(40),
  project_id: "meraki-forge",
  repository_identity: "kindred/meraki-forge",
  manifest_revision: 4,
  eligibility_digest: "d".repeat(64),
  eligibility: "ELIGIBLE" as const,
  remote_authorized: true,
  push_status: "NOT_STARTED" as const,
  pushed_sha: null,
  pr_status: "NOT_STARTED" as const,
  pr_number: null,
  pr_url: null,
  head_branch: "forge/task-4",
  base_branch: "main",
  delivery_revision: 0,
  obsidian_synced: false,
  notified: false,
  completed: false,
  running_step: null,
  last_error: null,
  created_at: "2026-08-17T00:00:00.000Z",
  updated_at: "2026-08-17T00:00:00.000Z",
};

describe("durable delivery store", () => {
  it("persists strict state in an isolated namespace and enforces CAS", async () => {
    const root = await mkdtemp(join(tmpdir(), "forge-delivery-"));
    const store = new DurableDeliveryStore(root);
    await store.save(state, null);
    await expect(
      store.save({ ...state, revision: 1 }, 0),
    ).resolves.toBeUndefined();
    await expect(store.save({ ...state, revision: 2 }, 0)).rejects.toThrow(
      "State revision conflict",
    );
    expect(await store.load("TASK-4")).toMatchObject({ revision: 1 });
    const raw = await readFile(
      join(root, ".forge/state/delivery/TASK-4.json"),
      "utf8",
    );
    expect(DeliveryStateSchema.parse(JSON.parse(raw))).toMatchObject({
      task_id: "TASK-4",
    });
  });

  it("rejects malformed remote metadata", () => {
    expect(() =>
      DeliveryStateSchema.parse({ ...state, pr_url: "javascript:alert(1)" }),
    ).toThrow();
  });

  it("allows only one concurrent initialization", async () => {
    const root = await mkdtemp(join(tmpdir(), "forge-delivery-race-"));
    const store = new DurableDeliveryStore(root);
    const results = await Promise.allSettled([
      store.save(state, null),
      store.save(state, null),
    ]);
    expect(
      results.filter((result) => result.status === "fulfilled"),
    ).toHaveLength(1);
    expect(
      results.filter((result) => result.status === "rejected"),
    ).toHaveLength(1);
  });
});
