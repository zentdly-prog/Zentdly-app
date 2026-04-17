import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { createServerClient } from "@/infrastructure/supabase/server";
import { ReservationRepository } from "@/infrastructure/repositories/reservationRepository";
import { CustomerRepository } from "@/infrastructure/repositories/customerRepository";
import { AvailabilityRepository } from "@/infrastructure/repositories/availabilityRepository";
import { AvailabilityService } from "@/domain/booking/availabilityService";
import { ReservationService } from "@/domain/booking/reservationService";
import { IntegrationOrchestrator } from "@/integrations/google/integrationOrchestrator";
import { ZentdlyError } from "@/lib/errors";

const RescheduleSchema = z.object({
  date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  time: z.string().regex(/^\d{2}:\d{2}$/),
  duration_minutes: z.number().int().positive().default(60),
  timezone: z.string().default("America/Argentina/Buenos_Aires"),
});

export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const { id } = await params;
    const db = createServerClient();
    const repo = new ReservationRepository(db);
    const reservation = await repo.findById(id);
    return NextResponse.json({ reservation });
  } catch (err) {
    return handleError(err);
  }
}

export async function DELETE(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const { id } = await params;
    const body = await req.json().catch(() => ({}));
    const reason = body?.reason as string | undefined;

    const db = createServerClient();
    const reservationRepo = new ReservationRepository(db);
    const customerRepo = new CustomerRepository(db);
    const availRepo = new AvailabilityRepository(db);
    const availService = new AvailabilityService(availRepo, reservationRepo);
    const reservationService = new ReservationService(reservationRepo, customerRepo, availService);

    const reservation = await reservationService.cancel(id, reason);

    // Sync cancellation
    const timezone = process.env.DEFAULT_TIMEZONE ?? "America/Argentina/Buenos_Aires";
    const integrations = new IntegrationOrchestrator(db);
    integrations
      .syncAfterCancel(reservation, timezone)
      .catch((err) => console.error("[api/reservations/cancel] sync error:", err));

    return NextResponse.json({ reservation });
  } catch (err) {
    return handleError(err);
  }
}

export async function PATCH(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const { id } = await params;
    const body = await req.json();
    const input = RescheduleSchema.parse(body);

    const db = createServerClient();
    const reservationRepo = new ReservationRepository(db);
    const customerRepo = new CustomerRepository(db);
    const availRepo = new AvailabilityRepository(db);
    const availService = new AvailabilityService(availRepo, reservationRepo);
    const reservationService = new ReservationService(reservationRepo, customerRepo, availService);

    const reservation = await reservationService.reschedule(id, input);
    return NextResponse.json({ reservation });
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
  console.error("[api/reservations/[id]]", err);
  return NextResponse.json({ error: "Internal server error" }, { status: 500 });
}
