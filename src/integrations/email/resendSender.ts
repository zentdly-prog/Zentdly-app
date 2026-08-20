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

/**
 * Sends a payment receipt to the business so a person can check it.
 *
 * The receipt image travels as an attachment on purpose: whoever reviews it has
 * to actually see it, and the panel deliberately does not store customer images
 * (they would bloat the database and are personal data we have no reason to
 * keep). The reviewer looks at the email, then validates in the panel.
 */
export async function sendDepositReceiptAlert(options: {
  to: string;
  businessName: string;
  customerName: string;
  customerPhone: string;
  reservationSummary: string;
  agentNote: string;
  image?: { base64: string; mimetype: string };
}): Promise<SendResult> {
  const { to, businessName, customerName, customerPhone, reservationSummary, agentNote, image } = options;
  if (!to) return { ok: false, error: "El negocio no tiene email de contacto configurado." };

  const subject = `[${businessName}] Comprobante de seña para revisar — ${customerName}`;
  const html = `
    <h2>Un cliente mandó un comprobante de seña</h2>
    <p><strong>Cliente:</strong> ${escapeHtml(customerName)} (${escapeHtml(customerPhone)})</p>
    <p><strong>Reserva:</strong><br>${escapeHtml(reservationSummary).replace(/\n/g, "<br>")}</p>
    <p><strong>Lo que se leyó del comprobante:</strong><br>${escapeHtml(agentNote)}</p>
    <hr>
    <p>El comprobante va adjunto. <strong>La reserva sigue pendiente</strong> hasta que la valides
    desde el panel, en la pestaña Reservas.</p>
  `;
  const text =
    `Un cliente mandó un comprobante de seña\n\n` +
    `Cliente: ${customerName} (${customerPhone})\n` +
    `Reserva:\n${reservationSummary}\n\n` +
    `Lo que se leyó del comprobante:\n${agentNote}\n\n` +
    `La reserva sigue pendiente hasta que la valides desde el panel, en la pestaña Reservas.`;

  const attachments = image
    ? [{
        filename: `comprobante.${image.mimetype.split("/")[1] ?? "jpg"}`,
        content: image.base64,
        contentType: image.mimetype,
      }]
    : undefined;

  if (isSmtpConfigured()) {
    const smtp = await sendMailViaSmtp({ to, subject, html, text, attachments });
    if (smtp.ok) return { ok: true, via: "smtp" };
    return { ...smtp, via: "smtp" };
  }

  // Resend is the fallback; it takes attachments in its own shape.
  if (!process.env.RESEND_API_KEY) return { ok: false, error: "No hay canal de email configurado.", via: "resend" };
  try {
    const resend = new Resend(process.env.RESEND_API_KEY);
    const { error } = await resend.emails.send({
      from: FROM_EMAIL,
      to,
      subject,
      html,
      attachments: attachments?.map((a) => ({ filename: a.filename, content: a.content })),
    });
    if (error) return { ok: false, error: error.message ?? "Error al enviar.", via: "resend" };
    return { ok: true, via: "resend" };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : "Error al enviar.", via: "resend" };
  }
}
