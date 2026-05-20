import type { SupabaseClient } from "@supabase/supabase-js";
import { addDays } from "date-fns";
import { GoogleCalendarProvider, type CalendarEvent } from "./calendarProvider";
import { getActiveCourtUnits, pickAvailableCourtUnit, type CourtUnit } from "@/domain/courts/courtUnits";

const IMPORT_THROTTLE_MS = 60_000;
const IMPORT_WINDOW_DAYS = 30;
const PLACEHOLDER_PHONE = "+000000000000";

interface CourtRow {
  id: string;
  sport_name: string;
  quantity: number;
  court_units: CourtUnit[] | null;
}

/**
 * Pulls externally-created Google Calendar events into the reservations table
 * so the bot's availability respects manually-added bookings. Idempotent:
 * events already imported (matched by external_event_id) are skipped, and
 * Zentdly-origin events (iCalUID starting with "zentdly-") are ignored.
 *
 * Throttled per tenant via google_config.last_calendar_import_at so it runs at
 * most once per minute regardless of how many messages arrive.
 */
export async function importCalendarEventsThrottled(
  db: SupabaseClient,
  tenantId: string,
  timezone: string,
): Promise<{ imported: number; skipped: boolean }> {
  const { data: config } = await db
    .from("google_config")
    .select("service_account, calendar_id, calendar_enabled, last_calendar_import_at")
    .eq("tenant_id", tenantId)
    .maybeSingle();

  if (!config?.service_account || !config.calendar_enabled || !config.calendar_id) {
    return { imported: 0, skipped: true };
  }

  const lastImport = config.last_calendar_import_at ? new Date(config.last_calendar_import_at).getTime() : 0;
  if (Date.now() - lastImport < IMPORT_THROTTLE_MS) {
    return { imported: 0, skipped: true };
  }

  // Mark the import time up-front so concurrent invocations don't double-run.
  await db.from("google_config").update({ last_calendar_import_at: new Date().toISOString() }).eq("tenant_id", tenantId);

  try {
    return await importCalendarEvents(db, tenantId, timezone, config);
  } catch (error) {
    console.error("[calendar-import] failed:", error);
    return { imported: 0, skipped: false };
  }
}

async function importCalendarEvents(
  db: SupabaseClient,
  tenantId: string,
  timezone: string,
  config: { service_account: { client_email: string; private_key: string }; calendar_id: string },
): Promise<{ imported: number; skipped: boolean }> {
  const provider = new GoogleCalendarProvider({
    credentials: {
      client_email: config.service_account.client_email,
      private_key: config.service_account.private_key,
    },
    calendar_id: config.calendar_id,
    timezone,
  });

  const now = new Date();
  const events = await provider.listEvents(now, addDays(now, IMPORT_WINDOW_DAYS));

  // Only events NOT created by Zentdly (those are already in the DB)
  const external = events.filter((e) => !e.iCalUID.startsWith("zentdly-"));
  if (!external.length) return { imported: 0, skipped: false };

  // Already-imported events
  const { data: existing } = await db
    .from("reservations")
    .select("external_event_id")
    .eq("tenant_id", tenantId)
    .in("external_event_id", external.map((e) => e.id));
  const importedIds = new Set((existing ?? []).map((r) => r.external_event_id as string));

  const toImport = external.filter((e) => !importedIds.has(e.id));
  if (!toImport.length) return { imported: 0, skipped: false };

  const { data: courts } = await db
    .from("court_types")
    .select("id, sport_name, quantity, court_units")
    .eq("tenant_id", tenantId)
    .eq("active", true);

  if (!courts?.length) return { imported: 0, skipped: false };
  const courtRows = courts as CourtRow[];

  const customerId = await getOrCreatePlaceholderCustomer(db, tenantId);
  if (!customerId) return { imported: 0, skipped: false };

  let imported = 0;
  for (const event of toImport) {
    const court = matchCourt(courtRows, event);
    const unit = await assignUnit(db, tenantId, court, event);

    const { error } = await db.from("reservations").insert({
      tenant_id: tenantId,
      customer_id: customerId,
      court_type_id: court.id,
      starts_at: new Date(event.startsAt).toISOString(),
      ends_at: new Date(event.endsAt).toISOString(),
      status: "confirmed",
      source: "google_calendar",
      external_event_id: event.id,
      notes: unit?.name ?? null,
    });
    if (!error) imported += 1;
  }

  return { imported, skipped: false };
}

function matchCourt(courts: CourtRow[], event: CalendarEvent): CourtRow {
  if (courts.length === 1) return courts[0];
  const summary = event.summary.toLowerCase();
  const matched = courts.find((c) => summary.includes(c.sport_name.toLowerCase()));
  return matched ?? courts[0];
}

async function assignUnit(
  db: SupabaseClient,
  tenantId: string,
  court: CourtRow,
  event: CalendarEvent,
): Promise<CourtUnit | null> {
  const units = getActiveCourtUnits(court);
  if (!units.length) return null;

  // Confirmed reservations overlapping this slot occupy a unit.
  const { data: overlapping } = await db
    .from("reservations")
    .select("notes")
    .eq("tenant_id", tenantId)
    .eq("court_type_id", court.id)
    .eq("status", "confirmed")
    .lt("starts_at", new Date(event.endsAt).toISOString())
    .gt("ends_at", new Date(event.startsAt).toISOString());

  return pickAvailableCourtUnit(court, overlapping ?? []);
}

async function getOrCreatePlaceholderCustomer(db: SupabaseClient, tenantId: string): Promise<string | null> {
  const { data: existing } = await db
    .from("customers")
    .select("id")
    .eq("tenant_id", tenantId)
    .eq("phone_e164", PLACEHOLDER_PHONE)
    .maybeSingle();
  if (existing?.id) return existing.id;

  const { data: created } = await db
    .from("customers")
    .insert({ tenant_id: tenantId, phone_e164: PLACEHOLDER_PHONE, name: "Google Calendar" })
    .select("id")
    .single();
  return created?.id ?? null;
}
