import { describe, expect, it } from 'vitest'
import { buildReferencePallet } from './autopallet'
import { pack, palletType } from './fixtures'
import { palletSummary, validatePallet } from './pallet'

const crit = (d: Parameters<typeof validatePallet>[0]) => validatePallet(d).filter((i) => i.severity === 'CRITICAL').map((i) => i.code)

describe('paletização de referência', () => {
  it('Hidrosilo 2250×380×180 em 2300×1150: 3 por camada, 33 = 11 camadas', () => {
    const pt = palletType({ code: 'PCF-2300x1150', dims: { l: 2300, w: 1150, h: 150 }, dynamicMaxKg: null })
    const k = pack({ dims: { l: 2250, w: 380, h: 180 }, grossKg: 5.76 })
    const r = buildReferencePallet(pt, k, 'k', 33, 'ref')
    expect(r.perLayer).toBe(3)
    expect(r.layers).toBe(11)
    expect(r.doc.items).toHaveLength(33)
    expect(palletSummary(r.doc).totalHeightMm).toBe(150 + 11 * 180)
    expect(crit(r.doc)).toEqual([])
  })
  it('caixa 500×600 em 1150×1150: cata-vento de 4 por camada, sem colisão', () => {
    const pt = palletType({ dims: { l: 1150, w: 1150, h: 150 }, dynamicMaxKg: null })
    const k = pack({ dims: { l: 500, w: 600, h: 130 } })
    const r = buildReferencePallet(pt, k, 'k', 60, 'ref')
    expect(r.perLayer).toBe(4)
    expect(r.layers).toBe(15)
    expect(crit(r.doc)).toEqual([])
  })
  it('caixa 1000×600 em PBR 1000×1200: 2 por camada; última camada parcial', () => {
    const pt = palletType()
    const k = pack({ dims: { l: 1000, w: 600, h: 400 }, grossKg: 130 })
    const r = buildReferencePallet(pt, k, 'k', 9, 'ref')
    expect(r.perLayer).toBe(2)
    expect(r.layers).toBe(5)
    expect(r.doc.items).toHaveLength(9)
    expect(crit(r.doc)).toEqual(['PALLET_CAPACITY'].filter(() => 9 * 130 > 1200))
  })
  it('tolerância: 3 × 385 = 1155 mm em 1150 vira 3 por camada, com alerta de overhang', () => {
    const pt = palletType({ dims: { l: 2300, w: 1150, h: 150 }, dynamicMaxKg: null })
    const k = pack({ dims: { l: 2250, w: 385, h: 310 } })
    expect(buildReferencePallet(pt, k, 'k', 18, 'ref').perLayer).toBe(2)
    const r = buildReferencePallet(pt, k, 'k', 18, 'ref', 25)
    expect(r.perLayer).toBe(3)
    expect(r.layers).toBe(6)
    expect(crit(r.doc)).toContain('OVERHANG')
  })
  it('caixa maior que o palete fica centralizada e gera alerta de overhang', () => {
    const pt = palletType({ dims: { l: 2000, w: 1200, h: 150 } })
    const k = pack({ dims: { l: 2100, w: 364, h: 337 } })
    const r = buildReferencePallet(pt, k, 'k', 9, 'ref')
    expect(r.perLayer).toBe(3)
    expect(r.doc.items[0].pos.x).toBe(-50)
    expect(crit(r.doc)).toContain('OVERHANG')
  })
})

describe('camadas travadas', () => {
  it('padrão com orientações misturadas alterna camadas giradas 180° sem colisões', () => {
    // 500×600 em 1150×1150 → cata-vento (orientações misturadas)
    const pt = palletType({ dims: { l: 1150, w: 1150, h: 150 }, dynamicMaxKg: null })
    const r = buildReferencePallet(pt, pack({ dims: { l: 500, w: 600, h: 130 } }), 'k', 8, 'ref')
    expect(r.interlocked).toBe(true)
    const l0 = r.doc.items.filter((i) => i.pos.z === 0).map((i) => `${i.pos.x},${i.pos.y},${i.orientation}`).sort()
    const l1 = r.doc.items.filter((i) => i.pos.z === 130).map((i) => `${i.pos.x},${i.pos.y},${i.orientation}`).sort()
    expect(l1).not.toEqual(l0)
    expect(crit(r.doc)).toEqual([])
  })
  it('padrão de uma orientação só não muda', () => {
    const r = buildReferencePallet(palletType(), pack({ dims: { l: 1000, w: 600, h: 400 } }), 'k', 4, 'ref')
    expect(r.interlocked).toBe(false)
  })
})
