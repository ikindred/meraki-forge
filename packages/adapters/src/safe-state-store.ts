import { randomUUID } from "node:crypto";
import {
  lstat,
  mkdir,
  open,
  readFile,
  realpath,
  rename,
  stat,
  unlink,
} from "node:fs/promises";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import type { ZodType } from "zod";

export class UnsafeTaskIdError extends Error {
  override readonly name = "UnsafeTaskIdError";
}

export class StateCorruptionError extends Error {
  override readonly name = "StateCorruptionError";
}

export class StateConflictError extends Error {
  override readonly name = "StateConflictError";
}

export class StateLockError extends Error {
  override readonly name = "StateLockError";
}

type Revisioned = { readonly revision: number };

/** A repository-contained, schema-valid, atomic state store keyed by safe task IDs. */
export class SafeStateStore<T extends Revisioned> {
  readonly #repositoryRoot: string;
  readonly #schema: ZodType<T>;
  readonly #namespace: string | undefined;

  constructor(repositoryRoot: string, schema: ZodType<T>, namespace?: string) {
    if (!isAbsolute(repositoryRoot)) {
      throw new Error("Repository root must be absolute");
    }
    this.#repositoryRoot = resolve(repositoryRoot);
    this.#schema = schema;
    if (namespace !== undefined) assertSafeTaskId(namespace);
    this.#namespace = namespace;
  }

  async load(taskId: string): Promise<T> {
    const { statePath } = await this.#paths(taskId);
    return this.#loadPath(statePath);
  }

  async save(
    taskId: string,
    state: T,
    expectedRevision?: number,
    createOnly = false,
  ): Promise<void> {
    const parsed = this.#schema.parse(state);
    const { statePath, lockPath, stateRoot } = await this.#paths(taskId);
    const temporaryPath = join(stateRoot, `.${taskId}.${randomUUID()}.tmp`);
    let lock: Awaited<ReturnType<typeof open>> | undefined;
    try {
      try {
        lock = await open(lockPath, "wx", 0o600);
      } catch (error) {
        if (isNodeError(error, "EEXIST")) {
          throw new StateLockError(`Task state is locked: ${taskId}`);
        }
        throw error;
      }
      await lock.writeFile(
        `${JSON.stringify({ pid: process.pid, acquired_at: new Date().toISOString() })}\n`,
      );
      await lock.sync();

      if (createOnly) {
        try {
          await lstat(statePath);
          throw new StateConflictError(`Task state already exists: ${taskId}`);
        } catch (error) {
          if (!isNodeError(error, "ENOENT")) throw error;
        }
      }

      if (expectedRevision !== undefined) {
        const current = await this.#loadPath(statePath);
        if (current.revision !== expectedRevision) {
          throw new StateConflictError(
            `State revision conflict: expected ${expectedRevision}, found ${current.revision}`,
          );
        }
      }

      const temporary = await open(temporaryPath, "wx", 0o600);
      try {
        await temporary.writeFile(`${JSON.stringify(parsed, null, 2)}\n`);
        await temporary.sync();
      } finally {
        await temporary.close();
      }
      await rename(temporaryPath, statePath);
      const directory = await open(stateRoot, "r");
      try {
        await directory.sync();
      } finally {
        await directory.close();
      }
    } finally {
      await lock?.close();
      if (lock) await unlink(lockPath).catch(() => undefined);
      await unlink(temporaryPath).catch(() => undefined);
    }
  }

  /** Recovery is deliberately separate from save: ordinary writers never steal locks. */
  async recoverStaleLock(
    taskId: string,
    staleAfterMs: number,
  ): Promise<boolean> {
    if (!Number.isFinite(staleAfterMs) || staleAfterMs < 0) {
      throw new RangeError("staleAfterMs must be a non-negative finite number");
    }
    const { lockPath } = await this.#paths(taskId);
    let lockStat;
    try {
      lockStat = await stat(lockPath);
    } catch (error) {
      if (isNodeError(error, "ENOENT")) return false;
      throw error;
    }
    if (Date.now() - lockStat.mtimeMs <= staleAfterMs) return false;
    const quarantine = `${lockPath}.stale.${randomUUID()}`;
    try {
      await rename(lockPath, quarantine);
    } catch (error) {
      if (isNodeError(error, "ENOENT")) return false;
      throw error;
    }
    const quarantined = await stat(quarantine);
    if (
      quarantined.ino !== lockStat.ino ||
      quarantined.mtimeMs !== lockStat.mtimeMs
    ) {
      try {
        await rename(quarantine, lockPath);
      } catch {
        /* A live lock already replaced it; preserve that lock. */
      }
      throw new StateLockError("Lock identity changed during stale recovery");
    }
    await unlink(quarantine);
    return true;
  }

  async #loadPath(statePath: string): Promise<T> {
    let source: string;
    try {
      const entry = await lstat(statePath);
      if (entry.isSymbolicLink()) {
        throw new StateCorruptionError(
          "Task state must not be a symbolic link",
        );
      }
      source = await readFile(statePath, "utf8");
    } catch (error) {
      if (isNodeError(error, "ENOENT")) throw error;
      throw new StateCorruptionError(
        `Unable to read task state: ${errorMessage(error)}`,
      );
    }
    try {
      return this.#schema.parse(JSON.parse(source));
    } catch (error) {
      throw new StateCorruptionError(
        `Invalid task state: ${errorMessage(error)}`,
      );
    }
  }

  async #paths(taskId: string): Promise<{
    readonly stateRoot: string;
    readonly statePath: string;
    readonly lockPath: string;
  }> {
    assertSafeTaskId(taskId);
    const canonicalRepository = await realpath(this.#repositoryRoot);
    const forgeRoot = join(canonicalRepository, ".forge");
    const commonStateRoot = join(forgeRoot, "state");
    const stateRoot = this.#namespace
      ? join(commonStateRoot, this.#namespace)
      : commonStateRoot;
    await ensureRealDirectory(forgeRoot);
    await ensureRealDirectory(commonStateRoot);
    if (this.#namespace) await ensureRealDirectory(stateRoot);
    assertContained(canonicalRepository, stateRoot);
    return {
      stateRoot,
      statePath: containedChild(stateRoot, `${taskId}.json`),
      lockPath: containedChild(stateRoot, `${taskId}.lock`),
    };
  }
}

function assertSafeTaskId(taskId: string): void {
  if (
    !/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(taskId) ||
    taskId === "." ||
    taskId === ".."
  ) {
    throw new UnsafeTaskIdError("Task ID must be a safe, single path segment");
  }
}

async function ensureRealDirectory(path: string): Promise<void> {
  try {
    const entry = await lstat(path);
    if (entry.isSymbolicLink())
      throw new Error(`State directory must not be a symbolic link: ${path}`);
    if (!entry.isDirectory())
      throw new Error(`State path is not a directory: ${path}`);
  } catch (error) {
    if (!isNodeError(error, "ENOENT")) throw error;
    await mkdir(path, { mode: 0o700 });
    const entry = await lstat(path);
    if (entry.isSymbolicLink() || !entry.isDirectory()) {
      throw new Error(`Unsafe state directory: ${path}`);
    }
  }
}

function containedChild(parent: string, name: string): string {
  const child = resolve(parent, name);
  assertContained(parent, child);
  return child;
}

function assertContained(parent: string, child: string): void {
  const pathFromParent = relative(parent, child);
  if (
    pathFromParent === ".." ||
    pathFromParent.startsWith(`..${sep}`) ||
    isAbsolute(pathFromParent)
  ) {
    throw new UnsafeTaskIdError("Resolved state path escapes the state root");
  }
}

function isNodeError(
  error: unknown,
  code: string,
): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error && error.code === code;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
