import { getWhatsAppConfig } from "@/lib/actions/whatsapp";
import WhatsAppClient from "./WhatsAppClient";

export const dynamic = "force-dynamic";

export default async function WhatsAppPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const config = await getWhatsAppConfig(id);
  const alreadyConnected = false; // state is checked live when button is pressed

  return <WhatsAppClient tenantId={id} alreadyConnected={alreadyConnected} />;
}
