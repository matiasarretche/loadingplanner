import 'server-only'
import nodemailer from 'nodemailer'

/** O envio de e-mail está configurado no servidor (conta SMTP da empresa — Microsoft 365)? */
export const mailConfigured = () => Boolean(process.env.SMTP_HOST && process.env.SMTP_USER && process.env.SMTP_PASS && process.env.SMTP_FROM)

/** Envia um e-mail pela conta SMTP da empresa (lança erro se o servidor recusar). */
export async function sendMail(m: { to: string | string[]; cc?: string[]; replyTo?: string; subject: string; text: string; attachments?: { filename: string; content: Buffer; contentType: string }[] }) {
  const port = Number(process.env.SMTP_PORT || 587)
  const transport = nodemailer.createTransport({
    host: process.env.SMTP_HOST,
    port,
    secure: process.env.SMTP_SECURE === 'true' || port === 465,
    auth: { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS },
  })
  await transport.sendMail({ from: process.env.SMTP_FROM, ...m })
}

/**
 * Endereço público da plataforma (links nos e-mails): APP_URL; senão o domínio de produção que a Vercel
 * informa (VERCEL_PROJECT_PRODUCTION_URL, sem protocolo); senão o servidor local.
 * Nunca usar o cabeçalho Host da requisição (permitiria injetar outro domínio no link de redefinição).
 */
export function appUrl() {
  const vercel = process.env.VERCEL_PROJECT_PRODUCTION_URL?.trim()
  const url = process.env.APP_URL?.trim() || (vercel ? `https://${vercel.replace(/^https?:\/\//, '')}` : 'http://127.0.0.1:3000')
  return url.replace(/\/+$/, '')
}
