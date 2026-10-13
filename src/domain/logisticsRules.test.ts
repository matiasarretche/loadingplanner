import { describe, expect, it } from 'vitest'
import { countryCode, resolveLogistics, withRuleLimit, RULE_LIMIT_PROFILE_ID } from './logisticsRules'

const r = (mode: 'SEA' | 'ROAD' | 'AIR', destination: string) => resolveLogistics({ mode, destination })

describe('regras logísticas (precedência: modalidade → destino → específica)', () => {
  it('normaliza países', () => {
    expect(countryCode('Estados Unidos')).toBe('US')
    expect(countryCode('EE.UU.')).toBe('US')
    expect(countryCode('USA')).toBe('US')
    expect(countryCode('Uruguay')).toBe('UY')
    expect(countryCode('uruguai')).toBe('UY')
    expect(countryCode('Brasil')).toBe('BR')
    expect(countryCode('Argentina')).toBe('AR')
    expect(countryCode('Atlântida')).toBeNull()
  })
  it('marítimo + Estados Unidos = palete 1,15 × 1,15 e 19.900 kg', () => {
    const x = r('SEA', 'Estados Unidos')
    expect(x.palletTypeCodes?.[0]).toBe('PCF-1150')
    expect(x.maxCargoKg).toBe(19900)
    expect(x.source).toEqual({ pallet: 'sea-default', maxCargoKg: 'sea-us' })
  })
  it('marítimo + Argentina / Uruguai = 1,15 × 1,15 e 27.000 kg (o limite de 28 t do Uruguai é só rodoviário)', () => {
    for (const d of ['Argentina', 'Uruguay']) {
      const x = r('SEA', d)
      expect(x.palletTypeCodes?.[0]).toBe('PCF-1150')
      expect(x.maxCargoKg).toBe(27000)
    }
  })
  it('carreta interna Brasil = palete 1,00 × 1,20 e 32.000 kg', () => {
    const x = r('ROAD', 'Brasil')
    expect(x.palletTypeCodes).toEqual(['PBR-1'])
    expect(x.maxCargoKg).toBe(32000)
  })
  it('carreta para Uruguai = 28.000 kg', () => {
    expect(r('ROAD', 'Uruguay').maxCargoKg).toBe(28000)
  })
  it('sem regra (aéreo): nada imposto', () => {
    const x = r('AIR', 'Estados Unidos')
    expect(x.palletTypeCodes).toBeNull()
    expect(x.maxCargoKg).toBeNull()
  })
  it('o limite da regra vira um perfil de restrição (substitui o anterior da regra)', () => {
    const a = withRuleLimit([], r('SEA', 'USA'))
    expect(a).toHaveLength(1)
    expect(a[0]).toMatchObject({ profileId: RULE_LIMIT_PROFILE_ID, maxPayloadKg: 19900 })
    const b = withRuleLimit(a, r('SEA', 'Argentina'))
    expect(b).toHaveLength(1)
    expect(b[0].maxPayloadKg).toBe(27000)
  })
})
