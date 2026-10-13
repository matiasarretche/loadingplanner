import { describe, expect, it } from 'vitest'
import { detectBrand, extractNumbers, isUnambiguous, rankProducts, resolveProducts } from './productMatch'

const hs = [500, 1000, 2000, 5000, 10000, 15000, 20000, 25000, 30000, 40000, 50000].map((l) => ({
  sku: l < 1000 ? `HS-${l}L` : `HS-${l / 1000}K`,
  name: `Hidrosilo ${l.toLocaleString('pt-BR')} L`,
  family: 'Hidrosilo',
  line: 'Hidrosilo',
  attrs: { capacidade_l: l },
}))
const items = [
  ...hs,
  { sku: 'HF-10K', name: 'Hydroforce 10.000 L', family: 'Hydroforce', line: 'Hydroforce', attrs: { capacidade_l: 10000 } },
  { sku: 'SB-9x75', name: 'Silo-bolsa 9 pés × 75 m', family: 'Silo-bolsa', line: 'Silo-bolsa', attrs: { diametro_ft: 9, comprimento_m: 75 } },
]

const top = (q: string, list = items) => rankProducts(q, list)[0]?.item.sku

describe('identificação de produtos', () => {
  it('números em várias formas', () => {
    expect(extractNumbers('Hidrosilo 10 mil')).toEqual([10000])
    expect(extractNumbers('o de 10k')).toEqual([10000])
    expect(extractNumbers('hidro de 10.000 litros')).toEqual([10000])
    expect(extractNumbers('5,5 m')).toEqual([5.5])
  })
  it('variações de escrita levam ao mesmo SKU', () => {
    const onlyHs = items.filter((i) => i.family === 'Hidrosilo')
    for (const q of ['Hidrosilo 10 mil', 'HS 10000', 'hidro de 10.000 litros', 'el de 10k', 'HS-10K']) expect(top(q, onlyHs)).toBe('HS-10K')
    expect(top('hidrosilo 20.000 L', onlyHs)).toBe('HS-20K')
    expect(top('500 litros hidrosilo', onlyHs)).toBe('HS-500L')
  })
  it('ambiguidade entre famílias com a mesma capacidade é detectada', () => {
    const r = rankProducts('10.000 L', items)
    expect(r.slice(0, 2).map((x) => x.item.sku).sort()).toEqual(['HF-10K', 'HS-10K'])
    expect(isUnambiguous(r)).toBe(false)
    expect(isUnambiguous(rankProducts('hidrosilo 10.000 L', items))).toBe(true)
  })
  it('código exato vence', () => {
    expect(top('sb-9x75')).toBe('SB-9x75')
  })
})

describe('marca padrão PACIFIL (regra determinística)', () => {
  const bags = [
    { sku: 'SB-9X60', name: 'Silo-bolsa 9 pés × 60 m', family: 'Silo-bolsa', line: 'Silo-bolsa', brand: 'Pacifil', attrs: { diametro_ft: 9, comprimento_m: 60 } },
    { sku: 'SB-ECO-9X60', name: 'Silo-bolsa 9 pés × 60 m', family: 'Silo-bolsa', line: 'Silo-bolsa Eco Bag', brand: 'EcoBag', attrs: { diametro_ft: 9, comprimento_m: 60 } },
    { sku: 'SB-PRO-9X60', name: 'Silo-bolsa 9 pés × 60 m', family: 'Silo-bolsa', line: 'Silo-bolsa Pró Bag', brand: 'ProBag', attrs: { diametro_ft: 9, comprimento_m: 60 } },
    { sku: 'SB-BRIDON-9X300', name: 'Silo-bolsa 9 pés × 300 pés (~91 m)', family: 'Silo-bolsa', line: 'Silo-bolsa linha Bridon', brand: 'Bridon', attrs: { diametro_ft: 9, comprimento_ft: 300 } },
  ]
  it('sem marca citada → Pacifil, sem perguntar', () => {
    const r = resolveProducts('Agregá 10 Silo Bolsas 9 × 60', bags)
    expect(r.brand).toMatchObject({ key: 'PACIFIL', defaulted: true })
    expect(r.results[0].item.sku).toBe('SB-9X60')
    expect(r.results.every((x) => x.item.brand === 'Pacifil')).toBe(true)
  })
  it('marca citada → respeita (Ecobag, ProBag, Brydon)', () => {
    expect(resolveProducts('Agregá 10 Silo Bolsas Ecobag 9 × 60', bags).results[0].item.sku).toBe('SB-ECO-9X60')
    expect(resolveProducts('silo bolsa pro bag 9x60', bags).results[0].item.sku).toBe('SB-PRO-9X60')
    expect(resolveProducts('bolsa brydon 9 pies', bags).results[0].item.sku).toBe('SB-BRIDON-9X300')
  })
  it('detecta apelidos de marca', () => {
    expect(detectBrand('eco bag 9x75')).toBe('ECOBAG')
    expect(detectBrand('Brydon 10 pés')).toBe('BRIDON')
    expect(detectBrand('silo bolsa 9 x 60')).toBeNull()
  })
})

describe('Hydroforce × Hidrosilo', () => {
  const list = [
    { sku: 'HS-10K', name: 'Hidrosilo 10.000 L', family: 'Hidrosilo', line: 'Hidrosilo', brand: 'Pacifil', attrs: { capacidade_l: 10000 } },
    { sku: 'HF-10K', name: 'Hydroforce 10.000 L', family: 'Hydroforce', line: 'Hydroforce', brand: 'Pacifil', attrs: { capacidade_l: 10000 } },
  ]
  it('"hidroforce" e "hydroforce" acham o Hydroforce sem ambiguidade', () => {
    for (const q of ['hidroforce de 10 mil', 'Hydroforce 10000', 'hidroforce 10k']) {
      const r = resolveProducts(q, list)
      expect(r.results[0].item.sku).toBe('HF-10K')
      expect(isUnambiguous(r.results)).toBe(true)
    }
  })
  it('"hidrosilo" continua achando o Hidrosilo', () => {
    expect(resolveProducts('hidrosilo de 10 mil', list).results[0].item.sku).toBe('HS-10K')
  })
})

describe('códigos oficiais numéricos', () => {
  const list = [
    // código 20000 existe na planilha oficial (Hidrosilo 2,15 × 25 m), sem capacidade no cadastro
    { sku: '20000', name: 'Hidrosilo 2,15 × 25 m × 500 µm', family: 'Hidrosilo', line: 'Hidrosilo', brand: 'Pacifil', attrs: { largura_m: 2.15, comprimento_m: 25 } },
    { sku: '17313', name: 'Hidrosilo 2 × 20 m × 600 µm — 20.000 L', family: 'Hidrosilo', line: 'Hidrosilo', brand: 'Pacifil', attrs: { capacidade_l: 20000, largura_m: 2, comprimento_m: 20 } },
    { sku: '17308', name: 'Hidrosilo 2 × 10 m × 600 µm — 10.000 L', family: 'Hidrosilo', line: 'Hidrosilo', brand: 'Pacifil', attrs: { capacidade_l: 10000, largura_m: 2, comprimento_m: 10 } },
    { sku: '19712', name: 'Lona BPF 8 × 50 m × 150 µm (natural)', family: 'Lona de silagem', line: 'Lona BPF', brand: 'Pacifil', attrs: { largura_m: 8, comprimento_m: 50, espessura_um: 150 } },
    { sku: '14412', name: 'Lona BPF 8 × 50 m × 125 µm', family: 'Lona de silagem', line: 'Lona BPF', brand: 'Pacifil', attrs: { largura_m: 8, comprimento_m: 50, espessura_um: 125 } },
  ]
  const topN = (q: string) => rankProducts(q, list)[0]?.item.sku
  it('capacidade em litros não é confundida com o código', () => {
    for (const q of ['hidrosilo 20.000 L', 'hidrosilo 20000 L', 'hidrosilo de 20000 litros', 'hidro 20 mil', 'hidrosilo 20k']) {
      const r = rankProducts(q, list)
      expect(r[0].item.sku).toBe('17313')
      expect(r.find((x) => x.item.sku === '20000')?.reasons ?? []).not.toContain('código exato')
    }
  })
  it('código citado sozinho ou no meio do texto vence', () => {
    expect(topN('19712')).toBe('19712')
    expect(topN('quero 10 do 19712')).toBe('19712')
    expect(topN('cód. 14412')).toBe('14412')
    expect(rankProducts('19712', list)[0]).toMatchObject({ score: 100, reasons: ['código exato'] })
    expect(isUnambiguous(resolveProducts('19712', list).results)).toBe(true)
  })
  it('sem "código parcial" nos códigos numéricos', () => {
    expect(rankProducts('1971', list).some((r) => r.reasons.includes('código parcial'))).toBe(false)
    expect(rankProducts('197120', list).some((r) => r.reasons.includes('código exato'))).toBe(false)
  })
  it('medidas da lona não viram código', () => {
    const r = rankProducts('lona bpf 8 x 50 150 micras', list)
    expect(r[0].item.sku).toBe('19712')
    expect(r.every((x) => !x.reasons.includes('código exato'))).toBe(true)
  })
})

describe('código oficial que também é capacidade (20000)', () => {
  const list = [
    // código 20000 da planilha oficial: Hidrosilo 2,15 × 25 m de 20.000 L (outra caixa e outro palete)
    { sku: '20000', name: 'Hidrosilo 2,15 × 25 m × 500 µm — 20.000 L (filme 4,3 m)', family: 'Hidrosilo', line: 'Hidrosilo', brand: 'Pacifil', attrs: { capacidade_l: 20000, largura_filme_m: 4.3 } },
    { sku: '17313', name: 'Hidrosilo 2 × 20 m × 600 µm — 20.000 L', family: 'Hidrosilo', line: 'Hidrosilo', brand: 'Pacifil', attrs: { capacidade_l: 20000, largura_filme_m: 4 } },
    { sku: '18004', name: 'Hidrosilo 2 × 20 m × 600 µm — 20.000 L', family: 'Hidrosilo', line: 'Hidrosilo', brand: 'Pacifil', attrs: { capacidade_l: 20000, largura_filme_m: 4 } },
    { sku: '17308', name: 'Hidrosilo 2 × 10 m × 600 µm — 10.000 L', family: 'Hidrosilo', line: 'Hidrosilo', brand: 'Pacifil', attrs: { capacidade_l: 10000, largura_filme_m: 4 } },
  ]
  it('"hidrosilo 20000" é capacidade: não escolhe o código 20000 sozinho', () => {
    for (const q of ['hidrosilo 20000', '2 hidrosilos de 20000', 'hidro 20000']) {
      const r = resolveProducts(q, list).results
      expect(isUnambiguous(r)).toBe(false)
      expect(r.map((x) => x.item.sku)).toEqual(expect.arrayContaining(['20000', '17313', '18004']))
      expect(r.find((x) => x.item.sku === '20000')?.reasons ?? []).not.toContain('código exato')
    }
  })
  it('o número sozinho ou com o código marcado continua sendo o código', () => {
    for (const q of ['20000', 'código 20000', 'cód. 20000', '#20000']) {
      const r = resolveProducts(q, list).results
      expect(r[0].item.sku).toBe('20000')
      expect(r[0].reasons).toContain('código exato')
      expect(isUnambiguous(r)).toBe(true)
    }
  })
})
