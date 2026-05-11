import OpenAI from "openai";
import { SupabaseClient } from "@supabase/supabase-js";
import type { ChatCompletionMessageParam, ChatCompletionTool } from "openai/resources/chat/completions";
import {
  createAgentBookingServices,
  type CalendarSyncReservation,
} from "@/domain/booking/agentBookingServices";
import { logAgentEvent, saveAgentState } from "@/domain/conversation/agentOps";

let openaiClient: OpenAI | null = null;

function getOpenAIClient(): OpenAI {
  if (!process.env.OPENAI_API_KEY) {
    throw new Error("Missing OPENAI_API_KEY environment variable");
  }

  openaiClient ??= new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
  return openaiClient;
}

// ─── Tool definitions ─────────────────────────────────────────────────────────

const TOOLS: ChatCompletionTool[] = [
  // Operational tools are intentionally disabled here.
  // Booking, availability, cancellation, rescheduling and deposit confirmation
  // must go through the deterministic booking router.
];

const FALLBACK_OPERATION_GUARDRAIL = `
Este es un fallback conversacional sin permiso para ejecutar acciones.
No podés afirmar que una reserva fue reservada, agendada, anotada, cancelada, reprogramada, confirmada o pagada.
No podés usar frases como "te reservé", "quedó reservado", "reserva confirmada", "cancelé" o equivalentes.
Si el cliente pide una acción operativa, pedí el dato faltante o indicá que necesitás verificarlo. La única capa que puede confirmar acciones es el motor determinístico.
`.trim();

// ─── Tool executor ────────────────────────────────────────────────────────────

interface AgentDeps {
  db: SupabaseClient;
  tenantId: string;
  customerId: string;
  customerPhone: string;
  timezone: string;
  conversationId?: string;
}

async function executeTool(
  name: string,
  args: Record<string, string>,
  deps: AgentDeps
): Promise<string> {
  const { db, tenantId, customerId, timezone } = deps;
  const booking = createAgentBookingServices({
    db,
    tenantId,
    customerId,
    customerPhone: deps.customerPhone,
    timezone,
    calendarSync: {
      sync: (reservation, customerName, customerPhone, tz) =>
        syncGoogleCalendar(db, tenantId, reservation, customerName, customerPhone, tz),
      delete: (externalEventId, tz) => deleteGoogleCalendarEvent(db, tenantId, externalEventId, tz),
    },
  });

  switch (name) {
    case "check_availability":
      return withToolLog(name, args, deps, () => booking.availability.check(args.date, args.sport_name));

    case "create_reservation":
      return withToolLog(name, args, deps, () => booking.reservations.create(args));

    case "list_my_reservations":
      return withToolLog(name, args, deps, () => booking.reservations.list());

    case "cancel_reservation":
      return withToolLog(name, args, deps, () => booking.reservations.cancel(args));

    case "reschedule_reservation":
      return withToolLog(name, args, deps, () => booking.reservations.reschedule(args));

    default:
      return "Tool no reconocida.";
  }
}

async function withToolLog(
  toolName: string,
  args: Record<string, string>,
  deps: AgentDeps,
  run: () => Promise<string>,
): Promise<string> {
  await saveAgentState(deps.db, deps.conversationId ?? "", {
    status: "executing",
    collected: {
      sport: args.sport_name,
      date: args.date,
      time: args.time,
      customer_name: args.customer_name,
      reservation_id: args.reservation_id,
    },
  }).catch(() => undefined);

  try {
    const result = await run();
    await logAgentEvent(deps.db, {
      tenantId: deps.tenantId,
      conversationId: deps.conversationId,
      customerId: deps.customerId,
      eventType: "tool_completed",
      toolName,
      payload: { args, result },
    });
    return result;
  } catch (error) {
    await logAgentEvent(deps.db, {
      tenantId: deps.tenantId,
      conversationId: deps.conversationId,
      customerId: deps.customerId,
      eventType: "tool_failed",
      toolName,
      payload: { args },
      error: error instanceof Error ? error.message : "Unknown tool error",
    });
    throw error;
  }
}

async function syncGoogleCalendar(
  db: SupabaseClient,
  tenantId: string,
  reservation: CalendarSyncReservation,
  customerName: string,
  customerPhone: string,
  tz: string
): Promise<void> {
  const { data: config } = await db
    .from("google_config")
    .select("service_account, calendar_id, calendar_enabled")
    .eq("tenant_id", tenantId)
    .single();

  if (!config?.calendar_enabled || !config.calendar_id || !config.service_account) return;

  try {
    const { GoogleCalendarProvider } = await import("@/integrations/google/calendarProvider");
    const calendar = new GoogleCalendarProvider({
      credentials: {
        client_email: config.service_account.client_email as string,
        private_key: config.service_account.private_key as string,
      },
      calendar_id: config.calendar_id,
      timezone: tz,
    });

    const result = await calendar.syncReservation(
      reservation as never,
      customerName || "Cliente",
      customerPhone
    );

    await db
      .from("reservations")
      .update({ external_event_id: result.externalId })
      .eq("id", reservation.id);
  } catch (error) {
    console.error("[agent] Google Calendar sync failed:", error);
  }
}

async function deleteGoogleCalendarEvent(
  db: SupabaseClient,
  tenantId: string,
  externalEventId: string | null,
  tz: string
): Promise<void> {
  if (!externalEventId) return;

  const { data: config } = await db
    .from("google_config")
    .select("service_account, calendar_id, calendar_enabled")
    .eq("tenant_id", tenantId)
    .single();

  if (!config?.calendar_enabled || !config.calendar_id || !config.service_account) return;

  try {
    const { GoogleCalendarProvider } = await import("@/integrations/google/calendarProvider");
    const calendar = new GoogleCalendarProvider({
      credentials: {
        client_email: config.service_account.client_email as string,
        private_key: config.service_account.private_key as string,
      },
      calendar_id: config.calendar_id,
      timezone: tz,
    });

    await calendar.deleteReservation(externalEventId);
  } catch (error) {
    console.error("[agent] Google Calendar delete failed:", error);
  }
}

// ─── Main agent runner ────────────────────────────────────────────────────────

export async function runAgent(
  systemPrompt: string,
  chatHistory: ChatCompletionMessageParam[],
  userMessage: string,
  _deps: AgentDeps
): Promise<string> {
  const openai = getOpenAIClient();
  const messages: ChatCompletionMessageParam[] = [
    { role: "system", content: systemPrompt },
    { role: "system", content: FALLBACK_OPERATION_GUARDRAIL },
    ...chatHistory,
    { role: "user", content: userMessage },
  ];

  // Allow up to 3 tool call rounds
  for (let round = 0; round < 3; round++) {
    const response = await openai.chat.completions.create({
      model: "gpt-4o-mini",
      temperature: 0.4,
      tools: TOOLS.length ? TOOLS : undefined,
      tool_choice: TOOLS.length ? "auto" : undefined,
      messages,
    });

    const choice = response.choices[0];
    const assistantMsg = choice.message;
    messages.push(assistantMsg);

    // No tool calls → final answer
    if (!assistantMsg.tool_calls?.length) {
      return sanitizeFallbackReply(assistantMsg.content?.trim() ?? "No pude generar una respuesta.", _deps);
    }

    // Execute each tool call
    for (const call of assistantMsg.tool_calls) {
      const fn = (call as { function: { name: string; arguments: string } }).function;
      const args = JSON.parse(fn.arguments) as Record<string, string>;
      const result = await executeTool(fn.name, args, _deps);
      messages.push({
        role: "tool",
        tool_call_id: call.id,
        content: result,
      });
    }
  }

  // Fallback after max rounds
  const finalResponse = await openai.chat.completions.create({
    model: "gpt-4o-mini",
    temperature: 0.4,
    messages,
  });
  return sanitizeFallbackReply(finalResponse.choices[0]?.message?.content?.trim() ?? "No pude procesar tu consulta.", _deps);
}

function sanitizeFallbackReply(reply: string, deps: AgentDeps): string {
  if (!containsOperationalClaim(reply)) return reply;

  logAgentEvent(deps.db, {
    tenantId: deps.tenantId,
    conversationId: deps.conversationId,
    customerId: deps.customerId,
    eventType: "fallback_operational_claim_blocked",
    payload: { blockedReply: reply },
  }).catch(() => undefined);

  return "Para eso necesito verificarlo en el sistema. Escribime el día, horario y nombre, o indicame el ID de la reserva si lo tenés.";
}

function containsOperationalClaim(reply: string): boolean {
  const normalized = reply
    .normalize("NFD")
    .replace(/\p{Diacritic}/gu, "")
    .toLowerCase();

  return [
    /\b(te\s+)?reserve\b/,
    /\b(te\s+)?agende\b/,
    /\b(te\s+)?anote\b/,
    /\b(cancele|cancelamos|cancelada|cancelado|queda\s+cancelad[ao]|quedo\s+cancelad[ao])\b/,
    /\b(confirm[eé]|confirmamos|confirmada|confirmado|queda\s+confirmad[ao]|quedo\s+confirmad[ao])\b/,
    /\b(reservada|reservado|queda\s+reservad[ao]|quedo\s+reservad[ao])\b/,
    /\b(reprogram[eé]|reprogramamos|reprogramada|reprogramado|queda\s+reprogramad[ao]|quedo\s+reprogramad[ao])\b/,
    /\b(voy|vamos|procedo|procedemos|proceder[eé]|paso|pasamos)\s+a\s+(reservar|agendar|anotar|cancelar|confirmar|reprogramar)\b/,
    /\b(voy|vamos)\s+a\s+proceder\s+a\s+(reservar|agendar|anotar|cancelar|confirmar|reprogramar)\b/,
    /\bproced(?:o|emos|ere|eremos)\s+a\s+(reservar|agendar|anotar|cancelar|confirmar|reprogramar)\b/,
    /\b(un momento|aguardame|esperame)[\s\S]{0,80}\b(reservar|agendar|anotar|cancelar|confirmar|reprogramar)\b/,
    /\b(seña|sena)\s+(recibida|confirmada|confirmado|pagada|pagado)\b/,
  ].some((pattern) => pattern.test(normalized));
}
