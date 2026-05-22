import type { SessionClient } from "../backend/session-client";

export async function submitMessage(client: SessionClient, text: string): Promise<void> {
  const trimmed = text.trim();
  if (!trimmed) {
    return;
  }
  await client.sendMessage(trimmed);
}
