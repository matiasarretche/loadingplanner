import { describe, expect, it } from 'vitest'
import { container, pack, palletType } from './fixtures'
import { orientDims } from './geometry'
import { addBoxesToMixed, evaluateMixedPlan, maxBoxesPerPallet, moveBoxesBetween, optimizeMixedPallets, OrderLine, removeBoxesFromMixed, singleSkuBaseline, transportMaxHeight } from './mixedPallets'
import { packKits } from './kitBoxes'

// Dados no formato do catálogo real de Hidrosilo (caixa, peso bruto, palete padrão)
const simple = palletType({ palletTypeId: 6, code: 'PCF-1150', dims: { l: 1150, w: 1150, h: 160 }, tareKg: 27, maxLoadKg: 2000, staticMaxKg: 2000, dynamicMaxKg: 2000 })
const double = palletType({ palletTypeId: 18, code: 'PCF-1150-DUPLO', dims: { l: 2300, w: 1150, h: 150 }, tareKg: 54, maxLoadKg: 4000, staticMaxKg: 4000, dynamicMaxKg: 4000 })
const hs = (sku: string, l: number, w: number, h: number, kg: number, id: number) => pack({ sku, name: sku, packagingVersionId: id, dims: { l, w, h }, grossKg: kg, netKg: kg * 0.85 })
const P = {
  '50K': hs('HS-50K', 2250, 380, 310, 129.59, 1),
  '40K': hs('HS-40K', 2250, 380, 260, 104.53, 2),
  '30K': hs('HS-30K', 2250, 380, 260, 80.06, 3),
  '20K': hs('HS-20K', 1140, 570, 250, 53.38, 4),
  '10K': hs('HS-10K', 1140, 570, 150, 28.02, 5),
  '5K': hs('HS-5K', 1140, 570, 110, 17.16, 6),
  '2K': hs('HS-2K', 600, 500, 130, 9.73, 7),
}
const line = (k: keyof typeof P, n: number): OrderLine => ({ packId: `pv${P[k].packagingVersionId}`, pack: P[k], boxes: n })
const ORDER = [line('50K', 10), line('40K', 10), line('30K', 10), line('20K', 10), line('10K', 20), line('5K', 30), line('2K', 20)]
const crit = (r: ReturnType<typeof optimizeMixedPallets>) => r.pallets.flatMap((p) => p.issues.filter((i) => i.severity === 'CRITICAL'))

describe('paletes mistos — pedido real de Hidrosilo', () => {
  const H = transportMaxHeight('FCL', container('40GP'))!
  const r = optimizeMixedPallets(ORDER, { palletTypes: [simple, double], maxHeightMm: H })

  it('altura máxima do FCL = a mais restritiva entre interior e porta', () => {
    expect(H).toBe(Math.min(container('40GP').inner.h, container('40GP').door.h))
  })
  it('coloca EXATAMENTE as quantidades pedidas', () => {
    expect(r.unplaced).toEqual([])
    for (const c of r.check) expect(c.placed, c.sku).toBe(c.requested)
    expect(r.totals.boxes).toBe(110)
  })
  it('respeita altura, capacidade e física (sem alertas críticos)', () => {
    expect(crit(r)).toEqual([])
    for (const p of r.pallets) {
      expect(p.heightMm).toBeLessThanOrEqual(H)
      expect(p.grossKg - p.doc.palletType.tareKg).toBeLessThanOrEqual(p.doc.palletType.maxLoadKg! + 1e-6)
    }
    expect(r.ok).toBe(true)
  })
  it('mistura referências e usa menos posições que paletes por SKU', () => {
    expect(r.pallets.some((p) => p.lines.length > 1)).toBe(true)
    const base = singleSkuBaseline(ORDER, { palletTypes: [simple, double], maxHeightMm: H }, (o) => (o.pack.dims.l > 1150 ? double : simple))
    expect(r.positions).toBeLessThan(base.reduce((s, b) => s + b.positions, 0))
  })
  it('cada caixa guarda produto, posição e orientação; pesadas embaixo', () => {
    for (const p of r.pallets)
      for (const it of p.doc.items) {
        expect(p.doc.packs[it.packId]).toBeDefined()
        expect(['LWH', 'WLH']).toContain(it.orientation)
      }
    // o 50K (mais pesado) começa no tabuleiro
    const with50 = r.pallets.find((p) => p.doc.items.some((i) => p.doc.packs[i.packId].sku === 'HS-50K' && i.pos.z === 0))
    expect(with50).toBeDefined()
  })
  it('é determinístico', () => {
    const again = optimizeMixedPallets(ORDER, { palletTypes: [simple, double], maxHeightMm: H })
    expect(again.pallets.map((p) => p.doc.items)).toEqual(r.pallets.map((p) => p.doc.items))
  })
})

describe('paletes mistos — edição manual', () => {
  const H = 2292
  const base = optimizeMixedPallets(ORDER, { palletTypes: [simple, double], maxHeightMm: H })
  it('retirar caixas deixa pendente no pedido e tira as de cima', () => {
    const p = base.pallets.find((x) => x.lines.some((l) => l.sku === 'HS-5K'))!
    const r = removeBoxesFromMixed(p.doc, 'HS-5K', 3)
    expect(r.removed).toHaveLength(3)
    const docs = base.pallets.map((x) => (x === p ? r.doc : x.doc))
    const ev = evaluateMixedPlan(docs, ORDER, { maxHeightMm: H })
    expect(ev.check.find((c) => c.sku === 'HS-5K')).toMatchObject({ requested: 30, placed: 27, ok: false })
    expect(ev.pallets.flatMap((x) => x.issues.filter((i) => i.severity === 'CRITICAL'))).toEqual([])
  })
  it('mover caixas entre paletes mantém o total e a física', () => {
    const from = base.pallets.find((x) => x.lines.some((l) => l.sku === 'HS-5K'))!
    const to = base.pallets.find((x) => x !== from && x.heightMm < 2000)!
    const m = moveBoxesBetween(from.doc, to.doc, 'HS-5K', 2, H)
    expect(m.moved).toBeGreaterThan(0)
    const docs = base.pallets.map((x) => (x === from ? m.from : x === to ? m.to : x.doc))
    const ev = evaluateMixedPlan(docs, ORDER, { maxHeightMm: H })
    expect(ev.check.every((c) => c.ok)).toBe(true)
    expect(ev.pallets.flatMap((x) => x.issues.filter((i) => i.severity === 'CRITICAL'))).toEqual([])
  })
  it('adicionar respeita a altura máxima (não passa do limite)', () => {
    const p = base.pallets.reduce((a, b) => (a.heightMm > b.heightMm ? a : b))
    const r = addBoxesToMixed(p.doc, 'pv5', P['10K'], 50, H)
    const ev = evaluateMixedPlan([r.doc], [], { maxHeightMm: H })
    expect(ev.pallets[0].heightMm).toBeLessThanOrEqual(H)
    expect(ev.pallets[0].issues.filter((i) => i.severity === 'CRITICAL')).toEqual([])
  })
})

describe('paletes mistos — casos gerais', () => {
  it('um único SKU equivale à paletização por camadas (26 × HS-10K a 2.110 mm)', () => {
    const r = optimizeMixedPallets([line('10K', 26)], { palletTypes: [simple], maxHeightMm: 2110 })
    expect(r.pallets).toHaveLength(1)
    expect(r.pallets[0].heightMm).toBeLessThanOrEqual(2110)
    expect(r.ok).toBe(true)
  })
  it('altura aérea configurável: 1.600 mm gera mais paletes, todos ≤ 1.600', () => {
    const r = optimizeMixedPallets(ORDER, { palletTypes: [simple, double], maxHeightMm: 1600 })
    expect(r.ok).toBe(true)
    for (const p of r.pallets) expect(p.heightMm).toBeLessThanOrEqual(1600)
    expect(transportMaxHeight('AIR', null, 1600)).toBe(1600)
    // sem altura informada e sem ULD: não inventa (nem usa o limite de outro equipamento)
    expect(transportMaxHeight('AIR', null, null, 2395)).toBeNull()
    expect(transportMaxHeight('LCL', null, null)).toBeNull()
  })
  it('limite de peso por palete é respeitado', () => {
    const r = optimizeMixedPallets([line('50K', 18)], { palletTypes: [double], maxHeightMm: 2292, maxLoadKg: 1000 })
    expect(r.ok).toBe(true)
    for (const p of r.pallets) expect(p.grossKg - p.doc.palletType.tareKg).toBeLessThanOrEqual(1000)
    expect(r.pallets.length).toBeGreaterThanOrEqual(3)
  })
  it('regra de palete (1,15 × 1,15) com reserva: só as caixas que não cabem usam o palete padrão do produto', () => {
    const r = optimizeMixedPallets(ORDER, { palletTypes: [simple], fallbackPalletTypes: [double], maxHeightMm: 2292 })
    expect(r.ok).toBe(true)
    for (const p of r.pallets) {
      const big = p.lines.some((l) => ['HS-50K', 'HS-40K', 'HS-30K'].includes(l.sku))
      expect(p.doc.palletType.code).toBe(big ? 'PCF-1150-DUPLO' : 'PCF-1150')
    }
    expect(r.notes.join(' ')).toMatch(/não cabe em PCF-1150/)
  })
  it('orientações livres: o motor pode deitar a caixa (face estável) e o resultado é físico e exato', () => {
    const all = ['LWH', 'WLH', 'LHW', 'HLW', 'WHL', 'HWL'] as const
    // caixa alta e estreita (300 × 200 × 1000): deitada rende mais por altura e é estável; em pé, não
    const tall = pack({ sku: 'ALTA', packagingVersionId: 50, dims: { l: 300, w: 200, h: 1000 }, grossKg: 10, allowedOrientations: [...all] })
    const upright = { ...tall, allowedOrientations: ['LWH', 'WLH'] as typeof tall.allowedOrientations }
    const free = optimizeMixedPallets([{ packId: 'pv50', pack: tall, boxes: 70 }], { palletTypes: [simple], maxHeightMm: 2292 })
    const fixed = optimizeMixedPallets([{ packId: 'pv50', pack: upright, boxes: 70 }], { palletTypes: [simple], maxHeightMm: 2292 })
    expect(free.ok).toBe(true)
    expect(fixed.ok).toBe(true)
    // orientação natural: apoiada na maior face (menor altura = 200 mm); restrição "só em pé" prevalece
    expect(free.pallets.every((p) => p.doc.items.every((i) => orientDims(tall.dims, i.orientation).z === 200))).toBe(true)
    expect(fixed.pallets.every((p) => p.doc.items.every((i) => orientDims(tall.dims, i.orientation).z === 1000))).toBe(true)
    // com o pedido real e todas as orientações liberadas, continua exato e sem alertas
    const allOrder = ORDER.map((o) => ({ ...o, pack: { ...o.pack, allowedOrientations: [...all] } }))
    const r = optimizeMixedPallets(allOrder, { palletTypes: [simple, double], maxHeightMm: 2292 })
    expect(r.ok).toBe(true)
  })
  it('camada com vãos (PBR 1,00 × 1,20): caixas de cima só sobre faces de caixas (sem apoio parcial)', () => {
    const pbr = palletType({ palletTypeId: 1, code: 'PBR-1', dims: { l: 1000, w: 1200, h: 137 }, tareKg: 27, maxLoadKg: 2000, staticMaxKg: 2000, dynamicMaxKg: 2000 })
    const order = [line('20K', 10), line('10K', 20), line('5K', 30), line('2K', 20)]
    const r = optimizeMixedPallets(order, { palletTypes: [pbr], maxHeightMm: 2600 })
    expect(r.pallets.flatMap((p) => p.issues.filter((i) => i.severity === 'CRITICAL'))).toEqual([])
    expect(r.ok).toBe(true)
  })
  it('caixa que não cabe em nenhum palete é informada (não some)', () => {
    const r = optimizeMixedPallets([line('50K', 2)], { palletTypes: [simple], maxHeightMm: 2292 })
    expect(r.ok).toBe(false)
    expect(r.unplaced[0]).toMatchObject({ sku: 'HS-50K', boxes: 2 })
  })
})

describe('regressão SB 9×60: a regra logística não piora o palete do catálogo', () => {
  // caixa 1000×600×400 (silo-bolsa 9×60), padrão do catálogo PBR-1 1000×1200 = 2 por camada; no PCF-1150 só 1
  const sb = pack({ sku: 'SB-9X60', name: 'SB-9X60', packagingVersionId: 90, dims: { l: 1000, w: 600, h: 400 }, grossKg: 60, netKg: 58, allowedOrientations: ['LWH', 'WLH', 'LHW', 'HLW', 'WHL', 'HWL'] })
  const pbr = palletType({ palletTypeId: 1, code: 'PBR-1', dims: { l: 1000, w: 1200, h: 137 }, dynamicMaxKg: 1500 })
  it('usa o PBR-1 do produto (2 caixas deitadas por camada), não o PCF-1150 da regra com 1 por camada', () => {
    const r = optimizeMixedPallets([{ packId: 'pv90', pack: sb, boxes: 40 }], { palletTypes: [simple], fallbackPalletTypes: [pbr], maxHeightMm: 2292 })
    expect(r.pallets.every((p) => p.doc.palletType.code === 'PBR-1')).toBe(true)
    for (const p of r.pallets) {
      expect(new Set(p.doc.items.map((i) => orientDims(sb.dims, i.orientation).z))).toEqual(new Set([400])) // deitadas
      const perLayer = new Map<number, number>()
      for (const i of p.doc.items) perLayer.set(i.pos.z, (perLayer.get(i.pos.z) ?? 0) + 1)
      expect(Math.max(...perLayer.values())).toBe(2)
    }
  })
})

describe('palete completo calculado com a altura real, contando os kits', () => {
  const hf = pack({ sku: 'HF-5K', name: 'HF-5K', packagingVersionId: 50, dims: { l: 1140, w: 570, h: 110 }, grossKg: 18, netKg: 15, companions: [{ sku: 'KIT-HF', qty: 1 }] })
  const kit = pack({ sku: 'KIT-HF', name: 'KIT-HF', packagingVersionId: 51, dims: { l: 200, w: 200, h: 200 }, grossKg: 2, netKg: 2 })
  const order = (b: number): OrderLine[] => [
    { packId: 'pv50', pack: hf, boxes: b },
    { packId: 'pv51', pack: kit, boxes: b },
  ]
  const at = (h: number) => maxBoxesPerPallet(hf, order, { palletTypes: [simple], maxHeightMm: h })
  it('2.292 mm (porta do 20GP/40GP): 34 HF + 34 kits (caixa de 26 + 8 individuais); a 2.200 mm cabem menos — e o resultado vai em UM palete', () => {
    expect(at(2292)).toBe(34)
    expect(at(2200)).toBeLessThan(34)
    const r = optimizeMixedPallets(order(at(2200)), { palletTypes: [simple], maxHeightMm: 2200 })
    expect(r.pallets).toHaveLength(1)
    expect(r.unplaced).toEqual([])
  })
})

describe('kits Hydroforce em caixas coletivas (26 / meia caixa / individuais) no motor', () => {
  const ALL = ['LWH', 'WLH', 'LHW', 'HLW', 'WHL', 'HWL'] as const
  const kitP = pack({ sku: 'KIT-HF', name: 'KIT-HF', packagingVersionId: 155, dims: { l: 200, w: 200, h: 200 }, grossKg: 2, netKg: 2, allowedOrientations: [...ALL] })
  const hfp = (sku: string, id: number, l: number, w: number, h: number, kg: number, max: number) =>
    pack({ sku, name: sku, packagingVersionId: id, dims: { l, w, h }, grossKg: kg, netKg: kg * 0.75, boxesPerPallet: max, companions: [{ sku: 'KIT-HF', qty: 1 }], allowedOrientations: [...ALL] })
  const HF2K = hfp('HF-2M-2K', 165, 600, 500, 130, 9.73, 52)
  const HF5K = hfp('HF-2M-5K', 166, 1140, 570, 110, 17.16, 36)
  const HF10K = hfp('HF-2M-10K', 167, 1140, 570, 150, 28.02, 26)
  const withKits = (p: typeof HF2K, n: number): OrderLine[] => [
    { packId: `pv${p.packagingVersionId}`, pack: p, boxes: n },
    { packId: 'pv155', pack: kitP, boxes: n },
  ]
  const run = (order: OrderLine[], h: number) => optimizeMixedPallets(order, { palletTypes: [simple], maxHeightMm: h })
  type Doc = ReturnType<typeof run>['pallets'][number]['doc']
  const count = (d: Doc, sku: string) => d.items.filter((i) => d.packs[i.packId].sku === sku).length
  const kitBoxes = (d: Doc) => d.items.filter((i) => d.packs[i.packId].sku === 'KIT-HF').map((i) => d.packs[i.packId].unitsPerPackage).sort((a, b) => b - a)
  const kitUnits = (d: Doc) => kitBoxes(d).reduce((s, k) => s + k, 0)

  it('52 × HF 2K (2.292 mm): 1 palete padrão, 2 caixas de 26, 2.100 mm; conferência em kits', () => {
    const r = run(withKits(HF2K, 52), 2292)
    expect(r.pallets).toHaveLength(1)
    expect(count(r.pallets[0].doc, 'HF-2M-2K')).toBe(52)
    expect(kitBoxes(r.pallets[0].doc)).toEqual([26, 26])
    expect(r.pallets[0].heightMm).toBe(2100)
    expect(r.check.find((c) => c.sku === 'KIT-HF')).toMatchObject({ requested: 52, placed: 52, ok: true })
    expect(r.ok).toBe(true)
  })
  it("40' HC (2.597 mm): 36 HF 5K = 1 caixa 69488 de 36 kits (2.540 mm); 26 HF 10K = 1 caixa de 26 (2.360 mm)", () => {
    const r5 = run(withKits(HF5K, 36), 2597)
    expect(r5.pallets).toHaveLength(1)
    expect(kitBoxes(r5.pallets[0].doc)).toEqual([36])
    expect(r5.pallets[0].heightMm).toBe(2540)
    // sem altura para a caixa de 400 mm (2.450 mm): a regra de sempre, 26 + 10 individuais
    const low = run(withKits(HF5K, 36), 2450)
    expect(low.pallets.map((p) => count(p.doc, 'HF-2M-5K'))).toEqual([36])
    expect(kitBoxes(low.pallets[0].doc)).toEqual([26, ...Array(10).fill(1)])
    expect(low.pallets[0].heightMm).toBe(2390)
    expect(r5.ok).toBe(true)
    const r10 = run(withKits(HF10K, 26), 2597)
    expect(r10.pallets).toHaveLength(1)
    expect(kitBoxes(r10.pallets[0].doc)).toEqual([26])
    expect(r10.pallets[0].heightMm).toBe(2360)
    expect(r10.ok).toBe(true)
  })
  it("20'/40' Dry (2.292 mm): o maior palete que cabe — 34 HF 5K e 24 HF 10K, kits = unidades — com nota", () => {
    const r5 = run(withKits(HF5K, 68), 2292)
    expect(r5.pallets.map((p) => count(p.doc, 'HF-2M-5K'))).toEqual([34, 34])
    for (const p of r5.pallets) {
      expect(kitBoxes(p.doc)).toEqual([26, ...Array(8).fill(1)])
      expect(p.heightMm).toBeLessThanOrEqual(2292)
    }
    expect(r5.notes.join(' ')).toMatch(/HF-2M-5K.*34 un\. \+ 34 kits/)
    expect(r5.ok).toBe(true)
    const r10 = run(withKits(HF10K, 48), 2292)
    expect(r10.pallets.map((p) => count(p.doc, 'HF-2M-10K'))).toEqual([24, 24])
    for (const p of r10.pallets) expect(kitBoxes(p.doc)).toEqual([13, 11])
    expect(r10.ok).toBe(true)
    // 36 pedidos: um palete com o máximo (34) e o resto à parte, cada um com os seus kits
    const r36 = run(withKits(HF5K, 36), 2292)
    expect(r36.pallets.map((p) => [count(p.doc, 'HF-2M-5K'), kitUnits(p.doc)])).toEqual([
      [34, 34],
      [2, 2],
    ])
    expect(r36.ok).toBe(true)
  })
  it('104 × HF 2K → 2 paletes padrão de 52 (2 caixas de 26 cada)', () => {
    const r = run(withKits(HF2K, 104), 2292)
    expect(r.pallets.map((p) => [count(p.doc, 'HF-2M-2K'), kitBoxes(p.doc).join('+')])).toEqual([
      [52, '26+26'],
      [52, '26+26'],
    ])
    expect(r.ok).toBe(true)
  })
  it('pedido misto: kits só nos paletes com Hydroforce, 1 por unidade; maxBoxesPerPallet a 2.292 mm = 34', () => {
    const r = run([line('20K', 10), ...withKits(HF5K, 40)], 2292)
    expect(r.unplaced).toEqual([])
    for (const p of r.pallets) expect(kitUnits(p.doc)).toBe(count(p.doc, 'HF-2M-5K'))
    expect(r.pallets.reduce((s, p) => s + kitUnits(p.doc), 0)).toBe(40)
    expect(r.ok).toBe(true)
    expect(maxBoxesPerPallet(HF5K, (b) => withKits(HF5K, b), { palletTypes: [simple], maxHeightMm: 2292 })).toBe(34)
    expect(maxBoxesPerPallet(HF5K, (b) => withKits(HF5K, b), { palletTypes: [simple], maxHeightMm: 2597 })).toBe(36)
  })

  const HF20K3M = hfp('HF-3M-20K', 170, 1140, 570, 250, 41.2, 16)
  const HS5K = pack({ sku: 'HS-2M-5K', name: 'HS-2M-5K', packagingVersionId: 142, dims: { l: 1140, w: 570, h: 110 }, grossKg: 17.16, netKg: 14, boxesPerPallet: 36, allowedOrientations: [...ALL] })
  const ln = (p: typeof HF2K, n: number): OrderLine => ({ packId: `pv${p.packagingVersionId}`, pack: p, boxes: n })
  const hfUnits = (d: Doc) => d.items.filter((i) => d.packs[i.packId].sku.startsWith('HF')).length
  const fmtKits = (d: Doc) => kitBoxes(d).filter((k) => k > 1).join('+') + (kitBoxes(d).some((k) => k === 1) ? `+${kitBoxes(d).filter((k) => k === 1).length}ind` : '')
  const sane = (r: ReturnType<typeof run>) => {
    expect(r.pallets.flatMap((p) => p.issues.filter((i) => i.severity === 'CRITICAL'))).toEqual([])
    for (const p of r.pallets) expect(kitUnits(p.doc)).toBe(hfUnits(p.doc))
    expect(r.ok).toBe(true)
  }

  it('palete acima do máximo do catálogo é aparado sem deixar caixas de kits flutuando (refeitas sobre o que ficou)', () => {
    // 2.292 mm: um palete passa do máximo e 1 caixa sai para outro palete — antes 6 KIT-HF ficavam sem apoio
    const r = run([ln(HF20K3M, 14), ln(HS5K, 20), ln(HF2K, 38), { packId: 'pv155', pack: kitP, boxes: 52 }], 2292)
    // (com a regra 1–12 individuais o recorte pode nem ser necessário; o que importa: nada flutuando, kits = HF)
    sane(r)
    const r2 = run([ln(HF2K, 30), ln(HF10K, 35), ln(HS5K, 16), ln(HF5K, 35), { packId: 'pv155', pack: kitP, boxes: 100 }], 2292)
    sane(r2)
  })
  it('HF 2K com a camada de cima incompleta (47 / 49 / 99 un.): sem palete a mais e sem a nota falsa de "padrão não cabe"', () => {
    for (const H of [2292, 2597]) {
      for (const n of [47, 49]) {
        const r = run(withKits(HF2K, n), H)
        expect(r.pallets.map((p) => count(p.doc, 'HF-2M-2K'))).toEqual([n])
        expect(r.notes.join(' ')).not.toMatch(/não cabe/)
        sane(r)
      }
      const r99 = run(withKits(HF2K, 99), H)
      expect(r99.pallets.map((p) => count(p.doc, 'HF-2M-2K'))).toEqual([52, 47])
      expect(r99.notes.join(' ')).not.toMatch(/não cabe/)
      sane(r99)
    }
    // a 2.000 mm o padrão não cabe: o maior palete é 48 (12 camadas completas + kits), não 44
    expect(maxBoxesPerPallet(HF2K, (b) => withKits(HF2K, b), { palletTypes: [simple], maxHeightMm: 2000 })).toBe(48)
  })
  it('37 caixas da mesma classe (HF 5K + HS 5K) em 40\' HC: 2 paletes, como no 20\'/40\' Dry', () => {
    for (const H of [2292, 2597]) {
      const r = run([ln(HF5K, 34), ln(HS5K, 3), { packId: 'pv155', pack: kitP, boxes: 34 }], H)
      expect(r.pallets).toHaveLength(2)
      sane(r)
    }
    const r73 = run([ln(HF5K, 70), ln(HS5K, 3), { packId: 'pv155', pack: kitP, boxes: 70 }], 2597)
    expect(r73.pallets).toHaveLength(3)
    sane(r73)
  })
  it('HF 2K com 2 soltas sobre a última camada: a caixa de 26 vem primeiro (26 → 26; 42 → 26 + 13 + 3; 46 → 26 + 13 + 7)', () => {
    for (const H of [2292, 2597]) {
      expect(fmtKits(run(withKits(HF2K, 26), H).pallets[0].doc)).toBe('26')
      expect(fmtKits(run(withKits(HF2K, 42), H).pallets[0].doc)).toBe('26+13+3')
      expect(fmtKits(run(withKits(HF2K, 46), H).pallets[0].doc)).toBe('26+13+7')
      const r78 = run(withKits(HF2K, 78), H)
      expect(r78.pallets.map((p) => [count(p.doc, 'HF-2M-2K'), fmtKits(p.doc)])).toEqual([
        [52, '26+26'],
        [26, '26'],
      ])
    }
  })
  it('cada palete leva as caixas de kits da regra para as suas unidades (todos os HF, 1 a 2 paletes padrão + 3)', () => {
    for (const p of [HF2K, HF5K, HF10K, HF20K3M])
      for (const H of [2292, 2597])
        for (let n = 1; n <= 2 * (p.boxesPerPallet ?? 0) + 3; n += 7) {
          const r = run(withKits(p, n), H)
          sane(r)
          for (const q of r.pallets) expect(kitBoxes(q.doc)).toEqual(packKits(hfUnits(q.doc)).map((f) => f.kits).sort((a, b) => b - a))
        }
  })
})
