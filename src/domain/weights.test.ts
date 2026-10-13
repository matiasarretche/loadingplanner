import { describe, expect, it } from 'vitest'
import { placePallets } from './autoload'
import { container, loadDoc, pack, palletDoc, palletType } from './fixtures'
import { loadSummary } from './load'
import { palletTareBySku } from './weights'

describe('três pesos: líquido, com embalagem e bruto (c/ palete)', () => {
  it('a tara de cada palete é repartida entre os produtos e fecha com o peso bruto da carga', () => {
    const pt = palletType({ tareKg: 25 })
    const a = pack({ sku: 'A', packagingVersionId: 1, grossKg: 100, netKg: 94 })
    const b = pack({ sku: 'B', packagingVersionId: 2, grossKg: 50, netKg: 47 })
    const item = (id: string, packId: string, z: number) => ({ id, packId, pos: { x: 0, y: 0, z }, orientation: 'LWH' as const, locked: false })
    const mixed = palletDoc({ palletType: pt, packs: { a, b }, items: [item('1', 'a', 0), item('2', 'a', 400), item('3', 'b', 800), item('4', 'b', 1200)] })
    const doc = placePallets(loadDoc({ space: container('40HC') }), 'm', mixed, 4).doc
    const t = palletTareBySku(doc)
    // por palete: A 200 kg e B 100 kg com embalagem → 2/3 e 1/3 dos 25 kg
    expect(t.get('A')).toBeCloseTo((4 * 25 * 2) / 3, 6)
    expect(t.get('B')).toBeCloseTo((4 * 25) / 3, 6)
    const s = loadSummary(doc)
    const packed = s.bySku.reduce((x, l) => x + l.grossKg, 0)
    expect(packed + (t.get('A') ?? 0) + (t.get('B') ?? 0)).toBeCloseTo(s.payloadKg, 6)
    expect(s.netKg).toBeLessThan(packed)
  })
})
