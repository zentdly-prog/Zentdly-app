import assert from "node:assert/strict";
import { addDays } from "date-fns";
import { formatInTimeZone, fromZonedTime } from "date-fns-tz";
import {
  handleDeterministicBookingMessage,
  parseBookingMessage,
} from "../src/domain/booking/deterministicRouter";
import { getBotPolicy } from "../src/lib/actions/policies";

process.env.OPENAI_API_KEY = "";

const TENANT_ID = "00000000-0000-4000-8000-000000000001";
const CUSTOMER_ID = "customer-1";
const PHONE = "+5491136123177";
const TIMEZONE = "America/Argentina/Buenos_Aires";

async function main() {
  await smokeParseHumanLanguage();
  await smokeBookingWithDepositAndCancellation();
  await smokeCancelAllWithConfirmation();
  await smokeRescheduleWithConfirmation();
  await smokeStateIsolationForListAndAvailability();
  await smokeNameAfterExactAvailabilityCreatesPendingReservation();
  await smokeAudioRejectedPolicy();
  console.log("booking smoke tests passed");
}

async function smokeParseHumanLanguage() {
  const now = fromZonedTime("2026-05-10T12:00:00", TIMEZONE);
  const parsedTypo = parseBookingMessage("Hola, te puedo reservar mama a las 20?", TIMEZONE, undefined, now);
  assert.equal(parsedTypo.date, "2026-05-11", '"mama" debe interpretarse como mañana');

  const parsedAmbiguous = parseBookingMessage("Te puedo reservar mañana a las 8?", TIMEZONE, undefined, now);
  assert.equal(parsedAmbiguous.time, null);
  assert.equal(parsedAmbiguous.timeAmbiguous, true);
  assert.deepEqual(parsedAmbiguous.timeOptions, { morning: "08:00", evening: "20:00" });
}

async function smokeBookingWithDepositAndCancellation() {
  const db = createSmokeDb();
  const date = futureDate(2);

  const booking = await route(db, `Hola, quiero reservar 3 canchas de padel para ${date} a las 20 a nombre de Mora`);
  assert.equal(booking.handled, true, JSON.stringify(booking));
  assert.match(booking.reply ?? "", /Reserva pendiente para 3 canchas/i);
  assert.equal(db.reservations.filter((reservation) => reservation.status === "pending").length, 3);
  assert.equal(db.reservations.filter((reservation) => reservation.status === "confirmed").length, 0);

  const confirm = await route(db, "Te mando el comprobante de la seña");
  assert.equal(confirm.handled, true, JSON.stringify(confirm));
  assert.match(confirm.reply ?? "", /Reserva confirmada con seña recibida/i);
  assert.equal(db.reservations.filter((reservation) => reservation.status === "confirmed").length, 3);

  const cancelOffer = await route(db, "Cancelame esas 3");
  assert.equal(cancelOffer.handled, true, JSON.stringify(cancelOffer));
  assert.match(cancelOffer.reply ?? "", /Confirmás que querés cancelarlas/i);
  assert.equal(db.reservations.filter((reservation) => reservation.status === "cancelled").length, 0);

  const cancelConfirm = await route(db, "sí confirmo");
  assert.equal(cancelConfirm.handled, true, JSON.stringify(cancelConfirm));
  assert.match(cancelConfirm.reply ?? "", /Cancelé 3 reservas/i);
  assert.equal(db.reservations.filter((reservation) => reservation.status === "cancelled").length, 3);
}

async function smokeCancelAllWithConfirmation() {
  const db = createSmokeDb();
  seedReservation(db, { id: "aaaaaaaa-0000-4000-8000-000000000001", date: futureDate(3), time: "18:00", notes: "Cancha 1" });
  seedReservation(db, { id: "bbbbbbbb-0000-4000-8000-000000000002", date: futureDate(3), time: "19:00", notes: "Cancha 2" });

  const cancelAll = await route(db, "Quiero cancelar todas");
  assert.equal(cancelAll.handled, true, JSON.stringify(cancelAll));
  assert.match(cancelAll.reply ?? "", /Confirmás que querés cancelarlas/i);
  assert.equal(db.reservations.filter((reservation) => reservation.status === "cancelled").length, 0);

  const confirm = await route(db, "dale");
  assert.equal(confirm.handled, true, JSON.stringify(confirm));
  assert.match(confirm.reply ?? "", /Cancelé 2 reservas/i);
  assert.equal(db.reservations.filter((reservation) => reservation.status === "cancelled").length, 2);
}

async function smokeRescheduleWithConfirmation() {
  const db = createSmokeDb();
  const reservationId = "cccccccc-0000-4000-8000-000000000003";
  const targetDate = futureDate(5);
  seedReservation(db, { id: reservationId, date: futureDate(4), time: "18:00", notes: "Cancha 1" });

  const offer = await route(db, `Reprogramar ${reservationId.slice(0, 8)} para ${targetDate} a las 21`);
  assert.equal(offer.handled, true, JSON.stringify(offer));
  assert.match(offer.reply ?? "", /Confirmás el cambio/i);
  assert.notEqual(formatInTimeZone(new Date(String(db.reservations[0].starts_at)), TIMEZONE, "yyyy-MM-dd HH:mm"), `${targetDate} 21:00`);

  const confirm = await route(db, "sí");
  assert.equal(confirm.handled, true, JSON.stringify(confirm));
  assert.match(confirm.reply ?? "", /Reprogramé 1 reserva/i);
  assert.equal(formatInTimeZone(new Date(String(db.reservations[0].starts_at)), TIMEZONE, "yyyy-MM-dd HH:mm"), `${targetDate} 21:00`);
}

async function smokeStateIsolationForListAndAvailability() {
  const db = createSmokeDb();
  const bookingDate = futureDate(6);
  const availabilityDate = futureDate(7);

  const pending = await route(db, `Quiero reservar 3 canchas de padel para ${bookingDate} a las 20 a nombre de Mora`);
  assert.equal(pending.handled, true, JSON.stringify(pending));
  assert.match(pending.reply ?? "", /Reserva pendiente para 3 canchas/i);

  const list = await route(db, "Que reservas tengo a mi nombre?");
  assert.equal(list.handled, true, JSON.stringify(list));
  assert.match(list.reply ?? "", /Estas son tus reservas activas/i);
  assert.doesNotMatch(list.reply ?? "", /No puedo reservar 3/i);

  const availability = await route(db, `Que disponibilidad tenes para ${availabilityDate}`);
  assert.equal(availability.handled, true, JSON.stringify(availability));
  assert.match(availability.reply ?? "", /08:00 \(4 canchas\)/);
  assert.doesNotMatch(availability.reply ?? "", /A nombre de quién/i);
}

async function smokeNameAfterExactAvailabilityCreatesPendingReservation() {
  const db = createSmokeDb();
  const date = futureDate(8);

  const availability = await route(db, `Tenes cancha para ${date} a las 08:00?`);
  assert.equal(availability.handled, true, JSON.stringify(availability));
  assert.match(availability.reply ?? "", /A nombre de quién/i);
  assert.equal(db.reservations.length, 0);

  const named = await route(db, "A nombre de Santiago");
  assert.equal(named.handled, true, JSON.stringify(named));
  assert.match(named.reply ?? "", /Reserva pendiente/i);
  assert.equal(db.reservations.length, 1);
  assert.equal(db.reservations[0].status, "pending");
}

async function smokeAudioRejectedPolicy() {
  const db = createSmokeDb();
  const policy = await getBotPolicy(TENANT_ID, db as never);
  assert.match(policy.audio_message, /No puedo escuchar audios/i);
  assert.match(policy.audio_message, /Escribime/i);
}

async function route(db: SmokeDb, message: string) {
  return handleDeterministicBookingMessage({
    db: db as never,
    tenantId: TENANT_ID,
    customerId: CUSTOMER_ID,
    customerPhone: PHONE,
    timezone: TIMEZONE,
    conversationId: "conversation-1",
    message,
    calendarSync: {
      sync: async () => undefined,
      delete: async () => undefined,
    },
  });
}

function futureDate(days: number): string {
  return formatInTimeZone(addDays(new Date(), days), TIMEZONE, "yyyy-MM-dd");
}

function createSmokeDb(): SmokeDb {
  return new SmokeDb();
}

function seedReservation(
  db: SmokeDb,
  input: { id: string; date: string; time: string; notes: string; status?: string },
) {
  const startsAt = fromZonedTime(`${input.date}T${input.time}:00`, TIMEZONE);
  const endsAt = new Date(startsAt.getTime() + 90 * 60_000);
  db.reservations.push({
    id: input.id,
    tenant_id: TENANT_ID,
    customer_id: CUSTOMER_ID,
    court_type_id: "court-padel",
    starts_at: startsAt.toISOString(),
    ends_at: endsAt.toISOString(),
    status: input.status ?? "confirmed",
    source: "whatsapp",
    external_event_id: null,
    external_sheet_row_id: null,
    notes: input.notes,
  });
}

type Row = Record<string, unknown>;
type QueryResult = { data: unknown; error: { message: string } | null };

class SmokeDb {
  ai_sessions: Row[] = [];
  agent_logs: Row[] = [];
  court_types: Row[] = [
    {
      id: "court-padel",
      tenant_id: TENANT_ID,
      sport_name: "Pádel",
      description: "Complejo smoke test",
      slot_duration_minutes: 90,
      open_time: "08:00",
      close_time: "23:00",
      quantity: 4,
      price_per_slot: 60000,
      days_of_week: [0, 1, 2, 3, 4, 5, 6],
      active: true,
      court_units: [
        { id: "unit-1", name: "Cancha 1", active: true },
        { id: "unit-2", name: "Cancha 2", active: true },
        { id: "unit-3", name: "Cancha 3", active: true },
        { id: "unit-4", name: "Cancha 4", active: true },
      ],
    },
  ];
  customers: Row[] = [{ id: CUSTOMER_ID, tenant_id: TENANT_ID, phone_e164: PHONE, name: "Mora" }];
  reservations: Row[] = [];
  tenant_bot_policies: Row[] = [
    {
      tenant_id: TENANT_ID,
      cancellation_min_hours: 0,
      reschedule_min_hours: 0,
      requires_deposit: true,
      deposit_amount: 10000,
      deposit_percentage: null,
      reservation_status_default: "pending",
      audio_message: "No puedo escuchar audios por acá. Escribime el día, horario y deporte y te ayudo.",
      human_handoff_message: "Te derivo con una persona del equipo para ayudarte con eso.",
    },
  ];
  private sequence = 1;

  from(table: string) {
    return new SmokeQuery(this, table);
  }

  nextId() {
    const value = this.sequence.toString(16).padStart(8, "0");
    this.sequence += 1;
    return `${value}-0000-4000-8000-${value.padStart(12, "0")}`;
  }
}

class SmokeQuery {
  private filters: Array<(row: Row) => boolean> = [];
  private mutation: "insert" | "update" | "upsert" | null = null;
  private payload: Row | Row[] | null = null;
  private singleMode: "single" | "maybeSingle" | null = null;
  private limitCount: number | null = null;
  private orderBy: { column: string; ascending: boolean } | null = null;

  constructor(private readonly db: SmokeDb, private readonly table: string) {}

  select() { return this; }
  eq(column: string, value: unknown) { this.filters.push((row) => row[column] === value); return this; }
  neq(column: string, value: unknown) { this.filters.push((row) => row[column] !== value); return this; }
  in(column: string, values: unknown[]) { this.filters.push((row) => values.includes(row[column])); return this; }
  gte(column: string, value: string) { this.filters.push((row) => String(row[column] ?? "") >= value); return this; }
  lte(column: string, value: string) { this.filters.push((row) => String(row[column] ?? "") <= value); return this; }
  lt(column: string, value: string) { this.filters.push((row) => String(row[column] ?? "") < value); return this; }
  gt(column: string, value: string) { this.filters.push((row) => String(row[column] ?? "") > value); return this; }
  ilike(column: string, pattern: string) {
    const needle = normalizeSearch(pattern.replace(/%/g, ""));
    this.filters.push((row) => normalizeSearch(String(row[column] ?? "")).includes(needle));
    return this;
  }
  not(column: string, operator: string, value: string) {
    if (operator === "in") {
      const values = value.replace(/[()]/g, "").split(",").filter(Boolean);
      this.filters.push((row) => !values.includes(String(row[column])));
    }
    return this;
  }
  order(column: string, options?: { ascending?: boolean }) {
    this.orderBy = { column, ascending: options?.ascending !== false };
    return this;
  }
  limit(count: number) { this.limitCount = count; return this; }
  single() { this.singleMode = "single"; return this; }
  maybeSingle() { this.singleMode = "maybeSingle"; return this; }
  insert(payload: Row | Row[]) { this.mutation = "insert"; this.payload = payload; return this; }
  update(payload: Row) { this.mutation = "update"; this.payload = payload; return this; }
  upsert(payload: Row | Row[]) { this.mutation = "upsert"; this.payload = payload; return this; }

  then<TResult1 = QueryResult, TResult2 = never>(
    onfulfilled?: ((value: QueryResult) => TResult1 | PromiseLike<TResult1>) | null,
    onrejected?: ((reason: unknown) => TResult2 | PromiseLike<TResult2>) | null,
  ) {
    return Promise.resolve(this.execute()).then(onfulfilled, onrejected);
  }

  private execute(): QueryResult {
    const table = this.getTable();
    let rows: Row[];

    if (this.mutation === "insert") {
      const input = Array.isArray(this.payload) ? this.payload : [this.payload];
      rows = input.filter(Boolean).map((item) => this.prepareInsert(item as Row));
      table.push(...rows);
    } else if (this.mutation === "update") {
      rows = table.filter((row) => this.filters.every((filter) => filter(row)));
      rows.forEach((row) => Object.assign(row, this.payload ?? {}));
    } else if (this.mutation === "upsert") {
      const input = Array.isArray(this.payload) ? this.payload : [this.payload];
      rows = input.filter(Boolean).map((item) => this.applyUpsert(table, item as Row));
    } else {
      rows = table.filter((row) => this.filters.every((filter) => filter(row)));
    }

    if (this.orderBy) {
      const { column, ascending } = this.orderBy;
      rows = [...rows].sort((a, b) => String(a[column]).localeCompare(String(b[column])) * (ascending ? 1 : -1));
    }

    if (this.limitCount != null) rows = rows.slice(0, this.limitCount);

    const data = rows.map((row) => this.hydrate(row));
    if (this.singleMode === "single") return { data: data[0] ?? null, error: data[0] ? null : { message: "No rows" } };
    if (this.singleMode === "maybeSingle") return { data: data[0] ?? null, error: null };
    return { data, error: null };
  }

  private prepareInsert(row: Row) {
    const next = { ...row };
    if (this.table === "reservations" && !next.id) next.id = this.db.nextId();
    return next;
  }

  private applyUpsert(table: Row[], row: Row) {
    const key =
      this.table === "ai_sessions" ? "conversation_id" :
      this.table === "tenant_bot_policies" ? "tenant_id" :
      "id";
    const existing = table.find((item) => item[key] === row[key]);
    if (existing) {
      Object.assign(existing, row);
      return existing;
    }
    const next = this.prepareInsert(row);
    table.push(next);
    return next;
  }

  private hydrate(row: Row) {
    const next = { ...row };
    if (this.table === "reservations") {
      next.court_types = this.db.court_types.find((court) => court.id === row.court_type_id) ?? null;
      next.customers = this.db.customers.find((customer) => customer.id === row.customer_id) ?? null;
    }
    return next;
  }

  private getTable(): Row[] {
    const tables = this.db as unknown as Record<string, Row[]>;
    const table = tables[this.table];
    if (!Array.isArray(table)) throw new Error(`Unknown smoke table: ${this.table}`);
    return table;
  }
}

function normalizeSearch(value: string) {
  return value
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase();
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
