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

export async function toggleWhatsAppBot(_prev: unknown, formData: FormData) {
  const tenantId = formData.get("tenant_id") as string;
  const enabled = formData.get("enabled") === "true";

  const parsed = z.string().uuid().safeParse(tenantId);
  if (!parsed.success) return { error: "Tenant inválido." };

  const db = createServerClient();
  const { error } = await db
    .from("whatsapp_config")
    .update({ connected: enabled, updated_at: new Date().toISOString() })
    .eq("tenant_id", tenantId);

  if (error) return { error: error.message };
  revalidatePath(`/tenants/${tenantId}/whatsapp`);
  return { ok: true, enabled };
}

function getEvolutionConfig() {
  const url = process.env.EVOLUTION_API_URL;
  const key = process.env.EVOLUTION_API_KEY;

  if (!url || !key) {
    throw new Error("Faltan EVOLUTION_API_URL o EVOLUTION_API_KEY.");
  }

  return { url: url.replace(/\/$/, ""), key };
}

export async function connectEvolutionWhatsApp(
  tenantId: string
): Promise<{ qr?: string; connected?: boolean; error?: string }> {
  try {
    const db = createServerClient();
    const { url: evolutionUrl, key: evolutionKey } = getEvolutionConfig();

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
        connected: true,
        evolution_api_url: evolutionUrl,
        evolution_api_key: evolutionKey,
        evolution_instance_name: instanceName,
        updated_at: new Date().toISOString(),
      },
      { onConflict: "tenant_id" }
    );

    // Configure Evolution webhook to point to our endpoint
    const webhookUrl = `${process.env.APP_URL}/api/webhooks/whatsapp`;
    await fetch(`${evolutionUrl}/webhook/set/${instanceName}`, {
      method: "POST",
      headers: { apikey: evolutionKey, "Content-Type": "application/json" },
      body: JSON.stringify({
        webhook: {
          url: webhookUrl,
          enabled: true,
          webhookByEvents: false,
          webhookBase64: false,
          events: ["MESSAGES_UPSERT"],
        },
      }),
    }).catch(() => null);

    // 1. Check connection state first
    const stateRes = await fetch(
      `${evolutionUrl}/instance/connectionState/${instanceName}`,
      { headers: { apikey: evolutionKey } }
    ).catch(() => null);

    const stateJson = stateRes?.ok ? await stateRes.json().catch(() => ({})) : {};
    if (stateJson?.instance?.state === "open") return { connected: true };

    // 2. Instance exists but disconnected — get a fresh QR via /instance/connect
    const connectRes = await fetch(`${evolutionUrl}/instance/connect/${instanceName}`, {
      headers: { apikey: evolutionKey },
    }).catch(() => null);

    if (connectRes?.ok) {
      const connectJson = await connectRes.json().catch(() => ({}));
      // Already connected (race condition)
      if (connectJson?.instance?.state === "open") return { connected: true };
      const qr = connectJson?.base64 ?? connectJson?.qrcode?.base64 ?? connectJson?.code ?? connectJson?.qrcode?.code;
      if (qr) return { qr };
    }

    // 3. Instance doesn't exist yet — create it
    const createRes = await fetch(`${evolutionUrl}/instance/create`, {
      method: "POST",
      headers: { apikey: evolutionKey, "Content-Type": "application/json" },
      body: JSON.stringify({ instanceName, qrcode: true, integration: "WHATSAPP-BAILEYS" }),
    }).catch(() => null);

    if (createRes?.ok) {
      const json = await createRes.json().catch(() => ({}));
      const qr = json?.qrcode?.base64 ?? json?.base64 ?? json?.qrcode?.code;
      if (qr) return { qr };
    }

    return { error: "No se pudo obtener el QR. Intentá de nuevo en unos segundos." };
  } catch (e) {
    return { error: e instanceof Error ? e.message : "Error de conexión con Evolution API." };
  }
}

export async function getEvolutionQR(tenantId: string): Promise<{ qr?: string; connected?: boolean; error?: string }> {
  return connectEvolutionWhatsApp(tenantId);
}

export async function checkEvolutionConnection(tenantId: string): Promise<{ connected: boolean }> {
  try {
    const db = createServerClient();
    const { url: evolutionUrl, key: evolutionKey } = getEvolutionConfig();
    const { data: tenant } = await db
      .from("tenants")
      .select("slug")
      .eq("id", tenantId)
      .single();

    if (!tenant?.slug) return { connected: false };

    const res = await fetch(
      `${evolutionUrl}/instance/connectionState/${tenant.slug}`,
      { headers: { apikey: evolutionKey }, cache: "no-store" }
    ).catch(() => null);

    if (!res?.ok) return { connected: false };
    const json = await res.json().catch(() => ({}));
    return { connected: json?.instance?.state === "open" };
  } catch {
    return { connected: false };
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
