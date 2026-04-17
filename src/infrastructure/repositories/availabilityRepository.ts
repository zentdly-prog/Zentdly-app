import { SupabaseClient } from "@supabase/supabase-js";
import type { BusinessHours, Closure, Court } from "@/types/database";

export class AvailabilityRepository {
  constructor(private readonly db: SupabaseClient) {}

  async getBusinessHours(venueId: string, dayOfWeek: number): Promise<BusinessHours | null> {
    const { data } = await this.db
      .from("business_hours")
      .select("*")
      .eq("venue_id", venueId)
      .eq("day_of_week", dayOfWeek)
      .single();

    return data as BusinessHours | null;
  }

  async getActiveCourts(venueId: string, sportId?: string): Promise<Court[]> {
    let query = this.db
      .from("courts")
      .select("*")
      .eq("venue_id", venueId)
      .eq("active", true);

    if (sportId) query = query.eq("sport_id", sportId);

    const { data } = await query;
    return (data ?? []) as Court[];
  }

  async getClosures(venueId: string, courtId: string | null, startsAt: Date, endsAt: Date): Promise<Closure[]> {
    let query = this.db
      .from("closures")
      .select("*")
      .eq("venue_id", venueId)
      .lt("starts_at", endsAt.toISOString())
      .gt("ends_at", startsAt.toISOString());

    if (courtId) {
      query = query.or(`court_id.is.null,court_id.eq.${courtId}`);
    } else {
      query = query.is("court_id", null);
    }

    const { data } = await query;
    return (data ?? []) as Closure[];
  }
}
