import { SupabaseClient } from "@supabase/supabase-js";
import type { ExtractedBooking } from "@/integrations/ai/schemas";
import type { Conversation, AiSession } from "@/types/database";

export interface ConversationState {
  step: "idle" | "collecting" | "confirming" | "done";
  extractedData: Partial<ExtractedBooking> | null;
}

export class ConversationHandler {
  constructor(private readonly db: SupabaseClient) {}

  async getOrCreate(tenantId: string, externalChatId: string, customerId: string): Promise<Conversation> {
    const { data: existing } = await this.db
      .from("conversations")
      .select("*")
      .eq("tenant_id", tenantId)
      .eq("external_chat_id", externalChatId)
      .single();

    if (existing) return existing as Conversation;

    const { data, error } = await this.db
      .from("conversations")
      .insert({
        tenant_id: tenantId,
        customer_id: customerId,
        channel: "whatsapp",
        external_chat_id: externalChatId,
        status: "active",
      })
      .select()
      .single();

    if (error) throw error;
    return data as Conversation;
  }

  async getSession(conversationId: string): Promise<AiSession | null> {
    const { data } = await this.db
      .from("ai_sessions")
      .select("*")
      .eq("conversation_id", conversationId)
      .single();

    return data as AiSession | null;
  }

  async upsertSession(
    conversationId: string,
    extracted: Partial<ExtractedBooking>,
    missingFields: string[],
    state: Record<string, unknown>,
  ): Promise<void> {
    await this.db.from("ai_sessions").upsert(
      {
        conversation_id: conversationId,
        extracted_data: extracted,
        missing_fields: missingFields,
        state,
        updated_at: new Date().toISOString(),
      },
      { onConflict: "conversation_id" },
    );
  }

  async saveMessage(
    conversationId: string,
    direction: "inbound" | "outbound",
    content: string,
    rawPayload: Record<string, unknown> = {},
  ): Promise<void> {
    await this.db.from("messages").insert({
      conversation_id: conversationId,
      direction,
      content,
      raw_payload: rawPayload,
    });

    await this.db
      .from("conversations")
      .update({ last_message_at: new Date().toISOString() })
      .eq("id", conversationId);
  }

  mergeExtracted(
    existing: Partial<ExtractedBooking> | null,
    incoming: ExtractedBooking,
  ): ExtractedBooking {
    if (!existing) return incoming;

    return {
      intent: incoming.intent !== "unknown" ? incoming.intent : (existing.intent ?? "unknown"),
      sport: incoming.sport ?? existing.sport ?? null,
      venue: incoming.venue ?? existing.venue ?? null,
      date: incoming.date ?? existing.date ?? null,
      time: incoming.time ?? existing.time ?? null,
      duration_minutes: incoming.duration_minutes ?? existing.duration_minutes ?? null,
      customer_name: incoming.customer_name ?? existing.customer_name ?? null,
      needs_follow_up: incoming.needs_follow_up,
      missing_fields: incoming.missing_fields,
    };
  }
}
