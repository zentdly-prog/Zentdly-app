import { SupabaseClient } from "@supabase/supabase-js";
import { GoogleSheetsProvider } from "./sheetsProvider";
import { GoogleCalendarProvider } from "./calendarProvider";
import type { GoogleIntegrationProvider } from "./types";
import type { Reservation, IntegrationSettings } from "@/types/database";
import { ReservationRepository } from "@/infrastructure/repositories/reservationRepository";

export class IntegrationOrchestrator {
  constructor(private readonly db: SupabaseClient) {}

  private buildProvider(settings: IntegrationSettings, timezone: string): GoogleIntegrationProvider | null {
    const cfg = settings.config as Record<string, unknown>;

    if (settings.provider === "google_sheets") {
      return new GoogleSheetsProvider({
        credentials: cfg.credentials as { client_email: string; private_key: string },
        spreadsheet_id: cfg.spreadsheet_id as string,
        sheet_name: cfg.sheet_name as string | undefined,
        timezone,
      });
    }

    if (settings.provider === "google_calendar") {
      return new GoogleCalendarProvider({
        credentials: cfg.credentials as { client_email: string; private_key: string },
        calendar_id: cfg.calendar_id as string,
        timezone,
      });
    }

    return null;
  }

  async syncAfterCreate(
    reservation: Reservation,
    customerName: string,
    customerPhone: string,
    timezone: string,
  ): Promise<void> {
    const { data: settings } = await this.db
      .from("integration_settings")
      .select("*")
      .eq("tenant_id", reservation.tenant_id)
      .eq("active", true);

    if (!settings?.length) return;

    const repo = new ReservationRepository(this.db);

    for (const setting of settings as IntegrationSettings[]) {
      const provider = this.buildProvider(setting, timezone);
      if (!provider) continue;

      try {
        const result = await provider.syncReservation(reservation, customerName, customerPhone);

        await repo.updateStatus(
          reservation.id,
          reservation.status,
          setting.provider === "google_calendar" ? result.externalId : undefined,
          setting.provider === "google_sheets" ? result.externalId : undefined,
        );
      } catch (err) {
        console.error(`[integration] sync failed for provider ${setting.provider}:`, err);
        // Non-blocking: log and continue
      }
    }
  }

  async syncAfterCancel(
    reservation: Reservation,
    timezone: string,
  ): Promise<void> {
    const { data: settings } = await this.db
      .from("integration_settings")
      .select("*")
      .eq("tenant_id", reservation.tenant_id)
      .eq("active", true);

    if (!settings?.length) return;

    for (const setting of settings as IntegrationSettings[]) {
      const provider = this.buildProvider(setting, timezone);
      if (!provider) continue;

      const externalId =
        setting.provider === "google_calendar"
          ? reservation.external_event_id
          : reservation.external_sheet_row_id;

      if (!externalId) continue;

      try {
        await provider.deleteReservation(externalId);
      } catch (err) {
        console.error(`[integration] cancel sync failed for provider ${setting.provider}:`, err);
      }
    }
  }
}
