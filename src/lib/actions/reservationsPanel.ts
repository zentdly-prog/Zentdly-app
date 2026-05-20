"use server";

import { createServerClient } from "@/infrastructure/supabase/server";
import { fromZonedTime } from "date-fns-tz";
import { revalidatePath } from "next/cache";
import { z } from "zod";

export async function getPanelReservations(
  tenantId: string,
  options?: { date?: string; timezone?: string; days?: number },
) {
  try {
    const db = createServerClient();
    const timezone = options?.timezone ?? "America/Argentina/Buenos_Aires";
    const startsFrom = options?.date
      ? fromZonedTime(`${options.date}T00:00:00`, timezone)
      : new Date();
    const startsTo = options?.date
      ? new Date(startsFrom.getTime() + 30 * 3600 * 1000)
      : new Date(startsFrom.getTime() + (options?.days ?? 14) * 86400000);

    const { data } = await db
      .from("reservations")
      .select("id, starts_at, ends_at, status, notes, customer_id, court_type_id, customers(name, phone_e164), court_types(sport_name)")
      .eq("tenant_id", tenantId)
      .gte("starts_at", startsFrom.toISOString())
      .lt("starts_at", startsTo.toISOString())
      .order("starts_at", { ascending: true });

    return data ?? [];
  } catch {
    return [];
  }
}

export async function getAiReservationStats(
  tenantId: string,
  timezone = "America/Argentina/Buenos_Aires",
): Promise<{ created: number; cancelled: number; monthLabel: string }> {
  const monthLabel = new Intl.DateTimeFormat("es-AR", { month: "long", year: "numeric", timeZone: timezone }).format(new Date());
  try {
    const db = createServerClient();
    // Start of the current month in the tenant's timezone, as UTC ISO.
    const parts = new Intl.DateTimeFormat("en-CA", { timeZone: timezone, year: "numeric", month: "2-digit" }).formatToParts(new Date());
    const year = parts.find((p) => p.type === "year")?.value;
    const month = parts.find((p) => p.type === "month")?.value;
    const monthStart = fromZonedTime(`${year}-${month}-01T00:00:00`, timezone).toISOString();

    // Reservations created by the AI (WhatsApp) this month
    const { count: created } = await db
      .from("reservations")
      .select("id", { count: "exact", head: true })
      .eq("tenant_id", tenantId)
      .eq("source", "whatsapp")
      .gte("created_at", monthStart);

    // Reservations cancelled by the AI this month
    const { count: cancelled, error: cancelledError } = await db
      .from("reservations")
      .select("id", { count: "exact", head: true })
      .eq("tenant_id", tenantId)
      .eq("cancelled_by", "ai")
      .gte("cancelled_at", monthStart);

    return {
      created: created ?? 0,
      cancelled: cancelledError ? 0 : (cancelled ?? 0),
      monthLabel,
    };
  } catch {
    return { created: 0, cancelled: 0, monthLabel };
  }
}

const UpdateReservationStatusSchema = z.object({
  tenant_id: z.string().uuid(),
  reservation_id: z.string().uuid(),
  status: z.enum(["pending", "confirmed", "cancelled", "completed"]),
});

export async function updateReservationStatus(formData: FormData): Promise<void> {
  const parsed = UpdateReservationStatusSchema.safeParse({
    tenant_id: formData.get("tenant_id"),
    reservation_id: formData.get("reservation_id"),
    status: formData.get("status"),
  });

  if (!parsed.success) return;

  const db = createServerClient();
  const isCancel = parsed.data.status === "cancelled";
  const update: Record<string, unknown> = isCancel
    ? { status: "cancelled", cancelled_at: new Date().toISOString(), cancelled_by: "panel" }
    : { status: parsed.data.status };

  let { error } = await db
    .from("reservations")
    .update(update)
    .eq("id", parsed.data.reservation_id)
    .eq("tenant_id", parsed.data.tenant_id);

  // Fallback if cancellation-tracking columns aren't applied yet
  if (error?.code === "42703") {
    ({ error } = await db
      .from("reservations")
      .update({ status: parsed.data.status })
      .eq("id", parsed.data.reservation_id)
      .eq("tenant_id", parsed.data.tenant_id));
  }

  if (error) return;
  revalidatePath(`/tenants/${parsed.data.tenant_id}/reservations`);
}
