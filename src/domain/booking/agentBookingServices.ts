import { SupabaseClient } from "@supabase/supabase-js";
import { addMinutes, parseISO } from "date-fns";
import { formatInTimeZone, fromZonedTime, toZonedTime } from "date-fns-tz";
import {
  describeCourtUnit,
  getCourtCapacity,
  pickAvailableCourtUnit,
  type CourtUnit,
} from "@/domain/courts/courtUnits";
import { buildDepositText, canChangeReservation } from "@/domain/booking/reservationRules";
import { getBotPolicy } from "@/lib/actions/policies";
import type { ReservationStatus } from "@/types/database";

const RESERVATION_START_INTERVAL_MINUTES = 30;

export interface AgentBookingContext {
  db: SupabaseClient;
  tenantId: string;
  customerId: string;
  customerPhone: string;
  timezone: string;
  calendarSync?: ReservationCalendarSync;
}

export interface ReservationCalendarSync {
  sync(
    reservation: CalendarSyncReservation,
    customerName: string,
    customerPhone: string,
    timezone: string,
  ): Promise<void>;
  delete(externalEventId: string | null, timezone: string): Promise<void>;
}

export interface CalendarSyncReservation {
  id: string;
  tenant_id: string;
  starts_at: string;
  ends_at: string;
  status: string;
  source: string;
  external_event_id: string | null;
  notes?: string | null;
}

export interface ReservableCourt {
  id: string;
  sport_name: string;
  description?: string | null;
  slot_duration_minutes: number;
  open_time: string;
  close_time: string;
  quantity: number;
  price_per_slot?: number | null;
  days_of_week: number[];
  court_units?: CourtUnit[] | null;
}

export interface CustomerReservation {
  id: string;
  starts_at: string;
  ends_at: string;
  status: string;
  source: string;
  external_event_id: string | null;
  external_sheet_row_id: string | null;
  notes: string | null;
  court_type_id: string;
  court_types: ReservableCourt | ReservableCourt[] | null;
}

interface CustomerRelation {
  name: string | null;
  phone_e164: string | null;
}

interface SlotAvailability {
  time: string;
  free: number;
}

export interface CourtAvailability {
  court_type_id: string;
  sport_name: string;
  date: string;
  price_per_slot: number | null;
  slot_duration_minutes: number;
  capacity: number;
  working_day: boolean;
  slots: Array<{
    time: string;
    starts_at: string;
    ends_at: string;
    free: number;
  }>;
}

export class AgentAvailabilityService {
  constructor(
    private readonly db: SupabaseClient,
    private readonly tenantId: string,
    private readonly timezone: string,
  ) {}

  async check(date: string, sportName?: string): Promise<string> {
    const availability = await this.getAvailability(date, sportName);
    if (!availability.length) return "No hay canchas configuradas para ese deporte.";

    const activeCourts = availability.filter((court) => court.working_day);
    if (activeCourts.length === 1) {
      const court = activeCourts[0];
      if (court.slots.length === 0) return `Para el ${date} está completo.`;
      return court.slots
        .map((slot) => `•  ${slot.time} (${slot.free} cancha${slot.free !== 1 ? "s" : ""})`)
        .join("\n");
    }

    const lines: string[] = [`Disponibilidad para el ${date}:`];

    for (const court of availability) {
      if (!court.working_day) {
        lines.push(`- ${court.sport_name}: no trabaja ese día.`);
        continue;
      }

      const price = court.price_per_slot != null ? ` ($${court.price_per_slot})` : "";

      if (court.slots.length === 0) {
        lines.push(`- ${court.sport_name}${price}: COMPLETO`);
      } else {
        lines.push(`- ${court.sport_name}${price}:`);
        lines.push(
          ...court.slots.map((slot) => `•  ${slot.time} (${slot.free} cancha${slot.free !== 1 ? "s" : ""})`),
        );
      }
    }

    return lines.join("\n");
  }

  async getAvailability(date: string, sportName?: string): Promise<CourtAvailability[]> {
    const dow = toZonedTime(fromZonedTime(`${date}T12:00:00`, this.timezone), this.timezone).getDay();
    const courts = await this.fetchReservableCourts(sportName);
    if (!courts.length) return [];

    const dayStartDate = fromZonedTime(`${date}T00:00:00`, this.timezone);
    const dayStart = dayStartDate.toISOString();
    const dayEnd = new Date(dayStartDate.getTime() + 30 * 3600 * 1000).toISOString();
    // Only confirmed reservations occupy the slot. Pending reservations
    // (awaiting deposit) leave the slot bookable by other customers.
    const { data: reservations } = await this.db
      .from("reservations")
      .select("starts_at, ends_at, court_type_id, status")
      .eq("tenant_id", this.tenantId)
      .eq("status", "confirmed")
      .gte("starts_at", dayStart)
      .lte("starts_at", dayEnd);

    const now = new Date();

    return courts.map((court) => {
      const workingDay = court.days_of_week.includes(dow);
      const slots = workingDay
        ? this.getSlotAvailabilityForDay(court, date, now, reservations ?? []).map((slot) => {
            const startsAt = fromZonedTime(`${date}T${slot.time}:00`, this.timezone);
            const endsAt = addMinutes(startsAt, court.slot_duration_minutes);
            return {
              ...slot,
              starts_at: startsAt.toISOString(),
              ends_at: endsAt.toISOString(),
            };
          })
        : [];

      return {
        court_type_id: court.id,
        sport_name: court.sport_name,
        date,
        price_per_slot: court.price_per_slot ?? null,
        slot_duration_minutes: court.slot_duration_minutes,
        capacity: getCourtCapacity(court),
        working_day: workingDay,
        slots,
      };
    });
  }

  async fetchReservableCourts(sportName?: string): Promise<ReservableCourt[]> {
    let query = this.db
      .from("court_types")
      .select("id, sport_name, description, slot_duration_minutes, open_time, close_time, quantity, price_per_slot, days_of_week, court_units")
      .eq("tenant_id", this.tenantId)
      .eq("active", true);

    if (sportName) query = query.ilike("sport_name", `%${sportName}%`);

    const { data, error } = await query;
    if (error?.code !== "42703") return (data ?? []) as ReservableCourt[];

    let fallbackQuery = this.db
      .from("court_types")
      .select("id, sport_name, slot_duration_minutes, open_time, close_time, quantity, price_per_slot, days_of_week")
      .eq("tenant_id", this.tenantId)
      .eq("active", true);

    if (sportName) fallbackQuery = fallbackQuery.ilike("sport_name", `%${sportName}%`);

    const { data: fallbackData } = await fallbackQuery;
    return ((fallbackData ?? []) as Omit<ReservableCourt, "description" | "court_units">[]).map((court) => ({
      ...court,
      description: null,
      court_units: null,
    }));
  }

  getScheduleSlots(court: ReservableCourt, date: string, now = new Date()): string[] {
    const slotWindow = this.getSlotWindow(court, date);
    const available: string[] = [];
    let cursor = slotWindow.start;
    const isToday = date === formatInTimeZone(now, this.timezone, "yyyy-MM-dd");

    while (addMinutes(cursor, court.slot_duration_minutes) <= slotWindow.end) {
      const end = addMinutes(cursor, court.slot_duration_minutes);
      if (!(isToday && end <= addMinutes(now, 10))) {
        available.push(formatInTimeZone(cursor, this.timezone, "HH:mm"));
      }
      cursor = addMinutes(cursor, RESERVATION_START_INTERVAL_MINUTES);
    }

    return available;
  }

  getSlotAvailabilityForDay(
    court: ReservableCourt,
    date: string,
    now: Date,
    reservations: { starts_at: string; ends_at: string; court_type_id: string }[],
  ): SlotAvailability[] {
    const slotWindow = this.getSlotWindow(court, date);
    const courtReservations = reservations.filter((reservation) => reservation.court_type_id === court.id);
    const available: SlotAvailability[] = [];
    let cursor = slotWindow.start;
    const isToday = date === formatInTimeZone(now, this.timezone, "yyyy-MM-dd");

    while (addMinutes(cursor, court.slot_duration_minutes) <= slotWindow.end) {
      const end = addMinutes(cursor, court.slot_duration_minutes);
      if (isToday && end <= addMinutes(now, 10)) {
        cursor = end;
        continue;
      }

      const taken = countOverlappingReservations(courtReservations, cursor, end);
      const free = getCourtCapacity(court) - taken;
      if (free > 0) available.push({ time: formatInTimeZone(cursor, this.timezone, "HH:mm"), free });
      cursor = addMinutes(cursor, RESERVATION_START_INTERVAL_MINUTES);
    }

    return available;
  }

  assertCourtWorksOnDate(court: ReservableCourt, date: string): string | null {
    const dow = toZonedTime(fromZonedTime(`${date}T12:00:00`, this.timezone), this.timezone).getDay();
    if (court.days_of_week.includes(dow)) return null;
    return `${court.sport_name} no trabaja el ${date}. Pedime otra fecha y te paso disponibilidad.`;
  }

  async assertSlotIsReservable(court: ReservableCourt, date: string, time: string): Promise<string | null> {
    if (this.getScheduleSlots(court, date).includes(time)) return null;

    const availability = await this.check(date, court.sport_name);
    return `Ese horario no está dentro de los turnos reservables para ${court.sport_name} el ${date}.\n${availability}`;
  }

  buildReservationRange(court: ReservableCourt, date: string, time: string): { startsAt: Date; endsAt: Date } {
    const startsAt = fromZonedTime(`${date}T${time}:00`, this.timezone);
    return { startsAt, endsAt: addMinutes(startsAt, court.slot_duration_minutes) };
  }

  async findOverlappingReservations(
    court: ReservableCourt,
    startsAt: Date,
    endsAt: Date,
    excludeReservationId?: string | string[],
  ): Promise<{ id: string; notes: string | null }[]> {
    // Conflict checks only look at confirmed reservations — pending bookings
    // do not lock the slot. Multiple pendings can coexist at the same time.
    let query = this.db
      .from("reservations")
      .select("id, notes")
      .eq("tenant_id", this.tenantId)
      .eq("court_type_id", court.id)
      .eq("status", "confirmed")
      .lt("starts_at", endsAt.toISOString())
      .gt("ends_at", startsAt.toISOString());

    if (Array.isArray(excludeReservationId) && excludeReservationId.length > 0) {
      query = query.not("id", "in", `(${excludeReservationId.join(",")})`);
    } else if (excludeReservationId) {
      query = query.neq("id", excludeReservationId);
    }

    const { data } = await query;
    return (data ?? []) as { id: string; notes: string | null }[];
  }

  private getSlotWindow(court: ReservableCourt, date: string): { start: Date; end: Date } {
    const isOvernight = court.close_time <= court.open_time;
    const nextDayStr = formatInTimeZone(
      new Date(fromZonedTime(`${date}T00:00:00`, this.timezone).getTime() + 86400000),
      this.timezone,
      "yyyy-MM-dd",
    );
    const closeDateStr = isOvernight ? nextDayStr : date;

    return {
      start: fromZonedTime(`${date}T${timeHHmm(court.open_time)}:00`, this.timezone),
      end: fromZonedTime(`${closeDateStr}T${timeHHmm(court.close_time)}:00`, this.timezone),
    };
  }
}

export class CourtAssignmentService {
  assign(court: ReservableCourt, overlappingReservations: { notes?: string | null }[]): CourtUnit {
    return pickAvailableCourtUnit(court, overlappingReservations);
  }
}

export class AgentReservationCommandService {
  constructor(
    private readonly context: AgentBookingContext,
    private readonly availability: AgentAvailabilityService,
    private readonly assignment: CourtAssignmentService,
  ) {}

  async create(args: Record<string, string>): Promise<string> {
    const result = await this.createReservation(args);
    return result.reply;
  }

  async confirmPending(args: {
    reservation_ids?: string[];
    date?: string;
    time?: string;
    sport_name?: string;
  }): Promise<string> {
    const pending = await this.findPendingReservations(args);
    if (!pending.length) {
      return "No encontré una reserva pendiente a tu nombre para confirmar.";
    }

    // Re-validate each pending slot against current confirmed reservations.
    // Since pending no longer blocks the slot, another customer may have
    // confirmed the slot in the meantime — refuse with a clear message.
    const confirmable: CustomerReservation[] = [];
    const conflicts: CustomerReservation[] = [];
    for (const reservation of pending) {
      const court = relationOne(reservation.court_types);
      if (!court) {
        conflicts.push(reservation);
        continue;
      }
      const startsAt = parseISO(reservation.starts_at);
      const endsAt = parseISO(reservation.ends_at);
      const overlapping = await this.availability.findOverlappingReservations(court, startsAt, endsAt, reservation.id);
      const capacity = getCourtCapacity(court);
      if (overlapping.length >= capacity) {
        conflicts.push(reservation);
        continue;
      }
      // Re-assign the court unit in case the originally-picked unit is now taken
      // by a confirmed booking. assign() prefers the previously-assigned unit when free.
      const reassigned = this.assignment.assign(court, overlapping);
      const { error: updateError } = await this.context.db
        .from("reservations")
        .update({ notes: reassigned.name })
        .eq("id", reservation.id);
      if (updateError) {
        conflicts.push(reservation);
        continue;
      }
      confirmable.push(reservation);
    }

    if (!confirmable.length) {
      return "Lamentablemente alguien tomó ese horario antes de que mandaras la seña. ¿Querés que vea otro horario?";
    }

    const ids = confirmable.map((reservation) => reservation.id);
    const { data, error } = await this.context.db
      .from("reservations")
      .update({ status: "confirmed" })
      .eq("tenant_id", this.context.tenantId)
      .eq("customer_id", this.context.customerId)
      .in("id", ids)
      .eq("status", "pending")
      .select("*, customers(name, phone_e164), court_types(sport_name)");

    if (error || !data?.length) return "No pude confirmar la reserva pendiente.";

    for (const reservation of data as Array<CalendarSyncReservation & { customers?: CustomerRelation | CustomerRelation[] | null }>) {
      const customer = relationOne(reservation.customers);
      await this.context.calendarSync?.sync(
        reservation,
        customer?.name ?? "Cliente",
        customer?.phone_e164 ?? this.context.customerPhone,
        this.context.timezone,
      );
    }

    const first = confirmable[0];
    const sport = relationOne(first.court_types)?.sport_name ?? args.sport_name ?? "Cancha";
    const start = formatInTimeZone(parseISO(first.starts_at), this.context.timezone, "dd/MM HH:mm");
    const quantity = data.length;
    const conflictNote = conflicts.length
      ? `\n\n⚠️ No pude confirmar ${conflicts.length} reserva${conflicts.length !== 1 ? "s" : ""} porque alguien más ya tomó ese horario.`
      : "";

    return `✅ Reserva confirmada con seña recibida.\n` +
      `• ${quantity} cancha${quantity !== 1 ? "s" : ""} de ${sport}\n` +
      `• ${start} hs${conflictNote}`;
  }

  async createReservation(args: Record<string, string>): Promise<{ ok: boolean; reply: string; id?: string; status?: ReservationStatus }> {
    const { customer_name, sport_name, date, time } = args;
    const courts = await this.availability.fetchReservableCourts(sport_name);
    if (!courts.length) return { ok: false, reply: `No encontré el deporte "${sport_name}". Verificá el nombre.` };

    const court = courts[0];
    const dayError = this.availability.assertCourtWorksOnDate(court, date);
    if (dayError) return { ok: false, reply: dayError };

    const slotError = await this.availability.assertSlotIsReservable(court, date, time);
    if (slotError) return { ok: false, reply: slotError };

    const { startsAt, endsAt } = this.availability.buildReservationRange(court, date, time);
    const existing = await this.availability.findOverlappingReservations(court, startsAt, endsAt);

    if (existing.length >= getCourtCapacity(court)) {
      const availability = await this.availability.check(date, court.sport_name);
      return { ok: false, reply: `Lo siento, el turno de ${sport_name} a las ${time} el ${date} ya está completo.\n${availability}` };
    }

    const courtUnit = this.assignment.assign(court, existing);

    if (customer_name) {
      await this.context.db.from("customers").update({ name: customer_name }).eq("id", this.context.customerId);
    }

    const policy = await getBotPolicy(this.context.tenantId, this.context.db);
    const requestedStatus = args.status as ReservationStatus | undefined;
    const status: ReservationStatus = requestedStatus ?? (policy.requires_deposit ? "pending" : policy.reservation_status_default);
    const { data: reservation, error } = await this.context.db
      .from("reservations")
      .insert({
        tenant_id: this.context.tenantId,
        customer_id: this.context.customerId,
        court_type_id: court.id,
        starts_at: startsAt.toISOString(),
        ends_at: endsAt.toISOString(),
        status,
        source: "whatsapp",
        notes: courtUnit.name,
      })
      .select("*")
      .single();

    if (error) return { ok: false, reply: `Error al crear la reserva: ${error.message}` };

    if (status === "confirmed") {
      await this.context.calendarSync?.sync(
        reservation as CalendarSyncReservation,
        customer_name,
        this.context.customerPhone,
        this.context.timezone,
      );
    }

    const price = court.price_per_slot != null ? ` · Precio: $${court.price_per_slot}` : "";
    const statusLabel = status === "pending" ? "Reserva pendiente" : "Reserva confirmada";
    const depositText = buildDepositText(policy);
    const reservationId = (reservation as { id: string }).id;

    const reply = `✅ ${statusLabel}!\n` +
      `📋 ID: ${reservationId.slice(0, 8)}\n` +
      `⚽ ${court.sport_name}\n` +
      `🏟️ ${describeCourtUnit(courtUnit)}\n` +
      `📅 ${date} a las ${time} hs\n` +
      `👤 ${customer_name}` +
      price +
      depositText;

    return { ok: true, reply, id: reservationId, status };
  }

  async list(): Promise<string> {
    const data = await this.listActive();
    if (!data.length) return "No tenés reservas activas próximas.";
    return this.formatReservations(data);
  }

  async listActive(limit = 20): Promise<CustomerReservation[]> {
    const { data } = await this.context.db
      .from("reservations")
      .select("id, starts_at, ends_at, status, source, notes, external_event_id, external_sheet_row_id, court_type_id, court_types(id, sport_name, description, slot_duration_minutes, open_time, close_time, quantity, days_of_week, court_units)")
      .eq("tenant_id", this.context.tenantId)
      .eq("customer_id", this.context.customerId)
      .in("status", ["confirmed", "pending"])
      .gte("starts_at", new Date().toISOString())
      .order("starts_at", { ascending: true })
      .limit(limit);

    return (data ?? []) as CustomerReservation[];
  }

  formatReservations(reservations: CustomerReservation[]): string {
    if (!reservations.length) return "No encontré reservas activas.";
    return reservations.map((reservation) => {
      const sport = relationOne(reservation.court_types)?.sport_name ?? "Cancha";
      const start = formatInTimeZone(parseISO(reservation.starts_at), this.context.timezone, "dd/MM HH:mm");
      const courtLabel = reservation.notes ? ` - ${reservation.notes}` : "";
      return `• ${sport}${courtLabel} - ${start} hs (ID: ${reservation.id.slice(0, 8)})`;
    }).join("\n");
  }

  async findCancellationCandidates(args: {
    reservation_id?: string | null;
    reservation_ids?: string[];
    date?: string | null;
    time?: string | null;
    sport_name?: string | null;
    quantity?: number | null;
    all?: boolean;
  }): Promise<CustomerReservation[]> {
    const active = await this.listActive(50);
    let candidates = active;

    const ids = args.reservation_ids?.filter(Boolean) ?? [];
    if (args.reservation_id) ids.push(args.reservation_id);
    if (ids.length > 0) {
      const keys = ids.map((id) => id.toLowerCase());
      candidates = candidates.filter((reservation) =>
        keys.some((key) => reservation.id.toLowerCase() === key || reservation.id.toLowerCase().startsWith(key)),
      );
    }

    if (args.date) {
      candidates = candidates.filter((reservation) =>
        formatInTimeZone(parseISO(reservation.starts_at), this.context.timezone, "yyyy-MM-dd") === args.date,
      );
    }

    if (args.time) {
      candidates = candidates.filter((reservation) =>
        formatInTimeZone(parseISO(reservation.starts_at), this.context.timezone, "HH:mm") === args.time,
      );
    }

    if (args.sport_name) {
      candidates = candidates.filter((reservation) => {
        const sport = relationOne(reservation.court_types)?.sport_name;
        return sport?.toLowerCase().includes(args.sport_name!.toLowerCase());
      });
    }

    if (!args.all && args.quantity && candidates.length > args.quantity) {
      candidates = candidates.slice(0, args.quantity);
    }

    return candidates;
  }

  async findChangeCandidates(args: {
    reservation_id?: string | null;
    reservation_ids?: string[];
    date?: string | null;
    time?: string | null;
    sport_name?: string | null;
    quantity?: number | null;
    all?: boolean;
  }): Promise<CustomerReservation[]> {
    return this.findCancellationCandidates(args);
  }

  async cancelMany(reservationIds: string[]): Promise<{ ok: boolean; reply: string; cancelledIds: string[] }> {
    const uniqueIds = [...new Set(reservationIds.filter(Boolean))];
    if (!uniqueIds.length) {
      return { ok: false, reply: "No encontré reservas para cancelar.", cancelledIds: [] };
    }

    const active = await this.listActive(50);
    const reservations = active.filter((reservation) => uniqueIds.includes(reservation.id));
    if (!reservations.length) {
      return { ok: false, reply: "No encontré reservas activas a tu nombre con esos datos.", cancelledIds: [] };
    }

    const policy = await getBotPolicy(this.context.tenantId, this.context.db);
    for (const reservation of reservations) {
      const cancellationCheck = canChangeReservation(parseISO(reservation.starts_at), policy.cancellation_min_hours);
      if (!cancellationCheck.ok) {
        const label = formatInTimeZone(parseISO(reservation.starts_at), this.context.timezone, "dd/MM HH:mm");
        return {
          ok: false,
          reply: `No puedo cancelar la reserva del ${label}. ${cancellationCheck.reason}`,
          cancelledIds: [],
        };
      }
    }

    for (const reservation of reservations) {
      await this.context.calendarSync?.delete(reservation.external_event_id, this.context.timezone);
    }

    const { data, error } = await this.context.db
      .from("reservations")
      .update({ status: "cancelled" })
      .eq("tenant_id", this.context.tenantId)
      .eq("customer_id", this.context.customerId)
      .in("id", reservations.map((reservation) => reservation.id))
      .in("status", ["confirmed", "pending"])
      .select("id");

    if (error || !data?.length) {
      return { ok: false, reply: "No pude cancelar esas reservas.", cancelledIds: [] };
    }

    const cancelledIds = data.map((reservation) => reservation.id as string);
    const summary = this.formatReservations(reservations.filter((reservation) => cancelledIds.includes(reservation.id)));
    return {
      ok: true,
      cancelledIds,
      reply: `✅ Cancelé ${cancelledIds.length} reserva${cancelledIds.length !== 1 ? "s" : ""}:\n${summary}`,
    };
  }

  async cancel(args: Record<string, string>): Promise<string> {
    const reservation = await this.findCustomerReservationForCancel(args);
    if (!reservation) {
      const active = await this.list();
      return `No encontré una reserva activa a tu nombre con esos datos. Solo puedo cancelar reservas hechas desde este mismo número.\n${active}`;
    }

    const policy = await getBotPolicy(this.context.tenantId, this.context.db);
    const cancellationCheck = canChangeReservation(parseISO(reservation.starts_at), policy.cancellation_min_hours);
    if (!cancellationCheck.ok) {
      return `No puedo cancelar esa reserva. ${cancellationCheck.reason}`;
    }

    await this.context.calendarSync?.delete(reservation.external_event_id, this.context.timezone);

    const { data, error } = await this.context.db
      .from("reservations")
      .update({ status: "cancelled" })
      .eq("id", reservation.id)
      .eq("customer_id", this.context.customerId)
      .select("id")
      .single();

    if (error || !data) return "No encontré esa reserva o no te pertenece.";

    const sport = relationOne(reservation.court_types)?.sport_name ?? "cancha";
    const dateLabel = formatInTimeZone(parseISO(reservation.starts_at), this.context.timezone, "dd/MM HH:mm");
    const courtLabel = reservation.notes ? ` (${reservation.notes})` : "";
    return `✅ Reserva cancelada: ${sport}${courtLabel} del ${dateLabel} hs.`;
  }

  async reschedule(args: Record<string, string>): Promise<string> {
    const reservation = await this.findCustomerReservation(args.reservation_id);
    if (!reservation) {
      const active = await this.list();
      return `No encontré esa reserva activa a tu nombre.\n${active}`;
    }

    const court = relationOne(reservation.court_types);
    if (!court) return "No pude identificar el tipo de cancha de esa reserva.";

    const policy = await getBotPolicy(this.context.tenantId, this.context.db);
    const rescheduleCheck = canChangeReservation(parseISO(reservation.starts_at), policy.reschedule_min_hours);
    if (!rescheduleCheck.ok) {
      return `No puedo reprogramar esa reserva. ${rescheduleCheck.reason}`;
    }

    const dayError = this.availability.assertCourtWorksOnDate(court, args.date);
    if (dayError) return dayError;

    const slotError = await this.availability.assertSlotIsReservable(court, args.date, args.time);
    if (slotError) return slotError;

    const { startsAt, endsAt } = this.availability.buildReservationRange(court, args.date, args.time);
    const existing = await this.availability.findOverlappingReservations(court, startsAt, endsAt, reservation.id);

    if (existing.length >= getCourtCapacity(court)) {
      const availability = await this.availability.check(args.date, court.sport_name);
      return `Ese horario ya está completo.\n${availability}`;
    }

    const courtUnit = this.assignment.assign(court, existing);

    const { data: updated, error } = await this.context.db
      .from("reservations")
      .update({
        starts_at: startsAt.toISOString(),
        ends_at: endsAt.toISOString(),
        notes: courtUnit.name,
      })
      .eq("id", reservation.id)
      .eq("customer_id", this.context.customerId)
      .select("*, customers(name, phone_e164)")
      .single();

    if (error) return `No pude reprogramar la reserva: ${error.message}`;

    const customer = relationOne((updated as CalendarSyncReservation & { customers?: CustomerRelation | CustomerRelation[] | null }).customers);
    await this.context.calendarSync?.sync(
      updated as CalendarSyncReservation,
      customer?.name ?? "Cliente",
      customer?.phone_e164 ?? "",
      this.context.timezone,
    );

    const dateLabel = formatInTimeZone(startsAt, this.context.timezone, "dd/MM HH:mm");
    return `✅ Reserva reprogramada: ${court.sport_name} (${describeCourtUnit(courtUnit)}) para el ${dateLabel} hs.`;
  }

  async validateRescheduleMany(
    reservationIds: string[],
    date: string,
    time: string,
  ): Promise<{ ok: true; reservations: CustomerReservation[] } | { ok: false; reply: string; reservations?: CustomerReservation[] }> {
    const reservations = await this.findActiveByIds(reservationIds);
    if (!reservations.length) return { ok: false, reply: "No encontré reservas activas a tu nombre con esos datos." };

    const policy = await getBotPolicy(this.context.tenantId, this.context.db);
    for (const reservation of reservations) {
      const rescheduleCheck = canChangeReservation(parseISO(reservation.starts_at), policy.reschedule_min_hours);
      if (!rescheduleCheck.ok) {
        const label = formatInTimeZone(parseISO(reservation.starts_at), this.context.timezone, "dd/MM HH:mm");
        return {
          ok: false,
          reply: `No puedo reprogramar la reserva del ${label}. ${rescheduleCheck.reason}`,
          reservations,
        };
      }
    }

    const byCourtType = new Map<string, CustomerReservation[]>();
    for (const reservation of reservations) {
      byCourtType.set(reservation.court_type_id, [...(byCourtType.get(reservation.court_type_id) ?? []), reservation]);
    }

    for (const group of byCourtType.values()) {
      const court = relationOne(group[0].court_types);
      if (!court) return { ok: false, reply: "No pude identificar el tipo de cancha de una reserva.", reservations };

      const dayError = this.availability.assertCourtWorksOnDate(court, date);
      if (dayError) return { ok: false, reply: dayError, reservations };

      const slotError = await this.availability.assertSlotIsReservable(court, date, time);
      if (slotError) return { ok: false, reply: slotError, reservations };

      const { startsAt, endsAt } = this.availability.buildReservationRange(court, date, time);
      const existing = await this.availability.findOverlappingReservations(
        court,
        startsAt,
        endsAt,
        group.map((reservation) => reservation.id),
      );

      if (existing.length + group.length > getCourtCapacity(court)) {
        const availability = await this.availability.check(date, court.sport_name);
        return {
          ok: false,
          reply: `No hay lugar para mover ${group.length} cancha${group.length !== 1 ? "s" : ""} a las ${time} el ${date}.\n${availability}`,
          reservations,
        };
      }
    }

    return { ok: true, reservations };
  }

  async rescheduleMany(
    reservationIds: string[],
    date: string,
    time: string,
  ): Promise<{ ok: boolean; reply: string; rescheduledIds: string[] }> {
    const validation = await this.validateRescheduleMany(reservationIds, date, time);
    if (!validation.ok) return { ok: false, reply: validation.reply, rescheduledIds: [] };

    const rescheduledIds: string[] = [];
    const updatedReservations: CustomerReservation[] = [];

    for (const reservation of validation.reservations) {
      const court = relationOne(reservation.court_types);
      if (!court) return { ok: false, reply: "No pude identificar el tipo de cancha de una reserva.", rescheduledIds };

      const { startsAt, endsAt } = this.availability.buildReservationRange(court, date, time);
      const existing = await this.availability.findOverlappingReservations(court, startsAt, endsAt, reservation.id);
      const courtUnit = this.assignment.assign(court, existing);

      const { data: updated, error } = await this.context.db
        .from("reservations")
        .update({
          starts_at: startsAt.toISOString(),
          ends_at: endsAt.toISOString(),
          notes: courtUnit.name,
        })
        .eq("id", reservation.id)
        .eq("customer_id", this.context.customerId)
        .select("*, customers(name, phone_e164), court_types(id, sport_name, description, slot_duration_minutes, open_time, close_time, quantity, days_of_week, court_units)")
        .single();

      if (error) return { ok: false, reply: `No pude reprogramar una reserva: ${error.message}`, rescheduledIds };

      const updatedReservation = updated as CalendarSyncReservation & CustomerReservation & { customers?: CustomerRelation | CustomerRelation[] | null };
      const customer = relationOne(updatedReservation.customers);
      await this.context.calendarSync?.sync(
        updatedReservation,
        customer?.name ?? "Cliente",
        customer?.phone_e164 ?? "",
        this.context.timezone,
      );

      rescheduledIds.push(reservation.id);
      updatedReservations.push(updatedReservation);
    }

    const summary = this.formatReservations(updatedReservations);
    return {
      ok: true,
      rescheduledIds,
      reply: `✅ Reprogramé ${rescheduledIds.length} reserva${rescheduledIds.length !== 1 ? "s" : ""}:\n${summary}`,
    };
  }

  private async findCustomerReservation(reservationIdOrPrefix: string): Promise<CustomerReservation | null> {
    const { data, error } = await this.context.db
      .from("reservations")
      .select("id, starts_at, ends_at, status, source, notes, external_event_id, external_sheet_row_id, court_type_id, court_types(id, sport_name, description, slot_duration_minutes, open_time, close_time, quantity, days_of_week, court_units)")
      .eq("tenant_id", this.context.tenantId)
      .eq("customer_id", this.context.customerId)
      .in("status", ["confirmed", "pending"])
      .gte("starts_at", new Date().toISOString())
      .order("starts_at", { ascending: true })
      .limit(20);

    if (error?.code === "42703") {
      const { data: fallbackData } = await this.context.db
        .from("reservations")
        .select("id, starts_at, ends_at, status, source, notes, external_event_id, external_sheet_row_id, court_type_id, court_types(id, sport_name, slot_duration_minutes, open_time, close_time, quantity, days_of_week)")
        .eq("tenant_id", this.context.tenantId)
        .eq("customer_id", this.context.customerId)
        .in("status", ["confirmed", "pending"])
        .gte("starts_at", new Date().toISOString())
        .order("starts_at", { ascending: true })
        .limit(20);

      return matchCustomerReservation(fallbackData, reservationIdOrPrefix);
    }

    return matchCustomerReservation(data, reservationIdOrPrefix);
  }

  private async findActiveByIds(reservationIds: string[]): Promise<CustomerReservation[]> {
    const uniqueIds = [...new Set(reservationIds.filter(Boolean))];
    if (!uniqueIds.length) return [];
    const active = await this.listActive(50);
    return active.filter((reservation) => uniqueIds.includes(reservation.id));
  }

  private async findCustomerReservationForCancel(args: Record<string, string>): Promise<CustomerReservation | null> {
    const reservationId = args.reservation_id?.trim();
    if (reservationId) return this.findCustomerReservation(reservationId);
    if (!args.date || !args.time) return null;

    const requestedStart = fromZonedTime(`${args.date}T${args.time}:00`, this.context.timezone);
    const startsFrom = new Date(requestedStart.getTime() - 60_000).toISOString();
    const startsTo = new Date(requestedStart.getTime() + 60_000).toISOString();

    const { data, error } = await this.context.db
      .from("reservations")
      .select("id, starts_at, ends_at, status, source, notes, external_event_id, external_sheet_row_id, court_type_id, court_types(id, sport_name, description, slot_duration_minutes, open_time, close_time, quantity, days_of_week, court_units)")
      .eq("tenant_id", this.context.tenantId)
      .eq("customer_id", this.context.customerId)
      .in("status", ["confirmed", "pending"])
      .gte("starts_at", new Date().toISOString())
      .gte("starts_at", startsFrom)
      .lte("starts_at", startsTo)
      .order("starts_at", { ascending: true })
      .limit(10);

    if (error?.code === "42703") {
      const { data: fallbackData } = await this.context.db
        .from("reservations")
        .select("id, starts_at, ends_at, status, source, notes, external_event_id, external_sheet_row_id, court_type_id, court_types(id, sport_name, slot_duration_minutes, open_time, close_time, quantity, days_of_week)")
        .eq("tenant_id", this.context.tenantId)
        .eq("customer_id", this.context.customerId)
        .in("status", ["confirmed", "pending"])
        .gte("starts_at", new Date().toISOString())
        .gte("starts_at", startsFrom)
        .lte("starts_at", startsTo)
        .order("starts_at", { ascending: true })
        .limit(10);

      return matchCustomerReservationForCancel(fallbackData, args);
    }

    return matchCustomerReservationForCancel(data, args);
  }

  private async findPendingReservations(args: {
    reservation_ids?: string[];
    date?: string;
    time?: string;
    sport_name?: string;
  }): Promise<CustomerReservation[]> {
    let query = this.context.db
      .from("reservations")
      .select("id, starts_at, ends_at, status, source, notes, external_event_id, external_sheet_row_id, court_type_id, court_types(id, sport_name, description, slot_duration_minutes, open_time, close_time, quantity, days_of_week, court_units)")
      .eq("tenant_id", this.context.tenantId)
      .eq("customer_id", this.context.customerId)
      .eq("status", "pending")
      .gte("starts_at", new Date().toISOString())
      .order("starts_at", { ascending: true })
      .limit(20);

    const ids = args.reservation_ids?.filter(Boolean) ?? [];
    if (ids.length > 0) {
      const { data } = await query;
      const prefixes = new Set(ids.map((id) => id.toLowerCase()));
      return ((data ?? []) as CustomerReservation[]).filter((reservation) =>
        [...prefixes].some((prefix) => reservation.id.toLowerCase().startsWith(prefix)),
      );
    }

    if (args.date && args.time) {
      const requestedStart = fromZonedTime(`${args.date}T${args.time}:00`, this.context.timezone);
      const startsFrom = new Date(requestedStart.getTime() - 60_000).toISOString();
      const startsTo = new Date(requestedStart.getTime() + 60_000).toISOString();
      query = query.gte("starts_at", startsFrom).lte("starts_at", startsTo);
    }

    const { data } = await query;
    return ((data ?? []) as CustomerReservation[]).filter((reservation) => {
      const courtType = relationOne(reservation.court_types);
      if (!args.sport_name || !courtType) return true;
      return courtType.sport_name.toLowerCase().includes(args.sport_name.toLowerCase());
    });
  }
}

export function createAgentBookingServices(context: AgentBookingContext): {
  availability: AgentAvailabilityService;
  reservations: AgentReservationCommandService;
  assignment: CourtAssignmentService;
} {
  const availability = new AgentAvailabilityService(context.db, context.tenantId, context.timezone);
  const assignment = new CourtAssignmentService();

  return {
    availability,
    assignment,
    reservations: new AgentReservationCommandService(context, availability, assignment),
  };
}

function countOverlappingReservations(
  reservations: { starts_at: string; ends_at: string }[],
  startsAt: Date,
  endsAt: Date,
): number {
  return reservations.filter((reservation) => {
    const reservationStart = parseISO(reservation.starts_at);
    const reservationEnd = parseISO(reservation.ends_at);
    return reservationStart < endsAt && reservationEnd > startsAt;
  }).length;
}

function matchCustomerReservation(data: unknown, reservationIdOrPrefix: string): CustomerReservation | null {
  const key = reservationIdOrPrefix.trim().toLowerCase();
  const matches = ((data ?? []) as CustomerReservation[]).filter((reservation) =>
    reservation.id.toLowerCase() === key || reservation.id.toLowerCase().startsWith(key),
  );

  return matches.length === 1 ? matches[0] : null;
}

function matchCustomerReservationForCancel(data: unknown, args: Record<string, string>): CustomerReservation | null {
  const matches = ((data ?? []) as CustomerReservation[]).filter((reservation) => {
    const courtType = relationOne(reservation.court_types);
    if (!args.sport_name || !courtType) return true;
    return courtType.sport_name.toLowerCase().includes(args.sport_name.toLowerCase());
  });

  return matches.length === 1 ? matches[0] : null;
}

function relationOne<T>(value: T | T[] | null | undefined): T | null {
  if (!value) return null;
  return Array.isArray(value) ? (value[0] ?? null) : value;
}

function timeHHmm(value: string): string {
  return value.slice(0, 5);
}
