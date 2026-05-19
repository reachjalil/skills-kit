export type SkillStatus =
  | "valid"
  | "missing_skill_md"
  | "missing_description"
  | "not_reviewed";

export type HarnessName = "codex" | "claude" | "gemini" | "cursor" | "custom";

export type SelectionMode = "symlink" | "copy" | "manifest";
export type PackageJsonOfferStatus = "ask" | "dismissed" | "configured";
export type StartupReviewStatus = "ask" | "dismissed";

export interface WorkspacePaths {
  root: string;
  agentsDir: string;
  sourceSkillsDir: string;
  kitDir: string;
  graphPath: string;
  preferencesPath: string;
  manifestsDir: string;
  reportsDir: string;
  tmpDir: string;
}

export interface SkillRecord {
  id: string;
  name: string;
  description: string;
  path: string;
  kit_ids: string[];
  tags: string[];
  notes: string;
  status: SkillStatus;
  checksum: string;
  last_scanned_at: string;
  last_reviewed_at: string;
  last_updated_at: string;
  last_activated_at: string;
}

export interface SkillKitAssignmentRecord {
  skill_id: string;
  tags: string[];
  notes: string;
  reason: string;
  added_at: string;
  updated_at: string;
  last_activated_at: string;
}

export interface SkillKitRecord {
  id: string;
  name: string;
  description: string;
  skill_ids: string[];
  skill_assignments: SkillKitAssignmentRecord[];
  tags: string[];
  created_at: string;
  updated_at: string;
}

export interface SelectionRecord {
  id: string;
  query: string;
  included_kit_ids: string[];
  included_skill_ids: string[];
  target_harness: HarnessName;
  created_at: string;
}

export interface SkillsGraph {
  version: 1;
  generated_at: string;
  source_dir: string;
  skills: SkillRecord[];
  kits: SkillKitRecord[];
  selections: SelectionRecord[];
}

export interface SkillsKitPreferences {
  version: 1;
  harness: {
    name: HarnessName;
    target_path: string;
    selection_mode: SelectionMode;
    confirm_before_write: boolean;
    managed_symlinks: boolean;
  };
  default_harnesses: HarnessTargetRecord[];
  supported_harnesses: HarnessTargetRecord[];
  startup_review: StartupReviewPreferences;
  package_json: PackageJsonPreferences;
}

export interface HarnessTargetRecord {
  name: HarnessName;
  target_path: string;
}

export interface PackageJsonPreferences {
  offer: PackageJsonOfferStatus;
  script_name: string;
  script_command: string;
  dependency_spec: string;
}

export interface StartupReviewPreferences {
  offer: StartupReviewStatus;
}

export interface ManagedSymlinkManifest {
  version: 1;
  generated_at: string;
  target_path: string;
  managed_skill_ids: string[];
  active_kit_ids: string[];
  active_skill_ids: string[];
}

export interface SymlinkAction {
  skill_id: string;
  target_path: string;
  source_path: string;
}

export interface SymlinkConflict {
  skill_id: string;
  target_path: string;
  reason: string;
}

export interface SymlinkApplyPlan {
  target_dir: string;
  selected_skill_ids: string[];
  active_kit_ids: string[];
  active_skill_ids: string[];
  create: SymlinkAction[];
  remove: SymlinkAction[];
  keep: SymlinkAction[];
  conflicts: SymlinkConflict[];
}
