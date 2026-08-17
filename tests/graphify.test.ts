import {
  mkdir,
  mkdtemp,
  readFile,
  rename,
  symlink,
  unlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { parseGraphifyMetadataYaml } from "../packages/kernel/src/graphify.js";
import { GraphifyAdapter } from "../packages/adapters/src/graphify-adapter.js";
import { GraphifyService } from "../packages/execution/src/graphify-service.js";

const roots: string[] = [];
async function repo() {
  const root = await mkdtemp(join(tmpdir(), "forge-graphify-"));
  roots.push(root);
  await mkdir(join(root, ".forge"));
  await mkdir(join(root, "graphify-out"));
  return root;
}
afterEach(async () => {
  const { rm } = await import("node:fs/promises");
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true })),
  );
});

const sha = "a".repeat(40);
const metadata = (commit = sha) =>
  `schema_version: "1"\ngraph_path: graphify-out/graph.json\nindexed_commit: ${commit}\ngraphify_version: 2.3.1\nindexed_at: 2026-08-17T00:00:00.000Z\n`;

describe("Graphify contract and adapter", () => {
  it("requires a contained graph path and full commit binding", () => {
    expect(parseGraphifyMetadataYaml(metadata()).indexed_commit).toBe(sha);
    expect(() => parseGraphifyMetadataYaml(metadata("abc123"))).toThrow();
    expect(() =>
      parseGraphifyMetadataYaml(
        metadata().replace("graphify-out/graph.json", "../graph.json"),
      ),
    ).toThrow();
  });

  it("reports CURRENT and STALE against live HEAD", async () => {
    const root = await repo();
    await writeFile(join(root, "graphify-out/graph.json"), '{"nodes":[]}\n');
    await writeFile(join(root, ".forge/graphify.yml"), metadata());
    const current = new GraphifyAdapter(root, (file, args) => {
      expect([file, ...args]).toEqual(["git", "rev-parse", "HEAD"]);
      return Promise.resolve({ stdout: `${sha}\n`, stderr: "" });
    });
    expect((await current.status()).status).toBe("CURRENT");
    const stale = new GraphifyAdapter(root, () =>
      Promise.resolve({
        stdout: `${"b".repeat(40)}\n`,
        stderr: "",
      }),
    );
    expect((await stale.status()).status).toBe("STALE");
  });

  it("distinguishes missing, unavailable, and invalid indexes", async () => {
    const root = await repo();
    const runner = () => Promise.resolve({ stdout: `${sha}\n`, stderr: "" });
    expect((await new GraphifyAdapter(root, runner).status()).status).toBe(
      "MISSING",
    );
    await writeFile(join(root, ".forge/graphify.yml"), metadata());
    expect((await new GraphifyAdapter(root, runner).status()).status).toBe(
      "MISSING",
    );
    await writeFile(join(root, "graphify-out/graph.json"), "not json");
    expect((await new GraphifyAdapter(root, runner).status()).status).toBe(
      "INVALID",
    );
    expect(
      (
        await new GraphifyAdapter(root, () =>
          Promise.reject(
            Object.assign(new Error("missing"), { code: "ENOENT" }),
          ),
        ).probe()
      ).status,
    ).toBe("UNAVAILABLE");
  });

  it("rejects a graph symlink escaping the repository", async () => {
    const root = await repo();
    const outside = join(tmpdir(), `outside-${Date.now()}.json`);
    roots.push(outside);
    await writeFile(outside, "{}");
    await symlink(outside, join(root, "graphify-out/graph.json"));
    await writeFile(join(root, ".forge/graphify.yml"), metadata());
    const adapter = new GraphifyAdapter(root, () =>
      Promise.resolve({ stdout: `${sha}\n`, stderr: "" }),
    );
    expect((await adapter.status()).status).toBe("INVALID");
  });

  it("rejects every symlink component even when it resolves inside the repository", async () => {
    const root = await repo();
    await mkdir(join(root, "real-index"));
    await writeFile(join(root, "real-index/graph.json"), "{}\n");
    await symlink(join(root, "real-index"), join(root, "linked-index"));
    await writeFile(
      join(root, ".forge/graphify.yml"),
      metadata().replace("graphify-out/graph.json", "linked-index/graph.json"),
    );
    const adapter = new GraphifyAdapter(root, () =>
      Promise.resolve({ stdout: `${sha}\n`, stderr: "" }),
    );
    const result = await adapter.status();
    expect(result.status).toBe("INVALID");
    expect(result.reason).toMatch(/symlink/iu);
  });

  it("bounds graph size and JSON node count", async () => {
    const root = await repo();
    await writeFile(join(root, ".forge/graphify.yml"), metadata());
    await writeFile(
      join(root, "graphify-out/graph.json"),
      JSON.stringify({ nodes: Array.from({ length: 100_001 }, () => null) }),
    );
    const adapter = new GraphifyAdapter(root, () =>
      Promise.resolve({ stdout: `${sha}\n`, stderr: "" }),
    );
    const result = await adapter.status();
    expect(result.status).toBe("INVALID");
    expect(result.reason).toMatch(/node count/iu);
  });
});

describe("Graphify service", () => {
  it("fails closed when the Graphify executable is unavailable", async () => {
    const root = await repo();
    const service = new GraphifyService(
      new GraphifyAdapter(root, (file) =>
        file === "graphify"
          ? Promise.reject(new Error("graphify not found"))
          : Promise.resolve({ stdout: `${sha}\n`, stderr: "" }),
      ),
    );
    await expect(service.inspect()).resolves.toMatchObject({
      status: "UNAVAILABLE",
      reason: "graphify not found",
    });
  });

  it("refreshes only an existing index with graphify update <repo> and binds full HEAD", async () => {
    const root = await repo();
    await writeFile(join(root, "graphify-out/graph.json"), "{}\n");
    await writeFile(
      join(root, ".forge/graphify.yml"),
      metadata("b".repeat(40)),
    );
    const calls: Array<[string, readonly string[]]> = [];
    const adapter = new GraphifyAdapter(root, (file, args) => {
      calls.push([file, args]);
      if (file === "graphify" && args[0] === "--help")
        return Promise.resolve({
          stdout: "Usage: graphify <command>\n",
          stderr: "",
        });
      if (file === "graphify")
        return Promise.resolve({ stdout: "updated\n", stderr: "" });
      return Promise.resolve({ stdout: `${sha}\n`, stderr: "" });
    });
    const result = await new GraphifyService(adapter).refresh();
    expect(result.status).toBe("CURRENT");
    expect(calls).toContainEqual(["graphify", ["--help"]]);
    expect(calls).toContainEqual(["graphify", ["update", adapter.repository]]);
    expect(
      parseGraphifyMetadataYaml(
        await readFile(join(root, ".forge/graphify.yml"), "utf8"),
      ).indexed_commit,
    ).toBe(sha);
  });

  it("preserves old metadata when the update command fails", async () => {
    const root = await repo();
    const old = metadata("b".repeat(40));
    await writeFile(join(root, "graphify-out/graph.json"), "{}\n");
    await writeFile(join(root, ".forge/graphify.yml"), old);
    const adapter = new GraphifyAdapter(root, async (file, args) => {
      if (file === "graphify" && args[0] === "--help")
        return { stdout: "Usage: graphify\n", stderr: "" };
      if (file === "graphify") {
        await writeFile(join(root, ".forge/graphify.yml"), metadata(sha));
        throw new Error("update failed");
      }
      if (args[0] === "status" || args[0] === "diff")
        return { stdout: "", stderr: "" };
      return { stdout: `${sha}\n`, stderr: "" };
    });
    await expect(new GraphifyService(adapter).refresh()).resolves.toMatchObject(
      {
        status: "UNAVAILABLE",
        reason: "update failed",
      },
    );
    expect(await readFile(join(root, ".forge/graphify.yml"), "utf8")).toBe(old);
  });

  it("returns the exact manual action when the initial graph is missing", async () => {
    const root = await repo();
    const adapter = new GraphifyAdapter(root, () =>
      Promise.resolve({ stdout: `${sha}\n`, stderr: "" }),
    );
    const service = new GraphifyService(adapter);
    await expect(service.refresh()).resolves.toMatchObject({
      status: "MISSING",
      action: `Initialize Graphify manually in ${adapter.repository}, then rerun forge graph refresh.`,
    });
  });

  it("adopts a valid manually initialized graph into commit-bound metadata", async () => {
    const root = await repo();
    await writeFile(join(root, "graphify-out/graph.json"), '{"nodes":[]}\n');
    const service = new GraphifyService(
      new GraphifyAdapter(root, (file, args) =>
        Promise.resolve({
          stdout:
            file === "graphify" && args[0] === "--help"
              ? "Usage: graphify\n"
              : `${sha}\n`,
          stderr: "",
        }),
      ),
    );
    await expect(service.refresh()).resolves.toMatchObject({
      status: "CURRENT",
      head: sha,
    });
    expect(
      parseGraphifyMetadataYaml(
        await readFile(join(root, ".forge/graphify.yml"), "utf8"),
      ).indexed_commit,
    ).toBe(sha);
  });

  it("rejects a registered repository path replaced by a symlink", async () => {
    const root = await repo();
    const moved = `${root}-moved`;
    roots.push(moved);
    await rename(root, moved);
    roots.splice(roots.indexOf(root), 1);
    await symlink(moved, root);
    roots.push(root);
    let called = false;
    expect(
      () =>
        new GraphifyAdapter(root, () => {
          called = true;
          return Promise.resolve({ stdout: `${sha}\n`, stderr: "" });
        }),
    ).toThrow(/real directory/iu);
    expect(called).toBe(false);
  });

  it("preserves metadata when update output is malformed and validates before binding", async () => {
    const root = await repo();
    const old = metadata("b".repeat(40));
    await writeFile(join(root, "graphify-out/graph.json"), "{}\n");
    await writeFile(join(root, ".forge/graphify.yml"), old);
    const adapter = new GraphifyAdapter(root, async (file, args) => {
      if (file === "graphify" && args[0] === "--help")
        return { stdout: "Usage: graphify <command>\n", stderr: "" };
      if (file === "graphify") {
        await writeFile(join(root, "graphify-out/graph.json"), "not json");
        return { stdout: "updated\n", stderr: "" };
      }
      if (args[0] === "status") return { stdout: "", stderr: "" };
      if (args[0] === "diff") return { stdout: "", stderr: "" };
      return { stdout: `${sha}\n`, stderr: "" };
    });
    await expect(new GraphifyService(adapter).refresh()).resolves.toMatchObject(
      {
        status: "INVALID",
      },
    );
    expect(await readFile(join(root, ".forge/graphify.yml"), "utf8")).toBe(old);
  });

  it("preserves metadata when update produces no graph artifact", async () => {
    const root = await repo();
    const old = metadata("b".repeat(40));
    await writeFile(join(root, "graphify-out/graph.json"), "{}\n");
    await writeFile(join(root, ".forge/graphify.yml"), old);
    const adapter = new GraphifyAdapter(root, async (file, args) => {
      if (file === "graphify" && args[0] === "--help")
        return { stdout: "Usage: graphify\n", stderr: "" };
      if (file === "graphify") {
        await unlink(join(root, "graphify-out/graph.json"));
        return { stdout: "", stderr: "" };
      }
      if (args[0] === "status" || args[0] === "diff")
        return { stdout: "", stderr: "" };
      return { stdout: `${sha}\n`, stderr: "" };
    });
    const result = await new GraphifyService(adapter).refresh();
    expect(result.status).toBe("INVALID");
    expect(result.reason).toMatch(/no graph output/iu);
    expect(await readFile(join(root, ".forge/graphify.yml"), "utf8")).toBe(old);
  });

  it("rejects HEAD movement and production changes without rebinding metadata", async () => {
    for (const mode of ["head", "production"] as const) {
      const root = await repo();
      const old = metadata("b".repeat(40));
      await writeFile(join(root, "graphify-out/graph.json"), "{}\n");
      await writeFile(join(root, ".forge/graphify.yml"), old);
      let updated = false;
      const adapter = new GraphifyAdapter(root, (file, args) => {
        if (file === "graphify" && args[0] === "--help")
          return Promise.resolve({ stdout: "Usage: graphify\n", stderr: "" });
        if (file === "graphify") {
          updated = true;
          return Promise.resolve({ stdout: "updated\n", stderr: "" });
        }
        if (args[0] === "status")
          return Promise.resolve({
            stdout: mode === "production" && updated ? " M src/app.ts\0" : "",
            stderr: "",
          });
        if (args[0] === "diff")
          return Promise.resolve({ stdout: "", stderr: "" });
        return Promise.resolve({
          stdout: `${mode === "head" && updated ? "c".repeat(40) : sha}\n`,
          stderr: "",
        });
      });
      const result = await new GraphifyService(adapter).refresh();
      expect(result.status).toBe("INVALID");
      expect(result.reason).toMatch(
        mode === "head" ? /HEAD changed/iu : /production files/iu,
      );
      expect(await readFile(join(root, ".forge/graphify.yml"), "utf8")).toBe(
        old,
      );
    }
  });
});
