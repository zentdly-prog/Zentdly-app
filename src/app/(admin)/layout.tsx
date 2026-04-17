import type { ReactNode } from "react";
import Link from "next/link";

export default function AdminLayout({ children }: { children: ReactNode }) {
  return (
    <div className="min-h-screen bg-gray-50 flex">
      <aside className="w-60 bg-white border-r border-gray-200 flex flex-col py-6 px-4 gap-1">
        <div className="mb-6 px-2">
          <span className="text-xl font-bold text-green-600">Zentdly</span>
        </div>
        <NavLink href="/dashboard">Dashboard</NavLink>
        <NavLink href="/courts">Canchas</NavLink>
        <NavLink href="/settings">Configuración</NavLink>
      </aside>
      <main className="flex-1 p-8 overflow-y-auto">{children}</main>
    </div>
  );
}

function NavLink({ href, children }: { href: string; children: ReactNode }) {
  return (
    <Link
      href={href}
      className="px-3 py-2 rounded-md text-sm font-medium text-gray-700 hover:bg-gray-100 hover:text-gray-900 transition-colors"
    >
      {children}
    </Link>
  );
}
