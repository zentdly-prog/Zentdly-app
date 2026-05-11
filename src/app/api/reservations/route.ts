import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { createServerClient } from "@/infrastructure/supabase/server";
import { fromZonedTime } from "date-fns-tz";
import { createAgentBookingServices } from "@/domain/booking/agentBookingServices";

const CreateReservationSchema = z.object({
  tenant_id: z.string().uuid(),
  customer_phone: z.string().min(7),
  customer_name: z.string().trim().optional(),
  sport_name: z.string().trim().min(1),
  date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  time: z.string().regex(/^\d{2}:\d{2}$/),
  timezone: z.string().default("America/Argentina/Buenos_Aires"),
});

export async function POST(req: NextRequest) {
  try {
    const body = await req.json();
    const input = CreateReservationSchema.parse(body);

    const db = createServerClient();
    const { data: customer, error: customerError } = await db
      .from("customers")
      .upsert(
        {
          tenant_id: input.tenant_id,
          phone_e164: input.customer_phone,
          name: input.customer_name ?? null,
        },
        { onConflict: "tenant_id,phone_e164", ignoreDuplicates: false },
      )
      .select("id")
      .single();

    if (customerError || !customer) {
      return NextResponse.json({ error: customerError?.message ?? "Customer not found" }, { status: 400 });
    }

    const booking = createAgentBookingServices({
      db,
      tenantId: input.tenant_id,
      customerId: customer.id,
      customerPhone: input.customer_phone,
      timezone: input.timezone,
    });

    const message = await booking.reservations.create({
      customer_name: input.customer_name ?? "",
      sport_name: input.sport_name,
      date: input.date,
      time: input.time,
    });

    const startsAt = fromZonedTime(`${input.date}T${input.time}:00`, input.timezone).toISOString();
    const { data: reservation } = await db
      .from("reservations")
      .select("id, tenant_id, customer_id, court_type_id, starts_at, ends_at, status, source, notes, external_event_id, external_sheet_row_id, court_types(sport_name)")
      .eq("tenant_id", input.tenant_id)
      .eq("customer_id", customer.id)
      .eq("starts_at", startsAt)
      .order("created_at", { ascending: false })
      .limit(1)
      .maybeSingle();

    return NextResponse.json({ reservation, message }, { status: reservation ? 201 : 409 });
  } catch (err) {
    return handleError(err);
  }
}

export async function GET(req: NextRequest) {
  try {
    const { searchParams } = req.nextUrl;
    const tenantId = searchParams.get("tenant_id");
    const date = searchParams.get("date");
    const timezone = searchParams.get("timezone") ?? "America/Argentina/Buenos_Aires";

    if (!tenantId || !date) {
      return NextResponse.json({ error: "tenant_id and date are required" }, { status: 400 });
    }

    const dayStart = fromZonedTime(`${date}T00:00:00`, timezone).toISOString();
    const dayEnd = new Date(fromZonedTime(`${date}T00:00:00`, timezone).getTime() + 30 * 3600 * 1000).toISOString();
    const db = createServerClient();
    const { data: reservations, error } = await db
      .from("reservations")
      .select("id, starts_at, ends_at, status, notes, customer_id, court_type_id, customers(name, phone_e164), court_types(sport_name)")
      .eq("tenant_id", tenantId)
      .gte("starts_at", dayStart)
      .lt("starts_at", dayEnd)
      .order("starts_at", { ascending: true });

    if (error) throw error;

    return NextResponse.json({ reservations: reservations ?? [] });
  } catch (err) {
    return handleError(err);
  }
}

function handleError(err: unknown): NextResponse {
  if (err instanceof z.ZodError) {
    return NextResponse.json({ error: "Validation error", details: err.issues }, { status: 422 });
  }
  console.error("[api/reservations]", err);
  return NextResponse.json({ error: "Internal server error" }, { status: 500 });
}
