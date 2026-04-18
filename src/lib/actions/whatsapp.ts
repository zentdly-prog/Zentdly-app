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

export async function getEvolutionQR(tenantId: string): Promise<{ qr?: string; connected?: boolean; error?: string }> {
  try {
    const db = createServerClient();
    const { data: config } = await db
      .from("whatsapp_config")
      .select("evolution_api_url, evolution_api_key, evolution_instance_name")
      .eq("tenant_id", tenantId)
      .single();

    if (!config?.evolution_api_url || !config?.evolution_api_key || !config?.evolution_instance_name) {
      return { error: "Guardá la URL, API Key e Instance Name antes de generar el QR." };
    }

    const baseUrl = config.evolution_api_url.replace(/\/$/, "");
    const instanceName = config.evolution_instance_name;
    const apiKey = config.evolution_api_key;

    // Check if instance already exists and is connected
    const statusRes = await fetch(`${baseUrl}/instance/fetchInstances?instanceName=${instanceName}`, {
      headers: { "apikey": apiKey },
    }).catch(() => null);

    if (statusRes?.ok) {
      const instances = await statusRes.json().catch(() => []);
      const list = Array.isArray(instances) ? instances : [instances];
      const existing = list.find((i: { instance?: { instanceName?: string; state?: string } }) =>
        i?.instance?.instanceName === instanceName
      );
      if (existing?.instance?.state === "open") {
        return { connected: true };
      }
    }

    // Create instance (idempotent — OK if already exists)
    await fetch(`${baseUrl}/instance/create`, {
      method: "POST",
      headers: { "apikey": apiKey, "Content-Type": "application/json" },
      body: JSON.stringify({ instanceName, qrcode: true, integration: "WHATSAPP-BAILEYS" }),
    }).catch(() => null);

    // Get QR code
    const res = await fetch(`${baseUrl}/instance/connect/${instanceName}`, {
      headers: { "apikey": apiKey },
    });

    if (!res.ok) return { error: `Evolution API respondió con error ${res.status}. Verificá que el servidor esté corriendo.` };
    const json = await res.json();
    const qr = json?.base64 ?? json?.qrcode?.base64 ?? json?.data?.qrcode ?? json?.code;

    if (!qr) return { error: "No se pudo obtener el QR. La instancia puede estar iniciando, intentá de nuevo en unos segundos." };
    return { qr };
  } catch (e) {
    return { error: e instanceof Error ? e.message : "Error de conexión con Evolution API." };
  }
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
