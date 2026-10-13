import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { APP_TZ, dateBR, dayBR, dt, dtSec } from './format'

// datas exibidas sempre em São Paulo, mesmo com o processo em UTC (como na Vercel) ou em outro fuso
describe('datas em hora de São Paulo', () => {
  const tz = process.env.TZ
  beforeAll(() => {
    process.env.TZ = 'UTC'
  })
  afterAll(() => {
    if (tz === undefined) delete process.env.TZ
    else process.env.TZ = tz
  })

  // 02:30 UTC de 13/10 = 23:30 de 12/10 em São Paulo (UTC−3)
  const instant = new Date('2026-10-13T02:30:05Z')

  it('o processo de teste está mesmo em UTC', () => {
    expect(instant.getHours()).toBe(2)
    expect(APP_TZ).toBe('America/Sao_Paulo')
  })

  it('dt(): data e hora curtas', () => {
    expect(dt(new Date('2026-10-13T02:30:00Z'))).toMatch(/^12\/10\/2026,? 23:30$/)
    expect(dt(instant)).toMatch(/^12\/10\/2026,? 23:30$/)
    expect(dt('2026-10-13T02:30:05.000Z')).toBe(dt(instant))
  })

  it('dtSec(): com segundos', () => {
    expect(dtSec(instant)).toMatch(/^12\/10\/2026,? 23:30:05$/)
  })

  it('dateBR() e dayBR(): o dia é o de São Paulo', () => {
    expect(dateBR(instant)).toBe('12/10/2026')
    expect(dayBR(instant)).toBe('2026-10-12')
    expect(dayBR('2026-10-13T02:30:05.000Z')).toBe('2026-10-12')
  })

  it("dia sem hora ('AAAA-MM-DD') não muda de dia", () => {
    expect(dt('2026-10-12')).toBe('12/10/2026')
    expect(dateBR('2026-10-12')).toBe('12/10/2026')
    expect(dayBR('2026-10-12')).toBe('2026-10-12')
  })

  it('vazio ou inválido', () => {
    expect(dt(null)).toBe('—')
    expect(dt(undefined)).toBe('—')
    expect(dt('')).toBe('—')
    expect(dt('não é data')).toBe('—')
    expect(dtSec(new Date(Number.NaN))).toBe('—')
    expect(dateBR(null)).toBe('—')
    expect(dayBR(null)).toBe('')
  })
})
