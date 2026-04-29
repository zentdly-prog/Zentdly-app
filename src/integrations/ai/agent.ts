import OpenAI from "openai";
import { SupabaseClient } from "@supabase/supabase-js";
import { formatInTimeZone, fromZonedTime, toZonedTime } from "date-fns-tz";
import { addMinutes, parseISO } from "date-fns";
import type { ChatCompletionMessageParam, ChatCompletionTool } from "openai/resources/chat/completions";

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
  {
    type: "function",
    function: {
      name: "check_availability",
      description: "Consulta los turnos disponibles para una fecha y deporte. Usá esta tool cuando el cliente pregunta por disponibilidad o quiere reservar.",
      parameters: {
        type: "object",
        properties: {
          date: { type: "string", description: "Fecha en formato YYYY-MM-DD" },
          sport_name: { type: "string", description: "Nombre del deporte (opcional, ej: 'Fútbol 5')" },
        },
        required: ["date"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "create_reservation",
      description: "Crea una reserva cuando el cliente confirmó deporte, fecha, horario y nombre. Solo llamar cuando tenés todos los datos confirmados por el cliente.",
      parameters: {
        type: "object",
        properties: {
          customer_name: { type: "string", description: "Nombre del cliente" },
          sport_name: { type: "string", description: "Nombre del deporte" },
          date: { type: "string", description: "Fecha en formato YYYY-MM-DD" },
          time: { type: "string", description: "Horario en formato HH:mm" },
        },
        required: ["customer_name", "sport_name", "date", "time"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "list_my_reservations",
      description: "Lista las reservas activas del cliente actual.",
      parameters: { type: "object", properties: {} },
    },
  },
  {
    type: "function",
    function: {
      name: "cancel_reservation",
      description: "Cancela una reserva del cliente.",
      parameters: {
        type: "object",
        properties: {
          reservation_id: { type: "string", description: "ID de la reserva a cancelar" },
        },
        required: ["reservation_id"],
      },
    },
  },
];

// ─── Tool executor ────────────────────────────────────────────────────────────

interface AgentDeps {
  db: SupabaseClient;
  tenantId: string;
  customerId: string;
  customerPhone: string;
  timezone: string;
}

async function executeTool(
  name: string,
  args: Record<string, string>,
  deps: AgentDeps
): Promise<string> {
  const { db, tenantId, customerId, timezone } = deps;

  switch (name) {
    case "check_availability":
      return checkAvailability(db, tenantId, args.date, args.sport_name, timezone);

    case "create_reservation":
      return createReservation(db, tenantId, customerId, args, timezone);

    case "list_my_reservations":
      return listReservations(db, tenantId, customerId, timezone);

    case "cancel_reservation":
      return cancelReservation(db, args.reservation_id, customerId);

    default:
      return "Tool no reconocida.";
  }
}

// ─── Tool implementations ─────────────────────────────────────────────────────

async function checkAvailability(
  db: SupabaseClient,
  tenantId: string,
  date: string,
  sportName: string | undefined,
  tz: string
): Promise<string> {
  // Use noon UTC to safely determine day-of-week in any timezone
  const dow = toZonedTime(new Date(`${date}T12:00:00Z`), tz).getDay();

  let query = db
    .from("court_types")
    .select("id, sport_name, slot_duration_minutes, open_time, close_time, quantity, price_per_slot, days_of_week")
    .eq("tenant_id", tenantId)
    .eq("active", true);

  if (sportName) {
    query = query.ilike("sport_name", `%${sportName}%`);
  }

  const { data: courts } = await query;
  if (!courts?.length) return "No hay canchas configuradas para ese deporte.";

  // Timezone-aware window: local midnight to +30h (covers overnight courts)
  const dayStart = fromZonedTime(`${date}T00:00:00`, tz).toISOString();
  const dayEnd = new Date(fromZonedTime(`${date}T00:00:00`, tz).getTime() + 30 * 3600 * 1000).toISOString();
  const { data: reservations } = await db
    .from("reservations")
    .select("starts_at, ends_at, court_type_id, status")
    .eq("tenant_id", tenantId)
    .in("status", ["confirmed", "pending"])
    .gte("starts_at", dayStart)
    .lte("starts_at", dayEnd);

  const now = new Date();
  const lines: string[] = [`Disponibilidad para el ${date}:`];

  for (const court of courts) {
    if (!court.days_of_week.includes(dow)) {
      lines.push(`- ${court.sport_name}: no trabaja ese día.`);
      continue;
    }

    const slots = getSlotsForDay(court, date, now, reservations ?? [], tz);
    const price = court.price_per_slot != null ? ` ($${court.price_per_slot})` : "";

    if (slots.length === 0) {
      lines.push(`- ${court.sport_name}${price}: COMPLETO`);
    } else {
      lines.push(`- ${court.sport_name}${price}: ${slots.join(", ")}`);
    }
  }

  return lines.join("\n");
}

function getSlotsForDay(
  court: { id: string; slot_duration_minutes: number; open_time: string; close_time: string; quantity: number },
  date: string,
  now: Date,
  reservations: { starts_at: string; ends_at: string; court_type_id: string }[],
  tz: string
): string[] {
  // Overnight support: if close ≤ open, close is on the next calendar day
  const isOvernight = court.close_time <= court.open_time;
  const nextDayStr = formatInTimeZone(
    new Date(fromZonedTime(`${date}T00:00:00`, tz).getTime() + 86400000),
    tz, "yyyy-MM-dd"
  );
  const closeDateStr = isOvernight ? nextDayStr : date;

  const slotStart = fromZonedTime(`${date}T${court.open_time}:00`, tz);
  const slotEnd   = fromZonedTime(`${closeDateStr}T${court.close_time}:00`, tz);

  const courtReservations = reservations.filter((r) => r.court_type_id === court.id);
  const available: string[] = [];
  let cursor = slotStart;
  const isToday = date === formatInTimeZone(now, tz, "yyyy-MM-dd");

  while (addMinutes(cursor, court.slot_duration_minutes) <= slotEnd) {
    const end = addMinutes(cursor, court.slot_duration_minutes);
    if (isToday && end <= addMinutes(now, 10)) { cursor = end; continue; }

    const taken = courtReservations.filter((r) => {
      const rs = parseISO(r.starts_at);
      const re = parseISO(r.ends_at);
      return rs < end && re > cursor;
    }).length;

    if (taken < court.quantity) available.push(formatInTimeZone(cursor, tz, "HH:mm"));
    cursor = end;
  }

  return available;
}

async function createReservation(
  db: SupabaseClient,
  tenantId: string,
  customerId: string,
  args: Record<string, string>,
  tz: string
): Promise<string> {
  const { customer_name, sport_name, date, time } = args;

  // Find court type
  const { data: courts } = await db
    .from("court_types")
    .select("id, sport_name, slot_duration_minutes, price_per_slot, quantity")
    .eq("tenant_id", tenantId)
    .eq("active", true)
    .ilike("sport_name", `%${sport_name}%`);

  if (!courts?.length) return `No encontré el deporte "${sport_name}". Verificá el nombre.`;

  const court = courts[0];

  // Build starts_at / ends_at in UTC
  const localStart = fromZonedTime(new Date(`${date}T${time}:00`), tz);
  const localEnd = addMinutes(localStart, court.slot_duration_minutes);

  // Check availability
  const { data: existing } = await db
    .from("reservations")
    .select("id")
    .eq("tenant_id", tenantId)
    .eq("court_type_id", court.id)
    .in("status", ["confirmed", "pending"])
    .lt("starts_at", localEnd.toISOString())
    .gt("ends_at", localStart.toISOString());

  const taken = existing?.length ?? 0;
  if (taken >= court.quantity) {
    return `Lo siento, el turno de ${sport_name} a las ${time} el ${date} ya está completo. Elegí otro horario.`;
  }

  // Update customer name if provided
  if (customer_name) {
    await db.from("customers").update({ name: customer_name }).eq("id", customerId);
  }

  // Insert reservation
  const { data: reservation, error } = await db
    .from("reservations")
    .insert({
      tenant_id: tenantId,
      customer_id: customerId,
      court_type_id: court.id,
      starts_at: localStart.toISOString(),
      ends_at: localEnd.toISOString(),
      status: "confirmed",
      source: "whatsapp",
    })
    .select("id")
    .single();

  if (error) return `Error al crear la reserva: ${error.message}`;

  const price = court.price_per_slot != null ? ` · Precio: $${court.price_per_slot}` : "";
  return `✅ Reserva confirmada!\n` +
    `📋 ID: ${reservation.id.slice(0, 8)}\n` +
    `⚽ ${court.sport_name}\n` +
    `📅 ${date} a las ${time} hs\n` +
    `👤 ${customer_name}` +
    price;
}

async function listReservations(
  db: SupabaseClient,
  tenantId: string,
  customerId: string,
  tz: string
): Promise<string> {
  const { data } = await db
    .from("reservations")
    .select("id, starts_at, ends_at, status, court_type_id, court_types(sport_name)")
    .eq("tenant_id", tenantId)
    .eq("customer_id", customerId)
    .in("status", ["confirmed", "pending"])
    .gte("starts_at", new Date().toISOString())
    .order("starts_at", { ascending: true })
    .limit(5);

  if (!data?.length) return "No tenés reservas activas próximas.";

  return data.map((r) => {
    const ct = r.court_types;
    const sport = (Array.isArray(ct) ? (ct[0] as { sport_name: string } | undefined) : (ct as { sport_name: string } | null))?.sport_name ?? "Cancha";
    const start = formatInTimeZone(parseISO(r.starts_at), tz, "dd/MM HH:mm");
    return `• ${sport} – ${start} hs (ID: ${r.id.slice(0, 8)})`;
  }).join("\n");
}

async function cancelReservation(
  db: SupabaseClient,
  reservationId: string,
  customerId: string
): Promise<string> {
  const { data, error } = await db
    .from("reservations")
    .update({ status: "cancelled" })
    .eq("id", reservationId)
    .eq("customer_id", customerId)
    .select("id")
    .single();

  if (error || !data) return "No encontré esa reserva o no te pertenece.";
  return `✅ Reserva cancelada correctamente.`;
}

// ─── Main agent runner ────────────────────────────────────────────────────────

export async function runAgent(
  systemPrompt: string,
  chatHistory: ChatCompletionMessageParam[],
  userMessage: string,
  deps: AgentDeps
): Promise<string> {
  const openai = getOpenAIClient();
  const messages: ChatCompletionMessageParam[] = [
    { role: "system", content: systemPrompt },
    ...chatHistory,
    { role: "user", content: userMessage },
  ];

  // Allow up to 3 tool call rounds
  for (let round = 0; round < 3; round++) {
    const response = await openai.chat.completions.create({
      model: "gpt-4o-mini",
      temperature: 0.4,
      tools: TOOLS,
      tool_choice: "auto",
      messages,
    });

    const choice = response.choices[0];
    const assistantMsg = choice.message;
    messages.push(assistantMsg);

    // No tool calls → final answer
    if (!assistantMsg.tool_calls?.length) {
      return assistantMsg.content?.trim() ?? "No pude generar una respuesta.";
    }

    // Execute each tool call
    for (const call of assistantMsg.tool_calls) {
      const fn = (call as { function: { name: string; arguments: string } }).function;
      const args = JSON.parse(fn.arguments) as Record<string, string>;
      const result = await executeTool(fn.name, args, deps);
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
  return finalResponse.choices[0]?.message?.content?.trim() ?? "No pude procesar tu consulta.";
}
