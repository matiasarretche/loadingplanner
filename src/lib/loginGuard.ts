/**
 * Regras do login exposto à internet (sem dependências de servidor: serve às telas e aos testes).
 * - Bloqueio por CONTA + ENDEREÇO (IP): na 4ª senha errada em 15 minutos, aquela conta fica bloqueada para aquele
 *   endereço (até 15 minutos) e o dono recebe o link de redefinição. Os outros endereços — o do dono legítimo —
 *   continuam entrando: errar a senha de propósito não tranca a conta de ninguém (decisão do dono: bloqueio temporário).
 * - Bloqueio da CONTA inteira (locked_at, 15 minutos): só com ACCOUNT_MAX_FAILURES senhas erradas em 15 minutos somando
 *   todos os endereços (ataque distribuído). Um navegador onde a conta já entrou (cookie de dispositivo) não é barrado por ele.
 * - Limite por IP: no máximo IP_MAX_ATTEMPTS tentativas sem sucesso em 15 minutos por endereço (contas existentes ou não).
 * - Toda tentativa é RESERVADA na auditoria antes do bcrypt e só então contada: tentativas simultâneas não furam os limites.
 * - Trocar/redefinir a senha (versão da sessão +1) zera as contagens da conta.
 * - Mensagem única para e-mail desconhecido, senha errada e bloqueio (não revela quais e-mails existem).
 */

export const LOCK_MINUTES = 15
export const LOCK_MS = LOCK_MINUTES * 60_000
/** janela das contagens (conta+endereço, conta inteira e IP) */
export const WINDOW_MS = LOCK_MS

/** senhas erradas por conta+endereço na janela: a 4ª bloqueia aquele endereço para a conta */
export const PAIR_MAX_FAILURES = 4
/** senhas erradas na conta inteira (todos os endereços) na janela: bloqueia a conta por 15 minutos */
export const ACCOUNT_MAX_FAILURES = 30
/** tentativas sem sucesso por endereço na janela */
export const IP_MAX_ATTEMPTS = 20

/** entidade/ações das tentativas de login na auditoria (entity_id = chave do endereço; diff = { ip, sv }) */
export const LOGIN_AUDIT_ENTITY = 'login'
/** tentativa reservada / senha errada / e-mail desconhecido: conta em todos os limites */
export const LOGIN_AUDIT_FAIL = 'fail'
/** recusada por um limite sem conferir a senha: conta só no limite por IP */
export const LOGIN_AUDIT_BLOCKED = 'blocked'
/** login certo: não conta e zera a sequência conta+endereço */
export const LOGIN_AUDIT_OK = 'ok'

/** "endereço" das tentativas sem IP conhecido (não acontece na Vercel): vira o bloqueio por conta de antes */
export const UNKNOWN_IP = 'desconhecido'

export const LOGIN_FAILED_MSG = 'E-mail ou senha incorretos — ou acesso bloqueado por 15 minutos após muitas tentativas.'

/** O bloqueio da conta inteira ainda vale? (aplicado há menos de 15 minutos) */
export function isLockActive(lockedAt: Date | null | undefined, now: Date = new Date()): boolean {
  return lockedAt != null && now.getTime() - lockedAt.getTime() < LOCK_MS
}

/** Minutos que faltam para o bloqueio da conta acabar (0 = sem bloqueio em vigor). */
export function lockMinutesLeft(lockedAt: Date | null | undefined, now: Date = new Date()): number {
  return isLockActive(lockedAt, now) ? Math.ceil((lockedAt!.getTime() + LOCK_MS - now.getTime()) / 60_000) : 0
}

/** Corte: bloqueios com locked_at <= este instante estão vencidos. */
export const lockCutoff = (now: Date = new Date()) => new Date(now.getTime() - LOCK_MS)

/** Pré-checagem barata (antes de reservar): o IP já gastou as tentativas da janela? */
export const ipThrottled = (attemptsBefore: number) => attemptsBefore >= IP_MAX_ATTEMPTS

/** Contagens na janela, JÁ incluindo a tentativa atual (reservada antes da contagem). */
export interface LoginCounts {
  /** tentativas sem sucesso deste endereço (qualquer conta) */
  ip: number
  /** senhas erradas desta conta a partir deste endereço, desde o último login certo dele */
  pair: number
  /** senhas erradas desta conta, todos os endereços */
  account: number
}

export type LoginGate = 'ip' | 'pair' | 'account' | null

/**
 * Esta tentativa pode conferir a senha? null = pode; senão, o limite que a barra.
 * Como cada contagem inclui a própria reserva, no máximo N tentativas por janela passam por cada limite,
 * mesmo disparadas em paralelo.
 */
export function loginGate(n: LoginCounts, o: { ipKnown: boolean; accountLocked: boolean; knownDevice: boolean }): LoginGate {
  if (o.ipKnown && n.ip > IP_MAX_ATTEMPTS) return 'ip'
  if (n.pair > PAIR_MAX_FAILURES) return 'pair'
  if (!o.knownDevice && (o.accountLocked || n.account > ACCOUNT_MAX_FAILURES)) return 'account'
  return null
}

/** Depois de uma senha errada conferida: esta tentativa bloqueia o par conta+endereço (a 4ª) e/ou a conta inteira? */
export function lockAfterWrong(n: LoginCounts): { pair: boolean; account: boolean } {
  return { pair: n.pair >= PAIR_MAX_FAILURES, account: n.account >= ACCOUNT_MAX_FAILURES }
}

/**
 * IP do cliente: 1º endereço de x-forwarded-for (na Vercel é o cliente real; a plataforma sobrescreve o cabeçalho)
 * ou x-real-ip. Só aceita caracteres de IPv4/IPv6 — o valor vai para a auditoria e para a consulta. null = desconhecido.
 */
export function clientIp(h: { get(name: string): string | null }): string | null {
  const ip = h.get('x-forwarded-for')?.split(',')[0]?.trim() || h.get('x-real-ip')?.trim() || ''
  return /^[0-9a-fA-F:.]{2,45}$/.test(ip) ? ip.toLowerCase() : null
}

/**
 * Chave inteira estável do IP (FNV-1a de 31 bits) gravada em audit_log.entity_id: assim a contagem por IP usa o
 * índice (entity, entity_id). Colisões são filtradas comparando também diff->>'ip'.
 */
export function ipKey(ip: string): number {
  let h = 0x811c9dc5
  for (let i = 0; i < ip.length; i++) {
    h ^= ip.charCodeAt(i)
    h = Math.imul(h, 0x01000193)
  }
  return (h >>> 0) & 0x7fffffff
}
