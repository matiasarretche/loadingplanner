import { describe, expect, it } from 'vitest'
import {
  carrierDiffers,
  CFOP_CONFLICT_ERROR,
  cfopConflict,
  cfopEdit,
  commercialDiffers,
  confirmWarnings,
  inactiveCarrierToSiblingsError,
  siblingCommercialChanges,
  termsDiffer,
  type ConfirmCommercial,
} from './confirmCommercial'

const base: ConfirmCommercial = {
  paymentTerms: '30% antecipado e 70% contra cópia dos documentos de embarque (BL)',
  showPaymentTerms: true,
  cfop: '7.101',
  transportCompany: { code: '12', name: 'RAPIDO TRANSPAULO LTDA' },
  siblingsDiffer: false,
}

describe('confirmWarnings (avisos do Confirmar pedido, nunca bloqueiam)', () => {
  it('tudo preenchido: sem avisos', () => {
    expect(confirmWarnings(base, true)).toEqual([])
  })

  it('faltando condição, CFOP e transportadora', () => {
    const w = confirmWarnings({ ...base, paymentTerms: null, cfop: null, transportCompany: null }, false)
    expect(w).toEqual(['Condição de pagamento não definida.', 'CFOP não informado.', 'Transportadora não definida.'])
  })

  it('quem não vê preços não recebe aviso da condição', () => {
    expect(confirmWarnings({ ...base, paymentTerms: null, showPaymentTerms: false }, false)).toEqual([])
  })

  it('transportadora "A DEFINIR" do ERP avisa', () => {
    const w = confirmWarnings({ ...base, transportCompany: { code: '999', name: 'A DEFINIR' } }, false)
    expect(w).toEqual(['Transportadora ainda “A definir”.'])
  })

  it('DESTINATARIO (cliente retira) não é aviso', () => {
    expect(confirmWarnings({ ...base, transportCompany: { code: '64', name: 'DESTINATARIO' } }, false)).toEqual([])
  })

  it('CFOP fora de 7.xxx numa exportação avisa (sem bloquear)', () => {
    const w = confirmWarnings({ ...base, cfop: '5.501' }, false)
    expect(w).toHaveLength(1)
    expect(w[0]).toContain('5.501')
  })

  it('outras unidades diferentes: só avisa se forem confirmadas junto', () => {
    expect(confirmWarnings({ ...base, siblingsDiffer: true }, false)).toEqual([])
    expect(confirmWarnings({ ...base, siblingsDiffer: true }, true)).toHaveLength(1)
  })
})

describe('commercialDiffers', () => {
  const terms = { advancePct: 30, balanceWhen: 'AGAINST_DOCS' as const, days: null, note: null }
  const plan = { transportCompanyId: 5, paymentTerms: terms }

  it('iguais (inclusive campos opcionais ausentes x null)', () => {
    expect(commercialDiffers(plan, [{ transportCompanyId: 5, paymentTerms: { advancePct: 30, balanceWhen: 'AGAINST_DOCS' } }])).toBe(false)
    expect(commercialDiffers(plan, [])).toBe(false)
  })

  it('transportadora ou condição diferente', () => {
    expect(commercialDiffers(plan, [{ transportCompanyId: 6, paymentTerms: terms }])).toBe(true)
    expect(commercialDiffers(plan, [{ transportCompanyId: 5, paymentTerms: null }])).toBe(true)
    expect(commercialDiffers(plan, [{ transportCompanyId: 5, paymentTerms: { ...terms, advancePct: 50 } }])).toBe(true)
  })

  it('100% antecipado ignora o "quando" do saldo', () => {
    const full = { transportCompanyId: null, paymentTerms: { advancePct: 100, balanceWhen: null } }
    expect(commercialDiffers(full, [{ transportCompanyId: null, paymentTerms: { advancePct: 100, balanceWhen: 'ON_ARRIVAL' } }])).toBe(false)
  })
})

describe('carrierDiffers / termsDiffer (avisos do painel da carga)', () => {
  const terms = { advancePct: 30, balanceWhen: 'AGAINST_DOCS' as const, days: null, note: null }
  const plan = { transportCompanyId: 5, paymentTerms: terms }

  it('separa transportadora de condição', () => {
    const other = [{ transportCompanyId: 6, paymentTerms: { advancePct: 30, balanceWhen: 'AGAINST_DOCS' as const } }]
    expect(carrierDiffers(plan, other)).toBe(true)
    expect(termsDiffer(plan, other)).toBe(false)
    const other2 = [{ transportCompanyId: 5, paymentTerms: { ...terms, advancePct: 50 } }]
    expect(carrierDiffers(plan, other2)).toBe(false)
    expect(termsDiffer(plan, other2)).toBe(true)
  })

  it('sem outras unidades: nada difere', () => {
    expect(carrierDiffers(plan, [])).toBe(false)
    expect(termsDiffer(plan, [])).toBe(false)
  })
})

describe('siblingCommercialChanges (o que o Salvar do painel leva às outras unidades)', () => {
  const x = { advancePct: 30, balanceWhen: 'AGAINST_DOCS' as const, days: null, note: null }
  const y = { advancePct: 100, balanceWhen: null, days: null, note: null }
  const next = { transportCompanyId: 5, paymentTerms: x }
  const sibs = [
    { id: 2, transportCompanyId: 7, paymentTerms: x },
    { id: 3, transportCompanyId: 5, paymentTerms: y },
    { id: 4, transportCompanyId: 5, paymentTerms: { advancePct: 30, balanceWhen: 'AGAINST_DOCS' as const } },
  ]

  it('Exportação sem a caixa: a condição vai SEMPRE; a transportadora das outras fica como está', () => {
    const c = siblingCommercialChanges(next, sibs, { exportArea: true, applyCarrier: false })
    expect(c.map((s) => [s.sibling.id, s.carrier, s.terms])).toEqual([[3, false, true]])
  })

  it('Exportação com a caixa: transportadora e condição, só onde algo muda', () => {
    const c = siblingCommercialChanges(next, sibs, { exportArea: true, applyCarrier: true })
    expect(c.map((s) => [s.sibling.id, s.carrier, s.terms])).toEqual([
      [2, true, false],
      [3, false, true],
    ])
  })

  it('Mercado Interno: a condição nunca muda; sem a caixa, nada muda nas outras', () => {
    expect(siblingCommercialChanges(next, sibs, { exportArea: false, applyCarrier: false })).toEqual([])
    const c = siblingCommercialChanges(next, sibs, { exportArea: false, applyCarrier: true })
    expect(c.map((s) => [s.sibling.id, s.carrier, s.terms])).toEqual([[2, true, false]])
  })

  it('"a definir" (null) também é levada com a caixa', () => {
    const c = siblingCommercialChanges({ transportCompanyId: null, paymentTerms: x }, sibs, { exportArea: false, applyCarrier: true })
    expect(c.map((s) => s.sibling.id)).toEqual([2, 3, 4])
  })
})

describe('inactiveCarrierToSiblingsError (transportadora inativa não vai para outras unidades)', () => {
  const sib = { id: 2, transportCompanyId: 7, paymentTerms: null }

  it('inativa levada a outra unidade: recusa', () => {
    const e = inactiveCarrierToSiblingsError([{ sibling: sib, carrier: true, terms: false }], { active: false, label: '12 — VELHA LTDA' })
    expect(e).toContain('12 — VELHA LTDA')
    expect(e).toContain('inativa')
  })

  it('inativa que só fica nesta carga (as outras só recebem a condição): ok', () => {
    expect(inactiveCarrierToSiblingsError([{ sibling: sib, carrier: false, terms: true }], { active: false, label: 'X' })).toBeNull()
    expect(inactiveCarrierToSiblingsError([], { active: false, label: 'X' })).toBeNull()
  })

  it('ativa ou sem transportadora: ok', () => {
    expect(inactiveCarrierToSiblingsError([{ sibling: sib, carrier: true, terms: false }], { active: true, label: 'X' })).toBeNull()
    expect(inactiveCarrierToSiblingsError([{ sibling: sib, carrier: true, terms: false }], null)).toBeNull()
  })
})

describe('CFOP do pedido pelo painel: só se editado, e sem pisar a mudança de outra pessoa', () => {
  it('cfopEdit: sem alteração não envia nada', () => {
    expect(cfopEdit('7.101', '7.101')).toBeNull()
    expect(cfopEdit('7101', '7.101')).toBeNull()
    expect(cfopEdit(' ', null)).toBeNull()
  })

  it('cfopEdit: alterado ou apagado envia o novo e o carregado', () => {
    expect(cfopEdit('7101', null)).toEqual({ cfop: '7.101', cfopExpected: null })
    expect(cfopEdit('', '7.101')).toEqual({ cfop: null, cfopExpected: '7.101' })
    expect(cfopEdit('7.501', '7.101')).toEqual({ cfop: '7.501', cfopExpected: '7.101' })
  })

  it('cfopConflict: gravado igual ao carregado → grava', () => {
    expect(cfopConflict('7.101', '7.101', '7.501')).toBe(false)
    expect(cfopConflict(null, null, '7.101')).toBe(false)
  })

  it('cfopConflict: outra pessoa mudou depois que o painel carregou → recusa', () => {
    expect(cfopConflict('7.101', null, null)).toBe(true)
    expect(cfopConflict('7.501', '7.101', '7.102')).toBe(true)
    expect(cfopConflict(null, '7.101', '7.102')).toBe(true)
    expect(CFOP_CONFLICT_ERROR).toBe('O CFOP do pedido foi alterado por outra pessoa — recarregue a página.')
  })

  it('cfopConflict: o gravado já é o valor novo → nada a mudar, sem erro', () => {
    expect(cfopConflict('7.101', null, '7.101')).toBe(false)
  })
})
