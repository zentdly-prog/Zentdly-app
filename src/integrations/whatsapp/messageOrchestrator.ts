import { createServerClient } from "@/infrastructure/supabase/server";
import { WhatsAppSender } from "./sender";
import { ConversationHandler } from "@/domain/conversation/conversationHandler";
import { CustomerRepository } from "@/infrastructure/repositories/customerRepository";
import { logAgentEvent, saveAgentState } from "@/domain/conversation/agentOps";
import { handleDeterministicBookingMessage } from "@/domain/booking/deterministicRouter";
import { renderFallbackReply } from "@/domain/conversation/fallbackResponder";
import type { WhatsAppIncomingMessage } from "./types";

export async function handleIncomingMessage(
  msg: WhatsAppIncomingMessage,
  tenantId: string,
  timezone: string,
): Promise<void> {
  const db = createServerClient();
  const sender = new WhatsAppSender();
  const conversationHandler = new ConversationHandler(db);
  const customerRepo = new CustomerRepository(db);

  await sender.markRead(msg.messageId).catch(() => undefined);

  // Upsert customer
  const customer = await customerRepo.upsertByPhone(tenantId, `+${msg.from}`);

  // Get or create conversation
  const conversation = await conversationHandler.getOrCreate(tenantId, msg.from, customer.id);

  if (msg.messageId) {
    const { data: existingMessage } = await db
      .from("messages")
      .select("id")
      .eq("conversation_id", conversation.id)
      .eq("direction", "inbound")
      .contains("raw_payload", { message_id: msg.messageId })
      .maybeSingle();

    if (existingMessage) return;
  }

  const control = await getConversationControl(db, conversation.id);

  // Save inbound message before AI so failures are visible from the panel.
  await conversationHandler.saveMessage(conversation.id, "inbound", msg.text, {
    message_id: msg.messageId,
  });

  await logAgentEvent(db, {
    tenantId,
    conversationId: conversation.id,
    customerId: customer.id,
    eventType: "message_received",
    payload: { provider: "meta" },
  });

  if (control.botPaused || control.requiresHuman) {
    await db
      .from("conversations")
      .update({ last_message_at: new Date().toISOString() })
      .eq("id", conversation.id);
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
    const replyText = deterministic.reply ?? "No pude procesar tu consulta.";
    await sender.sendText(msg.from, replyText);
    await conversationHandler.saveMessage(conversation.id, "outbound", replyText, { deterministic: true });
    await logAgentEvent(db, {
      tenantId,
      conversationId: conversation.id,
      customerId: customer.id,
      eventType: "deterministic_reply_sent",
      payload: { provider: "meta", reply: replyText },
    });
    return;
  }

  const replyText = await renderFallbackReply({
    db,
    tenantId,
    customerId: customer.id,
    conversationId: conversation.id,
    timezone,
    message: msg.text,
  });

  await sender.sendText(msg.from, replyText);
  await conversationHandler.saveMessage(conversation.id, "outbound", replyText);
  await saveAgentState(db, conversation.id, { status: "done" });
  await logAgentEvent(db, {
    tenantId,
    conversationId: conversation.id,
    customerId: customer.id,
    eventType: "reply_sent",
    payload: { provider: "meta", reply: replyText },
  });
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
