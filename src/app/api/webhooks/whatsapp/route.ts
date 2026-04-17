import { NextRequest, NextResponse } from "next/server";
import { createHmac } from "crypto";
import { parseIncomingMessage, type WhatsAppWebhookPayload } from "@/integrations/whatsapp/types";
import { handleIncomingMessage } from "@/integrations/whatsapp/messageOrchestrator";

// Meta Cloud API webhook verification (GET)
export async function GET(req: NextRequest) {
  const { searchParams } = req.nextUrl;
  const mode = searchParams.get("hub.mode");
  const token = searchParams.get("hub.verify_token");
  const challenge = searchParams.get("hub.challenge");

  if (mode === "subscribe" && token === process.env.WHATSAPP_VERIFY_TOKEN) {
    return new NextResponse(challenge, { status: 200 });
  }

  return new NextResponse("Forbidden", { status: 403 });
}

// Incoming messages (POST)
export async function POST(req: NextRequest) {
  const rawBody = await req.text();

  // Validate webhook signature
  const signature = req.headers.get("x-hub-signature-256") ?? "";
  if (!verifySignature(rawBody, signature)) {
    return new NextResponse("Invalid signature", { status: 401 });
  }

  let payload: WhatsAppWebhookPayload;
  try {
    payload = JSON.parse(rawBody);
  } catch {
    return new NextResponse("Bad JSON", { status: 400 });
  }

  if (payload.object !== "whatsapp_business_account") {
    return new NextResponse("OK", { status: 200 });
  }

  const msg = parseIncomingMessage(payload);
  if (!msg) {
    // Could be a status update — acknowledge and ignore
    return new NextResponse("OK", { status: 200 });
  }

  // Resolve tenantId from phoneNumberId — for MVP use env var mapping
  const tenantId = process.env.DEFAULT_TENANT_ID;
  const timezone = process.env.DEFAULT_TIMEZONE ?? "America/Argentina/Buenos_Aires";

  if (!tenantId) {
    console.error("DEFAULT_TENANT_ID not configured");
    return new NextResponse("OK", { status: 200 });
  }

  // Process async (fire and forget) so Meta receives 200 quickly
  handleIncomingMessage(msg, tenantId, timezone).catch((err) => {
    console.error("[whatsapp webhook] handleIncomingMessage error:", err);
  });

  return new NextResponse("OK", { status: 200 });
}

function verifySignature(body: string, signature: string): boolean {
  const secret = process.env.META_APP_SECRET;
  if (!secret) return false;

  const expected = "sha256=" + createHmac("sha256", secret).update(body).digest("hex");
  return signature === expected;
}
