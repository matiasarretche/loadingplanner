import { describe, expect, it } from 'vitest'
import { pack, palletType } from './fixtures'
import { kitPalletForHeight } from './kitPallet'
import { optimizeMixedPallets } from './mixedPallets'
import { palletSummary } from './pallet'
import type { PalletDoc } from './types'

describe('REF de Hydroforce com kits na altura da carga (editor e IA)', () => {
  const pt = palletType({ palletTypeId: 6, code: 'PCF-1150', dims: { l: 1150, w: 1150, h: 160 }, maxLoadKg: 2000, staticMaxKg: 2000, dynamicMaxKg: 2000 })
  const ALL = ['LWH', 'WLH', 'LHW', 'HLW', 'WHL', 'HWL'] as const
  const kit = pack({ sku: 'KIT-HF', packagingVersionId: 155, dims: { l: 200, w: 200, h: 200 }, grossKg: 2, netKg: 2, allowedOrientations: [...ALL] })
  const hf = (sku: string, id: number, l: number, w: number, h: number, kg: number, max: number) =>
    pack({ sku, packagingVersionId: id, dims: { l, w, h }, grossKg: kg, netKg: kg * 0.75, boxesPerPallet: max, companions: [{ sku: 'KIT-HF', qty: 1 }], allowedOrientations: [...ALL] })
  const refOf = (p: ReturnType<typeof hf>, n: number) =>
    optimizeMixedPallets(
      [
        { packId: `pv${p.packagingVersionId}`, pack: p, boxes: n },
        { packId: 'pv155', pack: kit, boxes: n },
      ],
      { palletTypes: [pt], maxHeightMm: 2597 },
    ).pallets[0].doc
  const units = (d: PalletDoc, sku: string) => d.items.filter((i) => d.packs[i.packId].sku === sku).length
  const kits = (d: PalletDoc) => d.items.filter((i) => d.packs[i.packId].sku === 'KIT-HF').reduce((s, i) => s + d.packs[i.packId].unitsPerPackage, 0)

  it("REF de 36 HF 5K (2.540 mm, caixa 69488) num 20'/40' Dry (2.292 mm): o maior que cabe, 34 un. + 34 kits, com nota", () => {
    const ref = refOf(hf('HF-2M-5K', 166, 1140, 570, 110, 17.16, 36), 36)
    expect(palletSummary(ref).totalHeightMm).toBe(2540)
    const fit = kitPalletForHeight(ref, 2292)!
    expect(fit).toMatchObject({ sku: 'HF-2M-5K', fullUnits: 36, units: 34 })
    expect(units(fit.pallet, 'HF-2M-5K')).toBe(34)
    expect(kits(fit.pallet)).toBe(34)
    expect(palletSummary(fit.pallet).totalHeightMm).toBeLessThanOrEqual(2292)
    expect(fit.pallet.name).toBe('REF · HF-2M-5K · 34 u · até 2292 mm')
    expect(fit.note).toMatch(/2540 mm.*2292 mm.*34 un\. \+ 34 kits/)
    // no 40' HC cabe como está
    expect(kitPalletForHeight(ref, 2597)).toBeNull()
  })
  it('REF de 26 HF 10K → 24 un.; REF de 52 HF 2K (2.100 mm) cabe como está', () => {
    const r10 = kitPalletForHeight(refOf(hf('HF-2M-10K', 167, 1140, 570, 150, 28.02, 26), 26), 2292)!
    expect([r10.units, kits(r10.pallet)]).toEqual([24, 24])
    expect(kitPalletForHeight(refOf(hf('HF-2M-2K', 205, 600, 500, 130, 9.73, 52), 52), 2292)).toBeNull()
  })
  it('palete sem kits (ou com mais de um produto) não é adaptado', () => {
    const hs = pack({ sku: 'HS-2M-5K', packagingVersionId: 142, dims: { l: 1140, w: 570, h: 110 }, grossKg: 17.16, netKg: 14, boxesPerPallet: 36 })
    const d = optimizeMixedPallets([{ packId: 'pv142', pack: hs, boxes: 36 }], { palletTypes: [pt], maxHeightMm: 2700 }).pallets[0].doc
    expect(kitPalletForHeight(d, 1500)).toBeNull()
  })
})
