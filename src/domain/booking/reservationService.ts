import { z } from "zod";
import { fromZonedTime } from "date-fns-tz";
import type { Reservation } from "@/types/database";
import type { ReservationRepository } from "@/infrastructure/repositories/reservationRepository";
import type { CustomerRepository } from "@/infrastructure/repositories/customerRepository";
import { AvailabilityService } from "./availabilityService";
import { ConflictError, ValidationError } from "@/lib/errors";

export const CreateReservationSchema = z.object({
  tenant_id: z.string().uuid(),
  venue_id: z.string().uuid(),
  court_id: z.string().uuid(),
  sport_id: z.string().uuid(),
  customer_phone: z.string().min(7),
  customer_name: z.string().optional(),
  date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  time: z.string().regex(/^\d{2}:\d{2}$/),
  duration_minutes: z.number().int().positive().default(60),
  timezone: z.string().default("America/Argentina/Buenos_Aires"),
  source: z.enum(["whatsapp", "panel", "api"]).default("whatsapp"),
  notes: z.string().optional(),
});

export type CreateReservationInput = z.infer<typeof CreateReservationSchema>;

export const CancelReservationSchema = z.object({
  reservation_id: z.string().uuid(),
  reason: z.string().optional(),
});

export class ReservationService {
  constructor(
    private readonly reservationRepo: ReservationRepository,
    private readonly customerRepo: CustomerRepository,
    private readonly availabilityService: AvailabilityService,
  ) {}

  async create(raw: CreateReservationInput): Promise<Reservation> {
    const input = CreateReservationSchema.parse(raw);

    const startsAt = fromZonedTime(`${input.date}T${input.time}:00`, input.timezone);
    const endsAt = new Date(startsAt.getTime() + input.duration_minutes * 60 * 1000);

    const available = await this.availabilityService.isSlotAvailable(
      input.court_id,
      startsAt,
      endsAt,
      input.venue_id,
    );

    if (!available) {
      throw new ConflictError(
        `No hay disponibilidad en esa cancha para el horario solicitado.`,
      );
    }

    const customer = await this.customerRepo.upsertByPhone(
      input.tenant_id,
      input.customer_phone,
      input.customer_name,
    );

    const reservation = await this.reservationRepo.create({
      tenant_id: input.tenant_id,
      venue_id: input.venue_id,
      court_id: input.court_id,
      customer_id: customer.id,
      sport_id: input.sport_id,
      starts_at: startsAt,
      ends_at: endsAt,
      source: input.source,
      notes: input.notes,
    });

    await this.reservationRepo.auditLog(reservation.id, "created", {
      source: input.source,
      customer_phone: input.customer_phone,
    });

    return reservation;
  }

  async cancel(reservationId: string, reason?: string): Promise<Reservation> {
    const existing = await this.reservationRepo.findById(reservationId);

    if (existing.status === "cancelled") {
      throw new ValidationError("La reserva ya está cancelada.");
    }
    if (existing.status === "completed") {
      throw new ValidationError("No se puede cancelar una reserva completada.");
    }

    const updated = await this.reservationRepo.updateStatus(reservationId, "cancelled");

    await this.reservationRepo.auditLog(reservationId, "cancelled", {
      reason: reason ?? null,
      previous_status: existing.status,
    });

    return updated;
  }

  async reschedule(
    reservationId: string,
    newInput: Pick<CreateReservationInput, "date" | "time" | "duration_minutes" | "timezone">,
  ): Promise<Reservation> {
    const existing = await this.reservationRepo.findById(reservationId);

    if (!["pending", "confirmed"].includes(existing.status)) {
      throw new ValidationError("Solo se pueden reprogramar reservas pendientes o confirmadas.");
    }

    const startsAt = fromZonedTime(`${newInput.date}T${newInput.time}:00`, newInput.timezone);
    const endsAt = new Date(startsAt.getTime() + newInput.duration_minutes * 60 * 1000);

    const available = await this.availabilityService.isSlotAvailable(
      existing.court_id,
      startsAt,
      endsAt,
      existing.venue_id,
    );

    if (!available) {
      throw new ConflictError("El nuevo horario no está disponible.");
    }

    await this.reservationRepo.auditLog(reservationId, "rescheduled", {
      old_starts_at: existing.starts_at,
      old_ends_at: existing.ends_at,
      new_starts_at: startsAt.toISOString(),
      new_ends_at: endsAt.toISOString(),
    });

    // Cancel old and create new to maintain the unique slot index integrity
    await this.reservationRepo.updateStatus(reservationId, "cancelled");

    const newReservation = await this.reservationRepo.create({
      tenant_id: existing.tenant_id,
      venue_id: existing.venue_id,
      court_id: existing.court_id,
      customer_id: existing.customer_id,
      sport_id: existing.sport_id,
      starts_at: startsAt,
      ends_at: endsAt,
      source: existing.source as "whatsapp" | "panel" | "api",
      notes: existing.notes ?? undefined,
    });

    return newReservation;
  }
}
