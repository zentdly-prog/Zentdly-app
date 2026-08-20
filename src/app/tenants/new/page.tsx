"use client";

import { useActionState } from "react";
import { createTenant } from "@/lib/actions/tenants";
import Link from "next/link";
import { SubmitButton } from "@/components/SubmitButton";
import { Alert } from "@/components/Alert";

export default function NewTenantPage() {
  const [state, action] = useActionState(createTenant, null);

  return (
    <div className="min-h-screen bg-gray-50">
      <header className="bg-white border-b border-gray-200 px-6 py-4 flex items-center gap-3">
        <Link href="/" className="text-sm text-gray-500 hover:text-gray-700">
          ← Negocios
        </Link>
        <span className="text-gray-300">/</span>
        <span className="text-sm font-medium text-gray-900">Nuevo negocio</span>
      </header>

      <main className="max-w-xl mx-auto px-6 py-8">
        <h1 className="text-2xl font-semibold text-gray-900 mb-6">Nuevo negocio</h1>

        <form action={action} className="bg-white rounded-xl border border-gray-200 p-6 space-y-4">
          {state?.error && <Alert type="error" message={state.error} />}

          <Field name="name" label="Nombre del complejo" placeholder="Complejo La Bombonera" hint="El identificador interno se genera solo a partir del nombre." required />
          <Field name="address" label="Dirección" placeholder="Av. Corrientes 1234, CABA" />
          <Field name="contact_name" label="Nombre del contacto" placeholder="Juan Pérez" />
          <Field name="contact_phone" label="Teléfono del contacto" placeholder="+5491112345678" />

          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">Zona horaria</label>
            <select
              name="timezone"
              defaultValue="America/Argentina/Buenos_Aires"
              className="w-full px-3 py-2 border border-gray-300 rounded-lg text-sm text-gray-900 focus:outline-none focus:ring-2 focus:ring-green-500"
            >
              <option value="America/Argentina/Buenos_Aires">Buenos Aires (GMT-3)</option>
              <option value="America/Argentina/Cordoba">Córdoba (GMT-3)</option>
              <option value="America/Argentina/Mendoza">Mendoza (GMT-3)</option>
              <option value="America/Montevideo">Montevideo (GMT-3)</option>
              <option value="America/Santiago">Santiago (GMT-4)</option>
              <option value="America/Bogota">Bogotá (GMT-5)</option>
              <option value="America/Mexico_City">Ciudad de México (GMT-6)</option>
            </select>
          </div>

          <div className="pt-2 flex justify-end gap-3">
            <Link
              href="/"
              className="px-5 py-2 text-sm text-gray-600 border border-gray-300 rounded-lg hover:bg-gray-50"
            >
              Cancelar
            </Link>
            <SubmitButton label="Crear negocio" />
          </div>
        </form>
      </main>
    </div>
  );
}

function Field({
  name,
  label,
  placeholder,
  hint,
  required,
}: {
  name: string;
  label: string;
  placeholder?: string;
  hint?: string;
  required?: boolean;
}) {
  return (
    <div>
      <label className="block text-sm font-medium text-gray-700 mb-1">
        {label} {required && <span className="text-red-500">*</span>}
      </label>
      <input
        type="text"
        name={name}
        placeholder={placeholder}
        required={required}
        className="w-full px-3 py-2 border border-gray-300 rounded-lg text-sm text-gray-900 focus:outline-none focus:ring-2 focus:ring-green-500"
      />
      {hint && <p className="mt-1 text-xs text-gray-400">{hint}</p>}
    </div>
  );
}
