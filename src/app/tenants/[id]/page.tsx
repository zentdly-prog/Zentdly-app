import { getTenant } from "@/lib/actions/tenants";
import { notFound } from "next/navigation";
import OverviewClient from "./OverviewClient";

export const dynamic = "force-dynamic";

export default async function TenantOverviewPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const tenant = await getTenant(id);
  if (!tenant) notFound();

  return <OverviewClient tenant={tenant} />;
}
