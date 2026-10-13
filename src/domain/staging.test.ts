import { describe, expect, it } from 'vitest'
import { placePallets } from './autoload'
import { balanceWeight } from './balance'
import { container, loadDoc, pack, palletDoc } from './fixtures'
import { validateLoad } from './load'
import { quadrantShares } from './quadrants'

const pbr = palletDoc({
  packs: { a: pack({ dims: { l: 1000, w: 1200, h: 1000 }, grossKg: 900 }) },
  items: [{ id: 'i', packId: 'a', pos: { x: 0, y: 0, z: 0 }, orientation: 'LWH', locked: false }],
})
const base = placePallets(loadDoc({ space: container('40GP') }), 'p', pbr, 4, { allowStacking: false }).doc
const moveTo = (id: string, x: number, y: number) => ({ ...base, units: base.units.map((u) => (u.id === id ? { ...u, pos: { x, y, z: 0 } } : u)) })

describe('zona de trabalho fora do equipamento', () => {
  const id = base.units[0].id
  it('palete totalmente fora: pendente de ubicação, não conta como carregado', () => {
    const d = moveTo(id, -3000, 0) // antes da parede do motorista
    const { issues, summary } = validateLoad(d)
    expect(issues.filter((i) => i.code === 'OUTSIDE_LOAD').map((i) => i.refs)).toEqual([[id]])
    expect(issues.some((i) => i.code === 'OUT_OF_BOUNDS')).toBe(false)
    expect(summary.pallets).toBe(3)
    expect(quadrantShares(d).totalKg).toBeCloseTo(quadrantShares(base).totalKg * 0.75, 0)
  })
  it('meio dentro, meio fora continua inválido (OUT_OF_BOUNDS)', () => {
    const { issues } = validateLoad(moveTo(id, -500, 0))
    expect(issues.some((i) => i.code === 'OUT_OF_BOUNDS' && i.refs.includes(id))).toBe(true)
    expect(issues.some((i) => i.code === 'OUTSIDE_LOAD')).toBe(false)
  })
  it('distribuir peso não mexe no palete que está fora', () => {
    const d = moveTo(id, 0, -2000) // ao lado da parede oeste
    const r = balanceWeight(d)
    expect(r.doc.units.find((u) => u.id === id)?.pos).toEqual({ x: 0, y: -2000, z: 0 })
  })
})
