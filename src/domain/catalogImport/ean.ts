/**
 * EAN / GTIN da planilha oficial: guardado SEMPRE como texto, exatamente como veio, com um estado de
 * validade. A planilha traz EAN-13 da unidade e, nos pacotes "C/ n UN", o GTIN-14 (DUN-14) da caixa.
 */
import type { EanStatus } from './types'

/** prefixo da empresa (GS1 Brasil) usado em todos os EAN válidos da planilha */
export const PACIFIL_GS1_PREFIX = '7898557'
/** prefixo digitado errado em alguns EAN (dígito verificador não fecha) */
const WRONG_PREFIX = '7898558'

/** Dígito verificador GS1 (EAN-8/12/13, GTIN-14) do corpo sem o dígito. */
export function gtinCheckDigit(body: string): number {
  let s = 0
  let w = 3
  for (let i = body.length - 1; i >= 0; i--) {
    s += Number(body[i]) * w
    w = w === 3 ? 1 : 3
  }
  return (10 - (s % 10)) % 10
}

const checkOk = (e: string) => gtinCheckDigit(e.slice(0, -1)) === Number(e.slice(-1))

/**
 * Estado do código de barras: EAN13 (EAN-13 válido), GTIN14 (GTIN-14/DUN-14 válido — código da caixa,
 * não da unidade) ou INVALID (com o motivo). Vazio → status null (sem EAN).
 */
export function eanStatusOf(ean: string | null | undefined): { status: EanStatus | null; note: string | null } {
  const e = String(ean ?? '').trim()
  if (!e) return { status: null, note: null }
  if (!/^\d+$/.test(e)) return { status: 'INVALID', note: 'contém caracteres que não são dígitos' }
  const len = e.length
  if (len === 13) {
    if (checkOk(e)) return { status: 'EAN13', note: null }
    const expected = e.slice(0, -1) + gtinCheckDigit(e.slice(0, -1))
    let note = `dígito verificador errado (esperado ${expected})`
    if (e.startsWith(WRONG_PREFIX)) {
      const fixed = PACIFIL_GS1_PREFIX + e.slice(WRONG_PREFIX.length)
      note += `; prefixo ${WRONG_PREFIX} em vez de ${PACIFIL_GS1_PREFIX}: com ${PACIFIL_GS1_PREFIX} seria ${fixed}${checkOk(fixed) ? ' (válido)' : ' (ainda inválido)'} — não corrigido`
    }
    return { status: 'INVALID', note }
  }
  if (len === 14) {
    if (checkOk(e)) return { status: 'GTIN14', note: 'GTIN-14 (DUN-14): código da caixa, não o EAN da unidade' }
    return { status: 'INVALID', note: `dígito verificador errado (esperado ${e.slice(0, -1) + gtinCheckDigit(e.slice(0, -1))})` }
  }
  return { status: 'INVALID', note: `${len} dígitos` }
}
