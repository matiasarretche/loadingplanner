'use client'

import { useRouter } from 'next/navigation'
import { useEffect, useState, type CSSProperties, type ReactNode } from 'react'
import {
  containerNumberValid,
  etaFrom,
  EXPORT_STATUS_LABEL,
  EXPORT_STATUSES,
  type ExportStatus,
  FIELD_LABEL,
  type FieldSource,
  type FieldSources,
  fmtDate,
  isActiveStatus,
  PER_UNIT_FIELDS,
  TRACKING_FIELDS,
  type TrackingField,
  trackingSituation,
} from '@/domain/exportTracking'
import { updateTrackingAction } from '../actions'
import type { TrackingPatch, TrackingValues } from '../types'
import { dias, fmtInstant } from './fmt'
import { useUnsavedTracking } from './UnsavedTracking'

/**
 * Formulário do seguimento (/exportacoes/[id]): status, datas, logística, responsável e observações.
 * Manda ao servidor SÓ os campos alterados (updateTrackingAction) — com "Aplicar também às outras cargas do
 * pedido", também os dados do embarque já preenchidos (SIBLING_COPY); a ETA é calculada (ETD + trânsito)
 * sempre que os dois estão preenchidos — o servidor recalcula e ignora a ETA digitada nesse caso.
 * Os indicadores (dias p/ carregamento/chegada, atrasos) acompanham o que é digitado, antes de salvar.
 * Status muda só manualmente: as datas nunca avançam a etapa sozinhas.
 */

type Key = keyof TrackingValues
type TextKey = Exclude<Key, 'status' | 'delayed'>
type FormState = { status: ExportStatus; delayed: boolean } & Record<TextKey, string>
type Places = { origin: string; destination: string; originHint: string; destinationHint: string }

const KEYS: readonly Key[] = [...TRACKING_FIELDS, 'originPlace', 'destinationPlace']
// mesmos limites do servidor (src/lib/exportTracking.ts)
const SHORT_MAX = 120
const LONG_MAX = 2000
const PLACE_MAX = 300

/**
 * "Aplicar também às outras cargas do pedido": além do que foi alterado agora, estes campos (dados do
 * embarque, comuns ao pedido) vão com o valor ATUAL quando preenchidos — assim dá para copiar o que já estava
 * salvo, sem redigitar. O carregamento PREVISTO também vai (decisão do Matías: as cargas do pedido costumam
 * carregar juntas). Status, atraso, incidência, confirmação, carregamento real, saída/chegada reais, entrega,
 * rastreio e observações são de cada carga: só vão se alterados agora. Contêiner e lacre nunca.
 * A tela lista o que vai ser aplicado antes de salvar.
 */
const SIBLING_COPY: readonly TextKey[] = ['paymentReceivedAt', 'responsibleUserId', 'carrier', 'forwarder', 'bookingNumber', 'blNumber', 'vessel', 'voyage', 'plannedLoadingDate', 'etd', 'transitDays', 'eta']

export interface TrackingFormProps {
  /** operação (export_operation) */
  id: number
  /**
   * muda a cada gravação: o formulário remonta com os valores do servidor (ETA calculada, maiúsculas…).
   * Nunca deve mudar com eventos que não alteram os dados (resumo gerado/enviado): a remontagem descarta o
   * que foi digitado e não salvo.
   */
  version: string
  /** hoje em São Paulo (todayBR) */
  today: string
  canEdit: boolean
  initial: TrackingValues
  fieldSources: FieldSources
  /** select "Responsável" */
  users: { id: number; name: string }[]
  responsibleName: string | null
  /** outras cargas do pedido com seguimento EM CURSO ("Aplicar também às outras N cargas do pedido") */
  siblingsWithOps: number
  /** outras cargas do pedido finalizadas/canceladas (Histórico): nunca são alteradas daqui */
  closedSiblings: number
  /** o pedido tem várias cargas: contêiner e lacre são só desta; origem/destino valem para todas */
  multiUnit: boolean
  /** transportadora da carga (sugestão no campo armador/transportadora) */
  transportCompany: string | null
  /** rótulos de origem/destino conforme a modalidade (portos, aeroportos, endereços) */
  places: Places
  tracking: { lastUpdate: string | null; provider: string | null; ref: string | null }
}

function toForm(v: TrackingValues): FormState {
  const f: Record<string, string | boolean> = {}
  for (const k of KEYS) {
    const x = v[k]
    f[k] = typeof x === 'boolean' ? x : x == null ? '' : String(x)
  }
  return f as unknown as FormState
}

function isDirty(base: FormState, cur: FormState, k: Key): boolean {
  const a = base[k]
  const b = cur[k]
  return typeof a === 'string' && typeof b === 'string' ? a.trim() !== b.trim() : a !== b
}

/**
 * Só o que mudou (vazio = apagar) + os campos de `copy` que estiverem preenchidos (cópia para as outras
 * cargas do pedido). Erro em texto quando um valor não pode ser enviado.
 */
function buildPatch(base: FormState, cur: FormState, skipEta: boolean, copy: readonly Key[] = []): { patch: TrackingPatch; error: string | null } {
  const patch: TrackingPatch = {}
  const out = patch as Record<string, unknown>
  for (const k of KEYS) {
    if (k === 'eta' && skipEta) continue
    const v = cur[k]
    const filled = typeof v === 'string' && v.trim() !== ''
    if (!isDirty(base, cur, k) && !(filled && copy.includes(k))) continue
    if (typeof v === 'boolean' || k === 'status') {
      out[k] = v
      continue
    }
    const t = v.trim()
    if (k === 'confirmedAt' && !t) return { patch, error: 'A data de confirmação do pedido é obrigatória.' }
    if (k === 'transitDays') {
      const n = Number(t)
      if (t && (!Number.isInteger(n) || n < 0 || n > 365)) return { patch, error: `${FIELD_LABEL.transitDays}: informe um número inteiro de 0 a 365.` }
      out[k] = t ? n : null
    } else if (k === 'responsibleUserId') out[k] = t ? Number(t) : null
    else out[k] = t || null
  }
  return { patch, error: null }
}

/**
 * Casca: guarda o aviso "salvo" enquanto o formulário remonta com os dados novos (key = version).
 */
export function TrackingForm(props: TrackingFormProps) {
  const [flash, setFlash] = useState<string | null>(null)
  return <FormBody key={props.version} {...props} flash={flash} setFlash={setFlash} />
}

function FormBody({
  id,
  today,
  canEdit,
  initial,
  fieldSources,
  users,
  responsibleName,
  siblingsWithOps,
  closedSiblings,
  multiUnit,
  transportCompany,
  places,
  tracking,
  flash,
  setFlash,
}: TrackingFormProps & { flash: string | null; setFlash: (s: string | null) => void }) {
  const router = useRouter()
  const [base, setBase] = useState(() => toForm(initial))
  const [form, setForm] = useState(base)
  const [applyToSiblings, setApplyToSiblings] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const ro = !canEdit

  // ETA calculada ao vivo (mesma regra do servidor) e situação com os valores digitados
  const tdText = form.transitDays.trim()
  const tdNum = Number(tdText)
  const transitDays = tdText !== '' && Number.isInteger(tdNum) && tdNum >= 0 && tdNum <= 365 ? tdNum : null
  const calcEta = etaFrom(form.etd || null, transitDays)
  const eta = calcEta ?? (form.eta || null)
  const sit = trackingSituation(
    {
      status: form.status,
      delayed: form.delayed,
      incident: form.incident || null,
      confirmedAt: form.confirmedAt || null,
      plannedLoadingDate: form.plannedLoadingDate || null,
      actualLoadingDate: form.actualLoadingDate || null,
      etd: form.etd || null,
      atd: form.atd || null,
      transitDays,
      eta,
      ata: form.ata || null,
    },
    today,
  )
  const changed = KEYS.filter((k) => !(k === 'eta' && calcEta) && isDirty(base, form, k))
  const dirty = changed.length > 0
  const knownResponsible = form.responsibleUserId === '' || users.some((u) => String(u.id) === form.responsibleUserId)

  // "Aplicar também às outras cargas do pedido": o que foi alterado + os dados do embarque preenchidos
  const siblingMode = !ro && applyToSiblings && siblingsWithOps > 0
  const copyKeys: Key[] = siblingMode ? SIBLING_COPY.filter((k) => form[k].trim() !== '' && !(k === 'eta' && calcEta) && !(k === 'responsibleUserId' && !knownResponsible)) : []
  const toSiblings = siblingMode
    ? KEYS.filter((k) => !PER_UNIT_FIELDS.includes(k as TrackingField) && k !== 'originPlace' && k !== 'destinationPlace' && (changed.includes(k) || copyKeys.includes(k)))
    : []
  // com ETD e trânsito copiados, a ETA de cada carga é recalculada no servidor
  const toSiblingsLabel = [...toSiblings.map((k) => FIELD_LABEL[k]), ...(calcEta && toSiblings.includes('etd') && toSiblings.includes('transitDays') ? ['ETA (calculada)'] : [])].join(', ')
  const canSave = dirty || copyKeys.length > 0

  // alterações não salvas: avisa antes de fechar/recarregar a página
  useEffect(() => {
    if (!dirty) return
    const h = (e: BeforeUnloadEvent) => e.preventDefault()
    window.addEventListener('beforeunload', h)
    return () => window.removeEventListener('beforeunload', h)
  }, [dirty])

  // ... e para o resumo para o cliente (o PDF usa os dados salvos: o diálogo pede para salvar antes)
  const setUnsaved = useUnsavedTracking()?.setChanged
  const changedKey = changed.join(',')
  useEffect(() => {
    if (!setUnsaved) return
    setUnsaved(changedKey ? changedKey.split(',') : [])
    return () => setUnsaved([])
  }, [changedKey, setUnsaved])

  function set<K extends keyof FormState>(k: K, v: FormState[K]) {
    setForm((f) => ({ ...f, [k]: v }))
    setError(null)
    setFlash(null)
  }

  function discard() {
    setForm(base)
    setError(null)
    setFlash(null)
  }

  async function save() {
    if (busy || ro) return
    const { patch, error: invalid } = buildPatch(base, form, calcEta != null, copyKeys)
    if (invalid) return setError(invalid)
    if (!Object.keys(patch).length) return setFlash('Nada para salvar.')
    setBusy(true)
    setError(null)
    setFlash(null)
    const r = await updateTrackingAction(id, patch, { applyToSiblings: siblingMode }).catch(() => ({ ok: false as const, error: 'Falha de comunicação com o servidor.' }))
    setBusy(false)
    if (!r.ok) return setError(r.error)
    setBase(form)
    setApplyToSiblings(false)
    const others = r.updated.filter((x) => x !== id).length
    const cargas = others === 1 ? '1 carga' : `${others} cargas`
    setFlash(
      r.updated.length === 0
        ? siblingMode
          ? 'Nada mudou: as outras cargas do pedido já tinham estas informações.'
          : 'Nada mudou.'
        : others === 0
          ? 'Seguimento salvo.'
          : r.updated.includes(id)
            ? `Seguimento salvo nesta e em mais ${cargas} do pedido.`
            : `Informações aplicadas a mais ${cargas} do pedido.`,
    )
    router.refresh()
  }

  // ---- peças de formulário ----
  const changedStyle = (k: Key): CSSProperties | undefined => (changed.includes(k) ? { borderColor: 'var(--warn)', background: '#fffdf5' } : undefined)
  /** origem do valor gravado (calculado / API); some enquanto o campo está alterado */
  const src = (k: Key) => (changed.includes(k) ? null : <Src s={fieldSources[k]} />)
  const text = (k: TextKey, o: { max?: number; placeholder?: string; upper?: boolean } = {}) =>
    ro ? (
      <Ro>{form[k] || '—'}</Ro>
    ) : (
      <input
        value={form[k]}
        onChange={(e) => set(k, o.upper ? e.target.value.toUpperCase() : e.target.value)}
        maxLength={o.max ?? SHORT_MAX}
        placeholder={o.placeholder}
        disabled={busy}
        autoComplete="off"
        style={changedStyle(k)}
      />
    )
  const date = (k: TextKey, o: { required?: boolean } = {}) =>
    ro ? <Ro>{fmtDate(form[k])}</Ro> : <input type="date" value={form[k]} onChange={(e) => set(k, e.target.value)} required={o.required} disabled={busy} style={changedStyle(k)} />
  const area = (k: TextKey, placeholder: string, empty: string) =>
    ro ? (
      <Ro>{form[k] || empty}</Ro>
    ) : (
      <textarea rows={3} value={form[k]} onChange={(e) => set(k, e.target.value)} maxLength={LONG_MAX} placeholder={placeholder} disabled={busy} style={{ resize: 'vertical', ...changedStyle(k) }} />
    )

  const statusHint =
    !ro && form.status !== base.status ? (
      !isActiveStatus(form.status) ? (
        <small>Ao salvar, a operação sai do painel e vai para o Histórico.</small>
      ) : !isActiveStatus(base.status) ? (
        <small>Ao salvar, a operação é reaberta e volta para o painel.</small>
      ) : null
    ) : null
  const containerWarn = form.containerNumber.trim() !== '' && !containerNumberValid(form.containerNumber)
  const unitOnly = multiUnit ? ' (só desta carga)' : ''
  const orderWide = multiUnit ? ' (do pedido: vale para todas as cargas)' : ''

  return (
    <form
      onSubmit={(e) => {
        e.preventDefault()
        void save()
      }}
    >
      <fieldset>
        <legend>Status</legend>
        <div className="form-grid">
          <Field label={FIELD_LABEL.status} src={src('status')} hint={statusHint}>
            {ro ? (
              <Ro>
                <span className={`pill exp-${form.status}`}>{EXPORT_STATUS_LABEL[form.status]}</span>
              </Ro>
            ) : (
              <select value={form.status} onChange={(e) => set('status', e.target.value as ExportStatus)} disabled={busy} style={changedStyle('status')}>
                {EXPORT_STATUSES.map((s) => (
                  <option key={s} value={s}>
                    {EXPORT_STATUS_LABEL[s]}
                  </option>
                ))}
              </select>
            )}
          </Field>
          <div style={{ alignSelf: 'end', paddingBottom: 6 }}>
            {ro ? (
              <Ro>{form.delayed ? 'Marcado como atrasado' : 'Não marcado como atrasado'}</Ro>
            ) : (
              <label className="check" title="Marcação manual (além dos alertas de datas vencidas)">
                <input type="checkbox" checked={form.delayed} onChange={(e) => set('delayed', e.target.checked)} disabled={busy} />
                <span style={changed.includes('delayed') ? { color: 'var(--warn)', fontWeight: 600 } : undefined}>{FIELD_LABEL.delayed}</span>
                {src('delayed')}
              </label>
            )}
          </div>
          <Field label={`${FIELD_LABEL.incident} (vazio = sem incidência)`} src={src('incident')} wide>
            {area('incident', 'Descreva a incidência (avaria, retenção na aduana, rolagem do navio…)', 'Sem incidência')}
          </Field>
        </div>
      </fieldset>

      <fieldset>
        <legend>Datas</legend>
        <div className="form-grid">
          <Field label={FIELD_LABEL.confirmedAt} src={src('confirmedAt')}>
            {date('confirmedAt', { required: true })}
          </Field>
          <Field
            label={FIELD_LABEL.paymentReceivedAt}
            src={src('paymentReceivedAt')}
            hint={!form.paymentReceivedAt && <small style={{ fontStyle: 'italic' }}>Pagamento não informado</small>}
          >
            {date('paymentReceivedAt')}
          </Field>
          <Field label={FIELD_LABEL.plannedLoadingDate} src={src('plannedLoadingDate')}>
            {date('plannedLoadingDate')}
          </Field>
          <Field label={FIELD_LABEL.actualLoadingDate} src={src('actualLoadingDate')}>
            {date('actualLoadingDate')}
          </Field>
          <Field label={FIELD_LABEL.etd} src={src('etd')}>
            {date('etd')}
          </Field>
          <Field label={FIELD_LABEL.atd} src={src('atd')}>
            {date('atd')}
          </Field>
          <Field label={FIELD_LABEL.transitDays} src={src('transitDays')}>
            {ro ? (
              <Ro>{form.transitDays ? dias(Number(form.transitDays)) : '—'}</Ro>
            ) : (
              <input type="number" inputMode="numeric" min={0} max={365} step={1} value={form.transitDays} onChange={(e) => set('transitDays', e.target.value)} disabled={busy} style={changedStyle('transitDays')} />
            )}
          </Field>
          <Field label={calcEta ? `${FIELD_LABEL.eta} — calculada (ETD + trânsito)` : FIELD_LABEL.eta} src={calcEta ? null : src('eta')}>
            {ro ? (
              <Ro>{fmtDate(eta)}</Ro>
            ) : (
              <input
                type="date"
                value={calcEta ?? form.eta}
                onChange={(e) => set('eta', e.target.value)}
                disabled={busy || calcEta != null}
                title={calcEta ? 'Calculada: ETD + trânsito estimado. Para digitar a ETA, apague o trânsito.' : undefined}
                style={changedStyle('eta')}
              />
            )}
          </Field>
          <Field label={FIELD_LABEL.ata} src={src('ata')}>
            {date('ata')}
          </Field>
          <Field label={FIELD_LABEL.deliveredAt} src={src('deliveredAt')}>
            {date('deliveredAt')}
          </Field>
        </div>
        <Indicators sit={sit} form={form} eta={eta} />
      </fieldset>

      <fieldset>
        <legend>Logística</legend>
        <div className="form-grid">
          <Field label={FIELD_LABEL.carrier} src={src('carrier')}>
            {text('carrier', { placeholder: transportCompany ?? '' })}
          </Field>
          <Field label="Agente de carga" src={src('forwarder')}>
            {text('forwarder')}
          </Field>
          <Field label={FIELD_LABEL.bookingNumber} src={src('bookingNumber')}>
            {text('bookingNumber')}
          </Field>
          <Field
            label={`${FIELD_LABEL.containerNumber}${unitOnly}`}
            src={src('containerNumber')}
            hint={containerWarn && <small style={{ color: 'var(--warn)' }}>Não parece um nº de contêiner ISO (ok se for placa de caminhão)</small>}
          >
            {text('containerNumber', { upper: true, placeholder: 'ex.: CSQU3054383' })}
          </Field>
          <Field label={`${FIELD_LABEL.sealNumber}${unitOnly}`} src={src('sealNumber')}>
            {text('sealNumber')}
          </Field>
          <Field label={FIELD_LABEL.blNumber} src={src('blNumber')}>
            {text('blNumber')}
          </Field>
          <Field label={FIELD_LABEL.vessel} src={src('vessel')}>
            {text('vessel')}
          </Field>
          <Field label={FIELD_LABEL.voyage} src={src('voyage')}>
            {text('voyage')}
          </Field>
          <Field label={`${places.origin}${orderWide}`} src={src('originPlace')}>
            {text('originPlace', { max: PLACE_MAX, placeholder: places.originHint })}
          </Field>
          <Field label={`${places.destination}${orderWide}`} src={src('destinationPlace')}>
            {text('destinationPlace', { max: PLACE_MAX, placeholder: places.destinationHint })}
          </Field>
          <Field label={FIELD_LABEL.currentLocation} src={src('currentLocation')}>
            {text('currentLocation')}
          </Field>
          <Field label={FIELD_LABEL.trackingStatus} src={src('trackingStatus')}>
            {text('trackingStatus')}
          </Field>
          {(tracking.lastUpdate || tracking.provider || tracking.ref) && (
            <small style={{ gridColumn: '1 / -1' }}>
              Rastreio atualizado em {fmtInstant(tracking.lastUpdate)}
              {tracking.provider ? ` · ${tracking.provider}` : ''}
              {tracking.ref ? ` · ref. ${tracking.ref}` : ''}
            </small>
          )}
        </div>
      </fieldset>

      <fieldset>
        <legend>Responsável e observações</legend>
        <div className="form-grid">
          <Field label={FIELD_LABEL.responsibleUserId} src={src('responsibleUserId')}>
            {ro ? (
              <Ro>{responsibleName ?? '—'}</Ro>
            ) : (
              <select value={form.responsibleUserId} onChange={(e) => set('responsibleUserId', e.target.value)} disabled={busy} style={changedStyle('responsibleUserId')}>
                <option value="">— sem responsável —</option>
                {users.map((u) => (
                  <option key={u.id} value={String(u.id)}>
                    {u.name}
                  </option>
                ))}
                {!knownResponsible && <option value={form.responsibleUserId}>{responsibleName ?? `#${form.responsibleUserId}`} (sem acesso ao seguimento)</option>}
              </select>
            )}
          </Field>
          <Field label={FIELD_LABEL.notes} src={src('notes')} wide>
            {area('notes', 'Observações internas do seguimento', '—')}
          </Field>
        </div>
      </fieldset>

      {!ro && (
        <div style={{ position: 'sticky', bottom: 0, zIndex: 3, background: 'var(--panel)', borderTop: '1px solid var(--border)', padding: '10px 0 4px' }}>
          {error && (
            <div className="alert error" role="alert" style={{ marginBottom: 8 }}>
              {error}
            </div>
          )}
          {flash && !error && (
            <div className="alert ok" role="status" style={{ marginBottom: 8 }}>
              {flash}
            </div>
          )}
          <div className="row">
            {siblingsWithOps > 0 && (
              <label className="check" style={{ flex: '1 1 280px' }} title="Copia os dados do embarque já preenchidos (booking, navio, ETD…) e o que foi alterado agora">
                <input type="checkbox" checked={applyToSiblings} onChange={(e) => setApplyToSiblings(e.target.checked)} disabled={busy} />
                <span>
                  {siblingsWithOps === 1 ? 'Aplicar também à outra carga' : `Aplicar também às outras ${siblingsWithOps} cargas`}
                  {closedSiblings > 0 ? ' em curso' : ''} do pedido (contêiner e lacre não são copiados)
                  {closedSiblings > 0 && <small> — {closedSiblings === 1 ? 'a finalizada/cancelada não é alterada' : 'as finalizadas/canceladas não são alteradas'}</small>}
                </span>
              </label>
            )}
            <span className="spacer" />
            <small>{dirty ? `${changed.length} ${changed.length === 1 ? 'campo alterado' : 'campos alterados'}` : 'Sem alterações'}</small>
            <button type="button" onClick={discard} disabled={busy || !dirty}>
              Descartar
            </button>
            <button type="submit" className="primary" disabled={busy || !canSave} aria-busy={busy}>
              {busy ? 'Salvando…' : 'Salvar'}
            </button>
          </div>
          {siblingMode && (
            <small style={{ display: 'block', marginTop: 4 }}>
              {toSiblings.length ? `Vai para as outras cargas: ${toSiblingsLabel}.` : 'Nada a aplicar às outras cargas: preencha ou altere algum dado do embarque.'}
            </small>
          )}
        </div>
      )}
    </form>
  )
}

/** indicadores calculados (com o que está digitado): dias até carregar/chegar e atrasos */
function Indicators({ sit, form, eta }: { sit: ReturnType<typeof trackingSituation>; form: FormState; eta: string | null }) {
  const findAlert = (kind: string) => sit.alerts.find((a) => a.kind === kind)
  const loadAlert = findAlert('LOADING_OVERDUE')
  const etdAlert = findAlert('ETD_OVERDUE')
  const etaAlert = findAlert('ETA_OVERDUE')
  const until = (d: number) => (d < 0 ? `há ${dias(-d)}` : d === 0 ? 'hoje' : dias(d))

  const loading: KpiProps = sit.loaded
    ? { k: 'Dias p/ carregamento', v: 'Carregado', s: form.actualLoadingDate ? `em ${fmtDate(form.actualLoadingDate)}` : undefined }
    : sit.daysToLoading == null
      ? { k: 'Dias p/ carregamento', v: '—', s: 'sem carregamento previsto' }
      : {
          k: 'Dias p/ carregamento',
          v: until(sit.daysToLoading),
          s: loadAlert ? <span className="exp-alert">{loadAlert.text}</span> : sit.soonToLoad ? <span className="exp-soon">Próxima a carregar</span> : `previsto ${fmtDate(form.plannedLoadingDate)}`,
          tone: loadAlert ? 'CRITICAL' : sit.soonToLoad ? 'WARNING' : undefined,
        }
  const arrival: KpiProps = sit.arrived
    ? { k: 'Dias p/ chegada', v: 'Chegou', s: form.ata ? `em ${fmtDate(form.ata)}` : undefined }
    : sit.daysToArrival == null
      ? { k: 'Dias p/ chegada', v: '—', s: 'sem ETA' }
      : {
          k: 'Dias p/ chegada',
          v: until(sit.daysToArrival),
          s: etaAlert ? <span className="exp-alert">{etaAlert.text}</span> : sit.soonToArrive ? <span className="exp-soon">Próxima a chegar</span> : `ETA ${fmtDate(eta)}`,
          tone: etaAlert ? 'CRITICAL' : sit.soonToArrive ? 'WARNING' : undefined,
        }
  const etdDelay: KpiProps = sit.etdDelay
    ? {
        k: 'Atraso vs ETD',
        v: dias(sit.etdDelay),
        s: etdAlert ? <span className="exp-alert">{etdAlert.text}</span> : form.atd ? `saída ${fmtDate(form.atd)} × ETD ${fmtDate(form.etd)}` : `ETD ${fmtDate(form.etd)}`,
        tone: etdAlert ? 'CRITICAL' : 'WARNING',
      }
    : { k: 'Atraso vs ETD', v: form.etd ? 'Sem atraso' : '—', s: form.etd ? `ETD ${fmtDate(form.etd)}` : 'sem ETD' }
  const etaDelay: KpiProps = sit.etaDelay
    ? {
        k: 'Atraso vs ETA',
        v: dias(sit.etaDelay),
        s: etaAlert ? <span className="exp-alert">{etaAlert.text}</span> : form.ata ? `chegada ${fmtDate(form.ata)} × ETA ${fmtDate(eta)}` : `ETA ${fmtDate(eta)}`,
        tone: etaAlert ? 'CRITICAL' : 'WARNING',
      }
    : { k: 'Atraso vs ETA', v: eta ? 'Sem atraso' : '—', s: eta ? `ETA ${fmtDate(eta)}` : 'sem ETA' }
  const transit: KpiProps = { k: 'Trânsito', v: sit.transit != null ? dias(sit.transit) : '—', s: 'ETD → ETA' }

  return (
    <div className="kpis" style={{ marginTop: 12 }} aria-live="polite">
      {[loading, arrival, etdDelay, etaDelay, transit].map((p) => (
        <Kpi key={p.k} {...p} />
      ))}
    </div>
  )
}

interface KpiProps {
  k: string
  v: string
  s?: ReactNode
  tone?: 'CRITICAL' | 'WARNING'
}

function Kpi({ k, v, s, tone }: KpiProps) {
  return (
    <div className={`kpi ${tone ?? ''}`}>
      <div className="k">{k}</div>
      <div className="v">{v}</div>
      {s && <div className="s">{s}</div>}
    </div>
  )
}

function Field({ label, src, hint, wide, children }: { label: ReactNode; src?: ReactNode; hint?: ReactNode; wide?: boolean; children: ReactNode }) {
  return (
    <label className="field" style={wide ? { gridColumn: '1 / -1' } : undefined}>
      <span>
        {label}
        {src}
      </span>
      {children}
      {hint}
    </label>
  )
}

/** valor somente leitura (usuário sem permissão de edição) */
function Ro({ children }: { children: ReactNode }) {
  return <div style={{ color: 'var(--text)', fontSize: 14, padding: '4px 0', minHeight: 24, overflowWrap: 'anywhere', whiteSpace: 'pre-line' }}>{children}</div>
}

/** origem do valor: calculado pelo sistema ou recebido de integração (manual não leva etiqueta) */
function Src({ s }: { s: FieldSource | undefined }) {
  if (s?.source === 'CALC')
    return (
      <span className="exp-src calc" title={`Calculado pelo sistema em ${fmtInstant(s.at)}`}>
        calculado
      </span>
    )
  if (s?.source === 'API')
    return (
      <span className="exp-src api" title={`Recebido de ${s.provider || 'integração'} em ${fmtInstant(s.at)}`}>
        API
      </span>
    )
  return null
}
