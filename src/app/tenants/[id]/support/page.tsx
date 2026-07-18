import { getHumanQueue } from "@/lib/actions/conversations";
import SupportClient from "./SupportClient";

export const dynamic = "force-dynamic";

export default async function SupportPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const queue = await getHumanQueue(id);
  return <SupportClient tenantId={id} initialQueue={queue} />;
}
