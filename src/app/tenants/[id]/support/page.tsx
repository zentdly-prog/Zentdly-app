import { getHumanQueue } from "@/lib/actions/conversations";
import { getTenant } from "@/lib/actions/tenants";
import SupportClient from "./SupportClient";

export const dynamic = "force-dynamic";

export default async function SupportPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const [queue, tenant] = await Promise.all([getHumanQueue(id), getTenant(id)]);
  return (
    <SupportClient
      tenantId={id}
      initialQueue={queue}
      contactEmail={(tenant as { contact_email?: string | null } | null)?.contact_email ?? null}
    />
  );
}
