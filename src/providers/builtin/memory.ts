import { action, createSlopServer, type ItemDescriptor, type SlopServer } from "@slop-ai/server";

import { createApprovalRequiredError, ProviderApprovalManager } from "../approvals";

type MemoryItem = {
  id: string;
  content: string;
  tags: string[];
  weight: number;
  created_at: string;
  updated_at: string;
  ttl?: string;
};

type SearchResult = {
  id: string;
  content: string;
  tags: string[];
  weight: number;
  created_at: string;
  updated_at: string;
  ttl?: string;
  score: number;
};

function now(): string {
  return new Date().toISOString();
}

function buildMemoryId(): string {
  return `mem-${crypto.randomUUID()}`;
}

function contentPreview(content: string, maxChars = 120): string {
  if (content.length <= maxChars) return content;
  return `${content.slice(0, maxChars - 3)}...`;
}

function clampWeight(w: number): number {
  return Math.max(0, Math.min(1, w));
}

function fuzzyScore(memory: MemoryItem, query: string): number {
  const terms = query.toLowerCase().split(/\s+/).filter(Boolean);
  if (terms.length === 0) return 1;
  const haystack = `${memory.content} ${memory.tags.join(" ")}`.toLowerCase();
  const matched = terms.filter((t) => haystack.includes(t)).length;
  return matched / terms.length;
}

function tagOverlap(a: MemoryItem, b: MemoryItem): number {
  const setB = new Set(b.tags);
  return a.tags.filter((t) => setB.has(t)).length;
}

export class MemoryProvider {
  readonly server: SlopServer;
  readonly approvals: ProviderApprovalManager;
  private memories: MemoryItem[] = [];
  private maxMemories: number;
  private defaultWeight: number;
  private compactThreshold: number;

  constructor(options: {
    maxMemories?: number;
    defaultWeight?: number;
    compactThreshold?: number;
  }) {
    this.maxMemories = options.maxMemories ?? 500;
    this.defaultWeight = options.defaultWeight ?? 0.5;
    this.compactThreshold = options.compactThreshold ?? 0.3;

    this.server = createSlopServer({
      id: "memory",
      name: "Memory",
    });
    this.approvals = new ProviderApprovalManager(this.server);

    this.server.register("session", () => this.buildSessionDescriptor());
    this.server.register("memories", () => this.buildMemoriesDescriptor());
    this.server.register("tags", () => this.buildTagsDescriptor());
    this.server.register("approvals", () => this.approvals.buildDescriptor());
  }

  stop(): void {
    this.server.stop();
  }

  private buildSessionDescriptor() {
    const tagSet = new Set(this.memories.flatMap((m) => m.tags));
    const totalWeight = this.memories.reduce((sum, m) => sum + m.weight, 0);

    return {
      type: "context",
      props: {
        total_count: this.memories.length,
        tag_count: tagSet.size,
        total_weight: Math.round(totalWeight * 1000) / 1000,
      },
      summary: "Long-term memory store for the agent.",
      actions: {
        add_memory: action(
          {
            content: "string",
            tags: {
              type: "array",
              description: "Categorization tags for this memory.",
              items: { type: "string" },
            },
            weight: {
              type: "number",
              description: `Importance weight (0–1). Defaults to ${this.defaultWeight}.`,
            },
            ttl: {
              type: "string",
              description: "Optional ISO timestamp after which this memory may be pruned.",
              optional: true,
            },
          },
          async ({ content, tags, weight, ttl }) =>
            this.addMemory({
              content,
              tags: Array.isArray(tags) ? (tags as string[]) : [],
              weight: typeof weight === "number" ? weight : this.defaultWeight,
              ttl: typeof ttl === "string" ? ttl : undefined,
            }),
          {
            label: "Add Memory",
            description: "Store a new memory in the long-term memory bank.",
            estimate: "instant",
          },
        ),
        search: action(
          {
            query: "string",
            tags: {
              type: "array",
              description: "Restrict results to memories containing all of these tags.",
              items: { type: "string" },
            },
            limit: {
              type: "number",
              description: "Maximum number of results to return (default 10).",
            },
          },
          async ({ query, tags, limit }) =>
            this.searchMemories(
              query,
              Array.isArray(tags) ? (tags as string[]) : [],
              typeof limit === "number" ? limit : 10,
            ),
          {
            label: "Search Memories",
            description: "Fuzzy-search the memory store by content or tags.",
            idempotent: true,
            estimate: "fast",
          },
        ),
        forget_weak: action(
          {
            threshold: {
              type: "number",
              description: `Remove memories below this weight (default: ${this.compactThreshold}).`,
            },
          },
          async ({ threshold }) =>
            this.forgetWeak(typeof threshold === "number" ? threshold : this.compactThreshold),
          {
            label: "Forget Weak",
            description: "Permanently remove all memories below the given weight threshold.",
            dangerous: true,
            estimate: "fast",
          },
        ),
        clear_all: action(
          {},
          async () => {
            // Caller-controlled bypass parameters are unsafe (model can spoof
            // them); always route through the provider approval queue. The
            // approval `execute` callback invokes `clearAll` directly, not
            // back through this descriptor, so there is no recursive bypass.
            const approvalId = this.approvals.request({
              path: "/session",
              action: "clear_all",
              reason: "Clearing all memories is irreversible and cannot be undone.",
              paramsPreview: "{}",
              dangerous: true,
              execute: () => this.clearAll(),
            });
            throw createApprovalRequiredError(
              `Clearing all memories requires approval via /approvals/${approvalId}.`,
            );
          },
          {
            label: "Clear All",
            description: "Permanently delete every memory in the store.",
            dangerous: true,
            estimate: "instant",
          },
        ),
        compact: action(async () => this.compact(), {
          label: "Compact",
          description: "Merge similar low-weight memories to reduce bloat.",
          estimate: "fast",
        }),
      },
      meta: {
        focus: true,
        salience: 0.8,
      },
    };
  }

  private buildMemoriesDescriptor() {
    const items: ItemDescriptor[] = this.memories
      .filter((m) => m.weight < this.compactThreshold)
      .sort((a, b) => b.updated_at.localeCompare(a.updated_at))
      .map((memory) => ({
        id: memory.id,
        props: {
          id: memory.id,
          content_preview: contentPreview(memory.content),
          tags: memory.tags,
          weight: memory.weight,
          created_at: memory.created_at,
          updated_at: memory.updated_at,
          ...(memory.ttl !== undefined ? { ttl: memory.ttl } : {}),
        },
        summary: contentPreview(memory.content, 80),
        actions: {
          update_memory: action(
            {
              content: {
                type: "string",
                description: "Replacement content for this memory.",
              },
              tags: {
                type: "array",
                description: "Replacement tag list.",
                items: { type: "string" },
              },
              weight: {
                type: "number",
                description: "Replacement weight (0–1).",
              },
            },
            async ({ content, tags, weight }) =>
              this.updateMemory(memory.id, {
                content: typeof content === "string" ? content : undefined,
                tags: Array.isArray(tags) ? (tags as string[]) : undefined,
                weight: typeof weight === "number" ? weight : undefined,
              }),
            {
              label: "Update Memory",
              description: "Edit the content, tags, or weight of this memory.",
              estimate: "instant",
            },
          ),
          delete_memory: action(async () => this.deleteMemory(memory.id), {
            label: "Delete Memory",
            description: "Permanently remove this memory.",
            dangerous: true,
            estimate: "instant",
          }),
        },
      }));

    return {
      type: "collection",
      props: {
        count: items.length,
      },
      summary: "Low-weight memories that are candidates for compaction or deletion.",
      items,
    };
  }

  private buildTagsDescriptor() {
    const tagCounts = new Map<string, number>();
    for (const memory of this.memories) {
      for (const tag of memory.tags) {
        tagCounts.set(tag, (tagCounts.get(tag) ?? 0) + 1);
      }
    }

    const items: ItemDescriptor[] = [...tagCounts.entries()]
      .sort((a, b) => b[1] - a[1])
      .map(([tag, count]) => ({
        id: tag,
        props: {
          tag,
          count,
        },
        summary: `Tag "${tag}" — ${count} ${count === 1 ? "memory" : "memories"}`,
        actions: {
          search_by_tag: action(async () => this.searchMemories("", [tag], 50), {
            label: "Search by Tag",
            description: `Return all memories tagged "${tag}".`,
            idempotent: true,
            estimate: "fast",
          }),
        },
      }));

    return {
      type: "collection",
      props: {
        count: tagCounts.size,
      },
      summary: "Active tags and their memory counts.",
      items,
    };
  }

  private addMemory(params: { content: string; tags: string[]; weight: number; ttl?: string }): {
    id: string;
    created_at: string;
  } {
    const created_at = now();
    const memory: MemoryItem = {
      id: buildMemoryId(),
      content: params.content,
      tags: params.tags,
      weight: clampWeight(params.weight),
      created_at,
      updated_at: created_at,
      ...(params.ttl !== undefined ? { ttl: params.ttl } : {}),
    };

    this.memories.unshift(memory);

    if (this.memories.length > this.maxMemories) {
      this.memories.sort((a, b) => b.weight - a.weight || b.updated_at.localeCompare(a.updated_at));
      this.memories = this.memories.slice(0, this.maxMemories);
    }

    this.server.refresh();
    return { id: memory.id, created_at: memory.created_at };
  }

  private updateMemory(
    id: string,
    updates: { content?: string; tags?: string[]; weight?: number },
  ): { updated_at: string } {
    const memory = this.memories.find((m) => m.id === id);
    if (!memory) {
      throw new Error(`Unknown memory: ${id}`);
    }

    if (typeof updates.content === "string") memory.content = updates.content;
    if (Array.isArray(updates.tags)) memory.tags = updates.tags;
    if (typeof updates.weight === "number") memory.weight = clampWeight(updates.weight);
    memory.updated_at = now();

    this.server.refresh();
    return { updated_at: memory.updated_at };
  }

  private deleteMemory(id: string): { deleted: true } {
    const index = this.memories.findIndex((m) => m.id === id);
    if (index === -1) {
      throw new Error(`Unknown memory: ${id}`);
    }

    this.memories.splice(index, 1);
    this.server.refresh();
    return { deleted: true };
  }

  private searchMemories(query: string, tags: string[], limit: number): SearchResult[] {
    let candidates = this.memories.filter((memory) => {
      if (tags.length === 0) return true;
      return tags.every((t) => memory.tags.includes(t));
    });

    if (query.trim()) {
      candidates = candidates
        .map((memory) => ({ memory, score: fuzzyScore(memory, query) }))
        .filter(({ score }) => score > 0)
        .sort((a, b) => b.score - a.score)
        .slice(0, limit)
        .map(({ memory, score }) => Object.assign({}, memory, { score }) as SearchResult);
    } else {
      candidates = candidates
        .slice(0, limit)
        .map((memory) => Object.assign({}, memory, { score: 1 }) as SearchResult);
    }

    return candidates as SearchResult[];
  }

  private forgetWeak(threshold: number): { removed_count: number } {
    const before = this.memories.length;
    this.memories = this.memories.filter((m) => m.weight >= threshold);
    const removed_count = before - this.memories.length;
    if (removed_count > 0) this.server.refresh();
    return { removed_count };
  }

  private clearAll(): { cleared_count: number } {
    const cleared_count = this.memories.length;
    this.memories = [];
    this.server.refresh();
    return { cleared_count };
  }

  private compact(): { merged_count: number } {
    const weak = this.memories.filter((m) => m.weight < this.compactThreshold);
    const strong = this.memories.filter((m) => m.weight >= this.compactThreshold);

    if (weak.length < 2) {
      return { merged_count: 0 };
    }

    const merged: MemoryItem[] = [];
    const consumed = new Set<string>();

    for (let i = 0; i < weak.length; i++) {
      if (consumed.has(weak[i].id)) continue;

      let best: MemoryItem | null = null;
      let bestOverlap = 0;

      for (let j = i + 1; j < weak.length; j++) {
        if (consumed.has(weak[j].id)) continue;
        const overlap = tagOverlap(weak[i], weak[j]);
        if (overlap > bestOverlap) {
          bestOverlap = overlap;
          best = weak[j];
        }
      }

      if (best !== null && bestOverlap > 0) {
        const combinedTags = [...new Set([...weak[i].tags, ...best.tags])];
        const combinedWeight = clampWeight((weak[i].weight + best.weight) / 2);
        const created_at = now();
        merged.push({
          id: buildMemoryId(),
          content: `${weak[i].content}\n\n${best.content}`,
          tags: combinedTags,
          weight: combinedWeight,
          created_at,
          updated_at: created_at,
        });
        consumed.add(weak[i].id);
        consumed.add(best.id);
      }
    }

    const survivors = weak.filter((m) => !consumed.has(m.id));
    this.memories = [...strong, ...survivors, ...merged];
    const merged_count = consumed.size / 2;

    if (merged_count > 0) this.server.refresh();
    return { merged_count };
  }
}
