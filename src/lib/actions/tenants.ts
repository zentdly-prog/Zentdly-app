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
  slug: z.string().min(1).regex(/^[a-z0-9-]+$/),
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

export async function createTenant(_prev: unknown, formData: FormData) {
  const raw = Object.fromEntries(formData.entries());
  const parsed = TenantSchema.safeParse(raw);
  if (!parsed.success) return { error: "Datos inválidos." };

  let db;
  try {
    db = createServerClient();
  } catch {
    return { error: "Faltan variables de entorno de Supabase. Configurá NEXT_PUBLIC_SUPABASE_URL y SUPABASE_SERVICE_ROLE_KEY en Vercel." };
  }

  const { data, error } = await db
    .from("tenants")
    .insert(parsed.data)
    .select("id")
    .single();

  if (error) return { error: error.message };
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
