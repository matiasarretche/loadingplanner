import { describe, expect, it } from 'vitest'
import { catalogFill, maxBoxesPerPallet, optimizeMixedPallets, type OrderLine } from './mixedPallets'
import type { PackSnapshot, PalletTypeSnapshot } from './types'

const pallet: PalletTypeSnapshot = { palletTypeId: 1, code: 'PCF-1150', name: 'PCF', dims: { l: 1150, w: 1150, h: 160 }, tareKg: 27, staticMaxKg: null, dynamicMaxKg: 2000, maxLoadKg: null, overhangAllowed: false, overhangMaxMm: 0, verification: 'VERIFIED' }
const pack = (sku: string, max: number | null): PackSnapshot => ({
  packagingVersionId: 1, version: 1, sku, name: sku, packageType: 'caixa', dims: { l: 1140, w: 570, h: 570 }, netKg: 190, grossKg: 200, unitsPerPackage: 1,
  allowedOrientations: ['LWH', 'WLH'], stackable: true, maxStackLayers: null, maxStackKg: null, fragile: false, verification: 'VERIFIED', color: '#336699', boxesPerPallet: max,
})
const opts = { palletTypes: [pallet], maxHeightMm: 2700 }

describe('máximo de caixas por palete do catálogo (estrito)', () => {
  it('pedido de Danilo: 60 + 36 + 30 caixas de máx. 6 → 21 paletes de 6 (não 16 de 8)', () => {
    const order: OrderLine[] = [
      { packId: 'a', pack: pack('SB-10X100', 6), boxes: 60 },
      { packId: 'b', pack: pack('SB-12X75', 6), boxes: 36 },
      { packId: 'c', pack: pack('SB-12X90', 6), boxes: 30 },
    ]
    const r = optimizeMixedPallets(order, opts)
    expect(r.pallets).toHaveLength(21)
    expect(r.pallets.every((p) => p.doc.items.length === 6 && catalogFill(p.doc) <= 1)).toBe(true)
    expect(r.check.every((c) => c.ok)).toBe(true)
  })
  it('pedido 5 de Danilo: caixas iguais com máximos diferentes (8 e 10) → paletes completos, sem dividir', () => {
    const box = (sku: string, max: number): PackSnapshot => ({ ...pack(sku, max), dims: { l: 1000, w: 600, h: 400 }, grossKg: 134 })
    const pbr: PalletTypeSnapshot = { ...pallet, palletTypeId: 2, code: 'PBR-1', dims: { l: 1200, w: 1000, h: 137 } }
    const order: OrderLine[] = [
      { packId: 'a', pack: box('SB-9X75', 8), boxes: 104 },
      { packId: 'b', pack: box('SB-9X60', 10), boxes: 20 },
      { packId: 'c', pack: box('SB-9X75-R', 8), boxes: 12 },
    ]
    const r = optimizeMixedPallets(order, { palletTypes: [pbr], maxHeightMm: 2700 })
    const by = (sku: string) => r.pallets.filter((p) => p.lines.some((l) => l.sku === sku)).map((p) => p.lines.find((l) => l.sku === sku)!.boxes)
    expect(by('SB-9X75')).toEqual(Array(13).fill(8))
    expect(by('SB-9X60')).toEqual([10, 10])
    // remanente (menos que um palete) continua no motor misto
    expect(by('SB-9X75-R').reduce((s, n) => s + n, 0)).toBe(12)
    expect(by('SB-9X75-R')).toContain(8)
    expect(r.pallets.every((p) => catalogFill(p.doc) <= 1 + 1e-9)).toBe(true)
    expect(r.check.every((c) => c.ok)).toBe(true)
  })
  it('"palete completo" = o máximo do catálogo', () => {
    const p = pack('SB-X', 6)
    expect(maxBoxesPerPallet(p, (b) => [{ packId: 'a', pack: p, boxes: b }], opts)).toBe(6)
  })
  it('sem máximo cadastrado: usa a altura do transporte (comportamento anterior)', () => {
    const r = optimizeMixedPallets([{ packId: 'a', pack: pack('SB-Y', null), boxes: 16 }], opts)
    expect(Math.max(...r.pallets.map((p) => p.doc.items.length))).toBe(8)
  })
})
