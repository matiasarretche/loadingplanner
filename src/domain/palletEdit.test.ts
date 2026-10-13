import { describe, expect, it } from 'vitest'
import { placePallets } from './autoload'
import { container, loadDoc, pack, palletDoc, palletType } from './fixtures'
import { orientDims } from './geometry'
import { palletParts } from './load'
import { editPalletItems, itemToSpace, ownPallet, spaceDeltaToLocal, spaceToItemPos } from './palletEdit'

const pt = palletType({ dims: { l: 1000, w: 1200, h: 137 } })
const box = pack({ sku: 'A', packagingVersionId: 1, dims: { l: 400, w: 300, h: 200 } })
const p = palletDoc({ palletType: pt, packs: { a: box }, items: [0, 1, 2].map((i) => ({ id: `i${i}`, packId: 'a', pos: { x: i * 400, y: 0, z: 0 }, orientation: 'LWH' as const, locked: false })) })

describe('edição das caixas dentro de um palete da carga', () => {
  const doc = placePallets(loadDoc({ space: container('40GP') }), 'p', p, 2, { allowStacking: false }).doc
  it('cópia própria só para o palete editado (os iguais não mudam)', () => {
    const u = doc.units[0]
    const r = ownPallet(doc, u.id)!
    expect(r.key).not.toBe('p')
    const d2 = editPalletItems(doc, u.id, (pp) => ({ ...pp, items: pp.items.slice(1) }))
    const own = d2.units.find((x) => x.id === u.id)!
    const other = d2.units.find((x) => x.id !== u.id)!
    expect(own.kind === 'PALLET' && d2.pallets[own.palletKey].items).toHaveLength(2)
    expect(other.kind === 'PALLET' && d2.pallets[other.palletKey].items).toHaveLength(3)
  })
  it('coordenadas local ↔ carga coincidem com o desenho (com e sem giro)', () => {
    for (const yaw of [false, true]) {
      const unit = { pos: { x: 1000, y: 200, z: 0 }, yaw }
      const parts = palletParts(p, unit).filter((x) => x.packId)
      p.items.forEach((it, k) => {
        const w = itemToSpace(p, unit, it)
        expect(w).toEqual(parts[k].box)
        expect(spaceToItemPos(p, unit, w.min, orientDims(box.dims, it.orientation))).toEqual(it.pos)
      })
    }
  })
  it('seta para a direita no 3D vira o eixo local certo no palete girado', () => {
    expect(spaceDeltaToLocal({ yaw: false }, { x: 10, y: 0, z: 0 })).toEqual({ x: 10, y: 0, z: 0 })
    expect(spaceDeltaToLocal({ yaw: true }, { x: 10, y: 0, z: 0 })).toEqual({ x: 0, y: -10, z: 0 })
  })
})

describe('palete personalizado montado no 3D (vazio → caixas)', () => {
  it('palete vazio entra na carga, recebe caixas apoiadas e os totais acompanham', async () => {
    const { addBoxesToMixed } = await import('./mixedPallets')
    const { validateLoad } = await import('./load')
    const pt2 = palletType({ code: 'PCF-1150', dims: { l: 1150, w: 1150, h: 150 }, dynamicMaxKg: 1500 })
    const empty = palletDoc({ name: 'Palete personalizado · PCF-1150', palletType: pt2, packs: {}, items: [] })
    let d = loadDoc({ space: container('40GP'), pallets: { custom1: empty }, units: [{ id: 'u1', kind: 'PALLET', palletKey: 'custom1', pos: { x: 0, y: 0, z: 0 }, yaw: false, locked: false }] })
    const before = validateLoad(d).summary
    expect(before.pallets).toBe(1)
    const k = pack({ sku: 'HS-10K', packagingVersionId: 7, dims: { l: 1140, w: 570, h: 150 }, grossKg: 28 })
    d = editPalletItems(d, 'u1', (p) => addBoxesToMixed(p, 'pv7', k, 10, 2292).doc)
    const v = validateLoad(d)
    expect(d.pallets.custom1.items).toHaveLength(10)
    expect(v.summary.packages).toBe(10)
    expect(v.summary.grossKg - before.grossKg).toBeCloseTo(280, 0)
    expect(v.issues.filter((i) => i.severity === 'CRITICAL')).toEqual([])
  })
})
