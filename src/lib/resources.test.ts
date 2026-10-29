import { describe, expect, it } from 'vitest'
import { isEmail, listRows, parseFields, RESOURCES, splitEmails } from './resources'

const fd = (o: Record<string, string>) => {
  const f = new FormData()
  for (const [k, v] of Object.entries(o)) f.set(k, v)
  return f
}

describe('cadastros: e-mail', () => {
  it('aceita um endereço e recusa lista, espaço ou domínio sem extensão', () => {
    expect(isEmail('compras@agro.com.uy')).toBe(true)
    expect(isEmail('j.perez+pedidos@empresa.co')).toBe(true)
    expect(isEmail('compras@agro')).toBe(false)
    expect(isEmail('compras agro@x.com')).toBe(false)
    expect(isEmail('a@x.com; b@y.com')).toBe(false)
    expect(isEmail('a@x.com,b@y.com')).toBe(false)
    expect(isEmail('@x.com')).toBe(false)
  })

  it('cliente: grupo Contato (nome, e-mail validado, telefone), todos opcionais', () => {
    const fields = RESOURCES.clientes.fields
    expect(fields.filter((f) => f.group === 'Contato').map((f) => f.name)).toEqual(['contactName', 'contactEmail', 'contactPhone'])
    const ok = parseFields(fields, fd({ name: 'Green Bag America', contactName: ' Jesús Magaña ', contactEmail: 'jesus@greenbag.com', contactPhone: '+1 512 555 0100' }))
    expect(ok.errors).toEqual({})
    expect(ok.data).toMatchObject({ contactName: 'Jesús Magaña', contactEmail: 'jesus@greenbag.com', contactPhone: '+1 512 555 0100' })
    const empty = parseFields(fields, fd({ name: 'Cliente sem contato' }))
    expect(empty.errors).toEqual({})
    expect(empty.data).toMatchObject({ contactName: null, contactEmail: null, contactPhone: null })
    expect(parseFields(fields, fd({ name: 'X', contactEmail: 'jesus@greenbag' })).errors.contactEmail).toMatch(/E-mail inválido/)
  })

  it('vários endereços (";" ou ","; "/" ou espaço dos cadastros antigos): valida cada um e grava "a; b"', () => {
    expect(splitEmails(' a@x.com ;b@y.com, c@z.com.br / d@w.co ')).toEqual({ emails: ['a@x.com', 'b@y.com', 'c@z.com.br', 'd@w.co'], invalid: [] })
    expect(splitEmails('compras agro@x.com').invalid).toEqual(['compras'])
    for (const [res, name] of [
      [RESOURCES.transportadoras, 'email'],
      [RESOURCES.clientes, 'contactEmail'],
    ] as const) {
      const base = { code: '348', name: 'HALLMAQ MAQUINAS E EQUIPAMENTOS LTDA' }
      for (const v of ['logistica@x.com; comercial@x.com', 'logistica@x.com,comercial@x.com', 'logistica@x.com / comercial@x.com']) {
        const r = parseFields(res.fields, fd({ ...base, [name]: v }))
        expect(r.errors).toEqual({})
        expect(r.data[name]).toBe('logistica@x.com; comercial@x.com')
      }
      expect(parseFields(res.fields, fd({ ...base, [name]: 'unico@x.com' })).data[name]).toBe('unico@x.com')
      // um endereço inválido na lista bloqueia e aparece na mensagem
      expect(parseFields(res.fields, fd({ ...base, [name]: 'logistica@x.com; comercial@x' })).errors[name]).toBe('E-mail inválido: “comercial@x” (ex.: nome@empresa.com; outro@empresa.com)')
      expect(parseFields(res.fields, fd({ ...base, [name]: ' ; , ' })).errors[name]).toBe('E-mail inválido (ex.: nome@empresa.com; outro@empresa.com)')
    }
  })
})

describe('cadastros: lista (ordem e busca)', () => {
  const t = RESOURCES.transportadoras
  const rows = [
    { id: 1, code: '100', name: 'PLIMOR LTDA', notes: null, active: true },
    { id: 2, code: '2', name: 'FEDEX', notes: null, active: true },
    { id: 3, code: '12', name: 'RAPIDO TRANSPAULO LTDA', notes: 'filial Caxias do Sul', active: true },
    { id: 4, code: '999', name: 'A DEFINIR', notes: null, active: true },
    { id: 5, code: '64', name: 'DESTINATÁRIO', notes: null, active: false },
  ]

  it('transportadoras: código do ERP em ordem numérica (2, 12, 64, 100, 999)', () => {
    expect(listRows(rows, { fields: t.fields, orderBy: t.orderBy, numericOrder: t.numericOrder }).map((r) => r.code)).toEqual(['2', '12', '64', '100', '999'])
  })

  it('busca sem acento/maiúsculas, por código, nome ou observações; todas as palavras', () => {
    const q = (s: string) => listRows(rows, { fields: t.fields, orderBy: t.orderBy, numericOrder: true, q: s }).map((r) => r.id)
    expect(q('destinatario')).toEqual([5])
    expect(q('999')).toEqual([4])
    expect(q('rapido caxias')).toEqual([3])
    expect(q('ltda')).toEqual([3, 1])
    expect(q('  ')).toEqual([2, 3, 5, 1, 4])
    expect(q('inexistente')).toEqual([])
  })

  it('sem numericOrder: mantém a ordem recebida (a do banco)', () => {
    expect(listRows(rows, { fields: t.fields, orderBy: 'code' }).map((r) => r.id)).toEqual([1, 2, 3, 4, 5])
  })
})
