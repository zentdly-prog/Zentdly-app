import { Resend } from "resend";

const resend = new Resend(process.env.RESEND_API_KEY);
const FROM_EMAIL = "soporte@zentdly.app";

export async function sendHumanSupportAlert(
  to: string,
  businessName: string,
  customerPhone: string,
  reason: string,
): Promise<{ ok: boolean; error?: string }> {
  if (!to) {
    return { ok: false, error: "No email configured for this business" };
  }

  try {
    await resend.emails.send({
      from: FROM_EMAIL,
      to,
      subject: `[${businessName}] Cliente solicitó atención humana`,
      html: `
        <h2>Alerta de soporte</h2>
        <p><strong>Negocio:</strong> ${escapeHtml(businessName)}</p>
        <p><strong>Teléfono del cliente:</strong> ${escapeHtml(customerPhone)}</p>
        <p><strong>Motivo:</strong> ${escapeHtml(reason)}</p>
        <p>El cliente está esperando tu respuesta en WhatsApp.</p>
      `,
    });
    return { ok: true };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : "Failed to send email" };
  }
}

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;");
}
