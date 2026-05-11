import { parseISO } from "date-fns";
import { toZonedTime } from "date-fns-tz";
import { generateSlots, slotsOverlap } from "@/lib/utils/date";
import type { AvailabilityRepository } from "@/infrastructure/repositories/availabilityRepository";
import type { ReservationRepository } from "@/infrastructure/repositories/reservationRepository";

export interface AvailabilitySlot {
  court_id: string;
  court_name: string;
  starts_at: Date;
  ends_at: Date;
  available: boolean;
}

export interface CheckAvailabilityInput {
  tenant_id: string;
  venue_id: string;
  sport_id?: string;
  date: string; // YYYY-MM-DD in tenant timezone
  timezone: string;
  duration_minutes?: number;
}

export class AvailabilityService {
  constructor(
    private readonly availRepo: AvailabilityRepository,
    private readonly reservationRepo: ReservationRepository,
  ) {}

  async getAvailableSlots(input: CheckAvailabilityInput): Promise<AvailabilitySlot[]> {
    const dayOfWeek = toZonedTime(
      new Date(`${input.date}T12:00:00Z`),
      input.timezone,
    ).getDay();

    const hours = await this.availRepo.getBusinessHours(input.venue_id, dayOfWeek);
    if (!hours) return [];

    const courts = await this.availRepo.getActiveCourts(input.venue_id, input.sport_id);
    if (!courts.length) return [];

    const slotDuration = input.duration_minutes ?? hours.slot_duration_minutes;
    const rawSlots = generateSlots(hours.open_time, hours.close_time, slotDuration, input.date, input.timezone);

    const result: AvailabilitySlot[] = [];

    for (const court of courts) {
      const dayStart = rawSlots[0]?.start;
      const dayEnd = rawSlots[rawSlots.length - 1]?.end;
      if (!dayStart || !dayEnd) continue;

      const [existingReservations, closures] = await Promise.all([
        this.reservationRepo.findActiveByCourtAndRange(court.id, dayStart, dayEnd),
        this.availRepo.getClosures(input.venue_id, court.id, dayStart, dayEnd),
      ]);

      for (const slot of rawSlots) {
        const blockedByReservation = existingReservations.some((r) =>
          slotsOverlap(slot, { start: parseISO(r.starts_at), end: parseISO(r.ends_at) }),
        );
        const blockedByClosure = closures.some((c) =>
          slotsOverlap(slot, { start: parseISO(c.starts_at), end: parseISO(c.ends_at) }),
        );

        result.push({
          court_id: court.id,
          court_name: court.name,
          starts_at: slot.start,
          ends_at: slot.end,
          available: !blockedByReservation && !blockedByClosure,
        });
      }
    }

    return result;
  }

  async isSlotAvailable(
    courtTypeId: string,
    startsAt: Date,
    endsAt: Date,
  ): Promise<boolean> {
    const reservations = await this.reservationRepo.findActiveByCourtAndRange(courtTypeId, startsAt, endsAt);
    return reservations.length === 0;
  }

  async findAlternativeSlots(
    input: CheckAvailabilityInput,
    limit = 3,
  ): Promise<AvailabilitySlot[]> {
    const all = await this.getAvailableSlots(input);
    return all.filter((s) => s.available).slice(0, limit);
  }
}
