import { describe, expect, it } from 'vitest'
import { placeLooseBoxes } from './autoload'
import { loadDoc, pack, palletDoc } from './fixtures'
import { validateLoad } from './load'
import { placeMixedPalletsInLoad } from './mixedLoad'
import { fitNone, noneMetrics } from './noEquipment'
import { loadDocSchema } from './schemas'
import { docServiceError, noneSpace, versionSpaceColumns, withNoneWorkArea } from './shipmentType'

const a = pack({ sku: 'SB-A', packagingVersionId: 7, grossKg: 20, netKg: 18, dims: { l: 500, w: 400, h: 300 } })
const grid = [0, 300].flatMap((z) => [0, 500].flatMap((x) => [0, 400, 800].map((y) => ({ id: `${x}-${y}-${z}`, packId: 'pv7', pos: { x, y, z }, orientation: 'LWH' as const, locked: false }))))
const pal = palletDoc({ packs: { pv7: a }, items: grid })

describe('envio sem equipamento (piso virtual)', () => {
  it('espaço NONE válido no schema; colunas da versão com typeId 0', () => {
    const d = loadDoc({ space: noneSpace('LCL', { maxHeightMm: 1800 }) })
    expect(loadDocSchema.safeParse(d).success).toBe(true)
    expect(versionSpaceColumns(d.space)).toEqual({ spaceKind: 'NONE', spaceTypeId: 0 })
    expect(d.space.inner.h).toBe(1800)
    // NONE sem tipo é inválido
    expect(loadDocSchema.safeParse({ ...d, space: { ...d.space, service: undefined } }).success).toBe(false)
  })

  it('paletes mistos no piso de trabalho e piso ajustado ao conteúdo; sem alertas de equipamento', () => {
    const d0 = withNoneWorkArea(loadDoc({ space: noneSpace('PALLETS_ONLY') }))
    const r = placeMixedPalletsInLoad(d0, [pal, pal, pal, pal, pal], 'mx')
    expect(r.placed).toBe(5)
    const d = fitNone(r.doc)
    expect(d.space.inner.l).toBeLessThan(10_000)
    const { issues } = validateLoad(d)
    const codes = issues.map((i) => i.code)
    for (const c of ['OUT_OF_BOUNDS', 'LOW_UTILIZATION', 'CG_LONGITUDINAL', 'WEIGHT_FRONT', 'QUADRANT_SOUTH']) expect(codes).not.toContain(c)
    expect(issues.some((i) => /payload/.test(i.message))).toBe(false)
    const m = noneMetrics(d)
    expect(m.pallets).toBe(5)
    expect(m.boxes).toBe(60)
    expect(m.chargeableKg).toBeNull()
    // idempotente
    expect(fitNone(d)).toBe(d)
  })

  it('aéreo carga solta: peso taxável = maior entre real e volume × 166,67', () => {
    const d0 = withNoneWorkArea(loadDoc({ space: noneSpace('AIR_LOOSE') }))
    const d = fitNone(placeMixedPalletsInLoad(d0, [pal], 'mx').doc)
    const m = noneMetrics(d)
    expect(m.chargeableKg).toBeCloseTo(Math.max(m.grossKg, (m.cbm * 1e6) / 6000), 6)
  })

  it('courier: volumes no piso e peso volumétrico pelo divisor', () => {
    const d0 = withNoneWorkArea(loadDoc({ space: noneSpace('COURIER', { courierDivisor: 5000 }) }))
    const r = placeLooseBoxes(d0, 'pv7', a, 10, {})
    expect(r.placed).toBe(10)
    const m = noneMetrics(fitNone(r.doc))
    expect(m.courier!.pieces).toBe(10)
    expect(m.courier!.volKg).toBeCloseTo(10 * ((50 * 40 * 30) / 5000), 6)
    expect(m.chargeableKg).toBeCloseTo(10 * Math.max(20, 12), 6)
  })

  it('o espaço tem de corresponder ao tipo do envio', () => {
    expect(docServiceError(noneSpace('LCL'), 'LCL')).toBeNull()
    expect(docServiceError(noneSpace('LCL'), 'COURIER')).not.toBeNull()
    expect(docServiceError(noneSpace('LCL'), 'FCL')).not.toBeNull()
  })
})

describe('Caminhão consolidado (ROAD_LTL)', () => {
  it('é envio sem equipamento: piso virtual rodoviário, altura padrão 2.000 mm, sem peso taxável', () => {
    const sp = noneSpace('ROAD_LTL')
    expect(sp).toMatchObject({ kind: 'NONE', service: 'ROAD_LTL', transport: 'ROAD', maxLoadHeightMm: 2000, inner: { h: 2000 } })
    expect(loadDocSchema.safeParse({ ...loadDoc(), space: sp }).success).toBe(true)
    expect(docServiceError(sp, 'ROAD_LTL')).toBeNull()
    expect(docServiceError(noneSpace('LCL'), 'ROAD_LTL')).not.toBeNull()
    expect(noneMetrics({ ...loadDoc(), space: sp }).chargeableKg).toBeNull()
  })
})
