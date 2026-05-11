import type { SupabaseClient } from "@supabase/supabase-js";
import { IntentExtractor } from "@/integrations/ai/intentExtractor";
import { getBotPolicy } from "@/lib/actions/policies";
import {
  getAgentState,
  logAgentEvent,
  saveAgentState,
  type AgentConversationState,
} from "@/domain/conversation/agentOps";

export interface FallbackInput {
  db: SupabaseClient;
  tenantId: string;
  customerId: string;
  conversationId: string;
  timezone: string;
  message: string;
}

export async function renderFallbackReply(input: FallbackInput): Promise<string> {
  const [tenant, policy, state, normalized] = await Promise.all([
    fetchTenant(input.db, input.tenantId),
    getBotPolicy(input.tenantId, input.db),
    getAgentState(input.db, input.conversationId),
    normalizeMessage(input),
  ]);

  const businessName = tenant?.name?.trim() ?? "el complejo";
  const inOperationalFlow =
    state.intent !== "unknown" && state.status === "collecting_data";

  let reply: string;
  let category: string;

  if (inOperationalFlow) {
    category = "in_flow_redirect";
    reply = buildFlowRedirectReply(state);
  } else if (normalized?.intent === "greeting") {
    category = "greeting";
    reply = `¡Hola! Soy el asistente de ${businessName}. ¿Querés reservar, ver disponibilidad o cancelar un turno?`;
  } else if (normalized?.intent === "human_handoff") {
    category = "handoff";
    reply = policy.human_handoff_message?.trim() || "Te derivo con una persona del equipo para ayudarte con eso.";
    await saveAgentState(input.db, input.conversationId, {
      status: "handoff",
    });
  } else if (normalized?.intent === "policy_question") {
    category = "policy_question";
    reply = await renderPolicyAnswer(input, policy, normalized.notes ?? input.message);
  } else if (looksLikeOperationalIntent(input.message)) {
    category = "operational_redirect";
    reply = "Para ayudarte mejor, decime día, horario y a nombre de quién hago la reserva.";
  } else {
    category = "unknown_redirect";
    reply = `Soy el asistente de ${businessName}, gestiono reservas. Decime día, horario y nombre, o pedime ver disponibilidad o cancelar un turno.`;
  }

  await logAgentEvent(input.db, {
    tenantId: input.tenantId,
    conversationId: input.conversationId,
    customerId: input.customerId,
    eventType: "fallback_reply_sent",
    payload: { category, reply, normalizedIntent: normalized?.intent ?? null },
  });

  return reply;
}

function buildFlowRedirectReply(state: AgentConversationState): string {
  const missing = state.missing ?? [];
  const labels: Record<string, string> = {
    date: "día",
    time: "horario",
    customer_name: "nombre",
    sport: "deporte",
    quantity: "cantidad de canchas",
    reservation: "qué reserva (día y horario)",
    deposit: "comprobante de seña",
  };
  const pieces = missing.map((field) => labels[field] ?? field).filter(Boolean);

  if (state.intent === "booking" && pieces.length > 0) {
    return `Para confirmar la reserva me falta: ${pieces.join(", ")}.`;
  }
  if (state.intent === "cancel" && pieces.length > 0) {
    return `Para cancelar necesito ${pieces.join(", ")}.`;
  }
  if (state.intent === "reschedule" && pieces.length > 0) {
    return `Para reprogramar necesito ${pieces.join(", ")}.`;
  }
  return "Decime el dato que falta y avanzamos.";
}

async function renderPolicyAnswer(
  input: FallbackInput,
  policy: Awaited<ReturnType<typeof getBotPolicy>>,
  hint: string,
): Promise<string> {
  const normalized = normalizeText(hint);

  if (/\b(precio|cuanto sale|cuanto cuesta|tarifa|valor)\b/.test(normalized)) {
    const courts = await fetchCourtPrices(input.db, input.tenantId);
    if (!courts.length) return "Por ahora no tengo precios cargados, te confirmo en cuanto pueda.";
    const lines = courts.map((c) =>
      c.price != null ? `• ${c.sport_name}: $${c.price}` : `• ${c.sport_name}: precio a consultar`,
    );
    return `Precios por turno:\n${lines.join("\n")}`;
  }

  if (/\b(horario|abren|cierran|hasta que hora|desde que hora)\b/.test(normalized)) {
    const courts = await fetchCourtHours(input.db, input.tenantId);
    if (!courts.length) return "Aún no tengo horarios cargados, te confirmo en cuanto pueda.";
    const lines = courts.map(
      (c) => `• ${c.sport_name}: ${c.open_time.slice(0, 5)} a ${c.close_time.slice(0, 5)}`,
    );
    return `Horarios:\n${lines.join("\n")}`;
  }

  if (/\b(deporte|deportes|que cancha|canchas tienen)\b/.test(normalized)) {
    const courts = await fetchCourtSports(input.db, input.tenantId);
    if (!courts.length) return "Aún no tengo deportes configurados.";
    return `Tenemos canchas de: ${courts.map((c) => c.sport_name).join(", ")}.`;
  }

  if (/\b(direccion|donde estan|donde quedan|ubicacion|donde es)\b/.test(normalized)) {
    const tenant = await fetchTenant(input.db, input.tenantId);
    return tenant?.address?.trim()
      ? `Estamos en ${tenant.address}.`
      : "Te paso la dirección en breve.";
  }

  if (/\b(cancelar|cancelacion|anular)\b/.test(normalized)) {
    const hours = policy.cancellation_min_hours ?? 0;
    return hours > 0
      ? `Podés cancelar hasta ${hours} hs antes del turno. Si necesitás, mandame el día y horario para cancelarla.`
      : "Podés cancelar la reserva en cualquier momento. Mandame el día y horario para cancelarla.";
  }

  return "Decime concretamente qué querés saber y te ayudo.";
}

async function fetchTenant(db: SupabaseClient, tenantId: string) {
  const { data } = await db
    .from("tenants")
    .select("name, address")
    .eq("id", tenantId)
    .maybeSingle();
  return data;
}

async function fetchCourtPrices(db: SupabaseClient, tenantId: string) {
  const { data } = await db
    .from("court_types")
    .select("sport_name, price_per_slot")
    .eq("tenant_id", tenantId)
    .eq("active", true);
  return (data ?? []).map((row) => ({
    sport_name: row.sport_name as string,
    price: row.price_per_slot as number | null,
  }));
}

async function fetchCourtHours(db: SupabaseClient, tenantId: string) {
  const { data } = await db
    .from("court_types")
    .select("sport_name, open_time, close_time")
    .eq("tenant_id", tenantId)
    .eq("active", true);
  return (data ?? []) as Array<{ sport_name: string; open_time: string; close_time: string }>;
}

async function fetchCourtSports(db: SupabaseClient, tenantId: string) {
  const { data } = await db
    .from("court_types")
    .select("sport_name")
    .eq("tenant_id", tenantId)
    .eq("active", true);
  return (data ?? []) as Array<{ sport_name: string }>;
}

async function normalizeMessage(input: FallbackInput) {
  try {
    const history = await loadHistory(input.db, input.conversationId);
    return await new IntentExtractor().normalize({
      message: input.message,
      timezone: input.timezone,
      history,
    });
  } catch {
    return null;
  }
}

async function loadHistory(db: SupabaseClient, conversationId: string) {
  const { data } = await db
    .from("messages")
    .select("direction, content")
    .eq("conversation_id", conversationId)
    .order("created_at", { ascending: false })
    .limit(12);

  return (data ?? []).reverse().map((m) => ({
    role: m.direction === "inbound" ? ("user" as const) : ("assistant" as const),
    content: m.content,
  }));
}

function normalizeText(value: string): string {
  return value
    .normalize("NFD")
    .replace(/\p{Diacritic}/gu, "")
    .toLowerCase();
}

function looksLikeOperationalIntent(message: string): boolean {
  const normalized = normalizeText(message);
  return /\b(reserv|agend|anot|sacar|turno|cancha|cancel|anul|baja|reprogram|cambi|mover|mande|transferi|comprobante|sena|seña|disponib|horario)\b/.test(
    normalized,
  );
}
