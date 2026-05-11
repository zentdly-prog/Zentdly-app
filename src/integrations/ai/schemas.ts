import { z } from "zod";

export const NormalizedIntentSchema = z.object({
  intent: z.enum([
    "booking",
    "availability",
    "cancel",
    "reschedule",
    "deposit_confirmation",
    "policy_question",
    "greeting",
    "human_handoff",
    "unknown",
  ]),
  action_requested: z.enum([
    "ask_missing_data",
    "ask_time_clarification",
    "check_availability",
    "create_reservation",
    "create_pending_reservation",
    "confirm_pending_reservation",
    "list_reservations",
    "cancel_reservation",
    "cancel_many_reservations",
    "reschedule_reservation",
    "answer_policy",
    "handoff",
    "none",
  ]),
  date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullable(),
  time: z.string().regex(/^\d{2}:\d{2}$/).nullable(),
  time_ambiguous: z.boolean(),
  time_options: z.array(z.string().regex(/^\d{2}:\d{2}$/)).max(4),
  sport: z.string().nullable(),
  quantity: z.number().int().positive().nullable(),
  customer_name: z.string().nullable(),
  reservation_id: z.string().nullable(),
  contextual_reference: z.object({
    type: z.enum([
      "none",
      "last_listed_reservations",
      "last_offered_slots",
      "last_pending_reservations",
      "last_created_reservations",
      "customer_active_reservations",
      "explicit_reservation_id",
      "explicit_date_time",
    ]),
    scope: z.enum([
      "none",
      "one",
      "mentioned_quantity",
      "all",
      "same_time",
      "same_day",
      "last_group",
    ]),
    text: z.string().nullable(),
  }),
  confirmation: z.object({
    is_confirmation: z.boolean(),
    is_rejection: z.boolean(),
    target_action: z.enum([
      "none",
      "booking",
      "cancel",
      "reschedule",
      "deposit_confirmation",
      "time_clarification",
    ]),
  }),
  missing_fields: z.array(z.enum(["sport", "date", "time", "customer_name", "quantity", "reservation"])),
  confidence: z.number().min(0).max(1),
  notes: z.string().nullable(),
});

export type NormalizedIntent = z.infer<typeof NormalizedIntentSchema>;

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
