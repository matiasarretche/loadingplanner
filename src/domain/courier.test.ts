import { describe, expect, it } from 'vitest'
import { courierLayout, courierPlan, volumetricKg } from './courier'
import { placeLooseBoxes } from './autoload'
import { loadDoc, pack } from './fixtures'
import { kitOrderLines } from './kitBoxes'
import type { OrderLine } from './mixedPallets'
import { docOrderLines } from './noEquipment'
import { noneSpace, withNoneWorkArea } from './shipmentType'

const line = (sku: string, boxes: number, dims: { l: number; w: number; h: number }, grossKg: number, unitsPerPackage = 1) =>
  ({ packId: sku, boxes, pack: { sku, name: sku, dims, grossKg, unitsPerPackage } } as unknown as OrderLine)

describe('courier', () => {
  it('peso volumétrico = C×L×A (cm) ÷ divisor', () => {
    expect(volumetricKg({ l: 1000, w: 500, h: 400 })).toBeCloseTo(40) // 100×50×40/5000
    expect(volumetricKg({ l: 1000, w: 500, h: 400 }, 6000)).toBeCloseTo(33.333, 2)
  })
  it('cada caixa é um volume; taxável = maior entre real e volumétrico por volume', () => {
    const p = courierPlan([line('HS', 2, { l: 1000, w: 500, h: 400 }, 30), line('KIT', 2, { l: 200, w: 200, h: 200 }, 3)])
    expect(p.totals.pieces).toBe(4)
    expect(p.totals.grossKg).toBeCloseTo(66)
    expect(p.totals.volKg).toBeCloseTo(80 + 2 * 1.6)
    expect(p.totals.chargeableKg).toBeCloseTo(2 * 40 + 2 * 3) // HS volumétrico, KIT real
  })
})

describe('courierLayout', () => {
  const hs = (boxes: number) => ({ packId: 'h', boxes, pack: { sku: 'HS', name: 'HS', dims: { l: 600, w: 500, h: 130 }, grossKg: 9.7, unitsPerPackage: 1, color: '#0a0', stackable: true, maxStackLayers: null } } as unknown as OrderLine)
  it('lado a lado: todas no chão, sem sobreposição', () => {
    const l = courierLayout([hs(2)])
    expect(l.boxes.map((b) => b.min)).toEqual([{ x: 0, y: 0, z: 0 }, { x: 680, y: 0, z: 0 }])
    expect(l.size).toEqual({ x: 1280, y: 500, z: 130 })
  })
  it('empilhado: uma em cima da outra, numeradas como a lista', () => {
    const l = courierLayout([hs(2)], { stack: true })
    expect(l.boxes.map((b) => [b.n, b.min.z])).toEqual([[1, 0], [2, 130]])
    expect(l.size.z).toBe(260)
  })
  it('limite de desenho', () => expect(courierLayout([hs(10)], { maxBoxes: 4 }).hidden).toBe(6))
})

describe('courier: kits Hydroforce nas caixas da regra (sem palete)', () => {
  const kit = pack({ sku: 'KIT-HF', name: 'Kit Hydroforce', packagingVersionId: 155, dims: { l: 200, w: 200, h: 200 }, grossKg: 2, netKg: 2 })
  it('39 kits = 1 caixa 79583 (26) + 1 meia caixa (13): 2 volumes, uma linha por tipo de caixa', () => {
    const p = courierPlan(kitOrderLines(kit, 'pv155', 39))
    expect(p.totals.pieces).toBe(2)
    expect(p.totals.units).toBe(39)
    expect(p.rows.map((r) => [r.boxes, r.units, r.dimsMm.l, r.grossKgEach])).toEqual([
      [1, 26, 1140, 55.2],
      [1, 13, 570, 27.6],
    ])
    // o tipo da caixa vai à parte: cada saída (tela, PDF em pt/es/en) o escreve no seu idioma
    expect(p.rows.map((r) => r.kitBox)).toEqual([
      { kind: 'BIG', code: '79583', kits: 26 },
      { kind: 'HALF', code: '79583-M', kits: 13 },
    ])
    expect(p.rows[0].name).toBe('Kit Hydroforce')
    expect(p.totals.grossKg).toBeCloseTo(55.2 + 27.6, 6)
  })
  it('34 kits = 1 caixa 79583 (26) + 8 individuais', () => {
    const p = courierPlan(kitOrderLines(kit, 'pv155', 34))
    expect(p.rows.map((r) => [r.boxes, r.units, r.kitBox?.kind ?? 'IND'])).toEqual([
      [1, 26, 'BIG'],
      [8, 8, 'IND'],
    ])
  })
  it('linhas do envio (docOrderLines) separam as caixas coletivas da individual', () => {
    const lines = kitOrderLines(kit, 'pv155', 30)
    let doc = loadDoc({ space: noneSpace('COURIER') })
    for (const l of lines) doc = placeLooseBoxes(withNoneWorkArea(doc), l.packId, l.pack, l.boxes).doc
    const got = docOrderLines(doc).map((l) => [l.packId, l.boxes])
    expect(got.sort()).toEqual([
      ['pv155', 4],
      ['pv155:79583x26', 1],
    ])
  })
})
