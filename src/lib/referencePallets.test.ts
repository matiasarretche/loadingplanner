import { describe, expect, it, vi } from 'vitest'

// só as funções puras (montagem e notas); nada de banco
vi.mock('@/db', () => ({ db: {}, schema: {} }))

import { pack, palletType } from '@/domain/fixtures'
import { companionNotes, companionReference } from './referencePallets'

const ALL = ['LWH', 'WLH', 'LHW', 'HLW', 'WHL', 'HWL'] as const
const pt = palletType({ palletTypeId: 6, code: 'PCF-1150', dims: { l: 1150, w: 1150, h: 160 }, tareKg: 25, maxLoadKg: 2000, staticMaxKg: null, dynamicMaxKg: null })
const kit = { packId: 'pv155', pack: pack({ sku: 'KIT-HF', name: 'Kit', packagingVersionId: 155, dims: { l: 200, w: 200, h: 200 }, grossKg: 2, netKg: 2, allowedOrientations: [...ALL] }), qty: 1 }
const hf = (sku: string, id: number, l: number, w: number, h: number, kg: number, upp: number) =>
  pack({ sku, name: sku, packagingVersionId: id, dims: { l, w, h }, grossKg: kg, netKg: kg * 0.75, boxesPerPallet: upp, companions: [{ sku: 'KIT-HF', qty: 1 }], allowedOrientations: [...ALL] })
const kitsOf = (d: NonNullable<ReturnType<typeof companionReference>>['doc']) =>
  d.items.filter((i) => d.packs[i.packId].sku === 'KIT-HF').map((i) => d.packs[i.packId].unitsPerPackage).sort((a, b) => b - a)

describe('montagem de referência com kits: o palete padrão do catálogo prevalece', () => {
  it("HF 2K: 52 un. + 2 caixas de 26, 2.100 mm (serve em 20'/40' Dry)", () => {
    const r = companionReference(pt, hf('HF-2M-2K', 165, 600, 500, 130, 9.73, 52), 'pv165', 52, kit)!
    expect(r).toMatchObject({ n: 52, heightMm: 2100, hcOnly: false })
    expect(kitsOf(r.doc)).toEqual([26, 26])
    expect(companionNotes('HF-2M-2K', 3, 52, r, 'KIT-HF')).toMatch(/52 un\. \+ 52 KIT-HF por cima \(2 × caixa 79583 \(26 kits\)\).*altura total 2\.100 mm/)
  })
  it("HF 5K: 36 un. + caixa 69488 com os 36 kits, 2.540 mm — nota \"só 40' HC / rodoviário\"", () => {
    const r = companionReference(pt, hf('HF-2M-5K', 166, 1140, 570, 110, 17.16, 36), 'pv166', 36, kit)!
    expect(r).toMatchObject({ n: 36, heightMm: 2540, hcOnly: true })
    expect(kitsOf(r.doc)).toEqual([36])
    const notes = companionNotes('HF-2M-5K', 2, 36, r, 'KIT-HF')
    expect(notes).toContain("altura 2.540 mm: só 40' HC / rodoviário")
    expect(notes).toContain('1 × caixa 69488 (36 kits)')
  })
  it('HF 10K: 26 un. + 1 caixa de 26, 2.360 mm (só 40\' HC)', () => {
    const r = companionReference(pt, hf('HF-2M-10K', 167, 1140, 570, 150, 28.02, 26), 'pv167', 26, kit)!
    expect(r).toMatchObject({ n: 26, heightMm: 2360, hcOnly: true })
    expect(kitsOf(r.doc)).toEqual([26])
  })
})
