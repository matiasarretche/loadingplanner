import { describe, expect, it } from 'vitest'
import { customerSearch } from './customerAddress'
import { sortTransportCompanies, SPECIAL_TRANSPORT_LABEL, specialTransportCompany, specialTransportCompanyIds, transportCompanyLabel } from './transportCompany'

const tc = (id: number, code: string, name: string) => ({ id, code, name })

describe('transportadoras do ERP', () => {
  it('rótulo com o código (distingue as filiais com o mesmo nome)', () => {
    expect(transportCompanyLabel({ code: '12', name: 'RAPIDO TRANSPAULO LTDA' })).toBe('RAPIDO TRANSPAULO LTDA · cód. 12')
  })
  it('linhas especiais do ERP', () => {
    const k = (name: string) => specialTransportCompany({ code: '1', name })
    expect([k('DESTINATARIO'), k('Destinatário'), k('A DEFINIR'), k('PROPRIO'), k('PRÓPRIO'), k('TRANSPORTE PROPRIO')]).toEqual(['customer_pickup', 'customer_pickup', 'to_define', 'own', 'own', 'own'])
    expect([k('SEDEX'), k('SEDEX PIN'), k('CORREIOS'), k('PAC CORREIO'), k('CORREIO CARTA REGISTRADA'), k('PAC'), k('CARTA REGISTRADA')]).toEqual(Array(7).fill('postal'))
    // empresas de verdade com palavras parecidas não viram especiais
    expect([k('PLIMOR'), k('TRANSPAC LOGISTICA'), k('PAC LOG TRANSPORTES'), k('EXPRESSO PROPRIO LTDA'), k('CARTAGO TRANSPORTES')]).toEqual([null, null, null, null, null])
    // espaços duplos / pontuação do ERP
    expect(k('  A  DEFINIR ')).toBe('to_define')
    expect(SPECIAL_TRANSPORT_LABEL.customer_pickup).toBe('Retirada pelo cliente (destinatário)')
  })
  it('ids do grupo "Especiais" na ordem: cliente retira, a definir, próprio, correios', () => {
    const list = [tc(1, '81', 'SEDEX'), tc(2, '52', 'PLIMOR'), tc(3, '999', 'A DEFINIR'), tc(4, '64', 'DESTINATARIO'), tc(5, '94', 'PROPRIO'), tc(6, '995', 'DESTINATARIO')]
    expect(specialTransportCompanyIds(list)).toEqual([4, 6, 3, 5, 1])
  })
  it('ordem: nome e, entre filiais, código numérico', () => {
    const list = [tc(1, '182', 'PLIMOR'), tc(2, '52', 'PLIMOR'), tc(3, '7', 'ATLAS'), tc(4, '1000', 'PLIMOR')]
    expect(sortTransportCompanies(list).map((c) => c.code)).toEqual(['7', '52', '182', '1000'])
  })
  it('busca: código exato primeiro, depois o nome', () => {
    const list = [tc(1, '52', 'PLIMOR'), tc(2, '182', 'PLIMOR'), tc(3, '18', 'TRANSPORTES 182 LTDA')]
    expect(customerSearch(list)('182').map((c) => c.id)).toEqual([2, 3])
    expect(customerSearch(list)('plimor').map((c) => c.id)).toEqual([1, 2])
  })
})
