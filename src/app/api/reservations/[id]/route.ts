import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { createServerClient } from "@/infrastructure/supabase/server";
import {
  AgentAvailabilityService,
  CourtAssignmentService,
  type ReservableCourt,
} from "@/domain/booking/agentBookingServices";
import { getCourtCapacity } from "@/domain/courts/courtUnits";

const RescheduleSchema = z.object({
  date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  time: z.string().regex(/^\d{2}:\d{2}$/),
  timezone: z.string().default("America/Argentina/Buenos_Aires"),
});

export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const { id } = await params;
    const db = createServerClient();
    const reservation = await loadReservation(db, id);
    if (!reservation) return NextResponse.json({ error: "Reservation not found" }, { status: 404 });
    return NextResponse.json({ reservation });
  } catch (err) {
    return handleError(err);
  }
}

export async function DELETE(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const { id } = await params;
    const body = await req.json().catch(() => ({}));
    const reason = body?.reason as string | undefined;

    const db = createServerClient();
    const existing = await loadReservation(db, id);
    if (!existing) return NextResponse.json({ error: "Reservation not found" }, { status: 404 });
    if (existing.status === "cancelled") {
      return NextResponse.json({ error: "La reserva ya está cancelada." }, { status: 409 });
    }

    await deleteGoogleCalendarEvent(db, existing.tenant_id, existing.external_event_id, process.env.DEFAULT_TIMEZONE ?? "America/Argentina/Buenos_Aires");

    const { data: reservation, error } = await db
      .from("reservations")
      .update({ status: "cancelled", notes: reason ? `${existing.notes ?? ""}${existing.notes ? " · " : ""}Cancelada: ${reason}` : existing.notes })
      .eq("id", id)
      .select("id, tenant_id, customer_id, court_type_id, starts_at, ends_at, status, source, notes, external_event_id, external_sheet_row_id")
      .single();

    if (error) throw error;
    return NextResponse.json({ reservation });
  } catch (err) {
    return handleError(err);
  }
}

export async function PATCH(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const { id } = await params;
    const body = await req.json();
    const input = RescheduleSchema.parse(body);

    const db = createServerClient();
    const existing = await loadReservation(db, id);
    if (!existing) return NextResponse.json({ error: "Reservation not found" }, { status: 404 });
    if (!["pending", "confirmed"].includes(existing.status)) {
      return NextResponse.json({ error: "Solo se pueden reprogramar reservas pendientes o confirmadas." }, { status: 409 });
    }

    const court = one(existing.court_types);
    if (!court) return NextResponse.json({ error: "No se pudo identificar el tipo de cancha." }, { status: 409 });

    const availability = new AgentAvailabilityService(db, existing.tenant_id, input.timezone);
    const dayError = availability.assertCourtWorksOnDate(court, input.date);
    if (dayError) return NextResponse.json({ error: dayError }, { status: 409 });

    const slotError = await availability.assertSlotIsReservable(court, input.date, input.time);
    if (slotError) return NextResponse.json({ error: slotError }, { status: 409 });

    const { startsAt, endsAt } = availability.buildReservationRange(court, input.date, input.time);
    const overlapping = await availability.findOverlappingReservations(court, startsAt, endsAt, id);
    if (overlapping.length >= getCourtCapacity(court)) {
      return NextResponse.json({ error: "Ese horario ya está completo." }, { status: 409 });
    }

    const courtUnit = new CourtAssignmentService().assign(court, overlapping);
    const { data: reservation, error } = await db
      .from("reservations")
      .update({
        starts_at: startsAt.toISOString(),
        ends_at: endsAt.toISOString(),
        notes: courtUnit.name,
      })
      .eq("id", id)
      .select("id, tenant_id, customer_id, court_type_id, starts_at, ends_at, status, source, notes, external_event_id, external_sheet_row_id")
      .single();

    if (error) throw error;
    return NextResponse.json({ reservation });
  } catch (err) {
    return handleError(err);
  }
}

async function loadReservation(db: ReturnType<typeof createServerClient>, id: string): Promise<ReservationRow | null> {
  const { data, error } = await db
    .from("reservations")
    .select("id, tenant_id, customer_id, court_type_id, starts_at, ends_at, status, source, notes, external_event_id, external_sheet_row_id, customers(name, phone_e164), court_types(id, sport_name, description, slot_duration_minutes, open_time, close_time, quantity, days_of_week, court_units)")
    .eq("id", id)
    .maybeSingle();

  if (error?.code === "42703") {
    const { data: fallbackData } = await db
      .from("reservations")
      .select("id, tenant_id, customer_id, court_type_id, starts_at, ends_at, status, source, notes, external_event_id, external_sheet_row_id, customers(name, phone_e164), court_types(id, sport_name, slot_duration_minutes, open_time, close_time, quantity, days_of_week)")
      .eq("id", id)
      .maybeSingle();

    return fallbackData as ReservationRow | null;
  }

  return data as ReservationRow | null;
}

async function deleteGoogleCalendarEvent(
  db: ReturnType<typeof createServerClient>,
  tenantId: string,
  externalEventId: string | null,
  timezone: string,
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
      timezone,
    });
    await calendar.deleteReservation(externalEventId);
  } catch (error) {
    console.error("[api/reservations/[id]] Google Calendar delete failed:", error);
  }
}

function one<T>(value: T | T[] | null | undefined): T | null {
  if (!value) return null;
  return Array.isArray(value) ? (value[0] ?? null) : value;
}

interface ReservationRow {
  id: string;
  tenant_id: string;
  customer_id: string;
  court_type_id: string;
  starts_at: string;
  ends_at: string;
  status: string;
  source: string;
  notes: string | null;
  external_event_id: string | null;
  external_sheet_row_id: string | null;
  court_types: ReservableCourt | ReservableCourt[] | null;
}

function handleError(err: unknown): NextResponse {
  if (err instanceof z.ZodError) {
    return NextResponse.json({ error: "Validation error", details: err.issues }, { status: 422 });
  }
  console.error("[api/reservations/[id]]", err);
  return NextResponse.json({ error: "Internal server error" }, { status: 500 });
}
