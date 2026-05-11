import { z } from "zod";

const INTENT_VALUES = [
  "booking",
  "availability",
  "cancel",
  "reschedule",
  "deposit_confirmation",
  "policy_question",
  "greeting",
  "human_handoff",
  "unknown",
] as const;

const ACTION_VALUES = [
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
] as const;

const CONTEXT_TYPE_VALUES = [
  "none",
  "last_listed_reservations",
  "last_offered_slots",
  "last_pending_reservations",
  "last_created_reservations",
  "customer_active_reservations",
  "explicit_reservation_id",
  "explicit_date_time",
] as const;

const CONTEXT_SCOPE_VALUES = [
  "none",
  "one",
  "mentioned_quantity",
  "all",
  "same_time",
  "same_day",
  "last_group",
] as const;

const TARGET_ACTION_VALUES = [
  "none",
  "booking",
  "cancel",
  "reschedule",
  "deposit_confirmation",
  "time_clarification",
] as const;

const MISSING_FIELD_VALUES = ["sport", "date", "time", "customer_name", "quantity", "reservation"] as const;

const enumWithFallback = <T extends readonly [string, ...string[]]>(values: T, fallback: T[number]) =>
  z.preprocess((v) => (values.includes(v as T[number]) ? v : fallback), z.enum(values));

const nullableString = z.preprocess(
  (v) => (v === undefined || v === "" ? null : v),
  z.string().nullable(),
);

const timeOption = z.preprocess(
  (v) => (typeof v === "string" && /^\d{1,2}:\d{2}$/.test(v) ? v.padStart(5, "0") : v),
  z.string().regex(/^\d{2}:\d{2}$/),
);

const dateString = z.preprocess(
  (v) => (typeof v === "string" && /^\d{4}-\d{2}-\d{2}$/.test(v) ? v : v ?? null),
  z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullable(),
);

const timeString = z.preprocess(
  (v) => {
    if (typeof v !== "string") return v ?? null;
    return /^\d{1,2}:\d{2}$/.test(v) ? v.padStart(5, "0") : v;
  },
  z.string().regex(/^\d{2}:\d{2}$/).nullable(),
);

export const NormalizedIntentSchema = z.object({
  intent: enumWithFallback(INTENT_VALUES, "unknown"),
  action_requested: enumWithFallback(ACTION_VALUES, "none"),
  date: dateString,
  time: timeString,
  time_ambiguous: z.preprocess((v) => Boolean(v), z.boolean()),
  time_options: z.preprocess(
    (v) => (Array.isArray(v) ? v.slice(0, 4) : []),
    z.array(timeOption).max(4),
  ),
  sport: nullableString,
  quantity: z.preprocess(
    (v) => (typeof v === "number" && v > 0 ? Math.trunc(v) : null),
    z.number().int().positive().nullable(),
  ),
  customer_name: nullableString,
  reservation_id: nullableString,
  contextual_reference: z.preprocess(
    (v) => (v && typeof v === "object" ? v : { type: "none", scope: "none", text: null }),
    z.object({
      type: enumWithFallback(CONTEXT_TYPE_VALUES, "none"),
      scope: enumWithFallback(CONTEXT_SCOPE_VALUES, "none"),
      text: nullableString,
    }),
  ),
  confirmation: z.preprocess(
    (v) => (v && typeof v === "object" ? v : { is_confirmation: false, is_rejection: false, target_action: "none" }),
    z.object({
      is_confirmation: z.preprocess((v) => Boolean(v), z.boolean()),
      is_rejection: z.preprocess((v) => Boolean(v), z.boolean()),
      target_action: enumWithFallback(TARGET_ACTION_VALUES, "none"),
    }),
  ),
  missing_fields: z.preprocess(
    (v) => (Array.isArray(v) ? v.filter((f) => (MISSING_FIELD_VALUES as readonly string[]).includes(f)) : []),
    z.array(z.enum(MISSING_FIELD_VALUES)),
  ),
  confidence: z.preprocess(
    (v) => {
      if (typeof v !== "number") return 0.5;
      if (v < 0) return 0;
      if (v > 1) return 1;
      return v;
    },
    z.number().min(0).max(1),
  ),
  notes: nullableString,
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
