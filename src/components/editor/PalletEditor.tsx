'use client'

import { brandLabelFor } from '@/domain/brandLabels'
import { describeKitBoxes, kitBoxLines, kitFamilyOf, packKeyOf } from '@/domain/kitBoxes'
import dynamic from 'next/dynamic'
import { useMemo, useRef, useState } from 'react'
import { useStore } from 'zustand'
import { ORIENTATION_LABEL, Orientation, orientDims, Vec3 } from '@/domain/geometry'
import { distinctOrientations, naturalOrientations, nextFlip, nextYaw, reorientPosition } from '@/domain/orientation'
import { itemBox, palletSummary, validatePallet } from '@/domain/pallet'
import { dropZ, findFreePosition, placementProblem, restZ } from '@/domain/placement'
import { stackable } from '@/domain/policy'
import { DEFAULT_THRESHOLDS } from '@/domain/types'
import type { PackSnapshot, PalletDoc } from '@/domain/types'
import { newPhysicalCriticals } from '@/domain/issues'
import { kg, m3, mm, nf0, pct } from '../format'
import type { SceneBody, ViewPreset } from '../three/Scene3D'
import { createDocStore, newId } from './docStore'
import { IssuesList, Kpi, NumberInput, SNAP_OPTIONS, UnsavedBanner, useBeforeUnload, useEditorKeys, useUnsavedGuard, ViewButtons } from './ui'

const Scene3D = dynamic(() => import('../three/Scene3D').then((m) => m.Scene3D), { ssr: false, loading: () => <div className="hint">Carregando 3D…</div> })

export interface SaveResult {
  ok?: boolean
  error?: string
}

interface Props {
  initial: PalletDoc
  catalog: PackSnapshot[]
  readOnly: boolean
  save: (doc: PalletDoc) => Promise<SaveResult>
  /** título (padrão: "Montagem: <nome>") */
  heading?: string
  /** texto do botão de gravar (padrão: "Salvar montagem") */
  saveLabel?: string
  /** altura máxima do palete carregado (tabuleiro + caixas); sem valor, a altura é validada na carga */
  maxHeightMm?: number
  /** botão "Fechar" (quando usado como janela sobre outra tela) */
  onClose?: () => void
}

// caixas coletivas de kits (26 / meia caixa) têm chave própria (domain/kitBoxes)
const packKey = (p: PackSnapshot) => packKeyOf(p)

export function PalletEditor({ initial, catalog, readOnly, save, heading, saveLabel, maxHeightMm, onClose }: Props) {
  const [store] = useState(() => createDocStore<PalletDoc>(initial))
  const doc = useStore(store, (s) => s.doc)
  const saved = useStore(store, (s) => s.saved)
  const selection = useStore(store, (s) => s.selection)
  const { apply, applyTransient, checkpoint, revertTo, undo, redo, select, markSaved } = store.getState()
  const canUndo = useStore(store, (s) => s.past.length > 0)
  const canRedo = useStore(store, (s) => s.future.length > 0)

  const [view, setView] = useState<ViewPreset>('persp')
  const [viewNonce, setViewNonce] = useState(0)
  const [showLabels, setShowLabels] = useState(false)
  const [snapMm, setSnap] = useState(10)
  const [addPack, setAddPack] = useState(catalog[0] ? packKey(catalog[0]) : '')
  /** orientação escolhida ao adicionar; null = natural (maior face apoiada, menor altura) */
  const [addOrient, setAddOrient] = useState<Orientation | null>(null)
  const [addQty, setAddQty] = useState(1)
  const [filter, setFilter] = useState('')
  const [msg, setMsg] = useState<{ type: 'ok' | 'error' | 'warn'; text: string } | null>(null)
  // estado simples (não transition): o 3D re-renderiza continuamente e uma transition poderia não concluir
  const [saving, setSaving] = useState(false)

  // compara conteúdo (não referência): ações sem efeito ou desfazer até o salvo não marcam alteração
  const dirty = useMemo(() => doc !== saved && JSON.stringify(doc) !== JSON.stringify(saved), [doc, saved])
  useBeforeUnload(dirty)
  const rootRef = useRef<HTMLDivElement>(null)

  const summary = useMemo(() => palletSummary(doc), [doc])
  const issues = useMemo(() => {
    const out = validatePallet(doc)
    if (maxHeightMm && summary.totalHeightMm > maxHeightMm)
      out.push({ code: 'HEIGHT_LIMIT', severity: 'CRITICAL', message: `Palete com ${mm(summary.totalHeightMm)} de altura (máx. ${mm(maxHeightMm)} para este transporte).`, refs: [], value: summary.totalHeightMm, limit: maxHeightMm })
    return out
  }, [doc, maxHeightMm, summary.totalHeightMm])
  const invalid = useMemo(() => new Set(issues.filter((i) => i.severity === 'CRITICAL').flatMap((i) => i.refs)), [issues])

  const T = doc.palletType
  const P = T.dims
  const oh = T.overhangAllowed ? T.overhangMaxMm : 0
  // o palete não tem altura máxima: o limite é do equipamento (verificado na carga)
  const lo: Vec3 = { x: -oh, y: -oh, z: 0 }
  const hi: Vec3 = { x: P.l + oh, y: P.w + oh, z: maxHeightMm ? Math.max(0, maxHeightMm - P.h) : 10000 }
  const loadH = Math.max(summary.totalHeightMm - P.h, 0)
  const sceneH = Math.max(summary.totalHeightMm, 1200)

  const selItems = doc.items.filter((i) => selection.includes(i.id))
  const sel = selItems.length === 1 ? selItems[0] : null
  const selPack = sel ? doc.packs[sel.packId] : null

  const catalogPack = catalog.find((c) => packKey(c) === addPack) ?? (doc.packs[addPack] as PackSnapshot | undefined)
  const addOrientations = catalogPack ? naturalOrientations(catalogPack.dims, catalogPack.allowedOrientations) : (['LWH'] as Orientation[])
  const effOrient = addOrient && addOrientations.includes(addOrient) ? addOrient : addOrientations[0]

  const bodies: SceneBody[] = doc.items.map((it, i) => {
    const b = itemBox(doc, it)
    const pack = doc.packs[it.packId]
    return {
      id: it.id,
      min: { x: b.min.x, y: b.min.y, z: b.min.z + P.h },
      size: b.size,
      color: pack?.color ?? '#999',
      print: pack?.sku,
      brand: pack ? brandLabelFor(pack) ?? undefined : undefined,
      // caixa coletiva de kits: quantos kits leva (ex.: KIT-HF ×26)
      label: pack?.kitBox ? `${pack.sku} ×${pack.kitBox.kits}` : `${pack?.sku ?? '?'} #${i + 1}`,
      selected: selection.includes(it.id),
      invalid: invalid.has(it.id),
      locked: it.locked,
    }
  })

  const obstacles = (except: Set<string>) =>
    doc.items.filter((i) => !except.has(i.id)).map((i) => ({ box: itemBox(doc, i), stackable: stackable(doc.packs[i.packId]?.stackable) }))

  function addItems() {
    if (!catalogPack) return
    const key = packKey(catalogPack)
    const size = orientDims(catalogPack.dims, effOrient)
    let placed = 0
    apply((d) => {
      const items = [...d.items]
      const packs = d.packs[key] ? d.packs : { ...d.packs, [key]: catalogPack }
      const tmp: PalletDoc = { ...d, packs, items }
      for (let n = 0; n < addQty; n++) {
        const obs = tmp.items.map((i) => ({ box: itemBox(tmp, i), stackable: stackable(tmp.packs[i.packId]?.stackable) }))
        const p = findFreePosition(obs, size, { lo, hi, allowStacking: true, minSupportPct: 100 })
        if (!p) break
        tmp.items.push({ id: newId('i'), packId: key, pos: p, orientation: effOrient, locked: false })
        placed++
      }
      return placed ? { ...tmp, items: [...tmp.items] } : d
    })
    setMsg(placed < addQty ? { type: 'warn', text: `Adicionados ${placed} de ${addQty}: sem espaço livre dentro dos limites do palete.` } : null)
  }

  const updateSel = (fn: (it: PalletDoc['items'][number]) => PalletDoc['items'][number]) =>
    apply((d) => ({ ...d, items: d.items.map((i) => (selection.includes(i.id) && !i.locked ? fn(i) : i)) }))

  const handlers = {
    step: snapMm,
    enabled: !readOnly,
    move: (dx: number, dy: number, dz: number) => updateSel((i) => ({ ...i, pos: { x: i.pos.x + dx, y: i.pos.y + dy, z: Math.max(0, i.pos.z + dz) } })),
    rotate: () => rotateSel(),
    flip: () => flipSel(),
    remove: () => {
      apply((d) => ({ ...d, items: d.items.filter((i) => !selection.includes(i.id) || i.locked) }))
      select([])
    },
    duplicate: () => duplicateSel(),
    undo,
    redo,
  }
  useEditorKeys(handlers)

  /**
   * Girar (R) / tombar (T): muda a orientação física (lógica comum em domain/orientation), mantém o
   * centro da caixa, apoia e, se colidir, procura o lugar livre mais próximo.
   */
  function reorientSel(kind: 'flip' | 'yaw' | Orientation) {
    let blocked = 0, noRoom = 0, done = 0
    apply((d) => {
      const items = [...d.items]
      for (const id of selection) {
        const idx = items.findIndex((x) => x.id === id)
        const it = items[idx]
        const pack = it && d.packs[it.packId]
        if (!it || it.locked || !pack) continue
        const o = kind === 'flip' ? nextFlip(it.orientation, pack.dims, pack.allowedOrientations) : kind === 'yaw' ? nextYaw(it.orientation, pack.dims, pack.allowedOrientations) : kind
        if (!o || o === it.orientation) {
          blocked++
          continue
        }
        const tmp: PalletDoc = { ...d, items }
        const obs = items.filter((x) => x.id !== id).map((x) => ({ box: itemBox(tmp, x), stackable: stackable(d.packs[x.packId]?.stackable) }))
        const pos = reorientPosition(itemBox(tmp, it), orientDims(pack.dims, o), obs, { lo, hi })
        if (!pos) {
          noRoom++
          continue
        }
        items[idx] = { ...it, orientation: o, pos }
        done++
      }
      return done ? { ...d, items } : d
    })
    if (blocked) setMsg({ type: 'warn', text: kind === 'flip' ? 'Sem outra face possível: o cadastro do produto restringe as orientações (ex.: "manter em pé") ou as faces são iguais.' : 'Girar não muda esta caixa (base quadrada) ou a orientação não é permitida no cadastro.' })
    else if (noRoom) setMsg({ type: 'warn', text: `${noRoom} caixa(s) sem espaço livre na nova orientação (altura/limites do palete).` })
  }
  const rotateSel = () => reorientSel('yaw')
  /** Tomba os volumes selecionados (outra face na vertical), dentro das orientações permitidas do produto. */
  const flipSel = () => reorientSel('flip')
  function duplicateSel() {
    if (!selItems.length) return
    const ids: string[] = []
    apply((d) => {
      const items = [...d.items]
      for (const it of selItems) {
        const tmp: PalletDoc = { ...d, items }
        const obs = items.map((i) => ({ box: itemBox(tmp, i), stackable: stackable(d.packs[i.packId]?.stackable) }))
        const p = findFreePosition(obs, itemBox(d, it).size, { lo, hi, allowStacking: true, minSupportPct: 100 })
        if (!p) continue
        const id = newId('i')
        ids.push(id)
        items.push({ ...it, id, pos: p, locked: false })
      }
      return { ...d, items }
    })
    if (ids.length) select(ids)
    else setMsg({ type: 'warn', text: 'Sem espaço livre para duplicar.' })
  }
  function settleSel() {
    updateSel((i) => {
      const b = itemBox(doc, i)
      const z = dropZ(obstacles(new Set([i.id])), { ...b, min: { ...b.min, z: b.min.z } }, 0)
      return { ...i, pos: { ...i.pos, z } }
    })
  }

  // ---- arrasto no 3D: validação ao soltar (posição inválida volta à última válida)
  const dragFrom = useRef<PalletDoc | null>(null)
  const itemObstacles = (d: PalletDoc, exceptId: string) =>
    d.items.filter((i) => i.id !== exceptId).map((i) => ({ box: itemBox(d, i), stackable: stackable(d.packs[i.packId]?.stackable) }))
  function endDragCheck(id: string) {
    const before = dragFrom.current
    dragFrom.current = null
    if (!before) return
    const now = store.getState().doc
    const it = now.items.find((i) => i.id === id)
    if (now === before || !it) return
    const why =
      placementProblem(itemObstacles(now, id), itemBox(now, it), { lo, hi, minSupportPct: DEFAULT_THRESHOLDS.minSupportPct }) ??
      newPhysicalCriticals(validatePallet(before), validatePallet(now))[0]?.message ??
      null
    if (!why) return
    revertTo(before)
    setMsg({ type: 'warn', text: `Posição inválida: ${why}. A caixa voltou à última posição válida.` })
  }

  async function doSave(): Promise<boolean> {
    setSaving(true)
    try {
      const r = await save(doc)
      if (r.ok) {
        markSaved(doc)
        setMsg({ type: 'ok', text: saveLabel ? 'Alterações aplicadas.' : 'Montagem salva.' })
        return true
      } else setMsg({ type: 'error', text: r.error ?? 'Erro ao salvar.' })
      return false
    } catch {
      setMsg({ type: 'error', text: 'Falha de comunicação com o servidor.' })
      return false
    } finally {
      setSaving(false)
    }
  }
  const guard = useUnsavedGuard(dirty, rootRef, () => doSave())

  const filtered = catalog.filter((c) => !filter || `${c.sku} ${c.name}`.toLowerCase().includes(filter.toLowerCase()))
  const cap = summary.capacityPct

  return (
    <div ref={rootRef}>
      {guard.modal}
      <UnsavedBanner dirty={dirty} />
      <div className="page-head">
        <h1>
          {heading ?? `Montagem: ${doc.name}`} <small>· {T.code}</small>
        </h1>
        {dirty && <span className="badge WARNING">● Alterações não salvas</span>}
        {!readOnly && (
          <button className="primary" onClick={doSave} disabled={saving || !dirty}>
            {saving ? 'Salvando…' : saveLabel ?? 'Salvar montagem'}
          </button>
        )}
        {onClose && <button onClick={onClose}>Fechar</button>}
      </div>
      {msg && <div className={`alert ${msg.type}`}>{msg.text}</div>}
      <div className="editor">
        <div className="side">
          {!readOnly && (
            <div className="panel">
              <h3 style={{ marginTop: 0 }}>Adicionar volumes</h3>
              <input placeholder="Filtrar SKU…" value={filter} onChange={(e) => setFilter(e.target.value)} style={{ width: '100%', marginBottom: 6 }} />
              <div className="list-select">
                {filtered.map((c) => (
                  <button key={packKey(c)} className={addPack === packKey(c) ? 'sel' : ''} onClick={() => {
                      setAddPack(packKey(c))
                      setAddOrient(null) // volta para a orientação natural do novo produto
                    }}>
                    <span className="swatch" style={{ background: c.color }} />
                    <span>
                      <strong>{c.sku}</strong> v{c.version} · {c.packageType}
                      <br />
                      <small>
                        {c.dims.l}×{c.dims.w}×{c.dims.h} mm · {kg(c.grossKg)}
                        {c.verification !== 'VERIFIED' && ' · ⚠ dados não verificados'}
                      </small>
                    </span>
                  </button>
                ))}
                {filtered.length === 0 && <small>Nenhuma embalagem cadastrada.</small>}
              </div>
              <div className="grid" style={{ gap: 8, marginTop: 8 }}>
                <label className="field">
                  Orientação
                  <select value={effOrient} onChange={(e) => setAddOrient(e.target.value as Orientation)}>
                    {addOrientations.map((o) => (
                      <option key={o} value={o}>
                        {ORIENTATION_LABEL[o]}
                      </option>
                    ))}
                  </select>
                </label>
                <div className="row">
                  <label className="field" style={{ width: 90 }}>
                    Quantidade
                    <input type="number" min={1} max={500} value={addQty} onChange={(e) => setAddQty(Math.max(1, Math.min(500, Number(e.target.value) || 1)))} />
                  </label>
                  <button className="primary" onClick={addItems} disabled={!catalogPack} style={{ alignSelf: 'flex-end' }}>
                    Adicionar
                  </button>
                </div>
                <small>Posiciona na próxima posição livre, camada a camada, respeitando o overhang. A altura máxima é validada na carga, conforme o equipamento.</small>
              </div>
            </div>
          )}
          <div className="panel">
            <h3 style={{ marginTop: 0 }}>Montagem</h3>
            <div className="grid" style={{ gap: 8 }}>
              <label className="field">
                Nome
                <input
                  defaultValue={doc.name}
                  disabled={readOnly}
                  onBlur={(e) => e.target.value.trim() && e.target.value !== doc.name && apply((d) => ({ ...d, name: e.target.value.trim() }))}
                />
              </label>
              <label className="field">
                Acessórios (filme, cantoneiras…) kg
                <NumberInput value={doc.accessoriesKg} disabled={readOnly} onCommit={(v) => apply((d) => ({ ...d, accessoriesKg: Math.max(0, v) }))} />
              </label>
              <label className="check" title="Regra Pacifil: todos os paletes são empilháveis sempre que houver altura útil">
                <input type="checkbox" checked={stackable(doc.stackable)} disabled />
                Aceita outro palete por cima <small className="muted">(sempre, regra Pacifil)</small>
              </label>
              {stackable(doc.stackable) && (
                <label className="field">
                  Peso máx. por cima (kg, vazio = sem limite)
                  <input
                    defaultValue={doc.maxTopKg ?? ''}
                    disabled={readOnly}
                    onBlur={(e) => {
                      const v = e.target.value.trim()
                      apply((d) => ({ ...d, maxTopKg: v === '' ? null : Math.max(0, Number(v.replace(',', '.')) || 0) }))
                    }}
                  />
                </label>
              )}
            </div>
            <p className="muted" style={{ fontSize: 12 }}>
              Palete: {P.l} × {P.w} × {P.h || '?'} mm · tara {T.tareKg ? kg(T.tareKg) : '?'} · overhang{' '}
              {T.overhangAllowed ? mm(T.overhangMaxMm) : 'não'}
            </p>
          </div>
        </div>

        <div className="canvas-wrap">
          <div className="toolbar">
            <ViewButtons view={view} setView={(v) => { setView(v); setViewNonce((n) => n + 1) }} views={['persp', 'top', 'side', 'front']} />
            <button className={`small ${showLabels ? 'active' : ''}`} onClick={() => setShowLabels((s) => !s)}>
              Etiquetas
            </button>
            <select value={snapMm} onChange={(e) => setSnap(Number(e.target.value))} title="Passo de movimento" style={{ fontSize: 12, padding: '2px 4px' }}>
              {SNAP_OPTIONS.map((s) => (
                <option key={s} value={s}>
                  Passo {s} mm
                </option>
              ))}
            </select>
            <span className="spacer" />
            {!readOnly && (
              <>
                <button className="small" onClick={undo} disabled={!canUndo}>
                  ↶ Desfazer
                </button>
                <button className="small" onClick={redo} disabled={!canRedo}>
                  ↷ Refazer
                </button>
              </>
            )}
          </div>
          <Scene3D
            showPrint
            bounds={{
              kind: 'pallet',
              size: { x: P.l, y: P.w, z: sceneH },
              deck: { size: { x: P.l, y: P.w, z: Math.max(P.h, 1) }, color: '#b48a5a' },
              limitBox: oh > 0 && loadH > 0 ? { min: { x: -oh, y: -oh, z: P.h }, size: { x: P.l + 2 * oh, y: P.w + 2 * oh, z: loadH } } : undefined,
            }}
            bodies={bodies}
            view={view}
            viewNonce={viewNonce}
            showWalls={false}
            showRoof={false}
            showLabels={showLabels}
            snapMm={snapMm}
            cg={doc.items.length ? summary.cg : null}
            onSelect={(id, add) => select(id == null ? [] : add ? (selection.includes(id) ? selection.filter((x) => x !== id) : [...selection, id]) : [id])}
            gizmo={!readOnly}
            onDragStart={() => {
              if (readOnly) return
              checkpoint()
              dragFrom.current = store.getState().doc
            }}
            onDragEnd={endDragCheck}
            onMove={(id, min, how) =>
              !readOnly &&
              applyTransient((d) => ({
                ...d,
                items: d.items.map((i) => {
                  if (i.id !== id || i.locked) return i
                  const size = itemBox(d, i).size
                  const local = { x: min.x, y: min.y, z: min.z - P.h }
                  // no plano a caixa assenta na superfície de baixo; pela seta azul, a altura é livre (validada ao soltar)
                  const z = how === 'plane' ? restZ(itemObstacles(d, i.id), { min: local, size }, 0) : Math.max(0, local.z)
                  return { ...i, pos: { ...local, z } }
                }),
              }))
            }
          />
          {msg && msg.type !== 'ok' && (
            <div className={`canvas-msg alert ${msg.type}`} onClick={() => setMsg(null)} title="Clique para fechar">
              {msg.text}
            </div>
          )}
          <div className="hint">
            <strong>Câmera:</strong> esq. gira · dir., roda pressionada ou Shift+esq. desloca · roda: zoom no cursor · ⌖ Centralizar<br />
            Arraste a caixa (assenta na superfície de baixo) ou as setas coloridas X/Y/Z · teclas: setas/PgUp/PgDn ({snapMm} mm; Shift ×10) · R gira · T tomba · Ctrl+D duplica · Del apaga · Shift+clique multi-seleção
          </div>
        </div>

        <div className="side">
          {sel && selPack ? (
            <div className="panel">
              <h3 style={{ marginTop: 0 }}>
                <span className="swatch" style={{ background: selPack.color }} />
                {selPack.sku} v{selPack.version}
              </h3>
              <div className="muted" style={{ fontSize: 12, marginBottom: 6 }}>
                {selPack.name} · {selPack.dims.l}×{selPack.dims.w}×{selPack.dims.h} mm · {kg(selPack.grossKg)}
              </div>
              <div className="muted" style={{ fontSize: 11 }}>Posição (mm) — x / y / z (z a partir do tabuleiro)</div>
              <div className="xyz">
                {(['x', 'y', 'z'] as const).map((a) => (
                  <NumberInput
                    key={a}
                    value={sel.pos[a]}
                    disabled={readOnly || sel.locked}
                    title={a}
                    onCommit={(v) => apply((d) => ({ ...d, items: d.items.map((i) => (i.id === sel.id ? { ...i, pos: { ...i.pos, [a]: a === 'z' ? Math.max(0, v) : v } } : i)) }))}
                  />
                ))}
              </div>
              <label className="field" style={{ marginTop: 6 }}>
                Orientação
                <select
                  value={sel.orientation}
                  disabled={readOnly || sel.locked}
                  onChange={(e) => reorientSel(e.target.value as Orientation)}
                >
                  {[...new Set([sel.orientation, ...distinctOrientations(selPack.dims, selPack.allowedOrientations)])].map((o) => {
                    const d = orientDims(selPack.dims, o)
                    return (
                      <option key={o} value={o}>
                        {ORIENTATION_LABEL[o]} — {d.x}×{d.y}×{d.z} mm
                      </option>
                    )
                  })}
                </select>
              </label>
            </div>
          ) : (
            selItems.length > 1 && <div className="panel">{selItems.length} itens selecionados</div>
          )}
          {!readOnly && selItems.length > 0 && (
            <div className="row">
              <button className="small" onClick={rotateSel}>
                ⟳ Girar 90°
              </button>
              <button className="small" onClick={flipSel} title="Tombar: outra face na vertical (tecla T)">
                ⤾ Tombar
              </button>
              <button className="small" onClick={duplicateSel}>
                Duplicar
              </button>
              <button className="small" onClick={settleSel}>
                Assentar
              </button>
              <button className="small" onClick={() => apply((d) => ({ ...d, items: d.items.map((i) => (selection.includes(i.id) ? { ...i, locked: !i.locked } : i)) }))}>
                {selItems.every((i) => i.locked) ? 'Desbloquear' : 'Bloquear'}
              </button>
              <button className="small danger" onClick={handlers.remove}>
                Excluir
              </button>
            </div>
          )}
          <div className="panel">
            <div className="kpis">
              <Kpi k="Volumes" v={nf0.format(summary.packages)} s={`${nf0.format(summary.units)} unidades`} />
              <Kpi k="Peso bruto palete" v={kg(summary.grossKg)} s={`líq. ${kg(summary.netKg)} · tara ${kg(summary.tareKg)}`} />
              <Kpi
                k="Capacidade"
                v={cap == null ? 'não cadastrada' : pct(cap)}
                s={summary.maxLoadKg ? `de ${kg(summary.maxLoadKg)}` : undefined}
                meter={cap}
                level={cap != null && cap > 100 ? 'CRITICAL' : undefined}
              />
              <Kpi
                k="Altura total"
                v={mm(summary.totalHeightMm)}
                s={maxHeightMm ? `máx. ${mm(maxHeightMm)} (transporte)` : 'limite: equipamento da carga'}
                level={maxHeightMm && summary.totalHeightMm > maxHeightMm ? 'CRITICAL' : undefined}
              />
              <Kpi k="CBM (envelope)" v={m3(summary.cbmEnvelope)} s={`volumes ${m3(summary.cbmPackages)}`} />
              <Kpi k="Ocupação superfície" v={pct(summary.surfaceUtilPct)} meter={summary.surfaceUtilPct} />
              <Kpi k="Ocupação volume" v={pct(summary.volumeUtilPct)} meter={summary.volumeUtilPct} />
              <Kpi k="Envelope L × W" v={`${nf0.format(summary.envelope.size.x)} × ${nf0.format(summary.envelope.size.y)}`} s="mm" />
            </div>
          </div>
          <div className="panel">
            <IssuesList issues={issues} onPick={(refs) => select(refs)} />
          </div>
          {doc.items.length > 0 && (
            <details className="panel">
              <summary>
                <strong>Itens ({doc.items.length})</strong>
              </summary>
              <div className="list-select" style={{ maxHeight: 220, marginTop: 6 }}>
                {doc.items.map((it, i) => (
                  <button
                    key={it.id}
                    className={selection.includes(it.id) ? 'sel' : ''}
                    onClick={(e) => select(e.shiftKey ? [...selection, it.id] : [it.id])}
                    style={invalid.has(it.id) ? { color: 'var(--crit)' } : undefined}
                  >
                    {it.locked ? '🔒 ' : ''}
                    {doc.packs[it.packId]?.sku} #{i + 1} · x {it.pos.x} y {it.pos.y} z {it.pos.z} · {it.orientation}
                  </button>
                ))}
              </div>
            </details>
          )}
          {summary.bySku.length > 0 && (
            <div className="panel">
              <table className="data compact">
                <thead>
                  <tr>
                    <th>SKU</th>
                    <th className="num">Vol.</th>
                    <th className="num">Un.</th>
                    <th className="num" title="Produto + caixa">c/ emb.</th>
                  </tr>
                </thead>
                <tbody>
                  {summary.bySku.map((l) => (
                    <tr key={l.sku}>
                      <td>
                        {l.sku}
                        {/* kits: caixas por tipo (26 / meia caixa / individuais) */}
                        {kitFamilyOf(l.sku) && (
                          <div className="muted" style={{ fontSize: 11 }}>
                            {describeKitBoxes(kitBoxLines(doc.items.map((it) => doc.packs[it.packId]).filter((k) => k?.sku === l.sku)))}
                          </div>
                        )}
                      </td>
                      <td className="num">{l.packages}</td>
                      <td className="num">{l.units}</td>
                      <td className="num">{kg(l.grossKg)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      </div>
    </div>
  )
}
