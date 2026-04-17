export interface WhatsAppIncomingMessage {
  from: string; // phone in e164
  messageId: string;
  text: string;
  timestamp: number;
  phoneNumberId: string;
}

export interface WhatsAppWebhookPayload {
  object: string;
  entry: WhatsAppEntry[];
}

interface WhatsAppEntry {
  id: string;
  changes: WhatsAppChange[];
}

interface WhatsAppChange {
  value: WhatsAppValue;
  field: string;
}

interface WhatsAppValue {
  messaging_product: string;
  metadata: { display_phone_number: string; phone_number_id: string };
  contacts?: { profile: { name: string }; wa_id: string }[];
  messages?: WhatsAppRawMessage[];
  statuses?: unknown[];
}

interface WhatsAppRawMessage {
  from: string;
  id: string;
  timestamp: string;
  text?: { body: string };
  type: string;
}

export function parseIncomingMessage(
  payload: WhatsAppWebhookPayload,
): WhatsAppIncomingMessage | null {
  const change = payload.entry?.[0]?.changes?.[0]?.value;
  if (!change) return null;

  const msg = change.messages?.[0];
  if (!msg || msg.type !== "text" || !msg.text?.body) return null;

  return {
    from: msg.from,
    messageId: msg.id,
    text: msg.text.body,
    timestamp: parseInt(msg.timestamp, 10),
    phoneNumberId: change.metadata.phone_number_id,
  };
}
