import { getTenantConversations } from "@/lib/actions/conversations";
import InboxClient from "./InboxClient";

export const dynamic = "force-dynamic";

export default async function InboxPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const conversations = await getTenantConversations(id);
  return <InboxClient tenantId={id} conversations={conversations} />;
}
