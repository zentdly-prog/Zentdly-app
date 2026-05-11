import { getBotPolicy } from "@/lib/actions/policies";
import PoliciesClient from "./PoliciesClient";

export const dynamic = "force-dynamic";

export default async function PoliciesPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const policy = await getBotPolicy(id);
  return <PoliciesClient policy={policy} />;
}
