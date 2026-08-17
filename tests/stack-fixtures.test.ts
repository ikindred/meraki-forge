import { readFile, readdir } from "node:fs/promises";
import { join, relative } from "node:path";
import { describe, expect, it } from "vitest";
import { detectStack, type RepoFile } from "../packages/kernel/src/index.js";

const fixtureRoot = join(import.meta.dirname, "fixtures/repos");
async function files(root: string): Promise<RepoFile[]> {
  const entries = await readdir(root, { withFileTypes: true });
  const nested = await Promise.all(
    entries.map(async (entry): Promise<RepoFile[]> => {
      const path = join(root, entry.name);
      return entry.isDirectory()
        ? files(path)
        : [
            {
              path: relative(root, path),
              content: await readFile(path, "utf8"),
            },
          ];
    }),
  );
  return nested.flat();
}

describe("stack discovery fixtures", () => {
  it.each([
    [
      "nextjs-supabase",
      ["Next.js", "React", "Supabase/PostgreSQL", "Playwright"],
    ],
    ["laravel-react", ["Laravel", "React"]],
    ["flutter-laravel", ["Flutter", "Laravel"]],
    ["python-fastapi", ["Python", "FastAPI"]],
    ["java-spring", ["Java", "Spring"]],
    ["dotnet", ["C#", ".NET"]],
    ["go", ["Go"]],
  ] as const)(
    "detects %s without assuming a single language",
    async (name, expected) => {
      const profile = detectStack(await files(join(fixtureRoot, name)));
      expect(profile.evidence.map((item) => item.name)).toEqual(
        expect.arrayContaining([...expected]),
      );
    },
  );

  it("reports unknown fixtures explicitly", async () => {
    expect(detectStack(await files(join(fixtureRoot, "unknown"))).unknown).toBe(
      true,
    );
  });
});
