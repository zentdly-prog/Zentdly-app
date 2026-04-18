"use server";

import { createServerClient } from "@/infrastructure/supabase/server";
import { revalidatePath } from "next/cache";
import { z } from "zod";

const WhatsAppConfigSchema = z.object({
  tenant_id: z.string().uuid(),
  provider: z.enum(["evolution", "meta"]),
  evolution_api_url: z.string().optional(),
  evolution_api_key: z.string().optional(),
  evolution_instance_name: z.string().optional(),
  meta_phone_number_id: z.string().optional(),
  meta_access_token: z.string().optional(),
  meta_verify_token: z.string().optional(),
  meta_app_secret: z.string().optional(),
  meta_business_id: z.string().optional(),
});

export async function getWhatsAppConfig(tenantId: string) {
  try {
    const db = createServerClient();
    const { data } = await db
      .from("whatsapp_config")
      .select("*")
      .eq("tenant_id", tenantId)
      .single();
    return data;
  } catch {
    return null;
  }
}

export async function saveWhatsAppConfig(_prev: unknown, formData: FormData) {
  const raw = Object.fromEntries(formData.entries());
  const parsed = WhatsAppConfigSchema.safeParse(raw);
  if (!parsed.success) return { error: "Datos inválidos." };

  const db = createServerClient();
  const { error } = await db
    .from("whatsapp_config")
    .upsert({ ...parsed.data, updated_at: new Date().toISOString() }, { onConflict: "tenant_id" });

  if (error) return { error: error.message };
  revalidatePath(`/tenants/${parsed.data.tenant_id}/whatsapp`);
  return { ok: true };
}

const EVOLUTION_URL = "https://evolution-api-production-be7b.up.railway.app";
const EVOLUTION_KEY = "zentdly-evolution-key-2024";

export async function connectEvolutionWhatsApp(
  tenantId: string
): Promise<{ qr?: string; connected?: boolean; error?: string }> {
  try {
    const db = createServerClient();

    // Get tenant slug to use as instance name
    const { data: tenant } = await db
      .from("tenants")
      .select("slug")
      .eq("id", tenantId)
      .single();

    if (!tenant?.slug) return { error: "No se encontró el negocio." };

    const instanceName = tenant.slug;

    // Upsert whatsapp_config so it's always in sync
    await db.from("whatsapp_config").upsert(
      {
        tenant_id: tenantId,
        provider: "evolution",
        evolution_api_url: EVOLUTION_URL,
        evolution_api_key: EVOLUTION_KEY,
        evolution_instance_name: instanceName,
        updated_at: new Date().toISOString(),
      },
      { onConflict: "tenant_id" }
    );

    // Check if already connected
    const stateRes = await fetch(
      `${EVOLUTION_URL}/instance/connectionState/${instanceName}`,
      { headers: { apikey: EVOLUTION_KEY } }
    ).catch(() => null);

    if (stateRes?.ok) {
      const stateJson = await stateRes.json().catch(() => ({}));
      if (stateJson?.instance?.state === "open") return { connected: true };
    }

    // Try to create instance — v1.8.2 returns QR in create response
    const createRes = await fetch(`${EVOLUTION_URL}/instance/create`, {
      method: "POST",
      headers: { apikey: EVOLUTION_KEY, "Content-Type": "application/json" },
      body: JSON.stringify({ instanceName, qrcode: true, integration: "WHATSAPP-BAILEYS" }),
    }).catch(() => null);

    if (createRes?.ok) {
      const json = await createRes.json();
      const qr = json?.qrcode?.base64 ?? json?.base64 ?? json?.qrcode?.code;
      if (qr) return { qr };
    }

    // Instance already exists — fetch QR from connect endpoint
    const connectRes = await fetch(`${EVOLUTION_URL}/instance/connect/${instanceName}`, {
      headers: { apikey: EVOLUTION_KEY },
    }).catch(() => null);

    if (!connectRes?.ok)
      return {
        error: `No se pudo obtener el QR (error ${connectRes?.status ?? "desconocido"}). Intentá de nuevo en unos segundos.`,
      };

    const connectJson = await connectRes.json();
    const qr = connectJson?.base64 ?? connectJson?.qrcode?.base64 ?? connectJson?.code;

    if (!qr)
      return {
        error: "El servidor está iniciando. Esperá unos segundos y volvé a intentar.",
      };

    return { qr };
  } catch (e) {
    return { error: e instanceof Error ? e.message : "Error de conexión con Evolution API." };
  }
}

export async function getEvolutionQR(tenantId: string): Promise<{ qr?: string; connected?: boolean; error?: string }> {
  return connectEvolutionWhatsApp(tenantId);
}

export async function saveBotPrompt(_prev: unknown, formData: FormData) {
  const tenantId = formData.get("tenant_id") as string;
  const botPrompt = formData.get("bot_prompt") as string;

  const db = createServerClient();
  const { error } = await db
    .from("tenants")
    .update({ bot_prompt: botPrompt })
    .eq("id", tenantId);

  if (error) return { error: error.message };
  revalidatePath(`/tenants/${tenantId}/bot`);
  return { ok: true };
}
