export default function SettingsPage() {
  return (
    <div>
      <h1 className="text-2xl font-semibold text-gray-900 mb-6">Configuración</h1>

      <div className="space-y-6 max-w-2xl">
        <Section title="Negocio">
          <Field label="Nombre del complejo" placeholder="Mi Complejo Deportivo" />
          <Field label="Zona horaria" placeholder="America/Argentina/Buenos_Aires" />
        </Section>

        <Section title="Integración Google">
          <div className="flex gap-3">
            <ProviderButton label="Google Sheets" />
            <ProviderButton label="Google Calendar" />
          </div>
        </Section>

        <Section title="WhatsApp">
          <Field label="Phone Number ID" placeholder="Meta phone_number_id" />
          <Field label="Verify Token" placeholder="Tu token de verificación" />
        </Section>
      </div>
    </div>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="bg-white rounded-lg border border-gray-200 p-6">
      <h2 className="text-base font-medium text-gray-800 mb-4">{title}</h2>
      <div className="space-y-4">{children}</div>
    </div>
  );
}

function Field({ label, placeholder }: { label: string; placeholder: string }) {
  return (
    <div>
      <label className="block text-sm font-medium text-gray-700 mb-1">{label}</label>
      <input
        type="text"
        placeholder={placeholder}
        className="w-full px-3 py-2 border border-gray-300 rounded-md text-sm focus:outline-none focus:ring-2 focus:ring-green-500"
      />
    </div>
  );
}

function ProviderButton({ label }: { label: string }) {
  return (
    <button className="px-4 py-2 border border-gray-300 rounded-md text-sm text-gray-700 hover:bg-gray-50 transition-colors">
      Conectar {label}
    </button>
  );
}
