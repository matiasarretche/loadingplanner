import { TRACKING_TZ } from '@/domain/exportTracking'

/**
 * Formatos do detalhe do seguimento (servidor e cliente): instantes sempre no fuso de São Paulo,
 * para o mesmo texto no servidor e no navegador (sem diferença de hidratação).
 */
const dateF = new Intl.DateTimeFormat('pt-BR', { timeZone: TRACKING_TZ, day: '2-digit', month: '2-digit', year: 'numeric' })
const timeF = new Intl.DateTimeFormat('pt-BR', { timeZone: TRACKING_TZ, hour: '2-digit', minute: '2-digit', hourCycle: 'h23' })

/** ISO → '12/10/2026 14:03' (São Paulo) */
export function fmtInstant(iso: string | null | undefined): string {
  if (!iso) return '—'
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return '—'
  return `${dateF.format(d)} ${timeF.format(d)}`
}

const usdF = new Intl.NumberFormat('pt-BR', { minimumFractionDigits: 2, maximumFractionDigits: 2 })
/** 'USD 12.345,00' ou '—' */
export const usd = (v: number | null | undefined) => (v == null ? '—' : `USD ${usdF.format(v)}`)

/** '1 dia' / '3 dias' */
export const dias = (n: number) => (n === 1 ? '1 dia' : `${n} dias`)
