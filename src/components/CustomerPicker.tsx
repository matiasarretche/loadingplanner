'use client'

import { useEffect, useId, useMemo, useRef, useState } from 'react'
import { customerLabel, customerLabelParts, customerSearch, type CustomerSearchFields } from '@/domain/customerAddress'
import { pickerList, type PickerGroup } from './customerPickerList'

export interface PickerCustomer extends CustomerSearchFields {
  id: number
}

/** texto só para leitores de tela */
const SR_ONLY: React.CSSProperties = { position: 'absolute', width: 1, height: 1, overflow: 'hidden', clip: 'rect(0 0 0 0)', whiteSpace: 'nowrap' }

/**
 * Cliente da carga com BUSCA: digita parte da razão social, da cidade, do país ou o código do ERP e a
 * lista filtra ("Razão social — Cidade, País · cód. 609"). A primeira opção é sempre "— novo cliente —"
 * (valor null). Teclado: ↑/↓ escolhe, Enter confirma, Esc fecha. Com `name`, envia o id num campo oculto
 * (vazio = novo cliente). `featured`: grupos mostrados no topo antes de digitar (ex.: homônimos e parecidos
 * com o do pedido), cada um com o seu título. `onChange` só é chamado quando o cliente MUDA.
 */
export function CustomerPicker({
  customers,
  value,
  onChange,
  name,
  featured,
  inputStyle,
  disabled,
  newLabel = '— novo cliente —',
}: {
  customers: PickerCustomer[]
  value: number | null
  onChange: (id: number | null) => void
  name?: string
  featured?: PickerGroup[]
  inputStyle?: React.CSSProperties
  disabled?: boolean
  newLabel?: string
}) {
  const listId = `clientes${useId().replace(/:/g, '')}`
  const [open, setOpen] = useState(false)
  const [query, setQuery] = useState('')
  const [active, setActive] = useState(0)
  // lista aberta e nada digitado nem navegado: Enter só fecha (confirma o que já está escolhido)
  const [pristine, setPristine] = useState(true)
  const listRef = useRef<HTMLSpanElement>(null)
  const search = useMemo(() => customerSearch(customers), [customers])
  const byId = useMemo(() => new Map(customers.map((c) => [c.id, c])), [customers])
  const selected = value != null ? byId.get(value) ?? null : null
  const selectedLabel = selected ? customerLabel(selected) : ''
  const q = query.trim()
  const results = useMemo(() => search(q), [search, q])
  const { groups, shown, hidden, items } = pickerList(results, { query: q, featured, byId, selected })
  // destaque sempre dentro da lista atual (a lista encolhe ao digitar)
  const act = Math.min(active, items.length - 1)
  const noResults = Boolean(q) && items.length === 1
  const notice = noResults ? `Nenhum cliente com “${q}”. Use “${newLabel}” para cadastrar.` : hidden > 0 ? `+ ${hidden} clientes — continue digitando para filtrar` : ''

  // a opção destacada fica visível ao navegar com o teclado
  useEffect(() => {
    if (open) listRef.current?.querySelector(`[data-i="${act}"]`)?.scrollIntoView({ block: 'nearest' })
  }, [open, act])

  const openList = () => {
    if (disabled) return
    setOpen(true)
    setQuery('')
    setPristine(true)
    // fechado, a busca já está vazia: a lista que abre é esta (com o escolhido sempre nela) — destaca o escolhido
    setActive(Math.max(0, items.findIndex((c) => (c?.id ?? null) === value)))
  }
  const close = () => {
    setOpen(false)
    setQuery('')
  }
  const choose = (c: PickerCustomer | null) => {
    const id = c ? c.id : null
    // confirmar o mesmo cliente não refaz o preenchimento (não pisa no que o usuário editou)
    if (id !== value) onChange(id)
    close()
  }

  const option = (c: PickerCustomer | null, i: number) => {
    const p = c ? customerLabelParts(c) : null
    const isSel = (c?.id ?? null) === value
    return (
      <span
        key={c ? c.id : 'novo'}
        id={`${listId}-${i}`}
        data-i={i}
        role="option"
        aria-selected={isSel}
        onMouseDown={(e) => e.preventDefault()}
        onMouseEnter={() => {
          setActive(i)
          setPristine(false)
        }}
        onClick={(e) => {
          // dentro de <label>: sem isso o clique "ativa" o rótulo
          e.preventDefault()
          choose(c)
        }}
        style={{ display: 'block', padding: '6px 8px', borderRadius: 6, cursor: 'pointer', fontSize: 13, lineHeight: 1.35, background: i === act ? '#e4f3ec' : undefined, fontWeight: isSel ? 600 : undefined }}
      >
        {p ? (
          <>
            <span style={{ color: 'var(--text)' }}>{p.name}</span>
            <span className="muted">{p.detail}</span>
          </>
        ) : (
          <span style={{ color: 'var(--text)' }}>{newLabel}</span>
        )}
      </span>
    )
  }
  // título visual do grupo; o leitor de tela usa o aria-label do role="group"
  const head = (t: string) => (
    <span aria-hidden="true" style={{ display: 'block', padding: '6px 8px 2px', fontSize: 11, textTransform: 'uppercase', letterSpacing: '.04em', color: 'var(--muted)' }}>
      {t}
    </span>
  )
  // índice de cada opção = posição em `items` (0 = novo cliente; depois os grupos e os demais)
  const groupEls = groups.map((g, gi) => {
    const start = 1 + groups.slice(0, gi).reduce((s, x) => s + x.items.length, 0)
    return (
      <span key={`g${gi}`} role="group" aria-label={g.label} style={{ display: 'block' }}>
        {head(g.label)}
        {g.items.map((c, k) => option(c, start + k))}
      </span>
    )
  })
  const shownStart = items.length - shown.length
  const shownEls = shown.map((c, k) => option(c, shownStart + k))

  return (
    <span style={{ display: 'block', position: 'relative' }}>
      {name && <input type="hidden" name={name} value={value ?? ''} />}
      <span style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
        <input
          role="combobox"
          aria-expanded={open}
          aria-controls={listId}
          aria-autocomplete="list"
          aria-activedescendant={open ? `${listId}-${act}` : undefined}
          value={open ? query : selectedLabel}
          placeholder={open ? 'buscar: nome, cidade, país ou código' : `${newLabel} · clique para buscar nome, cidade ou código`}
          title={selectedLabel || undefined}
          onFocus={openList}
          onMouseDown={() => {
            if (!open) openList()
          }}
          onBlur={close}
          onChange={(e) => {
            const t = e.target.value
            const ne = e.nativeEvent as InputEvent
            // fechado, o campo mostra o rótulo do escolhido: a busca nova começa só pelo que foi digitado
            // agora (apagar = lista inteira), nunca por "rótulo inteiro + letra"
            const v = open || !selectedLabel ? t : ne.inputType?.startsWith('delete') ? '' : t.startsWith(selectedLabel) ? t.slice(selectedLabel.length) : (ne.data ?? t)
            setQuery(v)
            setOpen(true)
            setPristine(false)
            setActive(v.trim() ? 1 : 0)
          }}
          onKeyDown={(e) => {
            if (e.nativeEvent.isComposing) return
            if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
              e.preventDefault()
              if (!open) return openList()
              setPristine(false)
              setActive(e.key === 'ArrowDown' ? Math.min(act + 1, items.length - 1) : Math.max(act - 1, 0))
            } else if (e.key === 'Enter') {
              // nunca envia o formulário daqui
              e.preventDefault()
              if (!open) return
              // busca sem resultado: não troca o cliente escolhido nem apaga o que foi digitado
              if (noResults) return
              // abriu e confirmou sem digitar nem navegar: fica o que já estava escolhido
              if (pristine) return close()
              choose(items[act] ?? null)
            } else if (e.key === 'Escape' && open) {
              e.preventDefault()
              close()
            }
          }}
          disabled={disabled}
          autoComplete="off"
          spellCheck={false}
          style={{ flex: 1, minWidth: 0, ...inputStyle }}
        />
        {value != null && !disabled && (
          <button type="button" className="small link" aria-label="Limpar cliente" title={`Limpar (volta para “${newLabel}”)`} onClick={() => onChange(null)} style={{ padding: '0 4px' }}>
            <span aria-hidden="true">✕</span>
          </button>
        )}
      </span>
      {open && (
        <span
          ref={listRef}
          // rolar a lista pela barra de rolagem não tira o foco do campo
          onMouseDown={(e) => e.preventDefault()}
          style={{
            display: 'block',
            position: 'absolute',
            top: 'calc(100% + 2px)',
            left: 0,
            zIndex: 30,
            width: '100%',
            minWidth: 'min(460px, calc(100vw - 32px))',
            maxHeight: 340,
            overflowY: 'auto',
            background: 'var(--panel)',
            border: '1px solid var(--border)',
            borderRadius: 8,
            boxShadow: '0 10px 28px rgba(16,24,40,.14)',
            padding: 4,
          }}
        >
          <span id={listId} role="listbox" aria-label="Clientes" style={{ display: 'block' }}>
            {option(null, 0)}
            {groupEls}
            {shownEls.length > 0 && (
              <span role="group" aria-label={groups.length ? 'Cadastrados' : 'Clientes cadastrados'} style={{ display: 'block' }}>
                {groups.length > 0 && head('Cadastrados')}
                {shownEls}
              </span>
            )}
          </span>
          {/* avisos fora do listbox, anunciados ao filtrar */}
          <span role="status" aria-live="polite" className="muted" style={{ display: 'block', padding: notice ? '6px 8px' : 0, fontSize: 12 }}>
            {q && !noResults && <span style={SR_ONLY}>{results.length === 1 ? '1 cliente encontrado. ' : `${results.length} clientes encontrados. `}</span>}
            {notice}
          </span>
        </span>
      )}
    </span>
  )
}
