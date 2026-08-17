import { mkdtemp, mkdir, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  ObsidianAttachmentError,
  resolveObsidianAttachments,
} from "../packages/adapters/src/obsidian-attachments.js";

describe("Obsidian attachments", () => {
  it("resolves embeds and links with immutable integrity metadata", async () => {
    const vault = await mkdtemp(join(tmpdir(), "forge-vault-"));
    await mkdir(join(vault, "assets"));
    await writeFile(
      join(vault, "assets", "dashboard.png"),
      Buffer.from([1, 2, 3]),
    );
    await writeFile(join(vault, "requirements.pdf"), "requirements");
    await writeFile(join(vault, "meeting-notes.md"), "notes");

    const result = await resolveObsidianAttachments(
      "![[assets/dashboard.png]] [[requirements.pdf|Requirements]] [[meeting-notes]]",
      { vault_path: vault, allowed_roots: ["."] },
    );

    expect(result.map((item) => item.vault_relative_path)).toEqual([
      "assets/dashboard.png",
      "requirements.pdf",
      "meeting-notes.md",
    ]);
    expect(result[0]).toMatchObject({
      byte_length: 3,
      embedded: true,
      mime_type: "image/png",
    });
    expect(result[0]?.sha256).toMatch(/^[a-f0-9]{64}$/);
    expect(Object.isFrozen(result[0])).toBe(true);
  });

  it("fails closed for missing, escaping, and symlinked attachments", async () => {
    const root = await mkdtemp(join(tmpdir(), "forge-vault-"));
    const vault = join(root, "vault");
    const outside = join(root, "secret.txt");
    await mkdir(vault);
    await writeFile(outside, "secret");
    await symlink(outside, join(vault, "linked.txt"));

    for (const source of [
      "[[missing.pdf]]",
      "[[../secret.txt]]",
      "[[linked.txt]]",
    ]) {
      await expect(
        resolveObsidianAttachments(source, {
          vault_path: vault,
          allowed_roots: ["."],
        }),
      ).rejects.toBeInstanceOf(ObsidianAttachmentError);
    }
  });

  it("enforces a size ceiling before reading attachment bytes", async () => {
    const vault = await mkdtemp(join(tmpdir(), "forge-vault-"));
    await writeFile(join(vault, "large.pdf"), "too large");
    await expect(
      resolveObsidianAttachments("[[large.pdf]]", {
        vault_path: vault,
        allowed_roots: ["."],
        max_bytes: 4,
      }),
    ).rejects.toThrow("size limit");
  });
});
