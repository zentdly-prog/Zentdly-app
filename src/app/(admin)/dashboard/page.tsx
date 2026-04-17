export default function DashboardPage() {
  return (
    <div>
      <h1 className="text-2xl font-semibold text-gray-900 mb-6">Dashboard</h1>
      <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
        <StatCard label="Reservas hoy" value="—" />
        <StatCard label="Reservas esta semana" value="—" />
        <StatCard label="Canchas activas" value="—" />
      </div>
      <div className="mt-8 bg-white rounded-lg border border-gray-200 p-6">
        <h2 className="text-lg font-medium text-gray-800 mb-4">Próximas reservas</h2>
        <p className="text-sm text-gray-500">
          Conectá Supabase y las reservas aparecerán aquí.
        </p>
      </div>
    </div>
  );
}

function StatCard({ label, value }: { label: string; value: string }) {
  return (
    <div className="bg-white rounded-lg border border-gray-200 p-5">
      <p className="text-sm text-gray-500">{label}</p>
      <p className="mt-1 text-3xl font-bold text-gray-900">{value}</p>
    </div>
  );
}
