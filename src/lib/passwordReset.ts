import 'server-only'
import { and, count, eq, gt, isNull, sql } from 'drizzle-orm'
import { createHash, randomBytes } from 'node:crypto'
import { db, schema } from '@/db'
import { appUrl, mailConfigured, sendMail } from '@/lib/mailer'
import { LOCK_MINUTES, PAIR_MAX_FAILURES } from '@/lib/loginGuard'

/**
 * Link de redefinição de senha por e-mail (uso único, 1 h). Fica FORA dos arquivos 'use server':
 * nada aqui pode ser chamado pelo navegador (antes sendResetLink era uma Server Action exportada sem autenticação).
 */

const RESET_TTL_MS = 60 * 60_000
/** no máximo 3 links por usuário em 24 h: bloqueios provocados de propósito não viram uma enxurrada de e-mails */
const RESET_DAILY_CAP = 3
/** tokens gerados aqui têm 43 caracteres (32 bytes em base64url); qualquer coisa muito maior é lixo */
const MAX_TOKEN_LEN = 128
const hashToken = (t: string) => createHash('sha256').update(t).digest('hex')
const pr = schema.passwordResets

/** Aviso de link inválido (só menciona o envio automático quando o e-mail está configurado). */
export const resetLinkInvalidMsg = () =>
  mailConfigured()
    ? `Link inválido, vencido ou já usado. Peça ao administrador para redefinir a senha (ou, após ${PAIR_MAX_FAILURES} tentativas erradas no login, um novo link é enviado ao seu e-mail).`
    : 'Link inválido, vencido ou já usado. Peça ao administrador para redefinir a senha.'

/** Já existe um link válido (não usado e não vencido) para este usuário? Evita um e-mail novo a cada bloqueio. */
async function hasValidResetLink(userId: number): Promise<boolean> {
  const r = await db.query.passwordResets.findFirst({
    columns: { id: true },
    where: and(eq(pr.userId, userId), isNull(pr.usedAt), gt(pr.expiresAt, new Date())),
  })
  return Boolean(r)
}

/** Motivo para NÃO enviar um link novo agora (null = pode enviar): já há um válido ou o limite de 24 h foi atingido. */
export async function resetLinkHold(userId: number): Promise<string | null> {
  if (await hasValidResetLink(userId)) return 'já havia um link válido'
  const [r] = await db
    .select({ n: count() })
    .from(pr)
    .where(and(eq(pr.userId, userId), gt(pr.createdAt, new Date(Date.now() - 86_400_000))))
  return (r?.n ?? 0) >= RESET_DAILY_CAP ? `limite de ${RESET_DAILY_CAP} links em 24 h` : null
}

/** Gera o link de redefinição (uso único, 1 h) e envia ao e-mail do usuário. false = e-mail não configurado/falhou. */
export async function sendResetLink(userId: number, email: string, name: string): Promise<boolean> {
  if (!mailConfigured()) return false
  const token = randomBytes(32).toString('base64url')
  const [row] = await db.insert(pr).values({ userId, tokenHash: hashToken(token), expiresAt: new Date(Date.now() + RESET_TTL_MS) }).returning({ id: pr.id })
  try {
    await sendMail({
      to: email,
      subject: 'Pacifil Load Planner — redefinir a senha',
      text:
        `Olá, ${name}.\n\n` +
        `Houve várias tentativas de entrar na sua conta com a senha errada e o acesso ficou bloqueado por ${LOCK_MINUTES} minutos (ou você pediu para redefinir a senha).\n` +
        `Depois desse prazo você pode entrar normalmente. Se esqueceu a senha, defina uma nova pelo link abaixo (vale 1 hora, uso único):\n\n` +
        `${appUrl()}/redefinir-senha?token=${token}\n\n` +
        `Se não foi você, avise o administrador.\n`,
    })
    return true
  } catch (e) {
    console.error('[reset link]', e)
    // o e-mail não saiu: o link não vale (e não impede o envio de outro no próximo bloqueio)
    if (row) await db.update(pr).set({ usedAt: new Date() }).where(eq(pr.id, row.id))
    return false
  }
}

/** Só consulta (não consome): a página mostra o aviso de link inválido sem pedir a senha nova. */
export async function resetTokenValid(token: string): Promise<boolean> {
  if (!token || token.length > MAX_TOKEN_LEN) return false
  const r = await db.query.passwordResets.findFirst({
    columns: { id: true },
    where: and(eq(pr.tokenHash, hashToken(token)), isNull(pr.usedAt), gt(pr.expiresAt, new Date())),
  })
  return Boolean(r)
}

/**
 * Consome o link de forma atômica (UPDATE … WHERE used_at IS NULL RETURNING: dois envios simultâneos não usam o
 * mesmo link) e grava a senha nova: desbloqueia a conta, derruba as sessões abertas e invalida outros links pendentes.
 */
export async function resetPasswordWithToken(token: string, passwordHash: string): Promise<{ userId: number } | 'invalid' | 'inactive'> {
  if (!token || token.length > MAX_TOKEN_LEN) return 'invalid'
  return db.transaction(async (tx) => {
    const now = new Date()
    const [r] = await tx
      .update(pr)
      .set({ usedAt: now })
      .where(and(eq(pr.tokenHash, hashToken(token)), isNull(pr.usedAt), gt(pr.expiresAt, now)))
      .returning({ userId: pr.userId })
    if (!r) return 'invalid'
    const u = schema.users
    const [ok] = await tx
      .update(u)
      .set({ passwordHash, mustChangePassword: false, sessionVersion: sql`${u.sessionVersion} + 1`, failedLogins: 0, lockedAt: null, updatedAt: now })
      .where(and(eq(u.id, r.userId), eq(u.active, true)))
      .returning({ id: u.id })
    if (!ok) return 'inactive'
    await tx.update(pr).set({ usedAt: now }).where(and(eq(pr.userId, r.userId), isNull(pr.usedAt)))
    return { userId: r.userId }
  })
}
