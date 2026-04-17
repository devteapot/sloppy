import { action, createSlopServer, type ItemDescriptor, type SlopServer } from "@slop-ai/server";

import { ProviderApprovalManager } from "../approvals";

type Message = {
  id: string;
  channel_id: string;
  direction: "inbound" | "outbound";
  content: string;
  timestamp: string;
  sender: string;
  receiver?: string;
};

type Channel = {
  id: string;
  name: string;
  transport: string;
  messages: Message[];
  unread_count: number;
};

export class MessagingProvider {
  readonly server: SlopServer;
  private maxMessages: number;
  private approvals: ProviderApprovalManager;
  private channels = new Map<string, Channel>();

  constructor(options: { maxMessages?: number } = {}) {
    this.maxMessages = options.maxMessages ?? 500;

    this.server = createSlopServer({
      id: "messaging",
      name: "Messaging",
    });
    this.approvals = new ProviderApprovalManager(this.server);

    this.server.register("session", () => this.buildSessionDescriptor());
    this.server.register("channels", () => this.buildChannelsDescriptor());
    this.server.register("approvals", () => this.approvals.buildDescriptor());
  }

  stop(): void {
    this.server.stop();
  }

  private listChannels(): Channel[] {
    return [...this.channels.values()];
  }

  private addChannel(name: string, transport: string): { id: string; name: string; transport: string } {
    const id = crypto.randomUUID();
    const channel: Channel = { id, name, transport, messages: [], unread_count: 0 };
    this.channels.set(id, channel);
    this.server.refresh();
    return { id, name, transport };
  }

  private sendMessage(channelId: string, message: string): { id: string; channel_id: string; sent_at: string } {
    const channel = this.channels.get(channelId);
    if (!channel) {
      throw new Error(`Unknown channel: ${channelId}`);
    }

    const id = crypto.randomUUID();
    const sent_at = new Date(Date.now()).toISOString();
    const msg: Message = {
      id,
      channel_id: channelId,
      direction: "outbound",
      content: message,
      timestamp: sent_at,
      sender: "agent",
    };

    channel.messages.push(msg);
    if (channel.messages.length > this.maxMessages) {
      channel.messages = channel.messages.slice(-this.maxMessages);
    }

    this.server.refresh();
    return { id, channel_id: channelId, sent_at };
  }

  private viewHistory(channelId: string, limit?: number): Message[] {
    const channel = this.channels.get(channelId);
    if (!channel) {
      throw new Error(`Unknown channel: ${channelId}`);
    }

    channel.unread_count = 0;
    this.server.refresh();

    const messages = channel.messages;
    return limit != null ? messages.slice(-limit) : messages;
  }

  private removeChannel(channelId: string): { removed: true } {
    if (!this.channels.has(channelId)) {
      throw new Error(`Unknown channel: ${channelId}`);
    }
    this.channels.delete(channelId);
    this.server.refresh();
    return { removed: true };
  }

  private buildSessionDescriptor() {
    const channels = this.listChannels();
    const total_messages = channels.reduce((sum, c) => sum + c.messages.length, 0);
    const unread_count = channels.reduce((sum, c) => sum + c.unread_count, 0);

    return {
      type: "context",
      props: {
        channels_count: channels.length,
        total_messages,
        unread_count,
      },
      summary: "Messaging session overview and channel management.",
      actions: {
        list_channels: action(async () => this.listChannels(), {
          label: "List Channels",
          description: "Return all messaging channels.",
          idempotent: true,
          estimate: "instant",
        }),
        add_channel: action(
          {
            name: "string",
            transport_type: "string",
          },
          async ({ name, transport_type }) => this.addChannel(name, transport_type),
          {
            label: "Add Channel",
            description: "Create a new messaging channel.",
            estimate: "instant",
          },
        ),
        remove_channel: action(
          { channel_id: "string" },
          async ({ channel_id }) => this.removeChannel(channel_id),
          {
            label: "Remove Channel",
            description: "Delete a messaging channel and its history.",
            dangerous: true,
            estimate: "instant",
          },
        ),
      },
      meta: {
        focus: unread_count > 0,
        salience: unread_count > 0 ? 0.9 : 0.5,
      },
    };
  }

  private buildChannelsDescriptor() {
    const items: ItemDescriptor[] = [...this.channels.values()].map((channel) => {
      const last = channel.messages.at(-1);
      const last_message_preview = last
        ? `${last.direction === "inbound" ? last.sender : "You"}: ${last.content.slice(0, 80)}`
        : null;

      return {
        id: channel.id,
        props: {
          id: channel.id,
          name: channel.name,
          transport: channel.transport,
          message_count: channel.messages.length,
          unread_count: channel.unread_count,
          last_message_preview,
        },
        actions: {
          send: action(
            { message: "string" },
            async ({ message }) => this.sendMessage(channel.id, message),
            {
              label: "Send Message",
              description: "Send an outbound message to this channel.",
              estimate: "fast",
            },
          ),
          view_history: action(
            {
              limit: {
                type: "number",
                description: "Maximum number of recent messages to return. Omit for all.",
              },
            },
            async ({ limit }) => this.viewHistory(channel.id, limit),
            {
              label: "View History",
              description: "Return recent messages for this channel.",
              idempotent: true,
              estimate: "instant",
            },
          ),
        },
        meta: {
          salience: channel.unread_count > 0 ? 0.85 : 0.4,
          urgency: channel.unread_count > 0 ? "medium" : "low",
        },
      };
    });

    return {
      type: "collection",
      props: {
        count: items.length,
      },
      summary: "Available messaging channels.",
      items,
    };
  }
}
