'use server'

import bcrypt from 'bcryptjs'
import { and, eq, isNull, lte, or, sql } from 'drizzle-orm'
import { headers } from 'next/headers'
import { redirect } from 'next/navigation'
import { after } from 'next/server'
import { db, schema } from '@/db'
import { assertUser } from '@/lib/auth'
import { createSession, deleteSession, knownDeviceUid, rememberDevice } from '@/lib/session'
import { logAudit } from '@/lib/audit'
import {
  clientIp,
  ipKey,
  ipThrottled,
  isLockActive,
  LOCK_MINUTES,
  lockAfterWrong,
  lockCutoff,
  LOGIN_AUDIT_BLOCKED,
  LOGIN_AUDIT_ENTITY,
  LOGIN_AUDIT_FAIL,
  LOGIN_AUDIT_OK,
  LOGIN_FAILED_MSG,
  loginGate,
  type LoginCounts,
  UNKNOWN_IP,
  WINDOW_MS,
} from '@/lib/loginGuard'
import { resetLinkHold, resetLinkInvalidMsg, resetPasswordWithToken, resetTokenValid, sendResetLink } from '@/lib/passwordReset'

// Arquivo 'use server': TODA função exportada vira endpoint público. Só exportar as ações chamadas pelas telas;
// os auxiliares abaixo (não exportados) e o envio do link (src/lib/passwordReset.ts) ficam fora do alcance do navegador.

let dummyHash: string | undefined

export interface FormState {
  error?: string
  ok?: string
}

const users = schema.users
const audit = schema.auditLog

type LoginUser = typeof users.$inferSelect

/**
 * Contagens da janela de 15 min (regras em src/lib/loginGuard.ts), numa consulta só:
 * - ip: tentativas sem sucesso deste endereço ('fail' + 'blocked');
 * - pair: senhas erradas desta conta a partir deste endereço desde o último login certo dele;
 * - account: senhas erradas desta conta vindas de qualquer endereço.
 * Só valem as falhas contra a senha atual (diff.sv = versão da sessão): trocar/redefinir a senha zera a conta.
 * Usa os índices audit_log(entity, entity_id) — entity_id = chave do endereço — e audit_log(user_id, at).
 */
async function countAttempts(origin: string, u: LoginUser | undefined, now: Date): Promise<LoginCounts> {
  const since = new Date(now.getTime() - WINDOW_MS)
  const k = ipKey(origin)
  const uid = u?.id ?? null
  const sv = u ? String(u.sessionVersion) : null
  const r = await db.execute<{ ip: string; pair: string; account: string }>(sql`
    select
      count(*) filter (where entity_id = ${k} and diff->>'ip' = ${origin} and action in (${LOGIN_AUDIT_FAIL}, ${LOGIN_AUDIT_BLOCKED})) as ip,
      count(*) filter (
        where entity_id = ${k} and diff->>'ip' = ${origin} and user_id = ${uid} and action = ${LOGIN_AUDIT_FAIL} and diff->>'sv' = ${sv}
          and at > coalesce((
            select max(o.at) from audit_log o
            where o.entity = ${LOGIN_AUDIT_ENTITY} and o.entity_id = ${k} and o.action = ${LOGIN_AUDIT_OK}
              and o.user_id = ${uid} and o.diff->>'ip' = ${origin} and o.at >= ${since}
          ), '-infinity')
      ) as pair,
      count(*) filter (where user_id = ${uid} and action = ${LOGIN_AUDIT_FAIL} and diff->>'sv' = ${sv}) as account
    from audit_log
    where entity = ${LOGIN_AUDIT_ENTITY} and at >= ${since} and (entity_id = ${k} or user_id = ${uid})
  `)
  const row = r.rows[0]
  return { ip: Number(row?.ip ?? 0), pair: Number(row?.pair ?? 0), account: Number(row?.account ?? 0) }
}

/** Reserva a tentativa ANTES do bcrypt: vale como falha (em todos os limites) até a senha conferir. */
async function reserveAttempt(origin: string, u: LoginUser | undefined): Promise<number> {
  const [row] = await db
    .insert(audit)
    .values({ entity: LOGIN_AUDIT_ENTITY, entityId: ipKey(origin), action: LOGIN_AUDIT_FAIL, userId: u?.id ?? null, diff: { ip: origin, sv: u?.sessionVersion } })
    .returning({ id: audit.id })
  return row.id
}

/** Fecha a reserva: 'ok' (login certo) ou 'blocked' (recusada por um limite, sem valer como senha errada). */
async function finishAttempt(id: number, action: typeof LOGIN_AUDIT_OK | typeof LOGIN_AUDIT_BLOCKED, motivo?: string) {
  await db
    .update(audit)
    .set(motivo ? { action, diff: sql`coalesce(${audit.diff}, '{}'::jsonb) || ${JSON.stringify({ motivo })}::jsonb` } : { action })
    .where(eq(audit.id, id))
}

/** Depois da resposta: link de redefinição (se o e-mail estiver configurado e dentro dos limites) + auditoria. */
async function notifyLock(u: LoginUser, scope: 'conta+endereço' | 'conta', tries: number, ip: string | null) {
  let resetLinkSent: boolean | string = false
  try {
    resetLinkSent = (await resetLinkHold(u.id)) ?? (await sendResetLink(u.id, u.email, u.name))
  } catch (e) {
    console.error('[login bloqueado]', e)
  }
  await logAudit('user', u.id, 'login_locked', u.id, { scope, tries, ip, resetLinkSent, minutes: LOCK_MINUTES })
}

/** Bloqueia a conta inteira por 15 min (muitas senhas erradas de vários endereços); só quem efetivamente bloqueia avisa. */
async function lockAccount(u: LoginUser, failures: number, ip: string | null, now: Date) {
  const [locked] = await db
    .update(users)
    .set({ lockedAt: now, failedLogins: failures })
    .where(and(eq(users.id, u.id), or(isNull(users.lockedAt), lte(users.lockedAt, lockCutoff(now)))))
    .returning({ id: users.id })
  // as sessões abertas continuam (senão qualquer um derrubaria o usuário legítimo errando a senha dele)
  if (locked) after(() => notifyLock(u, 'conta', failures, ip))
}

export async function loginAction(_: FormState, fd: FormData): Promise<FormState> {
  const email = String(fd.get('email') ?? '').trim().toLowerCase()
  const password = String(fd.get('password') ?? '')
  if (!email || !password) return { error: 'Informe e-mail e senha.' }
  const ip = clientIp(await headers())
  const origin = ip ?? UNKNOWN_IP
  const now = new Date()
  // IP que já gastou as tentativas da janela: recusa sem consultar a conta, sem bcrypt e sem gravar nada
  if (ip && ipThrottled((await countAttempts(origin, undefined, now)).ip)) return { error: LOGIN_FAILED_MSG }
  const u = await db.query.users.findFirst({ where: eq(users.email, email) })
  // reserva ANTES do bcrypt e só então conta (a reserva entra na contagem): tentativas simultâneas não furam os limites
  const attemptId = await reserveAttempt(origin, u)
  const n = await countAttempts(origin, u, now)
  const knownDevice = u != null && (await knownDeviceUid()) === u.id
  const gate = loginGate(n, { ipKnown: ip != null, accountLocked: u != null && isLockActive(u.lockedAt, now), knownDevice })
  if (gate === 'ip') {
    await finishAttempt(attemptId, LOGIN_AUDIT_BLOCKED, gate)
    return { error: LOGIN_FAILED_MSG }
  }
  // compara sempre (e-mail desconhecido, conta bloqueada…) para o tempo de resposta não revelar nada
  dummyHash ??= await bcrypt.hash('dummy-password', 12)
  const ok = await bcrypt.compare(password, u?.passwordHash ?? dummyHash)
  // bloqueio conta+endereço ou da conta inteira: recusa mesmo com a senha certa (a tentativa não vale como senha errada)
  if (gate) {
    await finishAttempt(attemptId, LOGIN_AUDIT_BLOCKED, gate)
    if (gate === 'account' && u && !isLockActive(u.lockedAt, now)) await lockAccount(u, n.account, ip, now)
    return { error: LOGIN_FAILED_MSG }
  }
  // e-mail desconhecido ou conta inativa: a reserva fica como falha
  if (!u || !u.active) return { error: LOGIN_FAILED_MSG }
  if (!ok) {
    const lock = lockAfterWrong(n)
    if (lock.account) await lockAccount(u, n.account, ip, now)
    // 4ª senha errada deste endereço: o dono recebe o link (no máximo um válido por vez e 3 por dia)
    else if (lock.pair) after(() => notifyLock(u, 'conta+endereço', n.pair, ip))
    return { error: LOGIN_FAILED_MSG }
  }
  // senha certa: confirma no banco (o registro foi lido antes do bcrypt) que a conta segue ativa, com a mesma senha
  // e sem bloqueio aplicado por uma tentativa simultânea; só então abre a sessão
  const [fresh] = await db
    .update(users)
    .set({ failedLogins: 0 })
    .where(
      and(
        eq(users.id, u.id),
        eq(users.active, true),
        eq(users.sessionVersion, u.sessionVersion),
        knownDevice ? undefined : or(isNull(users.lockedAt), lte(users.lockedAt, lockCutoff(new Date()))),
      ),
    )
    .returning({ id: users.id })
  if (!fresh) {
    await finishAttempt(attemptId, LOGIN_AUDIT_BLOCKED, 'account')
    return { error: LOGIN_FAILED_MSG }
  }
  await finishAttempt(attemptId, LOGIN_AUDIT_OK)
  await rememberDevice(u.id)
  await createSession({ uid: u.id, role: u.role, sv: u.sessionVersion })
  redirect(u.mustChangePassword ? '/conta/senha' : '/')
}

export async function logoutAction() {
  await deleteSession()
  redirect('/login')
}

export async function changePasswordAction(_: FormState, fd: FormData): Promise<FormState> {
  const me = await assertUser(undefined, { allowPendingPassword: true })
  const current = String(fd.get('current') ?? '')
  const next = String(fd.get('next') ?? '')
  const confirm = String(fd.get('confirm') ?? '')
  const u = await db.query.users.findFirst({ where: eq(users.id, me.id) })
  if (!u || !(await bcrypt.compare(current, u.passwordHash))) return { error: 'Senha atual incorreta.' }
  if (next.length < 10) return { error: 'A nova senha deve ter pelo menos 10 caracteres.' }
  if (next !== confirm) return { error: 'A confirmação não confere.' }
  if (next === current) return { error: 'A nova senha deve ser diferente da atual.' }
  // nova senha: TODAS as sessões abertas caem (versão da sessão +1); esta continua com a versão nova
  const sv = u.sessionVersion + 1
  await db
    .update(users)
    .set({ passwordHash: await bcrypt.hash(next, 12), mustChangePassword: false, sessionVersion: sv, failedLogins: 0, lockedAt: null, updatedAt: new Date(), updatedBy: me.id })
    .where(eq(users.id, me.id))
  await createSession({ uid: u.id, role: u.role, sv })
  redirect('/')
}

/** Redefinição pelo link do e-mail: nova senha, desbloqueia a conta e derruba as sessões abertas. */
export async function resetWithTokenAction(_: FormState, fd: FormData): Promise<FormState> {
  const token = String(fd.get('token') ?? '')
  const next = String(fd.get('next') ?? '')
  const confirm = String(fd.get('confirm') ?? '')
  if (!token) return { error: 'Link inválido.' }
  // consulta antes de calcular o hash (link inválido não gasta bcrypt); o consumo atômico vem depois
  if (!(await resetTokenValid(token))) return { error: resetLinkInvalidMsg() }
  if (next.length < 10) return { error: 'A nova senha deve ter pelo menos 10 caracteres.' }
  if (next !== confirm) return { error: 'A confirmação não confere.' }
  const r = await resetPasswordWithToken(token, await bcrypt.hash(next, 12))
  if (r === 'invalid') return { error: resetLinkInvalidMsg() }
  if (r === 'inactive') return { error: 'Usuário inativo.' }
  await logAudit('user', r.userId, 'reset_password_link', r.userId)
  return { ok: 'Senha redefinida. Entre com a nova senha.' }
}
