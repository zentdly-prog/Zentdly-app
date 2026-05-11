import { createServerClient } from "@/infrastructure/supabase/server";
import { evolutionSendText } from "./evolutionSender";
import { getBotPolicy } from "@/lib/actions/policies";
import { isForgetCommand, logAgentEvent, resetConversationState, saveAgentState } from "@/domain/conversation/agentOps";
import { handleDeterministicBookingMessage } from "@/domain/booking/deterministicRouter";
import { renderFallbackReply } from "@/domain/conversation/fallbackResponder";

export interface EvolutionIncomingMessage {
  instanceName: string;
  from: string;
  jid: string;        // full remoteJid — use this to send back (handles @lid format)
  text: string;
  messageId: string;
  pushName?: string;
  messageType?: "text" | "audio" | "image" | "document" | "sticker" | "video" | "unknown";
}

export async function handleEvolutionMessage(msg: EvolutionIncomingMessage): Promise<void> {
  const db = createServerClient();

  // ── 1. Find tenant ──────────────────────────────────────────────────────────
  const { data: config } = await db
    .from("whatsapp_config")
    .select("tenant_id, connected, forget_command_enabled")
    .eq("evolution_instance_name", msg.instanceName)
    .single();

  if (!config?.tenant_id) {
    console.error("[agent] No tenant for instance:", msg.instanceName);
    return;
  }

  const tenantId = config.tenant_id;
  const chatAliases = Array.from(new Set([
    msg.from,
    msg.jid.endsWith("@lid") ? msg.jid.split("@")[0] : null,
  ].filter(Boolean))) as string[];

  // ── 2. Reuse previous @lid conversation if it exists, then upsert customer ─
  const { data: previousConversation } = await db
    .from("conversations")
    .select("id, customer_id")
    .eq("tenant_id", tenantId)
    .in("external_chat_id", chatAliases)
    .order("last_message_at", { ascending: false })
    .limit(1)
    .maybeSingle();

  let customer: { id: string; name: string | null } | null = null;

  if (previousConversation?.customer_id) {
    const { data: existingCustomer } = await db
      .from("customers")
      .update({ name: msg.pushName ?? undefined, phone_e164: `+${msg.from}` })
      .eq("id", previousConversation.customer_id)
      .select("id, name")
      .single();
    customer = existingCustomer;
  }

  if (!customer) {
    const { data: upsertedCustomer } = await db
      .from("customers")
      .upsert(
        { tenant_id: tenantId, phone_e164: `+${msg.from}`, name: msg.pushName ?? null },
        { onConflict: "tenant_id,phone_e164", ignoreDuplicates: false }
      )
      .select("id, name")
      .single();
    customer = upsertedCustomer;
  }

  if (!customer) return;

  // ── 3. Get or create conversation ───────────────────────────────────────────
  let conversation: { id: string } | null = previousConversation ? { id: previousConversation.id } : null;

  if (!conversation) {
    const { data: upsertedConversation } = await db
      .from("conversations")
      .upsert(
        { tenant_id: tenantId, customer_id: customer.id, external_chat_id: msg.from, channel: "whatsapp" },
        { onConflict: "tenant_id,external_chat_id", ignoreDuplicates: false }
      )
      .select("id")
      .single();
    conversation = upsertedConversation;
  }

  if (!conversation) return;
  const conversationControl = await getConversationControl(db, conversation.id);

  // ── 4. Dedupe webhook retries before AI / booking side effects ─────────────
  if (msg.messageId) {
    const { data: existingMessage } = await db
      .from("messages")
      .select("id")
      .eq("conversation_id", conversation.id)
      .eq("direction", "inbound")
      .contains("raw_payload", { messageId: msg.messageId })
      .maybeSingle();

    if (existingMessage) return;
  }

  // ── 4b. Skip if inbound exactly matches bot's last outbound (echo guard) ───
  if (await isEchoOfOwnReply(db, conversation.id, msg.text)) {
    await logAgentEvent(db, {
      tenantId,
      conversationId: conversation.id,
      customerId: customer.id,
      eventType: "echo_dropped",
      payload: { text: msg.text.slice(0, 200) },
    });
    return;
  }

  // ── 5. Save inbound before any AI/context work so failures are traceable ───
  await db.from("messages").insert({
    conversation_id: conversation.id,
    direction: "inbound",
    content: msg.text,
    raw_payload: { messageId: msg.messageId, jid: msg.jid, messageType: msg.messageType ?? "text" },
  });

  await logAgentEvent(db, {
    tenantId,
    conversationId: conversation.id,
    customerId: customer.id,
    eventType: "message_received",
    payload: { messageType: msg.messageType ?? "text" },
  });

  if (config.connected === false || conversationControl.botPaused || conversationControl.requiresHuman) {
    await db
      .from("conversations")
      .update({ last_message_at: new Date().toISOString() })
      .eq("id", conversation.id);
    return;
  }

  // ── 6. Build context + history ─────────────────────────────────────────────
  const { data: tenant } = await db
    .from("tenants")
    .select("timezone")
    .eq("id", tenantId)
    .single();

  const timezone = tenant?.timezone ?? "America/Argentina/Buenos_Aires";
  const policy = await getBotPolicy(tenantId);

  // ── 5b. "Olvidar" command — reset conversation state if operator allows it ──
  const forgetAllowed = (config as { forget_command_enabled?: boolean | null }).forget_command_enabled ?? true;
  if (forgetAllowed && isForgetCommand(msg.text)) {
    await resetConversationState(db, conversation.id);
    const reply = "Listo, arrancamos de cero. ¿Querés reservar, ver disponibilidad o cancelar un turno?";
    recordRecentOutbound(conversation.id, reply);
    await evolutionSendText(msg.instanceName, msg.jid, reply);
    await db.from("messages").insert({
      conversation_id: conversation.id,
      direction: "outbound",
      content: reply,
      raw_payload: { auto: true, reason: "forget_command" },
    });
    await db.from("conversations").update({ last_message_at: new Date().toISOString() }).eq("id", conversation.id);
    await logAgentEvent(db, {
      tenantId,
      conversationId: conversation.id,
      customerId: customer.id,
      eventType: "forget_command_handled",
      payload: { text: msg.text.slice(0, 200) },
    });
    return;
  }

  if (msg.messageType === "audio") {
    recordRecentOutbound(conversation.id, policy.audio_message);
    await evolutionSendText(msg.instanceName, msg.jid, policy.audio_message);
    await db.from("messages").insert({
      conversation_id: conversation.id,
      direction: "outbound",
      content: policy.audio_message,
      raw_payload: { auto: true, reason: "audio_message" },
    });
    await saveAgentState(db, conversation.id, {
      intent: "unknown",
      status: "idle",
      missing: [],
    });
    await logAgentEvent(db, {
      tenantId,
      conversationId: conversation.id,
      customerId: customer.id,
      eventType: "audio_rejected",
      payload: { reply: policy.audio_message },
    });
    return;
  }

  const deterministic = await handleDeterministicBookingMessage({
    db,
    tenantId,
    customerId: customer.id,
    customerPhone: `+${msg.from}`,
    timezone,
    conversationId: conversation.id,
    message: msg.text,
  });

  if (deterministic.handled) {
    const reply = deterministic.reply ?? "No pude procesar tu consulta.";
    recordRecentOutbound(conversation.id, reply);
    await evolutionSendText(msg.instanceName, msg.jid, reply);
    await db.from("messages").insert({
      conversation_id: conversation.id,
      direction: "outbound",
      content: reply,
      raw_payload: { deterministic: true },
    });
    await db
      .from("conversations")
      .update({ last_message_at: new Date().toISOString() })
      .eq("id", conversation.id);
    await logAgentEvent(db, {
      tenantId,
      conversationId: conversation.id,
      customerId: customer.id,
      eventType: "deterministic_reply_sent",
      payload: { reply },
    });
    syncGoogleIfNeeded(db, tenantId).catch((e) =>
      console.error("[agent] Google sync error:", e)
    );
    return;
  }

  // ── 7. Deterministic fallback (no AI hallucinations) ────────────────────────
  const reply = await renderFallbackReply({
    db,
    tenantId,
    customerId: customer.id,
    conversationId: conversation.id,
    timezone,
    message: msg.text,
  });

  // ── 8. Send reply via Evolution ─────────────────────────────────────────────
  recordRecentOutbound(conversation.id, reply);
  await evolutionSendText(msg.instanceName, msg.jid, reply);

  // ── 9. Save outbound message ────────────────────────────────────────────────
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

  await saveAgentState(db, conversation.id, {
    status: "done",
  });
  await logAgentEvent(db, {
    tenantId,
    conversationId: conversation.id,
    customerId: customer.id,
    eventType: "reply_sent",
    payload: { reply },
  });

  // ── 10. Google sync safety pass (fire & forget) ─────────────────────────────
  syncGoogleIfNeeded(db, tenantId).catch((e) =>
    console.error("[agent] Google sync error:", e)
  );
}

// Recent outbound cache. Each conversation keeps its last few replies in memory,
// so the echo guard catches loops even before the DB insert has settled.
const recentOutboundCache = new Map<string, { content: string; ts: number }[]>();
const RECENT_OUTBOUND_TTL_MS = 5 * 60_000;
const RECENT_OUTBOUND_MAX = 5;

export function recordRecentOutbound(conversationId: string, content: string): void {
  const trimmed = content.trim();
  if (!trimmed) return;
  const now = Date.now();
  const existing = (recentOutboundCache.get(conversationId) ?? []).filter(
    (entry) => now - entry.ts < RECENT_OUTBOUND_TTL_MS,
  );
  existing.push({ content: trimmed, ts: now });
  while (existing.length > RECENT_OUTBOUND_MAX) existing.shift();
  recentOutboundCache.set(conversationId, existing);
}

async function isEchoOfOwnReply(
  db: ReturnType<typeof createServerClient>,
  conversationId: string,
  inboundText: string,
): Promise<boolean> {
  const normalized = inboundText.trim();
  if (normalized.length < 20) return false; // too short to be a reliable match

  // In-memory cache first — catches the case where the outbound DB insert
  // hasn't completed by the time the echo arrives.
  const now = Date.now();
  const cached = (recentOutboundCache.get(conversationId) ?? []).filter(
    (entry) => now - entry.ts < RECENT_OUTBOUND_TTL_MS,
  );
  if (cached.some((entry) => entry.content === normalized)) return true;
  recentOutboundCache.set(conversationId, cached);

  const since = new Date(now - RECENT_OUTBOUND_TTL_MS).toISOString();
  const { data: lastOutbound } = await db
    .from("messages")
    .select("content")
    .eq("conversation_id", conversationId)
    .eq("direction", "outbound")
    .gte("created_at", since)
    .order("created_at", { ascending: false })
    .limit(5);

  if (!lastOutbound?.length) return false;
  return lastOutbound.some((m) => (m.content as string).trim() === normalized);
}

async function getConversationControl(
  db: ReturnType<typeof createServerClient>,
  conversationId: string,
): Promise<{ botPaused: boolean; requiresHuman: boolean }> {
  const { data, error } = await db
    .from("conversations")
    .select("bot_paused, requires_human")
    .eq("id", conversationId)
    .maybeSingle();

  if (error) return { botPaused: false, requiresHuman: false };
  return {
    botPaused: data?.bot_paused === true,
    requiresHuman: data?.requires_human === true,
  };
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
