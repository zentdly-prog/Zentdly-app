"use server";

import { createServerClient } from "@/infrastructure/supabase/server";
import { revalidatePath } from "next/cache";
import { z } from "zod";

const CourtUnitSchema = z.object({
  id: z.string().optional(),
  name: z.string().min(1),
  has_roof: z.boolean().optional(),
  synthetic_grass: z.boolean().optional(),
  acrylic: z.boolean().optional(),
  description: z.string().optional().nullable(),
  active: z.boolean().optional(),
});

const CourtTypeSchema = z.object({
  tenant_id: z.string().uuid(),
  sport_name: z.string().min(1),
  slot_duration_minutes: z.coerce.number().int().positive(),
  open_time: z.string().regex(/^\d{2}:\d{2}$/),
  close_time: z.string().regex(/^\d{2}:\d{2}$/),
  quantity: z.coerce.number().int().positive(),
  price_per_slot: z.preprocess(
    (value) => value === "" ? undefined : value,
    z.coerce.number().optional(),
  ),
  description: z.string().optional(),
  days_of_week: z.string().optional(),
});

const UpdateCourtTypeSchema = CourtTypeSchema.extend({
  id: z.string().uuid(),
});

type CourtTypeInput = z.infer<typeof CourtTypeSchema>;
type CourtUnitInput = z.infer<typeof CourtUnitSchema>;

export async function getCourtTypes(tenantId: string) {
  try {
    const db = createServerClient();
    const { data } = await db
      .from("court_types")
      .select("*")
      .eq("tenant_id", tenantId)
      .order("created_at");
    return data ?? [];
  } catch {
    return [];
  }
}

export async function createCourtType(_prev: unknown, formData: FormData) {
  const raw = Object.fromEntries(formData.entries());
  const parsed = CourtTypeSchema.safeParse(raw);
  if (!parsed.success) return { error: "Datos inválidos: " + JSON.stringify(parsed.error.issues) };

  const payload = parseCourtTypePayload(parsed.data, formData);
  if (!payload.success) return { error: payload.error };

  let db;
  try { db = createServerClient(); } catch { return { error: "Faltan variables de entorno de Supabase." }; }

  const { error } = await db.from("court_types").insert({
    ...payload.data.base,
    description: payload.data.description,
    court_units: payload.data.court_units,
  });

  if (error?.code === "42703" || error?.message.includes("court_units") || error?.message.includes("description")) {
    const { error: fallbackError } = await db.from("court_types").insert(payload.data.base);
    if (fallbackError) return { error: fallbackError.message };
    revalidatePath(`/tenants/${parsed.data.tenant_id}/courts`);
    return {
      ok: true,
      warning: "La cancha se guardó sin detalles físicos porque falta aplicar la migración de court_units.",
    };
  }

  if (error) return { error: error.message };
  revalidatePath(`/tenants/${parsed.data.tenant_id}/courts`);
  return { ok: true };
}

export async function updateCourtType(_prev: unknown, formData: FormData) {
  const raw = Object.fromEntries(formData.entries());
  const parsed = UpdateCourtTypeSchema.safeParse(raw);
  if (!parsed.success) return { error: "Datos inválidos: " + JSON.stringify(parsed.error.issues) };

  const payload = parseCourtTypePayload(parsed.data, formData);
  if (!payload.success) return { error: payload.error };

  let db;
  try { db = createServerClient(); } catch { return { error: "Faltan variables de entorno de Supabase." }; }

  const { error } = await db
    .from("court_types")
    .update({
      ...payload.data.base,
      description: payload.data.description,
      court_units: payload.data.court_units,
    })
    .eq("id", parsed.data.id)
    .eq("tenant_id", parsed.data.tenant_id);

  if (error?.code === "42703" || error?.message.includes("court_units") || error?.message.includes("description")) {
    const { error: fallbackError } = await db
      .from("court_types")
      .update(payload.data.base)
      .eq("id", parsed.data.id)
      .eq("tenant_id", parsed.data.tenant_id);

    if (fallbackError) return { error: fallbackError.message };
    revalidatePath(`/tenants/${parsed.data.tenant_id}/courts`);
    return {
      ok: true,
      warning: "La cancha se actualizó sin detalles físicos porque falta aplicar la migración de court_units.",
    };
  }

  if (error) return { error: error.message };
  revalidatePath(`/tenants/${parsed.data.tenant_id}/courts`);
  return { ok: true };
}

function parseCourtTypePayload(input: CourtTypeInput, formData: FormData) {
  const daysRaw = formData.getAll("days_of_week").map(Number);
  const days = daysRaw.length > 0 ? daysRaw : [1, 2, 3, 4, 5, 6, 0];
  const unitsParsed = parseCourtUnits(formData.get("court_units"));

  if (!unitsParsed.success) return unitsParsed;

  const activeUnits = unitsParsed.data.filter((unit) => unit.active !== false);

  return {
    success: true as const,
    data: {
      base: {
        tenant_id: input.tenant_id,
        sport_name: input.sport_name,
        slot_duration_minutes: input.slot_duration_minutes,
        open_time: input.open_time,
        close_time: input.close_time,
        quantity: Math.max(1, activeUnits.length || input.quantity),
        days_of_week: days,
        price_per_slot: input.price_per_slot ?? null,
      },
      description: input.description?.trim() || null,
      court_units: unitsParsed.data,
    },
  };
}

function parseCourtUnits(rawUnits: FormDataEntryValue | null) {
  if (typeof rawUnits !== "string" || !rawUnits.trim()) {
    return { success: true as const, data: [] };
  }

  try {
    const parsed = z.array(CourtUnitSchema).safeParse(JSON.parse(rawUnits));
    if (!parsed.success) {
      return { success: false as const, error: "Datos inválidos en la lista de canchas." };
    }

    const units: CourtUnitInput[] = parsed.data
      .map((unit, index) => ({
        id: unit.id || `court-${index + 1}`,
        name: unit.name.trim(),
        has_roof: unit.has_roof,
        synthetic_grass: unit.synthetic_grass,
        acrylic: unit.acrylic,
        description: unit.description?.trim() || null,
        active: unit.active !== false,
      }))
      .filter((unit) => unit.name);

    if (units.length === 0) {
      return { success: false as const, error: "Cargá al menos una cancha." };
    }

    return { success: true as const, data: units };
  } catch {
    return { success: false as const, error: "No pude leer la lista de canchas." };
  }
}

export async function deleteCourtType(_prev: unknown, formData: FormData) {
  const id = formData.get("id") as string;
  const tenantId = formData.get("tenant_id") as string;

  let db;
  try { db = createServerClient(); } catch { return { error: "Faltan variables de entorno de Supabase." }; }
  const { error } = await db.from("court_types").delete().eq("id", id);
  if (error) return { error: error.message };

  revalidatePath(`/tenants/${tenantId}/courts`);
  return { ok: true };
}

export async function toggleCourtType(_prev: unknown, formData: FormData) {
  const id = formData.get("id") as string;
  const tenantId = formData.get("tenant_id") as string;
  const active = formData.get("active") === "true";

  const db = createServerClient();
  await db.from("court_types").update({ active: !active }).eq("id", id);
  revalidatePath(`/tenants/${tenantId}/courts`);
  return { ok: true };
}
