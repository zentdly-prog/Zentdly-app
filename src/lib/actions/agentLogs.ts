"use server";

import { createServerClient } from "@/infrastructure/supabase/server";

export async function getAgentLogs(tenantId: string) {
  try {
    const db = createServerClient();
    const { data } = await db
      .from("agent_logs")
      .select("id, event_type, intent, tool_name, payload, error, created_at, customers(name, phone_e164)")
      .eq("tenant_id", tenantId)
      .order("created_at", { ascending: false })
      .limit(100);

    return data ?? [];
  } catch {
    return [];
  }
}
