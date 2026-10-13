/**
 * Referência do pedido. Na EXPORTAÇÃO o campo se chama "Proforma" e já vem com a palavra "Proforma "
 * para só completar o número; no mercado interno continua "Pedido / referência".
 */
import type { Area } from './areas'

export const PROFORMA_PREFIX = 'Proforma '

export const orderRefFieldLabel = (area: Area | string | null | undefined) => (area === 'EXPORT' ? 'Proforma' : 'Pedido / referência')

/** valor inicial do campo: "Proforma " na exportação, vazio no mercado interno */
export const orderRefInitial = (area: Area | string | null | undefined) => (area === 'EXPORT' ? PROFORMA_PREFIX : '')

/** só a palavra "Proforma" (sem número) ou vazio = sem referência */
export function normalizeOrderRef(v: string | null | undefined): string | null {
  const t = (v ?? '').trim().replace(/\s+/g, ' ')
  return !t || /^proforma$/i.test(t) ? null : t.slice(0, 80)
}

/**
 * Como a referência aparece em nomes e textos: na EXPORTAÇÃO, número de proforma = "Proforma 192.26"
 * (sem repetir a palavra); texto do pedido do cliente ("Camión 5", "Pedido 1") e mercado interno = "Pedido …".
 */
export function orderRefLabel(ref: string, area: Area | string | null | undefined): string {
  const r = ref.replace(/^(pedido|proforma)\s+/i, '')
  const proforma = area === 'EXPORT' && (/^proforma\b/i.test(ref) || (/^\d/.test(r) && !/^pedido\b/i.test(ref)))
  return `${proforma ? 'Proforma' : 'Pedido'} ${r}`
}

/** nome automático da carga */
export const autoPlanName = (ref: string | null, spaceCode: string, country: string, area: Area | string | null | undefined) => (ref ? `${orderRefLabel(ref, area)} — ${spaceCode}` : `${spaceCode} ${country}`)
