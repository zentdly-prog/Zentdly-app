import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { createServerClient } from "@/infrastructure/supabase/server";
import { AgentAvailabilityService } from "@/domain/booking/agentBookingServices";

const QuerySchema = z.object({
  tenant_id: z.string().uuid(),
  date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  sport_name: z.string().trim().optional(),
  timezone: z.string().default("America/Argentina/Buenos_Aires"),
});

export async function GET(req: NextRequest) {
  try {
    const params = Object.fromEntries(req.nextUrl.searchParams.entries());
    const input = QuerySchema.parse(params);

    const db = createServerClient();
    const service = new AgentAvailabilityService(db, input.tenant_id, input.timezone);
    const courts = await service.getAvailability(input.date, input.sport_name);
    const message = await service.check(input.date, input.sport_name);

    return NextResponse.json({ courts, message });
  } catch (err) {
    if (err instanceof z.ZodError) {
      return NextResponse.json({ error: "Validation error", details: err.issues }, { status: 422 });
    }
    console.error("[api/availability]", err);
    return NextResponse.json({ error: "Internal server error" }, { status: 500 });
  }
}
