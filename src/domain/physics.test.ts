import { describe, expect, it } from 'vitest'
import { container, loadDoc, pack, palletDoc } from './fixtures'
import { loadSummary, validateLoad } from './load'
import { removeBoxesFromPallet } from './partial'
import type { LoadUnit } from './types'

const crit = (d: Parameters<typeof validateLoad>[0]) => validateLoad(d).issues.filter((i) => i.severity === 'CRITICAL').map((i) => i.code)

// palete PBR com 2 camadas × 2 caixas de 1000×600×300 (topo da carga a 137 + 600 = 737 mm)
const box = pack({ sku: 'A', dims: { l: 1000, w: 600, h: 300 }, grossKg: 20, netKg: 18, stackable: true, maxStackKg: 100 })
const pal = palletDoc({
  packs: { a: box },
  items: [0, 1].flatMap((z) => [0, 1].map((y) => ({ id: `i${z}${y}`, packId: 'a', pos: { x: 0, y: y * 600, z: z * 300 }, orientation: 'LWH' as const, locked: false }))),
})
const P = (id: string, x: number, z = 0): LoadUnit => ({ id, kind: 'PALLET', palletKey: 'p', pos: { x, y: 0, z }, yaw: false, locked: false })
const B = (id: string, x: number, y: number, z: number, packId = 'l'): LoadUnit => ({ id, kind: 'PACKAGE', packId, pos: { x, y, z }, orientation: 'LWH', locked: false })

describe('modelo físico detalhado (caixas sobre paletes)', () => {
  it('caixa solta apoiada no topo de um palete completo: válida e somada ao payload', () => {
    const doc = loadDoc({ space: container('40HC'), pallets: { p: pal }, packs: { l: box }, units: [P('u1', 0), B('b1', 0, 0, 737)] })
    expect(crit(doc)).toEqual([])
    expect(loadSummary(doc).payloadKg).toBe(4 * 20 + 27 + 20)
  })
  it('caixa solta no vão de um palete parcial (dentro do envelope) não colide e se apoia na camada de baixo', () => {
    const base = loadDoc({ space: container('40HC'), pallets: { p: pal }, packs: { l: box }, units: [P('u1', 0)] })
    const partial = removeBoxesFromPallet(base, 'u1', 1).doc // retira 1 caixa do topo (y = 600)
    const doc = { ...partial, units: [...partial.units, B('b1', 0, 600, 437)] }
    expect(crit(doc)).toEqual([])
  })
  it('caixa sobre produto marcado como não empilhável é permitida (regra Pacifil)', () => {
    const fragile = pack({ sku: 'F', dims: { l: 1000, w: 600, h: 300 }, stackable: false })
    const pf = palletDoc({ packs: { f: fragile }, items: [{ id: 'i', packId: 'f', pos: { x: 0, y: 0, z: 0 }, orientation: 'LWH', locked: false }] })
    const doc = loadDoc({ space: container('40HC'), pallets: { p: pf }, packs: { l: box }, units: [P('u1', 0), B('b1', 0, 0, 437)] })
    expect(crit(doc)).not.toContain('STACK_NOT_ALLOWED')
  })
  it('peso por cima da caixa do topo é respeitado', () => {
    const heavy = pack({ sku: 'H', dims: { l: 1000, w: 600, h: 300 }, grossKg: 150 })
    const doc = loadDoc({ space: container('40HC'), pallets: { p: pal }, packs: { h: heavy }, units: [P('u1', 0), B('b1', 0, 0, 737, 'h')] })
    expect(crit(doc)).toContain('STACK_WEIGHT') // 150 kg > 100 kg de máximo por cima
  })
  it('palete sobre palete: sempre permitido e o peso é distribuído pelas caixas de baixo', () => {
    const doc = loadDoc({ space: container('40HC'), pallets: { p: pal }, units: [P('u1', 0), P('u2', 0, 737)] })
    expect(crit(doc)).not.toContain('STACK_NOT_ALLOWED')
    const stackable = { ...pal, stackable: true }
    const ok = loadDoc({ space: container('40HC'), pallets: { p: stackable }, units: [P('u1', 0), P('u2', 0, 737)] })
    // 107 kg do palete de cima divididos entre 2 caixas do topo (53,5 kg cada) ≤ 100 kg
    expect(crit(ok)).toEqual([])
  })
  it('caixa flutuando acima do palete é detectada', () => {
    const doc = loadDoc({ space: container('40HC'), pallets: { p: pal }, packs: { l: box }, units: [P('u1', 0), B('b1', 0, 0, 900)] })
    expect(crit(doc)).toContain('UNSUPPORTED')
  })
})

describe('estado da carga', () => {
  it('distingue palete completo, parcial, caixa no piso e empilhada; calcula folgas', async () => {
    const { loadState } = await import('./state')
    const base = loadDoc({ space: container('40HC'), pallets: { p: pal }, packs: { l: box }, units: [P('u1', 0), P('u2', 1000), B('b1', 0, 0, 737), B('b2', 3000, 0, 0)] })
    const doc = removeBoxesFromPallet(base, 'u2', 1).doc
    const st = loadState(doc)
    expect(st.counts).toEqual({ fullPallets: 1, partialPallets: 1, boxesOnFloor: 1, boxesStacked: 1 })
    expect(st.units.find((u) => u.id === 'u2')).toMatchObject({ status: 'PALLET_PARTIAL', boxes: 3, fullBoxes: 4 })
    expect(st.maxTopMm).toBe(1037)
    expect(st.remainingPayloadKg).toBe(28600 - st.payloadKg)
  })
})
