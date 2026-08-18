import { Resend } from "resend";

// Resend refuses any sender on an unverified domain. Until a real domain is
// verified at resend.com/domains, `onboarding@resend.dev` is the only address
// that works — and it can only deliver to the Resend account's own email.
// Set RESEND_FROM_EMAIL once a domain is verified to reach business owners.
const FROM_EMAIL = process.env.RESEND_FROM_EMAIL ?? "Zentdly <onboarding@resend.dev>";

export interface SendResult {
  ok: boolean;
  error?: string;
  /** True when delivery failed because the sending domain isn't verified yet. */
  needsDomainSetup?: boolean;
}

export async function sendHumanSupportAlert(
  to: string,
  businessName: string,
  customerPhone: string,
  reason: string,
): Promise<SendResult> {
  if (!to) return { ok: false, error: "El negocio no tiene email de contacto configurado." };
  if (!process.env.RESEND_API_KEY) return { ok: false, error: "Falta configurar RESEND_API_KEY." };

  try {
    const resend = new Resend(process.env.RESEND_API_KEY);
    const { error } = await resend.emails.send({
      from: FROM_EMAIL,
      to,
      subject: `[${businessName}] Un cliente pidió hablar con una persona`,
      html: `
        <h2>Un cliente necesita atención humana</h2>
        <p><strong>Negocio:</strong> ${escapeHtml(businessName)}</p>
        <p><strong>Teléfono del cliente:</strong> ${escapeHtml(customerPhone)}</p>
        <p><strong>Motivo:</strong> ${escapeHtml(reason)}</p>
        <p>El bot quedó pausado con este cliente. Respondele por WhatsApp y marcalo como atendido en el panel.</p>
      `,
    });

    if (error) {
      const message = error.message ?? "Error al enviar el email.";
      return { ok: false, error: message, needsDomainSetup: /domain is not verified|your own email address/i.test(message) };
    }
    return { ok: true };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : "Error al enviar el email." };
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
