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

export async function getHumanQueue(tenantId: string) {
  try {
    const db = createServerClient();
    const { data } = await db
      .from("conversations")
      .select("id, external_chat_id, last_message_at, human_reason, customers(name, phone_e164)")
      .eq("tenant_id", tenantId)
      .eq("requires_human", true)
      .order("last_message_at", { ascending: false });
    return (data ?? []) as Array<{
      id: string;
      external_chat_id: string;
      last_message_at: string;
      human_reason: string | null;
      customers: { name: string | null; phone_e164: string | null } | { name: string | null; phone_e164: string | null }[] | null;
    }>;
  } catch {
    return [];
  }
}

/**
 * Signature of the human-support queue: just a count plus the newest id.
 * Polled frequently from the nav badge, so it must stay tiny — fetching the
 * full queue on every tick is what makes idle panels burn egress quota.
 */
export async function getHumanQueueSignature(
  tenantId: string,
): Promise<{ count: number; newestId: string | null }> {
  try {
    const db = createServerClient();
    const { data, count } = await db
      .from("conversations")
      .select("id", { count: "exact" })
      .eq("tenant_id", tenantId)
      .eq("requires_human", true)
      .order("last_message_at", { ascending: false })
      .limit(1);
    return { count: count ?? 0, newestId: data?.[0]?.id ?? null };
  } catch {
    return { count: 0, newestId: null };
  }
}

/**
 * Cheap change-detector for the inbox: the newest activity timestamp and the
 * row count. The client only refetches the full list when this changes.
 */
export async function getConversationsSignature(
  tenantId: string,
): Promise<{ count: number; latest: string | null }> {
  try {
    const db = createServerClient();
    const { data, count } = await db
      .from("conversations")
      .select("last_message_at", { count: "exact" })
      .eq("tenant_id", tenantId)
      .order("last_message_at", { ascending: false })
      .limit(1);
    return { count: count ?? 0, latest: data?.[0]?.last_message_at ?? null };
  } catch {
    return { count: 0, latest: null };
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
