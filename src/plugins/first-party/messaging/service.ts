import type { RouteMessageEnvelope } from "../shared/message-envelope";

export type SendMessageResult = {
  id: string;
  channel_id: string;
  sent_at: string;
  envelope_id?: string;
};

export interface MessagingService {
  sendMessage(
    channelId: string,
    message: string,
    envelopeInput?: RouteMessageEnvelope,
  ): SendMessageResult;
}
