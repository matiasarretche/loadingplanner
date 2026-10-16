/**
 * ENDEREÇO DO CLIENTE: o cadastro guarda o endereço em campos (rua e número, complemento, bairro,
 * código postal, cidade, estado/província, país); a carga e os documentos usam UMA linha de texto.
 * Também o rótulo e a busca do cliente nos seletores (razão social, cidade, país, código do ERP).
 */
import { countryCode, countryNameIn } from '@/lib/countries'

export interface CustomerAddressFields {
  /** rua e número */
  address?: string | null
  addressComplement?: string | null
  /** bairro */
  district?: string | null
  postalCode?: string | null
  city?: string | null
  /** estado / província / departamento */
  state?: string | null
  /** nome oficial em português (canonicalCountry) */
  country?: string | null
}

/** campos do endereço no cadastro (o país fica fora: é o destino usual, não o endereço) */
export const CUSTOMER_ADDRESS_FIELDS = ['address', 'addressComplement', 'district', 'postalCode', 'city', 'state'] as const

/** mesmo limite do endereço livre da carga (placeValue) */
export const CUSTOMER_ADDRESS_MAX = 300

/** países em que o código postal vem DEPOIS da cidade/estado ("Miami, FL 33172"; "Machakos 90100") */
const POSTAL_AFTER = new Set('US PR CA AU NZ GB IE IN PK JP CN TW HK KR PH ID MY SG TH AE IL ZA KE NG BB'.split(' '))

/** minúsculas, sem acento, só letras e números separados por um espaço (para comparar partes) */
const tok = (s: string) =>
  s
    .toLowerCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()

/** parte já presente (palavras inteiras) em outra: "LJ1" em "RUA X,5/LJ1"; "77033" em "HOUSTON TX 77033" */
const within = (hay: string, needle: string) => Boolean(needle) && ` ${tok(hay)} `.includes(` ${tok(needle)} `)

/**
 * Valor de um campo, limpo: espaços únicos, sem vírgula/traço sobrando nas pontas e vazio quando é só
 * marcador do ERP ("." / ".." / "..,.." / "-"): sem nenhuma letra ou número não é dado.
 */
export function addressPart(v: string | null | undefined): string {
  const t = (v ?? '')
    .replace(/\s+/g, ' ')
    .replace(/^[\s,;–—-]+|[\s,;–—-]+$/g, '')
    .trim()
  return /[\p{L}\p{N}]/u.test(t) ? t : ''
}

/**
 * Endereço do cadastro em UMA linha: "rua e número[, complemento], bairro, CEP cidade, estado".
 * Nos países em que o código postal vem depois (EUA, Canadá, Austrália…): "…, cidade, ESTADO CEP".
 * Sem partes vazias nem marcadores, sem repetir o complemento que já está na rua (o ERP grava
 * "RUA X,5/LJ1" e complemento "LJ1"), nem o CEP/estado que já estão na cidade. Cortado em 300 caracteres.
 * `withCountry`: acrescenta o país (no idioma `lang` — pt/es/en —, senão como está no cadastro),
 * a menos que a última parte já seja o país.
 */
export function formatCustomerAddress(c: CustomerAddressFields, opts: { withCountry?: boolean; lang?: string } = {}): string {
  const street = addressPart(c.address)
  const complement = addressPart(c.addressComplement)
  const city = addressPart(c.city)
  const district = addressPart(c.district)
  const postal = addressPart(c.postalCode)
  const state = addressPart(c.state)
  const cc = countryCode(c.country)

  const compl = complement && !within(street, complement) ? complement : ''
  const dist = district && tok(district) !== tok(city) && !within(`${street} ${compl}`, district) ? district : ''
  const zip = postal && !within(`${street} ${city}`, postal) ? postal : ''
  const st = state && !within(`${city} ${dist}`, state) ? state : ''

  const parts = [street, compl, dist]
  if (cc && POSTAL_AFTER.has(cc)) {
    // "Miami, FL 33172" · "Machakos 90100" · "London, SW1A 1AA"
    if (st) parts.push(city, `${st} ${zip}`.trim())
    else parts.push(`${city} ${zip}`.trim())
  } else parts.push(`${zip} ${city}`.trim(), st)

  const out = parts.filter(Boolean)
  const country = addressPart(c.country)
  if (opts.withCountry && country) {
    const last = out[out.length - 1]
    const already = Boolean(last) && (cc ? countryCode(last) === cc : tok(last) === tok(country))
    if (!already) out.push(cc && opts.lang ? countryNameIn(country, opts.lang) : country)
  }
  return out
    .join(', ')
    .slice(0, CUSTOMER_ADDRESS_MAX)
    .replace(/[\s,]+$/, '')
}

// ---------------------------------------------------------------------------
// Seletor de clientes: rótulo e busca
// ---------------------------------------------------------------------------

export interface CustomerSearchFields {
  name: string
  /** código do cliente no ERP */
  code?: string | null
  city?: string | null
  country?: string | null
}

/** "Razão social" + " — Cidade, País · cód. 609" (partes vazias somem) */
export function customerLabelParts(c: CustomerSearchFields): { name: string; detail: string } {
  const place = [addressPart(c.city), addressPart(c.country)].filter(Boolean).join(', ')
  const code = addressPart(c.code)
  return { name: c.name, detail: `${place ? ` — ${place}` : ''}${code ? ` · cód. ${code}` : ''}` }
}

/** "Razão social — Cidade, País · cód. 609" */
export function customerLabel(c: CustomerSearchFields): string {
  const p = customerLabelParts(c)
  return p.name + p.detail
}

/**
 * Busca de clientes por parte do nome, da cidade, do país ou pelo código (sem acento/caixa; todas as
 * palavras digitadas precisam aparecer). Monta o índice uma vez; a função devolvida filtra a cada tecla.
 * Ordem: código exato, nome que começa com o texto, palavra do nome que começa com ele e o resto
 * (cada grupo na ordem recebida — alfabética).
 */
export function customerSearch<T extends CustomerSearchFields>(list: T[]): (query: string) => T[] {
  const index = list.map((c) => ({ c, name: tok(c.name), code: tok(c.code ?? ''), key: ` ${tok(c.name)} ${tok(c.code ?? '')} ${tok(c.city ?? '')} ${tok(c.country ?? '')} ` }))
  return (query: string) => {
    const q = tok(query)
    if (!q) return list
    const words = q.split(' ')
    const rank = (x: (typeof index)[number]) => (x.code === q ? 0 : x.name.startsWith(q) ? 1 : x.name.split(' ').some((w) => w.startsWith(words[0])) ? 2 : 3)
    return index
      .filter((x) => words.every((w) => x.key.includes(w)))
      .map((x) => ({ x, r: rank(x) }))
      .sort((a, b) => a.r - b.r)
      .map(({ x }) => x.c)
  }
}
