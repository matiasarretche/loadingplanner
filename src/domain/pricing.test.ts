import { describe, expect, it } from 'vitest'
import { placePallets } from './autoload'
import { container, loadDoc, pack, palletDoc, palletType } from './fixtures'
import { kitBoxPack, packKeyOf } from './kitBoxes'
import { orderValueFromPrices, quoteSignatureInput, quoteSummary, skuQuantities } from './pricing'

describe('valor do pedido com os preços do módulo', () => {
  const a = pack({ sku: 'SB-A', packagingVersionId: 1, grossKg: 100, netKg: 94 })
  const item = (id: string, z: number) => ({ id, packId: 'a', pos: { x: 0, y: 0, z }, orientation: 'LWH' as const, locked: false })
  const p = palletDoc({ packs: { a }, items: [item('1', 0), item('2', 400)] })
  const doc = placePallets(loadDoc({ space: container('40HC') }), 'p', p, 3).doc

  it('preço por unidade × unidades; comissão total só interna', () => {
    const v = orderValueFromPrices(doc, { 'SB-A': { unitUsd: 105.26, baseUnitUsd: 100, commissionPct: 5, commissionUnitUsd: 5.26 } })
    expect(v.lines[0]).toMatchObject({ sku: 'SB-A', quantity: 6, unitPrice: 105.26, amount: 631.56 })
    expect(v.totals).toEqual({ USD: 631.56 })
    expect(v.commissionUsd).toBeCloseTo(31.56, 2)
  })
  it('sem preço: lista o produto e o motivo', () => {
    const v = orderValueFromPrices(doc, { 'SB-A': { unitUsd: null, reason: 'país XX sem categoria comercial' } })
    expect(v.missing).toEqual(['SB-A'])
    expect(v.reasons['SB-A']).toMatch(/sem categoria/)
    expect(v.totals).toEqual({})
  })
})

describe('cotações emitidas: resumo para consulta futura', () => {
  const f = (family: string, usdPerKg: number | null, extra: Partial<import('./pricing').PriceFactors> = {}) => ({
    familyId: 1, family, method: 'PER_KG', category: 'Categoria A', usdPerKg, fixedUsdPerUnit: null, refFamily: null, markupPct: null, brand: 'Pacifil', brandAdjustPct: null, netKgUnit: 100, baseUnitUsd: 240, ...extra,
  })
  const lines = [
    { sku: 'SB-A', name: 'Silo', units: 10, unitUsd: 240, amount: 2400, factors: f('Silo-bolsa', 2.4) },
    { sku: 'SB-ECO', name: 'Silo Eco', units: 2, unitUsd: 228, amount: 456, factors: f('Silo-bolsa', 2.4, { brand: 'Ecobag', brandAdjustPct: -5 }) },
    { sku: 'HS-5K', name: 'Hidrosilo', units: 5, unitUsd: 78, amount: 390, factors: f('Hidrosilo', 3.1, { method: 'PER_KG_PLUS_FIXED', fixedUsdPerUnit: 40 }) },
    { sku: 'KIT-HF', name: 'Kit', units: 5, unitUsd: 0, amount: 0, factors: f('Acessórios', null, { method: 'INCLUDED' }) },
  ]
  it('USD/kg principal = família de maior valor; comissão; ajuste de marca', () => {
    const s = quoteSummary(lines)
    expect(s.principal).toMatchObject({ family: 'Silo-bolsa', usdPerKg: 2.4 })
    expect(s.principal!.sharePct).toBeCloseTo(88, 0)
    expect(s.commissionPcts).toEqual([])
    expect(s.brandAdjusts).toEqual([{ brand: 'Ecobag', pct: -5 }])
    expect(quoteSummary([{ ...lines[0], commissionPct: 5 }]).commissionPcts).toEqual([5])
  })
  it('Silo-bolsa com faixas de diâmetro: principal pela família somando as faixas; cada faixa com o seu rótulo', () => {
    const banded = [
      { sku: 'SB-9', name: 'Silo 9', units: 1, unitUsd: 300, amount: 30000, factors: f('Silo-bolsa', 2.5, { priceBand: '9 a 12 pés' }) },
      { sku: 'SB-6', name: 'Silo 6', units: 1, unitUsd: 300, amount: 29000, factors: f('Silo-bolsa', 2.6, { priceBand: '5 a 8 pés (diâmetro 8,5 pés, faixa mais próxima)' }) },
      { sku: 'LS', name: 'Lona', units: 1, unitUsd: 400, amount: 41000, factors: f('Lona de silagem', 2.2) },
    ]
    const s = quoteSummary(banded)
    expect(s.principal).toMatchObject({ family: 'Silo-bolsa', usdPerKg: 2.5, sharePct: 59, bands: ['9 a 12 pés'], groups: 2 })
    expect(s.byFamily.filter((x) => x.family === 'Silo-bolsa').map((x) => x.bands)).toEqual([['9 a 12 pés'], ['5 a 8 pés']])
  })
  it('assinatura: mesmo conteúdo = mesma; preço ou USD/kg diferente = outra', () => {
    expect(quoteSignatureInput(lines)).toBe(quoteSignatureInput([...lines].reverse()))
    expect(quoteSignatureInput(lines)).not.toBe(quoteSignatureInput([{ ...lines[0], unitUsd: 241 }, ...lines.slice(1)]))
    expect(quoteSignatureInput(lines)).not.toBe(quoteSignatureInput([{ ...lines[0], factors: f('Silo-bolsa', 2.5) }, ...lines.slice(1)]))
  })
})

describe('kits em caixas coletivas: valor e assinatura contam kits (unidades), não caixas', () => {
  const kit = pack({ sku: 'KIT-HF', packagingVersionId: 155, dims: { l: 200, w: 200, h: 200 }, grossKg: 2, netKg: 2 })
  const hf = pack({ sku: 'HF-5K', packagingVersionId: 21, dims: { l: 1140, w: 570, h: 110 }, grossKg: 17.16, netKg: 12.3, companions: [{ sku: 'KIT-HF', qty: 1 }] })
  const big = kitBoxPack(kit, 'BIG', 26)
  const it0 = (id: string, packId: string, x: number, y: number, z: number) => ({ id, packId, pos: { x, y, z }, orientation: 'LWH' as const, locked: false })
  // 26 HF (13 camadas de 2) com 1 caixa de 26 kits × o mesmo com 26 kits individuais
  const pt = palletType({ palletTypeId: 6, code: 'PCF-1150', dims: { l: 1150, w: 1150, h: 160 }, maxLoadKg: 2000, staticMaxKg: 2000, dynamicMaxKg: 2000 })
  const hfItems = Array.from({ length: 26 }, (_, i) => it0(`h${i}`, 'pv21', 5, 5 + (i % 2) * 570, Math.floor(i / 2) * 110))
  const indItems = Array.from({ length: 26 }, (_, i) => it0(`k${i}`, 'pv155', 5 + (i % 5) * 200, 5 + (Math.floor(i / 5) % 5) * 200, 1430 + Math.floor(i / 25) * 200))
  const boxed = placePallets(loadDoc({ space: container('40HC') }), 'b', palletDoc({ palletType: pt, packs: { pv21: hf, [packKeyOf(big)]: big }, items: [...hfItems, it0('k', packKeyOf(big), 5, 5, 1430)] }), 1).doc
  const loose = placePallets(loadDoc({ space: container('40HC') }), 'l', palletDoc({ palletType: pt, packs: { pv21: hf, pv155: kit }, items: [...hfItems, ...indItems] }), 1).doc
  it('KIT-HF: 26 unidades a preço 0 nos dois casos; kg líquido por kit igual (mesma assinatura)', () => {
    const prices = { 'HF-5K': { unitUsd: 100 }, 'KIT-HF': { unitUsd: 0 } }
    for (const d of [boxed, loose]) {
      const v = orderValueFromPrices(d, prices)
      expect(v.lines.find((l) => l.sku === 'KIT-HF')).toMatchObject({ quantity: 26, amount: 0 })
      expect(v.totals).toEqual({ USD: 2600 })
    }
    const q = (d: typeof boxed) => skuQuantities(d).get('KIT-HF')!
    expect(q(boxed)).toMatchObject({ units: 26, boxes: 1 })
    expect(q(loose)).toMatchObject({ units: 26, boxes: 26 })
    expect(q(boxed).pack.netKg / q(boxed).pack.unitsPerPackage).toBe(q(loose).pack.netKg / q(loose).pack.unitsPerPackage)
  })
})
