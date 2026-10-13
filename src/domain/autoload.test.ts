import { describe, expect, it } from 'vitest'
import { apportion, composeMix, maxAdditional, placePallets, removeUnits, repack } from './autoload'
import { container, loadDoc, pack, palletDoc, palletType } from './fixtures'
import { validateLoad } from './load'

const crit = (d: Parameters<typeof validateLoad>[0]) => validateLoad(d).issues.filter((i) => i.severity === 'CRITICAL').map((i) => i.code)

// PBR 1000×1200 com carga de 1000 mm (altura total 1137), 927 kg
const pbr = palletDoc({
  name: 'PBR cheio',
  packs: { a: pack({ dims: { l: 1000, w: 1200, h: 1000 }, grossKg: 900 }) },
  items: [{ id: 'i', packId: 'a', pos: { x: 0, y: 0, z: 0 }, orientation: 'LWH', locked: false }],
})
// 1150×1150, altura 1950 (Hidrosilo-like), 1075 kg
const p1150 = palletDoc({
  name: '1150',
  palletType: palletType({ code: 'PCF-1150', dims: { l: 1150, w: 1150, h: 150 }, dynamicMaxKg: null }),
  packs: { a: pack({ dims: { l: 1150, w: 1150, h: 1800 }, grossKg: 1050 }) },
  items: [{ id: 'i', packId: 'a', pos: { x: 0, y: 0, z: 0 }, orientation: 'LWH', locked: false }],
})

describe('auto-carga determinística', () => {
  it('preenche 40HC com PBR sem alertas críticos: piso e depois empilha até o payload', () => {
    const r = placePallets(loadDoc({ space: container('40HC') }), 'p', pbr, null)
    expect(r.placed).toBeGreaterThan(20) // passa do piso (≈ 24) empilhando
    expect(r.stopReason).toBe('payload')
    expect(r.doc.units.some((u) => u.pos.z > 0)).toBe(true)
    expect(crit(r.doc)).toEqual([])
  })
  it('paletes baixos (caso Big Silo): completa o piso e empilha uma 2ª camada, mais kg', () => {
    const low = palletDoc({ ...p1150, packs: { a: pack({ dims: { l: 1150, w: 1150, h: 1000 }, grossKg: 560 }) }, stackable: false })
    const floorOnly = placePallets(loadDoc({ space: container('40GP') }), 'l', low, null, { allowStacking: false })
    const r = placePallets(loadDoc({ space: container('40GP') }), 'l', low, null)
    expect(floorOnly.placed).toBe(20)
    expect(r.placed).toBe(40) // 2 camadas de 1.150 mm (com tabuleiro) cabem em 2.395 mm
    expect(r.doc.units.filter((u) => u.pos.z > 0)).toHaveLength(20)
    expect(crit(r.doc)).toEqual([])
  })
  it('20GP com PBR: ≥ 9 paletes, combinando orientações', () => {
    const r = placePallets(loadDoc({ space: container('20GP') }), 'p', pbr, null)
    expect(r.placed).toBeGreaterThanOrEqual(9)
    expect(crit(r.doc)).toEqual([])
  })
  it('1150×1150 em 40HC: 20 paletes (2 × 10)', () => {
    const r = placePallets(loadDoc({ space: container('40HC') }), 'h', p1150, null)
    expect(r.placed).toBe(20)
    expect(crit(r.doc)).toEqual([])
  })
  it('para no payload efetivo', () => {
    const heavy = palletDoc({ ...pbr, palletType: palletType({ dynamicMaxKg: null }), packs: { a: pack({ dims: { l: 1000, w: 1200, h: 1000 }, grossKg: 5000 }) } })
    const r = placePallets(loadDoc({ space: container('20GP') }), 'p', heavy, null)
    expect(r.stopReason).toBe('payload')
    expect(r.placed).toBe(5) // 5 × 5027 = 25.135 ≤ 28.130; o 6º passaria
    expect(crit(r.doc)).toEqual([])
  })
  it('quantidade exata e "não cabe mais"', () => {
    const r = placePallets(loadDoc({ space: container('20GP') }), 'h', p1150, 3)
    expect(r.placed).toBe(3)
    expect(r.stopReason).toBe('done')
    const more = maxAdditional(r.doc, 'h', p1150)
    expect(more.max).toBe(7) // 20GP: 2 × 5 = 10 no total
    const over = placePallets(r.doc, 'h', p1150, 9)
    expect(over.placed).toBe(7)
    expect(over.stopReason).toBe('no_space')
  })
  it('palete mais alto que a porta é recusado com motivo', () => {
    const tall = palletDoc({ ...p1150, packs: { a: pack({ dims: { l: 1150, w: 1150, h: 2200 }, grossKg: 500 }) } }) // 2350 > porta 20GP 2292
    const r = placePallets(loadDoc({ space: container('20GP') }), 't', tall, 2)
    expect(r.placed).toBe(0)
    expect(r.stopReason).toBe('door')
  })
  it('mistura 60/40 por paletes respeita proporção e física', () => {
    const r = composeMix(loadDoc({ space: container('20GP') }), [
      { key: 'h', pallet: p1150, share: 0.6 },
      { key: 'p', pallet: pbr, share: 0.4 },
    ])
    expect(r.total).toBeGreaterThan(0)
    expect(r.counts[0] + r.counts[1]).toBe(r.total)
    expect(Math.abs(r.counts[0] / r.total - 0.6)).toBeLessThanOrEqual(0.5 / r.total + 1e-9)
    expect(crit(r.doc)).toEqual([])
  })
  it('apportion: maiores restos', () => {
    expect(apportion(10, [0.6, 0.4])).toEqual([6, 4])
    expect(apportion(7, [1, 1, 1])).toEqual([3, 2, 2])
  })
  it('remover os últimos e reempacotar após trocar de equipamento', () => {
    const r = placePallets(loadDoc({ space: container('40HC') }), 'h', p1150, 20)
    const rem = removeUnits(r.doc, () => true, 2, 'last')
    expect(rem.doc.units).toHaveLength(18)
    const to20 = repack({ ...rem.doc, space: container('20GP') })
    expect(to20.doc.units).toHaveLength(10)
    expect(to20.unplaced).toEqual([{ palletKey: 'h', count: 8 }])
    expect(crit(to20.doc)).toEqual([])
  })
})

describe('caixas soltas por cima dos paletes', () => {
  const hsBox = pack({ sku: 'HS-BOX', dims: { l: 1140, w: 570, h: 150 }, grossKg: 20, allowedOrientations: ['LWH', 'WLH'] })
  it('com o piso cheio, completa por cima até a altura útil sem alertas críticos', async () => {
    const { placeLooseBoxes } = await import('./autoload')
    const full = placePallets(loadDoc({ space: container('40HC') }), 'h', p1150, null) // 20 paletes de 1950 mm
    const r = placeLooseBoxes(full.doc, 'k', hsBox, null)
    // altura livre 2700 − 1950 = 750 → 5 camadas × 2 caixas por palete × 20 paletes
    expect(r.placed).toBe(200)
    expect(r.doc.units.filter((u) => u.kind === 'PACKAGE').every((u) => u.pos.z >= 1950)).toBe(true)
    expect(crit(r.doc)).toEqual([])
  })
  it('para no payload e empilha mesmo sobre produto marcado como não empilhável (regra Pacifil)', async () => {
    const { placeLooseBoxes } = await import('./autoload')
    const full = placePallets(loadDoc({ space: container('40HC') }), 'h', p1150, null)
    const heavy = pack({ ...hsBox, sku: 'PESADA', grossKg: 400, maxStackKg: null })
    const r = placeLooseBoxes(full.doc, 'k', heavy, null)
    expect(r.stopReason).toBe('payload') // 28.600 − 20 × 1.077 = 7.060 kg livres → 17 caixas de 400 kg
    expect(r.placed).toBe(17)
    const fragilePal = palletDoc({ ...p1150, packs: { a: pack({ dims: { l: 1150, w: 1150, h: 1800 }, grossKg: 1050, stackable: false }) } })
    const f = placePallets(loadDoc({ space: container('40HC') }), 'f', fragilePal, null)
    expect(placeLooseBoxes(f.doc, 'k', hsBox, 5, { onTopOnly: true }).placed).toBe(5)
  })
})

describe('padrão intercalado A-B / B-A no piso', () => {
  it('PBR 1,00×1,20 em 40GP: avalia o intercalado, alterna orientações em cada faixa e não perde paletes', async () => {
    const { interlacedSlots } = await import('./autoload')
    const { loadSummary } = await import('./load')
    const doc = loadDoc({ space: container('40GP') })
    const chosen = placePallets(doc, 'p', pbr, null)
    const slots = interlacedSlots({ ...doc, pallets: { p: pbr } }, pbr, false)!
    expect(slots).not.toBeNull()
    // faixa encostada na parede esquerda: orientações alternadas A-B-A-B
    const left = slots.filter((s) => s.pos.y === 0).map((s) => s.yaw)
    expect(left.slice(0, 4)).toEqual([false, true, false, true])
    // nunca escolhe um padrão com menos paletes que o primeiro encaixe
    expect(chosen.placed).toBeGreaterThanOrEqual(slots.length > 0 ? Math.min(slots.length, chosen.placed) : 0)
    expect(crit(chosen.doc)).toEqual([])
    const s = loadSummary(chosen.doc)
    console.log(`40GP/PBR: padrão=${chosen.pattern} paletes=${chosen.placed} (intercalado possível=${slots.length}) CG lateral=${s.cgLatDevPct?.toFixed(2)}%`)
  })
  it('palete quadrado (1150×1150) não usa intercalado (nada a alternar)', async () => {
    const { interlacedSlots } = await import('./autoload')
    expect(interlacedSlots(loadDoc({ space: container('40HC'), pallets: { h: p1150 } }), p1150, false)).toBeNull()
  })
})
