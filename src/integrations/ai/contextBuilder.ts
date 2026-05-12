import { SupabaseClient } from "@supabase/supabase-js";
import { formatInTimeZone, toZonedTime } from "date-fns-tz";
import { parseISO } from "date-fns";
import type { ChatCompletionMessageParam } from "openai/resources/chat/completions";

const DAYS_ES = ["domingo", "lunes", "martes", "miércoles", "jueves", "viernes", "sábado"];
const MONTHS_ES = [
  "enero", "febrero", "marzo", "abril", "mayo", "junio",
  "julio", "agosto", "septiembre", "octubre", "noviembre", "diciembre",
];

export interface BuiltContext {
  systemPrompt: string;
  chatHistory: ChatCompletionMessageParam[];
}

export async function buildAgentContext(
  db: SupabaseClient,
  tenantId: string,
  conversationId: string,
  customerId: string,
  timezone: string,
): Promise<BuiltContext> {
  const [tenant, customer, history, policy, courts, customerReservations] = await Promise.all([
    fetchTenant(db, tenantId),
    fetchCustomer(db, customerId),
    fetchHistory(db, conversationId),
    fetchBotPolicy(db, tenantId),
    fetchCourts(db, tenantId),
    fetchCustomerReservations(db, tenantId, customerId, timezone),
  ]);

  const now = new Date();
  const nowLocal = toZonedTime(now, timezone);
  const dayName = DAYS_ES[nowLocal.getDay()];
  const monthName = MONTHS_ES[nowLocal.getMonth()];
  const today = formatInTimeZone(now, timezone, "yyyy-MM-dd");
  const nowTime = formatInTimeZone(now, timezone, "HH:mm");
  const dateLine = `Hoy es ${dayName} ${nowLocal.getDate()} de ${monthName} de ${nowLocal.getFullYear()}, son las ${nowTime} hs. Fecha ISO: ${today}. Zona horaria: ${timezone}.`;

  const businessName = tenant?.name?.trim() || "el complejo";
  const businessAddress = tenant?.address?.trim() || null;
  const customPrompt = tenant?.bot_prompt?.trim() || null;

  const customerLine =
    customer?.name?.trim()
      ? `Cliente actual: ${customer.name.trim()} · Teléfono: ${customer.phone_e164 ?? "—"}`
      : `Cliente actual: nombre no informado · Teléfono: ${customer?.phone_e164 ?? "—"}`;

  const courtsBlock = courts.length
    ? courts.map((c) => {
        const price = c.price_per_slot != null ? `$${c.price_per_slot}` : "consultar";
        const days = c.days_of_week
          .slice()
          .sort()
          .map((d: number) => DAYS_ES[d])
          .join(", ");
        const lines = [
          `### ${c.sport_name}`,
          `Horario: ${c.open_time.slice(0, 5)} a ${c.close_time.slice(0, 5)} · ${c.slot_duration_minutes} min/turno · ${price} · ${c.quantity} cancha${c.quantity !== 1 ? "s" : ""}`,
          `Días: ${days}`,
        ];
        if (c.description?.trim()) lines.push(`Descripción: ${c.description.trim()}`);
        if (c.equipment_rental?.trim()) lines.push(`Alquiler de equipo: ${c.equipment_rental.trim()}`);
        if (c.rain_policy?.trim()) lines.push(`Política de lluvia: ${c.rain_policy.trim()}`);
        return lines.join("\n");
      }).join("\n\n")
    : "(sin canchas configuradas)";

  const policyBlock = [
    `- Requiere seña: ${policy.requires_deposit ? "sí" : "no"}`,
    policy.deposit_amount != null ? `- Seña fija: $${policy.deposit_amount}` : null,
    policy.deposit_percentage != null ? `- Seña %: ${policy.deposit_percentage}% del turno` : null,
    `- Estado inicial de reserva: ${policy.reservation_status_default}`,
    `- Horas mínimas para cancelar: ${policy.cancellation_min_hours ?? 0}`,
    `- Horas mínimas para reprogramar: ${policy.reschedule_min_hours ?? 0}`,
    policy.audio_message ? `- Mensaje al recibir audios: "${policy.audio_message}"` : null,
  ].filter(Boolean).join("\n");

  const reservationsBlock = customerReservations.length
    ? customerReservations.join("\n")
    : "(el cliente no tiene reservas activas)";

  const systemPrompt = `Sos el asistente de WhatsApp de *${businessName}*, un complejo de canchas deportivas en Argentina.

${dateLine}
${businessAddress ? `Dirección: ${businessAddress}` : ""}

═══════════════════════════════
QUIÉN ES ESTE CLIENTE
═══════════════════════════════
${customerLine}

Reservas activas del cliente:
${reservationsBlock}

═══════════════════════════════
CANCHAS Y SERVICIOS DEL NEGOCIO
═══════════════════════════════
${courtsBlock}

═══════════════════════════════
POLÍTICAS DEL NEGOCIO
═══════════════════════════════
${policyBlock}

${customPrompt ? `═══════════════════════════════\nINSTRUCCIONES ADICIONALES DEL NEGOCIO\n═══════════════════════════════\n${customPrompt}\n\n` : ""}═══════════════════════════════
CÓMO TRABAJAR
═══════════════════════════════
- Hablás en español rioplatense, natural y breve. Como un encargado humano, no como un robot.
- Para CUALQUIER acción (reservar, cancelar, confirmar seña, reagendar, consultar disponibilidad, ver reservas del cliente) usás las TOOLS. Nunca afirmes que hiciste algo sin haber recibido un resultado positivo de la tool correspondiente.
- Si te falta un dato para una tool (fecha, hora, nombre, etc.), preguntá. No inventes.
- Si el cliente da un horario ambiguo entre AM y PM (ej. "a las 8", "las 10"), preguntá "¿8:00 o 20:00?" antes de reservar. Horarios ≥12 (ej. "15:30", "20") son SIEMPRE PM, no ambiguos.
- Entendés números en español ("quinse treinta" = 15:30, "ocho y media" = 8:30, "veintiuna" = 21:00, "ocho de la noche" = 20:00, "ocho de la mañana" = 8:00).
- Si el cliente corrige algo ("no, era a las 8", "el 11 no el 12"), actualizá el dato y, si ya existía una reserva pendiente, reagendala con reschedule_reservation.
- Nunca reserves en el pasado. Si pide algo ya pasado, decile y ofrecé un horario futuro.
- Si el cliente manda una imagen o documento (PDF) Y tiene reservas pendientes esperando seña, asumí que es el comprobante y ejecutá confirm_deposit. Si no tiene pendientes, preguntá qué quiere hacer.
- Si el cliente quiere consultar precio/seña/horario/dirección/Instagram/web/dirección/maps, usá get_business_info con el topic correspondiente. No inventes valores.
- Para preguntas sobre la cancha en sí (alquiler de pelotas/paletas/equipo, qué pasa si llueve, qué incluye el turno) leé la sección "CANCHAS Y SERVICIOS DEL NEGOCIO" de arriba. Cada deporte tiene su Descripción, Alquiler de equipo y Política de lluvia. Pasale al cliente literalmente lo que figura ahí. Si para ese deporte no hay info cargada en esos campos, decí que vas a consultar y no inventes.
- CUANDO LE PIDAS LA SEÑA, llamá get_business_info con topic="payment_method" para conseguir el alias/CBU y el nombre del titular, y pasáselos al cliente en el mismo mensaje. Si el negocio no tiene alias cargado, decile que vas a pedir los datos al complejo.
- Para listar reservas del cliente o identificar una para cancelar/mover, usá list_my_reservations.
- Si una tool devuelve un error o mensaje de "no se pudo", pasale ese mensaje al cliente de forma clara y natural, no lo inventes.
- Respondé en 1-3 líneas como máximo. Si tenés que listar opciones, usá bullets cortos.
- Nunca prometas resultados a futuro ("voy a..."). Ejecutá la tool primero, después comunicá el resultado.
- Si el cliente dice "olvidate" / "empezar de nuevo" / "borrar todo", asumí que se reseteó el contexto (el sistema ya lo hizo) y arrancá de cero.`;

  return { systemPrompt, chatHistory: history };
}

async function fetchTenant(db: SupabaseClient, tenantId: string) {
  const { data } = await db
    .from("tenants")
    .select("name, address, bot_prompt")
    .eq("id", tenantId)
    .maybeSingle();
  return data as { name: string; address: string | null; bot_prompt: string | null } | null;
}

async function fetchCustomer(db: SupabaseClient, customerId: string) {
  const { data } = await db
    .from("customers")
    .select("name, phone_e164")
    .eq("id", customerId)
    .maybeSingle();
  return data as { name: string | null; phone_e164: string | null } | null;
}

async function fetchHistory(
  db: SupabaseClient,
  conversationId: string,
): Promise<ChatCompletionMessageParam[]> {
  const { data } = await db
    .from("messages")
    .select("direction, content, created_at")
    .eq("conversation_id", conversationId)
    .order("created_at", { ascending: false })
    .limit(30);

  const ordered = (data ?? []).reverse();
  return ordered.map((m) => ({
    role: m.direction === "inbound" ? "user" : "assistant",
    content: m.content as string,
  })) as ChatCompletionMessageParam[];
}

async function fetchBotPolicy(db: SupabaseClient, tenantId: string) {
  const { data } = await db
    .from("tenant_bot_policies")
    .select("cancellation_min_hours, reschedule_min_hours, requires_deposit, deposit_amount, deposit_percentage, reservation_status_default, audio_message, human_handoff_message")
    .eq("tenant_id", tenantId)
    .maybeSingle();
  return (data ?? {
    cancellation_min_hours: 0,
    reschedule_min_hours: 0,
    requires_deposit: false,
    deposit_amount: null,
    deposit_percentage: null,
    reservation_status_default: "confirmed",
    audio_message: "No puedo escuchar audios.",
    human_handoff_message: "Te derivo con una persona del equipo.",
  }) as {
    cancellation_min_hours: number;
    reschedule_min_hours: number;
    requires_deposit: boolean;
    deposit_amount: number | null;
    deposit_percentage: number | null;
    reservation_status_default: string;
    audio_message: string;
    human_handoff_message: string;
  };
}

async function fetchCourts(db: SupabaseClient, tenantId: string) {
  const { data, error } = await db
    .from("court_types")
    .select("sport_name, open_time, close_time, slot_duration_minutes, quantity, price_per_slot, days_of_week, description, equipment_rental, rain_policy")
    .eq("tenant_id", tenantId)
    .eq("active", true);

  // Fallback if equipment_rental / rain_policy columns don't exist yet
  if (error?.code === "42703") {
    const { data: fallback } = await db
      .from("court_types")
      .select("sport_name, open_time, close_time, slot_duration_minutes, quantity, price_per_slot, days_of_week, description")
      .eq("tenant_id", tenantId)
      .eq("active", true);
    return (fallback ?? []).map((c) => ({ ...c, equipment_rental: null, rain_policy: null })) as Array<CourtRow>;
  }

  return (data ?? []) as Array<CourtRow>;
}

type CourtRow = {
  sport_name: string;
  open_time: string;
  close_time: string;
  slot_duration_minutes: number;
  quantity: number;
  price_per_slot: number | null;
  days_of_week: number[];
  description: string | null;
  equipment_rental: string | null;
  rain_policy: string | null;
};

async function fetchCustomerReservations(
  db: SupabaseClient,
  tenantId: string,
  customerId: string,
  timezone: string,
): Promise<string[]> {
  const { data } = await db
    .from("reservations")
    .select("id, starts_at, status, notes, court_types(sport_name)")
    .eq("tenant_id", tenantId)
    .eq("customer_id", customerId)
    .in("status", ["confirmed", "pending"])
    .gte("starts_at", new Date().toISOString())
    .order("starts_at", { ascending: true })
    .limit(15);

  return (data ?? []).map((r) => {
    const ct = r.court_types as { sport_name: string } | { sport_name: string }[] | null;
    const sport = (Array.isArray(ct) ? ct[0]?.sport_name : ct?.sport_name) ?? "Cancha";
    const when = formatInTimeZone(parseISO(r.starts_at as string), timezone, "EEE dd/MM HH:mm");
    const notes = r.notes ? ` · ${r.notes}` : "";
    return `- ${(r.id as string).slice(0, 8)} · ${sport}${notes} · ${when} · ${r.status}`;
  });
}
