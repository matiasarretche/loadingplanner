import { describe, expect, it } from 'vitest'
import { allowedByLonaRule, citesLonaLine, isRuleLona, lonaForArea, lonaWidthM } from './lonaRule'

const cat = [
  { sku: 'LS-PAC-8X50-125-STD', name: 'Lona padrão 8 × 50 m × 125 µm' },
  { sku: 'LS-PAC-8X50-125-BPF', name: 'Lona BPF 8 × 50 m × 125 µm' },
  { sku: 'LS-PAC-14X50-125-STD', name: 'Lona padrão 14 × 50 m × 125 µm' },
  { sku: 'LS-PAC-14X50-125-BPF', name: 'Lona BPF 14 × 50 m × 125 µm' },
  { sku: 'LS-PAC-14X50-125-LP', name: 'Lona Plus 14 × 50 m × 125 µm' },
  { sku: 'LS-PAC-16X50-150-STD', name: 'Lona padrão 16 × 50 m × 150 µm' },
  { sku: 'LS-PAC-16X50-125', name: 'Lona BigSafe 16 × 50 m × 125 µm' },
]

describe('regra das lonas até 14 m', () => {
  it('largura pelo nome', () => {
    expect(lonaWidthM('Lona BPF 8 × 50 m × 125 µm')).toBe(8)
    expect(lonaWidthM('Lona Plus 14 × 50 m × 125 µm')).toBe(14)
  })
  it('só padrão/BPF/Plus de até 14 m', () => {
    expect(isRuleLona('Lona padrão 14 × 50 m × 125 µm')).toBe(true)
    expect(isRuleLona('Lona padrão 16 × 50 m × 150 µm')).toBe(false)
    expect(isRuleLona('Lona BigSafe 16 × 50 m × 125 µm')).toBe(false)
  })
  it('exportação = plana (padrão); mercado interno = BPF', () => {
    const ok = (area: 'EXPORT' | 'DOMESTIC') => cat.filter((c) => allowedByLonaRule(c.name, area)).map((c) => c.sku)
    expect(ok('EXPORT')).toEqual(['LS-PAC-8X50-125-STD', 'LS-PAC-14X50-125-STD', 'LS-PAC-16X50-150-STD', 'LS-PAC-16X50-125'])
    expect(ok('DOMESTIC')).toEqual(['LS-PAC-8X50-125-BPF', 'LS-PAC-14X50-125-BPF', 'LS-PAC-16X50-150-STD', 'LS-PAC-16X50-125'])
  })
  it('linha citada no pedido vale', () => {
    expect(citesLonaLine('lona BPF 8x50')).toBe(true)
    expect(citesLonaLine('lona plana 8x50')).toBe(true)
    expect(citesLonaLine('lona 8 x 50 125 micras')).toBe(false)
  })
  it('troca de área: equivalente da mesma medida', () => {
    expect(lonaForArea(cat[0], 'DOMESTIC', cat)?.sku).toBe('LS-PAC-8X50-125-BPF')
    expect(lonaForArea(cat[3], 'EXPORT', cat)?.sku).toBe('LS-PAC-14X50-125-STD')
    expect(lonaForArea(cat[0], 'EXPORT', cat)).toBeNull()
    expect(lonaForArea(cat[5], 'DOMESTIC', cat)).toBeNull()
  })
})
