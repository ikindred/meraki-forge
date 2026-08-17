import { describe, expect, it } from "vitest";
import { createSchedulerBootstrap } from "../packages/execution/src/project-doctor.js";

describe("scheduler bootstrap", () => {
  it("reports exact human setup when no stable provider writer is configured", async () => {
    const result = await createSchedulerBootstrap({
      provider: "codex",
      timezone: "Asia/Manila",
    });
    expect(result.status).toBe("HUMAN_SETUP_REQUIRED");
    expect(result.mutated).toBe(false);
    expect(result.instructions).toContain("DAILY_PM");
    expect(result.instructions).toContain("Asia/Manila");
  });

  it("uses only the injected provider writer and reports its truthful result", async () => {
    let called = 0;
    const result = await createSchedulerBootstrap({
      provider: "test",
      timezone: "UTC",
      automatic_writer: () => {
        called += 1;
        return Promise.resolve({ configured: true });
      },
    });
    expect(called).toBe(1);
    expect(result.status).toBe("CONFIGURED");
    expect(result.mutated).toBe(true);
  });
});
