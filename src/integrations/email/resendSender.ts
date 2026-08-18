import { Resend } from "resend";
import { isSmtpConfigured, sendMailViaSmtp } from "./smtpSender";

// Resend refuses any sender on an unverified domain, and without one it will
// only deliver to the account's own address — useless for alerting each
// business at its own email. So SMTP from a real mailbox is preferred when
// configured, and Resend stays as the fallback.
const FROM_EMAIL = process.env.RESEND_FROM_EMAIL ?? "Zentdly <onboarding@resend.dev>";

export interface SendResult {
  ok: boolean;
  error?: string;
  /** Which channel delivered (or attempted) the message. */
  via?: "smtp" | "resend";
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

  const subject = `[${businessName}] Un cliente pidió hablar con una persona`;
  const html = `
    <h2>Un cliente necesita atención humana</h2>
    <p><strong>Negocio:</strong> ${escapeHtml(businessName)}</p>
    <p><strong>Teléfono del cliente:</strong> ${escapeHtml(customerPhone)}</p>
    <p><strong>Motivo:</strong> ${escapeHtml(reason)}</p>
    <p>El bot quedó pausado con este cliente. Respondele por WhatsApp y marcalo como atendido en el panel.</p>
  `;
  const text =
    `Un cliente necesita atención humana\n\n` +
    `Negocio: ${businessName}\n` +
    `Teléfono del cliente: ${customerPhone}\n` +
    `Motivo: ${reason}\n\n` +
    `El bot quedó pausado con este cliente. Respondele por WhatsApp y marcalo como atendido en el panel.`;

  if (isSmtpConfigured()) {
    const smtp = await sendMailViaSmtp({ to, subject, html, text });
    if (smtp.ok) return { ok: true, via: "smtp" };
    // Fall through to Resend rather than losing the alert entirely.
    const fallback = await sendViaResend(to, subject, html);
    return fallback.ok ? fallback : { ...smtp, via: "smtp" };
  }

  return sendViaResend(to, subject, html);
}

async function sendViaResend(to: string, subject: string, html: string): Promise<SendResult> {
  if (!process.env.RESEND_API_KEY) return { ok: false, error: "Falta configurar RESEND_API_KEY.", via: "resend" };

  try {
    const resend = new Resend(process.env.RESEND_API_KEY);
    const { error } = await resend.emails.send({ from: FROM_EMAIL, to, subject, html });

    if (error) {
      const message = error.message ?? "Error al enviar el email.";
      return {
        ok: false,
        error: message,
        via: "resend",
        needsDomainSetup: /domain is not verified|your own email address/i.test(message),
      };
    }
    return { ok: true, via: "resend" };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : "Error al enviar el email.", via: "resend" };
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
