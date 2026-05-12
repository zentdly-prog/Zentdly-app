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
  contact_email?: string | null;
  address: string | null;
  maps_url?: string | null;
  instagram?: string | null;
  website?: string | null;
  bank_alias?: string | null;
  bank_holder_name?: string | null;
  bank_name?: string | null;
};

export default function OverviewClient({ tenant }: { tenant: Tenant }) {
  const [state, action] = useActionState(updateTenant, null);

  return (
    <div className="max-w-2xl space-y-6">
      <h2 className="text-lg font-semibold text-gray-900">Datos generales</h2>

      <form action={action} className="space-y-6">
        <input type="hidden" name="id" value={tenant.id} />

        {state?.error && <Alert type="error" message={state.error} />}
        {state?.ok && <Alert type="success" message="Datos actualizados." />}

        {/* ── Negocio ── */}
        <Section title="Negocio">
          <Field name="name" label="Nombre del complejo" defaultValue={tenant.name} required />
          <Field name="slug" label="Slug" hint="Solo minúsculas, números y guiones." defaultValue={tenant.slug} required />
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
        </Section>

        {/* ── Cobro de seña ── */}
        <Section title="Cobro de seña" hint="El bot le pasa estos datos al cliente cuando le pide el comprobante de la seña.">
          <Field
            name="bank_alias"
            label="Alias bancario / CBU"
            hint="Ej: cancha.padel.mp o un CBU completo. Es lo más importante para que la gente transfiera."
            defaultValue={tenant.bank_alias ?? ""}
          />
          <Field
            name="bank_holder_name"
            label="Titular de la cuenta"
            hint="A nombre de quién está la cuenta."
            defaultValue={tenant.bank_holder_name ?? ""}
          />
          <Field
            name="bank_name"
            label="Banco (opcional)"
            hint="Mercado Pago, Brubank, Galicia, etc."
            defaultValue={tenant.bank_name ?? ""}
          />
        </Section>

        {/* ── Contacto público ── */}
        <Section title="Contacto público" hint="El bot puede compartir estos datos con clientes que pregunten.">
          <Field name="address" label="Dirección" defaultValue={tenant.address ?? ""} />
          <Field
            name="maps_url"
            label="Link de Google Maps"
            hint="Pegá el link que copiás desde Maps con el botón 'Compartir'."
            defaultValue={tenant.maps_url ?? ""}
          />
          <Field name="instagram" label="Instagram" hint="Sin @, por ejemplo: canchasdelgordo" defaultValue={tenant.instagram ?? ""} />
          <Field name="website" label="Sitio web" defaultValue={tenant.website ?? ""} />
          <Field name="contact_email" label="Email de contacto" defaultValue={tenant.contact_email ?? ""} />
        </Section>

        {/* ── Contacto interno ── */}
        <Section title="Contacto interno" hint="No se comparte por el bot. Solo para vos.">
          <Field name="contact_name" label="Nombre del contacto" defaultValue={tenant.contact_name ?? ""} />
          <Field name="contact_phone" label="Teléfono del contacto" defaultValue={tenant.contact_phone ?? ""} />
        </Section>

        <div className="flex justify-end">
          <SubmitButton label="Guardar cambios" />
        </div>
      </form>
    </div>
  );
}

function Section({ title, hint, children }: { title: string; hint?: string; children: React.ReactNode }) {
  return (
    <div className="bg-white rounded-xl border border-gray-200 p-6 space-y-4">
      <div>
        <h3 className="text-sm font-semibold text-gray-900">{title}</h3>
        {hint && <p className="mt-1 text-xs text-gray-500">{hint}</p>}
      </div>
      {children}
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
