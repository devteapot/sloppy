import { action, createSlopServer, type ItemDescriptor, type SlopServer } from "@slop-ai/server";

import { ProviderApprovalManager } from "../approvals";

type ImageGeneration = {
  id: string;
  prompt: string;
  width: number;
  height: number;
  status: "generating" | "ready" | "error";
  url?: string;
  preview?: string;
  created_at: string;
  completed_at?: string;
};

type ImageAnalysis = {
  id: string;
  source: string;
  status: "analyzing" | "ready" | "error";
  result?: string;
  created_at: string;
  completed_at?: string;
};

export class VisionProvider {
  readonly server: SlopServer;
  private maxImages: number;
  private defaultWidth: number;
  private defaultHeight: number;
  private approvals: ProviderApprovalManager;
  private images = new Map<string, ImageGeneration>();
  private analyses = new Map<string, ImageAnalysis>();

  constructor(options: { maxImages?: number; defaultWidth?: number; defaultHeight?: number } = {}) {
    this.maxImages = options.maxImages ?? 50;
    this.defaultWidth = options.defaultWidth ?? 512;
    this.defaultHeight = options.defaultHeight ?? 512;

    this.server = createSlopServer({
      id: "vision",
      name: "Vision",
    });
    this.approvals = new ProviderApprovalManager(this.server);

    this.server.register("session", () => this.buildSessionDescriptor());
    this.server.register("images", () => this.buildImagesDescriptor());
    this.server.register("analyses", () => this.buildAnalysesDescriptor());
    this.server.register("approvals", () => this.approvals.buildDescriptor());
  }

  stop(): void {
    this.server.stop();
  }

  private evictOldImages(): void {
    if (this.images.size <= this.maxImages) {
      return;
    }

    const sorted = [...this.images.entries()].sort(
      ([, a], [, b]) => new Date(a.created_at).getTime() - new Date(b.created_at).getTime(),
    );

    const toRemove = sorted.slice(0, this.images.size - this.maxImages);
    for (const [id] of toRemove) {
      this.images.delete(id);
    }
  }

  generateImage(
    prompt: string,
    width?: number,
    height?: number,
  ): { id: string; status: string; created_at: string } {
    const id = crypto.randomUUID();
    const w = width ?? this.defaultWidth;
    const h = height ?? this.defaultHeight;
    const created_at = new Date().toISOString();

    const generation: ImageGeneration = {
      id,
      prompt,
      width: w,
      height: h,
      status: "generating",
      created_at,
    };

    this.images.set(id, generation);
    this.evictOldImages();
    this.server.refresh();

    setTimeout(() => {
      const existing = this.images.get(id);
      if (!existing) {
        return;
      }

      existing.status = "ready";
      existing.url = `https://placeholder.invalid/generated/${id}.png`;
      existing.preview = `data:image/svg+xml;base64,PHN2ZyB3aWR0aD0iNTEyIiBoZWlnaHQ9IjUxMiIgeG1sbnM9Imh0dHA6Ly93d3cudzMub3JnLzIwMDAvc3ZnIj48cmVjdCB3aWR0aD0iMTAwJSIgaGVpZ2h0PSIxMDAlIiBmaWxsPSIjY2NjIi8+PHRleHQgeD0iNTAlIiB5PSI1MCUiIGZvbnQtc2l6ZT0iMTYiIGZpbGw9IiM2NjYiIHRleHQtYW5jaG9yPSJtaWRkbGUiIGR5PSIuM2VtIj5HZW5lcmF0ZWQ8L3RleHQ+PC9zdmc+`;
      existing.completed_at = new Date().toISOString();
      this.server.refresh();
    }, 2000);

    return { id, status: "generating", created_at };
  }

  analyzeImage(source: string): { id: string; status: string; created_at: string } {
    const id = crypto.randomUUID();
    const created_at = new Date().toISOString();

    const analysis: ImageAnalysis = {
      id,
      source,
      status: "analyzing",
      created_at,
    };

    this.analyses.set(id, analysis);
    this.server.refresh();

    setTimeout(() => {
      const existing = this.analyses.get(id);
      if (!existing) {
        return;
      }

      existing.status = "ready";
      existing.result =
        "Simulated analysis: The image contains visual content. Objects detected: scene elements present. Colors: varied palette observed. No specific details available in simulation mode.";
      existing.completed_at = new Date().toISOString();
      this.server.refresh();
    }, 1500);

    return { id, status: "analyzing", created_at };
  }

  getImage(id: string): ImageGeneration {
    const image = this.images.get(id);
    if (!image) {
      throw new Error(`Unknown image: ${id}`);
    }

    return image;
  }

  getAnalysis(id: string): ImageAnalysis {
    const analysis = this.analyses.get(id);
    if (!analysis) {
      throw new Error(`Unknown analysis: ${id}`);
    }

    return analysis;
  }

  deleteImage(id: string): { id: string; deleted: boolean } {
    if (!this.images.has(id)) {
      throw new Error(`Unknown image: ${id}`);
    }

    this.images.delete(id);
    this.server.refresh();
    return { id, deleted: true };
  }

  private buildSessionDescriptor() {
    const readyImages = [...this.images.values()].filter((img) => img.status === "ready").length;
    const readyAnalyses = [...this.analyses.values()].filter((a) => a.status === "ready").length;

    return {
      type: "context",
      props: {
        images_generated: readyImages,
        analyses_done: readyAnalyses,
        cache_size: this.images.size,
        default_dimensions: `${this.defaultWidth}x${this.defaultHeight}`,
      },
      summary: "Vision session: image generation and analysis capabilities.",
      actions: {
        generate_image: action(
          {
            prompt: "string",
            width: {
              type: "number",
              description: `Image width in pixels. Defaults to ${this.defaultWidth}.`,
            },
            height: {
              type: "number",
              description: `Image height in pixels. Defaults to ${this.defaultHeight}.`,
            },
          },
          async ({ prompt, width, height }) =>
            this.generateImage(prompt, width as number | undefined, height as number | undefined),
          {
            label: "Generate Image",
            description: "Create an image from a text prompt. Returns immediately; poll /images for status.",
            estimate: "slow",
          },
        ),
        analyze_image: action(
          {
            source: {
              type: "string",
              description: "URL, base64 data URI, or file path of the image to analyze.",
            },
          },
          async ({ source }) => this.analyzeImage(source as string),
          {
            label: "Analyze Image",
            description: "Submit an image for analysis. Returns immediately; poll /analyses for results.",
            estimate: "slow",
          },
        ),
      },
      meta: {
        focus: true,
        salience: 1,
      },
    };
  }

  private buildImagesDescriptor() {
    const items: ItemDescriptor[] = [...this.images.values()].map((image) => ({
      id: image.id,
      props: {
        id: image.id,
        prompt: image.prompt,
        width: image.width,
        height: image.height,
        status: image.status,
        created_at: image.created_at,
        ...(image.preview ? { preview: image.preview } : {}),
        ...(image.url ? { url: image.url } : {}),
      },
      actions: {
        ...(image.status === "ready"
          ? {
              download: action(
                async () => ({
                  id: image.id,
                  url: image.url,
                  prompt: image.prompt,
                  width: image.width,
                  height: image.height,
                }),
                {
                  label: "Download Image",
                  description: "Retrieve the full image URL for download.",
                  idempotent: true,
                  estimate: "instant",
                },
              ),
            }
          : {}),
        delete: action(
          async () => this.deleteImage(image.id),
          {
            label: "Delete Image",
            description: "Remove this image from the cache.",
            dangerous: true,
            estimate: "instant",
          },
        ),
      },
      meta: {
        salience: image.status === "generating" ? 0.9 : image.status === "error" ? 1 : 0.5,
        urgency: image.status === "error" ? "high" : image.status === "generating" ? "medium" : "low",
      },
    }));

    return {
      type: "collection",
      props: {
        count: items.length,
      },
      summary: "Generated images and their current status.",
      items,
    };
  }

  private buildAnalysesDescriptor() {
    const items: ItemDescriptor[] = [...this.analyses.values()].map((analysis) => ({
      id: analysis.id,
      props: {
        id: analysis.id,
        source: analysis.source,
        status: analysis.status,
        result_preview: analysis.result ? analysis.result.slice(0, 120) : undefined,
        created_at: analysis.created_at,
        ...(analysis.completed_at ? { completed_at: analysis.completed_at } : {}),
      },
      actions: {
        ...(analysis.status === "ready"
          ? {
              view_result: action(
                async () => ({
                  id: analysis.id,
                  source: analysis.source,
                  result: analysis.result,
                  created_at: analysis.created_at,
                  completed_at: analysis.completed_at,
                }),
                {
                  label: "View Result",
                  description: "Return the full analysis result for this image.",
                  idempotent: true,
                  estimate: "instant",
                },
              ),
            }
          : {}),
      },
      meta: {
        salience: analysis.status === "analyzing" ? 0.9 : analysis.status === "error" ? 1 : 0.5,
        urgency:
          analysis.status === "error" ? "high" : analysis.status === "analyzing" ? "medium" : "low",
      },
    }));

    return {
      type: "collection",
      props: {
        count: items.length,
      },
      summary: "Past image analyses and their results.",
      items,
    };
  }
}
