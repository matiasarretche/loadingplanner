'use client'

import { useEffect, useId, useMemo, useRef, useState } from 'react'
import { pickerList, type PickerGroup } from './customerPickerList'

export type { PickerGroup }

/** texto só para leitores de tela */
const SR_ONLY: React.CSSProperties = { position: 'absolute', width: 1, height: 1, overflow: 'hidden', clip: 'rect(0 0 0 0)', whiteSpace: 'nowrap' }

/** textos do seletor (cada uso tem os seus: "cliente", "transportadora"…) */
export interface SearchPickerTexts {
  /** primeira opção, valor null (ex.: "— novo cliente —", "— a definir —") */
  emptyLabel: string
  /** placeholder com a lista aberta */
  searchPlaceholder: string
  /** placeholder fechado e sem escolha */
  closedPlaceholder: string
  /** aria-label do ✕ (ex.: "Limpar cliente") */
  clearLabel: string
  /** dica do ✕ */
  clearTitle: string
  /** aria-label da lista (ex.: "Clientes") */
  listLabel: string
  /** grupo dos demais quando há grupos no topo (ex.: "Cadastrados") */
  restLabel: string
  /** o mesmo grupo sem grupos no topo (ex.: "Clientes cadastrados") */
  restLabelAlone: string
  /** busca sem resultado */
  noResults: (query: string) => string
  /** "+ N … — continue digitando para filtrar" */
  more: (hidden: number) => string
  /** anúncio para leitor de tela: "N clientes encontrados." */
  found: (n: number) => string
}

/**
 * SELETOR COM BUSCA (genérico): digita parte do nome, do código… e a lista filtra. A primeira opção é sempre a
 * vazia (valor null, `texts.emptyLabel`). Teclado: ↑/↓ escolhe, Enter confirma (nunca envia o formulário),
 * Esc fecha. Com `name`, envia o id num campo oculto (vazio = null). `featured`: grupos mostrados no topo antes
 * de digitar, cada um com o seu título. Desenha até 60 opções por vez (o resto ao refinar a busca).
 * `onChange` só é chamado quando o valor MUDA.
 *
 * `searchFactory` monta o índice uma vez por lista e devolve a função que filtra a cada tecla (sem busca: a
 * lista inteira, na ordem recebida). `labelParts` = nome + detalhe (em cinza) de cada opção; `label` = texto do
 * campo fechado com o escolhido (padrão: nome + detalhe).
 */
export function SearchPicker<T extends { id: number }>({
  items,
  value,
  onChange,
  searchFactory,
  labelParts,
  label,
  texts,
  name,
  featured,
  inputStyle,
  disabled,
  idPrefix = 'busca',
}: {
  items: T[]
  value: number | null
  onChange: (id: number | null) => void
  searchFactory: (list: T[]) => (query: string) => T[]
  labelParts: (item: T) => { name: string; detail: string }
  label?: (item: T) => string
  texts: SearchPickerTexts
  name?: string
  featured?: PickerGroup[]
  inputStyle?: React.CSSProperties
  disabled?: boolean
  idPrefix?: string
}) {
  const listId = `${idPrefix}${useId().replace(/:/g, '')}`
  const [open, setOpen] = useState(false)
  const [query, setQuery] = useState('')
  const [active, setActive] = useState(0)
  // lista aberta e nada digitado nem navegado: Enter só fecha (confirma o que já está escolhido)
  const [pristine, setPristine] = useState(true)
  const listRef = useRef<HTMLSpanElement>(null)
  const search = useMemo(() => searchFactory(items), [searchFactory, items])
  const byId = useMemo(() => new Map(items.map((c) => [c.id, c])), [items])
  const selected = value != null ? byId.get(value) ?? null : null
  const fullLabel = (c: T) => {
    if (label) return label(c)
    const p = labelParts(c)
    return p.name + p.detail
  }
  const selectedLabel = selected ? fullLabel(selected) : ''
  const q = query.trim()
  const results = useMemo(() => search(q), [search, q])
  const { groups, shown, hidden, items: opts } = pickerList(results, { query: q, featured, byId, selected })
  // destaque sempre dentro da lista atual (a lista encolhe ao digitar)
  const act = Math.min(active, opts.length - 1)
  const noResults = Boolean(q) && opts.length === 1
  const notice = noResults ? texts.noResults(q) : hidden > 0 ? texts.more(hidden) : ''

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
    setActive(Math.max(0, opts.findIndex((c) => (c?.id ?? null) === value)))
  }
  const close = () => {
    setOpen(false)
    setQuery('')
  }
  const choose = (c: T | null) => {
    const id = c ? c.id : null
    // confirmar o mesmo valor não refaz nada (não pisa no que o usuário editou)
    if (id !== value) onChange(id)
    close()
  }

  const option = (c: T | null, i: number) => {
    const p = c ? labelParts(c) : null
    const isSel = (c?.id ?? null) === value
    return (
      <span
        key={c ? c.id : 'vazio'}
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
          <span style={{ color: 'var(--text)' }}>{texts.emptyLabel}</span>
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
  // índice de cada opção = posição em `opts` (0 = opção vazia; depois os grupos e os demais)
  const groupEls = groups.map((g, gi) => {
    const start = 1 + groups.slice(0, gi).reduce((s, x) => s + x.items.length, 0)
    return (
      <span key={`g${gi}`} role="group" aria-label={g.label} style={{ display: 'block' }}>
        {head(g.label)}
        {g.items.map((c, k) => option(c, start + k))}
      </span>
    )
  })
  const shownStart = opts.length - shown.length
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
          placeholder={open ? texts.searchPlaceholder : texts.closedPlaceholder}
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
              setActive(e.key === 'ArrowDown' ? Math.min(act + 1, opts.length - 1) : Math.max(act - 1, 0))
            } else if (e.key === 'Enter') {
              // nunca envia o formulário daqui
              e.preventDefault()
              if (!open) return
              // busca sem resultado: não troca o escolhido nem apaga o que foi digitado
              if (noResults) return
              // abriu e confirmou sem digitar nem navegar: fica o que já estava escolhido
              if (pristine) return close()
              choose(opts[act] ?? null)
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
          <button type="button" className="small link" aria-label={texts.clearLabel} title={texts.clearTitle} onClick={() => onChange(null)} style={{ padding: '0 4px' }}>
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
          <span id={listId} role="listbox" aria-label={texts.listLabel} style={{ display: 'block' }}>
            {option(null, 0)}
            {groupEls}
            {shownEls.length > 0 && (
              <span role="group" aria-label={groups.length ? texts.restLabel : texts.restLabelAlone} style={{ display: 'block' }}>
                {groups.length > 0 && head(texts.restLabel)}
                {shownEls}
              </span>
            )}
          </span>
          {/* avisos fora do listbox, anunciados ao filtrar */}
          <span role="status" aria-live="polite" className="muted" style={{ display: 'block', padding: notice ? '6px 8px' : 0, fontSize: 12 }}>
            {q && !noResults && <span style={SR_ONLY}>{texts.found(results.length)}</span>}
            {notice}
          </span>
        </span>
      )}
    </span>
  )
}
