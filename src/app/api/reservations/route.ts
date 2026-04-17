import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { createServerClient } from "@/infrastructure/supabase/server";
import { ReservationRepository } from "@/infrastructure/repositories/reservationRepository";
import { CustomerRepository } from "@/infrastructure/repositories/customerRepository";
import { AvailabilityRepository } from "@/infrastructure/repositories/availabilityRepository";
import { AvailabilityService } from "@/domain/booking/availabilityService";
import { ReservationService, CreateReservationSchema } from "@/domain/booking/reservationService";
import { IntegrationOrchestrator } from "@/integrations/google/integrationOrchestrator";
import { ZentdlyError } from "@/lib/errors";

export async function POST(req: NextRequest) {
  try {
    const body = await req.json();
    const input = CreateReservationSchema.parse(body);

    const db = createServerClient();
    const reservationRepo = new ReservationRepository(db);
    const customerRepo = new CustomerRepository(db);
    const availRepo = new AvailabilityRepository(db);
    const availService = new AvailabilityService(availRepo, reservationRepo);
    const reservationService = new ReservationService(reservationRepo, customerRepo, availService);

    const reservation = await reservationService.create(input);

    // Sync to Google integrations (non-blocking)
    const integrations = new IntegrationOrchestrator(db);
    const customer = await customerRepo.findById(reservation.customer_id);
    integrations
      .syncAfterCreate(
        reservation,
        customer?.name ?? "Sin nombre",
        customer?.phone_e164 ?? "",
        input.timezone,
      )
      .catch((err) => console.error("[api/reservations] sync error:", err));

    return NextResponse.json({ reservation }, { status: 201 });
  } catch (err) {
    return handleError(err);
  }
}

export async function GET(req: NextRequest) {
  try {
    const { searchParams } = req.nextUrl;
    const tenantId = searchParams.get("tenant_id");
    const date = searchParams.get("date");

    if (!tenantId || !date) {
      return NextResponse.json({ error: "tenant_id and date are required" }, { status: 400 });
    }

    const db = createServerClient();
    const repo = new ReservationRepository(db);
    const reservations = await repo.findByTenantAndDate(tenantId, date);

    return NextResponse.json({ reservations });
  } catch (err) {
    return handleError(err);
  }
}

function handleError(err: unknown): NextResponse {
  if (err instanceof z.ZodError) {
    return NextResponse.json({ error: "Validation error", details: err.issues }, { status: 422 });
  }
  if (err instanceof ZentdlyError) {
    return NextResponse.json({ error: err.message, code: err.code }, { status: err.statusCode });
  }
  console.error("[api/reservations]", err);
  return NextResponse.json({ error: "Internal server error" }, { status: 500 });
}
