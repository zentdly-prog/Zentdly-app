import { getTenant } from "@/lib/actions/tenants";
import { notFound } from "next/navigation";
import BotClient from "./BotClient";

export const dynamic = "force-dynamic";

export default async function BotPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const tenant = await getTenant(id);
  if (!tenant) notFound();
  return <BotClient tenantId={id} savedPrompt={tenant.bot_prompt ?? ""} />;
}
