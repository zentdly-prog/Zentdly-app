const BASE_URL = process.env.EVOLUTION_API_URL ?? "https://evolution-api-production-be7b.up.railway.app";
const API_KEY = process.env.EVOLUTION_API_KEY ?? "";

export async function evolutionSendText(instanceName: string, to: string, text: string): Promise<void> {
  const res = await fetch(`${BASE_URL}/message/sendText/${instanceName}`, {
    method: "POST",
    headers: { apikey: API_KEY, "Content-Type": "application/json" },
    body: JSON.stringify({ number: to, text }),
  });

  if (!res.ok) {
    const body = await res.text().catch(() => "");

    // @lid JIDs are not supported by Evolution API v1.x — log and skip
    if (res.status === 400 && body.includes("exists") && to.includes("@lid")) {
      console.warn(`[evolution] Cannot send to @lid JID ${to} (Evolution v1.x limitation). Message not delivered.`);
      return;
    }

    throw new Error(`Evolution send failed [${res.status}]: ${body}`);
  }
}
