'use client'

import dynamic from 'next/dynamic'
import { useCallback, useMemo, useRef, useState } from 'react'
import { brandLabelFor } from '@/domain/brandLabels'
import { isRollPack } from '@/domain/packShape'
import { distinctSkuColors } from '@/domain/colors'
import { expeditionModel } from '@/domain/expedition'
import { loadGeometries, palletParts, shortUnitLabel } from '@/domain/load'
import { fitNone } from '@/domain/noEquipment'
import type { LoadDoc } from '@/domain/types'
import { PdfPreview } from '@/components/pdf/PdfPreview'
import { kg, nf0 } from '@/components/format'
import { exportExpeditionPdf, ExpeditionInfo } from '@/components/editor/expeditionExport'
import { ViewButtons } from '@/components/editor/ui'
import type { CaptureFn, SceneBody, ViewPreset } from '@/components/three/Scene3D'

const Scene3D = dynamic(() => import('@/components/three/Scene3D').then((m) => m.Scene3D), { ssr: false, loading: () => <div className="hint">Carregando 3D…</div> })

const SIDE: Record<string, string> = { OESTE: 'lado oeste (motorista)', LESTE: 'lado leste (acompanhante)', CENTRO: 'centro' }
const m = (mm: number) => `${(mm / 1000).toLocaleString('pt-BR', { minimumFractionDigits: 2, maximumFractionDigits: 2 })} m`

/**
 * VISTA DE EXPEDIÇÃO (depósito, celular): o que carregar e em que ordem, o PDF de expedição e o 3D da
 * versão APROVADA (somente leitura). Tocar numa unidade da lista a destaca no 3D.
 */
export function ExpeditionView({ doc, info }: { doc: LoadDoc; info: ExpeditionInfo }) {
  const isNone = doc.space.kind === 'NONE'
  const view = useMemo(() => (isNone ? fitNone(doc) : doc), [isNone, doc])
  const model = useMemo(() => expeditionModel(view, { maxSteps: 6 }), [view])
  const geoms = useMemo(() => loadGeometries(view), [view])
  const colorOf = useMemo(() => {
    const used = view.units.flatMap((u) => (u.kind === 'PALLET' ? Object.values(view.pallets[u.palletKey]?.packs ?? {}) : view.packs[u.packId] ? [view.packs[u.packId]] : []))
    return distinctSkuColors(used)
  }, [view])
  const [sel, setSel] = useState<string | null>(null)
  const [cam, setCam] = useState<{ view: ViewPreset; nonce: number }>({ view: 'persp', nonce: 0 })
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState<string | null>(null)
  const [pdf, setPdf] = useState<{ blob: Blob; name: string } | null>(null)
  const [warn, setWarn] = useState<string | null>(null)
  // o 3D carrega depois da página: o PDF só leva as vistas 3D quando ele já está pronto
  const [ready3d, setReady3d] = useState(false)
  const capture = useRef<CaptureFn | null>(null)
  const onCaptureReady = useCallback((fn: CaptureFn) => {
    capture.current = fn
    setReady3d(true)
  }, [])

  const bodies: SceneBody[] = geoms.map((g) => {
    const u = g.unit
    let parts: SceneBody['parts']
    let color = '#999'
    let print: string | undefined
    let brand: SceneBody['brand']
    let roll = false
    if (u.kind === 'PALLET') {
      const p = view.pallets[u.palletKey]
      parts = palletParts(p, u).map((x) => {
        const k = x.packId ? p.packs[x.packId] : undefined
        return { min: x.box.min, size: x.box.size, color: k ? colorOf.get(k.sku) ?? k.color : '#b48a5a', print: k?.sku, brand: k ? brandLabelFor(k) ?? undefined : undefined, roll: isRollPack(k) }
      })
    } else {
      const k = view.packs[u.packId]
      color = k ? colorOf.get(k.sku) ?? k.color : '#999'
      print = k?.sku
      brand = k ? brandLabelFor(k) ?? undefined : undefined
      roll = isRollPack(k)
    }
    return { id: u.id, min: g.box.min, size: g.box.size, parts, color, print, brand, roll, label: shortUnitLabel(u, view.units.indexOf(u)), selected: sel === u.id }
  })

  async function makePdf() {
    setBusy(true)
    setErr(null)
    setWarn(null)
    try {
      // sem seleção: as vistas do PDF saem limpas
      if (sel) {
        setSel(null)
        await new Promise<void>((r) => requestAnimationFrame(() => requestAnimationFrame(() => r())))
      }
      const r = await exportExpeditionPdf({ doc, view, capture: capture.current, info })
      setPdf({ blob: r.blob, name: r.name })
      if (!r.withViews)
        setWarn(ready3d ? 'PDF gerado sem as vistas 3D (o 3D não está disponível neste aparelho). A planta, a vista lateral e a lista estão no PDF.' : 'PDF gerado sem as vistas 3D: o 3D ainda estava carregando. Espere o 3D aparecer embaixo e gere de novo para incluir as vistas e a sequência.')
    } catch {
      setErr('Não foi possível gerar o PDF de expedição. Tente de novo.')
    } finally {
      setBusy(false)
    }
  }

  const rows = model.rows.filter((r) => !r.outside)
  const t = model.totals
  return (
    <div className="expedition">
      <button className="primary expedition-pdf" onClick={() => void makePdf()} disabled={busy || !rows.length}>
        {busy ? 'Gerando o PDF…' : '📋 PDF de expedição'}
      </button>
      {err && <div className="alert error">{err}</div>}
      {warn && <div className="alert warn">{warn}</div>}
      {pdf && <PdfPreview blob={pdf.blob} fileName={pdf.name} lang="pt" subject={`Expedição — ${info.orderRef ?? info.planName}`} docLabel={`a instrução de carregamento${info.orderRef ? ` ${info.orderRef}` : ''}`} onClose={() => setPdf(null)} />}

      <div className="expedition-totals">
        {t.pallets > 0 && (
          <span>
            <strong>{nf0.format(t.pallets)}</strong> palete(s)
          </span>
        )}
        {t.packages > 0 && (
          <span>
            <strong>{nf0.format(t.packages)}</strong> volume(s) solto(s)
          </span>
        )}
        <span>
          <strong>{nf0.format(t.boxes)}</strong> caixa(s)
        </span>
        <span>
          <strong>{kg(t.grossKg)}</strong> bruto
        </span>
        {!isNone && (
          <span>
            <strong>{m(t.usedLengthMm)}</strong> de comprimento usado
          </span>
        )}
      </div>
      {model.notes.length > 0 && (
        <div className="alert warn">
          {model.notes.map((n, i) => (
            <div key={i}>{n}</div>
          ))}
        </div>
      )}

      <h2>O que carregar, na ordem</h2>
      {!isNone && <p className="muted" style={{ marginTop: -4 }}>Da frente (cabine / fundo do contêiner) para a traseira (porta). Toque numa unidade para vê-la no 3D.</p>}
      <ol className="expedition-list">
        {rows.map((r) => (
          <li key={r.id} className={sel === r.id ? 'on' : undefined}>
            <button type="button" className="expedition-row" onClick={() => setSel((s) => (s === r.id ? null : r.id))} aria-pressed={sel === r.id}>
              <span className="expedition-n">{r.order}</span>
              <span className="expedition-body">
                <strong>
                  {r.label} · {r.carrier}
                  {r.rotated ? ' · girado 90°' : ''}
                </strong>
                <span className="muted">
                  {isNone ? '' : `${SIDE[r.side] ?? r.side} · a ${m(r.x0)} da frente`}
                  {r.stackedOn ? `${isNone ? '' : ' · '}em cima de ${r.stackedOn}` : ''}
                  {r.overhang ? ' · ⚠ passa dos limites internos' : ''}
                </span>
                {r.items.map((it, i) => (
                  <span key={i} className="expedition-item">
                    {it.sku} — {nf0.format(it.boxes)} cx{it.units !== it.boxes ? ` (${nf0.format(it.units)} un)` : ''}
                    {it.box ? ` · ${it.box}` : ''}
                    <small className="muted"> {it.name}</small>
                  </span>
                ))}
                <span className="muted">{kg(r.grossKg)} bruto</span>
              </span>
            </button>
          </li>
        ))}
      </ol>

      <h2>3D da carga aprovada</h2>
      <div className="expedition-3d">
        <div className="toolbar">
          <ViewButtons view={cam.view} setView={(v) => setCam((c) => ({ view: v, nonce: c.nonce + 1 }))} views={['persp', 'top', 'side']} />
        </div>
        <Scene3D
          bounds={{ kind: 'container', size: { x: view.space.inner.l, y: view.space.inner.w, z: view.space.inner.h }, door: isNone ? undefined : view.space.door }}
          bodies={bodies}
          view={cam.view}
          viewNonce={cam.nonce}
          showWalls={!isNone}
          showRoof={false}
          showLabels
          showPrint
          snapMm={0}
          onSelect={(id) => setSel(id)}
          onMove={() => {}}
          onCaptureReady={onCaptureReady}
        />
        <div className="hint">Um dedo gira · dois dedos aproximam e deslocam · toque numa unidade para destacá-la</div>
      </div>
    </div>
  )
}
