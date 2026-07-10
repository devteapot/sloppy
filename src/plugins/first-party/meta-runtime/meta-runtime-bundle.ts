import { createHash } from "node:crypto";

import { now } from "../shared/runtime-helpers";
import type { MetaScope, PersistedState } from "./meta-runtime-model";
import { parsePersistedState } from "./meta-runtime-ops";

export type RuntimeBundleSkillFile = {
  path: string;
  content: string;
  sha256?: string;
};

export type RuntimeBundleSkill = {
  name: string;
  version?: string;
  scope?: string;
  content: string;
  content_sha256?: string;
  files: RuntimeBundleSkillFile[];
};

export type RuntimeBundle = {
  kind: "sloppy.meta-runtime.bundle";
  schema_version: 1;
  exported_at: string;
  scope: MetaScope | "merged";
  state: PersistedState;
  skills: RuntimeBundleSkill[];
  notes: {
    secrets: "excluded";
  };
};

export type SkillImportSummary = {
  created: string[];
  skipped: string[];
  failed: Array<{ name: string; reason: string }>;
  skippedFiles: Array<{ name: string; path: string; reason: string }>;
};

export function sha256(content: string): string {
  return createHash("sha256").update(content, "utf8").digest("hex");
}

export function emptySkillImportSummary(): SkillImportSummary {
  return { created: [], skipped: [], failed: [], skippedFiles: [] };
}

function validateBundleHash(label: string, content: string, expected: unknown): string | undefined {
  if (expected === undefined) {
    return undefined;
  }
  if (typeof expected !== "string" || expected.trim() === "") {
    throw new Error(`${label} must be a non-empty string when provided.`);
  }
  const actual = sha256(content);
  if (expected !== actual) {
    throw new Error(`${label} does not match bundled content.`);
  }
  return expected;
}

function validateBundleFilePath(path: string, label: string): void {
  if (path.startsWith("/") || path.startsWith("\\") || path.split(/[\\/]+/).includes("..")) {
    throw new Error(`${label} must be a relative path inside the skill directory.`);
  }
}

export function parseRuntimeBundle(raw: unknown): RuntimeBundle {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    throw new Error("bundle must be an object.");
  }
  const record = raw as Record<string, unknown>;
  if (record.kind !== "sloppy.meta-runtime.bundle") {
    throw new Error("bundle.kind must be sloppy.meta-runtime.bundle.");
  }
  if (record.schema_version !== 1) {
    throw new Error("bundle.schema_version must be 1.");
  }
  const state = record.state;
  if (!state || typeof state !== "object" || Array.isArray(state)) {
    throw new Error("bundle.state must be an object.");
  }
  const rawSkills = Array.isArray(record.skills) ? record.skills : [];
  const skills: RuntimeBundleSkill[] = rawSkills.map((entry, index) => {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
      throw new Error(`bundle.skills[${index}] must be an object.`);
    }
    const skill = entry as Record<string, unknown>;
    if (typeof skill.name !== "string" || skill.name.trim() === "") {
      throw new Error(`bundle.skills[${index}].name must be a non-empty string.`);
    }
    if (typeof skill.content !== "string" || skill.content.trim() === "") {
      throw new Error(`bundle.skills[${index}].content must be a non-empty string.`);
    }
    return {
      name: skill.name,
      version: typeof skill.version === "string" ? skill.version : undefined,
      scope: typeof skill.scope === "string" ? skill.scope : undefined,
      content: skill.content,
      content_sha256: validateBundleHash(
        `bundle.skills[${index}].content_sha256`,
        skill.content,
        skill.content_sha256,
      ),
      files: parseBundleSkillFiles(skill.files, index),
    };
  });
  return {
    kind: "sloppy.meta-runtime.bundle",
    schema_version: 1,
    exported_at: typeof record.exported_at === "string" ? record.exported_at : now(),
    scope:
      record.scope === "global" || record.scope === "workspace" || record.scope === "session"
        ? record.scope
        : "merged",
    state: parsePersistedState(state),
    skills,
    notes: { secrets: "excluded" },
  };
}

function parseBundleSkillFiles(raw: unknown, skillIndex: number): RuntimeBundleSkillFile[] {
  if (raw === undefined) return [];
  if (!Array.isArray(raw)) {
    throw new Error(`bundle.skills[${skillIndex}].files must be an array.`);
  }
  return raw.map((entry, fileIndex) => {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
      throw new Error(`bundle.skills[${skillIndex}].files[${fileIndex}] must be an object.`);
    }
    const file = entry as Record<string, unknown>;
    if (typeof file.path !== "string" || file.path.trim() === "") {
      throw new Error(
        `bundle.skills[${skillIndex}].files[${fileIndex}].path must be a non-empty string.`,
      );
    }
    validateBundleFilePath(file.path, `bundle.skills[${skillIndex}].files[${fileIndex}].path`);
    if (typeof file.content !== "string") {
      throw new Error(`bundle.skills[${skillIndex}].files[${fileIndex}].content must be a string.`);
    }
    return {
      path: file.path,
      content: file.content,
      sha256: validateBundleHash(
        `bundle.skills[${skillIndex}].files[${fileIndex}].sha256`,
        file.content,
        file.sha256,
      ),
    };
  });
}
