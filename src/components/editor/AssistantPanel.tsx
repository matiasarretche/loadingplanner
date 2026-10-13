'use client'

import { DictationButton } from '@/components/DictationButton'
import { ATTACH_ACCEPT, ATTACH_HINT, fileIcon, interpretAttachments, MAX_ATTACH, pastedImages, shrinkImage } from '@/components/intake/attach'
import { IntakeCatalogItem, IntakeLines, IntakeRow, rowReady, toRows } from '@/components/intake/IntakeLines'
import { IntakeResult, unitsFor } from '@/domain/intake'
import { MODE_LABEL } from '@/lib/constants'
import { useEffect, useRef, useState } from 'react'
import type { LoadDoc } from '@/domain/types'
import { askAssistantAction } from '@/app/cargas/assistant-actions'
import type { AssistantReply } from '@/lib/ai/service'
import { kg, nf0, pct } from '../format'

interface Msg {
  role: 'user' | 'assistant' | 'error'
  text: string
  tools?: { tool: string; ok: boolean }[]
}

interface Props {
  versionId: number
  /** documento que a IA deve considerar: pré-visualização pendente ou carga do editor */
  baseDoc: LoadDoc
  preview: LoadDoc | null
  onPreview: (doc: LoadDoc | null) => void
  onApply: (doc: LoadDoc) => void
  /** pedido dividido em várias unidades: o editor mostra a proposta multi-unidade */
  onMulti?: (docs: LoadDoc[], notes: string[]) => void
  /** executa uma vez o texto vindo do atalho "Criar com IA" (sessionStorage) */
  autoRun?: boolean
  /** catálogo (SKU, nome, embalagem) para revisar pedidos anexados */
  catalog?: IntakeCatalogItem[]
  /** área do envio (regra das lonas até 14 m na leitura de pedidos anexados) */
  area?: string | null
}

const EXAMPLES = [
  'Monte um 40 HC 100% com Hidrosilo 10.000 L',
  'Contêiner de 20 pés com 60% Hidrosilo 5.000 L e 40% Hidrosilo 20.000 L',
  'Coloque 2 paletes de Hidrosilo 20.000 L e complete o espaço com 5.000 L',
  'Passe esta mesma composição para um 40 HC',
]

const TOOL_LABEL: Record<string, string> = {
  search_products: 'buscou produtos',
  get_product_logistics: 'consultou dados logísticos',
  list_equipment: 'consultou equipamentos',
  get_current_load: 'leu a carga',
  set_equipment: 'trocou o equipamento',
  add_pallets: 'adicionou paletes',
  compose_mix: 'montou mistura',
  remove_pallets: 'removeu paletes',
  replace_product: 'substituiu produto',
  repack_load: 'reorganizou',
  clear_load: 'esvaziou',
  remove_boxes: 'retirou caixas',
  add_loose_boxes: 'adicionou caixas soltas',
  balance_load: 'distribuiu o peso',
  optimize_mixed_pallets: 'montou paletes mistos',
  add_boxes_to_pallet: 'agregou caixas ao palete',
  split_into_units: 'dividiu o pedido em unidades',
}

export function AssistantPanel({ versionId, baseDoc, preview, onPreview, onApply, onMulti, autoRun, catalog = [], area }: Props) {
  const [open, setOpen] = useState(true)
  const [text, setText] = useState('')
  const [msgs, setMsgs] = useState<Msg[]>([])
  const [conversationId, setConversationId] = useState<number | null>(null)
  const [last, setLast] = useState<AssistantReply | null>(null)
  // estado simples (não transition): o 3D re-renderiza continuamente e uma transition poderia não concluir
  const [pending, setPending] = useState(false)
  const inputRef = useRef<HTMLTextAreaElement>(null)
  // pedido do cliente anexado (foto, PDF, Word, Excel…): interpretado e revisado antes de montar
  const [files, setFiles] = useState<File[]>([])
  const fileRef = useRef<HTMLInputElement>(null)
  const [intake, setIntake] = useState<IntakeResult | null>(null)
  const [rows, setRows] = useState<IntakeRow[]>([])
  const addFiles = async (list: File[]) => {
    const arr = await Promise.all(list.map(shrinkImage))
    setFiles((x) => [...x, ...arr].slice(0, MAX_ATTACH))
  }

  async function readAttachments() {
    if (!files.length || pending) return
    const t = text.trim()
    setMsgs((x) => [...x, { role: 'user', text: `📎 ${files.map((f) => f.name).join(', ')}${t ? `\n${t}` : ''}` }])
    setPending(true)
    const r = await interpretAttachments(t, files, area)
    setPending(false)
    if (!r.ok) {
      setMsgs((x) => [...x, { role: 'error', text: r.error }])
      return
    }
    setFiles([])
    setText('')
    setIntake(r.result)
    setRows(toRows(r.result.lines))
    const n = r.result.lines.length
    const open = r.result.lines.filter((l) => l.status !== 'MATCHED').length
    setMsgs((x) => [...x, { role: 'assistant', text: `${r.result.summary}\n${n} linha(s)${open ? ` — ${open} para você escolher/confirmar` : ''}. Confira abaixo e clique em “Montar na carga”.` }])
  }

  /** Pedido revisado → instrução para o assistente montar na carga (quantidades exatas, sem perguntar de novo). */
  function buildFromIntake() {
    const parts: string[] = []
    for (const l of rows) {
      const pack = catalog.find((c) => c.sku === l.sku)
      if (!pack || !l.quantity) continue
      const c = unitsFor(l.quantity, l.unit, pack)
      if ('error' in c) continue
      parts.push('pallets' in c ? `- ${c.pallets} pallet(s) completo(s) de ${pack.sku}` : `- ${c.units} un. de ${pack.sku}`)
    }
    setIntake(null)
    setRows([])
    send(`Armá en la carga actual este pedido del cliente (productos y cantidades ya confirmados, no vuelvas a preguntar por ellos):\n${parts.join('\n')}\nUsá las cantidades exactas en pallets mixtos con las reglas logísticas; si no entra en un solo equipo, dividilo en unidades.`)
  }

  // atalho da página principal: lê e consome o texto uma única vez
  const autoDone = useRef(false)
  useEffect(() => {
    if (!autoRun || autoDone.current) return
    autoDone.current = true
    let t = ''
    try {
      t = sessionStorage.getItem('lp:aiPrompt') ?? ''
      sessionStorage.removeItem('lp:aiPrompt')
    } catch {
      t = ''
    }
    if (t) send(t)
    // eslint-disable-next-line react-hooks/exhaustive-deps -- dispara só ao abrir
  }, [autoRun])

  function send(message: string) {
    const m = message.trim()
    if (!m || pending) return
    setMsgs((x) => [...x, { role: 'user', text: m }])
    setText('')
    setPending(true)
    void (async () => {
      let r: Awaited<ReturnType<typeof askAssistantAction>>
      try {
        r = await askAssistantAction({ conversationId, versionId, message: m, baseDoc })
      } catch {
        r = { ok: false, error: 'Falha de comunicação com o servidor.' }
      } finally {
        setPending(false)
      }
      if (!r.ok) {
        setMsgs((x) => [...x, { role: 'error', text: r.error }])
        return
      }
      setConversationId(r.reply.conversationId)
      setMsgs((x) => [...x, { role: 'assistant', text: r.reply.text, tools: r.reply.toolCalls }])
      if (r.reply.units && r.reply.units.length > 1 && onMulti) {
        setLast(r.reply)
        onMulti(r.reply.units, r.reply.unitNotes)
      } else if (r.reply.proposal) {
        setLast(r.reply)
        onPreview(r.reply.proposal)
      }
    })()
  }

  const b = last?.before, a = last?.after
  const row = (label: string, f: (t: NonNullable<typeof b>) => string) => (
    <tr>
      <td>{label}</td>
      <td className="num">{b ? f(b) : '—'}</td>
      <td className="num">
        <strong>{a ? f(a) : '—'}</strong>
      </td>
    </tr>
  )

  return (
    <div className="panel no-print" style={{ marginBottom: 12, borderColor: '#9fd8c0' }}>
      <div className="row" style={{ cursor: 'pointer' }} onClick={() => setOpen((o) => !o)}>
        <strong style={{ letterSpacing: '.04em' }}>{open ? '▾' : '▸'} ASSISTENTE IA</strong>
        <small className="muted">Instruções em linguagem natural · os cálculos são feitos pelo motor do sistema</small>
        <span className="spacer" />
        {open && msgs.length > 0 && (
          <button
            className="small"
            onClick={(e) => {
              e.stopPropagation()
              setMsgs([])
              setConversationId(null)
              setLast(null)
              onPreview(null)
            }}
          >
            Nova conversa
          </button>
        )}
      </div>
      {open && (
        <div className={preview ? 'grid assistant-grid with-preview' : 'grid'} style={{ gap: 12, marginTop: 10 }}>
          <div>
            {msgs.length > 0 && (
              <div style={{ maxHeight: 260, overflow: 'auto', display: 'flex', flexDirection: 'column', gap: 6, marginBottom: 8 }}>
                {msgs.map((m, i) => (
                  <div
                    key={i}
                    style={{
                      alignSelf: m.role === 'user' ? 'flex-end' : 'stretch',
                      background: m.role === 'user' ? '#e4f3ec' : m.role === 'error' ? 'var(--crit-bg)' : '#fafbfc',
                      color: m.role === 'error' ? 'var(--crit)' : undefined,
                      border: '1px solid var(--border)',
                      borderRadius: 8,
                      padding: '6px 10px',
                      whiteSpace: 'pre-wrap',
                      maxWidth: m.role === 'user' ? '80%' : undefined,
                    }}
                  >
                    {m.role === 'assistant' ? <RichText text={m.text} /> : m.text}
                    {m.tools && m.tools.length > 0 && (
                      <div className="muted" style={{ fontSize: 11, marginTop: 4 }}>
                        Ações: {m.tools.map((t) => `${TOOL_LABEL[t.tool] ?? t.tool}${t.ok ? '' : ' (falhou)'}`).join(' · ')}
                      </div>
                    )}
                  </div>
                ))}
                {pending && <div className="muted">Interpretando e calculando…</div>}
              </div>
            )}
            <form
              onSubmit={(e) => {
                e.preventDefault()
                if (files.length) void readAttachments()
                else send(text)
              }}
              className="row"
              style={{ alignItems: 'flex-end' }}
            >
              <label className="field" style={{ flex: 1 }}>
                O que você quer fazer?
                <textarea
                  ref={inputRef}
                  rows={2}
                  value={text}
                  maxLength={2000}
                  placeholder={EXAMPLES[0]}
                  onChange={(e) => setText(e.target.value)}
                  onKeyDown={(e) => {
                    e.stopPropagation()
                    if (e.key === 'Enter' && !e.shiftKey) {
                      e.preventDefault()
                      if (files.length) void readAttachments()
                      else send(text)
                    }
                  }}
                  onPaste={(e) => {
                    const imgs = pastedImages(e)
                    if (imgs.length) {
                      e.preventDefault()
                      void addFiles(imgs)
                    }
                  }}
                />
              </label>
              <input
                ref={fileRef}
                type="file"
                multiple
                accept={ATTACH_ACCEPT}
                style={{ display: 'none' }}
                onChange={(e) => {
                  const fl = e.target.files ? [...e.target.files] : []
                  e.target.value = ''
                  if (fl.length) void addFiles(fl)
                }}
              />
              <button type="button" onClick={() => fileRef.current?.click()} disabled={pending} title={`Anexar o pedido do cliente — ${ATTACH_HINT}. Também dá para colar uma captura (Ctrl+V).`}>
                📎
              </button>
              <DictationButton value={text} onChange={setText} disabled={pending} />
              <button className="primary" disabled={pending || (!text.trim() && !files.length)}>
                {pending ? 'Executando…' : files.length ? 'Ler pedido' : 'Executar'}
              </button>
            </form>
            {files.length > 0 && (
              <ul className="intake-files">
                {files.map((fl, k) => (
                  <li key={`${fl.name}-${k}`}>
                    {fileIcon(fl)} {fl.name}
                    <button type="button" className="small" onClick={() => setFiles((x) => x.filter((_, j) => j !== k))} title="Remover anexo">
                      ✕
                    </button>
                  </li>
                ))}
              </ul>
            )}
            {intake && (
              <div className="panel" style={{ marginTop: 8, background: '#f7faf8' }}>
                <strong>Pedido do cliente interpretado</strong>
                {(intake.customer.name || intake.destination || intake.mode || intake.incoterm || intake.equipment || intake.equipmentText || intake.orderRef) && (
                  <div className="muted" style={{ fontSize: 12, margin: '4px 0' }}>
                    O pedido cita:{' '}
                    {[
                      intake.customer.name && `cliente ${intake.customer.name.value}`,
                      intake.orderRef && `ref. ${intake.orderRef.value}`,
                      intake.destination && `destino ${intake.destination.value}`,
                      intake.mode && `modalidade ${MODE_LABEL[intake.mode.value] ?? intake.mode.value}`,
                      intake.incoterm && `Incoterm ${intake.incoterm.value}`,
                      (intake.equipment?.label ?? intake.equipmentText) && `equipamento ${intake.equipment?.label ?? intake.equipmentText}`,
                    ]
                      .filter(Boolean)
                      .join(' · ')}{' '}
                    — confira se bate com esta carga (não é alterado automaticamente).
                  </div>
                )}
                {intake.issues.length > 0 && (
                  <div className="alert warn" style={{ fontSize: 12, margin: '6px 0' }}>
                    {intake.issues.map((x, i) => (
                      <div key={i}>• {x}</div>
                    ))}
                  </div>
                )}
                <IntakeLines lines={rows} setLines={setRows} catalog={catalog} compact />
                <div className="row" style={{ marginTop: 8, gap: 6 }}>
                  <button className="primary" disabled={pending || !rows.length || !rows.every(rowReady)} onClick={buildFromIntake} title={rows.every(rowReady) ? 'O assistente monta o pedido nesta carga pelo motor (regras logísticas, paletes mistos e divisão em unidades)' : 'Escolha o produto e a quantidade de todas as linhas'}>
                    ✔ Montar na carga
                  </button>
                  <button onClick={() => (setIntake(null), setRows([]))}>Descartar</button>
                  {!rows.every(rowReady) && <small style={{ color: '#d62728' }}>Falta escolher produto/quantidade em {rows.filter((r) => !rowReady(r)).length} linha(s).</small>}
                </div>
              </div>
            )}
            {msgs.length === 0 && (
              <div className="row" style={{ marginTop: 6 }}>
                {EXAMPLES.map((ex) => (
                  <button key={ex} type="button" className="small" onClick={() => setText(ex)}>
                    {ex}
                  </button>
                ))}
              </div>
            )}
          </div>
          {preview && (
            <div className="panel" style={{ background: '#f6fbf8' }}>
              <strong>Pré-visualização</strong>
              <div className="muted" style={{ fontSize: 12, marginBottom: 6 }}>
                O 3D e os indicadores mostram a proposta. Nada foi salvo.
              </div>
              <table className="data compact">
                <thead>
                  <tr>
                    <th />
                    <th className="num">Atual</th>
                    <th className="num">Proposta</th>
                  </tr>
                </thead>
                <tbody>
                  {row('Paletes', (t) => nf0.format(t.pallets))}
                  {row('Caixas', (t) => nf0.format(t.boxes))}
                  {row('Payload', (t) => kg(t.payloadKg))}
                  {row('Payload %', (t) => pct(t.payloadPct))}
                  {row('Ocupação piso', (t) => pct(t.floorUtilPct))}
                  {row('Capacidade (litros)', (t) => (t.storageCapacityLiters ? nf0.format(t.storageCapacityLiters) : '—'))}
                </tbody>
              </table>
              {last && last.criticalAfter > 0 && <div className="alert error" style={{ marginTop: 8 }}>A proposta tem {last.criticalAfter} alerta(s) crítico(s).</div>}
              <div className="row" style={{ marginTop: 10 }}>
                <button
                  className="primary"
                  onClick={() => {
                    onApply(preview)
                    onPreview(null)
                    setMsgs((x) => [...x, { role: 'assistant', text: 'Composição aplicada ao editor. Revise e clique em "Salvar versão" para gravar.' }])
                  }}
                >
                  Aplicar composição
                </button>
                <button onClick={() => inputRef.current?.focus()} title="Escreva o ajuste: o assistente parte desta proposta">
                  Modificar
                </button>
                <button className="danger" onClick={() => onPreview(null)}>
                  Cancelar
                </button>
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  )
}

/** Markdown mínimo e seguro (sem HTML): **negrito**, listas com "-" e quebras de linha. */
function RichText({ text }: { text: string }) {
  const inline = (line: string) =>
    line.split(/(\*\*[^*]+\*\*)/g).map((part, i) => (part.startsWith('**') && part.endsWith('**') ? <strong key={i}>{part.slice(2, -2)}</strong> : <span key={i}>{part}</span>))
  return (
    <div style={{ whiteSpace: 'normal' }}>
      {text.split('\n').map((line, i) => {
        const t = line.trim()
        if (!t) return <div key={i} style={{ height: 6 }} />
        if (/^[-•*] /.test(t)) return <div key={i} style={{ paddingLeft: 14, textIndent: -10 }}>• {inline(t.slice(2))}</div>
        return <div key={i}>{inline(t)}</div>
      })}
    </div>
  )
}
