'use client'

import { useRouter } from 'next/navigation'
import { useEffect, useRef, useState } from 'react'
import { countBySeverity, Issue, SEVERITY_LABEL, sortIssues } from '@/domain/issues'
import type { ViewPreset } from '../three/Scene3D'

export function IssuesList({ issues, onPick }: { issues: Issue[]; onPick?: (refs: string[]) => void }) {
  const c = countBySeverity(issues)
  const sorted = sortIssues(issues)
  return (
    <div>
      <div className="row" style={{ marginBottom: 6 }}>
        <strong>Validações</strong>
        <span className="badge CRITICAL">{c.CRITICAL} crítico(s)</span>
        <span className="badge WARNING">{c.WARNING} atenção</span>
        <span className="badge INFO">{c.INFO} info</span>
      </div>
      {sorted.length === 0 ? (
        <div className="badge ok">Sem alertas</div>
      ) : (
        <ul className="issues">
          {sorted.map((i, k) => (
            <li key={k} className={i.refs.length && onPick ? 'clickable' : ''} onClick={() => i.refs.length && onPick?.(i.refs)} title={i.code}>
              <span className={`badge ${i.severity}`}>{SEVERITY_LABEL[i.severity]}</span>
              <span>{i.message}</span>
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}

export function Kpi({ k, v, s, level, meter }: { k: string; v: string; s?: string; level?: 'CRITICAL' | 'WARNING'; meter?: number | null }) {
  return (
    <div className={`kpi ${level ?? ''}`}>
      <div className="k">{k}</div>
      <div className="v">{v}</div>
      {s && <div className="s">{s}</div>}
      {meter != null && (
        <div className={`meter ${meter > 100 ? 'over' : ''}`}>
          <div style={{ width: `${Math.min(100, Math.max(0, meter))}%` }} />
        </div>
      )}
    </div>
  )
}

export const VIEW_LABEL: Record<ViewPreset, string> = {
  persp: 'Perspectiva',
  top: 'Superior',
  side: 'Lateral',
  front: 'Traseira',
  rear: 'Frente',
}

export function ViewButtons({ view, setView, views }: { view: ViewPreset; setView: (v: ViewPreset) => void; views: ViewPreset[] }) {
  return (
    <>
      {views.map((v) => (
        <button key={v} className={`small ${view === v ? 'active' : ''}`} onClick={() => setView(v)}>
          {VIEW_LABEL[v]}
        </button>
      ))}
      <button className="small" onClick={() => setView('persp')} title="Volta a câmera para a vista inicial, centrada na carga (desfaz deslocamentos e zoom)">
        ⌖ Centralizar
      </button>
    </>
  )
}

export function NumberInput({
  value,
  onCommit,
  disabled,
  step = 1,
  title,
}: {
  value: number
  /** devolver false = valor recusado (o campo volta ao valor anterior) */
  onCommit: (v: number) => void | boolean
  disabled?: boolean
  step?: number
  title?: string
}) {
  return (
    <input
      key={value}
      type="number"
      step={step}
      defaultValue={value}
      disabled={disabled}
      title={title}
      onBlur={(e) => {
        const n = Math.round(Number(e.currentTarget.value))
        if (Number.isFinite(n) && n !== value) {
          if (onCommit(n) === false) e.currentTarget.value = String(value)
        } else e.currentTarget.value = String(value)
      }}
      onKeyDown={(e) => {
        if (e.key === 'Enter') (e.currentTarget as HTMLInputElement).blur()
        e.stopPropagation()
      }}
    />
  )
}

/** Atalhos: setas movem, PgUp/PgDn sobem/descem, R gira, Del apaga, Ctrl+D duplica, Ctrl+Z/Y. */
export function useEditorKeys(h: {
  move: (dx: number, dy: number, dz: number) => void
  rotate: () => void
  /** tombar (outra face na vertical), se o editor suportar */
  flip?: () => void
  remove: () => void
  duplicate: () => void
  /** Esc (ex.: sair do modo "dentro do palete") */
  escape?: () => void
  undo: () => void
  redo: () => void
  step: number
  enabled: boolean
}) {
  useEffect(() => {
    if (!h.enabled) return
    const fn = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement
      if (t && (t.tagName === 'INPUT' || t.tagName === 'SELECT' || t.tagName === 'TEXTAREA')) return
      const s = e.shiftKey ? h.step * 10 : h.step
      const k = e.key
      if ((e.ctrlKey || e.metaKey) && k.toLowerCase() === 'z') {
        e.preventDefault()
        if (e.shiftKey) h.redo()
        else h.undo()
      } else if ((e.ctrlKey || e.metaKey) && k.toLowerCase() === 'y') {
        e.preventDefault()
        h.redo()
      } else if ((e.ctrlKey || e.metaKey) && k.toLowerCase() === 'd') {
        e.preventDefault()
        h.duplicate()
      } else if (k === 'ArrowUp') {
        e.preventDefault()
        h.move(0, s, 0)
      } else if (k === 'ArrowDown') {
        e.preventDefault()
        h.move(0, -s, 0)
      } else if (k === 'ArrowLeft') {
        e.preventDefault()
        h.move(-s, 0, 0)
      } else if (k === 'ArrowRight') {
        e.preventDefault()
        h.move(s, 0, 0)
      } else if (k === 'PageUp') {
        e.preventDefault()
        h.move(0, 0, s)
      } else if (k === 'PageDown') {
        e.preventDefault()
        h.move(0, 0, -s)
      } else if (k.toLowerCase() === 'r' && !e.ctrlKey) h.rotate()
      else if (k.toLowerCase() === 't' && !e.ctrlKey) h.flip?.()
      else if (k === 'Delete') h.remove()
      else if (k === 'Escape') h.escape?.()
    }
    window.addEventListener('keydown', fn)
    return () => window.removeEventListener('keydown', fn)
  }, [h])
}

export const SNAP_OPTIONS = [1, 5, 10, 50, 100]

export function useBeforeUnload(dirty: boolean) {
  useEffect(() => {
    if (!dirty) return
    const fn = (e: BeforeUnloadEvent) => {
      e.preventDefault()
    }
    window.addEventListener('beforeunload', fn)
    return () => window.removeEventListener('beforeunload', fn)
  }, [dirty])
}

type PendingNav = { kind: 'link'; href: string } | { kind: 'form'; form: HTMLFormElement; submitter: HTMLElement | null }

/**
 * Proteção contra perda de alterações: intercepta links internos e formulários fora do editor
 * (menu, "Resumo", "Nova versão", "Sair"…) enquanto houver alterações não salvas e pergunta
 * "Salvar e sair / Sair sem salvar / Cancelar". Recarregar/fechar a aba usa o aviso do navegador.
 */
export function useUnsavedGuard(dirty: boolean, rootRef: React.RefObject<HTMLElement | null>, save: () => Promise<boolean>) {
  const [pending, setPending] = useState<PendingNav | null>(null)
  const [busy, setBusy] = useState(false)
  const bypass = useRef(false)
  const router = useRouter()

  useEffect(() => {
    if (!dirty) return
    const onClick = (e: MouseEvent) => {
      if (bypass.current || e.defaultPrevented || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey) return
      const a = (e.target as HTMLElement)?.closest?.('a') as HTMLAnchorElement | null
      if (!a || !a.href || a.target === '_blank' || a.hasAttribute('download')) return
      const url = new URL(a.href, location.href)
      if (url.origin !== location.origin || url.pathname.endsWith('/csv')) return
      if (url.pathname === location.pathname && url.search === location.search) return
      e.preventDefault()
      e.stopPropagation()
      setPending({ kind: 'link', href: url.pathname + url.search + url.hash })
    }
    const onSubmit = (e: SubmitEvent) => {
      if (bypass.current) return
      const form = e.target as HTMLFormElement
      if (rootRef.current && rootRef.current.contains(form)) return // formulários do próprio editor
      e.preventDefault()
      e.stopPropagation()
      setPending({ kind: 'form', form, submitter: (e.submitter as HTMLElement) ?? null })
    }
    document.addEventListener('click', onClick, true)
    document.addEventListener('submit', onSubmit, true)
    return () => {
      document.removeEventListener('click', onClick, true)
      document.removeEventListener('submit', onSubmit, true)
    }
  }, [dirty, rootRef])

  function proceed(p: PendingNav) {
    bypass.current = true
    setPending(null)
    if (p.kind === 'link') router.push(p.href)
    else p.form.requestSubmit(p.submitter instanceof HTMLButtonElement || p.submitter instanceof HTMLInputElement ? p.submitter : undefined)
    setTimeout(() => (bypass.current = false), 1500)
  }

  const modal = pending ? (
    <UnsavedDialog
      busy={busy}
      onCancel={() => setPending(null)}
      onDiscard={() => proceed(pending)}
      onSave={async () => {
        setBusy(true)
        try {
          if (await save()) proceed(pending)
        } finally {
          setBusy(false)
        }
      }}
    />
  ) : null
  return { modal }
}

function UnsavedDialog({ busy, onSave, onDiscard, onCancel }: { busy: boolean; onSave: () => void; onDiscard: () => void; onCancel: () => void }) {
  const ref = useRef<HTMLDialogElement>(null)
  useEffect(() => {
    ref.current?.showModal()
  }, [])
  return (
    <dialog
      ref={ref}
      onCancel={(e) => {
        e.preventDefault()
        onCancel()
      }}
      style={{ border: '1px solid var(--border)', borderRadius: 10, padding: 20, width: 'min(480px, 94vw)' }}
    >
      <h3 style={{ marginTop: 0, color: 'var(--text)', textTransform: 'none', letterSpacing: 0, fontSize: 16 }}>Alterações não salvas</h3>
      <p>Você tem alterações não salvas. Quer salvar a composição antes de sair?</p>
      <div className="row" style={{ justifyContent: 'flex-end' }}>
        <button onClick={onCancel} disabled={busy}>
          Cancelar
        </button>
        <button className="danger" onClick={onDiscard} disabled={busy}>
          Sair sem salvar
        </button>
        <button className="primary" onClick={onSave} disabled={busy}>
          {busy ? 'Salvando…' : 'Salvar e sair'}
        </button>
      </div>
    </dialog>
  )
}

/** Faixa bem visível enquanto houver alterações não salvas. */
export function UnsavedBanner({ dirty }: { dirty: boolean }) {
  if (!dirty) return null
  return (
    <div className="alert warn unsaved-banner" style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
      <strong>● Alterações não salvas</strong>
      <span>Esta composição foi modificada e ainda não foi salva.</span>
    </div>
  )
}
