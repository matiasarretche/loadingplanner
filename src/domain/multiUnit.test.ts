import { describe, expect, it } from 'vitest'
import { container, loadDoc, pack, palletDoc, palletType } from './fixtures'
import { validateLoad } from './load'
import { splitIntoUnits } from './multiUnit'

const crit = (d: Parameters<typeof validateLoad>[0]) => validateLoad(d).issues.filter((i) => i.severity === 'CRITICAL').map((i) => i.code)
const count = (d: Parameters<typeof validateLoad>[0]) => d.units.length

// 1150×1150 altos (não empilham por altura num 40GP): 20 por contêiner no piso, 1075 kg
const tall = (name: string, kg: number) =>
  palletDoc({
    name,
    palletType: palletType({ code: 'PCF-1150', dims: { l: 1150, w: 1150, h: 150 }, dynamicMaxKg: null }),
    packs: { a: pack({ sku: name, dims: { l: 1150, w: 1150, h: 1800 }, grossKg: kg }) },
    items: [{ id: 'i', packId: 'a', pos: { x: 0, y: 0, z: 0 }, orientation: 'LWH', locked: false }],
  })

describe('pedido em várias unidades: encher a 1ª, remanente na última', () => {
  const base = loadDoc({ space: container('40GP') })
  it('28 paletes (≈ 1,4 contêiner) → 20 + 8, não 14 + 14', () => {
    const r = splitIntoUnits(base, [{ key: 'a', pallet: tall('A', 900), count: 28 }])
    expect(r.units.map((u) => count(u.doc))).toEqual([20, 8])
    expect(r.unplaced).toEqual([])
    for (const u of r.units) expect(crit(u.doc)).toEqual([])
  })
  it('prefere produtos inteiros: a linha que não cabe inteira só completa o espaço que sobrou', () => {
    const r = splitIntoUnits(base, [
      { key: 'a', pallet: tall('A', 900), count: 12 },
      { key: 'b', pallet: tall('B', 800), count: 6 },
      { key: 'c', pallet: tall('C', 700), count: 7 },
    ])
    expect(count(r.units[0].doc)).toBe(20) // 1º cheio
    const first = Object.fromEntries(r.units[0].groups.map((g) => [g.key, g.count]))
    expect(first).toEqual({ a: 12, c: 7, b: 1 }) // linhas inteiras por kg total (A 10.800, C 4.900); B completa
    expect(r.units[1].groups).toEqual([{ key: 'b', name: 'B', count: 5 }])
  })
  it('sugere equipamento menor para o remanente quando ele cabe', () => {
    const r = splitIntoUnits(base, [{ key: 'a', pallet: tall('A', 900), count: 23 }], [], { alternatives: [container('20GP'), container('40HC')] })
    expect(r.units.map((u) => count(u.doc))).toEqual([20, 3])
    expect(r.smallerLast?.code).toBe('20GP')
  })
  it('tudo cabe numa unidade → uma só', () => {
    const r = splitIntoUnits(base, [{ key: 'a', pallet: tall('A', 900), count: 5 }])
    expect(r.units).toHaveLength(1)
  })
})
