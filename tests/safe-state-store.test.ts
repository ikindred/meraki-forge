import {
  lstat,
  mkdir,
  readFile,
  symlink,
  utimes,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { mkdtemp } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import {
  SafeStateStore,
  StateConflictError,
  StateCorruptionError,
  StateLockError,
  UnsafeTaskIdError,
} from "../packages/adapters/src/safe-state-store.js";

const State = z.object({
  revision: z.number().int().nonnegative(),
  events: z.array(z.string()),
});

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "forge-state-"));
  return { root, store: new SafeStateStore(root, State) };
}

describe("SafeStateStore", () => {
  it("stores schema-valid state beneath the canonical repository state root", async () => {
    const { root, store } = await fixture();
    await store.save("task-1", { revision: 0, events: ["created"] });
    expect(await store.load("task-1")).toEqual({
      revision: 0,
      events: ["created"],
    });
    expect(
      JSON.parse(
        await readFile(join(root, ".forge/state/task-1.json"), "utf8"),
      ),
    ).toEqual({ revision: 0, events: ["created"] });
  });

  it.each(["../escape", "/absolute", "nested/task", "bad\0id", ".", ".."])(
    "rejects unsafe task id %j",
    async (id) => {
      const { store } = await fixture();
      await expect(store.load(id)).rejects.toBeInstanceOf(UnsafeTaskIdError);
    },
  );

  it("rejects a symlinked state root", async () => {
    const { root, store } = await fixture();
    const outside = await mkdtemp(join(tmpdir(), "forge-outside-"));
    await mkdir(join(root, ".forge"));
    await symlink(outside, join(root, ".forge/state"));
    await expect(
      store.save("task", { revision: 0, events: [] }),
    ).rejects.toThrow(/symbolic link/i);
  });

  it("does not follow a symlinked task-state file", async () => {
    const { root, store } = await fixture();
    const outside = join(root, "outside.json");
    await mkdir(join(root, ".forge/state"), { recursive: true });
    await writeFile(
      outside,
      JSON.stringify({ revision: 0, events: ["secret"] }),
    );
    await symlink(outside, join(root, ".forge/state/task.json"));
    await expect(store.load("task")).rejects.toBeInstanceOf(
      StateCorruptionError,
    );
  });

  it("uses revision CAS and preserves prior events", async () => {
    const { store } = await fixture();
    await store.save("task", { revision: 0, events: ["a"] });
    await store.save("task", { revision: 1, events: ["a", "b"] }, 0);
    await expect(
      store.save("task", { revision: 1, events: ["lost"] }, 0),
    ).rejects.toBeInstanceOf(StateConflictError);
    expect((await store.load("task")).events).toEqual(["a", "b"]);
  });

  it("allows only one concurrent writer", async () => {
    const { store } = await fixture();
    await store.save("task", { revision: 0, events: [] });
    const results = await Promise.allSettled([
      store.save("task", { revision: 1, events: ["one"] }, 0),
      store.save("task", { revision: 1, events: ["two"] }, 0),
    ]);
    expect(
      results.filter((result) => result.status === "fulfilled"),
    ).toHaveLength(1);
    expect((await store.load("task")).events).toHaveLength(1);
  });

  it("never steals an active lock and recovers stale locks only explicitly", async () => {
    const { root, store } = await fixture();
    await store.save("task", { revision: 0, events: [] });
    const lock = join(root, ".forge/state/task.lock");
    await writeFile(lock, "active", { flag: "wx" });
    await expect(
      store.save("task", { revision: 1, events: [] }, 0),
    ).rejects.toBeInstanceOf(StateLockError);
    expect(await store.recoverStaleLock("task", 60_000)).toBe(false);
    const old = new Date(Date.now() - 120_000);
    await utimes(lock, old, old);
    expect(await store.recoverStaleLock("task", 60_000)).toBe(true);
    await expect(lstat(lock)).rejects.toMatchObject({ code: "ENOENT" });
    await store.save("task", { revision: 1, events: ["recovered"] }, 0);
  });

  it("reports malformed JSON and schema-invalid state as corruption", async () => {
    const { root, store } = await fixture();
    await mkdir(join(root, ".forge/state"), { recursive: true });
    await writeFile(join(root, ".forge/state/task.json"), "{broken");
    await expect(store.load("task")).rejects.toBeInstanceOf(
      StateCorruptionError,
    );
    await writeFile(
      join(root, ".forge/state/task.json"),
      JSON.stringify({ revision: "x", events: [] }),
    );
    await expect(store.load("task")).rejects.toBeInstanceOf(
      StateCorruptionError,
    );
  });
});
