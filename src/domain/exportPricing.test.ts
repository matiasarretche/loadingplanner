import { describe, expect, it } from 'vitest'
import { bandFor, bandPriceKey, buildPriceTwins, categoryOfCountry, configFromPayload, diameterFtOf, NO_CIF_REASON, NO_TWIN_REASON, roundUpUsd, twinsWithSnapshot, commissionKey, commissionRateFor, priceForProduct, priceKey, PricingConfig, quoteLineTotal, quotePrice, unitPriceFor, withCommission } from './exportPricing'

// valores ilustrativos só para o teste (não são preços da Pacifil)
const cfg: PricingConfig = {
  categories: [
    { id: 1, code: 'A', name: 'A', active: true },
    { id: 2, code: 'B', name: 'B', active: true },
  ],
  countryCategory: new Map([
    ['UY', 1],
    ['MX', 2],
  ]),
  familyRule: new Map([
    [10, { method: 'PER_KG' }],
    [20, { method: 'PER_KG_PLUS_FIXED' }],
    [30, { method: 'INCLUDED' }],
    [40, { method: 'RELATIVE', refFamilyId: 20, markupPct: 40 }],
  ]),
  brandAdjust: new Map([['ecobag', -5]]),
  commission: new Map([
    [commissionKey(7, 10), 5],
    [commissionKey(8, 10), 3],
  ]),
  familyPrice: new Map([
    [priceKey(10, 1), { usdPerKg: 2, fixedUsdPerUnit: null }],
    [priceKey(20, 2), { usdPerKg: 3, fixedUsdPerUnit: 15 }],
  ]),
}

/** recargo CIF por família (USD/kg); só as famílias informadas mudam */
const withCif = (c: PricingConfig, cif: Record<number, number | null>): PricingConfig => ({
  ...c,
  familyRule: new Map([...c.familyRule].map(([id, r]) => [id, id in cif ? { ...r, cifUsdPerKg: cif[id] } : r])),
})

describe('preços de exportação', () => {
  it('USD/kg sobre o peso LÍQUIDO', () => {
    const r = unitPriceFor('PER_KG', { usdPerKg: 2.4, fixedUsdPerUnit: null }, 102.166)
    expect(r.ok && r.unitUsd).toBeCloseTo(245.1984, 6)
  })
  it('Hidrosilo: peso líquido × USD/kg + fixo por unidade', () => {
    const r = unitPriceFor('PER_KG_PLUS_FIXED', { usdPerKg: 3, fixedUsdPerUnit: 15 }, 12.3)
    expect(r.ok && [r.kgPart, r.fixedPart]).toEqual([36.9, 15])
    expect(r.ok && r.unitUsd).toBeCloseTo(51.9, 9)
  })
  it('falta de dado → sem preço com o motivo (nunca inventa)', () => {
    expect(unitPriceFor('PER_KG', null, 10).ok).toBe(false)
    expect(unitPriceFor('PER_KG_PLUS_FIXED', { usdPerKg: 3, fixedUsdPerUnit: null }, 10).ok).toBe(false)
    expect(unitPriceFor('PER_KG', { usdPerKg: 3, fixedUsdPerUnit: null }, 0).ok).toBe(false)
  })
  it('incluído (KIT-HF) = 0', () => {
    expect(priceForProduct(cfg, { sku: 'KIT-HF', familyId: 30, netKg: 2 }, 'UY')).toMatchObject({ ok: true, unitUsd: 0 })
  })
  it('país → categoria → família → preço; país sem categoria não tem preço', () => {
    expect(priceForProduct(cfg, { sku: 'SB', familyId: 10, netKg: 100 }, 'UY')).toMatchObject({ ok: true, unitUsd: 200, category: { code: 'A' } })
    expect(priceForProduct(cfg, { sku: 'HS', familyId: 20, netKg: 10 }, 'mx')).toMatchObject({ ok: true, unitUsd: 45 })
    expect(priceForProduct(cfg, { sku: 'SB', familyId: 10, netKg: 100 }, 'AR')).toMatchObject({ ok: false, category: null })
    expect(categoryOfCountry(cfg, 'AR')).toBeNull()
  })
  it('Hidroforce = Hidrosilo + 40% (com o peso líquido do próprio produto)', () => {
    // Hidrosilo no MX: 10 kg × 3 + 15 = 45 → Hidroforce 45 × 1,4 = 63
    const hf = priceForProduct(cfg, { sku: 'HF', familyId: 40, netKg: 10 }, 'MX')
    expect(hf).toMatchObject({ ok: true, base: { familyId: 20, unitUsd: 45, markupPct: 40 } })
    expect(hf.ok && hf.unitUsd).toBeCloseTo(63, 9)
    // preço final (para cima ao dólar): 63
    expect(quotePrice(cfg, { sku: 'HF', familyId: 40, netKg: 10 }, 'MX')).toMatchObject({ unitUsd: 63 })
    // Hidrosilo com centavos: ARREDONDA para cima antes dos 40% (10,5 kg × 3 + 15 = 46,5 → 47 × 1,4 = 65,8 → 66)
    const hf2 = priceForProduct(cfg, { sku: 'HF', familyId: 40, netKg: 10.5 }, 'MX')
    expect(hf2).toMatchObject({ ok: true, base: { unitUsd: 47 } })
    expect(hf2.ok && hf2.unitUsd).toBeCloseTo(65.8, 9)
    expect(quotePrice(cfg, { sku: 'HF', familyId: 40, netKg: 10.5 }, 'MX')).toMatchObject({ unitUsd: 66 })
    // sem preço do Hidrosilo na categoria → sem preço, com o motivo
    expect(priceForProduct(cfg, { sku: 'HF', familyId: 40, netKg: 10 }, 'UY')).toMatchObject({ ok: false })
  })
  it('marca Ecobag: 5% abaixo do preço de lista (qualquer família)', () => {
    expect(priceForProduct(cfg, { sku: 'SB-ECO', familyId: 10, netKg: 100, brand: 'Ecobag' }, 'UY')).toMatchObject({ ok: true, listUnitUsd: 200, brandAdjustPct: -5, unitUsd: 190 })
    expect(priceForProduct(cfg, { sku: 'SB-PAC', familyId: 10, netKg: 100, brand: 'Pacifil' }, 'UY')).toMatchObject({ ok: true, unitUsd: 200 })
  })
  it('sem arredondar a centavos no meio: 20,001 kg × 2,50 = 50,0025 → 51 (não 50)', () => {
    const c4: PricingConfig = { ...cfg, familyPrice: new Map([[priceKey(10, 1), { usdPerKg: 2.5, fixedUsdPerUnit: null }]]) }
    expect(quotePrice(c4, { sku: 'SB', familyId: 10, netKg: 20.001 }, 'UY')).toMatchObject({ unitUsd: 51 })
    expect(quotePrice(withCif(c4, { 10: 0.05 }), { sku: 'SB', familyId: 10, netKg: 20.001 }, 'UY', { incoterm: 'CIF' })).toMatchObject({ unitUsd: 52 })
  })
  it('preço final sempre PARA CIMA ao dólar inteiro', () => {
    expect([roundUpUsd(51.01), roundUpUsd(51.54), roundUpUsd(52), roundUpUsd(52.0000001)]).toEqual([52, 52, 52, 52])
    // Ecobag: 200 × 0,95 = 190 (exato, fica 190); HS 10 kg × 3 + 15 = 45
    expect(quotePrice(cfg, { sku: 'HS', familyId: 20, netKg: 10.3 }, 'MX')).toMatchObject({ ok: true, baseUnitUsd: 45.9, unitUsd: 46 })
  })
  it('CIF: recargo por kg líquido da família, depois da marca, mantendo o fixo; só CIF', () => {
    const c2 = withCif(cfg, { 10: 0.05, 20: 0.2 })
    // Silo-bolsa UY: 100 kg × 2 = 200; CIF + 100 × 0,05 = 205
    expect(priceForProduct(c2, { sku: 'SB', familyId: 10, netKg: 100 }, 'UY', { incoterm: 'CIF' })).toMatchObject({ ok: true, unitUsd: 205, cifUsdPerKg: 0.05, cifSurchargeUsd: 5 })
    expect(priceForProduct(c2, { sku: 'SB', familyId: 10, netKg: 100 }, 'UY', { incoterm: 'FOB' })).toMatchObject({ ok: true, unitUsd: 200 })
    expect(priceForProduct(c2, { sku: 'SB', familyId: 10, netKg: 100 }, 'UY', { incoterm: 'CFR' })).toMatchObject({ ok: true, unitUsd: 200 })
    // Ecobag: lista 200 −5% = 190; o recargo CIF não leva o desconto da marca: 190 + 5 = 195
    expect(priceForProduct(c2, { sku: 'SB-ECO', familyId: 10, netKg: 100, brand: 'Ecobag' }, 'UY', { incoterm: 'cif' })).toMatchObject({ unitUsd: 195 })
    // Hidrosilo (fixo 15) com recargo próprio 0,2/kg: 10 × 3 + 15 + 10 × 0,2 = 47; fixo continua
    expect(priceForProduct(c2, { sku: 'HS', familyId: 20, netKg: 10 }, 'MX', { incoterm: 'CIF' })).toMatchObject({ unitUsd: 47, fixedPart: 15, cifSurchargeUsd: 2 })
    // incluído (KIT-HF) continua 0
    expect(priceForProduct(c2, { sku: 'KIT', familyId: 30, netKg: 2 }, 'UY', { incoterm: 'CIF' })).toMatchObject({ unitUsd: 0 })
    // com agente: comissão sobre o preço CIF e para cima ao dólar: 205 ÷ 0,95 = 215,79 → 216
    const c3: PricingConfig = { ...c2, commission: new Map([[commissionKey(7, 10), 5]]) }
    expect(quotePrice(c3, { sku: 'SB', familyId: 10, netKg: 100 }, 'UY', { agentId: 7, incoterm: 'CIF' })).toMatchObject({ unitUsd: 216 })
  })
  describe('CIF: recargo SEMPRE da família (não há padrão geral)', () => {
    // Hidrosilo (20) e Hidroforce (40) 0,10/kg; Silo-bolsa (10) 0,05/kg
    const c = withCif(cfg, { 10: 0.05, 20: 0.1, 40: 0.1 })
    it('usa o recargo da própria família', () => {
      // Silo-bolsa UY: 100 kg × 2 = 200 + 100 × 0,05 = 205
      expect(priceForProduct(c, { sku: 'SB', familyId: 10, netKg: 100 }, 'UY', { incoterm: 'CIF' })).toMatchObject({ ok: true, unitUsd: 205, cifUsdPerKg: 0.05, cifSurchargeUsd: 5 })
      // Hidrosilo MX: 10 × 3 + 15 = 45 + 10 × 0,10 = 46
      expect(priceForProduct(c, { sku: 'HS', familyId: 20, netKg: 10 }, 'MX', { incoterm: 'CIF' })).toMatchObject({ ok: true, unitUsd: 46, cifUsdPerKg: 0.1, cifSurchargeUsd: 1 })
      // Hidroforce (relativa): Hidrosilo 45 × 1,4 = 63 + o recargo do HIDROFORCE 10 × 0,10 = 64
      const hf = priceForProduct(c, { sku: 'HF', familyId: 40, netKg: 10 }, 'MX', { incoterm: 'CIF' })
      expect(hf).toMatchObject({ ok: true, cifUsdPerKg: 0.1, cifSurchargeUsd: 1 })
      expect(hf.ok && hf.unitUsd).toBeCloseTo(64, 9)
    })
    it('família sem recargo: sem preço em CIF (nunca recargo zero por omissão); FOB / FCA normais', () => {
      const semHs = withCif(c, { 20: null })
      expect(priceForProduct(semHs, { sku: 'HS', familyId: 20, netKg: 10 }, 'MX', { incoterm: 'CIF' })).toMatchObject({ ok: false, reason: NO_CIF_REASON })
      expect(quotePrice(semHs, { sku: 'HS', familyId: 20, netKg: 10 }, 'MX', { incoterm: 'cif', agentId: 7 })).toMatchObject({ ok: false, reason: NO_CIF_REASON, commission: null })
      expect(priceForProduct(semHs, { sku: 'HS', familyId: 20, netKg: 10 }, 'MX', { incoterm: 'FOB' })).toMatchObject({ ok: true, unitUsd: 45 })
      expect(priceForProduct(semHs, { sku: 'HS', familyId: 20, netKg: 10 }, 'MX', { incoterm: 'FCA' })).toMatchObject({ ok: true, unitUsd: 45 })
      expect(priceForProduct(semHs, { sku: 'HS', familyId: 20, netKg: 10 }, 'MX')).toMatchObject({ ok: true, unitUsd: 45 })
      // relativa: vale o recargo da PRÓPRIA família, não o da família de referência
      expect(priceForProduct(withCif(c, { 40: null }), { sku: 'HF', familyId: 40, netKg: 10 }, 'MX', { incoterm: 'CIF' })).toMatchObject({ ok: false, reason: NO_CIF_REASON })
      // família nova, sem linha de regra (PER_KG): sem preço em CIF, com preço em FOB
      const nova: PricingConfig = { ...c, familyPrice: new Map([...c.familyPrice, [priceKey(50, 1), { usdPerKg: 1, fixedUsdPerUnit: null }]]) }
      expect(priceForProduct(nova, { sku: 'NOVA', familyId: 50, netKg: 10 }, 'UY', { incoterm: 'CIF' })).toMatchObject({ ok: false, reason: NO_CIF_REASON })
      expect(priceForProduct(nova, { sku: 'NOVA', familyId: 50, netKg: 10 }, 'UY', { incoterm: 'FOB' })).toMatchObject({ ok: true, unitUsd: 10 })
    })
    it('recargo 0 informado de propósito: CIF sem acréscimo', () => {
      expect(priceForProduct(withCif(c, { 10: 0 }), { sku: 'SB', familyId: 10, netKg: 100 }, 'UY', { incoterm: 'CIF' })).toMatchObject({ ok: true, unitUsd: 200 })
    })
    it('incluído (KIT-HF): continua 0 em CIF, sem precisar de recargo', () => {
      expect(cfg.familyRule.get(30)?.cifUsdPerKg).toBeUndefined()
      expect(priceForProduct(c, { sku: 'KIT-HF', familyId: 30, netKg: 2 }, 'UY', { incoterm: 'CIF' })).toMatchObject({ ok: true, unitUsd: 0 })
      expect(quotePrice(c, { sku: 'KIT-HF', familyId: 30, netKg: 2 }, 'UY', { incoterm: 'CIF', agentId: 7 })).toMatchObject({ ok: true, unitUsd: 0, commission: null })
    })
    it('payload do navegador leva o recargo de cada família na regra', () => {
      const back = configFromPayload({ categories: c.categories, countryCategory: [...c.countryCategory], familyRule: [...c.familyRule], familyPrice: [...c.familyPrice], brandAdjust: [], commission: [], priceTwin: [], familyBands: [], bandPrice: [], skuDiameterFt: [], products: [], agents: [] })
      expect(priceForProduct(back, { sku: 'HS', familyId: 20, netKg: 10 }, 'MX', { incoterm: 'CIF' })).toMatchObject({ ok: true, unitUsd: 46 })
      expect(priceForProduct(back, { sku: 'SB', familyId: 10, netKg: 100 }, 'UY', { incoterm: 'CIF' })).toMatchObject({ ok: true, unitUsd: 205 })
    })
  })
  it('incluído (KIT-HF) via agente: 0, sem comissão e sem exigir % (não fica sem preço)', () => {
    expect(quotePrice(cfg, { sku: 'KIT-HF', familyId: 30, netKg: 2 }, 'UY', { agentId: 7 })).toMatchObject({ ok: true, unitUsd: 0, commission: null })
  })
  it('família "incluído": só o acompanhante vale 0; outro produto dela fica SEM PREÇO (nunca USD 0 calado)', () => {
    const c: PricingConfig = { ...cfg, companionSkus: new Set(['KIT-HF']) }
    expect(quotePrice(c, { sku: 'kit-hf', familyId: 30, netKg: 2 }, 'UY')).toMatchObject({ ok: true, unitUsd: 0, commission: null })
    const tape = quotePrice(c, { sku: '17712', familyId: 30, netKg: 4.94 }, 'UY', { agentId: 7 })
    expect(tape.ok).toBe(false)
    expect(!tape.ok && tape.reason).toContain('não é acompanhante')
    // o payload do navegador leva a lista de acompanhantes
    const back = configFromPayload({ categories: c.categories, countryCategory: [...c.countryCategory], familyRule: [...c.familyRule], familyPrice: [...c.familyPrice], brandAdjust: [], commission: [], priceTwin: [], familyBands: [], bandPrice: [], skuDiameterFt: [], companionSkus: ['KIT-HF'], products: [], agents: [] })
    expect(quotePrice(back, { sku: '17712', familyId: 30, netKg: 4.94 }, 'UY').ok).toBe(false)
    expect(quotePrice(back, { sku: 'KIT-HF', familyId: 30, netKg: 2 }, 'UY')).toMatchObject({ ok: true, unitUsd: 0 })
  })
  it('preço manual na cotização não depende da tabela', () => {
    expect(quoteLineTotal({ sku: 'SB', quantity: 3, calculatedUnitUsd: 200 })).toMatchObject({ unitUsd: 200, totalUsd: 600, manual: false })
    expect(quoteLineTotal({ sku: 'SB', quantity: 3, calculatedUnitUsd: 200, overrideUnitUsd: 190 })).toMatchObject({ unitUsd: 190, totalUsd: 570, manual: true })
  })
  it('comissão = % do preço FINAL: base 100 com 5% → 105,26 (agente recebe 5,26)', () => {
    expect(withCommission(100, 5)).toEqual({ unitUsd: 105.26, commissionUsd: 5.26 })
    // na cotização o preço final vai PARA CIMA ao dólar: 105,26 → 106
    expect(quoteLineTotal({ sku: 'SB', quantity: 2, calculatedUnitUsd: 100, commissionPct: 5 })).toMatchObject({ unitUsd: 106, totalUsd: 212, commissionUsd: 10.6 })
  })
  it('comissão: % do perfil do agente por família (o país não influi)', () => {
    expect(commissionRateFor(cfg, 7, 10)).toEqual({ pct: 5, source: 'agente' })
    expect(commissionRateFor(cfg, 8, 10)).toEqual({ pct: 3, source: 'agente' })
    expect(commissionRateFor(cfg, 8, 20)).toBeNull()
    // família sem % no perfil do agente → sem preço, com aviso
    expect(quotePrice(cfg, { sku: 'HS', familyId: 20, netKg: 10 }, 'MX', { agentId: 8 })).toMatchObject({ commission: { pct: null, warning: expect.stringContaining('perfil do agente') } })
    // Silo-bolsa no Uruguai (lista 200) via agente 7 (5%) → 210,53
    // 200 ÷ 0,95 = 210,53 → para cima 211; comissão = 5% de 211
    expect(quotePrice(cfg, { sku: 'SB', familyId: 10, netKg: 100 }, 'UY', { agentId: 7 })).toMatchObject({ ok: true, baseUnitUsd: 200, unitUsd: 211, commission: { pct: 5, source: 'agente', commissionUsd: 10.55 } })
    // fora da faixa usual: avisa, mas aceita
    expect(quotePrice(cfg, { sku: 'SB', familyId: 10, netKg: 100 }, 'UY', { commissionPct: 7 })).toMatchObject({ commission: { pct: 7, warning: expect.stringContaining('fora da faixa') } })
  })
  describe('Hidrosilo / Hidroforce de 3 m = Hidrosilo de 2 m da mesma capacidade', () => {
    // família 20 = Hidrosilo (por kg + fixo), 40 = Hidroforce (Hidrosilo arredondado + 40%)
    const twins = buildPriceTwins([
      { sku: 'HS-2M-5K', family: 'Hidrosilo', brand: 'Pacifil', widthM: 2, capacityL: 5000, netKg: 12.3 },
      { sku: 'HS-2M-10K', family: 'Hidrosilo', brand: 'Pacifil', widthM: 2, capacityL: 10000, netKg: 22.37 },
      { sku: 'HS-3M-10K', family: 'Hidrosilo', brand: 'Pacifil', widthM: 3, capacityL: 10000, netKg: 16.78 },
      { sku: 'HF-2M-10K', family: 'Hidroforce', brand: 'Pacifil', widthM: 2, capacityL: 10000, netKg: 22.37 },
      { sku: 'HF-3M-10K', family: 'Hidroforce', brand: 'Pacifil', widthM: 3, capacityL: 10000, netKg: 16.78 },
      { sku: 'HS-3M-35K', family: 'Hidrosilo', brand: 'Pacifil', widthM: 3, capacityL: 35000, netKg: 50 },
      { sku: 'LS-3X50', family: 'Lona de silagem', brand: 'Pacifil', widthM: 3, capacityL: null, netKg: 20 },
    ])
    const c: PricingConfig = { ...withCif(cfg, { 10: 0.05, 20: 0.1, 40: 0.1 }), priceTwin: twins }
    it('só os 3 m de Hidrosilo / Hidroforce entram; o equivalente é sempre o Hidrosilo 2 m', () => {
      expect(twins.get('HS-3M-10K')).toEqual({ sku: 'HS-2M-10K', netKg: 22.37 })
      expect(twins.get('HF-3M-10K')).toEqual({ sku: 'HS-2M-10K', netKg: 22.37 })
      expect(twins.get('HS-3M-35K')).toBeNull()
      expect(twins.has('HS-2M-10K')).toBe(false)
      expect(twins.has('LS-3X50')).toBe(false)
    })
    it('Hidrosilo 3 m: mesmo preço do 2 m (nunca pelo peso próprio), também em CIF', () => {
      const p2 = quotePrice(c, { sku: 'HS-2M-10K', familyId: 20, netKg: 22.37 }, 'MX')
      const p3 = quotePrice(c, { sku: 'hs-3m-10k', familyId: 20, netKg: 16.78 }, 'MX')
      expect(p3).toMatchObject({ ok: true, unitUsd: (p2 as { unitUsd: number }).unitUsd, priceAs: { sku: 'HS-2M-10K' } })
      const cif2 = quotePrice(c, { sku: 'HS-2M-10K', familyId: 20, netKg: 22.37 }, 'MX', { incoterm: 'CIF' }) as { unitUsd: number }
      expect(quotePrice(c, { sku: 'HS-3M-10K', familyId: 20, netKg: 16.78 }, 'MX', { incoterm: 'CIF' })).toMatchObject({ ok: true, unitUsd: cif2.unitUsd })
      // por kg próprio daria 16,78 × 3 + 15 = 65,34 → 66; pelo 2 m: 22,37 × 3 + 15 = 82,11 → 83
      expect(p3).toMatchObject({ unitUsd: 83 })
    })
    it('Hidroforce 3 m: Hidrosilo 2 m arredondado + 40%', () => {
      // Hidrosilo 2 m 10K = 83 → × 1,4 = 116,2 → 117 (igual ao Hidroforce 2 m 10K)
      expect(quotePrice(c, { sku: 'HF-3M-10K', familyId: 40, netKg: 16.78 }, 'MX')).toMatchObject({ ok: true, unitUsd: 117 })
      expect(quotePrice(c, { sku: 'HF-2M-10K', familyId: 40, netKg: 22.37 }, 'MX')).toMatchObject({ ok: true, unitUsd: 117 })
    })
    it('3 m desativado continua no mapa; 2 m desativado nunca é referência', () => {
      const t = buildPriceTwins([
        { sku: 'HS-2M-30K', family: 'Hidrosilo', brand: 'Pacifil', widthM: 2, capacityL: 30000, netKg: 67.1, active: true },
        { sku: 'HS-2M-4K', family: 'Hidrosilo', brand: 'Pacifil', widthM: 2, capacityL: 4000, netKg: 10, active: false },
        { sku: 'HS-3M-30K', family: 'Hidrosilo', brand: 'Pacifil', widthM: 3, capacityL: 30000, netKg: 50, active: false },
        { sku: 'HS-3M-4K', family: 'Hidrosilo', brand: 'Pacifil', widthM: 3, capacityL: 4000, netKg: 7, active: false },
      ])
      expect(t.get('HS-3M-30K')).toEqual({ sku: 'HS-2M-30K', netKg: 67.1 })
      expect(t.get('HS-3M-4K')).toBeNull()
    })
    it('carga com o 2 m equivalente: o 3 m usa o peso do snapshot do 2 m (mesmo preço na mesma Proforma)', () => {
      const snap = twinsWithSnapshot(twins, new Map([['HS-2M-10K', 22]]))!
      expect(snap.get('HS-3M-10K')).toEqual({ sku: 'HS-2M-10K', netKg: 22 })
      expect(snap.get('HF-3M-10K')).toEqual({ sku: 'HS-2M-10K', netKg: 22 })
      expect(snap.get('HS-3M-35K')).toBeNull()
      // o mapa original não muda
      expect(twins.get('HS-3M-10K')).toEqual({ sku: 'HS-2M-10K', netKg: 22.37 })
      const cs: PricingConfig = { ...c, priceTwin: snap }
      const p2 = quotePrice(cs, { sku: 'HS-2M-10K', familyId: 20, netKg: 22 }, 'MX', { incoterm: 'CIF' }) as { unitUsd: number }
      expect(quotePrice(cs, { sku: 'HS-3M-10K', familyId: 20, netKg: 16.78 }, 'MX', { incoterm: 'CIF' })).toMatchObject({ ok: true, unitUsd: p2.unitUsd })
    })
    it('3 m sem Hidrosilo 2 m da mesma capacidade: sem preço (não cai no cálculo por kg)', () => {
      expect(quotePrice(c, { sku: 'HS-3M-35K', familyId: 20, netKg: 50 }, 'MX')).toMatchObject({ ok: false, reason: NO_TWIN_REASON })
    })
    it('códigos oficiais numéricos: o 3 m acha o 2 m ATIVO pela largura + capacidade (nunca pelo código)', () => {
      const t = buildPriceTwins([
        // catálogo antigo, desativado pela importação: nunca é referência
        { sku: 'HS-2M-10K', family: 'Hidrosilo', brand: 'Pacifil', widthM: 2, capacityL: 10000, netKg: 22.37, active: false },
        { sku: 'HS-3M-10K', family: 'Hidrosilo', brand: 'Pacifil', widthM: 3, capacityL: 10000, netKg: 16.78, active: false },
        // catálogo oficial
        { sku: '18137', family: 'Hidrosilo', brand: 'Pacifil', widthM: 3, capacityL: 10000, netKg: 16.78, active: true },
        { sku: '17308', family: 'Hidrosilo', brand: 'Pacifil', widthM: 2, capacityL: 10000, netKg: 22.37, active: true },
        { sku: '18074', family: 'Hidroforce', brand: 'Pacifil', widthM: 2, capacityL: 10000, netKg: 14.54, active: true },
        { sku: '17640', family: 'Hidrosilo', brand: 'Pacifil', widthM: 2.15, capacityL: 10000, netKg: 30, active: true },
        // 3 m sem capacidade cadastrada (ex.: 19790, 3 × 22 m): sem equivalente
        { sku: '19790', family: 'Hidrosilo', brand: 'Pacifil', widthM: 3, capacityL: null, netKg: 61.51, active: true },
      ])
      expect(t.get('18137')).toEqual({ sku: '17308', netKg: 22.37 })
      // o 3 m antigo (cargas salvas) também passa a usar o 2 m ativo do catálogo oficial
      expect(t.get('HS-3M-10K')).toEqual({ sku: '17308', netKg: 22.37 })
      expect(t.get('19790')).toBeNull()
      // 2 m, 2,15 m e Hidroforce 2 m não entram no mapa
      expect(t.has('17308')).toBe(false)
      expect(t.has('17640')).toBe(false)
      expect(t.has('18074')).toBe(false)
      // preço do 3 m = preço do 2 m (Hidrosilo por kg + fixo)
      const ct: PricingConfig = { ...c, priceTwin: t }
      const p2 = quotePrice(ct, { sku: '17308', familyId: 20, netKg: 22.37 }, 'MX') as { unitUsd: number }
      expect(quotePrice(ct, { sku: '18137', familyId: 20, netKg: 16.78 }, 'MX')).toMatchObject({ ok: true, unitUsd: p2.unitUsd, priceAs: { sku: '17308' } })
    })
  })
  describe('Silo-bolsa: USD/kg por faixa de diâmetro', () => {
    const bands = [
      { key: '5-8', label: '5 a 8 pés', minFt: 5, maxFt: 8 },
      { key: '9-12', label: '9 a 12 pés', minFt: 9, maxFt: 12 },
      { key: '14', label: '14 pés', minFt: 14, maxFt: 14 },
    ]
    it('faixa do diâmetro, limites inclusive; fora das faixas, a de centro mais próximo (empate: a menor)', () => {
      expect(bandFor(bands, 5)).toMatchObject({ band: { key: '5-8' }, nearest: false })
      expect(bandFor(bands, 8)).toMatchObject({ band: { key: '5-8' }, nearest: false })
      expect(bandFor(bands, 9)).toMatchObject({ band: { key: '9-12' }, nearest: false })
      expect(bandFor(bands, 11.5)).toMatchObject({ band: { key: '9-12' }, nearest: false })
      expect(bandFor(bands, 12)).toMatchObject({ band: { key: '9-12' }, nearest: false })
      expect(bandFor(bands, 14)).toMatchObject({ band: { key: '14' }, nearest: false })
      // 8,5: centros 6,5 e 10,5 a 2 pés → empate → a menor
      expect(bandFor(bands, 8.5)).toMatchObject({ band: { key: '5-8' }, nearest: true })
      // 13: centro 14 a 1 pé, 10,5 a 2,5
      expect(bandFor(bands, 13)).toMatchObject({ band: { key: '14' }, nearest: true })
      expect(bandFor(bands, 4)).toMatchObject({ band: { key: '5-8' }, nearest: true })
      expect(bandFor(bands, 16)).toMatchObject({ band: { key: '14' }, nearest: true })
      expect(bandFor([], 9)).toBeNull()
    })
    it('diâmetro do catálogo: campo, depois attrs.diametro_m, depois o nome', () => {
      expect(diameterFtOf({ diameterFt: 9 })).toBe(9)
      expect(diameterFtOf({ attrs: { diametro_m: 3.505 } })).toBe(11.5)
      expect(diameterFtOf({ name: 'Silo-bolsa 10 pés × 60 m × 235 µm' })).toBe(10)
      expect(diameterFtOf({ name: 'Lona 6 × 25 m' })).toBeNull()
    })
    // família 10 = Silo-bolsa (por kg) com faixas; UY = categoria 1 (USD/kg da família 2, que não vale mais para o Silo-bolsa)
    const cb: PricingConfig = {
      ...cfg,
      familyBands: new Map([[10, bands]]),
      bandPrice: new Map([
        [bandPriceKey(10, 1, '5-8'), 2.1],
        [bandPriceKey(10, 1, '9-12'), 2.3],
      ]),
      skuDiameterFt: new Map([
        ['SB-6', 6],
        ['SB-9', 9],
        ['SB-11.5', 11.5],
        ['SB-14', 14],
        ['SB-13', 13],
      ]),
    }
    it('usa o USD/kg da faixa do produto', () => {
      expect(quotePrice(cb, { sku: 'SB-6', familyId: 10, netKg: 100 }, 'UY')).toMatchObject({ ok: true, unitUsd: 210, usdPerKg: 2.1, band: { key: '5-8', nearest: false } })
      expect(quotePrice(cb, { sku: 'sb-9', familyId: 10, netKg: 100 }, 'UY')).toMatchObject({ ok: true, unitUsd: 230, band: { key: '9-12' } })
      expect(quotePrice(cb, { sku: 'SB-11.5', familyId: 10, netKg: 100 }, 'UY')).toMatchObject({ ok: true, unitUsd: 230 })
    })
    it('marca, CIF e agente valem por cima da faixa', () => {
      expect(quotePrice(cb, { sku: 'SB-9', familyId: 10, netKg: 100, brand: 'Ecobag' }, 'UY')).toMatchObject({ unitUsd: 219 })
      expect(quotePrice(withCif(cb, { 10: 0.05 }), { sku: 'SB-9', familyId: 10, netKg: 100 }, 'UY', { incoterm: 'CIF' })).toMatchObject({ unitUsd: 235 })
      // 230 ÷ 0,95 = 242,1 → 243
      expect(quotePrice(cb, { sku: 'SB-9', familyId: 10, netKg: 100 }, 'UY', { agentId: 7 })).toMatchObject({ unitUsd: 243 })
    })
    it('faixa sem USD/kg na categoria, ou produto sem diâmetro: sem preço', () => {
      expect(quotePrice(cb, { sku: 'SB-14', familyId: 10, netKg: 100 }, 'UY')).toMatchObject({ ok: false, reason: expect.stringContaining('14 pés') })
      // 13 pés → faixa 14 (sem preço nesta categoria)
      expect(quotePrice(cb, { sku: 'SB-13', familyId: 10, netKg: 100 }, 'UY')).toMatchObject({ ok: false, reason: expect.stringContaining('14 pés') })
      expect(quotePrice(cb, { sku: 'SB-X', familyId: 10, netKg: 100 }, 'UY')).toMatchObject({ ok: false, reason: expect.stringContaining('diâmetro') })
    })
    it('famílias sem faixas continuam com o USD/kg da família', () => {
      expect(quotePrice(cb, { sku: 'HS', familyId: 20, netKg: 10 }, 'MX')).toMatchObject({ ok: true, unitUsd: 45 })
    })
  })
})
