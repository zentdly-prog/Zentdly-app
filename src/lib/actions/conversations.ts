"use server";

import { createServerClient } from "@/infrastructure/supabase/server";
import { revalidatePath } from "next/cache";
import { z } from "zod";

export async function getTenantConversations(tenantId: string) {
  try {
    const db = createServerClient();
    const { data, error } = await db
      .from("conversations")
      .select("id, external_chat_id, status, last_message_at, bot_paused, requires_human, human_reason, customers(name, phone_e164)")
      .eq("tenant_id", tenantId)
      .order("last_message_at", { ascending: false })
      .limit(50);

    if (!error) return data ?? [];

    const { data: fallbackData } = await db
      .from("conversations")
      .select("id, external_chat_id, status, last_message_at, customers(name, phone_e164)")
      .eq("tenant_id", tenantId)
      .order("last_message_at", { ascending: false })
      .limit(50);

    return (fallbackData ?? []).map((conversation) => ({
      ...conversation,
      bot_paused: false,
      requires_human: false,
      human_reason: null,
    }));
  } catch {
    return [];
  }
}

export async function getConversationMessages(conversationId: string) {
  try {
    const db = createServerClient();
    const { data } = await db
      .from("messages")
      .select("id, direction, content, created_at")
      .eq("conversation_id", conversationId)
      .order("created_at", { ascending: true })
      .limit(120);

    return data ?? [];
  } catch {
    return [];
  }
}

const ConversationControlSchema = z.object({
  tenant_id: z.string().uuid(),
  conversation_id: z.string().uuid(),
  bot_paused: z.coerce.boolean().optional(),
  requires_human: z.coerce.boolean().optional(),
  human_reason: z.string().optional(),
});

export async function updateConversationControl(_prev: unknown, formData: FormData) {
  const parsed = ConversationControlSchema.safeParse({
    tenant_id: formData.get("tenant_id"),
    conversation_id: formData.get("conversation_id"),
    bot_paused: formData.get("bot_paused") === "true",
    requires_human: formData.get("requires_human") === "true",
    human_reason: formData.get("human_reason") ?? "",
  });

  if (!parsed.success) return { error: "Datos inválidos." };

  const db = createServerClient();
  const { error } = await db
    .from("conversations")
    .update({
      bot_paused: parsed.data.bot_paused ?? false,
      requires_human: parsed.data.requires_human ?? false,
      human_reason: parsed.data.human_reason?.trim() || null,
    })
    .eq("id", parsed.data.conversation_id)
    .eq("tenant_id", parsed.data.tenant_id);

  if (error) return { error: error.message };
  revalidatePath(`/tenants/${parsed.data.tenant_id}/inbox`);
  return { ok: true };
}
