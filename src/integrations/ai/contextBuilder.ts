import { SupabaseClient } from "@supabase/supabase-js";
import { formatInTimeZone, fromZonedTime, toZonedTime } from "date-fns-tz";
import { addMinutes, parseISO } from "date-fns";

const DAYS_ES = ["domingo", "lunes", "martes", "miércoles", "jueves", "viernes", "sábado"];
const MONTHS_ES = ["enero", "febrero", "marzo", "abril", "mayo", "junio", "julio", "agosto", "septiembre", "octubre", "noviembre", "diciembre"];

// ─── Types ────────────────────────────────────────────────────────────────────

export interface TenantContext {
  tenantId: string;
  tenantName: string;
  timezone: string;
  botPrompt: string;
}

interface CourtType {
  id: string;
  sport_name: string;
  slot_duration_minutes: number;
  open_time: string;
  close_time: string;
  quantity: number;
  price_per_slot: number | null;
  days_of_week: number[];
}

interface ExistingReservation {
  starts_at: string;
  ends_at: string;
  court_type_id: string;
  status: string;
}

// ─── Main export ──────────────────────────────────────────────────────────────

export async function buildAgentContext(
  db: SupabaseClient,
  tenantId: string,
  conversationId: string
): Promise<{ systemPrompt: string; chatHistory: { role: "user" | "assistant"; content: string }[] }> {
  const tenant = await fetchTenant(db, tenantId);
  const tz = tenant?.timezone ?? "America/Argentina/Buenos_Aires";

  const [courts, todayReservations, history] = await Promise.all([
    fetchCourts(db, tenantId),
    fetchTodayReservations(db, tenantId, tz),
    fetchTodayHistory(db, conversationId),
  ]);

  const now = new Date();
  const todayDow = toZonedTime(now, tz).getDay(); // 0=Sun 6=Sat in tenant tz

  const courtsInfo = buildCourtsSection(courts, todayDow, now, todayReservations, tz);
  const systemPrompt = buildSystemPrompt(tenant, courtsInfo, now, tz);

  return { systemPrompt, chatHistory: history };
}

// ─── Tenant ───────────────────────────────────────────────────────────────────

async function fetchTenant(db: SupabaseClient, tenantId: string) {
  const { data } = await db
    .from("tenants")
    .select("name, timezone, bot_prompt, address")
    .eq("id", tenantId)
    .single();
  return data;
}

// ─── Courts ───────────────────────────────────────────────────────────────────

async function fetchCourts(db: SupabaseClient, tenantId: string): Promise<CourtType[]> {
  const { data } = await db
    .from("court_types")
    .select("id, sport_name, slot_duration_minutes, open_time, close_time, quantity, price_per_slot, days_of_week")
    .eq("tenant_id", tenantId)
    .eq("active", true);
  return (data ?? []) as CourtType[];
}

// ─── Reservations today ───────────────────────────────────────────────────────

async function fetchTodayReservations(db: SupabaseClient, tenantId: string, tz: string): Promise<ExistingReservation[]> {
  const now = new Date();
  const todayStr = formatInTimeZone(now, tz, "yyyy-MM-dd");
  // Wide window: local midnight to next day noon UTC — covers overnight courts (e.g. 08:00–03:00)
  const todayStart = fromZonedTime(`${todayStr}T00:00:00`, tz).toISOString();
  const todayEnd = new Date(fromZonedTime(`${todayStr}T00:00:00`, tz).getTime() + 30 * 3600 * 1000).toISOString();

  const { data } = await db
    .from("reservations")
    .select("starts_at, ends_at, court_type_id, status")
    .eq("tenant_id", tenantId)
    .in("status", ["confirmed", "pending"])
    .gte("starts_at", todayStart)
    .lte("starts_at", todayEnd);
  return (data ?? []) as ExistingReservation[];
}

// ─── Conversation history (today only) ───────────────────────────────────────

async function fetchTodayHistory(
  db: SupabaseClient,
  conversationId: string
): Promise<{ role: "user" | "assistant"; content: string }[]> {
  const todayStart = new Date(new Date().setHours(0, 0, 0, 0)).toISOString();

  const { data } = await db
    .from("messages")
    .select("direction, content")
    .eq("conversation_id", conversationId)
    .gte("created_at", todayStart)
    .order("created_at", { ascending: true })
    .limit(40);

  return (data ?? []).map((m) => ({
    role: m.direction === "inbound" ? ("user" as const) : ("assistant" as const),
    content: m.content,
  }));
}

// ─── Available slots builder ──────────────────────────────────────────────────

function buildCourtsSection(
  courts: CourtType[],
  todayDow: number,
  now: Date,
  reservations: ExistingReservation[],
  tz: string
): string {
  if (courts.length === 0) return "No hay canchas configuradas aún.";

  const lines: string[] = [];

  for (const court of courts) {
    const worksToday = court.days_of_week.includes(todayDow);
    const price = court.price_per_slot != null ? `$${court.price_per_slot}` : "precio a consultar";
    const duration = `${court.slot_duration_minutes} min`;

    const daysLabel = court.days_of_week
      .sort()
      .map((d) => DAYS_ES[d])
      .join(", ");

    lines.push(`\n### ${court.sport_name}`);
    lines.push(`- Duración del turno: ${duration}`);
    lines.push(`- Precio: ${price}`);
    lines.push(`- Horario: ${court.open_time.slice(0, 5)} a ${court.close_time.slice(0, 5)}`);
    lines.push(`- Días disponibles: ${daysLabel}`);
    lines.push(`- Canchas simultáneas: ${court.quantity}`);

    if (!worksToday) {
      lines.push(`- Hoy NO trabaja este deporte.`);
      continue;
    }

    const slots = getAvailableSlots(court, now, reservations, tz);
    if (slots.length === 0) {
      lines.push(`- Horarios libres hoy: COMPLETO (sin turnos disponibles)`);
    } else {
      lines.push(`- Horarios libres hoy: ${slots.join(", ")}`);
    }
  }

  return lines.join("\n");
}

function getAvailableSlots(
  court: CourtType,
  now: Date,
  reservations: ExistingReservation[],
  tz: string
): string[] {
  const todayStr = formatInTimeZone(now, tz, "yyyy-MM-dd");

  // Overnight support: if close ≤ open, close is on the next calendar day
  const isOvernight = court.close_time <= court.open_time;
  const nextDayStr = formatInTimeZone(
    new Date(fromZonedTime(`${todayStr}T00:00:00`, tz).getTime() + 86400000),
    tz, "yyyy-MM-dd"
  );
  const closeDateStr = isOvernight ? nextDayStr : todayStr;

  const slotStart = fromZonedTime(`${todayStr}T${court.open_time}:00`, tz);
  const slotEnd   = fromZonedTime(`${closeDateStr}T${court.close_time}:00`, tz);

  const courtReservations = reservations.filter((r) => r.court_type_id === court.id);
  const available: string[] = [];
  let cursor = slotStart;

  while (addMinutes(cursor, court.slot_duration_minutes) <= slotEnd) {
    const slotEndTime = addMinutes(cursor, court.slot_duration_minutes);

    if (slotEndTime <= addMinutes(now, 10)) {
      cursor = slotEndTime;
      continue;
    }

    const taken = courtReservations.filter((r) => {
      const resStart = parseISO(r.starts_at);
      const resEnd = parseISO(r.ends_at);
      return resStart < slotEndTime && resEnd > cursor;
    }).length;

    if (taken < court.quantity) {
      available.push(formatInTimeZone(cursor, tz, "HH:mm"));
    }

    cursor = slotEndTime;
  }

  return available;
}

// ─── System prompt assembler ──────────────────────────────────────────────────

function buildSystemPrompt(
  tenant: { name: string; timezone: string; bot_prompt: string | null; address: string | null } | null,
  courtsInfo: string,
  now: Date,
  tz: string
): string {
  const businessName = tenant?.name ?? "el negocio";
  const address = tenant?.address ? `Dirección: ${tenant.address}` : "";
  const customPrompt = tenant?.bot_prompt?.trim() ?? "";

  const nowLocal = toZonedTime(now, tz);
  const dow = nowLocal.getDay();
  const dom = nowLocal.getDate();
  const month = MONTHS_ES[nowLocal.getMonth()];
  const year = nowLocal.getFullYear();
  const timeStr = formatInTimeZone(now, tz, "HH:mm");
  const dayStr = DAYS_ES[dow];

  const dateBlock = `Hoy es ${dayStr} ${dom} de ${month} de ${year}, son las ${timeStr} hs (zona horaria: ${tz}).`;

  return `Sos el asistente virtual de *${businessName}*, un complejo deportivo que gestiona reservas de canchas por WhatsApp.
${address}

${dateBlock}

─────────────────────────────────────
CANCHAS Y DISPONIBILIDAD HOY
─────────────────────────────────────
${courtsInfo}

─────────────────────────────────────
INSTRUCCIONES DEL NEGOCIO
─────────────────────────────────────
${customPrompt || "Respondé en español rioplatense, de forma amigable y concisa. Ayudá al cliente a reservar o consultar turnos."}

─────────────────────────────────────
REGLAS GENERALES
─────────────────────────────────────
- Usá siempre la disponibilidad de arriba para informar horarios — nunca inventes horarios.
- Si el horario pedido ya está ocupado, ofrecé el siguiente disponible.
- Para confirmar una reserva necesitás: deporte, fecha, horario y nombre del cliente.
- Cuando tengas todos esos datos, confirmá la reserva con un resumen claro.
- Si el cliente pregunta por otro día (no hoy), decile que consultés disponibilidad para esa fecha y que te avise cuál prefiere.
- Respondé siempre en español, de forma breve y directa. Máximo 3-4 líneas por mensaje.
- No inventes precios ni horarios que no estén en la sección de canchas.`.trim();
}
