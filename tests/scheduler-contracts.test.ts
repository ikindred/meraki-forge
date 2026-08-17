import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";

const files = [
  "templates/scheduler/DAILY_PM.md",
  "templates/scheduler/ENGINEERING_COORDINATOR.md",
  "templates/scheduler/END_OF_DAY_REPORT.md",
] as const;

describe("Phase 4 scheduler contracts", () => {
  it("keeps prompts small, repository-managed, and free of delivery authority", async () => {
    for (const file of files) {
      const content = await readFile(file, "utf8");
      expect(content.length).toBeLessThan(1_200);
      expect(content).toContain("docs/architecture/FORGE_CONSTITUTION.md");
      expect(content).not.toMatch(
        /auto[-_ ]?merge|deploy production|force[-_ ]?push/i,
      );
      expect(content).not.toContain("# Meraki Forge Constitution");
    }
  });

  it("declares only the requested scheduling intent", async () => {
    await expect(readFile(files[0], "utf8")).resolves.toContain(
      "08:00 weekdays",
    );
    await expect(readFile(files[1], "utf8")).resolves.toContain("periodic");
    await expect(readFile(files[2], "utf8")).resolves.toContain(
      "19:15 weekdays",
    );
  });
});
