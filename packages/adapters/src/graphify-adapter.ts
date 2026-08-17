import { randomUUID } from "node:crypto";
import { lstatSync, realpathSync } from "node:fs";
import {
  lstat,
  open,
  readFile,
  realpath,
  rename,
  unlink,
} from "node:fs/promises";
import { dirname, join, relative, resolve, sep } from "node:path";
import { stringify } from "yaml";
import {
  GRAPHIFY_METADATA_PATH,
  type GraphifyMetadata,
  type GraphifyStatusResult,
  parseGraphifyMetadataYaml,
} from "../../kernel/src/graphify.js";

export type ExecFileResult = Readonly<{ stdout: string; stderr: string }>;
export type ExecFileRunner = (
  executable: string,
  args: readonly string[],
  options?: Readonly<{ cwd: string }>,
) => Promise<ExecFileResult>;

const MAX_GRAPH_BYTES = 16 * 1024 * 1024;
const MAX_GRAPH_NODES = 100_000;
const ALLOWED_GRAPHIFY_PATHS = ["graphify-out/", ".forge/graphify.yml"];

export class GraphifyAdapter {
  readonly repository: string;
  constructor(
    repository: string,
    private readonly run: ExecFileRunner,
  ) {
    const requested = resolve(repository);
    const entry = lstatSync(requested);
    if (!entry.isDirectory() || entry.isSymbolicLink())
      throw new Error("Registered repository must be a real directory");
    this.repository = realpathSync(requested);
  }

  async assertRepositoryIdentity(): Promise<string> {
    const entry = await lstat(this.repository);
    if (!entry.isDirectory() || entry.isSymbolicLink())
      throw new Error("Registered repository must be a real directory");
    const canonical = await realpath(this.repository);
    if (canonical !== this.repository)
      throw new Error("Registered repository identity changed");
    return canonical;
  }

  async probe(): Promise<GraphifyStatusResult> {
    try {
      // Graphify exposes no version flag; --help is its stable, side-effect-free probe.
      const result = await this.run("graphify", ["--help"], {
        cwd: this.repository,
      });
      const help = result.stdout.trim() || result.stderr.trim();
      return help
        ? { status: "CURRENT", reason: "unknown" }
        : { status: "INVALID", reason: "Graphify returned no help output" };
    } catch (error) {
      return {
        status: "UNAVAILABLE",
        reason: error instanceof Error ? error.message : "Graphify unavailable",
      };
    }
  }

  async head(): Promise<string> {
    const { stdout } = await this.run("git", ["rev-parse", "HEAD"], {
      cwd: this.repository,
    });
    const head = stdout.trim();
    if (!/^[0-9a-f]{40}$/u.test(head))
      throw new Error("Git returned an invalid HEAD");
    return head;
  }

  async status(): Promise<GraphifyStatusResult> {
    try {
      const root = await this.assertRepositoryIdentity();
      const metadataPath = await this.safeExistingPath(
        root,
        GRAPHIFY_METADATA_PATH,
      );
      if (!metadataPath) return { status: "MISSING" };
      const metadata = parseGraphifyMetadataYaml(
        await readFile(metadataPath, "utf8"),
      );
      const graphPath = await this.safeExistingPath(root, metadata.graph_path);
      if (!graphPath) return { status: "MISSING", metadata };
      await this.validateGraphFile(graphPath);
      const head = await this.head();
      return {
        status: head === metadata.indexed_commit ? "CURRENT" : "STALE",
        head,
        metadata,
      };
    } catch (error) {
      return {
        status: "INVALID",
        reason:
          error instanceof Error ? error.message : "Invalid Graphify index",
      };
    }
  }

  async update(): Promise<void> {
    await this.assertRepositoryIdentity();
    await this.run("graphify", ["update", this.repository], {
      cwd: this.repository,
    });
  }

  async mutationGuard(): Promise<string> {
    const status = await this.run(
      "git",
      ["status", "--porcelain=v1", "-z", "--untracked-files=all"],
      { cwd: this.repository },
    );
    const diff = await this.run(
      "git",
      [
        "diff",
        "--binary",
        "HEAD",
        "--",
        ".",
        ":(exclude)graphify-out/**",
        ":(exclude).forge/graphify.yml",
      ],
      { cwd: this.repository },
    );
    const productionEntries = status.stdout
      .split("\0")
      .filter(Boolean)
      .filter((entry) => !isAllowedStatusEntry(entry));
    const untrackedHashes = await Promise.all(
      productionEntries
        .filter((entry) => entry.startsWith("?? "))
        .map(async (entry) => {
          const path = entry.slice(3);
          const result = await this.run("git", ["hash-object", "--", path], {
            cwd: this.repository,
          });
          return `${path}:${result.stdout.trim()}`;
        }),
    );
    return `${productionEntries.sort().join("\0")}\n---untracked---\n${untrackedHashes.sort().join("\n")}\n---diff---\n${diff.stdout}`;
  }

  async validateConfiguredGraph(graphPath: string): Promise<void> {
    const root = await this.assertRepositoryIdentity();
    const resolved = await this.safeExistingPath(root, graphPath);
    if (!resolved) throw new Error("Graphify update produced no graph output");
    await this.validateGraphFile(resolved);
  }

  async readMetadataSource(): Promise<string> {
    const root = await this.assertRepositoryIdentity();
    const target = await this.safeExistingPath(root, GRAPHIFY_METADATA_PATH);
    if (!target) throw new Error("Graphify metadata disappeared");
    return readFile(target, "utf8");
  }

  async writeMetadata(metadata: GraphifyMetadata): Promise<void> {
    await this.writeMetadataSource(stringify(metadata));
  }

  async restoreMetadata(source: string): Promise<void> {
    parseGraphifyMetadataYaml(source);
    await this.writeMetadataSource(source);
  }

  private async writeMetadataSource(source: string): Promise<void> {
    const root = await this.assertRepositoryIdentity();
    const target = join(root, GRAPHIFY_METADATA_PATH);
    await this.assertParentSafe(root, dirname(target));
    await assertNoSymlinkComponents(root, target);
    const temporary = `${target}.tmp-${randomUUID()}`;
    const handle = await open(temporary, "wx", 0o600);
    try {
      await handle.writeFile(source);
      await handle.sync();
      await handle.close();
      await rename(temporary, target);
    } catch (error) {
      await handle.close().catch(() => undefined);
      await unlink(temporary).catch(() => undefined);
      throw error;
    }
  }

  private async safeExistingPath(
    root: string,
    path: string,
  ): Promise<string | null> {
    const target = resolve(root, path);
    if (!isContained(root, target))
      throw new Error("Graphify path escapes repository");
    try {
      await assertNoSymlinkComponents(root, target);
      const canonical = await realpath(target);
      if (!isContained(root, canonical))
        throw new Error("Graphify symlink escapes repository");
      return canonical;
    } catch (error) {
      if (isNodeError(error, "ENOENT")) return null;
      throw error;
    }
  }

  private async assertParentSafe(root: string, parent: string): Promise<void> {
    await assertNoSymlinkComponents(root, parent);
    const canonical = await realpath(parent);
    if (!isContained(root, canonical))
      throw new Error("Graphify metadata parent escapes repository");
  }

  private async validateGraphFile(graphPath: string): Promise<void> {
    const stat = await lstat(graphPath);
    if (!stat.isFile()) throw new Error("Graph is not a regular file");
    if (stat.size > MAX_GRAPH_BYTES)
      throw new Error("Graph exceeds the 16 MiB size limit");
    const source = await readFile(graphPath, "utf8");
    if (Buffer.byteLength(source) > MAX_GRAPH_BYTES)
      throw new Error("Graph exceeds the 16 MiB size limit");
    const graph: unknown = JSON.parse(source);
    if (countJsonNodes(graph, MAX_GRAPH_NODES) > MAX_GRAPH_NODES)
      throw new Error("Graph JSON node count exceeds 100000");
  }
}

async function assertNoSymlinkComponents(
  root: string,
  target: string,
): Promise<void> {
  const rel = relative(root, target);
  if (!isContained(root, target))
    throw new Error("Graphify path escapes repository");
  let current = root;
  for (const component of rel.split(sep).filter(Boolean)) {
    current = join(current, component);
    try {
      if ((await lstat(current)).isSymbolicLink())
        throw new Error("Graphify path contains a symlink component");
    } catch (error) {
      if (isNodeError(error, "ENOENT")) return;
      throw error;
    }
  }
}

function countJsonNodes(value: unknown, limit: number): number {
  const pending: unknown[] = [value];
  let count = 0;
  while (pending.length > 0) {
    const current = pending.pop();
    count += 1;
    if (count > limit) return count;
    if (Array.isArray(current)) {
      for (const child of current) pending.push(child);
    } else if (current !== null && typeof current === "object") {
      for (const child of Object.values(current)) pending.push(child);
    }
  }
  return count;
}

function isAllowedStatusEntry(entry: string): boolean {
  const path = entry.length >= 4 ? entry.slice(3) : entry;
  const renamedPath = path.includes(" -> ") ? path.split(" -> ").at(-1)! : path;
  return ALLOWED_GRAPHIFY_PATHS.some(
    (allowed) =>
      renamedPath === allowed.replace(/\/$/u, "") ||
      (allowed.endsWith("/") && renamedPath.startsWith(allowed)),
  );
}

function isContained(root: string, target: string): boolean {
  const rel = relative(root, target);
  return (
    rel === "" ||
    (!rel.startsWith(`..${sep}`) && rel !== ".." && !rel.startsWith(sep))
  );
}
function isNodeError(error: unknown, code: string): boolean {
  return error instanceof Error && "code" in error && error.code === code;
}
