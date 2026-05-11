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
  const safeConfig = config
    ? {
        provider: config.provider,
        bot_enabled: config.connected,
        forget_command_enabled:
          (config as { forget_command_enabled?: boolean | null }).forget_command_enabled ?? true,
        meta_phone_number_id: config.meta_phone_number_id,
        meta_access_token: config.meta_access_token,
        meta_verify_token: config.meta_verify_token,
        meta_app_secret: config.meta_app_secret,
        meta_business_id: config.meta_business_id,
      }
    : null;

  return <WhatsAppClient tenantId={id} initialConfig={safeConfig} />;
}
