// Coding-domain task planning heuristics for the orchestrator role.
//
// These classifiers and the inferred-dependency policy are intentionally
// outside the generic orchestration provider: the provider validates
// explicit dependencies but does not invent edges. The orchestrator role
// applies this policy as a pre-invocation transform on `create_tasks`.

import { normalizeReference } from "../../providers/builtin/orchestration/normalization";

export type PlanningTask = {
  name: string;
  goal: string;
  client_ref?: string;
};

export type PlanningTaskWithDeps = PlanningTask & {
  id: string;
  depends_on?: string[];
};

function uniqueStrings(values: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const value of values) {
    const normalized = normalizeReference(value);
    if (seen.has(normalized)) continue;
    seen.add(normalized);
    out.push(value);
  }
  return out;
}

function taskSearchText(task: PlanningTask): string {
  return `${task.name} ${task.goal} ${task.client_ref ?? ""}`.toLowerCase();
}

function hasTerm(text: string, terms: RegExp[]): boolean {
  return terms.some((term) => term.test(text));
}

export function isDocumentationTask(task: PlanningTask): boolean {
  return hasTerm(taskSearchText(task), [
    /\breadme\b/,
    /\bdocs?\b/,
    /\bdocumentation\b/,
    /\busage guide\b/,
    /\bsetup instructions\b/,
  ]);
}

export function isVerificationTask(task: PlanningTask): boolean {
  const text = taskSearchText(task);
  return hasTerm(text, [
    /\bverify\b/,
    /\bverification\b/,
    /\bvalidate\b/,
    /\bsmoke\b/,
    /\btest suite\b/,
    /\blint\b/,
    /\btypecheck\b/,
    /\bbuild passes\b/,
    /\bbuild verification\b/,
    /\brun (?:npm|bun|pnpm|yarn) (?:run )?build\b/,
  ]);
}

export function isScaffoldTask(task: PlanningTask): boolean {
  return hasTerm(taskSearchText(task), [
    /\bscaffold\b/,
    /\bbootstrap\b/,
    /\binitiali[sz]e\b/,
    /\bsetup project\b/,
    /\bcreate (?:a |the )?(?:vite|react|next|node|bun|typescript).*project\b/,
    /\bproject structure\b/,
  ]);
}

export function isDataModelTask(task: PlanningTask): boolean {
  return hasTerm(taskSearchText(task), [
    /\bdata model\b/,
    /\bseed data\b/,
    /\bschema\b/,
    /\btypes?\b/,
    /\bstore\b/,
    /\bstate management\b/,
    /\bcontext\b/,
  ]);
}

export function isUiTask(task: PlanningTask): boolean {
  return hasTerm(taskSearchText(task), [
    /\bui\b/,
    /\bfrontend\b/,
    /\bcomponents?\b/,
    /\bviews?\b/,
    /\bscreens?\b/,
    /\blayout\b/,
    /\bboard\b/,
    /\bcards?\b/,
    /\bforms?\b/,
  ]);
}

/**
 * Pure version of the coding-domain dependency inference.
 *
 * Given a batch of task drafts (each carrying a stable identifier — usually
 * the task's `client_ref` or a synthetic batch id — and any explicit
 * `depends_on` already supplied), returns a map from draft id to the
 * augmented `depends_on` list. Does not mutate inputs.
 *
 * Invariants:
 *   - Pre-existing edges are preserved.
 *   - Self-edges are never introduced.
 *   - When the batch does not look like a coding plan, the input edges are
 *     returned unchanged.
 */
export function inferBatchDependencyRefs(drafts: PlanningTaskWithDeps[]): Map<string, string[]> {
  const dependencies = new Map<string, string[]>();
  for (const draft of drafts) {
    dependencies.set(draft.id, [...(draft.depends_on ?? [])]);
  }

  const addDependency = (draft: PlanningTaskWithDeps, dependency: PlanningTaskWithDeps): void => {
    if (draft.id === dependency.id) return;
    const current = dependencies.get(draft.id) ?? [];
    current.push(dependency.id);
    dependencies.set(draft.id, uniqueStrings(current));
  };

  const producerTasks = drafts.filter(
    (draft) => !isDocumentationTask(draft) && !isVerificationTask(draft),
  );
  const scaffoldTasks = producerTasks.filter(isScaffoldTask);
  const dataModelTasks = producerTasks.filter(
    (draft) => isDataModelTask(draft) && !isScaffoldTask(draft),
  );
  const codingPlan =
    scaffoldTasks.length > 0 ||
    dataModelTasks.length > 0 ||
    producerTasks.some(isUiTask) ||
    drafts.some(isVerificationTask);
  if (!codingPlan) {
    return dependencies;
  }

  for (const draft of drafts) {
    if (isDocumentationTask(draft)) {
      for (const dependency of producerTasks) {
        addDependency(draft, dependency);
      }
      continue;
    }

    if (isVerificationTask(draft)) {
      for (const dependency of producerTasks) {
        addDependency(draft, dependency);
      }
      continue;
    }

    if (!isScaffoldTask(draft)) {
      for (const dependency of scaffoldTasks) {
        addDependency(draft, dependency);
      }
    }
  }

  return dependencies;
}
