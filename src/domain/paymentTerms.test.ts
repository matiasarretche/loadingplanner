import { describe, expect, it } from 'vitest'
import { checkPaymentTerms, normalizePaymentTerms, parseMoney, paymentTermsErrors, paymentTermsFromAi, paymentTermsText } from './paymentTerms'
import { proformaTotals } from './pricing'

describe('condições de pagamento (no idioma do PDF)', () => {
  it('100% antecipado', () => {
    const t = { advancePct: 100, balanceWhen: null }
    expect([paymentTermsText(t, 'pt'), paymentTermsText(t, 'es'), paymentTermsText(t, 'en')]).toEqual(['100% antecipado', '100% anticipado', '100% advance payment'])
  })
  it('30% anticipo y 70% antes del embarque', () => {
    const t = { advancePct: 30, balanceWhen: 'BEFORE_SHIPMENT' as const }
    expect(paymentTermsText(t, 'es')).toBe('30% de anticipo y 70% antes del embarque')
    expect(paymentTermsText(t, 'pt')).toBe('30% antecipado e 70% antes do embarque')
    expect(paymentTermsText(t, 'en')).toBe('30% advance payment and 70% before shipment')
  })
  it('saldo a N dias e nota livre', () => {
    const t = { advancePct: 0, balanceWhen: 'DAYS_AFTER_SHIPMENT' as const, days: 60, note: 'Banco: Itaú' }
    expect(paymentTermsText(t, 'es')).toBe('100% a 60 días de la fecha de embarque. Banco: Itaú')
  })
  it('validação', () => {
    expect(paymentTermsErrors({ advancePct: 30, balanceWhen: null })).not.toEqual([])
    expect(paymentTermsErrors({ advancePct: 30, balanceWhen: 'DAYS_AFTER_INVOICE', days: null })).not.toEqual([])
    expect(paymentTermsErrors({ advancePct: 120, balanceWhen: null })).not.toEqual([])
    expect(paymentTermsErrors({ advancePct: 30, balanceWhen: 'AGAINST_DOCS' })).toEqual([])
    expect(paymentTermsErrors({ advancePct: 30, balanceWhen: 'XYZ' as never })).not.toEqual([])
    expect(paymentTermsText({ advancePct: 30, balanceWhen: 'XYZ' as never, note: 'só a nota' }, 'pt')).toBe('só a nota')
  })
})

describe('valores em USD digitados', () => {
  it('ponto de milhar e vírgula decimal', () => {
    expect([parseMoney('3.200'), parseMoney('3.200,50'), parseMoney('1,5'), parseMoney('3200'), parseMoney('USD 1.800'), parseMoney(''), parseMoney('12.345.678'), parseMoney('2350,00')]).toEqual([3200, 3200.5, 1.5, 3200, 1800, null, 12345678, 2350])
    // formato inglês é recusado (não vira 2,35)
    expect(parseMoney('2,350.00')).toBeNaN()
    expect(parseMoney('3200.5')).toBeNaN()
    expect(parseMoney('abc')).toBeNaN()
  })
})

describe('proforma: frete e seguro somados uma única vez', () => {
  it('total = mercadoria + frete + seguro', () => {
    expect(proformaTotals(10000, 1500, 120)).toMatchObject({ goodsUsd: 10000, freightUsd: 1500, insuranceUsd: 120, totalUsd: 11620 })
    expect(proformaTotals(10000, null, null)).toMatchObject({ totalUsd: 10000 })
    expect(proformaTotals(null, null, null)).toMatchObject({ totalUsd: null })
    expect(proformaTotals(null, 1500, 0)).toMatchObject({ totalUsd: null })
  })
})

describe('condição normalizada (mesma forma em todos os caminhos)', () => {
  it('100% antecipado: sem saldo nem dias; nota aparada', () => {
    expect(normalizePaymentTerms({ advancePct: '100', balanceWhen: 'AGAINST_DOCS', days: '30', note: '  ' })).toEqual({ advancePct: 100, balanceWhen: null, days: null, note: null })
  })
  it('vírgula decimal, dias só em "a N dias"', () => {
    expect(normalizePaymentTerms({ advancePct: '12,5', balanceWhen: 'AGAINST_DOCS', days: 30 })).toEqual({ advancePct: 12.5, balanceWhen: 'AGAINST_DOCS', days: null, note: null })
    expect(normalizePaymentTerms({ advancePct: 30, balanceWhen: 'DAYS_AFTER_INVOICE', days: '60', note: ' Banco Itaú ' })).toEqual({ advancePct: 30, balanceWhen: 'DAYS_AFTER_INVOICE', days: 60, note: 'Banco Itaú' })
  })
  it('ausente → null; inválida passa adiante para ser acusada', () => {
    expect([normalizePaymentTerms(null), normalizePaymentTerms(undefined), normalizePaymentTerms('x')]).toEqual([null, null, null])
    expect(checkPaymentTerms(null)).toEqual({ ok: true, terms: null })
    expect(checkPaymentTerms({ advancePct: '', balanceWhen: 'BEFORE_SHIPMENT' })).toMatchObject({ ok: false })
    expect(checkPaymentTerms({ advancePct: 30, balanceWhen: 'XYZ' })).toMatchObject({ ok: false })
    expect(checkPaymentTerms({ advancePct: 30, balanceWhen: 'DAYS_AFTER_SHIPMENT', days: '' })).toMatchObject({ ok: false })
    expect(checkPaymentTerms({ advancePct: 30, balanceWhen: 'AGAINST_DOCS' })).toEqual({ ok: true, terms: { advancePct: 30, balanceWhen: 'AGAINST_DOCS', days: null, note: null } })
  })
  it('saída da IA', () => {
    expect(paymentTermsFromAi({ advance_pct: 30, balance_when: 'AGAINST_DOCS' })).toEqual({ advancePct: 30, balanceWhen: 'AGAINST_DOCS', days: null, note: null })
    expect(paymentTermsFromAi({ advance_pct: 0, balance_when: 'DAYS_AFTER_SHIPMENT', days: 60.4 })).toEqual({ advancePct: 0, balanceWhen: 'DAYS_AFTER_SHIPMENT', days: 60, note: null })
    expect(paymentTermsFromAi({ advance_pct: 100, balance_when: 'INVENTADO' })).toEqual({ advancePct: 100, balanceWhen: null, days: null, note: null })
    expect(paymentTermsFromAi({ balance_when: 'AGAINST_DOCS' })).toBeNull()
    expect(paymentTermsFromAi(null)).toBeNull()
  })
})
