import nodemailer, { type Transporter } from "nodemailer";

/**
 * SMTP delivery from the business's own mailbox.
 *
 * Ported from the project's `enviar_generico.py`, keeping its decisions:
 * the provider is derived from the sender's domain, and the password is only
 * ever read from the environment — never hardcoded, never passed as an
 * argument, so it cannot leak into logs or a process list.
 *
 * This exists because Resend refuses to deliver to arbitrary recipients until
 * a domain is verified, which made it useless for alerting each business at
 * its own address. A normal mailbox has no such restriction.
 */

type Security = "ssl" | "starttls";

const PROVIDERS: Record<string, [host: string, port: number, security: Security]> = {
  "gmail.com": ["smtp.gmail.com", 465, "ssl"],
  "googlemail.com": ["smtp.gmail.com", 465, "ssl"],
  "outlook.com": ["smtp-mail.outlook.com", 587, "starttls"],
  "hotmail.com": ["smtp-mail.outlook.com", 587, "starttls"],
  "live.com": ["smtp-mail.outlook.com", 587, "starttls"],
  "msn.com": ["smtp-mail.outlook.com", 587, "starttls"],
  "yahoo.com": ["smtp.mail.yahoo.com", 465, "ssl"],
  "yahoo.com.ar": ["smtp.mail.yahoo.com", 465, "ssl"],
  "icloud.com": ["smtp.mail.me.com", 587, "starttls"],
  "me.com": ["smtp.mail.me.com", 587, "starttls"],
  "zoho.com": ["smtp.zoho.com", 465, "ssl"],
  "zoho.eu": ["smtp.zoho.eu", 465, "ssl"],
  "gmx.net": ["mail.gmx.net", 587, "starttls"],
  "gmx.com": ["mail.gmx.com", 587, "starttls"],
  "web.de": ["smtp.web.de", 587, "starttls"],
  "fastmail.com": ["smtp.fastmail.com", 465, "ssl"],
  "yandex.com": ["smtp.yandex.com", 465, "ssl"],
};

export function smtpConfig(address: string): { host: string; port: number; secure: boolean } {
  const domain = address.split("@").pop()?.toLowerCase() ?? "";
  const [host, port, security] = PROVIDERS[domain] ?? [`smtp.${domain}`, 587, "starttls"];
  return {
    host: process.env.SMTP_HOST || host,
    port: Number(process.env.SMTP_PORT) || port,
    secure: (process.env.SMTP_SECURITY as Security | undefined ?? security) === "ssl",
  };
}

export function isSmtpConfigured(): boolean {
  return Boolean(process.env.SMTP_USER && process.env.SMTP_PASSWORD);
}

// Reused across invocations of a warm serverless instance: reconnecting for
// every message is slow and looks like abuse to the provider.
let transporter: Transporter | null = null;

function getTransporter(user: string, pass: string): Transporter {
  if (transporter) return transporter;
  const { host, port, secure } = smtpConfig(user);
  transporter ??= nodemailer.createTransport({
    host,
    port,
    secure,
    auth: { user, pass },
    connectionTimeout: 15_000,
    greetingTimeout: 15_000,
    socketTimeout: 20_000,
  });
  return transporter;
}

export interface SmtpResult {
  ok: boolean;
  error?: string;
  /** True when the mailbox rejected the credentials (usually a missing app password). */
  authFailed?: boolean;
}

export async function sendMailViaSmtp(options: {
  to: string;
  subject: string;
  html: string;
  text: string;
}): Promise<SmtpResult> {
  const user = process.env.SMTP_USER;
  const pass = process.env.SMTP_PASSWORD;
  if (!user || !pass) return { ok: false, error: "SMTP no configurado (faltan SMTP_USER y SMTP_PASSWORD)." };

  try {
    const from = process.env.SMTP_FROM_NAME ? `${process.env.SMTP_FROM_NAME} <${user}>` : user;
    await getTransporter(user, pass).sendMail({
      from,
      to: options.to,
      subject: options.subject,
      text: options.text,
      html: options.html,
    });
    return { ok: true };
  } catch (e) {
    const message = e instanceof Error ? e.message : "Error al enviar por SMTP.";
    // A bad password poisons the cached transport; drop it so a corrected
    // credential is picked up without redeploying.
    const authFailed = /invalid login|authentication|535|534/i.test(message);
    if (authFailed) transporter = null;
    return { ok: false, error: message, authFailed };
  }
}
