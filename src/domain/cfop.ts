/**
 * CFOP (Código Fiscal de Operações e Prestações) do PEDIDO: digitado à mão ao criar a carga (ex.: 7.101) e
 * editável depois; vale para todas as unidades do pedido (shipment.cfop). Uso INTERNO/FISCAL: nunca sai nos
 * PDFs para o cliente. Gravado sempre no formato "N.NNN".
 *
 * Validação: o FORMATO bloqueia (4 dígitos, 1º de 1 a 7); a ÁREA só avisa — há casos legítimos fora do padrão
 * (ex.: exportação indireta, venda a uma trading no Brasil, usa 5.501/6.501 mesmo na área Exportação).
 */

export type CfopArea = 'EXPORT' | 'DOMESTIC'

/** exemplo para o campo (exportação de produção própria) */
export const CFOP_PLACEHOLDER = '7.101'

const CFOP_RE = /^[1-7]\.\d{3}$/

/**
 * '7101' | '7.101' | ' 7.101 ' | '7,101' → '7.101'; vazio → null. Texto que não é um CFOP de 4 dígitos volta
 * só aparado (cfopError acusa o formato).
 */
export function normalizeCfop(raw: string | null | undefined): string | null {
  const t = String(raw ?? '').trim()
  if (!t) return null
  const digits = t.replace(/[\s.,-]/g, '')
  return /^\d{4}$/.test(digits) ? `${digits[0]}.${digits.slice(1)}` : t
}

/** Erro de formato (bloqueia) ou null. Vazio (null) é válido: o CFOP é opcional. */
export function cfopError(code: string | null): string | null {
  if (code == null || code === '') return null
  return CFOP_RE.test(code) ? null : 'CFOP inválido: use 4 dígitos, ex.: 7.101'
}

/**
 * Aviso (nunca bloqueia) quando o CFOP não combina com a área do pedido: Exportação sem 7.xxx; Mercado
 * Interno com 7.xxx (ou com um CFOP de entrada, 1.xxx–3.xxx). CFOP vazio ou inválido: null (o erro é de cfopError).
 */
export function cfopAreaWarning(code: string | null, area: CfopArea): string | null {
  if (!code || cfopError(code)) return null
  const first = code[0]
  if (area === 'EXPORT' && first !== '7') return `CFOP ${code} não é de exportação (7.xxx). Confira — exportação indireta (ex.: 5.501/6.501) é possível.`
  if (area === 'DOMESTIC' && first === '7') return `CFOP ${code} é de exportação: no Mercado Interno use 5.xxx (dentro do RS) ou 6.xxx (outros estados).`
  if (area === 'DOMESTIC' && first <= '3') return `CFOP ${code} é de entrada (1.xxx–3.xxx): numa venda use 5.xxx ou 6.xxx.`
  return null
}
