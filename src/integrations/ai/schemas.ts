import { z } from "zod";

export const ExtractedBookingSchema = z.object({
  intent: z.enum([
    "create_reservation",
    "query_availability",
    "cancel_reservation",
    "reschedule_reservation",
    "unknown",
  ]),
  sport: z.string().nullable(),
  venue: z.string().nullable(),
  date: z.string().nullable(), // YYYY-MM-DD
  time: z.string().nullable(), // HH:mm
  duration_minutes: z.number().nullable(),
  customer_name: z.string().nullable(),
  needs_follow_up: z.boolean(),
  missing_fields: z.array(z.string()),
});

export type ExtractedBooking = z.infer<typeof ExtractedBookingSchema>;

export const REQUIRED_FIELDS_BY_INTENT: Record<string, string[]> = {
  create_reservation: ["sport", "date", "time", "customer_name"],
  cancel_reservation: ["date", "time"],
  reschedule_reservation: ["date", "time"],
  query_availability: ["sport", "date"],
};
