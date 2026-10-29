'use client'

import { useActionState, useEffect, useMemo, useState } from 'react'
import { canonicalCountry, countryInText } from '@/lib/countries'
import { customerInText, serviceInText } from '@/domain/intake'
import { Area, AREA_LABEL } from '@/lib/areas'
import { INCOTERMS } from '@/lib/constants'
import { createPlanAction } from '../actions'
import { orderRefFieldLabel, orderRefInitial, PROFORMA_PREFIX } from '@/lib/orderRef'
import { originOrDefault, placeLabels } from '@/lib/places'
import { CountryInput } from '@/components/CountryInput'
import { CustomerPicker, type PickerCustomer } from '@/components/CustomerPicker'
import { TransportCompanyPicker, type PickerTransportCompany } from '@/components/TransportCompanyPicker'
import { PaymentTermsFields } from '@/components/PaymentTermsFields'
import { normalizePaymentTerms, PaymentTerms, paymentTermsErrors } from '@/domain/paymentTerms'
import { CFOP_PLACEHOLDER, cfopAreaWarning, cfopError, normalizeCfop } from '@/domain/cfop'
import { specialTransportCompanyIds } from '@/domain/transportCompany'
import { DEFAULT_COURIER_DIVISOR, isNoEquipment, isService, SHIPMENT_SERVICES, ShipmentService, TYPE_INFO } from '@/domain/shipmentType'

interface Opt {
  value: string
  label: string
  detail?: string
}

/** Dados da última carga de um cliente (para preencher o formulário ao escolhê-lo). */
export interface LastLoad {
  area: Area
  country: string
  incoterm: string
  service: ShipmentService
  originPlace: string
  destinationPlace: string
  customerAddress: string
  /** `CONTAINER:id` ou `VEHICLE:id` (mesmo formato das opções de equipamento); null = sem equipamento */
  equipment: string | null
  /** sem equipamento: altura máxima do palete carregado / divisor do courier */
  maxHeightMm: number | null
  courierDivisor: number | null
  profiles: string[]
  plan: string
  date: string
  /** transportadora e condição de pagamento da última carga; CFOP do pedido dela */
  transportCompanyId: number | null
  /** última transportadora usada pelo cliente (pode ser de uma carga anterior à última) */
  lastTransportCompanyId: number | null
  paymentTerms: PaymentTerms | null
  cfop: string | null
}

/** condição de pagamento que voltou do servidor (JSON do campo oculto) */
function termsFromField(v: string | undefined): PaymentTerms | null {
  if (!v) return null
  try {
    return normalizePaymentTerms(JSON.parse(v))
  } catch {
    return null
  }
}

/** Cliente ativo para o seletor: `address` = endereço do cadastro já em uma linha (formatCustomerAddress). */
export type NewPlanCustomer = PickerCustomer & { country: string; address: string; agentId?: string }

export function NewPlanForm(p: {
  customers: NewPlanCustomer[]
  /** agentes ativos (comissão no preço) */
  agents?: Opt[]
  containers: Opt[]
  ulds: Opt[]
  vehicles: Opt[]
  profiles: (Opt & { defaultChecked: boolean })[]
  /** veio do atalho "Criar com IA" da página principal: o assistente executa o texto ao abrir a carga */
  aiMode?: boolean
  /** áreas do usuário (Exportação / Mercado Interno): a carga fica visível só para quem trabalha na área */
  areas: Area[]
  /** última carga por cliente (id do cliente → dados) */
  lastLoad?: Record<string, LastLoad>
  /** transportadoras ativas do ERP (seletor com busca por nome ou código) */
  companies?: PickerTransportCompany[]
  /** tipo pedido na URL (?tipo=LCL…) */
  initialService?: ShipmentService
}) {
  const [state, action, pending] = useActionState(createPlanAction, {})
  const v = state.values ?? {}
  // COMERCIAL (opcionais): transportadora do ERP (id), condição de pagamento (só Exportação) e CFOP do pedido.
  // Ao escolher o cliente vêm da última carga dele (sem carga anterior: vazios), menos o que o usuário já mexeu
  const companies = useMemo(() => p.companies ?? [], [p.companies])
  const [tcId, setTcId] = useState<number | null>(Number(v.transportCompanyId) || null)
  const [terms, setTerms] = useState<PaymentTerms | null>(() => termsFromField(v.paymentTerms))
  const [cfop, setCfop] = useState(v.cfop ?? '')
  const [touched, setTouched] = useState({ tc: v.transportCompanyId != null, terms: v.paymentTerms != null, cfop: v.cfop != null })
  const specialIds = useMemo(() => specialTransportCompanyIds(companies), [companies])
  const [clientError, setClientError] = useState<string | null>(null)
  const [area, setArea] = useState<Area>((v.area as Area) ?? p.areas[0] ?? 'EXPORT')
  // TIPO DE ENVIO: com equipamento (editor 3D) ou sem (paletes mistos / volumes)
  const [service, setService] = useState<ShipmentService>(isService(v.service) ? v.service : p.initialService ?? (area === 'DOMESTIC' ? 'ROAD' : 'FCL'))
  const info = TYPE_INFO[service]
  const noEq = isNoEquipment(service)
  const [maxHeight, setMaxHeight] = useState(v.maxHeightMm ?? '')
  const [divisor, setDivisor] = useState(v.courierDivisor ?? DEFAULT_COURIER_DIVISOR.toLocaleString('pt-BR'))
  // o tipo só muda sozinho (último pedido do cliente / texto da IA) enquanto o usuário não o escolheu
  const [typeTouched, setTypeTouched] = useState(Boolean(v.service || p.initialService))
  const [customer, setCustomer] = useState(v.customerId ?? '')
  const [country, setCountry] = useState(v.country ?? (area === 'DOMESTIC' ? 'Brasil' : ''))
  // último país preenchido sozinho pelo cliente (cadastro ou última carga): se o campo ainda o tem, trocar de
  // cliente o atualiza; um país digitado pelo usuário (ou o "Brasil" do mercado interno) fica
  const [countryAuto, setCountryAuto] = useState('')
  const [incoterm, setIncoterm] = useState(v.incoterm ?? 'FOB')
  // agente da carga: vem do cadastro do cliente, pode ser trocado só para esta carga
  const [agentId, setAgentId] = useState(v.agentId ?? '')
  // origem/destino (porto, aeroporto ou endereço, conforme a modalidade) e endereço do cliente
  const [originPlace, setOriginPlace] = useState(v.originPlace ?? '')
  // endereço de coleta: a fábrica (Pacifil Sapiranga) até o usuário editar
  const [originTouched, setOriginTouched] = useState(v.originPlace != null)
  // tipo de lugar (porto, aeroporto, endereço) a que o texto da origem pertence; null = vale para o tipo atual
  const [originMode, setOriginMode] = useState<string | null>(null)
  const [destinationPlace, setDestinationPlace] = useState(v.destinationPlace ?? '')
  const [customerAddress, setCustomerAddress] = useState(v.customerAddress ?? '')
  const pl = placeLabels(info.placeMode)
  const [orderRef, setOrderRef] = useState(v.orderRef ?? orderRefInitial(area))
  // o campo Proforma/Pedido acompanha a área (só troca o prefixo vazio, nunca um número digitado)
  const refForArea = (a: Area) => setOrderRef((x) => (!x.trim() || x === PROFORMA_PREFIX ? orderRefInitial(a) : x))
  // depois de um erro, os perfis marcados voltam como estavam (não se perdem)
  const [profiles, setProfiles] = useState<string[]>(() => (v.profiles != null ? v.profiles.split(',').filter(Boolean) : p.profiles.filter((o) => o.defaultChecked).map((o) => o.value)))
  /** carga de origem do preenchimento automático (aviso no formulário) */
  const [filledFrom, setFilledFrom] = useState<LastLoad | null>(null)
  const optsFor = (s: ShipmentService) => (s === 'FCL' ? p.containers : s === 'AIR_ULD' ? p.ulds : s === 'ROAD' ? p.vehicles : [])
  // padrão: marítimo com contêiner standard de 40' (40GP); nas demais modalidades, o primeiro da lista
  const defaultFor = (s: ShipmentService) => {
    const opts = optsFor(s)
    return (s === 'FCL' ? opts.find((o) => /^40GP\b/i.test(o.label)) : undefined)?.value ?? opts[0]?.value ?? ''
  }
  const eqOpts = optsFor(service)
  const [equipment, setEquipment] = useState(v.equipment ?? defaultFor(service))
  const chooseService = (s: ShipmentService, touched = true) => {
    setService(s)
    setEquipment(defaultFor(s))
    setMaxHeight('')
    if (touched) setTypeTouched(true)
  }
  const cur = eqOpts.find((o) => o.value === equipment) ?? eqOpts[0]
  // CFOP: o formato bloqueia; a área só avisa. Condição de pagamento inválida também bloqueia
  const cfopValue = normalizeCfop(cfop)
  const cfopErr = cfopError(cfopValue)
  const cfopWarn = cfopAreaWarning(cfopValue, area)
  const termsOn = area === 'EXPORT' ? terms : null
  const termsErr = termsOn ? paymentTermsErrors(termsOn) : []
  // topo do seletor de transportadoras: a última usada por este cliente e as situações especiais do ERP
  const lastTc = customer ? p.lastLoad?.[customer]?.lastTransportCompanyId ?? null : null
  const tcFeatured = [
    { label: 'Última usada por este cliente', ids: lastTc != null ? [lastTc] : [] },
    { label: 'Especiais', ids: specialIds },
  ]
  /**
   * Escolhe o cliente e preenche com a sua última carga (área, destino, Incoterm, modalidade,
   * equipamento e limites). Devolve a última carga usada (ou null).
   * Endereço: o do cadastro (rua, complemento, bairro, CEP, cidade, estado em uma linha); sem endereço
   * no cadastro, o da última carga. Agente: o do cadastro. Transportadora, condição de pagamento e CFOP: os da
   * última carga (sem carga anterior: vazios), menos os que o usuário já mexeu.
   */
  function applyCustomer(id: string, curCountry: string): LastLoad | null {
    setCustomer(id)
    const c = p.customers.find((x) => String(x.id) === id)
    setAgentId(c?.agentId ?? '')
    const last = p.lastLoad?.[id] ?? null
    setFilledFrom(last)
    setCustomerAddress(c?.address || last?.customerAddress || '')
    // transportadora (só se ainda ativa), condição de pagamento e CFOP da última carga; sem carga anterior: vazios
    if (!touched.tc) setTcId(last?.transportCompanyId != null && companies.some((x) => x.id === last.transportCompanyId) ? last.transportCompanyId : null)
    if (!touched.terms) setTerms(last?.paymentTerms ?? null)
    if (!touched.cfop) setCfop(last?.cfop ?? '')
    if (!last) {
      // sem última carga: o país do cadastro, a menos que o usuário tenha digitado outro destino
      if (c?.country && (!curCountry || curCountry === countryAuto)) {
        setCountry(c.country)
        setCountryAuto(c.country)
      }
      return null
    }
    setOriginPlace(last.originPlace)
    setOriginTouched(Boolean(last.originPlace))
    setOriginMode(TYPE_INFO[last.service].placeMode)
    setDestinationPlace(last.destinationPlace)
    if (p.areas.includes(last.area)) {
      setArea(last.area)
      refForArea(last.area)
    }
    const lastCountry = last.country || c?.country
    setCountry(lastCountry || curCountry)
    if (lastCountry) setCountryAuto(lastCountry)
    setIncoterm(last.incoterm)
    if (!typeTouched) {
      setService(last.service)
      setEquipment(last.equipment && optsFor(last.service).some((o) => o.value === last.equipment) ? last.equipment : defaultFor(last.service))
      setMaxHeight(last.maxHeightMm ? String(last.maxHeightMm) : '')
      if (last.courierDivisor) setDivisor(String(last.courierDivisor))
    }
    setProfiles(last.profiles.filter((pid) => p.profiles.some((o) => o.value === pid)))
    return last
  }
  // atalho de IA: lê o texto (sessionStorage) e sugere país e contêiner citados nele
  const [aiText, setAiText] = useState('')
  useEffect(() => {
    if (!p.aiMode) return
    let t = ''
    try {
      t = sessionStorage.getItem('lp:aiPrompt') ?? ''
    } catch {
      t = ''
    }
    if (!t) return
    /* eslint-disable react-hooks/set-state-in-effect -- leitura única do texto vindo da página principal */
    setAiText(t)
    // 1) cliente citado no texto ("camión completo para Danilo") → preenche com a última carga dele
    const cid = customerInText(t, p.customers.map((c) => ({ id: c.id, name: c.name })))
    const last = cid != null ? applyCustomer(String(cid), '') : null
    // 2) o que o texto disser explicitamente prevalece: país, modalidade e contêiner
    const c = countryInText(t)
    if (c) setCountry(canonicalCountry(c) ?? c)
    // tipo de envio citado no texto (LCL, courier, aéreo solto…): só se o usuário ainda não escolheu o tipo
    const m = typeTouched ? null : serviceInText(t)
    if (m) {
      const s = m
      setService(s)
      // mesmo tipo da última carga do cliente: mantém o equipamento dela; senão, o padrão do tipo
      if (!last || last.service !== s) setEquipment(defaultFor(s))
    }
    // só quando o texto cita o contêiner explicitamente ("20%" ou "20 paletes" não contam)
    const eq = /\b40\s*-?\s*hc\b|high\s*cube/i.test(t) ? /^40HC/i : /\b20\s*(gp|dry|p[eé]s|pies|ft|feet|')|(cont[eê]i?ner|contenedor|container)\s+(de\s+)?20\b/i.test(t) ? /^20GP/i : null
    const hit = eq && p.containers.find((o) => eq.test(o.label))
    if (hit) {
      setService('FCL')
      setEquipment(hit.value)
    }
    /* eslint-enable react-hooks/set-state-in-effect */
    // eslint-disable-next-line react-hooks/exhaustive-deps -- leitura única ao abrir (applyCustomer usa só props estáveis)
  }, [p.aiMode, p.containers])
  return (
    <form
      action={action}
      onSubmit={(e) => {
        // CFOP ou condição de pagamento inválidos: corrigir antes de criar (o servidor também confere)
        const err = cfopErr ?? (termsErr.length ? `Condição de pagamento: ${termsErr.join(' ')}` : null)
        setClientError(err)
        if (err) e.preventDefault()
      }}
    >
      {state.error && <div className="alert error">{state.error}</div>}
      {aiText && (
        <div className="alert ok" style={{ display: 'flex', gap: 8, alignItems: 'flex-start' }}>
          <span>✨</span>
          <span>
            <strong>Ao criar o plano, o assistente IA vai montar:</strong> “{aiText}”
            <br />
            <small className="muted">Confira cliente, país, Incoterm e equipamento (sugeridos a partir do texto quando possível).</small>
          </span>
          <input type="hidden" name="ia" value="1" />
        </div>
      )}
      <fieldset>
        <legend>1 · Cliente e destino</legend>
        <div className="form-grid">
          <label className="field">
            Área *
            {p.areas.length > 1 ? (
              <select
                value={area}
                onChange={(e) => {
                  const a = e.target.value as Area
                  setArea(a)
                  refForArea(a)
                  // mercado interno: rodoviário e Brasil como ponto de partida (editáveis);
                  // o tipo escolhido pelo usuário não é trocado
                  if (!typeTouched) chooseService(a === 'DOMESTIC' ? 'ROAD' : 'FCL', false)
                  if (a === 'DOMESTIC' && !country) setCountry('Brasil')
                }}
              >
                {p.areas.map((a) => (
                  <option key={a} value={a}>
                    {AREA_LABEL[a]}
                  </option>
                ))}
              </select>
            ) : (
              <input value={AREA_LABEL[area]} readOnly disabled />
            )}
            <input type="hidden" name="area" value={area} />
          </label>
          <label className="field">
            Cliente
            <CustomerPicker name="customerId" customers={p.customers} value={customer ? Number(customer) : null} onChange={(id) => applyCustomer(id == null ? '' : String(id), country)} />
          </label>
          {filledFrom && customer && (
            <div className="alert ok" style={{ gridColumn: '1 / -1', margin: 0 }}>
              Preenchido com a última carga deste cliente: <strong>{filledFrom.plan}</strong> ({filledFrom.date}). Confira e ajuste se precisar.
            </div>
          )}
          {!customer && (
            <label className="field">
              Nome do novo cliente
              <input name="newCustomer" defaultValue={v.newCustomer} />
            </label>
          )}
          <label className="field" style={{ gridColumn: '1 / -1' }}>
            Endereço do cliente
            <input name="customerAddress" value={customerAddress} onChange={(e) => setCustomerAddress(e.target.value)} placeholder="rua, número, bairro, CEP, cidade (sugerido do cadastro do cliente)" />
          </label>
          <label className="field">
            País de destino *
            <CountryInput name="country" value={country} onChange={setCountry} required />
          </label>
          <label className="field">
            {orderRefFieldLabel(area)}
            <input name="orderRef" value={orderRef} onChange={(e) => setOrderRef(e.target.value)} placeholder={area === 'EXPORT' ? 'Proforma 1234' : ''} />
          </label>
          {area === 'EXPORT' && (p.agents ?? []).length > 0 && (
            <label className="field" title="A comissão do agente (por família de produto) entra no preço desta carga">
              Agente (comissão)
              <select name="agentId" value={agentId} onChange={(e) => setAgentId(e.target.value)}>
                <option value="">— sem agente —</option>
                {(p.agents ?? []).map((a) => (
                  <option key={a.value} value={a.value}>
                    {a.label}
                  </option>
                ))}
              </select>
            </label>
          )}
          <label className="field">
            Incoterm *
            <select name="incoterm" value={incoterm} onChange={(e) => setIncoterm(e.target.value)}>
              {INCOTERMS.map((i) => (
                <option key={i}>{i}</option>
              ))}
            </select>
          </label>
          <label className="field">
            Transportadora — opcional
            <TransportCompanyPicker
              name="transportCompanyId"
              companies={companies}
              value={tcId}
              onChange={(id) => {
                setTcId(id)
                setTouched((t) => ({ ...t, tc: true }))
              }}
              featured={tcFeatured}
            />
          </label>
          <label className="field" title="CFOP do pedido (vale para todas as unidades). Uso interno/fiscal: não sai nos PDFs do cliente.">
            CFOP — opcional
            <input
              name="cfop"
              value={cfop}
              onChange={(e) => {
                setCfop(e.target.value)
                setTouched((t) => ({ ...t, cfop: true }))
                setClientError(null)
              }}
              onBlur={() => setCfop(cfopValue ?? '')}
              placeholder={CFOP_PLACEHOLDER}
              inputMode="decimal"
              maxLength={12}
              autoComplete="off"
              aria-invalid={cfopErr ? true : undefined}
              style={cfopErr ? { borderColor: 'var(--crit)' } : undefined}
            />
            {cfopErr ? (
              <small style={{ color: 'var(--crit)' }}>{cfopErr}</small>
            ) : cfopWarn ? (
              <small style={{ color: '#b35f00' }}>{cfopWarn}</small>
            ) : (
              <small className="muted">uso interno/fiscal — não sai nos PDFs do cliente</small>
            )}
          </label>
          {area === 'EXPORT' && (
            <div style={{ gridColumn: '1 / -1' }}>
              <PaymentTermsFields
                idPrefix="nova-pagamento"
                value={terms}
                onChange={(t) => {
                  setTerms(t)
                  setTouched((x) => ({ ...x, terms: true }))
                  setClientError(null)
                }}
              />
            </div>
          )}
          <input type="hidden" name="paymentTerms" value={termsOn ? JSON.stringify(termsOn) : ''} />
        </div>
      </fieldset>
      <fieldset>
        <legend>2 · Tipo de envio</legend>
        <input type="hidden" name="service" value={service} />
        {(['Com equipamento (editor 3D)', 'Sem equipamento (paletes / volumes)'] as const).map((g, gi) => (
          <div key={g} style={{ marginBottom: 8 }}>
            <small className="muted">{g}</small>
            <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginTop: 4 }}>
              {SHIPMENT_SERVICES.filter((s) => TYPE_INFO[s].equipment === (gi === 0)).map((s) => (
                <button
                  key={s}
                  type="button"
                  className={`small ${service === s ? 'active' : ''}`}
                  onClick={() => chooseService(s)}
                  title={TYPE_INFO[s].hint}
                  style={{ textAlign: 'left', padding: '6px 10px' }}
                >
                  <strong>{TYPE_INFO[s].label}</strong>
                  <br />
                  <small className="muted">{TYPE_INFO[s].hint}</small>
                </button>
              ))}
            </div>
          </div>
        ))}
        <div className="form-grid">
          {!noEq && (
            <label className="field">
              Equipamento *
              <select name="equipment" value={equipment} onChange={(e) => setEquipment(e.target.value)}>
                {eqOpts.map((o) => (
                  <option key={o.value} value={o.value}>
                    {o.label}
                  </option>
                ))}
              </select>
            </label>
          )}
          {noEq && service !== 'COURIER' && (
            <label className="field">
              Altura máxima do palete carregado (mm) *
              <input name="maxHeightMm" inputMode="decimal" value={maxHeight} onChange={(e) => setMaxHeight(e.target.value)} placeholder={(info.defaultHeightMm ?? 2000).toLocaleString('pt-BR') + ' (ou 1,8 m)'} />
            </label>
          )}
          {service === 'COURIER' && (
            <label className="field">
              Divisor volumétrico (cm³/kg) *
              <input name="courierDivisor" inputMode="decimal" value={divisor} onChange={(e) => setDivisor(e.target.value)} />
            </label>
          )}
        </div>
        {!noEq && cur?.detail && <p className="muted">{cur.detail}</p>}
        {noEq && (
          <p className="muted">
            {service === 'COURIER'
              ? 'Depois de criar, informe os produtos: cada caixa vira um volume; o PDF traz peso real, volumétrico e taxável.'
              : 'Depois de criar, abre o planejador de paletes mistos: informe o pedido e o sistema monta os paletes (salvos nesta carga).'}
          </p>
        )}
        {equipment.startsWith('VEHICLE:') && (
          <div className="form-grid">
            <label className="field">
              Comprimento útil do caminhão (mm) — opcional
              <input name="lengthMm" inputMode="decimal" defaultValue={v.lengthMm} placeholder="o do cadastro; digite o real se for diferente" />
            </label>
          </div>
        )}
        <div className="form-grid">
          <label className="field">
            {pl.origin}
            <input
              name="originPlace"
              value={originMode && originMode !== info.placeMode ? originOrDefault('', info.placeMode, false) : originOrDefault(originPlace, info.placeMode, originTouched)}
              onChange={(e) => {
                setOriginPlace(e.target.value)
                setOriginTouched(true)
                setOriginMode(info.placeMode)
              }}
              placeholder={pl.originHint}
            />
          </label>
          <label className="field">
            {pl.destination}
            <input name="destinationPlace" value={destinationPlace} onChange={(e) => setDestinationPlace(e.target.value)} placeholder={pl.destinationHint} />
          </label>
        </div>
      </fieldset>
      {!noEq && <fieldset>
        <legend>3 · Confirmar limites</legend>
        <p className="muted" style={{ marginTop: 0 }}>
          O limite efetivo será o MENOR entre o equipamento e os perfis selecionados (transportador, legal/rota, operacional). Pode ser alterado depois no editor.
        </p>
        {p.profiles.map((o) => (
          <label key={o.value} className="check">
            <input type="checkbox" name="profiles" value={o.value} checked={profiles.includes(o.value)} onChange={(e) => setProfiles((xs) => (e.target.checked ? [...xs, o.value] : xs.filter((x) => x !== o.value)))} /> {o.label}
          </label>
        ))}
      </fieldset>}
      <label className="field" style={{ marginBottom: 12 }}>
        Observações
        <textarea name="notes" rows={2} defaultValue={v.notes} />
      </label>
      {clientError && <div className="alert error">{clientError}</div>}
      <button className="primary" disabled={pending || (!noEq && !equipment)}>
        {noEq ? (service === 'COURIER' ? 'Criar e informar os volumes' : 'Criar e montar os paletes') : 'Criar plano e abrir editor 3D'}
      </button>
    </form>
  )
}
