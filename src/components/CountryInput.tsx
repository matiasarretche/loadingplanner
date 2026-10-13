'use client'

import { useId, useMemo } from 'react'
import { ALL_COUNTRY_CODES, countryCode, countryNamePt, countryOptions } from '@/lib/countries'

/**
 * País de destino: lista com TODOS os países (nome em português) para escolher, e também aceita
 * digitar. Mostra a bandeira e, se informado, a categoria comercial (preços de exportação).
 */
export function CountryInput({ value, onChange, name, required, placeholder, categoryOf, disabled, inputStyle }: {
  value: string
  onChange: (v: string) => void
  name?: string
  required?: boolean
  placeholder?: string
  /** categoria comercial do país (código ISO) — ex.: "Categoria A"; null = sem categoria */
  categoryOf?: (code: string) => string | null
  disabled?: boolean
  /** estilo do campo (ex.: destaque vermelho de dado que falta) */
  inputStyle?: React.CSSProperties
}) {
  const opts = useMemo(() => countryOptions(), [])
  const listId = `paises${useId().replace(/:/g, '')}`
  const c = countryCode(value)
  const code = c && ALL_COUNTRY_CODES.includes(c) ? c : null
  const cat = code && categoryOf ? categoryOf(code) : undefined
  return (
    <span style={{ display: 'block' }}>
      <span style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
        {code && (
          // eslint-disable-next-line @next/next/no-img-element -- bandeira pequena externa
          <img src={`https://flagcdn.com/w20/${code.toLowerCase()}.png`} alt="" width={20} height={14} />
        )}
        {/* ao clicar, o texto fica selecionado: digitar substitui o país e a lista mostra TODOS os países */}
        <input name={name} list={listId} value={value} onChange={(e) => onChange(e.target.value)} onFocus={(e) => e.currentTarget.select()} onBlur={() => code && onChange(countryNamePt(code))} required={required} disabled={disabled} placeholder={placeholder ?? 'escolha ou digite o país'} autoComplete="off" style={{ flex: 1, ...inputStyle }} />
        {value && !disabled && (
          <button type="button" className="small link" title="Trocar o país (mostra a lista completa)" onClick={() => onChange('')} style={{ padding: '0 4px' }}>
            ✕
          </button>
        )}
      </span>
      <datalist id={listId}>
        {opts.map((o) => (
          <option key={o.code} value={o.name} />
        ))}
      </datalist>
      {value.trim() && !code && <small style={{ color: '#b35f00' }}>país não reconhecido — escolha da lista</small>}
      {code && categoryOf && <small className="muted">{cat ? cat : <span style={{ color: '#b35f00' }}>sem categoria comercial (sem preço)</span>}</small>}
    </span>
  )
}
