import type { ImageContentBlock } from "../llm/types";

/**
 * In-memory image registry backing the first-party images provider.
 *
 * Image bytes live HERE, never in conversation history or state-tree props:
 * loaded images are materialized into the per-turn state trail message (which
 * is hard-replaced every request), so unloading an image truly removes it
 * from context on the next request. Tool results and user messages only carry
 * tiny "/images/img-N" refs.
 *
 * Trail images re-bill at the full input rate every turn they stay loaded
 * (the trail sits after the cacheable history prefix), so auto-expiry — TTL
 * plus the maxLoaded LRU cap — is the backstop; the model's load/unload/pin
 * affordances are opt-in persistence, not required housekeeping.
 */

export type ImageRegistryOptions = {
  /** Max images attached to the trail at once; LRU-unloads unpinned. */
  maxLoaded: number;
  /**
   * Turns a freshly registered/loaded image stays attached unless pinned.
   * Default 1: glance once, describe it, drop the pixels — reload on demand.
   */
  defaultTtlTurns: number;
  /** Max images kept in memory; oldest unpinned are removed beyond it. */
  maxStored: number;
};

const MAX_DESCRIPTION_CHARS = 200;

export type RegisteredImage = {
  id: string;
  /**
   * Node path on the images provider, e.g. "/gallery/img-3". The collection
   * is NOT named after the provider id ("images"): slop providers strip a
   * leading "/<provider-id>/" from invoke paths, so a same-named node would
   * make item affordances unresolvable.
   */
  path: string;
  bytes: Buffer;
  mediaType: string;
  summary: string;
  /**
   * Model-written one-liner (describe affordance). With the default TTL of 1
   * the pixels leave context after a single appearance — the description is
   * how the model recognizes an unloaded image without reloading it.
   */
  description?: string;
  /** "tool:<providerId>:<path>" or "user". */
  source: string;
  width?: number;
  height?: number;
  loaded: boolean;
  pinned: boolean;
  ttlTurnsRemaining?: number;
  /** Monotonic sequence numbers; not wall-clock time. */
  registeredAt: number;
  lastLoadedAt: number;
};

export type TrailImage = {
  caption: string;
  image: ImageContentBlock;
};

export class ImageRegistry {
  private images = new Map<string, RegisteredImage>();
  private listeners = new Set<() => void>();
  private nextId = 1;
  private seq = 1;

  constructor(private readonly options: ImageRegistryOptions) {}

  register(input: {
    bytes: Buffer;
    mediaType: string;
    summary?: string;
    source: string;
    width?: number;
    height?: number;
  }): RegisteredImage {
    const id = `img-${this.nextId++}`;
    const image: RegisteredImage = {
      id,
      path: `/gallery/${id}`,
      bytes: Buffer.from(input.bytes),
      mediaType: input.mediaType,
      summary: input.summary ?? "image",
      source: input.source,
      width: input.width,
      height: input.height,
      loaded: true,
      pinned: false,
      ttlTurnsRemaining: this.options.defaultTtlTurns,
      registeredAt: this.seq++,
      lastLoadedAt: this.seq++,
    };
    this.images.set(id, image);
    // Automatic ingestion must not fail: if every trail slot is pinned, the
    // new image lands unloaded (metadata only) instead of throwing.
    this.evictLoadedOverflow(image, { bestEffort: true });
    this.evictStoredOverflow(image);
    this.notify();
    return image;
  }

  load(id: string, options?: { ttlTurns?: number }): RegisteredImage {
    const image = this.require(id);
    image.loaded = true;
    image.lastLoadedAt = this.seq++;
    if (!image.pinned) {
      image.ttlTurnsRemaining = options?.ttlTurns ?? this.options.defaultTtlTurns;
    }
    try {
      this.evictLoadedOverflow(image);
    } catch (error) {
      image.loaded = false;
      image.ttlTurnsRemaining = undefined;
      throw error;
    }
    this.notify();
    return image;
  }

  unload(id: string): RegisteredImage {
    const image = this.require(id);
    image.loaded = false;
    image.ttlTurnsRemaining = undefined;
    this.notify();
    return image;
  }

  /**
   * Pin protects the image wherever it is: loaded → never TTL/LRU-unloaded,
   * stored → never evicted by maxStored. It does NOT force attachment — a
   * pinned unloaded image is "keep the bytes, I'll load it again later".
   */
  pin(id: string): RegisteredImage {
    const image = this.require(id);
    if (!image.pinned && this.pinnedCount() >= this.options.maxStored) {
      throw new Error(
        `Cannot pin ${id}: ${this.options.maxStored} images are already pinned. Unpin or remove one first.`,
      );
    }
    image.pinned = true;
    image.ttlTurnsRemaining = undefined;
    this.notify();
    return image;
  }

  unpin(id: string): RegisteredImage {
    const image = this.require(id);
    image.pinned = false;
    if (image.loaded) {
      image.ttlTurnsRemaining = this.options.defaultTtlTurns;
    }
    this.notify();
    return image;
  }

  setDescription(id: string, description: string): RegisteredImage {
    const image = this.require(id);
    const trimmed = description.trim();
    if (!trimmed) {
      throw new Error("Description must not be empty.");
    }
    if (trimmed.length > MAX_DESCRIPTION_CHARS) {
      throw new Error(
        `Description too long (${trimmed.length} chars, max ${MAX_DESCRIPTION_CHARS}) — keep it to one line.`,
      );
    }
    image.description = trimmed;
    this.notify();
    return image;
  }

  remove(id: string): void {
    this.require(id);
    this.images.delete(id);
    this.notify();
  }

  get(id: string): RegisteredImage | undefined {
    return this.images.get(id);
  }

  list(): RegisteredImage[] {
    return [...this.images.values()].sort((a, b) => a.registeredAt - b.registeredAt);
  }

  /** Tick once per completed LLM request: age TTLs, unload expired images. */
  onTurn(): void {
    let changed = false;
    for (const image of this.images.values()) {
      if (!image.loaded || image.pinned || image.ttlTurnsRemaining === undefined) {
        continue;
      }
      image.ttlTurnsRemaining -= 1;
      if (image.ttlTurnsRemaining <= 0) {
        image.loaded = false;
        image.ttlTurnsRemaining = undefined;
      }
      changed = true;
    }
    if (changed) {
      this.notify();
    }
  }

  /** Loaded images as caption+block pairs, in load order, for the trail. */
  collectTrailImages(): TrailImage[] {
    return [...this.images.values()]
      .filter((image) => image.loaded)
      .sort((a, b) => a.lastLoadedAt - b.lastLoadedAt)
      .map((image) => ({
        caption: this.caption(image),
        image: {
          type: "image",
          mediaType: image.mediaType,
          data: image.bytes.toString("base64"),
        },
      }));
  }

  /**
   * Rough input-token cost of the loaded images (Anthropic-style w*h/750 when
   * dims are known, flat fallback otherwise). Heuristic, for budget display.
   */
  estimateLoadedImageTokens(): number {
    let total = 0;
    for (const image of this.images.values()) {
      if (!image.loaded) continue;
      total +=
        image.width && image.height
          ? Math.min(1600, Math.ceil((image.width * image.height) / 750))
          : 1100;
    }
    return total;
  }

  onChange(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private caption(image: RegisteredImage): string {
    const parts = [`${image.summary} — ${image.source}`];
    if (image.description) {
      parts.push(`"${image.description}"`);
    }
    parts.push(image.mediaType);
    if (image.width && image.height) {
      parts.push(`${image.width}x${image.height}`);
    }
    parts.push(image.pinned ? "pinned" : `ttl ${image.ttlTurnsRemaining}`);
    return `image ${image.path} (${parts.join(", ")}):`;
  }

  private require(id: string): RegisteredImage {
    const image = this.images.get(id);
    if (!image) {
      throw new Error(`Unknown image: ${id}`);
    }
    return image;
  }

  private pinnedCount(): number {
    return [...this.images.values()].filter((image) => image.pinned).length;
  }

  /** Keep at most maxLoaded attached; LRU-unload unpinned, never `keep`. */
  private evictLoadedOverflow(
    keep: RegisteredImage,
    options: { bestEffort?: boolean } = {},
  ): void {
    const loaded = () =>
      [...this.images.values()].filter((image) => image.loaded);
    while (loaded().length > this.options.maxLoaded) {
      const victim = loaded()
        .filter((image) => !image.pinned && image.id !== keep.id)
        .sort((a, b) => a.lastLoadedAt - b.lastLoadedAt)[0];
      if (!victim) {
        if (options.bestEffort) {
          keep.loaded = false;
          keep.ttlTurnsRemaining = undefined;
          return;
        }
        throw new Error(
          `Cannot load ${keep.id}: all ${this.options.maxLoaded} attached images are pinned. Unpin or unload one first.`,
        );
      }
      victim.loaded = false;
      victim.ttlTurnsRemaining = undefined;
    }
  }

  /** Drop the oldest unpinned beyond maxStored (pinned may overflow). */
  private evictStoredOverflow(keep: RegisteredImage): void {
    while (this.images.size > this.options.maxStored) {
      const victim = [...this.images.values()]
        .filter((image) => !image.pinned && image.id !== keep.id)
        .sort((a, b) => a.registeredAt - b.registeredAt)[0];
      if (!victim) {
        // Nothing evictable but the new arrival — allow overflow rather than
        // dropping pinned data or the image we were just asked to keep.
        return;
      }
      this.images.delete(victim.id);
    }
  }

  private notify(): void {
    for (const listener of this.listeners) {
      listener();
    }
  }
}
