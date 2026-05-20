import { scrypt, randomBytes, timingSafeEqual } from "node:crypto";
import { promisify } from "node:util";
import { createServerClient } from "@/infrastructure/supabase/server";
import type { PanelRole } from "@/lib/siteAuth";

const scryptAsync = promisify(scrypt);
const KEYLEN = 64;

export interface PanelUserRecord {
  id: string;
  username: string;
  role: PanelRole;
  tenant_id: string | null;
  created_at: string;
  tenants?: { name: string } | { name: string }[] | null;
}

async function hashPassword(password: string, salt: string): Promise<string> {
  const derived = (await scryptAsync(password, salt, KEYLEN)) as Buffer;
  return derived.toString("hex");
}

export async function makePasswordHash(password: string): Promise<{ hash: string; salt: string }> {
  const salt = randomBytes(16).toString("hex");
  const hash = await hashPassword(password, salt);
  return { hash, salt };
}

export async function verifyPassword(password: string, hash: string, salt: string): Promise<boolean> {
  const candidate = await hashPassword(password, salt);
  const a = Buffer.from(candidate, "hex");
  const b = Buffer.from(hash, "hex");
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

/** Returns the user's role+tenant if username+password match a panel_users row, else null. */
export async function authenticatePanelUser(
  username: string,
  password: string,
): Promise<{ role: PanelRole; username: string; tenantId: string | null } | null> {
  try {
    const db = createServerClient();
    const { data } = await db
      .from("panel_users")
      .select("username, password_hash, salt, role, tenant_id")
      .eq("username", username)
      .maybeSingle();

    if (!data) return null;
    const ok = await verifyPassword(password, data.password_hash as string, data.salt as string);
    if (!ok) return null;
    return {
      role: data.role as PanelRole,
      username: data.username as string,
      tenantId: (data.tenant_id as string | null) ?? null,
    };
  } catch {
    return null;
  }
}

export async function listPanelUsers(): Promise<PanelUserRecord[]> {
  try {
    const db = createServerClient();
    const { data } = await db
      .from("panel_users")
      .select("id, username, role, tenant_id, created_at, tenants(name)")
      .order("created_at", { ascending: true });
    return (data ?? []) as PanelUserRecord[];
  } catch {
    return [];
  }
}

export async function createPanelUser(
  username: string,
  password: string,
  role: PanelRole,
  tenantId: string | null,
): Promise<{ ok: true } | { ok: false; error: string }> {
  const cleanUser = username.trim().toLowerCase();
  if (!/^[a-z0-9_.-]{3,32}$/.test(cleanUser)) {
    return { ok: false, error: "Usuario inválido (3-32 caracteres: letras, números, . _ -)." };
  }
  if (password.length < 6) {
    return { ok: false, error: "La contraseña debe tener al menos 6 caracteres." };
  }
  if (role === "lite" && !tenantId) {
    return { ok: false, error: "Elegí a qué negocio pertenece el usuario lite." };
  }

  try {
    const db = createServerClient();
    const { hash, salt } = await makePasswordHash(password);
    const { error } = await db.from("panel_users").insert({
      username: cleanUser,
      password_hash: hash,
      salt,
      role,
      tenant_id: role === "lite" ? tenantId : null,
    });
    if (error) {
      if (error.code === "23505") return { ok: false, error: "Ese usuario ya existe." };
      return { ok: false, error: error.message };
    }
    return { ok: true };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : "Error al crear el usuario." };
  }
}

export async function deletePanelUser(id: string): Promise<{ ok: boolean; error?: string }> {
  try {
    const db = createServerClient();
    const { error } = await db.from("panel_users").delete().eq("id", id);
    if (error) return { ok: false, error: error.message };
    return { ok: true };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : "Error al borrar." };
  }
}
