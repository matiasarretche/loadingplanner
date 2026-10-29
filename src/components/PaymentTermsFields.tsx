'use client'

import { useState } from 'react'
import { BALANCE_WHEN_OPTIONS, BalanceWhen, balanceWhenLabel, normalizePaymentTerms, PaymentTerms, paymentTermsErrors, paymentTermsText } from '@/domain/paymentTerms'

/** o que está digitado nos campos (texto: "12,5" fica como digitado enquanto se digita) */
interface Draft {
  advance: string
  when: BalanceWhen
  days: string
  note: string
}

const EMPTY: Draft = { advance: '100', when: 'BEFORE_SHIPMENT', days: '', note: '' }

const draftOf = (t: PaymentTerms | null, prev: Draft = EMPTY): Draft =>
  t
    ? { advance: Number.isFinite(t.advancePct) ? String(t.advancePct).replace('.', ',') : '', when: t.balanceWhen ?? prev.when, days: t.days != null ? String(t.days) : '', note: t.note ?? '' }
    : prev

const termsOf = (d: Draft): PaymentTerms => normalizePaymentTerms({ advancePct: d.advance, balanceWhen: d.when, days: d.days, note: d.note })!

/** chave de comparação (o mesmo valor em outro objeto não refaz os campos) */
const keyOf = (t: PaymentTerms | null) => (t ? JSON.stringify([t.advancePct, t.balanceWhen, t.days ?? null, t.note ?? null]) : '')

/**
 * CONDIÇÕES DE PAGAMENTO (% antecipado + quando se paga o saldo + dias + nota livre), com a prévia do texto
 * que sai no PDF em pt/es/en. Caixa desmarcada = sem condição (onChange(null)).
 * `onChange` recebe a condição já normalizada, MESMO inválida (para a tela mostrar o erro e bloquear o envio
 * com paymentTermsErrors). Um `value` diferente vindo de fora (ex.: preenchido com a última carga do cliente)
 * refaz os campos; o próprio valor devolvido em onChange não (o que está sendo digitado não se perde).
 */
export function PaymentTermsFields({ value, onChange, disabled, idPrefix = 'pagamento' }: { value: PaymentTerms | null; onChange: (v: PaymentTerms | null) => void; disabled?: boolean; idPrefix?: string }) {
  const [draft, setDraft] = useState<Draft>(() => draftOf(value))
  const [seen, setSeen] = useState(() => keyOf(value))
  const key = keyOf(value)
  if (key !== seen) {
    // valor novo vindo de fora: os campos passam a mostrá-lo (padrão do React para estado derivado de props)
    setSeen(key)
    setDraft((d) => draftOf(value, d))
  }
  const on = value != null
  const terms = termsOf(draft)
  const errors = on ? paymentTermsErrors(terms) : []
  const adv = terms.advancePct

  const emit = (d: Draft) => {
    const t = termsOf(d)
    setDraft(d)
    setSeen(keyOf(t))
    onChange(t)
  }
  const edit = (patch: Partial<Draft>) => emit({ ...draft, ...patch })

  return (
    <fieldset style={{ marginTop: 6 }}>
      <legend>
        <label className="check">
          <input
            type="checkbox"
            id={`${idPrefix}-on`}
            checked={on}
            onChange={(e) => {
              if (e.target.checked) return emit(draft)
              // desmarcar não apaga o que foi digitado: marcar de novo volta com os mesmos campos
              setSeen('')
              onChange(null)
            }}
            disabled={disabled}
          />{' '}
          Condições de pagamento
        </label>
      </legend>
      {on && (
        <>
          <div className="row" style={{ gap: 8, flexWrap: 'wrap', alignItems: 'flex-end' }}>
            <label className="field" style={{ width: 120 }}>
              % antecipado
              <input id={`${idPrefix}-adv`} inputMode="decimal" value={draft.advance} onChange={(e) => edit({ advance: e.target.value })} disabled={disabled} />
            </label>
            {!(adv >= 100) && (
              <>
                <label className="field">
                  Saldo
                  <select id={`${idPrefix}-when`} value={draft.when} onChange={(e) => edit({ when: e.target.value as BalanceWhen })} disabled={disabled}>
                    {BALANCE_WHEN_OPTIONS.map((w) => (
                      <option key={w} value={w}>
                        {balanceWhenLabel(w)}
                      </option>
                    ))}
                  </select>
                </label>
                {draft.when.startsWith('DAYS_') && (
                  <label className="field" style={{ width: 90 }}>
                    Dias
                    <input id={`${idPrefix}-days`} inputMode="numeric" value={draft.days} onChange={(e) => edit({ days: e.target.value })} disabled={disabled} />
                  </label>
                )}
              </>
            )}
            <label className="field" style={{ flex: 1, minWidth: 220 }}>
              Nota livre (opcional; sai como digitada)
              <input id={`${idPrefix}-note`} value={draft.note} onChange={(e) => edit({ note: e.target.value })} disabled={disabled} maxLength={300} />
            </label>
          </div>
          {errors.length ? (
            <small role="alert" style={{ color: 'var(--crit)' }}>
              {errors.join(' ')}
            </small>
          ) : (
            <div className="muted" style={{ fontSize: 12 }}>
              PDF — pt: {paymentTermsText(terms, 'pt')} · es: {paymentTermsText(terms, 'es')} · en: {paymentTermsText(terms, 'en')}
            </div>
          )}
        </>
      )}
    </fieldset>
  )
}
