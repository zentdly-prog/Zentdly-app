import Link from "next/link";
import { getTenant } from "@/lib/actions/tenants";
import { notFound } from "next/navigation";

const TABS = [
  { href: "", label: "General" },
  { href: "/courts", label: "Canchas" },
  { href: "/whatsapp", label: "WhatsApp" },
  { href: "/bot", label: "Bot / IA" },
  { href: "/google", label: "Google" },
];

export default async function TenantLayout({
  children,
  params,
}: {
  children: React.ReactNode;
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const tenant = await getTenant(id);
  if (!tenant) notFound();

  return (
    <div className="min-h-screen bg-gray-50">
      <header className="bg-white border-b border-gray-200">
        <div className="max-w-5xl mx-auto px-6">
          <div className="py-4 flex items-center gap-2">
            <Link href="/" className="text-sm text-gray-500 hover:text-gray-700">
              Negocios
            </Link>
            <span className="text-gray-300">/</span>
            <span className="text-sm font-semibold text-gray-900">{tenant.name}</span>
            <span
              className={`ml-2 text-xs px-2 py-0.5 rounded-full font-medium ${
                tenant.active ? "bg-green-100 text-green-700" : "bg-gray-100 text-gray-500"
              }`}
            >
              {tenant.active ? "Activo" : "Inactivo"}
            </span>
          </div>

          <nav className="flex gap-1 -mb-px">
            {TABS.map((tab) => (
              <TabLink key={tab.href} tenantId={id} href={tab.href} label={tab.label} />
            ))}
          </nav>
        </div>
      </header>

      <main className="max-w-5xl mx-auto px-6 py-8">{children}</main>
    </div>
  );
}

function TabLink({ tenantId, href, label }: { tenantId: string; href: string; label: string }) {
  const fullHref = `/tenants/${tenantId}${href}`;
  return (
    <Link
      href={fullHref}
      className="px-4 py-3 text-sm font-medium text-gray-600 border-b-2 border-transparent hover:text-gray-900 hover:border-gray-300 transition-colors"
    >
      {label}
    </Link>
  );
}
