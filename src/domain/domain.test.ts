import { describe, expect, it } from 'vitest'
import { cbm, intersects, orientDims, unionArea, yawOrientation } from './geometry'
import { container, loadDoc, pack, palletDoc, palletType } from './fixtures'
import { effectiveLimits, loadSummary, palletPlacement, palletLocalToSpace, validateLoad } from './load'
import { findFreePosition } from './placement'
import { palletSummary, validatePallet } from './pallet'
import { LoadUnit } from './types'

const codes = (issues: { code: string; severity: string }[], sev = 'CRITICAL') =>
  issues.filter((i) => i.severity === sev).map((i) => i.code)

describe('geometria', () => {
  it('orientações e giro', () => {
    const d = { l: 500, w: 400, h: 300 }
    expect(orientDims(d, 'LWH')).toEqual({ x: 500, y: 400, z: 300 })
    expect(orientDims(d, 'WLH')).toEqual({ x: 400, y: 500, z: 300 })
    expect(orientDims(d, 'HWL')).toEqual({ x: 300, y: 400, z: 500 })
    expect(yawOrientation('LWH')).toBe('WLH')
    expect(yawOrientation('LHW')).toBe('HLW')
  })
  it('encostar não é colisão; interpenetrar é', () => {
    const a = { min: { x: 0, y: 0, z: 0 }, size: { x: 100, y: 100, z: 100 } }
    expect(intersects(a, { min: { x: 100, y: 0, z: 0 }, size: { x: 100, y: 100, z: 100 } })).toBe(false)
    expect(intersects(a, { min: { x: 99, y: 0, z: 0 }, size: { x: 100, y: 100, z: 100 } })).toBe(true)
    expect(intersects(a, { min: { x: 99, y: 0, z: 0 }, size: { x: 100, y: 100, z: 100 } }, 1)).toBe(false)
  })
  it('CBM = LWH/1e9', () => {
    expect(cbm({ l: 1000, w: 1200, h: 1000 })).toBeCloseTo(1.2, 9)
    expect(cbm({ l: 5900, w: 2352, h: 2395 })).toBeCloseTo(33.23, 2)
  })
  it('área de união', () => {
    expect(unionArea([{ x0: 0, y0: 0, x1: 10, y1: 10 }, { x0: 5, y0: 5, x1: 15, y1: 15 }])).toBe(175)
  })
})

describe('palete', () => {
  it('pesos: gross = produtos + palete + acessórios', () => {
    const d = palletDoc({
      accessoriesKg: 3,
      items: [
        { id: 'i1', packId: 'a', pos: { x: 0, y: 0, z: 0 }, orientation: 'LWH', locked: false },
        { id: 'i2', packId: 'a', pos: { x: 500, y: 0, z: 0 }, orientation: 'LWH', locked: false },
      ],
    })
    const s = palletSummary(d)
    expect(s.productsGrossKg).toBe(40)
    expect(s.netKg).toBe(36)
    expect(s.grossKg).toBe(40 + 27 + 3)
    expect(s.totalHeightMm).toBe(137 + 300)
    expect(s.surfaceUtilPct).toBeCloseTo((1000 * 400 * 100) / (1000 * 1200), 6)
    expect(codes(validatePallet(d))).toEqual([])
  })
  it('colisão entre itens', () => {
    const d = palletDoc({
      items: [
        { id: 'i1', packId: 'a', pos: { x: 0, y: 0, z: 0 }, orientation: 'LWH', locked: false },
        { id: 'i2', packId: 'a', pos: { x: 400, y: 0, z: 0 }, orientation: 'LWH', locked: false },
      ],
    })
    expect(codes(validatePallet(d))).toContain('COLLISION')
  })
  it('capacidade do palete excedida (ex.: 4 silo-bolsas de 315 kg em PBR-1)', () => {
    const silo = pack({ sku: 'SB-10x150-235', dims: { l: 1000, w: 600, h: 600 }, grossKg: 315, netKg: 310 })
    const d = palletDoc({
      packs: { s: silo },
      items: [0, 1].flatMap((ix) =>
        [0, 1].map((iz) => ({ id: `s${ix}${iz}`, packId: 's', pos: { x: 0, y: ix * 600, z: iz * 600 }, orientation: 'LWH' as const, locked: false })),
      ),
    })
    const iss = validatePallet(d)
    expect(codes(iss)).toContain('PALLET_CAPACITY')
  })
  it('overhang: proibido, dentro e acima do permitido', () => {
    const mk = (allowed: boolean, max: number) =>
      palletDoc({
        palletType: palletType({ overhangAllowed: allowed, overhangMaxMm: max }),
        items: [{ id: 'i', packId: 'a', pos: { x: -30, y: 0, z: 0 }, orientation: 'LWH', locked: false }],
      })
    expect(codes(validatePallet(mk(false, 0)))).toContain('OVERHANG')
    expect(codes(validatePallet(mk(true, 50)))).not.toContain('OVERHANG')
    expect(codes(validatePallet(mk(true, 50)), 'INFO')).toContain('OVERHANG')
    expect(codes(validatePallet(mk(true, 20)))).toContain('OVERHANG')
  })
  it('palete não tem altura máxima: quem limita é o equipamento', () => {
    const tall = pack({ dims: { l: 1000, w: 1200, h: 2500 }, grossKg: 100 })
    const d = palletDoc({ packs: { a: tall }, items: [{ id: 'i', packId: 'a', pos: { x: 0, y: 0, z: 0 }, orientation: 'LWH', locked: false }] })
    expect(codes(validatePallet(d))).toEqual([])
    // 137 + 2500 = 2637 mm: passa na altura interna do 40HC (2700) mas não na porta (2597)
    const load = loadDoc({ space: container('40HC'), pallets: { p: d }, units: [{ id: 'u', kind: 'PALLET', palletKey: 'p', pos: { x: 0, y: 0, z: 0 }, yaw: false, locked: false }] })
    expect(codes(validateLoad(load).issues)).toContain('DOOR_FIT')
    expect(codes(validateLoad({ ...load, space: container('20GP') }).issues)).toContain('OUT_OF_BOUNDS')
  })
  it('orientação não permitida', () => {
    const d = palletDoc({ items: [{ id: 'i', packId: 'a', pos: { x: 0, y: 0, z: 0 }, orientation: 'LHW', locked: false }] })
    expect(codes(validatePallet(d))).toContain('ORIENTATION')
  })
  it('apoio e peso sobre o item (empilhamento sempre permitido — regra Pacifil)', () => {
    const fragile = pack({ sku: 'FRAG', stackable: false })
    const d = palletDoc({
      packs: { a: pack(), f: fragile },
      items: [
        { id: 'base', packId: 'f', pos: { x: 0, y: 0, z: 0 }, orientation: 'LWH', locked: false },
        { id: 'top', packId: 'a', pos: { x: 0, y: 0, z: 300 }, orientation: 'LWH', locked: false },
        { id: 'float', packId: 'a', pos: { x: 500, y: 600, z: 500 }, orientation: 'LWH', locked: false },
      ],
    })
    const c = codes(validatePallet(d))
    expect(c).not.toContain('STACK_NOT_ALLOWED')
    expect(c).toContain('UNSUPPORTED')

    const limited = pack({ sku: 'LIM', maxStackKg: 30 })
    const d2 = palletDoc({
      packs: { l: limited },
      items: [0, 1, 2].map((k) => ({ id: `l${k}`, packId: 'l', pos: { x: 0, y: 0, z: k * 300 }, orientation: 'LWH' as const, locked: false })),
    })
    // o de baixo carrega 40 kg (> 30)
    expect(codes(validatePallet(d2))).toContain('STACK_WEIGHT')
  })
  it('pallet misto soma por SKU', () => {
    const d = palletDoc({
      packs: { a: pack({ sku: 'A', unitsPerPackage: 10 }), b: pack({ sku: 'B', grossKg: 5, netKg: 4, unitsPerPackage: 2 }) },
      items: [
        { id: '1', packId: 'a', pos: { x: 0, y: 0, z: 0 }, orientation: 'LWH', locked: false },
        { id: '2', packId: 'b', pos: { x: 500, y: 0, z: 0 }, orientation: 'LWH', locked: false },
        { id: '3', packId: 'b', pos: { x: 500, y: 400, z: 0 }, orientation: 'LWH', locked: false },
      ],
    })
    const s = palletSummary(d)
    expect(s.bySku.map((l) => [l.sku, l.packages, l.units])).toEqual([['A', 1, 10], ['B', 2, 4]])
    expect(s.productsGrossKg).toBe(30)
  })
})

describe('peso líquido ausente', () => {
  it('avisa quando a embalagem não tem peso líquido', () => {
    const d = palletDoc({ packs: { a: pack({ netKg: 0, grossKg: 5 }) }, items: [{ id: 'i', packId: 'a', pos: { x: 0, y: 0, z: 0 }, orientation: 'LWH', locked: false }] })
    expect(validatePallet(d).some((i) => i.severity === 'WARNING' && i.message.includes('sem peso líquido'))).toBe(true)
  })
})

describe('carga', () => {
  const fullPallet = palletDoc({
    name: 'P1',
    packs: { a: pack({ dims: { l: 1000, w: 1200, h: 1000 }, grossKg: 900, netKg: 880 }) },
    items: [{ id: 'i', packId: 'a', pos: { x: 0, y: 0, z: 0 }, orientation: 'LWH', locked: false }],
  })
  const pu = (id: string, x: number, y: number, z = 0, yaw = false): LoadUnit => ({ id, kind: 'PALLET', palletKey: 'p', pos: { x, y, z }, yaw, locked: false })

  it('20GP / 40GP / 40HC: payload e gross', () => {
    for (const code of ['20GP', '40GP', '40HC'] as const) {
      const doc = loadDoc({ space: container(code), pallets: { p: fullPallet }, units: [pu('u1', 0, 0, 0, true), pu('u2', 0, 1000, 0, true)] })
      const { issues, summary } = validateLoad(doc)
      expect(codes(issues)).toEqual([])
      expect(summary.payloadKg).toBe(2 * (900 + 27))
      expect(summary.grossKg).toBe(summary.payloadKg + doc.space.tareKg)
      expect(summary.pallets).toBe(2)
    }
  })
  it('limite efetivo = MIN(físico, transportador, legal)', () => {
    const doc = loadDoc({
      space: container('40HC'),
      limits: [
        { profileId: 1, name: 'Transportador X', scope: 'CARRIER', maxPayloadKg: 26000, maxGrossKg: null, maxHeightMm: null, minSupportPct: null, cgLongTolPct: null, cgLatTolPct: null, lowUtilPct: null },
        { profileId: 2, name: 'Rota BR', scope: 'LEGAL', maxPayloadKg: null, maxGrossKg: 28000, maxHeightMm: null, minSupportPct: null, cgLongTolPct: null, cgLatTolPct: null, lowUtilPct: null },
      ],
    })
    const L = effectiveLimits(doc)
    expect(L.payloadKg.value).toBe(28000 - 3900)
    expect(L.payloadKg.source).toContain('Rota BR')
    expect(L.grossKg.value).toBe(28000)
  })
  it('payload excedido', () => {
    const heavy = palletDoc({ ...fullPallet, packs: { a: pack({ dims: { l: 1000, w: 1200, h: 1000 }, grossKg: 15000 }) }, palletType: palletType({ dynamicMaxKg: null }) })
    const doc = loadDoc({ space: container('20GP'), pallets: { p: heavy }, units: [pu('u1', 0, 0), pu('u2', 1000, 0)] })
    expect(codes(validateLoad(doc).issues)).toContain('PAYLOAD_EXCEEDED')
  })
  it('paredes, teto e comprimento', () => {
    const doc = loadDoc({ space: container('20GP'), pallets: { p: fullPallet }, units: [pu('u1', 5000, 0), pu('u2', 0, 1500)] })
    const iss = validateLoad(doc).issues.filter((i) => i.code === 'OUT_OF_BOUNDS')
    expect(iss.map((i) => i.refs[0]).sort()).toEqual(['u1', 'u2'])
  })
  it('colisão entre unidades', () => {
    const doc = loadDoc({ pallets: { p: fullPallet }, units: [pu('u1', 0, 0), pu('u2', 500, 0)] })
    expect(codes(validateLoad(doc).issues)).toContain('COLLISION')
  })
  it('porta: altura e largura', () => {
    // palete de 137 + 2200 = 2337 mm > porta 20GP 2292, mas < altura interna 2395
    const tall = palletDoc({ ...fullPallet, packs: { a: pack({ dims: { l: 1000, w: 1200, h: 2200 }, grossKg: 500 }) } })
    const doc = loadDoc({ space: container('20GP'), pallets: { p: tall }, units: [pu('u1', 0, 0)] })
    expect(codes(validateLoad(doc).issues)).toContain('DOOR_FIT')
    expect(codes(validateLoad({ ...doc, space: container('40HC') }).issues)).not.toContain('DOOR_FIT')
  })
  it('rotação de palete troca dimensões e mantém o CG dentro do envelope', () => {
    const off = palletDoc({
      name: 'off',
      packs: { a: pack({ dims: { l: 500, w: 400, h: 300 }, grossKg: 500 }) },
      items: [{ id: 'i', packId: 'a', pos: { x: 0, y: 0, z: 0 }, orientation: 'LWH', locked: false }],
    })
    const doc = loadDoc({ pallets: { p: off }, units: [pu('u1', 0, 0, 0, true)] })
    const s = loadSummary(doc)
    expect(s.usedLengthMm).toBe(1200)
    const pl = palletPlacement(off, { pos: { x: 0, y: 0, z: 0 }, yaw: true })
    // canto local (0,0) do palete vai para x=1200 (lado oposto), y=0 após giro anti-horário
    expect(palletLocalToSpace(pl, { x: 0, y: 0, z: 0 })).toEqual({ x: 1200, y: 0, z: 0 })
    expect(palletLocalToSpace(pl, { x: 1000, y: 1200, z: 0 })).toEqual({ x: 0, y: 1000, z: 0 })
    expect(s.cg!.x).toBeGreaterThan(0)
    expect(s.cg!.x).toBeLessThan(1200)
    expect(s.cg!.y).toBeGreaterThan(0)
    expect(s.cg!.y).toBeLessThan(1000)
  })
  it('CG longitudinal desbalanceado', () => {
    const doc = loadDoc({ space: container('40GP'), pallets: { p: fullPallet }, units: [pu('u1', 0, 0, 0, true), pu('u2', 0, 1000, 0, true)] })
    expect(codes(validateLoad(doc).issues, 'WARNING')).toContain('CG_LONGITUDINAL')
  })
  it('caminhão configurável com perfil de altura legal', () => {
    const truck = {
      kind: 'VEHICLE' as const, typeId: 9, code: 'SR-13.6', name: 'Semirreboque 13,6 m', inner: { l: 13600, w: 2480, h: 2800 },
      door: { w: 2480, h: 2800 }, tareKg: 7500, maxPayloadKg: 27000, maxGrossKg: null, floorLoadKgPerM: null, source: null, verification: 'VERIFIED' as const,
    }
    const tall = palletDoc({ ...fullPallet, packs: { a: pack({ dims: { l: 1000, w: 1200, h: 2600 }, grossKg: 500 }) } })
    const doc = loadDoc({
      space: truck,
      pallets: { p: tall },
      limits: [{ profileId: 3, name: 'Altura rota', scope: 'ROUTE', maxPayloadKg: null, maxGrossKg: null, maxHeightMm: 2600, minSupportPct: null, cgLongTolPct: null, cgLatTolPct: null, lowUtilPct: null }],
      units: [pu('u1', 0, 0)],
    })
    expect(codes(validateLoad(doc).issues)).toContain('HEIGHT_LIMIT')
  })
  it('kg/CBM e distribuição longitudinal', () => {
    const doc = loadDoc({ space: container('20GP'), pallets: { p: fullPallet }, units: [pu('u1', 0, 0)] })
    const s = loadSummary(doc)
    expect(s.cbmUnits).toBeCloseTo((1000 * 1200 * 1137) / 1e9, 9)
    expect(s.longitudinal[0].kg).toBeCloseTo(927, 6)
    expect(s.longitudinal.reduce((a, b) => a + b.kg, 0)).toBeCloseTo(927, 6)
  })
  it('empilhar palete marcado como não empilhável é permitido (regra Pacifil)', () => {
    const doc = loadDoc({ pallets: { p: fullPallet }, units: [pu('u1', 0, 0), pu('u2', 0, 0, 1137)] })
    expect(codes(validateLoad(doc).issues)).not.toContain('STACK_NOT_ALLOWED')
  })
})

describe('posição livre (ajuda manual)', () => {
  it('preenche do fundo para a porta sem colidir', () => {
    const size = { x: 1200, y: 1000, z: 1137 }
    const obs: { box: { min: { x: number; y: number; z: number }; size: typeof size }; stackable: boolean }[] = []
    const opts = { lo: { x: 0, y: 0, z: 0 }, hi: { x: 5900, y: 2352, z: 2395 }, allowStacking: false, minSupportPct: 70 }
    for (let i = 0; i < 8; i++) {
      const p = findFreePosition(obs, size, opts)
      expect(p).not.toBeNull()
      obs.push({ box: { min: p!, size }, stackable: false })
    }
    // 20GP: 4 fileiras × 2 PBR com 1200 no comprimento
    expect(findFreePosition(obs, size, opts)).toBeNull()
  })
})

describe('tombar caixas', () => {
  it('percorre as faces na vertical respeitando as orientações permitidas', async () => {
    const { flipOrientation, ORIENTATIONS } = await import('./geometry')
    expect(flipOrientation('LWH', ORIENTATIONS)).toBe('LHW') // W na vertical, L continua no comprimento
    expect(flipOrientation('LHW', ORIENTATIONS)).toBe('WHL') // tomba para a frente: L na vertical
    expect(flipOrientation('WHL', ORIENTATIONS)).toBe('WLH') // volta em pé (girado)
    expect(flipOrientation('LWH', ['LWH', 'WLH'])).toBeNull() // só em pé: restrição do cadastro
  })
})
