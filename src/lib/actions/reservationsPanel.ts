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
      .select("id, starts_at, ends_at, status, notes, customer_id, court_type_id, deposit_receipt_at, deposit_receipt_note, deposit_reviewed_at, deposit_reviewed_by, customers(name, phone_e164), court_types(sport_name)")
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
  revalidatePath(`/tenants/${parsed.data.tenant_id}/calendar`);
}

/** Court types offered by a business, for the manual reservation form. */
export async function getTenantCourtOptions(tenantId: string) {
  try {
    const db = createServerClient();
    const { data } = await db
      .from("court_types")
      .select("id, sport_name")
      .eq("tenant_id", tenantId)
      .eq("active", true)
      .order("sport_name");
    return (data ?? []) as Array<{ id: string; sport_name: string }>;
  } catch {
    return [];
  }
}

const ManualReservationSchema = z.object({
  tenant_id: z.string().uuid(),
  customer_name: z.string().min(1),
  customer_phone: z.string().optional(),
  sport_name: z.string().min(1),
  date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  time: z.string().regex(/^\d{2}:\d{2}$/),
  status: z.enum(["pending", "confirmed", "cancelled", "completed"]),
});

/**
 * Creates a reservation from the panel.
 *
 * Deliberately routed through the same domain service the WhatsApp agent uses,
 * so slot validation, capacity and court-unit assignment behave identically —
 * a manual booking can't silently double-book a slot the bot considers taken.
 */
export async function createManualReservation(
  _prev: unknown,
  formData: FormData,
): Promise<{ ok?: boolean; error?: string }> {
  const parsed = ManualReservationSchema.safeParse(Object.fromEntries(formData.entries()));
  if (!parsed.success) return { error: "Revisá los datos: falta el cliente, la cancha, la fecha o la hora." };

  const { tenant_id, customer_name, customer_phone, sport_name, date, time, status } = parsed.data;

  try {
    const db = createServerClient();

    const { data: tenant } = await db.from("tenants").select("timezone").eq("id", tenant_id).maybeSingle();
    const timezone = tenant?.timezone ?? "America/Argentina/Buenos_Aires";

    // Reuse the customer when the phone matches, so panel and WhatsApp
    // bookings land on the same person instead of creating duplicates.
    const phone = customer_phone?.trim()
      ? `+${customer_phone.replace(/[^\d]/g, "")}`
      : `panel:${customer_name.trim().toLowerCase()}`;

    const { data: customer, error: customerError } = await db
      .from("customers")
      .upsert({ tenant_id, phone_e164: phone, name: customer_name.trim() }, { onConflict: "tenant_id,phone_e164" })
      .select("id")
      .single();

    if (customerError || !customer) return { error: "No pude registrar al cliente." };

    const { createAgentBookingServices } = await import("@/domain/booking/agentBookingServices");
    const booking = createAgentBookingServices({
      db,
      tenantId: tenant_id,
      customerId: customer.id,
      customerPhone: phone,
      timezone,
      calendarSync: { sync: async () => undefined, delete: async () => undefined },
    });

    const result = await booking.reservations.createReservation({
      date,
      time,
      customer_name: customer_name.trim(),
      sport_name,
      status,
    });

    if (!result.ok) return { error: result.reply };

    revalidatePath(`/tenants/${tenant_id}/reservations`);
    revalidatePath(`/tenants/${tenant_id}/calendar`);
    return { ok: true };
  } catch (e) {
    return { error: e instanceof Error ? e.message : "No pude crear la reserva." };
  }
}

const RescheduleSchema = z.object({
  tenant_id: z.string().uuid(),
  reservation_id: z.string().uuid(),
  date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  time: z.string().regex(/^\d{2}:\d{2}$/),
  sport_name: z.string().min(1),
});

/** Moves a reservation to another date/time and/or court from the panel. */
export async function rescheduleReservationFromPanel(
  _prev: unknown,
  formData: FormData,
): Promise<{ ok?: boolean; error?: string }> {
  const parsed = RescheduleSchema.safeParse(Object.fromEntries(formData.entries()));
  if (!parsed.success) return { error: "Revisá la fecha, la hora y la cancha." };

  const { tenant_id, reservation_id, date, time, sport_name } = parsed.data;

  try {
    const db = createServerClient();
    const { data: reservation } = await db
      .from("reservations")
      .select("customer_id")
      .eq("id", reservation_id)
      .eq("tenant_id", tenant_id)
      .maybeSingle();

    if (!reservation?.customer_id) return { error: "No encontré esa reserva." };

    const { data: tenant } = await db.from("tenants").select("timezone").eq("id", tenant_id).maybeSingle();
    const { data: customer } = await db
      .from("customers")
      .select("phone_e164")
      .eq("id", reservation.customer_id)
      .maybeSingle();

    const { createAgentBookingServices } = await import("@/domain/booking/agentBookingServices");
    const booking = createAgentBookingServices({
      db,
      tenantId: tenant_id,
      customerId: reservation.customer_id,
      customerPhone: customer?.phone_e164 ?? "",
      timezone: tenant?.timezone ?? "America/Argentina/Buenos_Aires",
      calendarSync: { sync: async () => undefined, delete: async () => undefined },
    });

    const result = await booking.reservations.rescheduleMany([reservation_id], date, time, sport_name);
    if (!result.ok) return { error: result.reply };

    revalidatePath(`/tenants/${tenant_id}/reservations`);
    revalidatePath(`/tenants/${tenant_id}/calendar`);
    return { ok: true };
  } catch (e) {
    return { error: e instanceof Error ? e.message : "No pude reprogramar la reserva." };
  }
}

const ReviewDepositSchema = z.object({
  tenant_id: z.string().uuid(),
  reservation_id: z.string().uuid(),
  decision: z.enum(["accept", "reject"]),
});

/**
 * A person at the business accepts or rejects a deposit receipt.
 *
 * The agent never decides this: it only records that a receipt arrived and
 * emails it over. Accepting is what finally confirms the reservation.
 * Available to admins and to the business's own (lite) users alike, since both
 * reach the Reservations tab.
 */
export async function reviewDepositReceipt(
  _prev: unknown,
  formData: FormData,
): Promise<{ ok?: boolean; error?: string }> {
  const parsed = ReviewDepositSchema.safeParse(Object.fromEntries(formData.entries()));
  if (!parsed.success) return { error: "Datos inválidos." };

  const { tenant_id, reservation_id, decision } = parsed.data;

  try {
    const { getSession } = await import("@/lib/session");
    const session = await getSession();
    if (!session.valid) return { error: "Sesión vencida. Volvé a entrar." };
    // A lite user may only review reservations of the business they belong to.
    if (session.role === "lite" && session.tenantId !== tenant_id) {
      return { error: "No tenés permiso sobre este negocio." };
    }

    const db = createServerClient();
    const reviewed = {
      deposit_reviewed_at: new Date().toISOString(),
      deposit_reviewed_by: session.username || session.role,
    };

    const { error } = await db
      .from("reservations")
      .update(
        decision === "accept"
          ? { status: "confirmed", ...reviewed }
          : { status: "cancelled", cancelled_at: new Date().toISOString(), cancelled_by: "panel", ...reviewed },
      )
      .eq("id", reservation_id)
      .eq("tenant_id", tenant_id);

    if (error) return { error: error.message };

    revalidatePath(`/tenants/${tenant_id}/reservations`);
    revalidatePath(`/tenants/${tenant_id}/calendar`);
    return { ok: true };
  } catch (e) {
    return { error: e instanceof Error ? e.message : "No pude registrar la revisión." };
  }
}
