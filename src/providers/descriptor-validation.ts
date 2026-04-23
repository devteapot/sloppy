import { z } from "zod";

const UnixTransport = z.object({
  type: z.literal("unix"),
  path: z.string().min(1),
});

const WebSocketTransport = z.object({
  type: z.literal("ws"),
  url: z.string().url(),
});

const StdioTransport = z.object({
  type: z.literal("stdio"),
  command: z.array(z.string()).min(1),
});

const PipeTransport = z.object({
  type: z.literal("pipe"),
  name: z.string().min(1),
});

const PostmessageTransport = z.object({
  type: z.literal("postmessage"),
});

const TransportSchema = z.discriminatedUnion("type", [
  UnixTransport,
  WebSocketTransport,
  StdioTransport,
  PipeTransport,
  PostmessageTransport,
]);

const ProviderDescriptorSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  version: z.string().optional(),
  slop_version: z.string().optional(),
  description: z.string().optional(),
  capabilities: z.array(z.string()).optional(),
  transport: TransportSchema,
});

export type ValidationResult = { valid: true } | { valid: false; errors: string[] };

export function validateDescriptor(descriptor: unknown): ValidationResult {
  const result = ProviderDescriptorSchema.safeParse(descriptor);

  if (result.success) {
    return { valid: true };
  }

  const errors: string[] = [];

  for (const issue of result.error.issues) {
    const path = issue.path.join(".");
    errors.push(path ? `${path}: ${issue.message}` : issue.message);
  }

  return { valid: false, errors };
}
