import { isAbsolute, relative, resolve } from "node:path";
import type { RegisteredProject } from "../../kernel/src/master-registry.js";

export type LegacyCommandCenterConfig = Readonly<{
  schema_version: "1";
  project_id: string;
  display_name: string;
  repo_path: string;
  forge_config_path: string;
  graphify_path: string;
  stack_summary: string;
  command_center: Readonly<{ vault_path: string; command_center_path: string }>;
}>;

export type MasterMigrationInput = Readonly<{
  legacy: LegacyCommandCenterConfig;
  sharedVaultPath: string;
  now?: string;
}>;

export type MasterMigrationInspection = Readonly<{
  registryMatch?: boolean;
  workspaceExists?: boolean;
  conflict?: string;
}>;

export interface MasterMigrationAdapter {
  inspect(plan: MasterMigrationPlan): Promise<MasterMigrationInspection>;
  apply(plan: MasterMigrationPlan): Promise<unknown>;
}

export type MasterMigrationPlan = Readonly<{
  schema_version: "1";
  status: "READY" | "UNCHANGED" | "CONFLICT";
  registry_project: RegisteredProject;
  legacy_command_center_path: string;
  actions: readonly Readonly<{
    action: "CREATE" | "REGISTER" | "REFERENCE_LEGACY";
    target: string;
    source?: string;
  }>[];
  conflicts: readonly string[];
}>;

function contained(root: string, path: string): string {
  if (!isAbsolute(root)) throw new Error("MIGRATION_VAULT_PATH_INVALID");
  const target = resolve(root, path);
  const rel = relative(resolve(root), target);
  if (rel.startsWith("..") || isAbsolute(rel))
    throw new Error("MIGRATION_PATH_ESCAPE");
  return target;
}

function basePlan(input: MasterMigrationInput): MasterMigrationPlan {
  if (!/^[a-z0-9][a-z0-9-]{0,62}$/u.test(input.legacy.project_id))
    throw new Error("MIGRATION_PROJECT_ID_INVALID");
  if (
    !input.legacy.display_name ||
    /[\\/]|^\.{1,2}$/u.test(input.legacy.display_name)
  )
    throw new Error("MIGRATION_PROJECT_NAME_INVALID");
  if (
    resolve(input.legacy.command_center.vault_path) !==
    resolve(input.sharedVaultPath)
  )
    throw new Error("MIGRATION_VAULT_CONFLICT");
  const legacyPath = contained(
    input.sharedVaultPath,
    input.legacy.command_center.command_center_path,
  );
  const workspace = contained(
    input.sharedVaultPath,
    `Projects/${input.legacy.display_name}`,
  );
  const at = input.now ?? new Date().toISOString();
  const registryProject = Object.freeze({
    project_id: input.legacy.project_id,
    display_name: input.legacy.display_name,
    repo_path: input.legacy.repo_path,
    forge_config_path: input.legacy.forge_config_path,
    graphify_path: input.legacy.graphify_path,
    obsidian_project_path: workspace,
    stack_summary: input.legacy.stack_summary,
    registration_status: "ACTIVE" as const,
    aliases: [] as string[],
    registered_at: at,
    updated_at: at,
    record_version: 1,
  });
  return Object.freeze({
    schema_version: "1",
    status: "READY",
    registry_project: registryProject,
    legacy_command_center_path: legacyPath,
    actions: Object.freeze([
      Object.freeze({ action: "CREATE" as const, target: workspace }),
      Object.freeze({
        action: "REGISTER" as const,
        target: input.legacy.project_id,
      }),
      Object.freeze({
        action: "REFERENCE_LEGACY" as const,
        target: workspace,
        source: legacyPath,
      }),
    ]),
    conflicts: Object.freeze([]),
  });
}

export function planMasterMigration(
  input: MasterMigrationInput,
): MasterMigrationPlan;
export function planMasterMigration(
  input: MasterMigrationInput,
  adapter: MasterMigrationAdapter,
): Promise<MasterMigrationPlan>;
export function planMasterMigration(
  input: MasterMigrationInput,
  adapter?: MasterMigrationAdapter,
): MasterMigrationPlan | Promise<MasterMigrationPlan> {
  const plan = basePlan(input);
  if (!adapter) return plan;
  return adapter.inspect(plan).then((inspection) => {
    if (inspection.conflict)
      return Object.freeze({
        ...plan,
        status: "CONFLICT" as const,
        conflicts: Object.freeze([inspection.conflict]),
      });
    if (inspection.registryMatch && inspection.workspaceExists)
      return Object.freeze({
        ...plan,
        status: "UNCHANGED" as const,
        actions: Object.freeze([]),
      });
    const actions = plan.actions.filter(
      (action) =>
        !(inspection.workspaceExists && action.action === "CREATE") &&
        !(inspection.registryMatch && action.action === "REGISTER"),
    );
    return Object.freeze({ ...plan, actions: Object.freeze(actions) });
  });
}

export async function applyMasterMigration(
  plan: MasterMigrationPlan,
  adapter: MasterMigrationAdapter,
  options: Readonly<{ dryRun?: boolean; approved?: boolean }> = {},
): Promise<
  Readonly<{
    status: "DRY_RUN" | "UNCHANGED" | "APPLIED";
    plan: MasterMigrationPlan;
  }>
> {
  if (plan.status === "CONFLICT") throw new Error("MIGRATION_CONFLICT");
  if (options.dryRun) return Object.freeze({ status: "DRY_RUN", plan });
  if (plan.status === "UNCHANGED")
    return Object.freeze({ status: "UNCHANGED", plan });
  if (!options.approved) throw new Error("MIGRATION_APPROVAL_REQUIRED");
  await adapter.apply(plan);
  return Object.freeze({ status: "APPLIED", plan });
}
