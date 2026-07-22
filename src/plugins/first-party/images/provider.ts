import { action, createSlopServer, type ItemDescriptor, type SlopServer } from "@slop-ai/server";

import { ImageRegistry, type ImageRegistryOptions } from "../../../core/images";

/**
 * State-tree front end for the runtime ImageRegistry.
 *
 * Image BYTES never appear in this descriptor — props are metadata only.
 * Loaded images are attached to the per-turn state trail message by the loop
 * (captioned with their /images node path); this provider gives the model the
 * lifecycle controls: load, unload, pin, unpin, remove.
 */
export class ImagesProvider {
  readonly server: SlopServer;
  readonly registry: ImageRegistry;

  constructor(options: ImageRegistryOptions) {
    this.registry = new ImageRegistry(options);
    this.server = createSlopServer({
      id: "images",
      name: "Images",
    });
    this.registry.onChange(() => this.server.refresh());
    // "gallery", not "images": the provider strips "/<id>/" from invoke
    // paths, so a node named after the provider id would shadow item actions.
    this.server.register("gallery", () => this.buildGalleryDescriptor(options));
  }

  stop(): void {
    this.server.stop();
  }

  private buildGalleryDescriptor(options: ImageRegistryOptions) {
    const images = this.registry.list();
    const items: ItemDescriptor[] = images.map((image) => ({
      id: image.id,
      props: {
        loaded: image.loaded,
        pinned: image.pinned,
        media_type: image.mediaType,
        bytes: image.bytes.length,
        ...(image.width && image.height ? { dims: `${image.width}x${image.height}` } : {}),
        source: image.source,
        ...(image.description ? { description: image.description } : {}),
        ...(image.ttlTurnsRemaining !== undefined
          ? { ttl_turns_remaining: image.ttlTurnsRemaining }
          : {}),
      },
      summary: this.itemSummary(image),
      actions: {
        describe: action(
          {
            description: {
              type: "string",
              description:
                "One-line description (max 200 chars) so this image stays " +
                "identifiable after it unloads.",
            },
          },
          async ({ description }) =>
            this.toResult(this.registry.setDescription(image.id, description as string)),
          {
            label: "Describe",
            description:
              "Record what this image shows. Do it while the image is visible — " +
              "after it unloads, the description is what identifies it.",
            estimate: "instant",
          },
        ),
        ...(image.loaded
          ? {
              unload: action(async () => this.toResult(this.registry.unload(image.id)), {
                label: "Unload",
                description: "Detach this image from the live context (bytes are kept).",
                estimate: "instant",
              }),
            }
          : {
              load: action(
                {
                  ttl_turns: {
                    type: "number",
                    description: `Turns to stay attached (default ${options.defaultTtlTurns}; ignored when pinned).`,
                    optional: true,
                  },
                },
                async ({ ttl_turns }) =>
                  this.toResult(
                    this.registry.load(image.id, {
                      ttlTurns: ttl_turns as number | undefined,
                    }),
                  ),
                {
                  label: "Load",
                  description: "Attach this image to the live context.",
                  estimate: "instant",
                },
              ),
            }),
        ...(image.pinned
          ? {
              unpin: action(async () => this.toResult(this.registry.unpin(image.id)), {
                label: "Unpin",
                description: "Allow this image to auto-expire and be evicted again.",
                estimate: "instant",
              }),
            }
          : {
              pin: action(async () => this.toResult(this.registry.pin(image.id)), {
                label: "Pin",
                description:
                  "Protect this image: no TTL expiry while loaded, never evicted from storage.",
                estimate: "instant",
              }),
            }),
        remove: action(
          async () => {
            this.registry.remove(image.id);
            return { id: image.id, removed: true };
          },
          {
            label: "Remove",
            description: "Delete the image bytes from the registry.",
            estimate: "instant",
          },
        ),
      },
    }));

    return {
      type: "collection",
      props: {
        count: images.length,
        loaded_count: images.filter((image) => image.loaded).length,
        max_loaded: options.maxLoaded,
        default_ttl_turns: options.defaultTtlTurns,
        estimated_loaded_tokens: this.registry.estimateLoadedImageTokens(),
      },
      summary:
        "In-memory image registry. Loaded images are attached to the live state " +
        "message each turn, captioned with their node path here. Unload images " +
        "you no longer need; load or pin the ones you must keep seeing — loaded " +
        "images auto-expire after their TTL.",
      items,
    };
  }

  private itemSummary(image: {
    summary: string;
    description?: string;
    loaded: boolean;
    path: string;
  }): string {
    const described = image.description
      ? `${image.summary} — "${image.description}"`
      : image.summary;
    return image.loaded
      ? `${described} — attached this turn as "image ${image.path}".`
      : image.description
        ? `${described} — not in context; load to view again.`
        : `${image.summary} — not in context and undescribed; load to view, then describe.`;
  }

  private toResult(image: {
    id: string;
    path: string;
    loaded: boolean;
    pinned: boolean;
    description?: string;
    ttlTurnsRemaining?: number;
  }) {
    return {
      id: image.id,
      path: image.path,
      loaded: image.loaded,
      pinned: image.pinned,
      ...(image.description ? { description: image.description } : {}),
      ...(image.ttlTurnsRemaining !== undefined
        ? { ttl_turns_remaining: image.ttlTurnsRemaining }
        : {}),
    };
  }
}
