import { SafeStateStore } from "../../adapters/src/safe-state-store.js";
import {
  CoordinatorStateSchema,
  type CoordinatorState,
  type CoordinatorStore,
} from "./coordinator.js";

export class DurableCoordinatorStore implements CoordinatorStore {
  readonly #states: SafeStateStore<CoordinatorState>;
  constructor(repositoryRoot: string) {
    this.#states = new SafeStateStore(repositoryRoot, CoordinatorStateSchema);
  }
  load(taskId: string): Promise<CoordinatorState> {
    return this.#states.load(taskId);
  }
  save(state: CoordinatorState, expectedRevision: number): Promise<void> {
    return this.#states.save(state.task_id, state, expectedRevision);
  }
  initialize(state: CoordinatorState): Promise<void> {
    return this.#states.save(state.task_id, state);
  }
}
