import { createHash } from "node:crypto";
import { lstat, readFile, realpath, stat } from "node:fs/promises";
import { extname, isAbsolute, join, relative, resolve, sep } from "node:path";

export class ObsidianAttachmentError extends Error {
  override readonly name = "ObsidianAttachmentError";
}

export type ObsidianAttachment = Readonly<{
  reference: string;
  vault_relative_path: string;
  absolute_path: string;
  embedded: boolean;
  display_text: string | null;
  mime_type: string;
  byte_length: number;
  modified_at: string;
  sha256: string;
}>;

export async function resolveObsidianAttachments(
  source: string,
  config: Readonly<{
    vault_path: string;
    allowed_roots: readonly string[];
    max_bytes?: number;
  }>,
): Promise<readonly ObsidianAttachment[]> {
  if (!isAbsolute(config.vault_path))
    throw new ObsidianAttachmentError("Vault path must be absolute");
  const vault = await canonicalDirectory(config.vault_path);
  if (config.allowed_roots.length === 0)
    throw new ObsidianAttachmentError(
      "At least one allowed vault root is required",
    );
  const allowedRoots = await Promise.all(
    config.allowed_roots.map(async (path) => {
      assertSafeRelative(path, true);
      const candidate = resolve(vault, path);
      assertContained(vault, candidate);
      await rejectSymlinkComponents(vault, candidate);
      return canonicalDirectory(candidate);
    }),
  );
  const matches = [...source.matchAll(/(!)?\[\[([^\]]+)\]\]/gu)];
  const attachments = await Promise.all(
    matches.map(async (match): Promise<ObsidianAttachment> => {
      const reference = match[0];
      const [rawTarget, displayText] = (match[2] ?? "").split("|", 2);
      const target = rawTarget?.split("#", 1)[0]?.trim() ?? "";
      assertSafeRelative(target, false);
      let candidate = resolve(vault, target);
      assertContained(vault, candidate);
      if (extname(candidate) === "")
        candidate = await withMarkdownFallback(candidate);
      await rejectSymlinkComponents(vault, candidate);
      const canonical = await realpath(candidate).catch(() => {
        throw new ObsidianAttachmentError(
          `Attachment does not exist: ${target}`,
        );
      });
      if (!allowedRoots.some((root) => isContained(root, canonical))) {
        throw new ObsidianAttachmentError(
          `Attachment is outside allowed vault roots: ${target}`,
        );
      }
      const entry = await lstat(canonical);
      if (!entry.isFile())
        throw new ObsidianAttachmentError(
          `Attachment is not a regular file: ${target}`,
        );
      const maxBytes = config.max_bytes ?? 25 * 1024 * 1024;
      if (!Number.isSafeInteger(maxBytes) || maxBytes <= 0)
        throw new ObsidianAttachmentError("Invalid attachment size policy");
      if (entry.size > maxBytes)
        throw new ObsidianAttachmentError(
          `Attachment exceeds the configured size limit: ${target}`,
        );
      const bytes = await readFile(canonical);
      return Object.freeze({
        reference,
        vault_relative_path: relative(vault, canonical).split(sep).join("/"),
        absolute_path: canonical,
        embedded: match[1] === "!",
        display_text: displayText?.trim() || null,
        mime_type: mimeType(extname(canonical).toLowerCase()),
        byte_length: bytes.byteLength,
        modified_at: entry.mtime.toISOString(),
        sha256: createHash("sha256").update(bytes).digest("hex"),
      });
    }),
  );
  return Object.freeze(attachments);
}

async function withMarkdownFallback(candidate: string): Promise<string> {
  try {
    await stat(candidate);
    return candidate;
  } catch {
    /* use Obsidian note extension */
  }
  return `${candidate}.md`;
}

function assertSafeRelative(path: string, allowDot: boolean): void {
  if (
    !path ||
    isAbsolute(path) ||
    (!allowDot && path === ".") ||
    path.includes("\0") ||
    path.split(/[\\/]/u).some((part) => part === ".." || part === "")
  ) {
    throw new ObsidianAttachmentError(
      "Attachment paths must be normalized vault-relative paths",
    );
  }
}

async function canonicalDirectory(path: string): Promise<string> {
  const canonical = await realpath(path).catch(() => {
    throw new ObsidianAttachmentError(`Directory does not exist: ${path}`);
  });
  if (!(await lstat(canonical)).isDirectory())
    throw new ObsidianAttachmentError(`Not a directory: ${path}`);
  return canonical;
}

async function rejectSymlinkComponents(
  root: string,
  target: string,
): Promise<void> {
  let current = root;
  for (const part of relative(root, target).split(sep).filter(Boolean)) {
    current = join(current, part);
    const entry = await lstat(current).catch(() => {
      throw new ObsidianAttachmentError(
        `Attachment does not exist: ${relative(root, target)}`,
      );
    });
    if (entry.isSymbolicLink())
      throw new ObsidianAttachmentError(
        "Attachment paths must not contain symbolic links",
      );
  }
}

function assertContained(root: string, candidate: string): void {
  if (!isContained(root, candidate))
    throw new ObsidianAttachmentError("Attachment path escapes the vault");
}
function isContained(root: string, candidate: string): boolean {
  const rel = relative(root, candidate);
  return (
    rel === "" ||
    (rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel))
  );
}
function mimeType(extension: string): string {
  return (
    (
      {
        ".png": "image/png",
        ".jpg": "image/jpeg",
        ".jpeg": "image/jpeg",
        ".webp": "image/webp",
        ".gif": "image/gif",
        ".pdf": "application/pdf",
        ".md": "text/markdown",
        ".txt": "text/plain",
      } as Record<string, string>
    )[extension] ?? "application/octet-stream"
  );
}
