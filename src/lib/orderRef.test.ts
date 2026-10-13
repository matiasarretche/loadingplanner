import { describe, expect, it } from 'vitest'
import { autoPlanName, normalizeOrderRef, orderRefFieldLabel, orderRefInitial, orderRefLabel } from './orderRef'

describe('referência do pedido (Proforma)', () => {
  it('exportação: campo "Proforma" já preenchido com a palavra', () => {
    expect(orderRefFieldLabel('EXPORT')).toBe('Proforma')
    expect(orderRefInitial('EXPORT')).toBe('Proforma ')
    expect(orderRefFieldLabel('DOMESTIC')).toBe('Pedido / referência')
    expect(orderRefInitial('DOMESTIC')).toBe('')
  })
  it('só "Proforma" sem número = sem referência', () => {
    expect(normalizeOrderRef('Proforma ')).toBeNull()
    expect(normalizeOrderRef('  ')).toBeNull()
    expect(normalizeOrderRef(' Proforma  1234 ')).toBe('Proforma 1234')
  })
  it('nome automático', () => {
    expect(orderRefLabel('Proforma 1234', 'EXPORT')).toBe('Proforma 1234')
    expect(orderRefLabel('192.26', 'EXPORT')).toBe('Proforma 192.26')
    expect(orderRefLabel('Camión 5', 'DOMESTIC')).toBe('Pedido Camión 5')
    expect(orderRefLabel('Camión 5', 'EXPORT')).toBe('Pedido Camión 5')
    expect(orderRefLabel('Pedido 1', 'EXPORT')).toBe('Pedido 1')
    expect(orderRefLabel('192.26', 'DOMESTIC')).toBe('Pedido 192.26')
    expect(autoPlanName('Proforma 1234', '40GP', 'México', 'EXPORT')).toBe('Proforma 1234 — 40GP')
    expect(autoPlanName('192.26', '40GP', 'México', 'EXPORT')).toBe('Proforma 192.26 — 40GP')
    expect(autoPlanName(null, '40GP', 'México', 'EXPORT')).toBe('40GP México')
  })
})
