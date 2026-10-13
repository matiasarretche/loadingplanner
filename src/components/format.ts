import type { Field } from '@/lib/resources'
import { PDF_TZ } from '@/lib/pdf/i18n'

export const nf0 = new Intl.NumberFormat('pt-BR', { maximumFractionDigits: 0 })
export const nf1 = new Intl.NumberFormat('pt-BR', { maximumFractionDigits: 1 })
export const nf2 = new Intl.NumberFormat('pt-BR', { maximumFractionDigits: 2 })
export const nf3 = new Intl.NumberFormat('pt-BR', { minimumFractionDigits: 3, maximumFractionDigits: 3 })

export function kg(v: number | null | undefined) {
  return v == null ? '—' : `${nf1.format(v)} kg`
}
export function mm(v: number | null | undefined) {
  return v == null ? '—' : `${nf0.format(v)} mm`
}
export function pct(v: number | null | undefined) {
  return v == null ? '—' : `${nf1.format(v)}%`
}
export function m3(v: number | null | undefined) {
  return v == null ? '—' : `${nf3.format(v)} m³`
}
/**
 * Fuso de TODAS as datas e horas mostradas às pessoas: hora de Brasília (São Paulo), a mesma dos PDFs.
 * O servidor (Vercel) roda em UTC e o navegador pode estar em qualquer fuso; fixar o fuso também faz o
 * HTML do servidor e o do navegador saírem iguais (sem erro de hidratação).
 */
export const APP_TZ = PDF_TZ

type When = Date | string | null | undefined
/** dia civil sem hora ('AAAA-MM-DD'): nunca passa por new Date(), que o leria como meia-noite UTC */
const ISO_DAY = /^\d{4}-\d{2}-\d{2}$/
const dtF = new Intl.DateTimeFormat('pt-BR', { dateStyle: 'short', timeStyle: 'short', timeZone: APP_TZ })
const dtSecF = new Intl.DateTimeFormat('pt-BR', { dateStyle: 'short', timeStyle: 'medium', timeZone: APP_TZ })
const dateF = new Intl.DateTimeFormat('pt-BR', { timeZone: APP_TZ })
const dayF = new Intl.DateTimeFormat('en-CA', { timeZone: APP_TZ, year: 'numeric', month: '2-digit', day: '2-digit' })

/** instante válido (Date ou texto ISO com hora); null se vazio ou inválido */
function instant(v: When): Date | null {
  if (!v) return null
  const d = typeof v === 'string' ? new Date(v) : v
  return Number.isNaN(d.getTime()) ? null : d
}

/** data e hora em São Paulo: '12/10/2026, 23:30' (um dia 'AAAA-MM-DD' sai só como data) */
export function dt(v: When) {
  if (typeof v === 'string' && ISO_DAY.test(v)) return dateBR(v)
  const d = instant(v)
  return d ? dtF.format(d) : '—'
}

/** data e hora com segundos em São Paulo: '12/10/2026, 23:30:05' */
export function dtSec(v: When) {
  const d = instant(v)
  return d ? dtSecF.format(d) : '—'
}

/** só a data em São Paulo: '12/10/2026'; um dia 'AAAA-MM-DD' só é reordenado (sem fuso) */
export function dateBR(v: When) {
  if (typeof v === 'string' && ISO_DAY.test(v)) return `${v.slice(8, 10)}/${v.slice(5, 7)}/${v.slice(0, 4)}`
  const d = instant(v)
  return d ? dateF.format(d) : '—'
}

/** dia em São Paulo como 'AAAA-MM-DD' (filtro por período igual à data exibida); '' se vazio ou inválido */
export function dayBR(v: When) {
  if (typeof v === 'string' && ISO_DAY.test(v)) return v
  const d = instant(v)
  return d ? dayF.format(d) : ''
}

export const VERIFICATION_LABEL: Record<string, string> = {
  VERIFIED: 'Verificado',
  ESTIMATED: 'Estimado',
  UNVERIFIED: 'Não verificado',
}

export const STATUS_LABEL: Record<string, string> = {
  DRAFT: 'Rascunho',
  IN_REVIEW: 'Em revisão',
  APPROVED: 'Aprovado',
  SUPERSEDED: 'Substituído',
}

export function formatCell(f: Field, v: unknown): string {
  if (v == null || v === '') return '—'
  if (f.type === 'bool') return v ? 'Sim' : 'Não'
  if (f.type === 'select' && f.options) return f.options.find((o) => o.value === v)?.label ?? String(v)
  if (f.type === 'int' || f.type === 'decimal') {
    const n = Number(v)
    return `${f.type === 'int' ? nf0.format(n) : nf2.format(n)}${f.unit ? ` ${f.unit}` : ''}`
  }
  return String(v)
}

/** Valor para input: sem separador de milhar (evita ambiguidade). */
export function inputValue(f: Field, v: unknown): string {
  if (v == null) return ''
  if (f.type === 'decimal') return String(v).replace('.', ',')
  return String(v)
}
