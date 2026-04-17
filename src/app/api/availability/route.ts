import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { createServerClient } from "@/infrastructure/supabase/server";
import { AvailabilityRepository } from "@/infrastructure/repositories/availabilityRepository";
import { ReservationRepository } from "@/infrastructure/repositories/reservationRepository";
import { AvailabilityService } from "@/domain/booking/availabilityService";
import { ZentdlyError } from "@/lib/errors";

const QuerySchema = z.object({
  tenant_id: z.string().uuid(),
  venue_id: z.string().uuid(),
  sport_id: z.string().uuid().optional(),
  date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  timezone: z.string().default("America/Argentina/Buenos_Aires"),
  duration_minutes: z.coerce.number().int().positive().optional(),
});

export async function GET(req: NextRequest) {
  try {
    const params = Object.fromEntries(req.nextUrl.searchParams.entries());
    const input = QuerySchema.parse(params);

    const db = createServerClient();
    const availRepo = new AvailabilityRepository(db);
    const reservationRepo = new ReservationRepository(db);
    const service = new AvailabilityService(availRepo, reservationRepo);

    const slots = await service.getAvailableSlots(input);

    return NextResponse.json({ slots });
  } catch (err) {
    if (err instanceof z.ZodError) {
      return NextResponse.json({ error: "Validation error", details: err.issues }, { status: 422 });
    }
    if (err instanceof ZentdlyError) {
      return NextResponse.json({ error: err.message }, { status: err.statusCode });
    }
    return NextResponse.json({ error: "Internal server error" }, { status: 500 });
  }
}
