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
  await smokeSecondBookingDoesNotInheritFirst();
  await smokeBareNameCompletesBooking();
  await smokeMultiTimeBookingInOneMessage();
  await smokePendingReschedulesToNewSlot();
  await smokeQuantityNotMisreadAsTime();
  await smokeDocumentAsDepositProof();
  await smokePendingDoesNotBlockSlot();
  await smokeBareHourTreatedAmbiguous();
  console.log("booking smoke tests passed");
}

async function smokeBareHourTreatedAmbiguous() {
  // "a las 8" with no AM/PM marker must be treated as ambiguous,
  // even when the LLM (absent in smoke tests) is not available.
  const db = createSmokeDb();
  const date = futureDate(12);

  const first = await route(db, `Quiero reservar para ${date} a las 8`);
  assert.equal(first.handled, true);
  assert.match(first.reply ?? "", /08:00 o a las 20:00/, JSON.stringify(first));
  // Must NOT have created any reservation yet
  assert.equal(db.reservations.length, 0, "no reservation should exist before AM/PM is clarified");
}

async function smokePendingDoesNotBlockSlot() {
  // Court has capacity 4. If 4 pendings exist at the same slot from another
  // customer, availability for THIS customer must still show the slot as free
  // (4 canchas) because pending no longer locks the slot.
  const db = createSmokeDb();
  const date = futureDate(11);

  // Seed 4 pendings at 14:00 from a different customer
  for (let i = 0; i < 4; i++) {
    const startsAt = fromZonedTime(`${date}T14:00:00`, TIMEZONE);
    const endsAt = new Date(startsAt.getTime() + 90 * 60_000);
    db.reservations.push({
      id: `00000000-1111-4000-8000-00000000000${i + 1}`,
      tenant_id: TENANT_ID,
      customer_id: "other-customer",
      court_type_id: "court-padel",
      starts_at: startsAt.toISOString(),
      ends_at: endsAt.toISOString(),
      status: "pending",
      source: "whatsapp",
      external_event_id: null,
      external_sheet_row_id: null,
      notes: `Cancha ${i + 1}`,
    });
  }

  const availability = await route(db, `Tenes cancha para ${date} a las 14:00?`);
  // The slot should still be available because the 4 pendings don't block
  assert.match(availability.reply ?? "", /A nombre de qui[eé]n/i,
    `expected slot to be free (pendings should not block) — got: ${availability.reply}`);

  // Now confirm one of the existing pendings (simulate the other customer paying)
  db.reservations[0].status = "confirmed";
  // Re-check availability — should now show 3 free (4 capacity - 1 confirmed)
  const availability2 = await route(db, `Tenes cancha para ${date} a las 14:00?`);
  assert.match(availability2.reply ?? "", /3\s*canchas?\s*disponibles?/i,
    `expected 3 canchas disponibles — got: ${availability2.reply}`);
}

async function smokeQuantityNotMisreadAsTime() {
  // Bug: "2 canchas para las 10" was being parsed as multi-time [02:00, 10:00]
  const db = createSmokeDb();
  const date = futureDate(9);
  const result = await route(db, `Quiero reservar 2 canchas para ${date} a las 14:00 a nombre de Santiago`);
  assert.equal(result.handled, true, JSON.stringify(result));
  // Bot must NOT have tried to book at 02:00 — only at 14:00 with quantity 2
  assert.doesNotMatch(result.reply ?? "", /02:00/);
  assert.match(result.reply ?? "", /14:00/);
  const pending = db.reservations.filter((r) => r.status === "pending");
  assert.equal(pending.length, 2, `expected 2 pending, got ${pending.length}: ${JSON.stringify(pending)}`);
}

async function smokeDocumentAsDepositProof() {
  // A [document] message after the deposit prompt should confirm the pending
  const db = createSmokeDb();
  const date = futureDate(10);
  const initial = await route(db, `Reservar 1 cancha para ${date} a las 15:00 a nombre de Mora`);
  assert.match(initial.reply ?? "", /Reserva pendiente/i);
  assert.equal(db.reservations.filter((r) => r.status === "pending").length, 1);

  const proof = await route(db, "[document]");
  assert.match(proof.reply ?? "", /Reserva confirmada con seña/i, JSON.stringify(proof));
  assert.equal(db.reservations.filter((r) => r.status === "confirmed").length, 1);
}

async function smokePendingReschedulesToNewSlot() {
  // Bug: after a pending is created, if user re-confirms a NEW time,
  // the pending should be rescheduled (not keep the old reservation
  // while pretending to be at the new time).
  const db = createSmokeDb();
  const date = futureDate(3);

  // Initial: create pending at 14:00 (unambiguous)
  const initial = await route(db, `Quiero reservar 1 cancha para ${date} a las 14:00 a nombre de Mora`);
  assert.match(initial.reply ?? "", /Reserva pendiente/i, JSON.stringify(initial));
  assert.equal(db.reservations.length, 1);
  const reservationId = db.reservations[0].id as string;

  // User asks for a different slot WITHOUT a booking verb — should still
  // reschedule the existing pending (this was the user's real-world bug).
  const change = await route(db, `a las 16:00`);
  assert.equal(change.handled, true, JSON.stringify(change));
  assert.match(change.reply ?? "", /16:00/);
  // Still only ONE reservation (rescheduled, not duplicated)
  assert.equal(db.reservations.length, 1);
  assert.equal(db.reservations[0].id, reservationId);
  // It is now at 16:00, not 14:00
  assert.equal(
    formatInTimeZone(new Date(String(db.reservations[0].starts_at)), TIMEZONE, "HH:mm"),
    "16:00",
    "pending must be at 16:00 after the change, not still at 14:00",
  );
}

async function smokeMultiTimeBookingInOneMessage() {
  const db = createSmokeDb();
  const date = futureDate(7);

  // One message asking for 4 different times — name not provided yet
  const offer = await route(
    db,
    `Quiero reservar para ${date}: una a las 14, otra a las 16, otra a las 18 y la ultima a las 21`,
  );
  assert.equal(offer.handled, true, JSON.stringify(offer));
  assert.match(offer.reply ?? "", /4 horarios/i, JSON.stringify(offer));
  assert.match(offer.reply ?? "", /nombre/i);
  assert.equal(db.reservations.length, 0);

  // Provide the name — bot should now create 4 pending reservations
  const result = await route(db, "a nombre de Mateo");
  assert.equal(result.handled, true, JSON.stringify(result));
  assert.match(result.reply ?? "", /14:00/);
  assert.match(result.reply ?? "", /16:00/);
  assert.match(result.reply ?? "", /18:00/);
  assert.match(result.reply ?? "", /21:00/);
  const pendingCount = db.reservations.filter((r) => r.status === "pending").length;
  assert.equal(pendingCount, 4, `expected 4 pending reservations, got ${pendingCount}`);
}

async function smokeBareNameCompletesBooking() {
  // "de santiago" alone should complete the booking when only name is missing
  const dbA = createSmokeDb();
  const dateA = futureDate(4);
  const askA = await route(dbA, `Quiero reservar para ${dateA} a las 20:00`);
  assert.match(askA.reply ?? "", /A nombre de qui[eé]n/i);
  const completeA = await route(dbA, "de Santiago");
  assert.match(completeA.reply ?? "", /Reserva pendiente/i, JSON.stringify(completeA));
  assert.equal(dbA.reservations.length, 1);
  assert.equal((dbA.reservations[0].notes as string | null) ?? "", "Cancha 1");

  // Lone first name (no prefix) should also complete
  const dbB = createSmokeDb();
  const dateB = futureDate(5);
  await route(dbB, `Quiero reservar para ${dateB} a las 21:00`);
  const completeB = await route(dbB, "Ernesto Sabato");
  assert.match(completeB.reply ?? "", /Reserva pendiente/i, JSON.stringify(completeB));
  assert.equal(dbB.reservations.length, 1);

  // "soy X" works too
  const dbC = createSmokeDb();
  const dateC = futureDate(6);
  await route(dbC, `Tenes para ${dateC} a las 19:00?`);
  const completeC = await route(dbC, "soy Mateo");
  assert.match(completeC.reply ?? "", /Reserva pendiente/i, JSON.stringify(completeC));
}

async function smokeSecondBookingDoesNotInheritFirst() {
  const db = createSmokeDb();
  const firstDate = futureDate(2);
  const secondDate = futureDate(3);

  // Reserva 1: padel mañana 20hs, nombre Mora, 3 canchas
  const first = await route(db, `Quiero reservar 3 canchas de padel para ${firstDate} a las 20 a nombre de Mora`);
  assert.match(first.reply ?? "", /Reserva pendiente para 3 canchas/i);
  const proof = await route(db, "Te paso el comprobante");
  assert.match(proof.reply ?? "", /Reserva confirmada con seña/i);

  // Reserva 2 en la misma conversación, sin dar cantidad ni nombre — debe pedirlos, NO heredar 3 ni "Mora"
  const second = await route(db, `Te pido otra cancha para ${secondDate} a las 21`);
  assert.equal(second.handled, true, JSON.stringify(second));
  assert.doesNotMatch(second.reply ?? "", /3 canchas/i, "no debe heredar las 3 canchas de la reserva anterior");
  assert.doesNotMatch(second.reply ?? "", /Mora/i, "no debe heredar el nombre Mora");
  assert.match(second.reply ?? "", /nombre/i, "debe pedir el nombre nuevamente");
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
