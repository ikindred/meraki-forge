import { GitAdapter } from "./git-adapter.js";
import type { CandidateVerifier } from "../../execution/src/validation-orchestrator.js";

/** Binds every validation operation to an unchanged, clean local candidate. */
export class GitCandidateVerifier implements CandidateVerifier {
  constructor(private readonly worktree: string) {}

  async assertCurrent(candidateSha: string): Promise<void> {
    const git = new GitAdapter(this.worktree);
    if ((await git.candidateCommit()) !== candidateSha)
      throw new Error("VALIDATION_CANDIDATE_CHANGED");
    if (!(await git.isClean())) throw new Error("VALIDATION_WORKTREE_DIRTY");
  }
}
