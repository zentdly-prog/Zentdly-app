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

export async function toggleForgetCommand(_prev: unknown, formData: FormData) {
  const tenantId = formData.get("tenant_id") as string;
  const enabled = formData.get("enabled") === "true";

  const parsed = z.string().uuid().safeParse(tenantId);
  if (!parsed.success) return { error: "Tenant inválido." };

  const db = createServerClient();
  const { error } = await db
    .from("whatsapp_config")
    .update({ forget_command_enabled: enabled, updated_at: new Date().toISOString() })
    .eq("tenant_id", tenantId);

  if (error) {
    const missingColumn =
      error.code === "42703" ||
      error.code === "PGRST204" ||
      /forget_command_enabled/.test(error.message ?? "");
    if (missingColumn) {
      return { error: "Falta correr la migración 010 en Supabase Studio (columna forget_command_enabled)." };
    }
    return { error: error.message };
  }
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

/**
 * Points an instance's webhook at this deployment. Must be called after the
 * instance is known to exist — a freshly created instance has no webhook, and
 * without one inbound WhatsApp messages never reach the app.
 */
async function ensureWebhook(
  evolutionUrl: string,
  evolutionKey: string,
  instanceName: string,
): Promise<boolean> {
  const appUrl = (process.env.APP_URL ?? "https://zentdly-three.vercel.app").replace(/\/$/, "");
  const body = JSON.stringify({
    webhook: {
      url: `${appUrl}/api/webhooks/whatsapp`,
      enabled: true,
      webhookByEvents: false,
      webhookBase64: false,
      events: ["MESSAGES_UPSERT"],
    },
  });

  // A just-created instance briefly rejects this with a 500, and a silent miss
  // means the new number never receives messages — so retry instead of hoping.
  for (let attempt = 0; attempt < 3; attempt++) {
    const res = await fetch(`${evolutionUrl}/webhook/set/${instanceName}`, {
      method: "POST",
      headers: { apikey: evolutionKey, "Content-Type": "application/json" },
      body,
    }).catch(() => null);

    if (res?.ok) return true;
    await new Promise((resolve) => setTimeout(resolve, 1500));
  }

  console.error(`[whatsapp] Could not set webhook for instance "${instanceName}"`);
  return false;
}

async function readInstanceState(
  evolutionUrl: string,
  evolutionKey: string,
  instanceName: string,
): Promise<string | null> {
  const res = await fetch(`${evolutionUrl}/instance/connectionState/${instanceName}`, {
    headers: { apikey: evolutionKey },
    cache: "no-store",
  }).catch(() => null);

  if (!res?.ok) return null; // 404 = instance does not exist, which is "not connected"
  const json = await res.json().catch(() => ({}));
  return (json?.instance?.state as string | undefined) ?? null;
}

/**
 * Unlinks the phone currently paired to an instance and confirms it actually
 * happened.
 *
 * A fire-and-forget logout is not enough: Evolution reports the socket state
 * asynchronously, so a follow-up "connect" can still see `open` and conclude a
 * phone is already linked — which is exactly what blocks pairing a new one.
 * So we wait for the state to leave `open`, and if it refuses to, we delete the
 * instance outright. A deleted instance is recreated cleanly on the next
 * connect, which is always safe here because the pairing is being discarded.
 */
async function unlinkInstance(
  evolutionUrl: string,
  evolutionKey: string,
  instanceName: string,
): Promise<boolean> {
  await fetch(`${evolutionUrl}/instance/logout/${instanceName}`, {
    method: "DELETE",
    headers: { apikey: evolutionKey },
  }).catch(() => null);

  // Give the socket a couple of seconds to actually drop.
  for (let attempt = 0; attempt < 3; attempt++) {
    const state = await readInstanceState(evolutionUrl, evolutionKey, instanceName);
    if (state !== "open") return true;
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }

  // Still reporting `open`. That state is not trustworthy on its own: Evolution
  // keeps it in its own database, so a dead socket — or a transient outage of
  // that database — leaves it stale forever. Discard the instance instead;
  // it is recreated cleanly when the next QR is requested.
  for (let attempt = 0; attempt < 2; attempt++) {
    const deleteRes = await fetch(`${evolutionUrl}/instance/delete/${instanceName}`, {
      method: "DELETE",
      headers: { apikey: evolutionKey },
    }).catch(() => null);

    if (deleteRes?.ok) return true;
    if ((await readInstanceState(evolutionUrl, evolutionKey, instanceName)) !== "open") return true;
    await new Promise((resolve) => setTimeout(resolve, 1500));
  }

  return false;
}

export async function connectEvolutionWhatsApp(
  tenantId: string,
  options?: { forceNew?: boolean },
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

    // 1. Check connection state first.
    // When the operator explicitly asked to pair a different phone, skip this
    // short-circuit and drop the current pairing instead — otherwise an already
    // linked number makes it impossible to link a new one.
    if (options?.forceNew) {
      // Best effort: even if Evolution still claims the number is linked, keep
      // going. What matters is whether we can hand back a QR to scan, and the
      // create step below discards the stale instance if it comes to that.
      await unlinkInstance(evolutionUrl, evolutionKey, instanceName);
    } else {
      const state = await readInstanceState(evolutionUrl, evolutionKey, instanceName);
      if (state === "open") {
        await ensureWebhook(evolutionUrl, evolutionKey, instanceName);
        return { connected: true };
      }
    }

    // 2. Instance exists but disconnected — get a fresh QR via /instance/connect
    const connectRes = await fetch(`${evolutionUrl}/instance/connect/${instanceName}`, {
      headers: { apikey: evolutionKey },
    }).catch(() => null);

    if (connectRes?.ok) {
      const connectJson = await connectRes.json().catch(() => ({}));
      // Already connected (race condition). Never report this when the operator
      // asked for a new pairing — that is the dead end we are fixing.
      if (!options?.forceNew && connectJson?.instance?.state === "open") {
        await ensureWebhook(evolutionUrl, evolutionKey, instanceName);
        return { connected: true };
      }
      const qr = connectJson?.base64 ?? connectJson?.qrcode?.base64 ?? connectJson?.code ?? connectJson?.qrcode?.code;
      if (qr) {
        await ensureWebhook(evolutionUrl, evolutionKey, instanceName);
        return { qr };
      }
    }

    // 2b. Pairing a new phone but the old instance is still holding on —
    // discard it so the create below starts from a clean slate.
    if (options?.forceNew) {
      await fetch(`${evolutionUrl}/instance/delete/${instanceName}`, {
        method: "DELETE",
        headers: { apikey: evolutionKey },
      }).catch(() => null);
    }

    // 3. Instance doesn't exist yet (or was just discarded) — create it
    const createRes = await fetch(`${evolutionUrl}/instance/create`, {
      method: "POST",
      headers: { apikey: evolutionKey, "Content-Type": "application/json" },
      body: JSON.stringify({ instanceName, qrcode: true, integration: "WHATSAPP-BAILEYS" }),
    }).catch(() => null);

    if (createRes?.ok) {
      const json = await createRes.json().catch(() => ({}));
      const qr = json?.qrcode?.base64 ?? json?.base64 ?? json?.qrcode?.code;
      if (qr) {
        // Must run after creation: a recreated instance starts with no webhook,
        // so skipping this would silently stop inbound messages.
        await ensureWebhook(evolutionUrl, evolutionKey, instanceName);
        return { qr };
      }
    }

    return {
      error:
        "No se pudo obtener el QR. El servicio de WhatsApp puede estar reiniciándose — esperá un minuto y probá de nuevo.",
    };
  } catch (e) {
    return { error: e instanceof Error ? e.message : "Error de conexión con Evolution API." };
  }
}

export async function getEvolutionQR(tenantId: string): Promise<{ qr?: string; connected?: boolean; error?: string }> {
  return connectEvolutionWhatsApp(tenantId);
}

export async function checkEvolutionConnection(tenantId: string): Promise<{ connected: boolean; state?: string }> {
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
    const state = json?.instance?.state as string | undefined;
    return { connected: state === "open", state };
  } catch {
    return { connected: false };
  }
}

export async function disconnectEvolutionWhatsApp(tenantId: string): Promise<{ ok: boolean; error?: string }> {
  try {
    const db = createServerClient();
    const { url: evolutionUrl, key: evolutionKey } = getEvolutionConfig();
    const { data: tenant } = await db
      .from("tenants")
      .select("slug")
      .eq("id", tenantId)
      .single();

    if (!tenant?.slug) return { ok: false, error: "No se encontró el negocio." };

    // Verified unlink: confirms the socket actually dropped, so a follow-up
    // pairing isn't rejected with "already connected".
    const unlinked = await unlinkInstance(evolutionUrl, evolutionKey, tenant.slug);
    if (!unlinked) {
      return {
        ok: false,
        error:
          "No se pudo desvincular el número. El servicio de WhatsApp puede estar reiniciándose — esperá un minuto y probá de nuevo.",
      };
    }

    revalidatePath(`/tenants/${tenantId}/whatsapp`);
    return { ok: true };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : "Error al desconectar." };
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
