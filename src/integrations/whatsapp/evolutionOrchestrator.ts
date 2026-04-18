import { createServerClient } from "@/infrastructure/supabase/server";
import { evolutionSendText } from "./evolutionSender";
import { buildAgentContext } from "@/integrations/ai/contextBuilder";
import { runAgent } from "@/integrations/ai/agent";
import type { ChatCompletionMessageParam } from "openai/resources/chat/completions";

export interface EvolutionIncomingMessage {
  instanceName: string;
  from: string;
  text: string;
  messageId: string;
  pushName?: string;
}

export async function handleEvolutionMessage(msg: EvolutionIncomingMessage): Promise<void> {
  const db = createServerClient();

  // ── 1. Find tenant ──────────────────────────────────────────────────────────
  const { data: config } = await db
    .from("whatsapp_config")
    .select("tenant_id")
    .eq("evolution_instance_name", msg.instanceName)
    .single();

  if (!config?.tenant_id) {
    console.error("[agent] No tenant for instance:", msg.instanceName);
    return;
  }

  const tenantId = config.tenant_id;

  // ── 2. Upsert customer ──────────────────────────────────────────────────────
  const { data: customer } = await db
    .from("customers")
    .upsert(
      { tenant_id: tenantId, phone_e164: `+${msg.from}`, name: msg.pushName ?? null },
      { onConflict: "tenant_id,phone_e164", ignoreDuplicates: false }
    )
    .select("id, name")
    .single();

  if (!customer) return;

  // ── 3. Get or create conversation ───────────────────────────────────────────
  const { data: conversation } = await db
    .from("conversations")
    .upsert(
      { tenant_id: tenantId, customer_id: customer.id, external_chat_id: msg.from, channel: "whatsapp" },
      { onConflict: "tenant_id,external_chat_id", ignoreDuplicates: false }
    )
    .select("id")
    .single();

  if (!conversation) return;

  // ── 4. Build context + history BEFORE saving inbound (avoids duplicate) ────
  const { data: tenant } = await db
    .from("tenants")
    .select("timezone")
    .eq("id", tenantId)
    .single();

  const timezone = tenant?.timezone ?? "America/Argentina/Buenos_Aires";

  const { systemPrompt, chatHistory } = await buildAgentContext(db, tenantId, conversation.id);

  // ── 5. Save inbound message ─────────────────────────────────────────────────
  await db.from("messages").insert({
    conversation_id: conversation.id,
    direction: "inbound",
    content: msg.text,
    raw_payload: { messageId: msg.messageId },
  });

  // ── 6. Run AI agent ─────────────────────────────────────────────────────────
  const reply = await runAgent(
    systemPrompt,
    chatHistory as ChatCompletionMessageParam[],
    msg.text,
    {
      db,
      tenantId,
      customerId: customer.id,
      customerPhone: `+${msg.from}`,
      timezone,
    }
  );

  // ── 7. Send reply via Evolution ─────────────────────────────────────────────
  await evolutionSendText(msg.instanceName, msg.from, reply);

  // ── 8. Save outbound message ────────────────────────────────────────────────
  await db.from("messages").insert({
    conversation_id: conversation.id,
    direction: "outbound",
    content: reply,
    raw_payload: {},
  });

  await db
    .from("conversations")
    .update({ last_message_at: new Date().toISOString() })
    .eq("id", conversation.id);

  // ── 9. Google sync (fire & forget) ─────────────────────────────────────────
  syncGoogleIfNeeded(db, tenantId).catch((e) =>
    console.error("[agent] Google sync error:", e)
  );
}

// ─── Google sync ─────────────────────────────────────────────────────────────
// Runs after the reply is sent so it doesn't block the WhatsApp response

async function syncGoogleIfNeeded(db: ReturnType<typeof createServerClient>, tenantId: string) {
  const { data: gConfig } = await db
    .from("google_config")
    .select("*")
    .eq("tenant_id", tenantId)
    .single();

  if (!gConfig?.service_account) return;
  if (!gConfig.calendar_enabled && !gConfig.sheets_enabled) return;

  // Find the latest confirmed reservation for this tenant (created in the last 30 seconds)
  const since = new Date(Date.now() - 30_000).toISOString();
  const { data: reservations } = await db
    .from("reservations")
    .select("*, customers(name, phone_e164), court_types(sport_name)")
    .eq("tenant_id", tenantId)
    .eq("status", "confirmed")
    .gte("created_at", since)
    .is("external_event_id", null);

  if (!reservations?.length) return;

  const { data: tenant } = await db
    .from("tenants")
    .select("timezone")
    .eq("id", tenantId)
    .single();

  const tz = tenant?.timezone ?? "America/Argentina/Buenos_Aires";
  const creds = {
    client_email: gConfig.service_account.client_email as string,
    private_key: gConfig.service_account.private_key as string,
  };

  for (const res of reservations) {
    const customerName = (res.customers as { name: string } | null)?.name ?? "Cliente";
    const customerPhone = (res.customers as { phone_e164: string } | null)?.phone_e164 ?? "";
    const sportName = (res.court_types as { sport_name: string } | null)?.sport_name ?? "Cancha";

    // Calendar
    if (gConfig.calendar_enabled && gConfig.calendar_id) {
      try {
        const { GoogleCalendarProvider } = await import("@/integrations/google/calendarProvider");
        const cal = new GoogleCalendarProvider({
          credentials: creds,
          calendar_id: gConfig.calendar_id,
          timezone: tz,
        });
        const { externalId } = await cal.syncReservation(
          { ...res, sport_name: sportName } as never,
          customerName,
          customerPhone
        );
        await db.from("reservations").update({ external_event_id: externalId }).eq("id", res.id);
      } catch (e) {
        console.error("[agent] Calendar sync failed:", e);
      }
    }

    // Sheets
    if (gConfig.sheets_enabled && gConfig.spreadsheet_id) {
      try {
        const { GoogleSheetsProvider } = await import("@/integrations/google/sheetsProvider");
        const sheets = new GoogleSheetsProvider({
          credentials: creds,
          spreadsheet_id: gConfig.spreadsheet_id,
          sheet_name: gConfig.sheet_name ?? "Reservas",
          timezone: tz,
        });
        await sheets.ensureHeaders();
        const { externalId } = await sheets.syncReservation(
          res as never,
          customerName,
          customerPhone
        );
        await db.from("reservations").update({ external_sheet_row_id: externalId }).eq("id", res.id);
      } catch (e) {
        console.error("[agent] Sheets sync failed:", e);
      }
    }
  }
}
