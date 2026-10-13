import { describe, expect, it } from 'vitest'
import {
  ACCOUNT_MAX_FAILURES,
  clientIp,
  IP_MAX_ATTEMPTS,
  ipKey,
  ipThrottled,
  isLockActive,
  LOCK_MINUTES,
  LOCK_MS,
  lockAfterWrong,
  lockCutoff,
  lockMinutesLeft,
  LOGIN_FAILED_MSG,
  loginGate,
  PAIR_MAX_FAILURES,
  WINDOW_MS,
} from './loginGuard'

const at = (iso: string) => new Date(iso)
const hdr = (o: Record<string, string>) => ({ get: (k: string) => o[k.toLowerCase()] ?? null })
const free = { ipKnown: true, accountLocked: false, knownDevice: false }

describe('bloqueio temporário da conta inteira', () => {
  const now = at('2026-10-13T12:00:00Z')
  it('sem bloqueio', () => {
    expect(isLockActive(null, now)).toBe(false)
    expect(isLockActive(undefined, now)).toBe(false)
  })
  it('vale por 15 minutos', () => {
    expect(LOCK_MS).toBe(15 * 60_000)
    expect(WINDOW_MS).toBe(LOCK_MS)
    expect(isLockActive(at('2026-10-13T12:00:00Z'), now)).toBe(true)
    expect(isLockActive(at('2026-10-13T11:45:00.001Z'), now)).toBe(true)
  })
  it('vence com 15 minutos ou mais (bloqueios antigos, "permanentes", também vencem)', () => {
    expect(isLockActive(at('2026-10-13T11:45:00Z'), now)).toBe(false)
    expect(isLockActive(at('2026-09-01T08:00:00Z'), now)).toBe(false)
  })
  it('corte coerente com isLockActive', () => {
    const cut = lockCutoff(now)
    expect(cut.toISOString()).toBe('2026-10-13T11:45:00.000Z')
    expect(isLockActive(cut, now)).toBe(false)
    expect(isLockActive(new Date(cut.getTime() + 1), now)).toBe(true)
  })
  it('minutos restantes (tela de usuários)', () => {
    expect(lockMinutesLeft(null, now)).toBe(0)
    expect(lockMinutesLeft(at('2026-10-13T12:00:00Z'), now)).toBe(15)
    expect(lockMinutesLeft(at('2026-10-13T11:50:30Z'), now)).toBe(6)
    expect(lockMinutesLeft(at('2026-10-13T11:45:00.001Z'), now)).toBe(1)
    expect(lockMinutesLeft(at('2026-10-13T11:45:00Z'), now)).toBe(0)
  })
  it('mensagem genérica única, coerente com o prazo', () => {
    expect(LOGIN_FAILED_MSG).toContain(`${LOCK_MINUTES} minutos`)
    expect(LOGIN_FAILED_MSG).toBe('E-mail ou senha incorretos — ou acesso bloqueado por 15 minutos após muitas tentativas.')
  })
})

describe('limites com a tentativa já reservada na contagem', () => {
  const n = (ip: number, pair: number, account: number) => ({ ip, pair, account })
  it('conta+endereço: até a 4ª senha é conferida; a 4ª errada bloqueia; a 5ª nem é conferida', () => {
    expect(PAIR_MAX_FAILURES).toBe(4)
    expect(loginGate(n(1, 1, 1), free)).toBeNull()
    expect(loginGate(n(4, 4, 4), free)).toBeNull()
    expect(lockAfterWrong(n(3, 3, 3)).pair).toBe(false)
    expect(lockAfterWrong(n(4, 4, 4)).pair).toBe(true)
    expect(loginGate(n(5, 5, 5), free)).toBe('pair')
  })
  it('rajada em paralelo: cada reserva enxerga as anteriores, então só 4 passam', () => {
    // 50 tentativas simultâneas: a k-ésima reserva gravada conta pelo menos k
    const passed = Array.from({ length: 50 }, (_, i) => loginGate(n(i + 1, i + 1, i + 1), { ...free, ipKnown: false })).filter((g) => g === null)
    expect(passed).toHaveLength(PAIR_MAX_FAILURES)
  })
  it('outro endereço (o dono) continua entrando enquanto o atacante está bloqueado', () => {
    expect(loginGate(n(1, 1, 12), free)).toBeNull()
  })
  it('conta inteira: só com muitas senhas erradas somando os endereços', () => {
    expect(ACCOUNT_MAX_FAILURES).toBe(30)
    expect(loginGate(n(1, 1, ACCOUNT_MAX_FAILURES), free)).toBeNull()
    expect(lockAfterWrong(n(1, 1, ACCOUNT_MAX_FAILURES - 1)).account).toBe(false)
    expect(lockAfterWrong(n(1, 1, ACCOUNT_MAX_FAILURES)).account).toBe(true)
    expect(loginGate(n(1, 1, ACCOUNT_MAX_FAILURES + 1), free)).toBe('account')
    expect(loginGate(n(1, 1, 1), { ...free, accountLocked: true })).toBe('account')
  })
  it('dispositivo conhecido passa pelo bloqueio da conta, não pelo par nem pelo IP', () => {
    const dev = { ...free, knownDevice: true }
    expect(loginGate(n(1, 1, 99), { ...dev, accountLocked: true })).toBeNull()
    expect(loginGate(n(5, 5, 5), dev)).toBe('pair')
    expect(loginGate(n(IP_MAX_ATTEMPTS + 1, 1, 1), dev)).toBe('ip')
  })
})

describe('limite por IP', () => {
  it('20 tentativas sem sucesso na janela', () => {
    expect(IP_MAX_ATTEMPTS).toBe(20)
    expect(ipThrottled(19)).toBe(false)
    expect(ipThrottled(20)).toBe(true)
    expect(loginGate({ ip: 20, pair: 0, account: 0 }, free)).toBeNull()
    expect(loginGate({ ip: 21, pair: 0, account: 0 }, free)).toBe('ip')
    // IP desconhecido (fora da Vercel): sem limite por IP, vale o limite por conta
    expect(loginGate({ ip: 99, pair: 1, account: 1 }, { ...free, ipKnown: false })).toBeNull()
  })
  it('IP do cliente: 1º de x-forwarded-for, depois x-real-ip', () => {
    expect(clientIp(hdr({ 'x-forwarded-for': '203.0.113.7, 10.0.0.1' }))).toBe('203.0.113.7')
    expect(clientIp(hdr({ 'x-forwarded-for': ' 2001:DB8::1 ' }))).toBe('2001:db8::1')
    expect(clientIp(hdr({ 'x-real-ip': '198.51.100.2' }))).toBe('198.51.100.2')
    expect(clientIp(hdr({ 'x-forwarded-for': '', 'x-real-ip': '::1' }))).toBe('::1')
  })
  it('valores estranhos ou ausentes → null', () => {
    expect(clientIp(hdr({}))).toBeNull()
    expect(clientIp(hdr({ 'x-forwarded-for': "1.2.3.4'; drop table x" }))).toBeNull()
    expect(clientIp(hdr({ 'x-forwarded-for': 'unknown' }))).toBeNull()
    expect(clientIp(hdr({ 'x-forwarded-for': '1'.repeat(60) }))).toBeNull()
  })
  it('chave do IP: inteiro positivo de 31 bits, estável', () => {
    for (const ip of ['203.0.113.7', '::1', '2001:db8::1', '255.255.255.255', 'desconhecido']) {
      const k = ipKey(ip)
      expect(Number.isInteger(k)).toBe(true)
      expect(k).toBeGreaterThanOrEqual(0)
      expect(k).toBeLessThanOrEqual(0x7fffffff)
      expect(ipKey(ip)).toBe(k)
    }
    expect(ipKey('203.0.113.7')).not.toBe(ipKey('203.0.113.8'))
  })
})
