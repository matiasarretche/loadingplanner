import { describe, expect, it } from 'vitest'
import { placeLooseBoxes, placePallets } from './autoload'
import { addMissingCompanions, companionLines, companionsFromAttrs, companionStatus } from './companions'
import { container, loadDoc, pack, palletDoc, palletType } from './fixtures'
import { orientDims } from './geometry'
import { validateLoad } from './load'
import { kitBoxPack, packKeyOf } from './kitBoxes'
import { addBoxesToMixed, optimizeMixedPallets } from './mixedPallets'
import { palletSummary } from './pallet'
import type { PalletDoc } from './types'

const pt = palletType({ palletTypeId: 6, code: 'PCF-1150', dims: { l: 1150, w: 1150, h: 160 }, maxLoadKg: 2000, staticMaxKg: 2000, dynamicMaxKg: 2000 })
const hf = pack({ sku: 'HF-10K', packagingVersionId: 10, dims: { l: 1140, w: 570, h: 150 }, grossKg: 28.02, companions: [{ sku: 'KIT-HF', qty: 1 }] })
const kit = pack({ sku: 'KIT-HF', packagingVersionId: 11, dims: { l: 200, w: 200, h: 200 }, grossKg: 2, netKg: 2 })
const hfPallet = (n: number) =>
  palletDoc({
    name: `REF · HF-10K · ${n} u`,
    palletType: pt,
    packs: { pv10: hf },
    items: Array.from({ length: n }, (_, i) => ({ id: `i${i}`, packId: 'pv10', pos: { x: 5, y: (i % 2) * 570 + 5, z: Math.floor(i / 2) * 150 }, orientation: 'LWH' as const, locked: false })),
  })
const findKit = (sku: string) => (sku === 'KIT-HF' ? { packId: 'pv11', pack: kit } : null)
const codes = (d: Parameters<typeof validateLoad>[0]) => validateLoad(d).issues.map((i) => i.code)

describe('acompanhantes: kit Hydroforce sempre por cima do palete com Hydroforce', () => {
  it('regra vem do cadastro (acessorio_sku / acessorio_qtd)', () => {
    expect(companionsFromAttrs({ acessorio_sku: 'KIT-HF', acessorio_qtd: 1 })).toEqual([{ sku: 'KIT-HF', qty: 1 }])
    expect(companionsFromAttrs({ capacidade_l: 10000 })).toEqual([])
  })
  it('conta exigido × presente por palete e a validação avisa', () => {
    const doc = placePallets(loadDoc({ space: container('40GP') }), 'hf', hfPallet(24), 2).doc
    expect(companionStatus(doc)).toEqual([{ sku: 'KIT-HF', for: ['HF-10K'], required: 48, present: 0, missing: 48, misplaced: 0, looseParents: 0 }])
    expect(codes(doc)).toContain('COMPANION_MISSING')
  })
  it('completa os kits POR CIMA do palete do Hydroforce (nunca soltos)', () => {
    const doc = placePallets(loadDoc({ space: container('40GP') }), 'hf', hfPallet(24), 2).doc
    const r = addMissingCompanions(doc, findKit)
    expect(r.added).toEqual([{ sku: 'KIT-HF', placed: 48, missing: 0 }])
    expect(r.doc.units.every((u) => u.kind === 'PALLET')).toBe(true) // nenhuma caixa solta
    const p = Object.values(r.doc.pallets)[0]
    expect(p.items.filter((i) => p.packs[i.packId].sku === 'KIT-HF').every((i) => i.pos.z >= 150)).toBe(true)
    expect(codes(r.doc)).not.toContain('COMPANION_MISSING')
    expect(validateLoad(r.doc).issues.filter((i) => i.severity === 'CRITICAL')).toEqual([])
  })
  it('se não couber (26 HF-10K: 2,11 m + kits > porta 2,29 m), AVISA e não coloca em outro lugar', () => {
    const doc = placePallets(loadDoc({ space: container('40GP') }), 'hf', hfPallet(26), 1).doc
    const r = addMissingCompanions(doc, findKit)
    expect(r.added[0]).toMatchObject({ sku: 'KIT-HF', placed: 0, missing: 26 })
    expect(r.doc).toBe(doc)
    expect(codes(r.doc)).toContain('COMPANION_MISSING')
  })
  it('kit solto ou Hydroforce solto: avisos de lugar errado', () => {
    const base = placePallets(loadDoc({ space: container('40GP') }), 'hf', hfPallet(24), 1).doc
    const looseKit = placeLooseBoxes(base, 'pv11', kit, 1).doc
    expect(companionStatus(looseKit)[0].misplaced).toBe(1)
    expect(codes(looseKit)).toContain('COMPANION_MISPLACED')
    const looseHf = placeLooseBoxes(loadDoc({ space: container('40GP') }), 'pv10', hf, 2).doc
    expect(companionStatus(looseHf)[0]).toMatchObject({ looseParents: 2, missing: 2 })
  })
  it('linhas de acompanhantes para um pedido', () => {
    expect(companionLines([{ pack: hf, boxes: 20 }, { pack: kit, boxes: 3 }])).toEqual([{ sku: 'KIT-HF', kits: 20, for: ['HF-10K'] }])
  })
})

describe('otimizador de paletes mistos com acompanhantes', () => {
  it('reserva altura/peso dos kits: todos no palete do próprio Hydroforce, dentro da altura', () => {
    const r = optimizeMixedPallets(
      [
        { packId: 'pv10', pack: hf, boxes: 52 },
        { packId: 'pv11', pack: kit, boxes: 52 },
      ],
      { palletTypes: [pt], maxHeightMm: 2292 },
    )
    expect(r.unplaced).toEqual([])
    expect(r.ok).toBe(true)
    for (const p of r.pallets) {
      const hfN = p.doc.items.filter((i) => p.doc.packs[i.packId].sku === 'HF-10K').length
      // kits contados em unidades (caixas de 26 / meia caixa / individuais)
      const kitN = p.doc.items.filter((i) => p.doc.packs[i.packId].sku === 'KIT-HF').reduce((s, i) => s + p.doc.packs[i.packId].unitsPerPackage, 0)
      expect(kitN).toBe(hfN) // 1 kit por Hydroforce, no mesmo palete
      expect(p.heightMm).toBeLessThanOrEqual(2292)
      const hfTop = Math.max(...p.doc.items.filter((i) => p.doc.packs[i.packId].sku === 'HF-10K').map((i) => i.pos.z))
      for (const i of p.doc.items.filter((x) => p.doc.packs[x.packId].sku === 'KIT-HF')) expect(i.pos.z + orientDims(p.doc.packs[i.packId].dims, i.orientation).z).toBeGreaterThan(hfTop)
    }
  })
  it('se faltar altura para os kits, informa como não colocado (não espalha)', () => {
    const r = optimizeMixedPallets(
      [
        { packId: 'pv10', pack: hf, boxes: 2 },
        { packId: 'pv11', pack: kit, boxes: 2 },
      ],
      { palletTypes: [pt], maxHeightMm: 160 + 150 + 100 },
    )
    expect(r.unplaced.some((u) => u.sku === 'KIT-HF')).toBe(true)
    expect(r.ok).toBe(false)
  })
})

describe('kits Hydroforce em caixas coletivas (caixa 79583 de 26, meia caixa até 13, individuais)', () => {
  const hf2k = pack({ sku: 'HF-2K', packagingVersionId: 20, dims: { l: 600, w: 500, h: 130 }, grossKg: 9.73, netKg: 6.71, boxesPerPallet: 52, companions: [{ sku: 'KIT-HF', qty: 1 }] })
  const hf5k = pack({ sku: 'HF-5K', packagingVersionId: 21, dims: { l: 1140, w: 570, h: 110 }, grossKg: 17.16, netKg: 12.3, boxesPerPallet: 36, companions: [{ sku: 'KIT-HF', qty: 1 }] })
  /** palete só com o Hydroforce (sem kits), montado pelo motor */
  const bare = (p: typeof hf2k, n: number, h: number) => optimizeMixedPallets([{ packId: `pv${p.packagingVersionId}`, pack: p, boxes: n }], { palletTypes: [pt], maxHeightMm: h }).pallets[0].doc
  const kitsOn = (p: PalletDoc) => p.items.filter((i) => p.packs[i.packId].sku === 'KIT-HF').map((i) => p.packs[i.packId])
  const units = (p: PalletDoc) => kitsOn(p).reduce((s, k) => s + k.unitsPerPackage, 0)

  it('HF 2K × 52: 2 caixas de 26 sobre o cata-vento (~92% apoiadas), 2.100 mm, sem alerta crítico', () => {
    const doc = placePallets(loadDoc({ space: container('40GP') }), 'hf', bare(hf2k, 52, 2292), 1).doc
    const r = addMissingCompanions(doc, findKit)
    expect(r.added).toEqual([{ sku: 'KIT-HF', placed: 52, missing: 0 }])
    const p = Object.values(r.doc.pallets)[0]
    expect(kitsOn(p).map((k) => k.kitBox?.kits)).toEqual([26, 26])
    expect(palletSummary(p).totalHeightMm).toBe(2100)
    expect(companionStatus(r.doc)[0]).toMatchObject({ required: 52, present: 52, missing: 0, misplaced: 0 })
    expect(validateLoad(r.doc).issues.filter((i) => i.severity === 'CRITICAL')).toEqual([])
  })
  it('HF 5K × 36 (40\' HC): 1 caixa 69488 de 36 kits, 2.540 mm; peso com a tara da caixa', () => {
    const doc = placePallets(loadDoc({ space: container('40HC') }), 'hf', bare(hf5k, 36, 2597), 1).doc
    const r = addMissingCompanions(doc, findKit)
    expect(r.added).toEqual([{ sku: 'KIT-HF', placed: 36, missing: 0 }])
    const p = Object.values(r.doc.pallets)[0]
    expect(kitsOn(p).map((k) => k.unitsPerPackage)).toEqual([36])
    expect(kitsOn(p)[0].kitBox?.code).toBe('69488')
    expect(palletSummary(p).totalHeightMm).toBe(2540)
    // 36 × 2 kg + 5,65 kg da caixa 69488
    expect(kitsOn(p).reduce((s, k) => s + k.grossKg, 0)).toBeCloseTo(77.65, 6)
    expect(validateLoad(r.doc).issues.filter((i) => i.severity === 'CRITICAL')).toEqual([])
  })
  it('caixa que não cabe vira caixas menores (meias caixas de 250 mm sem altura → individuais de 200 mm)', () => {
    const doc = placePallets(loadDoc({ space: container('40HC') }), 'hf', bare(hf5k, 14, 2597), 1).doc
    // 7 camadas (770 mm): cabem 200 mm de kits, não os 250 da meia caixa
    const r = addMissingCompanions(doc, findKit, 160 + 770 + 220)
    expect(r.added).toEqual([{ sku: 'KIT-HF', placed: 14, missing: 0 }])
    const p = Object.values(r.doc.pallets)[0]
    expect(kitsOn(p).every((k) => !k.kitBox)).toBe(true)
    expect(units(p)).toBe(14)
  })
  it('idempotente; palete antigo com kits individuais completos não muda', () => {
    const doc = placePallets(loadDoc({ space: container('40GP') }), 'hf', bare(hf2k, 52, 2292), 1).doc
    const once = addMissingCompanions(doc, findKit).doc
    const twice = addMissingCompanions(once, findKit)
    expect(twice.added).toEqual([])
    expect(twice.doc).toBe(once)
    // palete antigo: 36 HF 5K + 36 caixas individuais de kit
    const old = addBoxesToMixed(bare(hf5k, 36, 2597), 'pv11', kit, 36, 2597).doc
    expect(units(old)).toBe(36)
    const load = placePallets(loadDoc({ space: container('40HC') }), 'old', old, 1).doc
    const r = addMissingCompanions(load, findKit)
    expect(r.added).toEqual([])
    expect(r.doc).toBe(load)
    expect(codes(load)).not.toContain('COMPANION_MISSING')
  })
  it('kits fora do lugar contados em unidades (uma caixa de 26 solta = 26 kits)', () => {
    const base = placePallets(loadDoc({ space: container('40HC') }), 'hf', hfPallet(24), 1).doc
    const big = kitBoxPack(kit, 'BIG', 26)
    const loose = placeLooseBoxes(base, packKeyOf(big), big, 1).doc
    expect(companionStatus(loose)[0]).toMatchObject({ misplaced: 26, missing: 24 })
  })
})
