import { describe, expect, it } from 'vitest'
import { newPhysicalCriticals, Issue } from './issues'
import { placementProblem, restZ } from './placement'

const box = (x: number, y: number, z: number, s = 100) => ({ min: { x, y, z }, size: { x: s, y: s, z: s } })
const o = { lo: { x: 0, y: 0, z: 0 }, hi: { x: 1000, y: 1000, z: 500 }, minSupportPct: 80 }

describe('posição manual (arrasto no 3D)', () => {
  const base = [{ box: box(0, 0, 0), stackable: true }]
  it('assenta na superfície mais alta sob a base; encostar ao lado não sobe', () => {
    expect(restZ(base, box(20, 20, 999))).toBe(100)
    expect(restZ(base, box(100, 0, 999))).toBe(0)
    expect(restZ(base, box(99, 0, 999))).toBe(0) // 1 mm de sobreposição: margem
  })
  it('valida colisão, limites, altura, apoio e flutuação', () => {
    expect(placementProblem(base, box(0, 0, 100), o)).toBeNull()
    expect(placementProblem(base, box(50, 0, 0), o)).toMatch(/atravessa/)
    expect(placementProblem(base, box(950, 0, 0), o)).toMatch(/limites/)
    expect(placementProblem(base, box(0, 0, 450), o)).toMatch(/altura/)
    expect(placementProblem(base, box(300, 0, 200), o)).toMatch(/flutuando/)
    expect(placementProblem(base, box(50, 0, 100), o)).toMatch(/apoio insuficiente/)
    expect(placementProblem([{ box: box(0, 0, 0), stackable: false }], box(0, 0, 100), o)).toMatch(/não aceita/)
  })
  it('só os críticos físicos NOVOS contam', () => {
    const a: Issue = { code: 'COLLISION', severity: 'CRITICAL', message: 'x', refs: ['a', 'b'] }
    const q: Issue = { code: 'QUADRANT_SOUTH', severity: 'CRITICAL', message: 'q', refs: [] }
    const n: Issue = { code: 'UNSUPPORTED', severity: 'CRITICAL', message: 'n', refs: ['c'] }
    expect(newPhysicalCriticals([a], [{ ...a, refs: ['b', 'a'] }, q, n])).toEqual([n])
  })
})
