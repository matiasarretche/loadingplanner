import { describe, expect, it } from 'vitest'
import { placePallets } from './autoload'
import { balanceMetrics, balanceWeight, spreadAlongLength } from './balance'
import { container, loadDoc, pack, palletDoc, palletType } from './fixtures'
import { loadGeometries, loadSummary, validateLoad } from './load'
import { quadrantShares } from './quadrants'
import type { LoadDoc } from './types'

const crit = (d: Parameters<typeof validateLoad>[0]) => validateLoad(d).issues.filter((i) => i.severity === 'CRITICAL').map((i) => i.code)
const pt = palletType({ code: 'PCF-1150', dims: { l: 1150, w: 1150, h: 150 }, dynamicMaxKg: null })
const heavy = palletDoc({ name: 'Pesado', palletType: pt, packs: { a: pack({ sku: 'PESADO', dims: { l: 1150, w: 1150, h: 1500 }, grossKg: 1300 }) }, items: [{ id: 'i', packId: 'a', pos: { x: 0, y: 0, z: 0 }, orientation: 'LWH', locked: false }] })
const light = palletDoc({ name: 'Leve', palletType: pt, packs: { b: pack({ sku: 'LEVE', dims: { l: 1150, w: 1150, h: 1500 }, grossKg: 150 }) }, items: [{ id: 'i', packId: 'b', pos: { x: 0, y: 0, z: 0 }, orientation: 'LWH', locked: false }] })

/** mesmo conteúdo: mesmos paletes (id → montagem) */
const content = (d: LoadDoc) => d.units.map((u) => `${u.id}:${u.kind === 'PALLET' ? u.palletKey : u.packId}`).sort()

describe('distribuir peso por quadrantes (NORTE = motorista)', () => {
  // 10 leves no motorista e 10 pesados na porta: peso concentrado no SUL
  const southHeavy = (() => {
    const a = placePallets(loadDoc({ space: container('40HC') }), 'l', light, 10)
    return placePallets(a.doc, 'h', heavy, 10).doc
  })()

  it('pesos muito desiguais (tudo pesado na porta): aproxima frente × trás o máximo possível, sem mudar o conteúdo', () => {
    expect(quadrantShares(southHeavy).southPct).toBeGreaterThan(70)
    const r = balanceWeight(southHeavy)
    const rear = r.after.quadrants.rearPct
    // 1300 kg × 150 kg em fileiras fixas: a melhor alternativa fica perto do meio e nunca com mais peso na frente
    expect(Math.abs(rear - 50)).toBeLessThan(Math.abs(quadrantShares(southHeavy).southPct - 50))
    if (!r.meetsRules) expect(r.reason).toMatch(/Não foi possível alcançar/)
    expect(content(r.doc)).toEqual(content(southHeavy))
  })

  it('nunca mais peso na frente, traseira até 51%, e equilibra leste/oeste', () => {
    const mid = palletDoc({ name: 'Médio', palletType: pt, packs: { b: pack({ sku: 'MEDIO', dims: { l: 1150, w: 1150, h: 1500 }, grossKg: 700 }) }, items: [{ id: 'i', packId: 'b', pos: { x: 0, y: 0, z: 0 }, orientation: 'LWH', locked: false }] })
    const a = placePallets(loadDoc({ space: container('40HC') }), 'm', mid, 10)
    const southHeavy = placePallets(a.doc, 'h', heavy, 10).doc
    const r = balanceWeight(southHeavy)
    const s = r.after.quadrants.shares
    expect(r.meetsRules).toBe(true)
    expect(s.southPct).toBeGreaterThanOrEqual(50)
    expect(s.southPct).toBeLessThanOrEqual(51)
    expect(Math.abs(s.pct.NE - s.pct.NO)).toBeLessThan(2) // granularidade: 1 palete ≈ 3 p.p.
    expect(Math.abs(s.pct.SE - s.pct.SO)).toBeLessThan(2)
    // não muda produtos nem quantidades
    expect(content(r.doc)).toEqual(content(southHeavy))
    expect(loadSummary(r.doc).payloadKg).toBe(loadSummary(southHeavy).payloadKg)
    expect(crit(r.doc)).toEqual([])
  })

  it('validação avisa traseira acima do recomendado e frente pesada', () => {
    const codes = (d: LoadDoc) => validateLoad(d).issues.map((i) => i.code)
    expect(codes(southHeavy)).toContain('QUADRANT_SOUTH')
    // espelho: tudo pesado no motorista → frente pesada
    const a = placePallets(loadDoc({ space: container('40HC') }), 'h', heavy, 10)
    const frontHeavy = placePallets(a.doc, 'l', light, 10).doc
    expect(codes(frontHeavy)).toContain('WEIGHT_FRONT')
    expect(codes(balanceWeight(frontHeavy).doc)).not.toContain('WEIGHT_FRONT')
  })

  it('é determinístico e estável (rodar de novo não piora)', () => {
    const a = balanceWeight(southHeavy)
    const b = balanceWeight(southHeavy)
    expect(b.doc).toEqual(a.doc)
    const again = balanceWeight(a.doc)
    expect(again.after.score).toBeLessThanOrEqual(a.after.score + 1e-9)
  })

  it('não mexe em paletes travados', () => {
    const locked = { ...southHeavy, units: southHeavy.units.map((u, i) => (i === 0 ? { ...u, locked: true } : u)) }
    const r = balanceWeight(locked)
    expect(r.doc.units.find((u) => u.id === locked.units[0].id)).toEqual(locked.units[0])
  })

  it('carga uniforme não muda', () => {
    const uniform = placePallets(loadDoc({ space: container('40HC') }), 'h', heavy, 20).doc
    const r = balanceWeight(uniform)
    expect(r.swaps).toBe(0)
    expect(balanceMetrics(r.doc).score).toBe(balanceMetrics(uniform).score)
  })
})

describe('distribuição com tipos de palete diferentes (caso real)', () => {
  // 8 PBR pesados (silo-bolsa) + 8 PCF-1150 leves (Hidrosilo) num 40HC: o piso fica só pela metade (tudo no NORTE)
  const pbr = palletDoc({ name: 'SB', palletType: palletType({ dynamicMaxKg: 2000 }), packs: { a: pack({ sku: 'SB', dims: { l: 1000, w: 1200, h: 1750 }, grossKg: 1300 }) }, items: [{ id: 'i', packId: 'a', pos: { x: 0, y: 0, z: 0 }, orientation: 'LWH', locked: false }] })
  const doc = (() => {
    const a = placePallets(loadDoc({ space: container('40HC') }), 's', pbr, 8)
    return placePallets(a.doc, 'l', light, 8).doc
  })()
  it('sem espaçar: não alcança (tudo na metade do motorista) e explica', () => {
    const r = balanceWeight(doc)
    expect(r.meetsRules).toBe(false)
    expect(r.reason).toMatch(/Não foi possível alcançar a distribuição de peso requerida/)
    expect(r.doc.units).toHaveLength(16)
    expect(crit(r.doc)).toEqual([])
  })
  it('com espaçamento permitido cumpre as regras sem alertas', () => {
    const r = balanceWeight(doc, { spread: true })
    // espaçando até a porta: deixa de ter mais peso na frente
    const out = (e: typeof r.after.quadrants) => 2 * e.frontExcess + e.rearExcess
    expect(out(r.after.quadrants)).toBeLessThan(out(balanceWeight(doc).after.quadrants))
    expect(r.after.quadrants.shares.southPct).toBeLessThanOrEqual(51)
    expect(crit(r.doc)).toEqual([])
    expect(content(r.doc)).toEqual(content(doc))
  })
  it('com espaço até a porta: prefere deslocar o BLOCO (paletes travados entre si, sem vãos internos)', () => {
    const r = balanceWeight(doc, { spread: true })
    expect(r.meetsRules).toBe(true)
    expect(r.strategy).toMatch(/bloco deslocado/)
    const gs = loadGeometries(r.doc).filter((g) => g.box.min.z === 0)
    for (const g of gs) {
      const end = g.box.min.x + g.box.size.x
      const ahead = gs.filter((h) => h !== g && h.box.min.x >= end - 1 && h.box.min.y < g.box.min.y + g.box.size.y && h.box.min.y + h.box.size.y > g.box.min.y)
      if (ahead.length) expect(Math.min(...ahead.map((h) => h.box.min.x)) - end).toBeLessThanOrEqual(1)
    }
  })
  it('espaçar estica a carga até a porta sem sobreposições', () => {
    const sp = spreadAlongLength(doc)
    expect(loadSummary(sp).freeLengthMm).toBeLessThan(50)
    expect(crit(sp)).toEqual([])
  })
  it('espaçar não mexe se houver unidades travadas', () => {
    const locked = { ...doc, units: doc.units.map((u, i) => (i === 3 ? { ...u, locked: true } : u)) }
    expect(spreadAlongLength(locked)).toBe(locked)
  })
})

describe('colunas empilhadas (regra: tudo empilhável)', () => {
  // paletes baixos: 2 camadas; leves na frente, pesados na porta → peso concentrado no SUL
  const lowLight = palletDoc({ name: 'Leve baixo', palletType: pt, packs: { b: pack({ sku: 'LB', dims: { l: 1150, w: 1150, h: 1000 }, grossKg: 300 }) }, items: [{ id: 'i', packId: 'b', pos: { x: 0, y: 0, z: 0 }, orientation: 'LWH', locked: false }] })
  const lowHeavy = palletDoc({ name: 'Pesado baixo', palletType: pt, packs: { a: pack({ sku: 'PB', dims: { l: 1150, w: 1150, h: 1000 }, grossKg: 700 }) }, items: [{ id: 'i', packId: 'a', pos: { x: 0, y: 0, z: 0 }, orientation: 'LWH', locked: false }] })
  it('move as colunas inteiras, mantém tudo empilhado e fica na faixa (traseira 50–51%)', () => {
    // monta 40GP com 20 posições: 10 colunas leves (frente) e 10 pesadas (porta)
    const floorL = placePallets(loadDoc({ space: container('40GP') }), 'l', lowLight, 10, { allowStacking: false })
    const floorH = placePallets(floorL.doc, 'h', lowHeavy, 10, { allowStacking: false })
    const stacked = placePallets(placePallets(floorH.doc, 'l', lowLight, 10).doc, 'h', lowHeavy, 10).doc
    expect(stacked.units.filter((u) => u.pos.z > 0)).toHaveLength(20)
    expect(quadrantShares(stacked).southPct).toBeGreaterThan(55)
    const r = balanceWeight(stacked)
    expect(r.movable).toBeGreaterThanOrEqual(10)
    expect(r.after.quadrants.shares.southPct).toBeGreaterThanOrEqual(50)
    expect(r.after.quadrants.shares.southPct).toBeLessThanOrEqual(51)
    expect(r.doc.units.filter((u) => u.pos.z > 0)).toHaveLength(20)
    expect(content(r.doc)).toEqual(content(stacked))
    expect(crit(r.doc)).toEqual([])
  })
})

describe('carga com colisão (caso da tela)', () => {
  const sb = palletDoc({ name: 'SB', palletType: palletType({ dynamicMaxKg: 2000 }), packs: { a: pack({ sku: 'SB', dims: { l: 1000, w: 1200, h: 1750 }, grossKg: 1300 }) }, items: [{ id: 'i', packId: 'a', pos: { x: 0, y: 0, z: 0 }, orientation: 'LWH', locked: false }] })
  const ok = (() => {
    const a = placePallets(loadDoc({ space: container('40GP') }), 'l', light, 8)
    return placePallets(a.doc, 's', sb, 8).doc
  })()
  it('colisão causada por arrasto manual: reorganizar resolve', () => {
    const last = ok.units[ok.units.length - 1]
    const broken = { ...ok, units: ok.units.map((u) => (u.id === last.id ? { ...u, pos: { ...ok.units[0].pos } } : u)) }
    const r = balanceWeight(broken)
    expect(r.physicalIssuesBefore).toBeGreaterThan(0)
    expect(r.physicalIssuesAfter).toBe(0)
    expect(r.doc.units).toHaveLength(16)
    expect(crit(r.doc)).toEqual([])
  })
  it('mais paletes do que cabem: não mexe e explica o motivo', () => {
    const extra = { ...ok, units: [...ok.units, { ...ok.units[0], id: 'extra' }] }
    const full = placePallets(extra, 's', sb, null).doc
    const r = balanceWeight(full)
    expect(r.doc).toBe(full)
    expect(r.reason).toMatch(/problema\(s\) físico/)
  })
})
