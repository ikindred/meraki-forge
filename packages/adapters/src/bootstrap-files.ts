import { randomUUID } from "node:crypto";
import {
  lstat,
  mkdir,
  open,
  readFile,
  realpath,
  rename,
  unlink,
} from "node:fs/promises";
import {
  basename,
  dirname,
  extname,
  isAbsolute,
  join,
  relative,
  resolve,
  sep,
} from "node:path";

export const MANAGED_BEGIN = "<!-- BEGIN MERAKI FORGE MANAGED -->";
export const MANAGED_END = "<!-- END MERAKI FORGE MANAGED -->";
const YAML_MARKER = "# MERAKI FORGE MANAGED FILE";

export class BootstrapFileError extends Error {
  override readonly name: string = "BootstrapFileError";
}
export class BootstrapConflictError extends BootstrapFileError {
  override readonly name: string = "BootstrapConflictError";
}

export type BootstrapRoot = "repository" | "vault";
export type BootstrapEntry = Readonly<{
  root: BootstrapRoot;
  path: string;
  kind: "directory" | "managed-file" | "composed-markdown";
  content?: string;
}>;
export type BootstrapFilePlan = Readonly<{
  repositoryRoot: string;
  vaultRoot: string;
  entries: readonly BootstrapEntry[];
}>;

export type BootstrapApplyResult = Readonly<{
  status: "DRY_RUN" | "APPLIED" | "UNCHANGED";
  changes: readonly string[];
}>;

/** Apply a fully materialized plan. It never follows a symlink below either configured root. */
export async function applyManagedBootstrapFiles(
  plan: BootstrapFilePlan,
  dryRun = false,
): Promise<BootstrapApplyResult> {
  const roots = {
    repository: await canonicalDirectory(plan.repositoryRoot),
    vault: await canonicalDirectory(plan.vaultRoot),
  } as const;
  const resolved = plan.entries.map((entry) => ({
    entry,
    target: safeTarget(roots[entry.root], entry.path),
  }));
  const duplicates = new Set<string>();
  for (const item of resolved) {
    if (duplicates.has(item.target))
      throw new BootstrapFileError(
        `Duplicate bootstrap target: ${item.entry.path}`,
      );
    duplicates.add(item.target);
    await rejectExistingSymlinkComponents(roots[item.entry.root], item.target);
  }

  const directories: Array<{
    entry: BootstrapEntry;
    target: string;
    changed: boolean;
  }> = [];
  for (const item of resolved.filter(
    ({ entry }) => entry.kind === "directory",
  )) {
    let changed = false;
    try {
      const current = await lstat(item.target);
      if (current.isSymbolicLink() || !current.isDirectory())
        throw new BootstrapConflictError(
          `Bootstrap directory conflicts at ${item.entry.path}`,
        );
    } catch (error) {
      if (!isNodeError(error, "ENOENT")) throw error;
      changed = true;
    }
    directories.push({ ...item, changed });
  }

  // Materialize every file and detect all conflicts before the first write.
  const files: Array<{
    target: string;
    source: string;
    existing: string | undefined;
    entry: BootstrapEntry;
    changed: boolean;
  }> = [];
  for (const item of resolved.filter(
    ({ entry }) => entry.kind !== "directory",
  )) {
    const existing = await optionalFile(item.target);
    const source = compose(item.entry, existing);
    files.push({ ...item, source, existing, changed: existing !== source });
  }
  const changes = [
    ...directories
      .filter(({ changed }) => changed)
      .map(({ entry }) => `${entry.root}:${entry.path}/`),
    ...files
      .filter(({ changed }) => changed)
      .map(({ entry }) => `${entry.root}:${entry.path}`),
  ];
  if (dryRun) return { status: "DRY_RUN", changes };

  for (const { entry, target } of directories) {
    await safeMkdir(roots[entry.root], target);
  }
  for (const file of files.filter(({ changed }) => changed)) {
    await safeMkdir(roots[file.entry.root], dirname(file.target));
    if ((await optionalFile(file.target)) !== file.existing)
      throw new BootstrapConflictError(
        `Bootstrap target changed during apply: ${file.entry.path}`,
      );
    await atomicWrite(roots[file.entry.root], file.target, file.source);
  }
  return {
    status:
      directories.some(({ changed }) => changed) ||
      files.some(({ changed }) => changed)
        ? "APPLIED"
        : "UNCHANGED",
    changes,
  };
}

function compose(entry: BootstrapEntry, existing: string | undefined): string {
  const content = normalize(entry.content ?? "");
  if (entry.kind === "composed-markdown") {
    const managed = `${MANAGED_BEGIN}\n${content.trimEnd()}\n${MANAGED_END}`;
    if (existing === undefined || existing.trim() === "") return `${managed}\n`;
    const begin = existing.indexOf(MANAGED_BEGIN);
    const end = existing.indexOf(MANAGED_END);
    const duplicateBegin =
      begin >= 0 && existing.indexOf(MANAGED_BEGIN, begin + 1) >= 0;
    const duplicateEnd =
      end >= 0 && existing.indexOf(MANAGED_END, end + 1) >= 0;
    if (begin < 0 !== end < 0 || (begin >= 0 && end < begin))
      throw new BootstrapConflictError(
        `Malformed managed markers conflict at ${entry.path}`,
      );
    if (duplicateBegin || duplicateEnd)
      throw new BootstrapConflictError(
        `Duplicate managed markers conflict at ${entry.path}`,
      );
    if (begin < 0) return `${existing.trimEnd()}\n\n${managed}\n`;
    const after = end + MANAGED_END.length;
    return `${existing.slice(0, begin)}${managed}${existing.slice(after)}`;
  }
  const generated = extname(entry.path).match(/^\.ya?ml$/u)
    ? `${YAML_MARKER}\n${content}`
    : `${MANAGED_BEGIN}\n${content.trimEnd()}\n${MANAGED_END}\n`;
  if (existing === undefined || existing === generated) return generated;
  const owned =
    existing.startsWith(`${YAML_MARKER}\n`) ||
    (existing.startsWith(`${MANAGED_BEGIN}\n`) &&
      existing.trimEnd().endsWith(MANAGED_END));
  if (!owned)
    throw new BootstrapConflictError(
      `Unmanaged file conflict at ${entry.path}`,
    );
  return generated;
}

function normalize(value: string): string {
  return value.replace(/\r\n?/gu, "\n").replace(/\n*$/u, "\n");
}

async function canonicalDirectory(path: string): Promise<string> {
  if (!isAbsolute(path))
    throw new BootstrapFileError("Bootstrap roots must be absolute");
  const canonical = await realpath(resolve(path));
  const entry = await lstat(canonical);
  if (!entry.isDirectory())
    throw new BootstrapFileError("Bootstrap root must be a directory");
  return canonical;
}

function safeTarget(root: string, path: string): string {
  if (
    !path ||
    isAbsolute(path) ||
    path
      .split(/[\\/]/u)
      .some((part) => part === "" || part === "." || part === "..")
  )
    throw new BootstrapFileError(`Unsafe bootstrap path: ${path}`);
  const target = resolve(root, path);
  const rel = relative(root, target);
  if (rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel))
    throw new BootstrapFileError(`Bootstrap path escapes root: ${path}`);
  return target;
}

async function rejectExistingSymlinkComponents(
  root: string,
  target: string,
): Promise<void> {
  let current = root;
  for (const part of relative(root, target).split(sep).filter(Boolean)) {
    current = join(current, part);
    try {
      if ((await lstat(current)).isSymbolicLink())
        throw new BootstrapFileError(
          `Bootstrap destination contains a symbolic link: ${current}`,
        );
    } catch (error) {
      if (isNodeError(error, "ENOENT")) return;
      throw error;
    }
  }
}

async function safeMkdir(root: string, target: string): Promise<void> {
  let current = root;
  for (const part of relative(root, target).split(sep).filter(Boolean)) {
    current = join(current, part);
    try {
      const entry = await lstat(current);
      if (entry.isSymbolicLink() || !entry.isDirectory())
        throw new BootstrapFileError(
          `Bootstrap directory is unsafe: ${current}`,
        );
    } catch (error) {
      if (!isNodeError(error, "ENOENT")) throw error;
      await mkdir(current, { mode: 0o700 });
    }
  }
}

async function optionalFile(path: string): Promise<string | undefined> {
  try {
    const entry = await lstat(path);
    if (entry.isSymbolicLink() || !entry.isFile())
      throw new BootstrapConflictError(
        `Bootstrap target is not a regular file: ${path}`,
      );
    return await readFile(path, "utf8");
  } catch (error) {
    if (isNodeError(error, "ENOENT")) return undefined;
    throw error;
  }
}

async function atomicWrite(
  root: string,
  target: string,
  source: string,
): Promise<void> {
  const parent = dirname(target);
  if ((await realpath(parent)) !== parent)
    throw new BootstrapFileError(
      `Bootstrap destination changed identity: ${parent}`,
    );
  await rejectExistingSymlinkComponents(root, parent);
  const temporary = join(
    dirname(target),
    `.${basename(target)}.${randomUUID()}.tmp`,
  );
  const handle = await open(temporary, "wx", 0o600);
  try {
    await handle.writeFile(source);
    await handle.sync();
  } finally {
    await handle.close();
  }
  try {
    await rename(temporary, target);
  } finally {
    await unlink(temporary).catch(() => undefined);
  }
  const directory = await open(dirname(target), "r");
  try {
    await directory.sync();
  } finally {
    await directory.close();
  }
}

function isNodeError(
  error: unknown,
  code: string,
): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error && error.code === code;
}
