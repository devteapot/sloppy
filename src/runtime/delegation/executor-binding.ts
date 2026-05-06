import { z } from "zod";

export const executorBindingSchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("llm"),
    profileId: z.string().min(1),
    modelOverride: z.string().min(1).optional(),
  }),
  z.object({
    kind: z.literal("acp"),
    adapterId: z.string().min(1),
    modelOverride: z.string().min(1).optional(),
    timeoutMs: z.number().int().min(1).optional(),
  }),
]);

export type ExecutorBinding = z.infer<typeof executorBindingSchema>;
