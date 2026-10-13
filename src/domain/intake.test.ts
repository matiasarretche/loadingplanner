import { describe, expect, it } from 'vitest'
import { customerInText, equipmentCodeInText, modeInText, IntakeDraft, matchCustomer, missingForCreate, normName, unitsFor, serviceInText } from './intake'

const base: IntakeDraft = {
  area: 'EXPORT',
  customerId: 3,
  newCustomer: '',
  country: 'Nicarágua',
  mode: 'SEA',
  incoterm: 'FCA',
  equipment: 'CONTAINER:2',
  orderRef: '',
  notes: '',
  lines: [{ sku: 'SB-9-60', quantity: 10, unit: 'UNIT', sourceText: 'x' }],
}

describe('missingForCreate', () => {
  it('nada falta com tudo informado', () => expect(missingForCreate(base)).toEqual([]))
  it('pergunta só o que falta (sem assumir modalidade, Incoterm, equipamento)', () => {
    const m = missingForCreate({ ...base, mode: '', incoterm: '', equipment: '', country: ' ' })
    expect(m).toEqual(['País de destino', 'Tipo de envio', 'Incoterm', 'Equipamento'])
  })
  it('envio sem equipamento (LCL, courier…) não pede equipamento', () => {
    expect(missingForCreate({ ...base, mode: 'LCL', equipment: '' })).not.toContain('Equipamento')
    expect(missingForCreate({ ...base, mode: 'FCL', equipment: '' })).toContain('Equipamento')
  })
  it('linhas sem produto, quantidade ou unidade definida', () => {
    const m = missingForCreate({ ...base, lines: [{ sku: null, quantity: null, unit: 'OTHER', sourceText: '' }] })
    expect(m).toEqual(['Linha 1: produto do catálogo', 'Linha 1: quantidade', 'Linha 1: unidade da quantidade'])
  })
  it('cliente: cadastrado ou nome novo', () => {
    expect(missingForCreate({ ...base, customerId: null })).toContain('Cliente')
    expect(missingForCreate({ ...base, customerId: null, newCustomer: 'Agro SA' })).not.toContain('Cliente')
  })
})

describe('unitsFor', () => {
  const pack = { unitsPerPackage: 2, netKg: 100 }
  it('unidades, caixas e paletes', () => {
    expect(unitsFor(7, 'UNIT', pack)).toEqual({ units: 7 })
    expect(unitsFor(3, 'BOX', pack)).toEqual({ units: 6 })
    expect(unitsFor(2, 'PALLET', pack)).toEqual({ pallets: 2 })
  })
  it('kg → unidades pelo peso líquido por unidade (arredonda para cima)', () => {
    const r = unitsFor(1010, 'KG', pack) // 50 kg/un.
    expect('units' in r && r.units).toBe(21)
  })
  it('sem peso líquido não converte kg; OTHER pede definição', () => {
    expect(unitsFor(10, 'KG', { unitsPerPackage: 1, netKg: 0 })).toHaveProperty('error')
    expect(unitsFor(10, 'OTHER', pack)).toHaveProperty('error')
  })
})

describe('clientes e equipamento', () => {
  const cs = [
    { id: 1, name: 'Agropecuaria El Sol S.A.' },
    { id: 2, name: 'Alema Farms' },
    { id: 3, name: 'Sol Agro' },
  ]
  it('normaliza razão social', () => expect(normName('Agropecuária El Sol, S.A.')).toBe('agropecuaria el sol'))
  it('igual após normalizar → cadastrado; parecidos para conferir', () => {
    expect(matchCustomer('AGROPECUARIA EL SOL SA', cs).matchedId).toBe(1)
    const r = matchCustomer('Alema Koudijs Feed', cs)
    expect(r.matchedId).toBeNull()
    expect(r.similar.map((x) => x.id)).toEqual([2])
  })
  it('equipamento só quando explícito', () => {
    expect(equipmentCodeInText("1x40HC")).toBe('40HC')
    expect(equipmentCodeInText('contenedor de 20')).toBe('20GP')
    expect(equipmentCodeInText("2 x 40' dry")).toBe('40GP')
    expect(equipmentCodeInText('20 rollos de 40 metros')).toBeNull()
  })
})

describe('atalho de IA: cliente e modalidade citados no texto', () => {
  const cs = [
    { id: 1, name: 'Danilo' },
    { id: 2, name: 'Jesús Magaña - Agromai' },
    { id: 3, name: 'Agro Uruguay S.A.' },
  ]
  it('cliente pelo nome (sem acento/caixa) ou por uma palavra do nome', () => {
    expect(customerInText('camion completo para Danilo, de 9x60-210 probag', cs)).toBe(1)
    expect(customerInText('40HC para AGROMAI', cs)).toBe(2)
    expect(customerInText('contenedor para Jesus Magaña', cs)).toBe(2)
  })
  it('palavras genéricas não identificam cliente', () => {
    expect(customerInText('camión completo de silo bolsa para Uruguay', cs)).toBeNull()
  })
  it('modalidade explícita', () => {
    expect(modeInText('camión completo para Danilo')).toBe('ROAD')
    expect(modeInText('Monte um 40 HC 100% com Hidrosilo')).toBe('SEA')
    expect(modeInText('envio aéreo de 2 paletes')).toBe('AIR')
    expect(modeInText('9x60-210 probag')).toBeNull()
  })
})

describe('serviceInText: caminhão consolidado', () => {
  it('rodoviário consolidado / fracionado / LTL → ROAD_LTL; consolidado sem caminhão continua LCL', () => {
    expect(serviceInText('enviar por camión consolidado a Asunción')).toBe('ROAD_LTL')
    expect(serviceInText('carga fracionada rodoviária para Montevidéu')).toBe('ROAD_LTL')
    expect(serviceInText('LTL to Santiago')).toBe('ROAD_LTL')
    expect(serviceInText('caminhão completo para Montevidéu')).toBe('ROAD')
    expect(serviceInText('embarque consolidado LCL a Callao')).toBe('LCL')
    expect(serviceInText('carga consolidada marítima')).toBe('LCL')
    // texto marítimo que cita o caminhão da coleta continua LCL
    expect(serviceInText('LCL consolidado, retiro en camión en la fábrica')).toBe('LCL')
    expect(serviceInText('carga consolidada marítima, flete terrestre incluido')).toBe('LCL')
  })
})
