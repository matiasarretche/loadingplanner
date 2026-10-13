import { describe, expect, it } from 'vitest'
import type { CarrierSnapshot } from './axles'
import { loadDoc } from './fixtures'
import type { SpaceSnapshot } from './types'
import { effectiveCarrier, withVehicleLength } from './vehicleLength'

const truck: SpaceSnapshot = { kind: 'VEHICLE', typeId: 9, code: 'SR-14.6', name: 'Semirreboque', inner: { l: 14600, w: 2480, h: 2700 }, door: { w: 2480, h: 2700 }, tareKg: 8250, maxPayloadKg: 28000, maxGrossKg: null, floorLoadKgPerM: null, source: null, verification: 'ESTIMATED', transport: 'ROAD' }
const semi: CarrierSnapshot = { id: 9, code: 'SR', name: 'SR', kind: 'SEMITRAILER', lengthMm: 14800, kingpinMm: 1000, frontAxleAheadMm: null, group: 'TANDEM3', groupCenterMm: 12000, groupSpacingMm: 1300, techGroupKg: null, techFrontKg: null, tareKg: 8000, tareCgMm: null, cargoStartMm: 100, verification: 'ESTIMATED', source: null }

describe('comprimento do caminhão informado na carga', () => {
  it('muda o comprimento útil e guarda o do cadastro; voltar ao cadastro limpa', () => {
    const d = withVehicleLength(loadDoc({ space: truck }), 15800)
    expect(d.space.inner.l).toBe(15800)
    expect(d.space.baseInnerL).toBe(14600)
    const back = withVehicleLength(d, 14600)
    expect(back.space.inner.l).toBe(14600)
    expect(back.space.baseInnerL).toBeUndefined()
  })
  it('contêiner não muda; valores absurdos são ignorados', () => {
    const c = loadDoc()
    expect(withVehicleLength(c, 15000)).toBe(c)
    const d = loadDoc({ space: truck })
    expect(withVehicleLength(d, 500).space.inner.l).toBe(14600)
  })
  it('carga por eixo: semirreboque leva o conjunto traseiro junto com o fundo; rígido mantém os eixos', () => {
    const d = withVehicleLength(loadDoc({ space: truck }), 15800)
    const e = effectiveCarrier(d, semi)
    expect(e).toMatchObject({ lengthMm: 16000, groupCenterMm: 13200, kingpinMm: 1000 })
    const rigid = effectiveCarrier(d, { ...semi, kind: 'RIGID', kingpinMm: null, frontAxleAheadMm: 1200 })
    expect(rigid).toMatchObject({ lengthMm: 16000, groupCenterMm: 12000 })
    // sem comprimento informado: implemento do cadastro
    expect(effectiveCarrier(loadDoc({ space: truck }), semi)).toBe(semi)
  })
})
