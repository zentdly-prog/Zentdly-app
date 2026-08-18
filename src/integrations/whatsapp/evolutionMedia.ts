const BASE_URL = (process.env.EVOLUTION_API_URL ?? "https://evolution-api-production-6fab.up.railway.app").replace(/\/$/, "");
const API_KEY = process.env.EVOLUTION_API_KEY ?? "";

// Vision costs scale with image size, and WhatsApp photos are well under this.
// Anything larger is far more likely to be a mistake than a payment receipt.
const MAX_IMAGE_BYTES = 5 * 1024 * 1024;

export interface FetchedMedia {
  dataUrl: string;
  mimetype: string;
}

/**
 * Downloads the media attached to an inbound WhatsApp message and returns it as
 * a data URL ready to hand to a vision model.
 *
 * Evolution only ever gives us a placeholder like "[image]" in the webhook
 * payload, so without this the agent is blind to receipts customers send.
 * Returns null whenever the media is unusable — callers fall back to
 * text-only handling rather than failing the whole message.
 */
export async function fetchMediaAsDataUrl(
  instanceName: string,
  messageId: string,
): Promise<FetchedMedia | null> {
  if (!messageId || !API_KEY) return null;

  try {
    const res = await fetch(`${BASE_URL}/chat/getBase64FromMediaMessage/${instanceName}`, {
      method: "POST",
      headers: { apikey: API_KEY, "Content-Type": "application/json" },
      body: JSON.stringify({ message: { key: { id: messageId } }, convertToMp4: false }),
      signal: AbortSignal.timeout(12_000),
    });

    if (!res.ok) return null;

    const json = (await res.json().catch(() => null)) as
      | { base64?: string; mimetype?: string }
      | null;

    const base64 = json?.base64;
    const mimetype = json?.mimetype ?? "image/jpeg";
    if (!base64) return null;

    // Only still images can go to the vision model. PDFs and other documents
    // fall through to text-only handling.
    if (!mimetype.startsWith("image/")) return null;

    // base64 encodes 3 bytes per 4 characters.
    if (base64.length * 0.75 > MAX_IMAGE_BYTES) return null;

    return { dataUrl: `data:${mimetype};base64,${base64}`, mimetype };
  } catch {
    return null;
  }
}
