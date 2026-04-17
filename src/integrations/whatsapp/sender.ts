export class WhatsAppSender {
  private readonly accessToken: string;
  private readonly phoneNumberId: string;
  private readonly baseUrl = "https://graph.facebook.com/v19.0";

  constructor() {
    this.accessToken = process.env.WHATSAPP_ACCESS_TOKEN!;
    this.phoneNumberId = process.env.WHATSAPP_PHONE_NUMBER_ID!;
  }

  async sendText(to: string, body: string): Promise<void> {
    const url = `${this.baseUrl}/${this.phoneNumberId}/messages`;

    const res = await fetch(url, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${this.accessToken}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        messaging_product: "whatsapp",
        to,
        type: "text",
        text: { body },
      }),
    });

    if (!res.ok) {
      const err = await res.text();
      throw new Error(`WhatsApp send failed [${res.status}]: ${err}`);
    }
  }

  async markRead(messageId: string): Promise<void> {
    const url = `${this.baseUrl}/${this.phoneNumberId}/messages`;
    await fetch(url, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${this.accessToken}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        messaging_product: "whatsapp",
        status: "read",
        message_id: messageId,
      }),
    });
  }
}
