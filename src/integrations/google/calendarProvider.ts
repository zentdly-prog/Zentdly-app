import { google } from "googleapis";
import { IntegrationError } from "@/lib/errors";
import type { Reservation } from "@/types/database";
import type { GoogleIntegrationProvider, SyncReservationResult } from "./types";

export interface CalendarConfig {
  credentials: {
    client_email: string;
    private_key: string;
  };
  calendar_id: string;
  timezone: string;
}

export class GoogleCalendarProvider implements GoogleIntegrationProvider {
  constructor(private readonly config: CalendarConfig) {}

  private getClient() {
    const auth = new google.auth.GoogleAuth({
      credentials: this.config.credentials,
      scopes: ["https://www.googleapis.com/auth/calendar"],
    });
    return google.calendar({ version: "v3", auth });
  }

  async syncReservation(
    reservation: Reservation,
    customerName: string,
    customerPhone: string,
  ): Promise<SyncReservationResult> {
    const calendar = this.getClient();

    // Idempotent: use reservation.id as iCalUID
    const iCalUID = `zentdly-${reservation.id}@zentdly.app`;

    const courtLabel = reservation.notes ? ` - ${reservation.notes}` : "";
    const event = {
      summary: `Reserva${courtLabel}: ${customerName}`,
      description: `Cliente: ${customerName}\nTeléfono: ${customerPhone}\n${reservation.notes ? `Cancha: ${reservation.notes}\n` : ""}Origen: ${reservation.source}`,
      start: {
        dateTime: reservation.starts_at,
        timeZone: this.config.timezone,
      },
      end: {
        dateTime: reservation.ends_at,
        timeZone: this.config.timezone,
      },
      iCalUID,
    };

    try {
      // Check if event exists (idempotency)
      if (reservation.external_event_id) {
        const updated = await calendar.events.update({
          calendarId: this.config.calendar_id,
          eventId: reservation.external_event_id,
          requestBody: event,
        });
        return { externalId: updated.data.id! };
      }

      const created = await calendar.events.insert({
        calendarId: this.config.calendar_id,
        requestBody: event,
      });

      return { externalId: created.data.id! };
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      throw new IntegrationError("google_calendar", message);
    }
  }

  async deleteReservation(externalId: string): Promise<void> {
    const calendar = this.getClient();
    try {
      await calendar.events.delete({
        calendarId: this.config.calendar_id,
        eventId: externalId,
      });
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      throw new IntegrationError("google_calendar", message);
    }
  }
}
