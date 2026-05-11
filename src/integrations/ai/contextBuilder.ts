import { SupabaseClient } from "@supabase/supabase-js";
import { formatInTimeZone, fromZonedTime, toZonedTime } from "date-fns-tz";
import { addDays, parseISO } from "date-fns";
import {
  describeCourtUnit,
  getActiveCourtUnits,
  getCourtCapacity,
  type CourtUnit,
} from "@/domain/courts/courtUnits";

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
  description: string | null;
  slot_duration_minutes: number;
  open_time: string;
  close_time: string;
  quantity: number;
  price_per_slot: number | null;
  days_of_week: number[];
  court_units: CourtUnit[] | null;
}

interface ExistingReservation {
  id?: string;
  starts_at: string;
  ends_at: string;
  court_type_id: string;
  status: string;
  notes?: string | null;
  customers?: { name: string | null; phone_e164: string | null } | { name: string | null; phone_e164: string | null }[] | null;
  court_types?: { sport_name: string | null } | { sport_name: string | null }[] | null;
}

interface CustomerProfile {
  name: string | null;
  phone_e164: string;
  notes: string | null;
}

// ─── Main export ──────────────────────────────────────────────────────────────

export async function buildAgentContext(
  db: SupabaseClient,
  tenantId: string,
  conversationId: string,
  customerId: string
): Promise<{ systemPrompt: string; chatHistory: { role: "user" | "assistant"; content: string }[] }> {
  const tenant = await fetchTenant(db, tenantId);
  const tz = tenant?.timezone ?? "America/Argentina/Buenos_Aires";

  const [courts, upcomingReservations, customerReservations, customer, history, policy] = await Promise.all([
    fetchCourts(db, tenantId),
    fetchUpcomingReservations(db, tenantId, tz, 14),
    fetchCustomerReservations(db, tenantId, customerId),
    fetchCustomer(db, customerId),
    fetchRecentHistory(db, conversationId),
    fetchBotPolicy(db, tenantId),
  ]);

  const now = new Date();
  const todayDow = toZonedTime(now, tz).getDay(); // 0=Sun 6=Sat in tenant tz

  const courtsInfo = buildCourtsSection(courts, todayDow);
  const calendarInfo = buildCalendarSection(upcomingReservations, tz);
  const customerInfo = buildCustomerSection(customer, customerReservations, tz);
  const policyInfo = buildPolicySection(policy);
  const systemPrompt = buildSystemPrompt(tenant, courtsInfo, calendarInfo, customerInfo, policyInfo, now, tz);

  return { systemPrompt, chatHistory: history };
}

async function fetchBotPolicy(db: SupabaseClient, tenantId: string) {
  const { data } = await db
    .from("tenant_bot_policies")
    .select("cancellation_min_hours, reschedule_min_hours, requires_deposit, deposit_amount, deposit_percentage, reservation_status_default, audio_message, human_handoff_message")
    .eq("tenant_id", tenantId)
    .maybeSingle();

  return data ?? {
    cancellation_min_hours: 0,
    reschedule_min_hours: 0,
    requires_deposit: false,
    deposit_amount: null,
    deposit_percentage: null,
    reservation_status_default: "confirmed",
    audio_message: "No puedo escuchar audios por acá. Escribime el día, horario y deporte y te ayudo.",
    human_handoff_message: "Te derivo con una persona del equipo para ayudarte con eso.",
  };
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

async function fetchCustomer(db: SupabaseClient, customerId: string): Promise<CustomerProfile | null> {
  const { data } = await db
    .from("customers")
    .select("name, phone_e164, notes")
    .eq("id", customerId)
    .single();
  return (data ?? null) as CustomerProfile | null;
}

// ─── Courts ───────────────────────────────────────────────────────────────────

async function fetchCourts(db: SupabaseClient, tenantId: string): Promise<CourtType[]> {
  const { data, error } = await db
    .from("court_types")
    .select("id, sport_name, description, slot_duration_minutes, open_time, close_time, quantity, price_per_slot, days_of_week, court_units")
    .eq("tenant_id", tenantId)
    .eq("active", true);

  if (error?.code === "42703") {
    const { data: fallbackData } = await db
      .from("court_types")
      .select("id, sport_name, slot_duration_minutes, open_time, close_time, quantity, price_per_slot, days_of_week")
      .eq("tenant_id", tenantId)
      .eq("active", true);

    return ((fallbackData ?? []) as Omit<CourtType, "description" | "court_units">[]).map((court) => ({
      ...court,
      description: null,
      court_units: null,
    }));
  }

  return (data ?? []) as CourtType[];
}

// ─── Reservations / calendar ──────────────────────────────────────────────────

async function fetchUpcomingReservations(
  db: SupabaseClient,
  tenantId: string,
  tz: string,
  days: number
): Promise<ExistingReservation[]> {
  const now = new Date();
  const todayStr = formatInTimeZone(now, tz, "yyyy-MM-dd");
  const todayStart = fromZonedTime(`${todayStr}T00:00:00`, tz).toISOString();
  const rangeEnd = addDays(fromZonedTime(`${todayStr}T00:00:00`, tz), days).toISOString();

  const { data } = await db
    .from("reservations")
    .select("id, starts_at, ends_at, court_type_id, status, notes, customers(name, phone_e164), court_types(sport_name)")
    .eq("tenant_id", tenantId)
    .in("status", ["confirmed", "pending"])
    .gte("starts_at", todayStart)
    .lt("starts_at", rangeEnd)
    .order("starts_at", { ascending: true });
  return (data ?? []) as ExistingReservation[];
}

async function fetchCustomerReservations(
  db: SupabaseClient,
  tenantId: string,
  customerId: string
): Promise<ExistingReservation[]> {
  const { data } = await db
    .from("reservations")
    .select("id, starts_at, ends_at, court_type_id, status, notes, court_types(sport_name)")
    .eq("tenant_id", tenantId)
    .eq("customer_id", customerId)
    .in("status", ["confirmed", "pending"])
    .gte("starts_at", new Date().toISOString())
    .order("starts_at", { ascending: true })
    .limit(10);
  return (data ?? []) as ExistingReservation[];
}

// ─── Conversation history ───────────────────────────────────────────────────

async function fetchRecentHistory(
  db: SupabaseClient,
  conversationId: string
): Promise<{ role: "user" | "assistant"; content: string }[]> {
  const { data } = await db
    .from("messages")
    .select("direction, content")
    .eq("conversation_id", conversationId)
    .order("created_at", { ascending: false })
    .limit(80);

  return (data ?? []).reverse().map((m) => ({
    role: m.direction === "inbound" ? ("user" as const) : ("assistant" as const),
    content: m.content,
  }));
}

// ─── Available slots builder ──────────────────────────────────────────────────

function buildCourtsSection(
  courts: CourtType[],
  todayDow: number,
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
    lines.push(`- Canchas simultáneas: ${getCourtCapacity(court)}`);

    if (court.description?.trim()) {
      lines.push(`- Descripción general: ${court.description.trim()}`);
    }

    lines.push("- Canchas físicas:");
    for (const unit of getActiveCourtUnits(court)) {
      lines.push(`  • ${describeCourtUnit(unit)}`);
    }

    if (!worksToday) {
      lines.push(`- Hoy NO trabaja este deporte.`);
      continue;
    }

    lines.push("- Para informar disponibilidad al cliente, consultar siempre la herramienta.");
  }

  return lines.join("\n");
}

function buildCustomerSection(
  customer: CustomerProfile | null,
  reservations: ExistingReservation[],
  tz: string
): string {
  const name = customer?.name?.trim() || "todavía no informado";
  const phone = customer?.phone_e164 ?? "sin teléfono";
  const notes = customer?.notes?.trim() || "sin notas";

  const lines = [
    `- Nombre conocido: ${name}`,
    `- Teléfono: ${phone}`,
    `- Notas: ${notes}`,
  ];

  if (!reservations.length) {
    lines.push("- Próximas reservas del cliente: ninguna.");
    return lines.join("\n");
  }

  lines.push("- Próximas reservas del cliente:");
  for (const r of reservations) {
    const sport = relationOne(r.court_types)?.sport_name ?? "Cancha";
    const start = formatInTimeZone(parseISO(r.starts_at), tz, "EEE dd/MM HH:mm");
    const end = formatInTimeZone(parseISO(r.ends_at), tz, "HH:mm");
    const courtLabel = r.notes ? ` · ${r.notes}` : "";
    lines.push(`  • ${r.id?.slice(0, 8)} · ${sport}${courtLabel} · ${start}-${end} · ${r.status}`);
  }

  return lines.join("\n");
}

function buildCalendarSection(reservations: ExistingReservation[], tz: string): string {
  if (!reservations.length) return "No hay reservas activas en los próximos 14 días.";

  const grouped = new Map<string, ExistingReservation[]>();
  for (const reservation of reservations) {
    const day = formatInTimeZone(parseISO(reservation.starts_at), tz, "yyyy-MM-dd EEEE");
    grouped.set(day, [...(grouped.get(day) ?? []), reservation]);
  }

  const lines: string[] = [];
  for (const [day, dayReservations] of grouped) {
    lines.push(`\n${day}`);
    for (const reservation of dayReservations.slice(0, 20)) {
      const customer = relationOne(reservation.customers);
      const courtType = relationOne(reservation.court_types);
      const start = formatInTimeZone(parseISO(reservation.starts_at), tz, "HH:mm");
      const end = formatInTimeZone(parseISO(reservation.ends_at), tz, "HH:mm");
      const sport = courtType?.sport_name ?? "Cancha";
      const customerName = customer?.name || customer?.phone_e164 || "Cliente";
      const courtLabel = reservation.notes ? ` · ${reservation.notes}` : "";
      lines.push(`- ${start}-${end} · ${sport}${courtLabel} · ${customerName} · ${reservation.status}`);
    }
    if (dayReservations.length > 20) {
      lines.push(`- ... ${dayReservations.length - 20} reservas más ese día.`);
    }
  }

  return lines.join("\n");
}

function relationOne<T>(value: T | T[] | null | undefined): T | null {
  if (!value) return null;
  return Array.isArray(value) ? (value[0] ?? null) : value;
}

// ─── System prompt assembler ──────────────────────────────────────────────────

function buildSystemPrompt(
  tenant: { name: string; timezone: string; bot_prompt: string | null; address: string | null } | null,
  courtsInfo: string,
  calendarInfo: string,
  customerInfo: string,
  policyInfo: string,
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
CLIENTE Y MEMORIA OPERATIVA
─────────────────────────────────────
${customerInfo}

─────────────────────────────────────
CANCHAS Y DISPONIBILIDAD RAPIDA
─────────────────────────────────────
${courtsInfo}

─────────────────────────────────────
CALENDARIO INTERNO - PROXIMOS 14 DIAS
─────────────────────────────────────
${calendarInfo}

─────────────────────────────────────
POLITICAS DEL NEGOCIO
─────────────────────────────────────
${policyInfo}

─────────────────────────────────────
INSTRUCCIONES DEL NEGOCIO
─────────────────────────────────────
${customPrompt || "Respondé en español rioplatense, de forma amigable y concisa. Ayudá al cliente a reservar o consultar turnos."}

─────────────────────────────────────
REGLAS GENERALES
─────────────────────────────────────
- La base de datos interna de Zentdly es la fuente de verdad del calendario. No inventes reservas, horarios ni precios.
- Para disponibilidad, altas, cancelaciones o cambios usá las herramientas disponibles. No confirmes usando solo memoria textual.
- Si este mensaje llega al fallback conversacional, no tenés permiso para ejecutar ni confirmar acciones. Nunca digas que algo quedó reservado, cancelado, reprogramado, confirmado o pagado salvo que el resultado venga explícitamente de una acción ejecutada por el motor determinístico.
- Si el cliente pide reservar, cancelar, reprogramar o confirmar seña y no tenés un resultado operativo explícito, pedí el dato faltante o decí que necesitás verificarlo en el sistema.
- Si el cliente pide "hoy", "mañana", "el viernes" o similares, resolvelo con la fecha local indicada arriba.
- Para confirmar una reserva necesitás: deporte, fecha, horario y nombre del cliente. Si ya conocés el nombre por memoria, podés usarlo.
- Antes de confirmar una reserva, verificá disponibilidad con la herramienta y luego creala con la herramienta.
- Si el horario pedido ya está ocupado, ofrecé alternativas reales devueltas por la herramienta.
- Las canchas físicas pueden tener características distintas: techo, césped sintético, acrílico o descripción propia. Usá esos datos cuando el cliente pida una cancha específica o pregunte diferencias.
- Si hay varias canchas del mismo deporte pero con características distintas, tratá cada cancha física como una unidad reservable separada. No digas que son idénticas si la descripción indica diferencias.
- Si el cliente quiere cancelar, solo podés cancelar reservas asociadas al número del cliente actual. Usá la herramienta con fecha y hora o con ID; si no existe una reserva activa de ese mismo número en ese horario, decí que no encontraste una reserva a su nombre y no canceles nada.
- Si el cliente quiere cancelar pero no identificó claramente cuál, listá sus reservas activas antes de cancelar.
- Si el cliente manda audio, no lo aceptes: pedile que escriba el mensaje.
- Si hay ambigüedad de deporte, fecha u horario, preguntá solo el dato faltante.
- Respondé siempre en español, de forma breve y directa. Máximo 3-4 líneas por mensaje.
- No menciones detalles internos, IDs completos ni herramientas salvo que haga falta para diferenciar reservas.`.trim();
}

function buildPolicySection(policy: {
  cancellation_min_hours?: number | null;
  reschedule_min_hours?: number | null;
  requires_deposit?: boolean | null;
  deposit_amount?: number | null;
  deposit_percentage?: number | null;
  reservation_status_default?: string | null;
  audio_message?: string | null;
  human_handoff_message?: string | null;
}): string {
  const deposit = policy.requires_deposit
    ? [
        policy.deposit_amount != null ? `$${policy.deposit_amount}` : null,
        policy.deposit_percentage != null ? `${policy.deposit_percentage}%` : null,
      ].filter(Boolean).join(" o ") || "sí, monto a consultar"
    : "no";

  return [
    `- Horas mínimas para cancelar: ${policy.cancellation_min_hours ?? 0}`,
    `- Horas mínimas para reprogramar: ${policy.reschedule_min_hours ?? 0}`,
    `- Requiere seña: ${deposit}`,
    `- Estado inicial de reserva: ${policy.reservation_status_default ?? "confirmed"}`,
    `- Mensaje ante audios: ${policy.audio_message ?? "Pedir que escriba el mensaje."}`,
    `- Mensaje de derivación humana: ${policy.human_handoff_message ?? "Derivar a una persona del equipo."}`,
  ].join("\n");
}
