import { describe, expect, it } from 'vitest'
import { boxesPerPallet } from './spread'

describe('boxesPerPallet (camadas inteiras)', () => {
  it('120 caixas, 2 por camada: 22 paletes → diferença de no máximo uma camada, soma igual', () => {
    const q = boxesPerPallet({ boxes: 120, perLayer: 2 }, 22)
    expect(q.reduce((a, b) => a + b, 0)).toBe(120)
    expect(q.every((x) => x % 2 === 0)).toBe(true)
    expect(Math.max(...q) - Math.min(...q)).toBeLessThanOrEqual(2)
  })
  it('caixas que não fecham camada vão num palete só', () => {
    const q = boxesPerPallet({ boxes: 25, perLayer: 4 }, 3)
    expect(q.reduce((a, b) => a + b, 0)).toBe(25)
    expect(q.filter((x) => x % 4 !== 0)).toHaveLength(1)
  })
})
