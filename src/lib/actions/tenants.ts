"use server";

import { createServerClient } from "@/infrastructure/supabase/server";
import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { z } from "zod";

const optionalText = z.preprocess(
  (v) => (typeof v === "string" && v.trim() === "" ? null : v),
  z.string().optional().nullable(),
);

const TenantSchema = z.object({
  name: z.string().min(1),
  slug: z.string().optional(),
  timezone: z.string().default("America/Argentina/Buenos_Aires"),
  contact_name: optionalText,
  contact_phone: optionalText,
  contact_email: optionalText,
  address: optionalText,
  maps_url: optionalText,
  instagram: optionalText,
  website: optionalText,
  bank_alias: optionalText,
  bank_holder_name: optionalText,
  bank_name: optionalText,
});

/**
 * Turns a business name into a slug usable as an Evolution instance name.
 * Accents are folded rather than dropped so "Pádel Córdoba" becomes
 * "padel-cordoba" instead of "pdel-crdoba".
 */
function slugify(value: string): string {
  return value
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40);
}

async function uniqueSlug(db: ReturnType<typeof createServerClient>, base: string): Promise<string> {
  const seed = base || "negocio";
  const { data } = await db.from("tenants").select("slug").like("slug", `${seed}%`);
  const taken = new Set((data ?? []).map((row) => row.slug as string));
  if (!taken.has(seed)) return seed;
  for (let n = 2; n < 100; n++) {
    const candidate = `${seed}-${n}`;
    if (!taken.has(candidate)) return candidate;
  }
  return `${seed}-${Date.now().toString().slice(-5)}`;
}

export async function createTenant(_prev: unknown, formData: FormData) {
  const raw = Object.fromEntries(formData.entries());
  const parsed = TenantSchema.safeParse(raw);
  if (!parsed.success) {
    const campo = parsed.error.issues[0]?.path.join(".") ?? "los datos";
    return { error: `Revisá ${campo === "name" ? "el nombre del negocio" : campo}.` };
  }

  let db;
  try {
    db = createServerClient();
  } catch {
    return { error: "Faltan variables de entorno de Supabase. Configuralas en Vercel." };
  }

  // The slug doubles as the WhatsApp instance name, so it is derived from the
  // name instead of being typed by hand: a slug with spaces or accents used to
  // fail validation with an unhelpful message, or produce a broken instance.
  const requested = parsed.data.slug?.trim();
  const base = slugify(requested || parsed.data.name);
  const slug = await uniqueSlug(db, base);

  const { data, error } = await db
    .from("tenants")
    .insert({ ...parsed.data, slug })
    .select("id")
    .single();

  if (error) {
    if (error.code === "23505") return { error: "Ya existe un negocio con ese identificador. Probá con otro nombre." };
    return { error: error.message };
  }

  // Seed the rows the panel expects, so a new business is usable straight
  // away instead of silently falling back to defaults.
  await db.from("tenant_bot_policies").upsert(
    {
      tenant_id: data.id,
      cancellation_min_hours: 0,
      reschedule_min_hours: 0,
      requires_deposit: false,
      reservation_status_default: "confirmed",
      audio_message: "No puedo escuchar audios por acá. Escribime el día, horario y deporte y te ayudo.",
      human_handoff_message: "Te derivo con una persona del equipo para ayudarte con eso.",
    },
    { onConflict: "tenant_id" },
  );

  await db.from("whatsapp_config").upsert(
    {
      tenant_id: data.id,
      provider: "evolution",
      connected: true,
      evolution_instance_name: slug,
      updated_at: new Date().toISOString(),
    },
    { onConflict: "tenant_id" },
  );

  revalidatePath("/");
  redirect(`/tenants/${data.id}`);
}

export async function updateTenant(_prev: unknown, formData: FormData) {
  const id = formData.get("id") as string;
  const raw = Object.fromEntries(formData.entries());
  const parsed = TenantSchema.safeParse(raw);
  if (!parsed.success) return { error: "Datos inválidos." };

  let db;
  try {
    db = createServerClient();
  } catch {
    return { error: "Faltan variables de entorno de Supabase." };
  }

  const { error } = await db.from("tenants").update(parsed.data).eq("id", id);
  if (error) return { error: error.message };

  revalidatePath(`/tenants/${id}`);
  return { ok: true };
}

export async function getTenants() {
  try {
    const db = createServerClient();
    const { data } = await db
      .from("tenants")
      .select("id, name, slug, timezone, active, contact_name, contact_phone, address, bot_prompt")
      .order("created_at", { ascending: false });
    return data ?? [];
  } catch {
    return [];
  }
}

export async function getTenant(id: string) {
  try {
    const db = createServerClient();
    const { data } = await db
      .from("tenants")
      .select("*")
      .eq("id", id)
      .single();
    return data;
  } catch {
    return null;
  }
}

/**
 * Deletes a business and everything hanging off it.
 *
 * Reservations, customers, conversations, messages, policies and config all
 * cascade from tenants, so the row delete is enough on the database side. The
 * WhatsApp instance does not: it lives in Evolution, and leaving it behind
 * leaves an orphan holding a phone pairing and a webhook pointing here.
 */
export async function deleteTenant(_prev: unknown, formData: FormData) {
  const id = formData.get("tenant_id");
  const confirmName = String(formData.get("confirm_name") ?? "").trim();

  const parsedId = z.string().uuid().safeParse(id);
  if (!parsedId.success) return { error: "Negocio inválido." };

  const db = createServerClient();
  const { data: tenant } = await db
    .from("tenants")
    .select("name, slug")
    .eq("id", parsedId.data)
    .maybeSingle();

  if (!tenant) return { error: "No encontré ese negocio." };

  // Typing the name is the guard against deleting the wrong business: this
  // destroys every conversation and reservation it has, and cannot be undone.
  if (confirmName !== tenant.name) {
    return { error: `Para borrarlo, escribí exactamente el nombre: ${tenant.name}` };
  }

  const evolutionUrl = process.env.EVOLUTION_API_URL?.replace(/\/$/, "");
  const evolutionKey = process.env.EVOLUTION_API_KEY;
  if (evolutionUrl && evolutionKey && tenant.slug) {
    await fetch(`${evolutionUrl}/instance/logout/${tenant.slug}`, {
      method: "DELETE",
      headers: { apikey: evolutionKey },
    }).catch(() => null);
    await fetch(`${evolutionUrl}/instance/delete/${tenant.slug}`, {
      method: "DELETE",
      headers: { apikey: evolutionKey },
    }).catch(() => null);
  }

  const { error } = await db.from("tenants").delete().eq("id", parsedId.data);
  if (error) return { error: `No pude borrar el negocio: ${error.message}` };

  revalidatePath("/");
  return { ok: true, deleted: tenant.name };
}
