import { getGoogleConfig } from "@/lib/actions/google";
import GoogleClient from "./GoogleClient";

export const dynamic = "force-dynamic";

export default async function GooglePage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const config = await getGoogleConfig(id);
  return <GoogleClient tenantId={id} initialConfig={config} />;
}
