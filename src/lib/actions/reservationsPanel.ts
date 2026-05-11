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
  const { error } = await db
    .from("reservations")
    .update({ status: parsed.data.status })
    .eq("id", parsed.data.reservation_id)
    .eq("tenant_id", parsed.data.tenant_id);

  if (error) return;
  revalidatePath(`/tenants/${parsed.data.tenant_id}/reservations`);
}
