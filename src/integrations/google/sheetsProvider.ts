import { google } from "googleapis";
import { formatLocal } from "@/lib/utils/date";
import { IntegrationError } from "@/lib/errors";
import type { Reservation } from "@/types/database";
import type { GoogleIntegrationProvider, SyncReservationResult } from "./types";

export interface SheetsConfig {
  credentials: {
    client_email: string;
    private_key: string;
  };
  spreadsheet_id: string;
  sheet_name?: string;
  timezone: string;
}

export class GoogleSheetsProvider implements GoogleIntegrationProvider {
  private readonly config: SheetsConfig;

  constructor(config: SheetsConfig) {
    this.config = config;
  }

  private getClient() {
    const auth = new google.auth.GoogleAuth({
      credentials: this.config.credentials,
      scopes: ["https://www.googleapis.com/auth/spreadsheets"],
    });
    return google.sheets({ version: "v4", auth });
  }

  async syncReservation(
    reservation: Reservation,
    customerName: string,
    customerPhone: string,
  ): Promise<SyncReservationResult> {
    const sheets = this.getClient();
    const sheetName = this.config.sheet_name ?? "Reservas";

    const row = [
      reservation.id,
      formatLocal(new Date(reservation.starts_at), this.config.timezone, "dd/MM/yyyy"),
      formatLocal(new Date(reservation.starts_at), this.config.timezone, "HH:mm"),
      formatLocal(new Date(reservation.ends_at), this.config.timezone, "HH:mm"),
      customerName,
      customerPhone,
      reservation.status,
      reservation.source,
      new Date().toISOString(),
    ];

    try {
      const response = await sheets.spreadsheets.values.append({
        spreadsheetId: this.config.spreadsheet_id,
        range: `${sheetName}!A:I`,
        valueInputOption: "RAW",
        requestBody: { values: [row] },
      });

      // Use updatedRange as external ID (idempotency key for future updates)
      const updatedRange = response.data.updates?.updatedRange ?? "";
      return { externalId: updatedRange };
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      throw new IntegrationError("google_sheets", message);
    }
  }

  async deleteReservation(_externalId: string): Promise<void> {
    // Sheets rows are soft-deleted by status update rather than row removal
    // Full implementation would locate the row by reservation ID and update status column
  }

  async ensureHeaders(): Promise<void> {
    const sheets = this.getClient();
    const sheetName = this.config.sheet_name ?? "Reservas";

    const headers = [
      ["ID", "Fecha", "Hora Inicio", "Hora Fin", "Cliente", "Teléfono", "Estado", "Origen", "Creado"],
    ];

    try {
      const res = await sheets.spreadsheets.values.get({
        spreadsheetId: this.config.spreadsheet_id,
        range: `${sheetName}!A1:I1`,
      });

      if (!res.data.values?.length) {
        await sheets.spreadsheets.values.update({
          spreadsheetId: this.config.spreadsheet_id,
          range: `${sheetName}!A1:I1`,
          valueInputOption: "RAW",
          requestBody: { values: headers },
        });
      }
    } catch {
      // Non-critical: headers setup is best-effort
    }
  }
}
