"use server";

import { createServerClient } from "@/infrastructure/supabase/server";
import type { SupabaseClient } from "@supabase/supabase-js";
import { revalidatePath } from "next/cache";
import { z } from "zod";

const BotPolicySchema = z.object({
  tenant_id: z.string().uuid(),
  cancellation_min_hours: z.coerce.number().int().min(0),
  reschedule_min_hours: z.coerce.number().int().min(0),
  requires_deposit: z.coerce.boolean().optional(),
  deposit_amount: z.preprocess((value) => value === "" ? null : value, z.coerce.number().nullable().optional()),
  deposit_percentage: z.preprocess((value) => value === "" ? null : value, z.coerce.number().int().min(0).max(100).nullable().optional()),
  reservation_status_default: z.enum(["pending", "confirmed"]),
  audio_message: z.string().min(1),
  human_handoff_message: z.string().min(1),
});

export type BotPolicy = z.infer<typeof BotPolicySchema>;

const DEFAULT_POLICY: Omit<BotPolicy, "tenant_id"> = {
  cancellation_min_hours: 0,
  reschedule_min_hours: 0,
  requires_deposit: false,
  deposit_amount: null,
  deposit_percentage: null,
  reservation_status_default: "confirmed",
  audio_message: "No puedo escuchar audios por acá. Escribime el día, horario y deporte y te ayudo.",
  human_handoff_message: "Te derivo con una persona del equipo para ayudarte con eso.",
};

export async function getBotPolicy(tenantId: string, client?: SupabaseClient): Promise<BotPolicy> {
  try {
    const db = client ?? createServerClient();
    const { data, error } = await db
      .from("tenant_bot_policies")
      .select("tenant_id, cancellation_min_hours, reschedule_min_hours, requires_deposit, deposit_amount, deposit_percentage, reservation_status_default, audio_message, human_handoff_message")
      .eq("tenant_id", tenantId)
      .maybeSingle();

    if (error || !data) return { tenant_id: tenantId, ...DEFAULT_POLICY };
    return { ...DEFAULT_POLICY, ...data, tenant_id: tenantId } as BotPolicy;
  } catch {
    return { tenant_id: tenantId, ...DEFAULT_POLICY };
  }
}

export async function saveBotPolicy(_prev: unknown, formData: FormData) {
  const raw = Object.fromEntries(formData.entries());
  const parsed = BotPolicySchema.safeParse({
    ...raw,
    requires_deposit: formData.get("requires_deposit") === "on",
  });

  if (!parsed.success) return { error: "Datos inválidos." };

  const db = createServerClient();
  const { error } = await db.from("tenant_bot_policies").upsert(
    {
      ...parsed.data,
      updated_at: new Date().toISOString(),
    },
    { onConflict: "tenant_id" },
  );

  if (error) return { error: error.message };
  revalidatePath(`/tenants/${parsed.data.tenant_id}/policies`);
  return { ok: true };
}
