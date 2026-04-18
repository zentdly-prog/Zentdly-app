"use server";

import { createServerClient } from "@/infrastructure/supabase/server";
import { revalidatePath } from "next/cache";

export async function getGoogleConfig(tenantId: string) {
  try {
    const db = createServerClient();
    const { data } = await db
      .from("google_config")
      .select("*")
      .eq("tenant_id", tenantId)
      .single();
    return data;
  } catch {
    return null;
  }
}

export async function saveGoogleConfig(_prev: unknown, formData: FormData) {
  const tenantId = formData.get("tenant_id") as string;
  const serviceAccountRaw = formData.get("service_account") as string;
  const calendarId = (formData.get("calendar_id") as string).trim();
  const spreadsheetId = (formData.get("spreadsheet_id") as string).trim();
  const sheetName = (formData.get("sheet_name") as string).trim() || "Reservas";
  const calendarEnabled = formData.get("calendar_enabled") === "on";
  const sheetsEnabled = formData.get("sheets_enabled") === "on";

  // Parse & validate service account JSON
  let serviceAccount: Record<string, unknown> | null = null;
  if (serviceAccountRaw.trim()) {
    try {
      serviceAccount = JSON.parse(serviceAccountRaw);
      if (!serviceAccount?.client_email || !serviceAccount?.private_key) {
        return { error: "El JSON de la cuenta de servicio debe tener client_email y private_key." };
      }
    } catch {
      return { error: "El JSON de la cuenta de servicio no es válido." };
    }
  }

  const db = createServerClient();
  const { error } = await db.from("google_config").upsert(
    {
      tenant_id: tenantId,
      service_account: serviceAccount,
      calendar_id: calendarId,
      spreadsheet_id: spreadsheetId,
      sheet_name: sheetName,
      calendar_enabled: calendarEnabled,
      sheets_enabled: sheetsEnabled,
      updated_at: new Date().toISOString(),
    },
    { onConflict: "tenant_id" }
  );

  if (error) return { error: error.message };
  revalidatePath(`/tenants/${tenantId}/google`);
  return { ok: true };
}

export async function testGoogleConnection(tenantId: string): Promise<{ ok?: boolean; error?: string; calendarOk?: boolean; sheetsOk?: boolean }> {
  try {
    const config = await getGoogleConfig(tenantId);
    if (!config?.service_account) return { error: "No hay credenciales configuradas." };

    const { GoogleCalendarProvider } = await import("@/integrations/google/calendarProvider");
    const { GoogleSheetsProvider } = await import("@/integrations/google/sheetsProvider");

    const creds = {
      client_email: config.service_account.client_email as string,
      private_key: config.service_account.private_key as string,
    };

    let calendarOk = false;
    let sheetsOk = false;

    if (config.calendar_enabled && config.calendar_id) {
      try {
        const cal = new GoogleCalendarProvider({
          credentials: creds,
          calendar_id: config.calendar_id,
          timezone: "America/Argentina/Buenos_Aires",
        });
        // Try listing one event to verify access
        const { google } = await import("googleapis");
        const auth = new google.auth.GoogleAuth({
          credentials: creds,
          scopes: ["https://www.googleapis.com/auth/calendar"],
        });
        const calendar = google.calendar({ version: "v3", auth });
        await calendar.calendarList.get({ calendarId: config.calendar_id });
        calendarOk = true;
        void cal;
      } catch {
        calendarOk = false;
      }
    }

    if (config.sheets_enabled && config.spreadsheet_id) {
      try {
        const sheets = new GoogleSheetsProvider({
          credentials: creds,
          spreadsheet_id: config.spreadsheet_id,
          sheet_name: config.sheet_name,
          timezone: "America/Argentina/Buenos_Aires",
        });
        await sheets.ensureHeaders();
        sheetsOk = true;
      } catch {
        sheetsOk = false;
      }
    }

    return { ok: true, calendarOk, sheetsOk };
  } catch (e) {
    return { error: e instanceof Error ? e.message : "Error desconocido." };
  }
}
