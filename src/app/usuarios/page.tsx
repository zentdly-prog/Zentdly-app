import Link from "next/link";
import { redirect } from "next/navigation";
import { getSession } from "@/lib/session";
import { getPanelUsersForAdmin } from "@/lib/actions/users";
import UsersClient from "./UsersClient";

export const dynamic = "force-dynamic";

export default async function UsuariosPage() {
  const session = await getSession();
  if (!session.valid) redirect("/login?next=/usuarios");
  if (session.role !== "admin") redirect("/");

  const users = await getPanelUsersForAdmin();

  return (
    <div className="min-h-screen bg-gray-50">
      <header className="bg-white border-b border-gray-200 px-6 py-4 flex items-center gap-3">
        <Link href="/" className="text-sm text-gray-500 hover:text-gray-700">Negocios</Link>
        <span className="text-gray-300">/</span>
        <span className="text-sm font-semibold text-gray-900">Usuarios</span>
      </header>

      <main className="max-w-3xl mx-auto px-6 py-8">
        <UsersClient users={users} />
      </main>
    </div>
  );
}
