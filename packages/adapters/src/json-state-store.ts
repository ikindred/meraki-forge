import { open, readFile, rename, unlink, writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { TaskStateSchema, type TaskState } from "../../kernel/src/state.js";
export class JsonStateStore {
  async load(path: string): Promise<TaskState> {
    return TaskStateSchema.parse(JSON.parse(await readFile(path, "utf8")));
  }
  async save(
    path: string,
    state: TaskState,
    expectedRevision?: number,
  ): Promise<void> {
    const lockPath = `${path}.lock`;
    const temp = `${path}.${randomUUID()}.tmp`;
    let lock;
    try {
      lock = await open(lockPath, "wx", 0o600);
      if (expectedRevision !== undefined) {
        const current = await this.load(path);
        if (current.revision !== expectedRevision)
          throw new Error("State revision conflict");
      }
      await writeFile(
        temp,
        `${JSON.stringify(TaskStateSchema.parse(state), null, 2)}\n`,
        { flag: "wx", mode: 0o600 },
      );
      await rename(temp, path);
    } finally {
      await lock?.close();
      await unlink(lockPath).catch(() => undefined);
      await unlink(temp).catch(() => undefined);
    }
  }
}
