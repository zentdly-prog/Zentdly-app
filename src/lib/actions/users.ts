"use server";

import { revalidatePath } from "next/cache";
import { getSession } from "@/lib/session";
import { createPanelUser, deletePanelUser, type PanelUserRecord, listPanelUsers } from "@/lib/panelUsers";
import type { PanelRole } from "@/lib/siteAuth";

export async function getPanelUsersForAdmin(): Promise<PanelUserRecord[]> {
  const session = await getSession();
  if (!session.valid || session.role !== "admin") return [];
  return listPanelUsers();
}

export async function createPanelUserAction(_prev: unknown, formData: FormData) {
  const session = await getSession();
  if (!session.valid || session.role !== "admin") {
    return { error: "No tenés permisos para crear usuarios." };
  }

  const username = String(formData.get("username") ?? "");
  const password = String(formData.get("password") ?? "");
  const roleRaw = String(formData.get("role") ?? "lite");
  const role: PanelRole = roleRaw === "admin" ? "admin" : "lite";
  const tenantIdRaw = String(formData.get("tenant_id") ?? "");
  const tenantId = tenantIdRaw && tenantIdRaw !== "all" ? tenantIdRaw : null;

  const result = await createPanelUser(username, password, role, tenantId);
  if (!result.ok) return { error: result.error };

  revalidatePath("/usuarios");
  return { ok: true };
}

export async function deletePanelUserAction(formData: FormData) {
  const session = await getSession();
  if (!session.valid || session.role !== "admin") return;

  const id = String(formData.get("id") ?? "");
  if (!id) return;
  await deletePanelUser(id);
  revalidatePath("/usuarios");
}
