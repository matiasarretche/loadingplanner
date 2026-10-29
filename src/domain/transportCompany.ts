/**
 * TRANSPORTADORAS do ERP (código + nome). Nomes repetidos com códigos diferentes são FILIAIS: importadas todas
 * tal qual e vinculadas à carga sempre pelo id/código, nunca pelo nome (que é ambíguo). Algumas linhas do ERP
 * não são empresas e sim situações (cliente retira, a definir, transporte próprio, correios): reconhecidas
 * aqui pelo nome, sem migração.
 */

export type SpecialTransport = 'customer_pickup' | 'to_define' | 'own' | 'postal'

export const SPECIAL_TRANSPORT_LABEL: Record<SpecialTransport, string> = {
  customer_pickup: 'Retirada pelo cliente (destinatário)',
  to_define: 'A definir',
  own: 'Transporte próprio',
  postal: 'Correios',
}

/** ordem do grupo "Especiais" no seletor */
const SPECIAL_ORDER: SpecialTransport[] = ['customer_pickup', 'to_define', 'own', 'postal']

/** "RAPIDO TRANSPAULO LTDA · cód. 12" (o código distingue as filiais com o mesmo nome) */
export function transportCompanyLabel(c: { code: string; name: string }): string {
  return `${c.name} · cód. ${c.code}`
}

/** maiúsculas, sem acento e com um espaço só entre as palavras */
const norm = (s: string) =>
  s
    .toUpperCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^A-Z0-9]+/g, ' ')
    .trim()

/**
 * Linha do ERP que é uma SITUAÇÃO e não uma empresa: DESTINATARIO → cliente retira; A DEFINIR; PROPRIO →
 * transporte próprio; SEDEX / CORREIO(S) / PAC / CARTA (registrada) → correios. Demais: null.
 */
export function specialTransportCompany(c: { code: string; name: string }): SpecialTransport | null {
  const n = norm(c.name)
  if (/^DESTINATARIO\b/.test(n)) return 'customer_pickup'
  if (/^A DEFINIR\b/.test(n)) return 'to_define'
  if (/^((TRANSPORTE|VEICULO|FROTA) )?PROPRI[OA]$/.test(n)) return 'own'
  if (/\b(SEDEX|CORREIOS?)\b/.test(n) || /^(PAC|CARTA|CARTA REGISTRADA)$/.test(n)) return 'postal'
  return null
}

/** ids das linhas especiais (para o grupo "Especiais" do seletor), na ordem: cliente retira, a definir, próprio, correios */
export function specialTransportCompanyIds<T extends { id: number; code: string; name: string }>(list: T[]): number[] {
  const kinds = list.map((c) => ({ id: c.id, k: specialTransportCompany(c) }))
  return SPECIAL_ORDER.flatMap((k) => kinds.filter((x) => x.k === k).map((x) => x.id))
}

/** ordem da lista: nome (alfabética, sem diferenciar acento/caixa) e, entre filiais com o mesmo nome, código numérico */
export function sortTransportCompanies<T extends { code: string; name: string }>(list: T[]): T[] {
  return [...list].sort((a, b) => a.name.localeCompare(b.name, 'pt-BR', { sensitivity: 'base' }) || a.code.localeCompare(b.code, 'pt-BR', { numeric: true }))
}
