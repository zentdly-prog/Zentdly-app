import OpenAI from "openai";
import { formatInTimeZone } from "date-fns-tz";
import {
  ExtractedBookingSchema,
  NormalizedIntentSchema,
  REQUIRED_FIELDS_BY_INTENT,
  type ExtractedBooking,
  type NormalizedIntent,
} from "./schemas";
import type { AgentConversationState } from "@/domain/conversation/agentOps";

type ConversationRole = "user" | "assistant";

export interface IntentExtractorInput {
  message: string;
  timezone?: string;
  history?: Array<{ role: ConversationRole; content: string }>;
  state?: AgentConversationState | Record<string, unknown> | null;
  now?: Date;
}

const NORMALIZER_SYSTEM_PROMPT = `Sos un extractor de intención para reservas de canchas por WhatsApp.
Tu única tarea es transformar lenguaje humano en JSON estructurado para que otro motor determinístico ejecute reglas.

NO podés reservar, cancelar, reprogramar, confirmar ni prometer acciones.
NO respondas al cliente.
NO inventes disponibilidad, reservas, precios ni IDs.
Devolvé SOLO JSON válido.

Interpretación:
- Corregí errores de tipeo por contexto: "mama", "maña", "manana" pueden significar "mañana" si el mensaje habla de fecha.
- Interpretá referencias contextuales: "esas", "esas 3", "las de mañana", "todas", "la última", "ese horario".
- Si el cliente confirma algo con "sí", "dale", "ok", usá el estado/historial para marcar confirmation.
- Si dice "no", "nono", "mejor no", marcá rechazo.
- Los horarios se devuelven en HH:mm 24hs.
- Si el horario es ambiguo como "a las 8", "8:30" o "las 10" sin am/pm/tarde/noche, poné time=null, time_ambiguous=true y time_options con mañana/noche.
- Si dice "8 de la noche", "8pm", "20", devolvé "20:00".
- Si dice "8 de la mañana", "8am", devolvé "08:00".
- Las fechas relativas se calculan con la fecha local provista.
- Si no estás seguro de un campo, usá null y bajá confidence.

Intenciones:
- booking: quiere reservar/agendar/anotar/sacar cancha.
- availability: pregunta horarios/disponibilidad.
- cancel: quiere cancelar/anular/dar de baja.
- reschedule: quiere cambiar/reprogramar una reserva.
- deposit_confirmation: manda comprobante o dice que pagó/transfirió seña.
- policy_question: pregunta precio, seña, reglas, cancelación o condiciones.
- greeting: saludo sin pedido operativo.
- human_handoff: pide hablar con una persona.
- unknown: no alcanza para clasificar.

Acciones solicitadas:
- create_reservation o create_pending_reservation solo significan "el usuario pidió esto"; NO significa que esté ejecutado.
- cancel_many_reservations si pide cancelar "todas", "esas 3", "las de mañana" o un grupo.
- list_reservations si pide ver qué reservas tiene o no identificó cuál cancelar.
- ask_time_clarification si el horario es ambiguo.
- ask_missing_data si falta un dato crítico.
- none si no hay acción operativa.

JSON exacto:
{
  "intent": "booking" | "availability" | "cancel" | "reschedule" | "deposit_confirmation" | "policy_question" | "greeting" | "human_handoff" | "unknown",
  "action_requested": "ask_missing_data" | "ask_time_clarification" | "check_availability" | "create_reservation" | "create_pending_reservation" | "confirm_pending_reservation" | "list_reservations" | "cancel_reservation" | "cancel_many_reservations" | "reschedule_reservation" | "answer_policy" | "handoff" | "none",
  "date": "YYYY-MM-DD" | null,
  "time": "HH:mm" | null,
  "time_ambiguous": boolean,
  "time_options": ["HH:mm"],
  "sport": string | null,
  "quantity": number | null,
  "customer_name": string | null,
  "reservation_id": string | null,
  "contextual_reference": {
    "type": "none" | "last_listed_reservations" | "last_offered_slots" | "last_pending_reservations" | "last_created_reservations" | "customer_active_reservations" | "explicit_reservation_id" | "explicit_date_time",
    "scope": "none" | "one" | "mentioned_quantity" | "all" | "same_time" | "same_day" | "last_group",
    "text": string | null
  },
  "confirmation": {
    "is_confirmation": boolean,
    "is_rejection": boolean,
    "target_action": "none" | "booking" | "cancel" | "reschedule" | "deposit_confirmation" | "time_clarification"
  },
  "missing_fields": ["sport" | "date" | "time" | "customer_name" | "quantity" | "reservation"],
  "confidence": number,
  "notes": string | null
}`;

export class IntentExtractor {
  private client: OpenAI | null = null;

  private getClient(): OpenAI {
    if (!process.env.OPENAI_API_KEY) {
      throw new Error("Missing OPENAI_API_KEY environment variable");
    }

    this.client ??= new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
    return this.client;
  }

  async normalize(input: IntentExtractorInput): Promise<NormalizedIntent> {
    const timezone = input.timezone ?? "America/Argentina/Buenos_Aires";
    const now = input.now ?? new Date();
    const today = formatInTimeZone(now, timezone, "yyyy-MM-dd");
    const nowLocal = formatInTimeZone(now, timezone, "yyyy-MM-dd HH:mm");
    const history = (input.history ?? []).slice(-12);

    const response = await this.getClient().chat.completions.create({
      model: "gpt-4o-mini",
      temperature: 0,
      response_format: { type: "json_object" },
      messages: [
        { role: "system", content: NORMALIZER_SYSTEM_PROMPT },
        {
          role: "user",
          content: JSON.stringify({
            today,
            now_local: nowLocal,
            timezone,
            message: input.message,
            state: input.state ?? null,
            history,
          }),
        },
      ],
    });

    const raw = safeJsonParse(response.choices[0]?.message?.content);
    try {
      const parsed = NormalizedIntentSchema.parse(raw);
      return normalizeMissingFields(parsed);
    } catch (error) {
      const err = error instanceof Error ? error : new Error("schema parse failed");
      (err as Error & { rawPayload?: unknown }).rawPayload = raw;
      throw err;
    }
  }

  async extract(
    userMessage: string,
    timezone = "America/Argentina/Buenos_Aires",
  ): Promise<ExtractedBooking> {
    const normalized = await this.normalize({ message: userMessage, timezone });
    const legacy = {
      intent: toLegacyIntent(normalized.intent),
      sport: normalized.sport,
      venue: null,
      date: normalized.date,
      time: normalized.time,
      duration_minutes: null,
      customer_name: normalized.customer_name,
      needs_follow_up: normalized.missing_fields.length > 0,
      missing_fields: normalized.missing_fields,
    };

    const parsed = ExtractedBookingSchema.parse(legacy);
    const required = REQUIRED_FIELDS_BY_INTENT[parsed.intent] ?? [];
    parsed.missing_fields = required.filter((field) => parsed[field as keyof ExtractedBooking] === null);
    parsed.needs_follow_up = parsed.missing_fields.length > 0;
    return parsed;
  }
}

function normalizeMissingFields(intent: NormalizedIntent): NormalizedIntent {
  const missing = new Set(intent.missing_fields);

  if ((intent.intent === "booking" || intent.intent === "reschedule" || intent.intent === "availability") && !intent.date) {
    missing.add("date");
  }
  if ((intent.intent === "booking" || intent.intent === "reschedule") && !intent.time) {
    missing.add("time");
  }
  if (intent.intent === "booking" && !intent.customer_name) {
    missing.add("customer_name");
  }
  if ((intent.intent === "cancel" || intent.intent === "reschedule") && !intent.reservation_id && intent.contextual_reference.type === "none" && (!intent.date || !intent.time)) {
    missing.add("reservation");
  }
  if (intent.time_ambiguous) {
    missing.add("time");
  }

  return {
    ...intent,
    missing_fields: [...missing],
    action_requested: intent.time_ambiguous ? "ask_time_clarification" : intent.action_requested,
  };
}

function safeJsonParse(value: string | null | undefined): unknown {
  if (!value) return {};
  try {
    return JSON.parse(value);
  } catch {
    const match = value.match(/\{[\s\S]*\}/);
    return match ? JSON.parse(match[0]) : {};
  }
}

function toLegacyIntent(intent: NormalizedIntent["intent"]): ExtractedBooking["intent"] {
  switch (intent) {
    case "booking":
      return "create_reservation";
    case "availability":
      return "query_availability";
    case "cancel":
      return "cancel_reservation";
    case "reschedule":
      return "reschedule_reservation";
    default:
      return "unknown";
  }
}
