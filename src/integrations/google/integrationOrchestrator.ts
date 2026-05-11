import { SupabaseClient } from "@supabase/supabase-js";
import { GoogleSheetsProvider } from "./sheetsProvider";
import { GoogleCalendarProvider } from "./calendarProvider";
import type { Reservation } from "@/types/database";

export class IntegrationOrchestrator {
  constructor(private readonly db: SupabaseClient) {}

  async syncAfterCreate(
    reservation: Reservation,
    customerName: string,
    customerPhone: string,
    timezone: string,
  ): Promise<void> {
    const { data: config } = await this.db
      .from("google_config")
      .select("*")
      .eq("tenant_id", reservation.tenant_id)
      .maybeSingle();

    if (!config?.service_account) return;

    const credentials = {
      client_email: config.service_account.client_email as string,
      private_key: config.service_account.private_key as string,
    };

    if (config.calendar_enabled && config.calendar_id) {
      try {
        const calendar = new GoogleCalendarProvider({
          credentials,
          calendar_id: config.calendar_id,
          timezone,
        });
        const result = await calendar.syncReservation(reservation, customerName, customerPhone);
        await this.db.from("reservations").update({ external_event_id: result.externalId }).eq("id", reservation.id);
      } catch (err) {
        console.error("[integration] calendar sync failed:", err);
      }
    }

    if (config.sheets_enabled && config.spreadsheet_id) {
      try {
        const sheets = new GoogleSheetsProvider({
          credentials,
          spreadsheet_id: config.spreadsheet_id,
          sheet_name: config.sheet_name ?? "Reservas",
          timezone,
        });
        await sheets.ensureHeaders();
        const result = await sheets.syncReservation(reservation, customerName, customerPhone);
        await this.db.from("reservations").update({ external_sheet_row_id: result.externalId }).eq("id", reservation.id);
      } catch (err) {
        console.error("[integration] sheets sync failed:", err);
      }
    }
  }

  async syncAfterCancel(
    reservation: Reservation,
    timezone: string,
  ): Promise<void> {
    const { data: config } = await this.db
      .from("google_config")
      .select("*")
      .eq("tenant_id", reservation.tenant_id)
      .maybeSingle();

    if (!config?.service_account) return;

    const credentials = {
      client_email: config.service_account.client_email as string,
      private_key: config.service_account.private_key as string,
    };

    if (config.calendar_enabled && config.calendar_id && reservation.external_event_id) {
      try {
        const calendar = new GoogleCalendarProvider({
          credentials,
          calendar_id: config.calendar_id,
          timezone,
        });
        await calendar.deleteReservation(reservation.external_event_id);
      } catch (err) {
        console.error("[integration] calendar cancel sync failed:", err);
      }
    }

    if (config.sheets_enabled && config.spreadsheet_id && reservation.external_sheet_row_id) {
      try {
        const sheets = new GoogleSheetsProvider({
          credentials,
          spreadsheet_id: config.spreadsheet_id,
          sheet_name: config.sheet_name ?? "Reservas",
          timezone,
        });
        await sheets.deleteReservation(reservation.external_sheet_row_id);
      } catch (err) {
        console.error("[integration] sheets cancel sync failed:", err);
      }
    }
  }
}
