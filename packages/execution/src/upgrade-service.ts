import {
  lstat,
  mkdir,
  readFile,
  rename,
  unlink,
  writeFile,
} from "node:fs/promises";
import { dirname, isAbsolute, relative, resolve } from "node:path";
import { randomUUID } from "node:crypto";

export type ContentClassification =
  "FORGE_MANAGED" | "PROJECT_OVERRIDE" | "USER_MANAGED";
export interface UpgradeTemplate {
  readonly path: string;
  readonly classification: ContentClassification;
  readonly content: string;
}
export interface UpgradeAction {
  readonly path: string;
  readonly action: "CREATE" | "UPDATE" | "UNCHANGED" | "CONFLICT";
  readonly classification: ContentClassification;
}
export interface UpgradeReport {
  readonly schema_version: "1";
  readonly target_version: string;
  readonly status: "READY" | "CONFLICT" | "APPLIED" | "UNCHANGED";
  readonly actions: readonly UpgradeAction[];
}

function target(root: string, path: string): string {
  if (isAbsolute(path) || path.includes("\0"))
    throw new Error("UPGRADE_PATH_ESCAPE");
  const destination = resolve(root, path);
  const rel = relative(resolve(root), destination);
  if (rel.startsWith("..") || isAbsolute(rel))
    throw new Error("UPGRADE_PATH_ESCAPE");
  return destination;
}
async function assertNoSymlinkParents(
  root: string,
  destination: string,
): Promise<void> {
  const segments = relative(resolve(root), dirname(destination))
    .split("/")
    .filter(Boolean);
  let cursor = resolve(root);
  for (const segment of segments) {
    cursor = resolve(cursor, segment);
    try {
      if ((await lstat(cursor)).isSymbolicLink())
        throw new Error("UPGRADE_SYMLINK_DENIED");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      break;
    }
  }
  try {
    if ((await lstat(destination)).isSymbolicLink())
      throw new Error("UPGRADE_SYMLINK_DENIED");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
}
async function existing(path: string): Promise<string | undefined> {
  try {
    return await readFile(path, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
}

export async function planUpgrade(
  root: string,
  targetVersion: string,
  templates: readonly UpgradeTemplate[],
): Promise<UpgradeReport> {
  if (!isAbsolute(root)) throw new Error("UPGRADE_ROOT_INVALID");
  const rootEntry = await lstat(root);
  if (!rootEntry.isDirectory() || rootEntry.isSymbolicLink())
    throw new Error("UPGRADE_ROOT_INVALID");
  if (!/^\d+$/.test(targetVersion)) throw new Error("UPGRADE_VERSION_INVALID");
  if (new Set(templates.map((item) => item.path)).size !== templates.length)
    throw new Error("UPGRADE_DUPLICATE_PATH");
  const actions: UpgradeAction[] = [];
  for (const template of templates) {
    const destination = target(root, template.path);
    await assertNoSymlinkParents(root, destination);
    const current = await existing(destination);
    const action =
      current === undefined
        ? "CREATE"
        : current === template.content
          ? "UNCHANGED"
          : template.classification === "FORGE_MANAGED"
            ? "UPDATE"
            : "CONFLICT";
    actions.push(
      Object.freeze({
        path: template.path,
        action,
        classification: template.classification,
      }),
    );
  }
  const conflict = actions.some((item) => item.action === "CONFLICT");
  return Object.freeze({
    schema_version: "1",
    target_version: targetVersion,
    status: conflict ? "CONFLICT" : "READY",
    actions: Object.freeze(actions),
  });
}

export async function applyUpgrade(
  root: string,
  targetVersion: string,
  templates: readonly UpgradeTemplate[],
): Promise<UpgradeReport> {
  const plan = await planUpgrade(root, targetVersion, templates);
  if (plan.status === "CONFLICT") return plan;
  const changed = plan.actions.filter(
    (item) => item.action === "CREATE" || item.action === "UPDATE",
  );
  const staged: Array<{
    destination: string;
    temporary: string;
    backup: string | undefined;
  }> = [];
  for (const action of changed) {
    const template = templates.find((item) => item.path === action.path);
    if (!template) throw new Error("UPGRADE_TEMPLATE_MISSING");
    const destination = target(root, action.path);
    await assertNoSymlinkParents(root, destination);
    await mkdir(dirname(destination), { recursive: true });
    const temp = `${destination}.${randomUUID()}.tmp`;
    try {
      await writeFile(temp, template.content, {
        encoding: "utf8",
        flag: "wx",
        mode: 0o600,
      });
    } catch (error) {
      await unlink(temp).catch(() => undefined);
      for (const item of staged)
        await unlink(item.temporary).catch(() => undefined);
      throw error;
    }
    staged.push({
      destination,
      temporary: temp,
      backup:
        action.action === "UPDATE"
          ? `${destination}.${randomUUID()}.backup`
          : undefined,
    });
  }
  const committed: typeof staged = [];
  try {
    for (const item of staged) {
      await assertNoSymlinkParents(root, item.destination);
      if (item.backup) await rename(item.destination, item.backup);
      try {
        await rename(item.temporary, item.destination);
      } catch (error) {
        if (item.backup) await rename(item.backup, item.destination);
        throw error;
      }
      committed.push(item);
    }
  } catch (error) {
    for (const item of [...committed].reverse()) {
      await unlink(item.destination).catch(() => undefined);
      if (item.backup) await rename(item.backup, item.destination);
    }
    throw error;
  } finally {
    for (const item of staged)
      await unlink(item.temporary).catch(() => undefined);
  }
  for (const item of committed)
    if (item.backup) await unlink(item.backup).catch(() => undefined);
  return Object.freeze({
    ...plan,
    status: changed.length === 0 ? "UNCHANGED" : "APPLIED",
  });
}
