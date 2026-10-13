'use client'

import { useRouter } from 'next/navigation'
import { useEffect, useRef, useState } from 'react'
import { DictationButton } from '@/components/DictationButton'
import { ATTACH_ACCEPT, ATTACH_HINT, fileIcon, interpretAttachments, MAX_ATTACH, pastedImages, shrinkImage, takePendingIntake } from '@/components/intake/attach'
import { BODY_LIMITS, fmtMB, intakeSizeError } from '@/components/intake/limits'
import { IntakeLines, IntakeRow, toRows } from '@/components/intake/IntakeLines'
import { IntakeDraft, IntakeResult, missingForCreate, ReadField } from '@/domain/intake'
import { Area, AREA_LABEL } from '@/lib/areas'
import { orderRefFieldLabel, orderRefInitial, PROFORMA_PREFIX } from '@/lib/orderRef'
import { lonaForArea, LONA_RULE_TEXT } from '@/domain/lonaRule'
import { INCOTERMS } from '@/lib/constants'
import { isService, serviceFromMode, SHIPMENT_SERVICES, TYPE_INFO } from '@/domain/shipmentType'
import { createFromIntakeAction } from './actions'
import { originOrDefault, placeLabels } from '@/lib/places'
import { CountryInput } from '@/components/CountryInput'
import { parseBrNumber, parseMm } from '@/domain/brNumber'

interface Props {
  areas: Area[]
  customers: { id: number; name: string; country: string }[]
  equipment: { value: string; label: string; mode: string }[]
  catalog: { sku: string; name: string; unitsPerPackage: number; netKg: number }[]
}


const nf = new Intl.NumberFormat('pt-BR', { maximumFractionDigits: 2 })

export function OrderIntake(p: Props) {
  const router = useRouter()
  const [files, setFiles] = useState<File[]>([])
  const [text, setText] = useState('')
  const [busy, setBusy] = useState<'read' | 'create' | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [drag, setDrag] = useState(false)
  const [res, setRes] = useState<IntakeResult | null>(null)
  const [lines, setLines] = useState<IntakeRow[]>([])
  const [d, setD] = useState<Omit<IntakeDraft, 'lines'>>({ area: p.areas[0] ?? '', customerId: null, newCustomer: '', country: '', mode: '', incoterm: '', equipment: '', orderRef: orderRefInitial(p.areas[0]), originPlace: '', destinationPlace: '', customerAddress: '', notes: '' })
  // endereço de coleta editado pelo usuário (senão, a fábrica no rodoviário)
  const [originTouched, setOriginTouched] = useState(false)
  const [notes, setNotes] = useState<string[]>([])
  const fileRef = useRef<HTMLInputElement>(null)

  async function addFiles(list: FileList | File[]) {
    const arr = await Promise.all([...list].map(shrinkImage))
    setFiles((f) => [...f, ...arr].slice(0, MAX_ATTACH))
  }

  function load(x: IntakeResult) {
    setRes(x)
    setLines(toRows(x.lines))
    setOriginTouched(false)
    const eqMode = x.equipment ? p.equipment.find((e) => e.value === x.equipment!.value)?.mode : undefined
    // tipo de envio: o lido pela IA (marítimo/rodoviário/aéreo → com equipamento; LCL/courier só com evidência)
    const mode = x.mode?.value ? (isService(x.mode.value) ? x.mode.value : serviceFromMode(x.mode.value)) : ''
    setD({
      area: d.area || (p.areas[0] ?? ''),
      customerId: x.customer.matchedId,
      newCustomer: x.customer.matchedId ? '' : x.customer.name?.value ?? '',
      country: x.destination?.value ?? '',
      mode,
      incoterm: x.incoterm?.value ?? '',
      // equipamento citado só vale se for da modalidade lida (nada é deduzido)
      equipment: x.equipment && (!mode || (isService(mode) && TYPE_INFO[mode].equipment && eqMode === TYPE_INFO[mode].mode)) ? x.equipment.value : '',
      // exportação: "Proforma " pronto para completar o número (se o pedido não trouxer referência)
      orderRef: x.orderRef?.value ?? orderRefInitial(d.area || p.areas[0]),
      notes: x.notes ?? '',
    })
  }

  async function interpret(t = text, fs = files) {
    if (!fs.length && !t.trim()) return
    setBusy('read')
    setError(null)
    const r = await interpretAttachments(t, fs, d.area)
    setBusy(null)
    if (!r.ok) return setError(r.error)
    load(r.result)
  }

  // anexos/texto vindos do Assistente IA da página principal: interpreta direto ao abrir
  const autoDone = useRef(false)
  useEffect(() => {
    if (autoDone.current) return
    autoDone.current = true
    const pend = takePendingIntake()
    if (!pend) return
    /* eslint-disable react-hooks/set-state-in-effect -- consome uma única vez o que veio da página principal */
    setFiles(pend.files)
    setText(pend.text)
    /* eslint-enable react-hooks/set-state-in-effect */
    void interpret(pend.text, pend.files)
    // eslint-disable-next-line react-hooks/exhaustive-deps -- dispara só ao abrir
  }, [])

  /** Muda a área do pedido e troca as lonas até 14 m para a linha da área (mesma medida e espessura). */
  function changeArea(area: string) {
    // o campo Proforma/Pedido acompanha a área (só troca o prefixo vazio, nunca um número digitado)
    setD((x) => ({ ...x, area, orderRef: !x.orderRef.trim() || x.orderRef === PROFORMA_PREFIX ? orderRefInitial(area) : x.orderRef }))
    if (area !== 'EXPORT' && area !== 'DOMESTIC') return
    setLines((ls) =>
      ls.map((l) => {
        const cur = l.sku ? p.catalog.find((c) => c.sku === l.sku) : undefined
        const alt = cur ? lonaForArea(cur, area, p.catalog) : null
        return alt ? { ...l, sku: alt.sku, note: `Linha ajustada pela regra das lonas (${area === 'EXPORT' ? 'exportação → Lona padrão' : 'mercado interno → Lona BPF'}).` } : l
      }),
    )
  }

  // altura / divisor / comprimento digitados no formato brasileiro ("1.800", "1,8 m")
  const [numText, setNumText] = useState<{ h: string; div: string; len: string }>({ h: '', div: '', len: '' })
  const hNum = parseMm(numText.h)
  const divNum = parseBrNumber(numText.div)
  const lenNum = parseMm(numText.len)
  const numError =
    Number.isNaN(hNum) || (hNum != null && (hNum < 300 || hNum > 4000 || !Number.isInteger(hNum)))
      ? 'Altura máx. do palete: entre 300 e 4.000 mm, no formato brasileiro (ex.: 1.800 ou 1,8 m).'
      : Number.isNaN(divNum) || (divNum != null && (divNum < 1000 || divNum > 10000 || !Number.isInteger(divNum)))
        ? 'Divisor volumétrico: entre 1.000 e 10.000 (ex.: 5.000).'
        : Number.isNaN(lenNum) || (lenNum != null && (lenNum < 2000 || lenNum > 25000 || !Number.isInteger(lenNum)))
          ? 'Comprimento do caminhão: entre 2.000 e 25.000 mm (ex.: 15.300 ou 15,3 m).'
          : null
  // endereço de coleta: a fábrica (Pacifil Sapiranga) se o pedido não disser outro e o usuário não editar
  const svc0 = isService(d.mode) ? d.mode : null
  const originShown = originOrDefault(d.originPlace ?? '', svc0 ? TYPE_INFO[svc0].placeMode : d.mode, originTouched)
  const draft: IntakeDraft = {
    ...d,
    originPlace: originShown,
    maxHeightMm: hNum != null && !Number.isNaN(hNum) ? hNum : null,
    courierDivisor: divNum != null && !Number.isNaN(divNum) ? divNum : null,
    lengthMm: lenNum != null && !Number.isNaN(lenNum) ? lenNum : null,
    lines: lines.map((l) => ({ sku: l.sku, quantity: l.quantity, unit: l.unit, sourceText: l.sourceText })),
  }
  const missing = res ? [...missingForCreate(draft), ...(numError ? [numError] : [])] : []

  async function create() {
    setBusy('create')
    setError(null)
    try {
      const r = await createFromIntakeAction(draft)
      if (!r.ok) {
        setError(r.error)
        setNotes(r.notes ?? [])
        return
      }
      router.push(`/cargas/${r.planId}`)
    } catch {
      setError('Falha de comunicação com o servidor.')
    } finally {
      setBusy(null)
    }
  }


  // ---------------------------------------------------------------- 1 · entrada
  if (!res) {
    // tudo segue num envio só (limite de 4 MB): mostra o total e avisa antes de interpretar
    const filesBytes = files.reduce((s, f) => s + f.size, 0)
    const sizeError = intakeSizeError(files, text)
    return (
      <div className="intake">
        <p className="muted" style={{ marginTop: 0 }}>
          Anexe o que o cliente mandou — foto ou captura de uma lista, PDF da ordem de compra, documento Word, planilha Excel/CSV, cotação anterior — e/ou cole ou dite o texto. O assistente identifica os produtos do catálogo e as quantidades, mostra um resumo para você conferir e pergunta só o que faltar. Nada é gravado até você confirmar.
        </p>
        <div
          className={`intake-drop ${drag ? 'on' : ''}`}
          onDragOver={(e) => {
            e.preventDefault()
            setDrag(true)
          }}
          onDragLeave={() => setDrag(false)}
          onDrop={(e) => {
            e.preventDefault()
            setDrag(false)
            if (e.dataTransfer.files.length) addFiles(e.dataTransfer.files)
          }}
          onClick={() => fileRef.current?.click()}
          role="button"
          tabIndex={0}
        >
          <input ref={fileRef} type="file" multiple accept={ATTACH_ACCEPT} style={{ display: 'none' }} onChange={(e) => (e.target.files && addFiles(e.target.files), (e.target.value = ''))} />
          <strong>📎 Arraste os arquivos aqui ou clique para escolher</strong>
          <div className="muted" style={{ fontSize: 12 }}>
            {ATTACH_HINT} · também dá para colar uma captura (Ctrl+V) no campo de texto
          </div>
        </div>
        {files.length > 0 && (
          <ul className="intake-files">
            {files.map((f, i) => (
              <li key={`${f.name}-${i}`}>
                {fileIcon(f)} {f.name} <small className="muted">({nf.format(f.size / 1024)} KB)</small>
                <button className="small" type="button" onClick={() => setFiles((x) => x.filter((_, k) => k !== i))} title="Remover">
                  ✕
                </button>
              </li>
            ))}
            <li className="muted" style={{ fontSize: 12 }}>
              Total: {fmtMB(filesBytes, true)} de {fmtMB(BODY_LIMITS.intakeTotal)}
            </li>
          </ul>
        )}
        {sizeError && <div className="alert warn" style={{ marginTop: 8 }}>{sizeError}</div>}
        <label className="field" style={{ marginTop: 10 }}>
          Texto do pedido (colado, digitado ou ditado) — Enter interpreta, Shift+Enter quebra linha
          <textarea
            value={text}
            rows={5}
            maxLength={20000}
            onChange={(e) => setText(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
                e.preventDefault()
                void interpret()
              }
            }}
            onPaste={(e) => {
              const imgs = pastedImages(e)
              if (imgs.length) {
                e.preventDefault()
                addFiles(imgs)
              }
            }}
            placeholder="Ex.: Buenos días, necesitamos 2 contenedores de 40': 300 silobolsas 9 pies × 60 m 235 micrones y 50 lonas 8×50…"
          />
        </label>
        <div className="row" style={{ alignItems: 'center', gap: 8 }}>
          {p.areas.length > 1 && (
            <select value={d.area} onChange={(e) => setD({ ...d, area: e.target.value })} title={`Área do pedido. ${LONA_RULE_TEXT}`}>
              {p.areas.map((a) => (
                <option key={a} value={a}>
                  {AREA_LABEL[a]}
                </option>
              ))}
            </select>
          )}
          <button className="primary" onClick={() => interpret()} disabled={busy !== null || (!files.length && !text.trim()) || Boolean(sizeError)}>
            {busy === 'read' ? 'Lendo o pedido…' : '✨ Interpretar pedido'}
          </button>
          <DictationButton value={text} onChange={setText} disabled={busy !== null} />
          {busy === 'read' && <small className="muted">PDFs e fotos podem levar até 1 minuto.</small>}
        </div>
        {error && <div className="alert error" style={{ marginTop: 10 }}>{error}</div>}
      </div>
    )
  }

  // ---------------------------------------------------------------- 2 · revisão
  const svc = isService(d.mode) ? d.mode : null
  const needsEq = !svc || TYPE_INFO[svc].equipment
  const eqOpts = p.equipment.filter((e) => !svc || e.mode === TYPE_INFO[svc].mode)
  const pl = placeLabels(svc ? TYPE_INFO[svc].placeMode : d.mode)
  const custCountry = d.customerId ? p.customers.find((c) => c.id === d.customerId)?.country : res.customer.country?.value
  const lacking = (ok: boolean) => (ok ? undefined : { borderColor: '#d62728', background: '#fff5f5' })
  const read = (f: ReadField<string> | null | undefined) => (f ? <small className="intake-ev" title={f.evidence ?? ''}>📄 lido do pedido{f.evidence ? `: “${f.evidence}”` : ''}</small> : <small className="intake-miss">não consta no pedido — informe</small>)

  return (
    <div className="intake">
      <div className="panel">
        <h3 style={{ marginTop: 0 }}>O que entendi</h3>
        <p style={{ margin: '0 0 4px' }}>{res.summary}</p>
        <small className="muted">
          {res.files.length ? `Lido de: ${res.files.map((f) => `${f.name} (${f.kind})`).join(', ')}` : 'Lido do texto informado'}
          {res.equipmentText && ` · equipamento citado: “${res.equipmentText}” (não reconhecido no cadastro)`}
        </small>
        {res.issues.length > 0 && (
          <div className="alert warn" style={{ marginTop: 8 }}>
            <strong>Pontos para conferir</strong>
            <ul style={{ margin: '4px 0 0 18px', padding: 0 }}>
              {res.issues.map((x, i) => (
                <li key={i}>{x}</li>
              ))}
            </ul>
          </div>
        )}
      </div>

      <div className="panel">
        <h3 style={{ marginTop: 0 }}>Produtos ({lines.length})</h3>
        <IntakeLines lines={lines} setLines={setLines} catalog={p.catalog} />
        <small className="muted" style={{ display: 'block', marginTop: 6 }}>
          Acompanhantes obrigatórios (ex.: KIT-HF do Hydroforce) entram sozinhos ao montar. Caixas e kg são convertidos em unidades pelo cadastro da embalagem.
        </small>
      </div>

      <div className="panel">
        <h3 style={{ marginTop: 0 }}>Dados da operação</h3>
        <div className="form-grid">
          {p.areas.length > 1 && (
            <label className="field">
              Área *
              <select value={d.area} onChange={(e) => changeArea(e.target.value)}>
                {p.areas.map((a) => (
                  <option key={a} value={a}>
                    {AREA_LABEL[a]}
                  </option>
                ))}
              </select>
            </label>
          )}
          <label className="field">
            Cliente *
            <select value={d.customerId ?? ''} onChange={(e) => setD({ ...d, customerId: e.target.value ? Number(e.target.value) : null })} style={lacking(Boolean(d.customerId || d.newCustomer.trim()))}>
              <option value="">— novo cliente —</option>
              {res.customer.similar.length > 0 && (
                <optgroup label="Parecidos com o do pedido">
                  {res.customer.similar.map((c) => (
                    <option key={c.id} value={c.id}>
                      {c.name}
                    </option>
                  ))}
                </optgroup>
              )}
              <optgroup label="Cadastrados">
                {p.customers.map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.name}
                    {c.country ? ` (${c.country})` : ''}
                  </option>
                ))}
              </optgroup>
            </select>
            {res.customer.matchedId ? <small className="intake-ev">✓ já cadastrado (nome do pedido: “{res.customer.name?.value}”)</small> : read(res.customer.name)}
          </label>
          {!d.customerId && (
            <label className="field">
              Nome do novo cliente *
              <input value={d.newCustomer} onChange={(e) => setD({ ...d, newCustomer: e.target.value })} style={lacking(Boolean(d.newCustomer.trim()))} />
              {res.customer.similar.length > 0 && <small className="intake-miss">Há clientes parecidos cadastrados — confira para não duplicar.</small>}
            </label>
          )}
          <label className="field">
            País de destino *
            <CountryInput value={d.country} onChange={(v) => setD({ ...d, country: v })} inputStyle={lacking(Boolean(d.country.trim()))} />
            {read(res.destination)}
            {!d.country && custCountry && (
              <button type="button" className="small link" onClick={() => setD({ ...d, country: custCountry })}>
                usar o país do cliente ({custCountry})?
              </button>
            )}
          </label>
          <label className="field">
            Tipo de envio *
            <select
              value={d.mode}
              onChange={(e) => {
                const s = e.target.value
                const keep = isService(s) && TYPE_INFO[s].equipment && p.equipment.find((x) => x.value === d.equipment)?.mode === TYPE_INFO[s].mode
                setD({ ...d, mode: s, equipment: keep ? d.equipment : '' })
              }}
              style={lacking(Boolean(d.mode))}
            >
              <option value="">— escolha —</option>
              {SHIPMENT_SERVICES.map((k) => (
                <option key={k} value={k}>
                  {TYPE_INFO[k].label}
                </option>
              ))}
            </select>
            {read(res.mode)}
          </label>
          <label className="field">
            Incoterm *
            <select value={d.incoterm} onChange={(e) => setD({ ...d, incoterm: e.target.value })} style={lacking(Boolean(d.incoterm))}>
              <option value="">— escolha —</option>
              {INCOTERMS.map((x) => (
                <option key={x} value={x}>
                  {x}
                </option>
              ))}
            </select>
            {read(res.incoterm)}
          </label>
          {!needsEq && svc !== 'COURIER' && (
            <label className="field">
              Altura máx. do palete carregado (mm)
              <input value={numText.h} placeholder={(svc ? TYPE_INFO[svc].defaultHeightMm ?? 2000 : 2000).toLocaleString('pt-BR')} onChange={(e) => setNumText({ ...numText, h: e.target.value })} />
            </label>
          )}
          {svc === 'COURIER' && (
            <label className="field">
              Divisor volumétrico (cm³/kg)
              <input value={numText.div} placeholder="5.000" onChange={(e) => setNumText({ ...numText, div: e.target.value })} />
            </label>
          )}
          {svc === 'ROAD' && (
            <label className="field">
              Comprimento útil do caminhão (mm) — opcional
              <input value={numText.len} placeholder="o do cadastro (ex.: 15.300 ou 15,3 m)" onChange={(e) => setNumText({ ...numText, len: e.target.value })} />
            </label>
          )}
          <label className="field">
            Transportadora (código ou nome) — opcional
            <input value={d.transportCompany ?? ''} onChange={(e) => setD({ ...d, transportCompany: e.target.value })} placeholder="deixe em branco se ainda não definida" />
          </label>
          {needsEq && <label className="field">
            Equipamento *
            <select value={d.equipment} onChange={(e) => setD({ ...d, equipment: e.target.value })} disabled={!d.mode} style={lacking(Boolean(d.equipment))}>
              <option value="">{d.mode ? '— escolha —' : 'escolha a modalidade antes'}</option>
              {eqOpts.map((x) => (
                <option key={x.value} value={x.value}>
                  {x.label}
                </option>
              ))}
            </select>
            {res.equipment ? read(res.equipment) : res.equipmentText ? <small className="intake-miss">citado “{res.equipmentText}” — escolha o equivalente</small> : read(null)}
          </label>}
          <label className="field">
            {orderRefFieldLabel(d.area)}
            <input value={d.orderRef} onChange={(e) => setD({ ...d, orderRef: e.target.value })} placeholder={d.area === 'EXPORT' ? 'Proforma 1234' : ''} />
            {res.orderRef && read(res.orderRef)}
          </label>
          <label className="field">
            {pl.origin}
            <input
              value={originShown}
              onChange={(e) => {
                setD({ ...d, originPlace: e.target.value })
                setOriginTouched(true)
              }}
              placeholder={pl.originHint}
            />
          </label>
          <label className="field">
            {pl.destination}
            <input value={d.destinationPlace ?? ''} onChange={(e) => setD({ ...d, destinationPlace: e.target.value })} placeholder={pl.destinationHint} />
          </label>
          <label className="field" style={{ gridColumn: '1 / -1' }}>
            Endereço do cliente
            <input value={d.customerAddress ?? ''} onChange={(e) => setD({ ...d, customerAddress: e.target.value })} placeholder="rua, número, cidade, país" />
          </label>
        </div>
        <label className="field" style={{ marginTop: 8 }}>
          Observações
          <textarea rows={2} value={d.notes} onChange={(e) => setD({ ...d, notes: e.target.value })} />
        </label>
      </div>

      {missing.length > 0 ? (
        <div className="alert warn">
          <strong>Falta para continuar:</strong> {missing.join(' · ')}
        </div>
      ) : (
        <div className="alert ok">Tudo pronto. A carga será montada pelo motor com as regras logísticas da modalidade e do destino (palete padrão, peso máximo) e dividida em mais unidades se não couber.</div>
      )}
      {error && <div className="alert error">{error}</div>}
      {notes.length > 0 && (
        <div className="alert warn">
          {notes.map((n, i) => (
            <div key={i}>{n}</div>
          ))}
        </div>
      )}
      <div className="row" style={{ gap: 8 }}>
        <button className="primary" onClick={create} disabled={busy !== null || missing.length > 0}>
          {busy === 'create' ? 'Montando a carga…' : '✔ Confirmar: criar pedido e montar carga'}
        </button>
        <button onClick={() => (setRes(null), setError(null))} disabled={busy !== null}>
          ← Voltar aos anexos
        </button>
      </div>
    </div>
  )
}
