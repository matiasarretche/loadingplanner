import { describe, expect, it } from 'vitest'
import { container, loadDoc, pack } from './fixtures'
import { evaluateQuadrants, footprintFractions, quadrantShares, sharesFromKg } from './quadrants'

describe('quadrantes (convenção Norte = motorista x=0, Sul = porta x=L, Oeste y=0, Leste y=W)', () => {
  const L = 12000, W = 2400
  it('elemento inteiro num quadrante recebe 100% do peso', () => {
    expect(footprintFractions({ min: { x: 0, y: 0, z: 0 }, size: { x: 1000, y: 1000, z: 1 } }, L, W)).toEqual({ NE: 0, NO: 1, SE: 0, SO: 0 })
    expect(footprintFractions({ min: { x: 11000, y: 1400, z: 0 }, size: { x: 1000, y: 1000, z: 1 } }, L, W)).toEqual({ NE: 0, NO: 0, SE: 1, SO: 0 })
  })
  it('elemento que cruza a linha divide o peso pela área (ex.: 70% / 30%)', () => {
    // 1000 de largura: 700 em y < 1200 (Oeste) e 300 em y > 1200 (Leste)
    const f = footprintFractions({ min: { x: 0, y: 500, z: 0 }, size: { x: 1000, y: 1000, z: 1 } }, L, W)
    expect(f.NO).toBeCloseTo(0.7, 9)
    expect(f.NE).toBeCloseTo(0.3, 9)
  })
  it('cruzando os 4 quadrantes no centro: 25% cada', () => {
    const f = footprintFractions({ min: { x: 5500, y: 700, z: 0 }, size: { x: 1000, y: 1000, z: 1 } }, L, W)
    for (const q of ['NE', 'NO', 'SE', 'SO'] as const) expect(f[q]).toBeCloseTo(0.25, 9)
  })
  it('regra: o mais uniforme possível, com 1–2 p.p. a mais na metade traseira; nunca mais peso na frente', () => {
    const ideal = evaluateQuadrants(sharesFromKg({ NE: 246, NO: 246, SE: 254, SO: 254 })) // 49,2 / 50,8
    expect(ideal.ok).toBe(true)
    expect(ideal.zone).toBe('ideal')
    const even = evaluateQuadrants(sharesFromKg({ NE: 250, NO: 250, SE: 250, SO: 250 })) // 50 / 50
    expect(even.ok).toBe(true)
    expect(even.zone).toBe('ok')
    expect(even.idealGap).toBeCloseTo(0.5, 9)
    const front = evaluateQuadrants(sharesFromKg({ NE: 253, NO: 253, SE: 247, SO: 247 })) // 50,6 na frente
    expect(front.zone).toBe('front')
    expect(front.frontExcess).toBeCloseTo(0.6, 9)
    expect(front.ok).toBe(false)
    const rear = evaluateQuadrants(sharesFromKg({ NE: 240, NO: 240, SE: 260, SO: 260 })) // 52 atrás
    expect(rear.zone).toBe('rear')
    expect(rear.rearExcess).toBeCloseTo(1, 9)
    expect(rear.ok).toBe(false)
  })
  it('caixa solta conta pelo peso real', () => {
    const doc = loadDoc({ space: container('40HC'), packs: { a: pack({ dims: { l: 1000, w: 1000, h: 300 }, grossKg: 100 }) }, units: [{ id: 'b', kind: 'PACKAGE', packId: 'a', pos: { x: 0, y: 0, z: 0 }, orientation: 'LWH', locked: false }] })
    expect(quadrantShares(doc).pct.NO).toBe(100)
  })
})
