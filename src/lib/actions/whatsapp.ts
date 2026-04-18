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

const EVOLUTION_URL = "https://evolution-api-6ufp.onrender.com";
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
    const statusRes = await fetch(
      `${EVOLUTION_URL}/instance/fetchInstances?instanceName=${instanceName}`,
      { headers: { apikey: EVOLUTION_KEY } }
    ).catch(() => null);

    if (statusRes?.ok) {
      const list = await statusRes.json().catch(() => []);
      const instances = Array.isArray(list) ? list : [list];
      const found = instances.find(
        (i: { instance?: { instanceName?: string; state?: string } }) =>
          i?.instance?.instanceName === instanceName
      );
      if (found?.instance?.state === "open") return { connected: true };
    }

    // Create instance (idempotent)
    await fetch(`${EVOLUTION_URL}/instance/create`, {
      method: "POST",
      headers: { apikey: EVOLUTION_KEY, "Content-Type": "application/json" },
      body: JSON.stringify({ instanceName, qrcode: true, integration: "WHATSAPP-BAILEYS" }),
    }).catch(() => null);

    // Get QR
    const res = await fetch(`${EVOLUTION_URL}/instance/connect/${instanceName}`, {
      headers: { apikey: EVOLUTION_KEY },
    });

    if (!res.ok)
      return {
        error: `El servidor de Evolution respondió con error ${res.status}. Puede estar iniciando, intentá en unos segundos.`,
      };

    const json = await res.json();
    const qr = json?.base64 ?? json?.qrcode?.base64 ?? json?.data?.qrcode ?? json?.code;

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
