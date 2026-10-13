import { describe, expect, it } from 'vitest'
import { AxleProfileSnapshot, axleIssues, axleLoads, CarrierSnapshot, cargoOffsetMm, containerPositions, RoadSetup, TractorSnapshot } from './axles'
import type { LoadDoc } from './types'

const profile: AxleProfileSnapshot = {
  id: 1,
  code: 'BR',
  name: 'Brasil',
  country: 'BR',
  limits: { STEER: 6000, SINGLE_DUAL: 10000, TANDEM2: 17000, TANDEM3: 25500 },
  maxGrossKg: 48500,
  warnPct: 95,
  axleTolPct: 12.5,
  grossTolPct: 5,
  verification: 'ESTIMATED',
  source: null,
}
const tractor: TractorSnapshot = {
  id: 1,
  code: '6X2',
  name: 'Cavalo 6x2',
  wheelbaseMm: 4000,
  fifthWheelAheadMm: 400,
  rearGroup: 'TANDEM2',
  rearSpacingMm: 1370,
  tareFrontKg: 5000,
  tareRearKg: 4000,
  techFrontKg: null,
  techRearKg: null,
  verification: 'ESTIMATED',
  source: null,
}
const trailer: CarrierSnapshot = {
  id: 1,
  code: 'SR',
  name: 'Semirreboque',
  kind: 'SEMITRAILER',
  lengthMm: 14000,
  kingpinMm: 1000,
  frontAxleAheadMm: null,
  group: 'TANDEM3',
  groupCenterMm: 11000,
  groupSpacingMm: 1310,
  techGroupKg: null,
  techFrontKg: null,
  tareKg: 0,
  tareCgMm: null,
  cargoStartMm: 0,
  verification: 'ESTIMATED',
  source: null,
}
const space = { inner: { l: 14000, w: 2450, h: 2700 }, tareKg: 0 } as LoadDoc['space']
const road = (p: Partial<RoadSetup> = {}): RoadSetup => ({ tractor, carrier: trailer, profile, ...p })

describe('axleLoads — semirreboque', () => {
  it('massa no meio entre pino-rei e eixos: metade em cada apoio', () => {
    // s = 6000 → (6000−1000)/(11000−1000) = 0,5
    const r = axleLoads({ space }, road(), [{ kg: 20000, x: 6000 }])
    const g = Object.fromEntries(r.groups.map((x) => [x.key, x]))
    expect(r.kingpinKg).toBeCloseTo(10000)
    expect(g.CARRIER.kg).toBeCloseTo(10000)
    expect(g.CARRIER.perAxleKg).toBeCloseTo(10000 / 3)
    // cavalo: t5 = 3600 → traseiro recebe 3600/4000 = 90% do pino-rei
    expect(g.TRACTOR_REAR.kg).toBeCloseTo(4000 + 9000)
    expect(g.TRACTOR_FRONT.kg).toBeCloseTo(5000 + 1000)
    expect(r.grossKg).toBeCloseTo(20000 + 9000)
    // equilíbrio: soma das reações = massa total
    expect(r.groups.reduce((a, x) => a + x.kg, 0)).toBeCloseTo(r.grossKg)
  })

  it('alerta por conjunto mesmo com o PBTC dentro do limite', () => {
    // tudo atrás, sobre os eixos do semirreboque: 27 t num tandem triplo de 25,5 t
    const r = axleLoads({ space }, road(), [{ kg: 27000, x: 11000 }])
    expect(r.grossStatus).not.toBe('over')
    const sr = r.groups.find((x) => x.key === 'CARRIER')!
    expect(sr.kg).toBeCloseTo(27000)
    expect(sr.status).toBe('over')
    const iss = axleIssues(road(), r)
    expect(iss.some((i) => i.code === 'AXLE_OVERLOAD' && i.severity === 'CRITICAL')).toBe(true)
  })

  it('aviso perto do limite (warnPct) e PBTC acima', () => {
    const r = axleLoads({ space }, road(), [{ kg: 24500, x: 11000 }]) // 96% de 25,5 t
    expect(r.groups.find((x) => x.key === 'CARRIER')!.status).toBe('warn')
    const r2 = axleLoads({ space }, road({ profile: { ...profile, maxGrossKg: 30000 } }), [{ kg: 24500, x: 11000 }])
    expect(r2.grossStatus).toBe('over')
    expect(axleIssues(road(), r2).some((i) => i.code === 'AXLE_GROSS')).toBe(true)
  })

  it('limite efetivo = menor entre legal e capacidade técnica', () => {
    const r = axleLoads({ space }, road({ tractor: { ...tractor, techFrontKg: 5500 } }), [])
    const f = r.groups.find((x) => x.key === 'TRACTOR_FRONT')!
    expect(f.limitKg).toBe(5500)
    expect(f.legalKg).toBe(6000)
  })

  it('posições dos eixos no referencial da carga', () => {
    const r = axleLoads({ space }, road(), [])
    const sr = r.groups.find((x) => x.key === 'CARRIER')!
    expect(sr.axleXs).toEqual([11000 - 1310, 11000, 11000 + 1310])
    // eixo dianteiro do cavalo: k − t5 = 1000 − 3600
    expect(r.groups.find((x) => x.key === 'TRACTOR_FRONT')!.axleXs).toEqual([-2600])
  })

  it('tara do implemento no CG informado', () => {
    const r = axleLoads({ space }, road({ carrier: { ...trailer, tareKg: 7000, tareCgMm: 6000 } }), [])
    expect(r.kingpinKg).toBeCloseTo(3500)
    expect(r.cargoKg).toBe(0)
  })
})

describe('axleLoads — rígido e chassi', () => {
  it('caminhão rígido: dianteiro + traseiro somam a massa', () => {
    const rigid: CarrierSnapshot = { ...trailer, kind: 'RIGID', kingpinMm: null, frontAxleAheadMm: 1000, group: 'SINGLE_DUAL', groupCenterMm: 4000, tareKg: 6000, tareCgMm: 1000 }
    // eixo dianteiro em s = −1000, traseiro em 4000 (vão 5000). Carga 5000 kg em s = 2500 → 70% atrás
    const r = axleLoads({ space }, road({ tractor: null, carrier: rigid }), [{ kg: 5000, x: 2500 }])
    const g = Object.fromEntries(r.groups.map((x) => [x.key, x]))
    expect(g.CARRIER.kg).toBeCloseTo(3500 + 6000 * 0.4)
    expect(g.CARRIER_FRONT.kg).toBeCloseTo(1500 + 6000 * 0.6)
    expect(r.kingpinKg).toBeNull()
  })

  it('contêiner no chassi: deslocamento da parede e tara do contêiner', () => {
    const chassis: CarrierSnapshot = { ...trailer, kind: 'CHASSIS', lengthMm: 12420, kingpinMm: 1200, groupCenterMm: 10010 }
    const c20 = { inner: { l: 5898, w: 2352, h: 2393 }, tareKg: 2200 } as LoadDoc['space']
    const pos = containerPositions(12420, 5898)
    expect(pos.map((p) => p.frontMm)).toEqual([0, 3181, 6362])
    const rd = road({ carrier: chassis, containerFrontMm: pos[2].frontMm })
    expect(cargoOffsetMm({ space: c20 }, rd)).toBeCloseTo(6362 + 80)
    const r = axleLoads({ space: c20 }, rd, [])
    // tara do contêiner no centro: s = 6362 + 3029 = 9391
    expect(r.groups.find((x) => x.key === 'CARRIER')!.kg).toBeCloseTo((2200 * (9391 - 1200)) / (10010 - 1200))
  })
})
