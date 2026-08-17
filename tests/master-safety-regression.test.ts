import { describe, expect, it } from "vitest";
import {
  assertContainedProjectPath,
  assertSingleProjectWrite,
  PROJECT_OPERATION_STAGES,
} from "../packages/kernel/src/project-operation.js";

describe("master command center workflow safety", () => {
  it("forbids a write routed to a different project", () => {
    expect(() =>
      assertSingleProjectWrite("/projects/kyra", "/projects/valet"),
    ).toThrow("CROSS_PROJECT_WRITE_FORBIDDEN");
    expect(() =>
      assertSingleProjectWrite("/projects/kyra", "/projects/kyra"),
    ).not.toThrow();
  });

  it("requires Graphify and other project paths to remain contained", () => {
    expect(() =>
      assertContainedProjectPath(
        "/projects/kyra",
        "/projects/kyra/graphify-out",
      ),
    ).not.toThrow();
    expect(() =>
      assertContainedProjectPath(
        "/projects/kyra",
        "/projects/valet/graphify-out",
      ),
    ).toThrow("PROJECT_PATH_ESCAPE");
  });

  it("contains no merge, deploy, push, remote-mutation, or scheduler stages", () => {
    expect(PROJECT_OPERATION_STAGES.join(" ")).not.toMatch(
      /MERGE|DEPLOY|PUSH|REMOTE|SCHEDULER/u,
    );
  });
});
