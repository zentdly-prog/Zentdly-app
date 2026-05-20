"use client";

import { useActionState, useState } from "react";
import { createPanelUserAction, deletePanelUserAction } from "@/lib/actions/users";
import { SubmitButton } from "@/components/SubmitButton";
import { Alert } from "@/components/Alert";

type PanelUser = {
  id: string;
  username: string;
  role: "admin" | "lite";
  tenant_id: string | null;
  created_at: string;
  tenants?: { name: string } | { name: string }[] | null;
};

type TenantOption = { id: string; name: string };

function tenantName(u: PanelUser): string | null {
  const t = u.tenants;
  if (!t) return null;
  return Array.isArray(t) ? (t[0]?.name ?? null) : t.name;
}

export default function UsersClient({ users, tenants }: { users: PanelUser[]; tenants: TenantOption[] }) {
  const [state, action] = useActionState(createPanelUserAction, null);
  const [role, setRole] = useState<"lite" | "admin">("lite");

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-semibold text-gray-900">Usuarios del panel</h1>
        <p className="text-sm text-gray-500 mt-1">
          Los usuarios <strong>lite</strong> solo ven Calendario, Reservas y Conversaciones (para pausar chats). No pueden tocar configuración, canchas, políticas ni WhatsApp.
        </p>
      </div>

      <form action={action} className="bg-white rounded-xl border border-gray-200 p-6 space-y-4">
        <h2 className="text-sm font-semibold text-gray-900">Crear usuario</h2>
        {state?.error && <Alert type="error" message={state.error} />}
        {state?.ok && <Alert type="success" message="Usuario creado." />}

        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">Usuario</label>
            <input
              name="username"
              required
              placeholder="ej: recepcion"
              className="w-full px-3 py-2 border border-gray-300 rounded-lg text-sm text-gray-900 focus:outline-none focus:ring-2 focus:ring-green-500"
            />
          </div>
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">Contraseña</label>
            <input
              name="password"
              type="text"
              required
              minLength={6}
              placeholder="mín. 6 caracteres"
              className="w-full px-3 py-2 border border-gray-300 rounded-lg text-sm text-gray-900 focus:outline-none focus:ring-2 focus:ring-green-500"
            />
          </div>
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">Rol</label>
            <select
              name="role"
              value={role}
              onChange={(e) => setRole(e.target.value === "admin" ? "admin" : "lite")}
              className="w-full px-3 py-2 border border-gray-300 rounded-lg text-sm text-gray-900 focus:outline-none focus:ring-2 focus:ring-green-500"
            >
              <option value="lite">Lite (calendario, reservas, chats)</option>
              <option value="admin">Admin (acceso total)</option>
            </select>
          </div>
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">
              Negocio {role === "lite" && <span className="text-red-500">*</span>}
            </label>
            <select
              name="tenant_id"
              required={role === "lite"}
              disabled={role === "admin"}
              defaultValue=""
              className="w-full px-3 py-2 border border-gray-300 rounded-lg text-sm text-gray-900 focus:outline-none focus:ring-2 focus:ring-green-500 disabled:bg-gray-100 disabled:text-gray-400"
            >
              <option value="">{role === "admin" ? "Todos (admin)" : "Elegí un negocio…"}</option>
              {tenants.map((t) => (
                <option key={t.id} value={t.id}>{t.name}</option>
              ))}
            </select>
          </div>
        </div>

        <p className="text-xs text-gray-400">
          El usuario lite solo va a poder operar el negocio que elijas acá.
        </p>

        <div className="flex justify-end">
          <SubmitButton label="Crear usuario" />
        </div>
      </form>

      <div className="bg-white rounded-xl border border-gray-200 overflow-hidden">
        <div className="px-6 py-3 border-b border-gray-100 text-sm font-semibold text-gray-900">
          Usuarios ({users.length})
        </div>
        {users.length === 0 ? (
          <div className="p-6 text-sm text-gray-500">Todavía no creaste usuarios. El admin principal entra con las credenciales del entorno.</div>
        ) : (
          <div className="divide-y divide-gray-100">
            {users.map((u) => (
              <div key={u.id} className="px-6 py-3 flex items-center justify-between gap-4">
                <div>
                  <div className="text-sm font-medium text-gray-900">{u.username}</div>
                  <div className="text-xs text-gray-400 flex items-center gap-2 mt-0.5">
                    <span className={`inline-block px-1.5 py-0.5 rounded ${u.role === "admin" ? "bg-purple-100 text-purple-700" : "bg-blue-100 text-blue-700"}`}>
                      {u.role}
                    </span>
                    {u.role === "lite" && (
                      <span className="text-gray-500">{tenantName(u) ?? "sin negocio"}</span>
                    )}
                  </div>
                </div>
                <form action={deletePanelUserAction}>
                  <input type="hidden" name="id" value={u.id} />
                  <button className="text-xs text-red-600 hover:text-red-700 hover:underline">Eliminar</button>
                </form>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
