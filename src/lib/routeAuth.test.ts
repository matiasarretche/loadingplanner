import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { CurrentUser } from './auth'

vi.mock('server-only', () => ({}))
const current = vi.hoisted(() => ({ user: null as CurrentUser | null }))
vi.mock('@/lib/auth', () => ({ getCurrentUser: async () => current.user }))

const { routeUser } = await import('./routeAuth')
const { BODY_LIMITS, fmtMB, intakeSizeError } = await import('@/components/intake/limits')

const user = (o: Partial<CurrentUser> = {}): CurrentUser => ({ id: 1, email: 'a@b.c', name: 'A', role: 'EXPORT_ASSISTANT', mustChangePassword: false, areas: ['EXPORT'], avatar: null, ...o })

describe('routeUser', () => {
  beforeEach(() => {
    current.user = null
  })

  it('sem sessão → 401 em JSON', async () => {
    const r = await routeUser()
    expect(r).toBeInstanceOf(Response)
    expect((r as Response).status).toBe(401)
    expect(await (r as Response).json()).toEqual({ ok: false, error: expect.stringContaining('Sessão expirada') })
  })

  it('senha temporária → 403 (salvo allowPendingPassword)', async () => {
    current.user = user({ mustChangePassword: true })
    const r = await routeUser()
    expect((r as Response).status).toBe(403)
    expect(await routeUser(undefined, { allowPendingPassword: true })).toMatchObject({ id: 1 })
  })

  it('sem permissão → 403 com a mensagem da rota (texto)', async () => {
    current.user = user({ role: 'WAREHOUSE_VIEWER' })
    const r = (await routeUser('viewPrices', { text: true, denied: 'Sem permissão para o PDF.' })) as Response
    expect(r.status).toBe(403)
    expect(await r.text()).toBe('Sem permissão para o PDF.')
  })

  it('com permissão → o usuário', async () => {
    current.user = user()
    expect(await routeUser('editPlans')).toMatchObject({ id: 1, role: 'EXPORT_ASSISTANT' })
  })
})

describe('limites de corpo', () => {
  it('cabem abaixo dos 4,5 MB da Vercel', () => {
    for (const k of ['intakeTotal', 'emailPdf', 'photoUpload', 'response'] as const) expect(BODY_LIMITS[k]).toBeLessThan(BODY_LIMITS.platform)
  })

  it('pedido para a IA: soma anexos + texto', () => {
    expect(intakeSizeError([{ size: 1_000_000 }, { size: 2_000_000 }], 'oi')).toBeNull()
    expect(intakeSizeError([{ size: 3_000_000 }, { size: 1_500_000 }])).toMatch(/máx\. 4 MB/)
  })

  it('fmtMB em pt-BR; para cima quando pedido', () => {
    expect(fmtMB(4 * 1024 * 1024)).toBe('4 MB')
    expect(fmtMB(4.2 * 1024 * 1024)).toBe('4,2 MB')
    expect(fmtMB(4.01 * 1024 * 1024, true)).toBe('4,1 MB')
  })
})
