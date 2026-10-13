import { describe, expect, it } from 'vitest'
import type { PriceListRow } from '@/lib/priceList'
import { priceListProductText } from './priceListPdf'

const row = (o: Partial<PriceListRow>): PriceListRow => ({
  sku: '1',
  name: 'x',
  brand: 'Pacifil',
  widthM: 2,
  lengthM: 10,
  thicknessUm: 600,
  capacityL: 10000,
  box: null,
  unitsPerPallet: null,
  palletCode: null,
  netKg: null,
  grossKg: null,
  priceUsd: null,
  reason: null,
  ...o,
})

describe('descrição dos reservatórios na lista de preços', () => {
  it('o Hidrosilo padrão continua como antes', () => {
    expect(priceListProductText('Hidrosilo', row({}), 'pt')).toBe('Hidrosilo 2 m × 10 m — 10.000 litros')
    expect(priceListProductText('Hidrosilo', row({ lengthM: 5.5, capacityL: 5000 }), 'es')).toBe('Hidrosilo 2 m × 5,5 m — 5.000 litros')
    expect(priceListProductText('Hidroforce', row({ brand: 'Agromai' }), 'pt')).toBe('Hidroforce 2 m × 10 m — 10.000 litros (Agromai)')
  })
  it('medidas como escritas no idioma da lista (2,15 — nunca 2,2; 1,65 — nunca 1,7)', () => {
    expect(priceListProductText('Hidrosilo', row({ widthM: 2.15, lengthM: 25, capacityL: 20000 }), 'pt')).toBe('Hidrosilo 2,15 m × 25 m — 20.000 litros')
    expect(priceListProductText('Hidrosilo', row({ widthM: 2.15, lengthM: 25, capacityL: 20000 }), 'en')).toBe('Hidrosilo 2.15 m × 25 m — 20,000 liters')
    expect(priceListProductText('Hidrosilo', row({ widthM: 1.2, lengthM: 1.65, capacityL: null, unitsPerPack: 15 }), 'pt')).toBe('Hidrosilo 1,2 m × 1,65 m (c/15 un.)')
  })
  it('tanques de mesma medida ficam distintos: válvulas, Plus X3, filme aberto, pacote e espessura', () => {
    const base = { widthM: 2.15, lengthM: 25, thicknessUm: 500, capacityL: 20000 }
    const texts = [
      row({ ...base, sku: '17644', valves: 4 }),
      row({ ...base, sku: '20025', valves: 4, filmWidthM: 4.3 }),
      row({ ...base, sku: '20000', filmWidthM: 4.3 }),
      row({ ...base, sku: '17584', valves: 4, filmWidthM: 4.3, plusX3: true }),
    ].map((r) => priceListProductText('Hidrosilo', r, 'pt'))
    expect(new Set(texts).size).toBe(texts.length)
    expect(texts[1]).toBe('Hidrosilo 2,15 m × 25 m — 20.000 litros (4V, filme 4,3 m)')
    expect(texts[3]).toBe('Hidrosilo Plus X3 2,15 m × 25 m — 20.000 litros (4V, filme 4,3 m)')
    const t500 = priceListProductText('Hidrosilo', row({ lengthM: 5.5, capacityL: 5000, thicknessUm: 500 }), 'pt', true)
    const t600 = priceListProductText('Hidrosilo', row({ lengthM: 5.5, capacityL: 5000, thicknessUm: 600 }), 'pt', true)
    expect(t500).toBe('Hidrosilo 2 m × 5,5 m × 500 µm — 5.000 litros')
    expect(t500).not.toBe(t600)
  })
  it('as outras famílias usam o nome do catálogo', () => {
    expect(priceListProductText('Lona de silagem', row({ name: 'Lona padrão 8 × 50 m × 125 µm', widthM: 8, lengthM: 50 }), 'en')).toBe('Lona padrão 8 × 50 m × 125 µm')
  })
})
