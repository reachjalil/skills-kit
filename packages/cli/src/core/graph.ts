import { mkdir, readFile, writeFile } from "node:fs/promises";
import { parse, stringify } from "smol-toml";

import { slugifyId } from "../utils/paths";
import type {
  SelectionRecord,
  SkillKitAssignmentRecord,
  SkillKitRecord,
  SkillRecord,
  SkillsGraph,
  WorkspacePaths,
} from "../types";

export function createEmptyGraph(now = new Date()): SkillsGraph {
  return {
    version: 1,
    generated_at: now.toISOString(),
    source_dir: "./.agents/skills",
    skills: [],
    kits: [],
    selections: [],
  };
}

export async function loadGraph(paths: WorkspacePaths): Promise<SkillsGraph> {
  const raw = await readFile(paths.graphPath, "utf8").catch(() => "");
  if (!raw.trim()) {
    return createEmptyGraph();
  }

  const parsed = parse(raw) as Partial<SkillsGraph>;
  return normalizeGraph(parsed);
}

export async function saveGraph(
  paths: WorkspacePaths,
  graph: SkillsGraph
): Promise<void> {
  await mkdir(paths.kitDir, { recursive: true });
  await writeFile(paths.graphPath, stringify(graph), "utf8");
}

export function mergeScannedSkills(
  existing: SkillsGraph,
  scanned: SkillRecord[],
  now = new Date()
): SkillsGraph {
  const existingById = new Map(
    existing.skills.map((skill) => [skill.id, skill])
  );
  const kitIdsBySkill = new Map<string, string[]>();

  for (const kit of existing.kits) {
    for (const skillId of kit.skill_ids) {
      const kitIds = kitIdsBySkill.get(skillId) ?? [];
      kitIds.push(kit.id);
      kitIdsBySkill.set(skillId, kitIds);
    }
  }

  const skills = scanned.map((skill) => {
    const previous = existingById.get(skill.id);
    return {
      ...skill,
      kit_ids: kitIdsBySkill.get(skill.id) ?? previous?.kit_ids ?? [],
      tags: previous?.tags ?? [],
      notes: previous?.notes ?? "",
      last_reviewed_at: previous?.last_reviewed_at ?? "",
      last_activated_at: previous?.last_activated_at ?? "",
    };
  });

  const validSkillIds = new Set(skills.map((skill) => skill.id));
  const kits = existing.kits.map((kit) => ({
    ...kit,
    skill_ids: kit.skill_ids.filter((skillId) => validSkillIds.has(skillId)),
  }));

  return {
    ...existing,
    generated_at: now.toISOString(),
    skills,
    kits,
  };
}

export function upsertKit(
  graph: SkillsGraph,
  input: {
    name: string;
    description?: string;
    skillIds: string[];
    tags?: string[];
    reason?: string;
    notes?: string;
    now?: Date;
  }
): SkillsGraph {
  const nowIso = (input.now ?? new Date()).toISOString();
  const id = slugifyId(input.name);
  const existing = graph.kits.find((kit) => kit.id === id);
  const skillIds = uniqueSorted(input.skillIds);
  const existingAssignmentsBySkill = new Map(
    (existing?.skill_assignments ?? []).map((assignment) => [
      assignment.skill_id,
      assignment,
    ])
  );
  const assignmentTags = input.tags ?? existing?.tags ?? [];
  const skillAssignments = skillIds.map((skillId) => {
    const existingAssignment = existingAssignmentsBySkill.get(skillId);
    return {
      skill_id: skillId,
      tags: existingAssignment?.tags ?? assignmentTags,
      notes: input.notes ?? existingAssignment?.notes ?? "",
      reason: input.reason ?? existingAssignment?.reason ?? "",
      added_at: existingAssignment?.added_at ?? nowIso,
      updated_at: nowIso,
      last_activated_at: existingAssignment?.last_activated_at ?? "",
    };
  });
  const nextKit: SkillKitRecord = existing
    ? {
        ...existing,
        description: input.description ?? existing.description,
        skill_ids: skillIds,
        skill_assignments: skillAssignments,
        tags: input.tags ?? existing.tags,
        updated_at: nowIso,
      }
    : {
        id,
        name: input.name.trim(),
        description: input.description ?? "",
        skill_ids: skillIds,
        skill_assignments: skillAssignments,
        tags: input.tags ?? [],
        created_at: nowIso,
        updated_at: nowIso,
      };

  const kits = existing
    ? graph.kits.map((kit) => (kit.id === id ? nextKit : kit))
    : [...graph.kits, nextKit].toSorted((a, b) => a.name.localeCompare(b.name));

  return syncSkillKitIds({
    ...graph,
    generated_at: nowIso,
    kits,
  });
}

export function addSelection(
  graph: SkillsGraph,
  selection: SelectionRecord
): SkillsGraph {
  return {
    ...graph,
    generated_at: selection.created_at,
    selections: [...graph.selections, selection],
  };
}

export function markSkillsActivated(
  graph: SkillsGraph,
  input: {
    kitIds: string[];
    skillIds: string[];
    activatedAt: string;
  }
): SkillsGraph {
  const activeKitIds = new Set(input.kitIds.map(slugifyId));
  const activeSkillIds = new Set(input.skillIds);

  return syncSkillKitIds({
    ...graph,
    generated_at: input.activatedAt,
    skills: graph.skills.map((skill) => ({
      ...skill,
      last_activated_at: activeSkillIds.has(skill.id)
        ? input.activatedAt
        : skill.last_activated_at,
    })),
    kits: graph.kits.map((kit) => {
      if (!activeKitIds.has(kit.id)) {
        return kit;
      }

      return {
        ...kit,
        skill_assignments: kit.skill_assignments.map((assignment) => ({
          ...assignment,
          last_activated_at: activeSkillIds.has(assignment.skill_id)
            ? input.activatedAt
            : assignment.last_activated_at,
        })),
      };
    }),
  });
}

export function resolveSkillIdsFromKits(
  graph: SkillsGraph,
  kitIds: string[]
): string[] {
  const requested = new Set(kitIds.map(slugifyId));
  const selected = new Set<string>();

  for (const kit of graph.kits) {
    if (!requested.has(kit.id)) {
      continue;
    }
    for (const skillId of kit.skill_ids) {
      selected.add(skillId);
    }
  }

  return [...selected].toSorted();
}

export function syncSkillKitIds(graph: SkillsGraph): SkillsGraph {
  const kitIdsBySkill = new Map<string, string[]>();
  for (const kit of graph.kits) {
    for (const skillId of kit.skill_ids) {
      const kitIds = kitIdsBySkill.get(skillId) ?? [];
      kitIds.push(kit.id);
      kitIdsBySkill.set(skillId, kitIds);
    }
  }

  return {
    ...graph,
    skills: graph.skills.map((skill) => ({
      ...skill,
      kit_ids: (kitIdsBySkill.get(skill.id) ?? []).toSorted(),
    })),
  };
}

function normalizeGraph(input: Partial<SkillsGraph>): SkillsGraph {
  return syncSkillKitIds({
    version: 1,
    generated_at: stringValue(input.generated_at),
    source_dir: stringValue(input.source_dir, "./.agents/skills"),
    skills: arrayValue(input.skills).map(normalizeSkill),
    kits: arrayValue(input.kits).map(normalizeKit),
    selections: arrayValue(input.selections).map(normalizeSelection),
  });
}

function normalizeSkill(input: Partial<SkillRecord>): SkillRecord {
  return {
    id: stringValue(input.id),
    name: stringValue(input.name, stringValue(input.id)),
    description: stringValue(input.description),
    path: stringValue(input.path),
    kit_ids: arrayValue(input.kit_ids).map(String),
    tags: arrayValue(input.tags).map(String),
    notes: stringValue(input.notes),
    status: input.status ?? "not_reviewed",
    checksum: stringValue(input.checksum),
    last_scanned_at: stringValue(input.last_scanned_at),
    last_reviewed_at: stringValue(input.last_reviewed_at),
    last_updated_at: stringValue(input.last_updated_at),
    last_activated_at: stringValue(input.last_activated_at),
  };
}

function normalizeKit(input: Partial<SkillKitRecord>): SkillKitRecord {
  const now = new Date(0).toISOString();
  const skillIds = arrayValue(input.skill_ids).map(String);
  return {
    id: stringValue(input.id, slugifyId(stringValue(input.name))),
    name: stringValue(input.name),
    description: stringValue(input.description),
    skill_ids: skillIds,
    skill_assignments: normalizeSkillAssignments(
      input.skill_assignments,
      skillIds,
      now
    ),
    tags: arrayValue(input.tags).map(String),
    created_at: stringValue(input.created_at, now),
    updated_at: stringValue(input.updated_at, now),
  };
}

function normalizeSkillAssignments(
  input: SkillKitAssignmentRecord[] | undefined,
  skillIds: string[],
  fallbackDate: string
): SkillKitAssignmentRecord[] {
  const bySkillId = new Map(
    arrayValue(input).map((assignment) => [
      String(assignment.skill_id),
      assignment,
    ])
  );

  return skillIds.map((skillId) => {
    const assignment = bySkillId.get(skillId);
    return {
      skill_id: skillId,
      tags: arrayValue(assignment?.tags).map(String),
      notes: stringValue(assignment?.notes),
      reason: stringValue(assignment?.reason),
      added_at: stringValue(assignment?.added_at, fallbackDate),
      updated_at: stringValue(assignment?.updated_at, fallbackDate),
      last_activated_at: stringValue(assignment?.last_activated_at),
    };
  });
}

function normalizeSelection(input: Partial<SelectionRecord>): SelectionRecord {
  return {
    id: stringValue(input.id),
    query: stringValue(input.query),
    included_kit_ids: arrayValue(input.included_kit_ids).map(String),
    included_skill_ids: arrayValue(input.included_skill_ids).map(String),
    target_harness: input.target_harness ?? "codex",
    created_at: stringValue(input.created_at),
  };
}

function uniqueSorted(values: string[]): string[] {
  return [...new Set(values.filter(Boolean))].toSorted();
}

function stringValue(value: unknown, fallback = ""): string {
  return typeof value === "string" ? value : fallback;
}

function arrayValue<T>(value: T[] | undefined): T[] {
  return Array.isArray(value) ? value : [];
}
