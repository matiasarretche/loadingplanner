import { describe, expect, it } from 'vitest'
import { placePallets } from './autoload'
import { container, loadDoc, pack, palletDoc, palletType } from './fixtures'
import { loadSummary, validateLoad } from './load'
import { optimizeMixedPallets } from './mixedPallets'
import { palletBoxCounts, removeBoxesFromPallet } from './partial'
import type { PalletDoc } from './types'

// palete com 2 camadas × 2 caixas de 1000×600×300 mm, 20 kg cada
const p = palletDoc({
  name: 'P',
  packs: { a: pack({ sku: 'A', dims: { l: 1000, w: 600, h: 300 }, grossKg: 20, netKg: 18 }) },
  items: [0, 1].flatMap((z) => [0, 1].map((y) => ({ id: `i${z}${y}`, packId: 'a', pos: { x: 0, y: y * 600, z: z * 300 }, orientation: 'LWH' as const, locked: false }))),
})
const base = loadDoc({
  space: container('40HC'),
  pallets: { p },
  units: [
    { id: 'u1', kind: 'PALLET', palletKey: 'p', pos: { x: 0, y: 0, z: 0 }, yaw: false, locked: false },
    { id: 'u2', kind: 'PALLET', palletKey: 'p', pos: { x: 1000, y: 0, z: 0 }, yaw: false, locked: false },
  ],
})

describe('palete parcial', () => {
  it('retira caixas de um palete sem afetar o outro igual', () => {
    const r = removeBoxesFromPallet(base, 'u2', 2)
    expect(r.removed).toBe(2)
    expect(r.remaining).toBe(2)
    const u2 = r.doc.units.find((u) => u.id === 'u2')!
    const u1 = r.doc.units.find((u) => u.id === 'u1')!
    expect(u1.kind === 'PALLET' && u1.palletKey).toBe('p')
    const k2 = u2.kind === 'PALLET' ? u2.palletKey : ''
    expect(k2).toBe('p~u2')
    expect(palletBoxCounts(r.doc.pallets[k2])).toEqual({ boxes: 2, fullBoxes: 4, partial: true })
    // as retiradas são as de cima
    expect(r.doc.pallets[k2].items.every((i) => i.pos.z === 0)).toBe(true)
    // pesos e unidades atualizados: 8 caixas → 6
    expect(loadSummary(base).packages).toBe(8)
    expect(loadSummary(r.doc).packages).toBe(6)
    expect(loadSummary(base).payloadKg - loadSummary(r.doc).payloadKg).toBe(40)
    expect(validateLoad(r.doc).issues.filter((i) => i.severity === 'CRITICAL')).toEqual([])
  })
  it('retiradas sucessivas reutilizam a cópia do palete e mantêm o total de origem', () => {
    const a = removeBoxesFromPallet(base, 'u1', 1)
    const b = removeBoxesFromPallet(a.doc, 'u1', 1)
    const k = b.doc.units.find((u) => u.id === 'u1')!
    const key = k.kind === 'PALLET' ? k.palletKey : ''
    expect(key).toBe('p~u1')
    expect(palletBoxCounts(b.doc.pallets[key])).toEqual({ boxes: 2, fullBoxes: 4, partial: true })
    expect(Object.keys(b.doc.pallets).sort()).toEqual(['p', 'p~u1'])
  })
  it('limita ao que existe e filtra por SKU', () => {
    expect(removeBoxesFromPallet(base, 'u1', 10).removed).toBe(4)
    expect(removeBoxesFromPallet(base, 'u1', 1, 'X').error).toContain('não tem caixas de X')
  })
})

describe('palete parcial de Hydroforce: kits reembalados para o que ficou', () => {
  const pt = palletType({ palletTypeId: 6, code: 'PCF-1150', dims: { l: 1150, w: 1150, h: 160 }, maxLoadKg: 2000, staticMaxKg: 2000, dynamicMaxKg: 2000 })
  const hf = pack({ sku: 'HF-5K', packagingVersionId: 21, dims: { l: 1140, w: 570, h: 110 }, grossKg: 17.16, netKg: 12.3, boxesPerPallet: 36, companions: [{ sku: 'KIT-HF', qty: 1 }] })
  const kit = pack({ sku: 'KIT-HF', packagingVersionId: 155, dims: { l: 200, w: 200, h: 200 }, grossKg: 2, netKg: 2 })
  // palete padrão: 36 HF + caixa de 26 + 10 individuais (40' HC)
  const full = optimizeMixedPallets(
    [
      { packId: 'pv21', pack: hf, boxes: 36 },
      { packId: 'pv155', pack: kit, boxes: 36 },
    ],
    { palletTypes: [pt], maxHeightMm: 2597 },
  ).pallets[0].doc
  const doc = placePallets(loadDoc({ space: container('40HC') }), 'hf', full, 1).doc
  const unitId = doc.units[0].id
  const kitsOf = (p: PalletDoc) => p.items.filter((i) => p.packs[i.packId].sku === 'KIT-HF').map((i) => p.packs[i.packId].unitsPerPackage)

  it('tirar 10 HF de 36 → 26 HF + 1 caixa de 26 kits, sem alerta crítico', () => {
    const r = removeBoxesFromPallet(doc, unitId, 10)
    expect(r.removed).toBe(10)
    const u = r.doc.units[0]
    const p = r.doc.pallets[u.kind === 'PALLET' ? u.palletKey : '']
    expect(p.items.filter((i) => p.packs[i.packId].sku === 'HF-5K')).toHaveLength(26)
    expect(kitsOf(p)).toEqual([26])
    expect(r.remaining).toBe(27)
    expect(validateLoad(r.doc).issues.filter((i) => i.severity === 'CRITICAL')).toEqual([])
    expect(validateLoad(r.doc).issues.map((i) => i.code)).not.toContain('COMPANION_MISSING')
  })
  it('tirar todos os HF leva os kits junto (nunca kit sem o produto)', () => {
    const r = removeBoxesFromPallet(doc, unitId, 36, 'HF-5K')
    const u = r.doc.units[0]
    const p = r.doc.pallets[u.kind === 'PALLET' ? u.palletKey : '']
    expect(kitsOf(p)).toEqual([])
  })
})

describe('palete parcial de HF 2K (52 un. + 2 caixas de 26): as caixas de kits nunca ficam sem apoio', () => {
  const pt = palletType({ palletTypeId: 6, code: 'PCF-1150', dims: { l: 1150, w: 1150, h: 160 }, maxLoadKg: 2000, staticMaxKg: 2000, dynamicMaxKg: 2000 })
  const ALL = ['LWH', 'WLH', 'LHW', 'HLW', 'WHL', 'HWL'] as const
  const hf = pack({ sku: 'HF-2M-2K', packagingVersionId: 205, dims: { l: 600, w: 500, h: 130 }, grossKg: 9.73, netKg: 7.3, boxesPerPallet: 52, companions: [{ sku: 'KIT-HF', qty: 1 }], allowedOrientations: [...ALL] })
  const kit = pack({ sku: 'KIT-HF', packagingVersionId: 155, dims: { l: 200, w: 200, h: 200 }, grossKg: 2, netKg: 2, allowedOrientations: [...ALL] })
  const ref = optimizeMixedPallets(
    [
      { packId: 'pv205', pack: hf, boxes: 52 },
      { packId: 'pv155', pack: kit, boxes: 52 },
    ],
    { palletTypes: [pt], maxHeightMm: 2292 },
  ).pallets[0].doc
  const after = (code: '40HC' | '40GP', n: number) => {
    const doc = placePallets(loadDoc({ space: container(code) }), 'hf2k', ref, 1).doc
    const r = removeBoxesFromPallet(doc, doc.units[0].id, n)
    const u = r.doc.units[0]
    const p = r.doc.pallets[u.kind === 'PALLET' ? u.palletKey : '']
    const v = validateLoad(r.doc)
    return {
      hf: p.items.filter((i) => p.packs[i.packId].sku === 'HF-2M-2K').length,
      kits: p.items.filter((i) => p.packs[i.packId].sku === 'KIT-HF').map((i) => p.packs[i.packId].unitsPerPackage).sort((a, b) => b - a),
      critical: v.issues.filter((i) => i.severity === 'CRITICAL').map((i) => i.code),
      codes: v.issues.map((i) => i.code),
    }
  }
  it("40' HC: tirar 1, 2, 3 ou 5 HF (os de cima, sob as caixas de 26) → kits = HF, refeitos pela regra, sem alerta crítico", () => {
    for (const n of [1, 2, 3, 5]) {
      const a = after('40HC', n)
      expect(a.hf).toBe(52 - n)
      expect(a.kits.reduce((s, k) => s + k, 0)).toBe(52 - n)
      expect(a.critical).toEqual([])
    }
    // 52 − 10 = 42: caixa de 26 + meia caixa (13) + meia caixa (3) — não 2 meias caixas + 16 individuais
    expect(after('40HC', 10).kits).toEqual([26, 13, 3])
  })
  it("20'/40' Dry (2.292 mm): o que não cabe fica faltando com aviso — nunca caixa de kit flutuando", () => {
    for (const n of [1, 2, 3, 5]) {
      const a = after('40GP', n)
      expect(a.critical).toEqual([])
      expect(a.kits.reduce((s, k) => s + k, 0)).toBeLessThanOrEqual(a.hf)
      if (a.kits.reduce((s, k) => s + k, 0) < a.hf) expect(a.codes).toContain('COMPANION_MISSING')
    }
  })
})
