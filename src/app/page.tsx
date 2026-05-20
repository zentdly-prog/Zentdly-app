import Link from "next/link";
import { getTenants } from "@/lib/actions/tenants";
import { getSession } from "@/lib/session";

export const dynamic = "force-dynamic";

export default async function TenantsPage() {
  const [tenants, session] = await Promise.all([getTenants(), getSession()]);
  const isAdmin = session.role === "admin";

  return (
    <div className="min-h-screen bg-gray-50">
      <header className="bg-white border-b border-gray-200 px-6 py-4 flex items-center justify-between">
        <div className="flex items-center gap-3">
          <div className="w-8 h-8 bg-green-600 rounded-lg flex items-center justify-center">
            <span className="text-white text-sm font-bold">Z</span>
          </div>
          <span className="text-lg font-semibold text-gray-900">Zentdly</span>
          <span className="text-sm text-gray-400">Panel interno</span>
        </div>
        <div className="flex items-center gap-2">
          {isAdmin && (
            <Link href="/usuarios" className="px-3 py-2 text-sm font-medium text-gray-600 hover:text-gray-900">
              Usuarios
            </Link>
          )}
          {isAdmin && (
            <Link
              href="/tenants/new"
              className="px-4 py-2 bg-green-600 text-white text-sm font-medium rounded-lg hover:bg-green-700 transition-colors"
            >
              + Nuevo negocio
            </Link>
          )}
          <form action="/api/logout" method="post">
            <button className="px-3 py-2 text-sm text-gray-500 hover:text-gray-700">Salir</button>
          </form>
        </div>
      </header>

      <main className="max-w-6xl mx-auto px-6 py-8">
        <div className="mb-6">
          <h1 className="text-2xl font-semibold text-gray-900">Negocios activos</h1>
          <p className="text-sm text-gray-500 mt-1">
            {tenants.length} negocio{tenants.length !== 1 ? "s" : ""} en el sistema
          </p>
        </div>

        {tenants.length === 0 ? (
          <div className="bg-white rounded-xl border border-gray-200 p-12 text-center">
            <div className="w-12 h-12 bg-gray-100 rounded-xl flex items-center justify-center mx-auto mb-4">
              <span className="text-2xl">🏟️</span>
            </div>
            <h3 className="text-gray-900 font-medium mb-1">Sin negocios todavía</h3>
            <p className="text-sm text-gray-500 mb-4">
              Agregá el primer complejo deportivo para empezar.
            </p>
            <Link
              href="/tenants/new"
              className="inline-block px-4 py-2 bg-green-600 text-white text-sm font-medium rounded-lg hover:bg-green-700 transition-colors"
            >
              + Nuevo negocio
            </Link>
          </div>
        ) : (
          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
            {tenants.map((t) => (
              <TenantCard key={t.id} tenant={t} />
            ))}
          </div>
        )}
      </main>
    </div>
  );
}

type Tenant = Awaited<ReturnType<typeof getTenants>>[number];

function TenantCard({ tenant }: { tenant: Tenant }) {
  return (
    <Link
      href={`/tenants/${tenant.id}`}
      className="bg-white rounded-xl border border-gray-200 p-5 hover:border-green-400 hover:shadow-sm transition-all group"
    >
      <div className="flex items-start justify-between mb-3">
        <div className="w-10 h-10 bg-green-100 rounded-lg flex items-center justify-center flex-shrink-0">
          <span className="text-green-700 font-bold text-sm">
            {tenant.name.slice(0, 2).toUpperCase()}
          </span>
        </div>
        <span
          className={`text-xs px-2 py-1 rounded-full font-medium ${
            tenant.active
              ? "bg-green-100 text-green-700"
              : "bg-gray-100 text-gray-500"
          }`}
        >
          {tenant.active ? "Activo" : "Inactivo"}
        </span>
      </div>

      <h3 className="font-semibold text-gray-900 group-hover:text-green-700 transition-colors">
        {tenant.name}
      </h3>

      {tenant.address && (
        <p className="text-xs text-gray-400 mt-1 truncate">{tenant.address}</p>
      )}

      <div className="mt-3 pt-3 border-t border-gray-100 flex items-center justify-between">
        <div className="flex items-center gap-1.5">
          <StatusDot active={!!tenant.bot_prompt} />
          <span className="text-xs text-gray-500">Bot</span>
        </div>
        <span className="text-xs text-gray-400">→</span>
      </div>
    </Link>
  );
}

function StatusDot({ active }: { active: boolean }) {
  return (
    <div
      className={`w-1.5 h-1.5 rounded-full ${active ? "bg-green-500" : "bg-gray-300"}`}
    />
  );
}
