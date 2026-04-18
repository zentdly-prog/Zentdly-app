"use client";

import { useActionState } from "react";
import { updateTenant } from "@/lib/actions/tenants";
import { SubmitButton } from "@/components/SubmitButton";
import { Alert } from "@/components/Alert";

type Tenant = {
  id: string;
  name: string;
  slug: string;
  timezone: string;
  contact_name: string | null;
  contact_phone: string | null;
  address: string | null;
};

export default function OverviewClient({ tenant }: { tenant: Tenant }) {
  const [state, action] = useActionState(updateTenant, null);

  return (
    <div className="max-w-xl">
      <h2 className="text-lg font-semibold text-gray-900 mb-4">Datos generales</h2>

      <form action={action} className="bg-white rounded-xl border border-gray-200 p-6 space-y-4">
        <input type="hidden" name="id" value={tenant.id} />

        {state?.error && <Alert type="error" message={state.error} />}
        {state?.ok && <Alert type="success" message="Datos actualizados." />}

        <Field name="name" label="Nombre del complejo" defaultValue={tenant.name} required />
        <Field name="slug" label="Slug" hint="Solo minúsculas, números y guiones." defaultValue={tenant.slug} required />
        <Field name="address" label="Dirección" defaultValue={tenant.address ?? ""} />
        <Field name="contact_name" label="Nombre del contacto" defaultValue={tenant.contact_name ?? ""} />
        <Field name="contact_phone" label="Teléfono del contacto" defaultValue={tenant.contact_phone ?? ""} />

        <div>
          <label className="block text-sm font-medium text-gray-700 mb-1">Zona horaria</label>
          <select
            name="timezone"
            defaultValue={tenant.timezone}
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

        <div className="pt-2 flex justify-end">
          <SubmitButton label="Guardar cambios" />
        </div>
      </form>
    </div>
  );
}

function Field({
  name,
  label,
  hint,
  required,
  defaultValue,
}: {
  name: string;
  label: string;
  hint?: string;
  required?: boolean;
  defaultValue?: string;
}) {
  return (
    <div>
      <label className="block text-sm font-medium text-gray-700 mb-1">
        {label} {required && <span className="text-red-500">*</span>}
      </label>
      <input
        type="text"
        name={name}
        required={required}
        defaultValue={defaultValue}
        className="w-full px-3 py-2 border border-gray-300 rounded-lg text-sm text-gray-900 focus:outline-none focus:ring-2 focus:ring-green-500"
      />
      {hint && <p className="mt-1 text-xs text-gray-400">{hint}</p>}
    </div>
  );
}
