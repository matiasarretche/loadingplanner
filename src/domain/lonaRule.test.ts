import { describe, expect, it } from 'vitest'
import { allowedByLonaRule, citesLonaLine, filterByLonaRule, isRuleLona, lonaForArea, lonaWidthM } from './lonaRule'

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

describe('regra das lonas com os nomes do catálogo oficial (códigos numéricos)', () => {
  const oficial = [
    { sku: '19712', name: 'Lona BPF 8 × 50 m × 150 µm (natural)' },
    { sku: '14412', name: 'Lona BPF 8 × 50 m × 125 µm' },
    { sku: '19867', name: 'Lona BPF Ecobag 8 × 50 m × 110 µm' },
    { sku: '19771', name: 'Lona padrão 8 × 100 m × 120 µm' },
    { sku: '19894', name: 'Lona Plus 14 × 50 m × 120 µm' },
    { sku: '18327', name: 'Lona BPF B/P 15 × 50 m × 100 µm' },
    { sku: '17774', name: 'Lona BigSafe 16 × 50 m × 125 µm' },
    { sku: '18116', name: 'Lona BigSafe 12 × 50 m × 125 µm' },
    { sku: '19524', name: 'Lona barreira O2 (PA) 10 × 50 m × 125 µm (poliamida)' },
    { sku: '18054', name: 'Filme BPF 1,5 × 600 m × 40 µm' },
  ]
  it('marca depois da linha e acabamento no fim não atrapalham a largura', () => {
    expect(lonaWidthM('Lona BPF Ecobag 8 × 50 m × 110 µm')).toBe(8)
    expect(lonaWidthM('Lona BPF 8 × 50 m × 150 µm (natural)')).toBe(8)
    expect(lonaWidthM('Lona padrão 12,2 × 45,72 m (40 × 150 pés) × 150 µm')).toBe(12.2)
    expect(isRuleLona('Lona BPF Ecobag 8 × 50 m × 110 µm')).toBe(true)
    expect(isRuleLona('Lona BPF 8 × 50 m × 150 µm (natural)')).toBe(true)
  })
  it('fora da regra: BigSafe, barreira PA, BPF acima de 14 m, filmes', () => {
    expect(isRuleLona('Lona BigSafe 12 × 50 m × 125 µm')).toBe(false)
    expect(isRuleLona('Lona barreira O2 (PA) 10 × 50 m × 125 µm (poliamida)')).toBe(false)
    expect(isRuleLona('Lona BPF B/P 15 × 50 m × 100 µm')).toBe(false)
    expect(isRuleLona('Filme BPF 1,5 × 600 m × 40 µm')).toBe(false)
  })
  it('exportação × mercado interno', () => {
    const ok = (area: 'EXPORT' | 'DOMESTIC') => oficial.filter((c) => allowedByLonaRule(c.name, area)).map((c) => c.sku)
    expect(ok('EXPORT')).toEqual(['19771', '18327', '17774', '18116', '19524', '18054'])
    expect(ok('DOMESTIC')).toEqual(['19712', '14412', '19867', '18327', '17774', '18116', '19524', '18054'])
  })
  it('troca de área com código numérico: equivalente pelo nome (mesma medida e marca) ou nenhum', () => {
    const cat = [...oficial, { sku: '19999', name: 'Lona padrão Ecobag 8 × 50 m × 110 µm' }]
    expect(lonaForArea(oficial[2], 'EXPORT', cat)?.sku).toBe('19999')
    expect(lonaForArea(cat[cat.length - 1], 'DOMESTIC', cat)?.sku).toBe('19867')
    // sem "Lona padrão 8 × 50 m × 150 µm (natural)" cadastrada: sem equivalente
    expect(lonaForArea(oficial[0], 'EXPORT', oficial)).toBeNull()
    expect(lonaForArea(oficial[3], 'EXPORT', oficial)).toBeNull()
  })
  it('busca: o código citado no pedido vale mesmo fora da linha da área', () => {
    const skus = (q: string, area: 'EXPORT' | 'DOMESTIC') => filterByLonaRule(oficial, area, q).map((c) => c.sku)
    // sem linha nem código: a regra tira as Lonas BPF da exportação
    expect(skus('lona 8x50 150', 'EXPORT')).not.toContain('19712')
    // código numérico citado: fica (só ele; as outras BPF continuam fora)
    expect(skus('19712', 'EXPORT')).toContain('19712')
    expect(skus('2 x 19712', 'EXPORT')).not.toContain('14412')
    // linha citada: catálogo inteiro
    expect(skus('lona bpf 8x50', 'EXPORT')).toHaveLength(oficial.length)
  })
  it('Lona BPF Plus X3 até 14 m segue a linha BPF (mercado interno): o X3 não atrapalha a largura', () => {
    expect(lonaWidthM('Lona BPF Plus X3 10 × 50 m × 125 µm')).toBe(10)
    expect(isRuleLona('Lona BPF Plus X3 10 × 50 m × 125 µm')).toBe(true)
    expect(allowedByLonaRule('Lona BPF Plus X3 10 × 50 m × 125 µm', 'DOMESTIC')).toBe(true)
    expect(allowedByLonaRule('Lona BPF Plus X3 10 × 50 m × 125 µm', 'EXPORT')).toBe(false)
  })
})
