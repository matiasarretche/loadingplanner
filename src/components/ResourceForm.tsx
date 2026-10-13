'use client'

import { useState as useCountryState } from 'react'
import { CountryInput } from './CountryInput'
import { useActionState } from 'react'
import type { Field } from '@/lib/resources'
import { ORIENTATION_LABEL, ORIENTATIONS } from '@/domain/geometry'
import { inputValue } from './format'

export interface FormStateLike {
  error?: string
  fieldErrors?: Record<string, string>
  values?: Record<string, string>
}

interface Props {
  fields: Field[]
  defaults: Record<string, unknown>
  action: (s: FormStateLike, fd: FormData) => Promise<FormStateLike>
  readOnly?: boolean
  dynOptions?: Record<string, { value: string; label: string }[]>
  submitLabel?: string
  hidden?: Record<string, string>
}

/** Formulário genérico agrupado por fieldset, com erros por campo. */
export function ResourceForm({ fields, defaults, action, readOnly, dynOptions, submitLabel = 'Salvar', hidden }: Props) {
  const [state, formAction, pending] = useActionState(action, {})
  const groups = new Map<string, Field[]>()
  for (const f of fields) {
    const g = f.group ?? ''
    groups.set(g, [...(groups.get(g) ?? []), f])
  }
  const val = (f: Field) => (state.values ? state.values[f.name] ?? '' : inputValue(f, defaults[f.name]))
  return (
    <form action={formAction}>
      {state.error && <div className="alert error">{state.error}</div>}
      {hidden && Object.entries(hidden).map(([k, v]) => <input key={k} type="hidden" name={k} value={v} />)}
      <fieldset disabled={readOnly} style={{ border: 'none', padding: 0, margin: 0 }}>
        {[...groups.entries()].map(([g, fs]) => (
          <fieldset key={g}>
            {g && <legend>{g}</legend>}
            <div className="form-grid">
              {fs.map((f) => {
                const err = state.fieldErrors?.[f.name]
                const label = (
                  <>
                    {f.label}
                    {f.required && ' *'} {f.unit && <span className="unit">({f.unit})</span>}
                  </>
                )
                if (f.type === 'bool') {
                  const checked = state.values ? state.values[f.name] === 'on' : Boolean(defaults[f.name])
                  return (
                    <label key={f.name} className="check">
                      <input type="checkbox" name={f.name} defaultChecked={checked} /> {f.label}
                    </label>
                  )
                }
                if (f.type === 'orientations') {
                  const cur = (defaults[f.name] as string[] | undefined) ?? ['LWH', 'WLH']
                  return (
                    <div key={f.name} style={{ gridColumn: '1 / -1' }}>
                      <div className="muted" style={{ fontSize: 12, marginBottom: 4 }}>
                        {f.label}
                      </div>
                      <div className="row">
                        {ORIENTATIONS.map((o) => (
                          <label key={o} className="check">
                            <input
                              type="checkbox"
                              name={`${f.name}_${o}`}
                              defaultChecked={state.values ? state.values[`${f.name}_${o}`] === 'on' : cur.includes(o)}
                            />
                            {ORIENTATION_LABEL[o]}
                          </label>
                        ))}
                      </div>
                      {f.help && <small>{f.help}</small>}
                      {err && <div className="field-error">{err}</div>}
                    </div>
                  )
                }
                const common = { name: f.name, defaultValue: val(f), 'aria-invalid': Boolean(err) }
                // dado obrigatório do cadastro ainda vazio: destaque em vermelho até ser preenchido e salvo
                const missing = Boolean(f.highlightEmpty) && (val(f) === '' || val(f) == null)
                return (
                  <label key={f.name} className="field" style={f.type === 'textarea' ? { gridColumn: '1 / -1' } : undefined}>
                    <span>{label}</span>
                    {f.type === 'textarea' ? (
                      <textarea rows={3} {...common} />
                    ) : f.type === 'country' ? (
                      <CountryField name={f.name} initial={String(val(f) ?? '')} />
                    ) : f.type === 'select' ? (
                      <select {...common}>
                        {(!f.required || f.optionsFrom) && <option value="">—</option>}
                        {(f.optionsFrom ? dynOptions?.[f.optionsFrom] ?? [] : f.options ?? []).map((o) => (
                          <option key={o.value} value={o.value}>
                            {o.label}
                          </option>
                        ))}
                      </select>
                    ) : (
                      <input
                        {...common}
                        type={f.type === 'date' ? 'date' : 'text'}
                        inputMode={f.type === 'int' ? 'numeric' : f.type === 'decimal' ? 'decimal' : undefined}
                        style={{ ...(f.type === 'int' || f.type === 'decimal' ? { textAlign: 'right' as const } : {}), ...(missing ? { borderColor: 'var(--crit)', background: 'var(--crit-bg)' } : {}) }}
                      />
                    )}
                    {missing && !err && <span className="field-error">{f.highlightEmpty}</span>}
                    {f.help && <small>{f.help}</small>}
                    {err && <span className="field-error">{err}</span>}
                  </label>
                )
              })}
            </div>
          </fieldset>
        ))}
      </fieldset>
      {!readOnly && (
        <button className="primary" disabled={pending}>
          {pending ? 'Salvando…' : submitLabel}
        </button>
      )}
    </form>
  )
}

/** País no cadastro: lista de todos os países (nome em português); grava o nome oficial. */
function CountryField({ name, initial }: { name: string; initial: string }) {
  const [v, setV] = useCountryState(initial)
  return <CountryInput name={name} value={v} onChange={setV} />
}
