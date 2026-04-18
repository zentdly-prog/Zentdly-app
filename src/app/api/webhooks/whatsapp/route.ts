import { NextRequest, NextResponse } from "next/server";
import { createHmac } from "crypto";
import { parseIncomingMessage, type WhatsAppWebhookPayload } from "@/integrations/whatsapp/types";
import { handleIncomingMessage } from "@/integrations/whatsapp/messageOrchestrator";
import { handleEvolutionMessage } from "@/integrations/whatsapp/evolutionOrchestrator";
import type { EvolutionIncomingMessage } from "@/integrations/whatsapp/evolutionOrchestrator";

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

export const maxDuration = 60; // seconds — requires Vercel Pro, ignored on Hobby but safe to set

// Incoming messages (POST)
export async function POST(req: NextRequest) {
  const rawBody = await req.text();

  let payload: Record<string, unknown>;
  try {
    payload = JSON.parse(rawBody);
  } catch {
    return new NextResponse("Bad JSON", { status: 400 });
  }

  // ── Evolution API webhook ──────────────────────────────────────────────────
  if (payload.event === "messages.upsert") {
    const msg = parseEvolutionPayload(payload);
    if (msg) {
      try {
        await handleEvolutionMessage(msg);
      } catch (err) {
        console.error("[evolution webhook] error:", err);
      }
    }
    return new NextResponse("OK", { status: 200 });
  }

  // ── Meta Cloud API webhook ─────────────────────────────────────────────────
  const signature = req.headers.get("x-hub-signature-256") ?? "";
  if (!verifySignature(rawBody, signature)) {
    return new NextResponse("Invalid signature", { status: 401 });
  }

  const metaPayload = payload as unknown as WhatsAppWebhookPayload;
  if (metaPayload.object !== "whatsapp_business_account") {
    return new NextResponse("OK", { status: 200 });
  }

  const msg = parseIncomingMessage(metaPayload);
  if (!msg) return new NextResponse("OK", { status: 200 });

  const tenantId = process.env.DEFAULT_TENANT_ID;
  const timezone = process.env.DEFAULT_TIMEZONE ?? "America/Argentina/Buenos_Aires";

  if (!tenantId) {
    console.error("DEFAULT_TENANT_ID not configured");
    return new NextResponse("OK", { status: 200 });
  }

  handleIncomingMessage(msg, tenantId, timezone).catch((err) => {
    console.error("[whatsapp webhook] handleIncomingMessage error:", err);
  });

  return new NextResponse("OK", { status: 200 });
}

function parseEvolutionPayload(payload: Record<string, unknown>): EvolutionIncomingMessage | null {
  try {
    const data = payload.data as Record<string, unknown>;
    const key = data?.key as Record<string, unknown>;
    const message = data?.message as Record<string, unknown>;

    if (key?.fromMe) return null; // skip our own messages

    const remoteJid = key?.remoteJid as string;
    if (!remoteJid || remoteJid.includes("@g.us")) return null; // skip groups

    const from = remoteJid.split("@")[0];
    const text =
      (message?.conversation as string) ??
      ((message?.extendedTextMessage as Record<string, unknown>)?.text as string) ??
      null;

    if (!text?.trim()) return null;

    return {
      instanceName: payload.instance as string,
      from,
      text: text.trim(),
      messageId: key?.id as string,
      pushName: data?.pushName as string | undefined,
    };
  } catch {
    return null;
  }
}

function verifySignature(body: string, signature: string): boolean {
  const secret = process.env.META_APP_SECRET;
  if (!secret) return false;

  const expected = "sha256=" + createHmac("sha256", secret).update(body).digest("hex");
  return signature === expected;
}
