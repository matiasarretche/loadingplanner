import { describe, expect, it } from 'vitest'
import { needsThickness, sortProducts } from './productOrder'

const sb = (sku: string, ft: number, m: number | null, um?: number, brand = 'Pacifil') => ({ sku, familyName: 'Silo-bolsa', familySort: 1, brand, attrs: { diametro_ft: ft, ...(m != null ? { comprimento_m: m } : {}) }, thicknessUm: um ?? null })

describe('ordem única de produtos (numérica, não alfabética)', () => {
  it('silo-bolsa: diâmetro → comprimento → espessura', () => {
    const list = [sb('SB-10X75', 10, 75, 220), sb('SB-5X60', 5, 60), sb('SB-12X60', 12, 60), sb('SB-9X60-254', 9, 60, 254), sb('SB-9X60-220', 9, 60, 220), sb('SB-9X100', 9, 100), sb('SB-6X60', 6, 60), sb('SB-14X60', 14, 60), sb('SB-8X60', 8, 60)]
    expect(sortProducts(list, (x) => x).map((x) => x.sku)).toEqual(['SB-5X60', 'SB-6X60', 'SB-8X60', 'SB-9X60-220', 'SB-9X60-254', 'SB-9X100', 'SB-10X75', 'SB-12X60', 'SB-14X60'])
  })
  it('comprimento em pés conta pelo valor em metros', () => {
    const list = [{ ...sb('SB-9X300FT', 9, null), attrs: { diametro_ft: 9, comprimento_ft: 300 } }, sb('SB-9X60', 9, 60), sb('SB-9X100', 9, 100)]
    expect(sortProducts(list, (x) => x).map((x) => x.sku)).toEqual(['SB-9X60', 'SB-9X300FT', 'SB-9X100'])
  })
  it('lona: largura → comprimento → espessura; hidrosilo por litros; famílias mantêm sua ordem', () => {
    const lona = (sku: string, w: number, m: number, um: number) => ({ sku, familyName: 'Lona de silagem', familySort: 2, attrs: { largura_m: w, comprimento_m: m }, thicknessUm: um })
    const hs = (sku: string, l: number) => ({ sku, familyName: 'Hidrosilo', familySort: 3, attrs: { capacidade_l: l } })
    const list = [hs('HS-20K', 20000), lona('LS-12X50', 12, 50, 150), hs('HS-5K', 5000), lona('LS-8X100', 8, 100, 150), lona('LS-8X50', 8, 50, 200), lona('LS-8X50-150', 8, 50, 150), sb('SB-9X60', 9, 60)]
    expect(sortProducts(list, (x) => x).map((x) => x.sku)).toEqual(['SB-9X60', 'LS-8X50-150', 'LS-8X50', 'LS-8X100', 'LS-12X50', 'HS-5K', 'HS-20K'])
  })
  it('hidrosilo: largura (2 m antes de 3 m) e depois capacidade', () => {
    const hs = (sku: string, w: number, l: number) => ({ sku, familyName: 'Hidrosilo', familySort: 3, attrs: { largura_m: w, capacidade_l: l } })
    const list = [hs('HS-3M-5K', 3, 5000), hs('HS-2M-20K', 2, 20000), hs('HS-3M-20K', 3, 20000), hs('HS-2M-0.5K', 2, 500), hs('HS-3M-10K', 3, 10000), hs('HS-2M-5K', 2, 5000)]
    expect(sortProducts(list, (x) => x).map((x) => x.sku)).toEqual(['HS-2M-0.5K', 'HS-2M-5K', 'HS-2M-20K', 'HS-3M-5K', 'HS-3M-10K', 'HS-3M-20K'])
  })
  it('mesma medida: Pacifil antes das outras marcas', () => {
    expect(sortProducts([sb('SB-ECO-9X60', 9, 60, 220, 'EcoBag'), sb('SB-9X60', 9, 60, 220)], (x) => x).map((x) => x.sku)).toEqual(['SB-9X60', 'SB-ECO-9X60'])
  })
  it('espessura obrigatória nos filmes; não nos acessórios', () => {
    expect(needsThickness('Silo-bolsa')).toBe(true)
    expect(needsThickness('Lona de silagem')).toBe(true)
    expect(needsThickness('Acessórios')).toBe(false)
  })
})

describe('campos técnicos exigidos por família', () => {
  it('silo exige diâmetro, comprimento (m ou pés) e espessura; lona/hidro largura e comprimento', async () => {
    const { missingFields } = await import('./productOrder')
    expect(missingFields('Silo-bolsa', { diameterFt: 9, lengthFt: 300, thicknessUm: 250 })).toEqual([])
    expect(missingFields('Silo-bolsa', { diameterFt: 5 })).toEqual(['length', 'thicknessUm'])
    expect(missingFields('Lona de silagem', { widthM: 8, lengthM: 50 })).toEqual(['thicknessUm'])
    expect(missingFields('Hidrosilo', { lengthM: 10, thicknessUm: 600 })).toEqual(['widthM'])
    expect(missingFields('Animal Comfort', { widthM: 1.2, lengthM: 30 })).toEqual([])
    expect(missingFields('Acessórios', {})).toEqual([])
  })
})
