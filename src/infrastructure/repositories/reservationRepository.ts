import { SupabaseClient } from "@supabase/supabase-js";
import type { Reservation, ReservationStatus } from "@/types/database";
import { ConflictError, NotFoundError } from "@/lib/errors";

export interface CreateReservationInput {
  tenant_id: string;
  court_type_id: string;
  customer_id: string;
  starts_at: Date;
  ends_at: Date;
  status?: ReservationStatus;
  source?: string;
  notes?: string;
}

export class ReservationRepository {
  constructor(private readonly db: SupabaseClient) {}

  async findById(id: string): Promise<Reservation> {
    const { data, error } = await this.db
      .from("reservations")
      .select("*")
      .eq("id", id)
      .single();

    if (error || !data) throw new NotFoundError("Reservation", id);
    return data as Reservation;
  }

  async findActiveByCourtAndRange(
    courtTypeId: string,
    startsAt: Date,
    endsAt: Date,
  ): Promise<Reservation[]> {
    const { data, error } = await this.db
      .from("reservations")
      .select("*")
      .eq("court_type_id", courtTypeId)
      .in("status", ["pending", "confirmed"])
      .lt("starts_at", endsAt.toISOString())
      .gt("ends_at", startsAt.toISOString());

    if (error) throw error;
    return (data ?? []) as Reservation[];
  }

  async findByTenantAndDate(tenantId: string, date: string): Promise<Reservation[]> {
    const dayStart = `${date}T00:00:00Z`;
    const dayEnd = `${date}T23:59:59Z`;

    const { data, error } = await this.db
      .from("reservations")
      .select("*, customers(name, phone_e164), court_types(sport_name)")
      .eq("tenant_id", tenantId)
      .gte("starts_at", dayStart)
      .lte("starts_at", dayEnd)
      .order("starts_at");

    if (error) throw error;
    return (data ?? []) as Reservation[];
  }

  async create(input: CreateReservationInput): Promise<Reservation> {
    const { data, error } = await this.db
      .from("reservations")
      .insert({
        tenant_id: input.tenant_id,
        court_type_id: input.court_type_id,
        customer_id: input.customer_id,
        starts_at: input.starts_at.toISOString(),
        ends_at: input.ends_at.toISOString(),
        status: input.status ?? "confirmed",
        source: input.source ?? "whatsapp",
        notes: input.notes ?? null,
      })
      .select()
      .single();

    if (error) {
      if (error.code === "23505") {
        throw new ConflictError("That time slot is already booked.");
      }
      throw error;
    }

    return data as Reservation;
  }

  async updateStatus(
    id: string,
    status: ReservationStatus,
    externalEventId?: string,
    externalSheetRowId?: string,
  ): Promise<Reservation> {
    const update: Record<string, unknown> = { status };
    if (externalEventId !== undefined) update.external_event_id = externalEventId;
    if (externalSheetRowId !== undefined) update.external_sheet_row_id = externalSheetRowId;

    const { data, error } = await this.db
      .from("reservations")
      .update(update)
      .eq("id", id)
      .select()
      .single();

    if (error || !data) throw new NotFoundError("Reservation", id);
    return data as Reservation;
  }

  async auditLog(
    reservationId: string,
    action: string,
    payload: Record<string, unknown>,
  ): Promise<void> {
    await this.db
      .from("reservation_audit_log")
      .insert({ reservation_id: reservationId, action, payload });
  }
}
