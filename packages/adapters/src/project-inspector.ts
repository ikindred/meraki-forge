import { execFile as execFileCallback } from "node:child_process";
import { lstat, readdir, readFile, realpath } from "node:fs/promises";
import { join, relative, resolve } from "node:path";
import { promisify } from "node:util";
import {
  detectStack,
  type RepoFile,
  type StackProfile,
} from "../../kernel/src/stack.js";

const execFile = promisify(execFileCallback);
const DEFAULT_LIMITS = Object.freeze({
  maxFiles: 5_000,
  maxFileBytes: 1024 * 1024,
  maxDepth: 12,
});
const MANIFEST_NAMES = new Set([
  "package.json",
  "composer.json",
  "pubspec.yaml",
  "pyproject.toml",
  "requirements.txt",
  "pom.xml",
  "build.gradle",
  "go.mod",
  "Cargo.toml",
  "Dockerfile",
  "compose.yml",
  "compose.yaml",
  "docker-compose.yml",
  "docker-compose.yaml",
]);
const SKIP_DIRECTORIES = new Set([
  ".git",
  "node_modules",
  "vendor",
  "dist",
  "build",
  ".next",
  ".forge",
]);

export interface InspectionLimits {
  readonly maxFiles?: number;
  readonly maxFileBytes?: number;
  readonly maxDepth?: number;
}
export interface ProjectInspection {
  readonly repositoryRoot: string;
  readonly git: { readonly clean: boolean };
  readonly branch: {
    readonly current: string | null;
    readonly default: string | null;
  };
  readonly remotes: readonly { readonly name: string; readonly url: string }[];
  readonly stack: StackProfile;
  readonly manifests: readonly string[];
  readonly existing: {
    readonly agents: boolean;
    readonly codex: boolean;
    readonly forge: boolean;
  };
}

export async function inspectProjectRepository(
  start: string,
  requested: InspectionLimits = {},
): Promise<ProjectInspection> {
  const limits = { ...DEFAULT_LIMITS, ...requested };
  if (
    !Number.isSafeInteger(limits.maxFiles) ||
    limits.maxFiles < 1 ||
    !Number.isSafeInteger(limits.maxFileBytes) ||
    limits.maxFileBytes < 1 ||
    !Number.isSafeInteger(limits.maxDepth) ||
    limits.maxDepth < 0
  )
    throw new Error("Invalid inspection limits");
  const cwd = resolve(start);
  let repositoryRoot: string;
  try {
    repositoryRoot = await realpath(
      (await git(cwd, ["rev-parse", "--show-toplevel"])).trim(),
    );
  } catch {
    throw new Error(`Target is not a Git repository: ${cwd}`);
  }
  const files = await collectManifests(repositoryRoot, limits);
  const [status, current, remotes, defaultBranch] = await Promise.all([
    git(repositoryRoot, ["status", "--porcelain=v1", "-z"]),
    gitOptional(repositoryRoot, ["symbolic-ref", "--quiet", "--short", "HEAD"]),
    git(repositoryRoot, ["remote", "-v"]),
    gitOptional(repositoryRoot, [
      "symbolic-ref",
      "--quiet",
      "--short",
      "refs/remotes/origin/HEAD",
    ]),
  ]);
  const rootEntries = new Set(await readdir(repositoryRoot));
  return Object.freeze({
    repositoryRoot,
    git: Object.freeze({ clean: status.length === 0 }),
    branch: Object.freeze({
      current: current?.trim() || null,
      default:
        defaultBranch?.trim().replace(/^origin\//, "") ||
        current?.trim() ||
        null,
    }),
    remotes: Object.freeze(parseRemotes(remotes)),
    stack: detectStack(files),
    manifests: Object.freeze(files.map((file) => file.path)),
    existing: Object.freeze({
      agents: rootEntries.has("AGENTS.md"),
      codex: rootEntries.has(".codex"),
      forge: rootEntries.has(".forge"),
    }),
  });
}

async function collectManifests(
  root: string,
  limits: Required<InspectionLimits>,
): Promise<RepoFile[]> {
  const result: RepoFile[] = [];
  let visited = 0;
  async function walk(directory: string, depth: number): Promise<void> {
    if (depth > limits.maxDepth) return;
    const entries = await readdir(directory, { withFileTypes: true });
    entries.sort((a, b) => a.name.localeCompare(b.name));
    for (const entry of entries) {
      visited += 1;
      if (visited > limits.maxFiles)
        throw new Error(
          `Repository inspection exceeds ${limits.maxFiles} files`,
        );
      const absolute = join(directory, entry.name);
      if (entry.isSymbolicLink()) continue;
      if (entry.isDirectory()) {
        if (!SKIP_DIRECTORIES.has(entry.name)) await walk(absolute, depth + 1);
        continue;
      }
      if (
        !entry.isFile() ||
        !(MANIFEST_NAMES.has(entry.name) || entry.name.endsWith(".csproj"))
      )
        continue;
      const stat = await lstat(absolute);
      if (stat.size > limits.maxFileBytes)
        throw new Error(
          `Manifest exceeds read limit: ${relative(root, absolute)}`,
        );
      result.push({
        path: relative(root, absolute).split("\\").join("/"),
        content: await readFile(absolute, "utf8"),
      });
    }
  }
  await walk(root, 0);
  return result;
}
async function git(cwd: string, args: readonly string[]): Promise<string> {
  const result = await execFile("git", [...args], {
    cwd,
    encoding: "utf8",
    maxBuffer: 4 * 1024 * 1024,
    timeout: 10_000,
  });
  return result.stdout;
}
async function gitOptional(
  cwd: string,
  args: readonly string[],
): Promise<string | null> {
  try {
    return await git(cwd, args);
  } catch {
    return null;
  }
}
function parseRemotes(text: string): readonly { name: string; url: string }[] {
  const map = new Map<string, string>();
  for (const line of text.split("\n")) {
    const match = /^(\S+)\s+(\S+)\s+\(fetch\)$/.exec(line.trim());
    if (match) map.set(match[1]!, match[2]!);
  }
  return [...map]
    .map(([name, url]) => Object.freeze({ name, url }))
    .sort((a, b) => a.name.localeCompare(b.name));
}
