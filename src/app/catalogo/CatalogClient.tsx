'use client'

import { kitFamilyOf } from '@/domain/kitBoxes'
import { eanStatusOf } from '@/domain/catalogImport/ean'
import type { EanStatus } from '@/domain/catalogImport/types'
import { useEffect, useMemo, useRef, useState, useTransition, Fragment } from 'react'
import { kg, nf0, nf2, VERIFICATION_LABEL } from '@/components/format'

const PRICE_UNIT_SHORT: Record<string, string> = { UNIT: '/un', BOX: '/cx', PALLET: '/pal' }
import { isOrientation, ORIENTATION_LABEL, ORIENTATIONS } from '@/domain/geometry'
import { DEFAULT_ORIENTATIONS, ORIENTATION_POLICIES, POLICY_LABEL, policyOf } from '@/domain/orientation'
import { productKind, requiredFields, TechField } from '@/domain/productOrder'
import { TechCells, TechHeaders } from '@/components/TechCells'
import { FamilyTech, TECH_OPTIONS, TECHNOLOGIES, parseTechOption, techBadge, techOptionValue } from '@/domain/technology'
import { calcLengthM, isCalculatedNet, packRecalcBlocker, perimeterFor, siloBagFormulaText, siloBagNetKg, type SiloPerimeter } from '@/domain/siloPerimeter'
import { CatalogItemInput, deleteCatalogItemAction, deleteFamilyAction, saveCatalogItemAction, saveFamilyAction } from './actions'
import { PerimeterEditor } from './PerimeterEditor'

export interface CatalogFamily {
  id: number
  code: string
  name: string
  /** tecnologia comercial nos PDFs (PACIFIL NXT: menção ou selo); null = nenhuma */
  tech: FamilyTech | null
  lines: string[]
  /** perímetro real por diâmetro — só na família Silo-bolsa (vazio = nenhum definido; ausente = não se aplica) */
  perimeters?: SiloPerimeter[]
}

type FamilyForm = { id: number | null; name: string; code: string; tech: string }

export interface CatalogRow {
  variantId: number
  familyId: number
  line: string
  sku: string
  name: string
  /** marca comercial (Pacifil, EcoBag…) */
  brand: string
  /** código de barras como veio da planilha oficial (texto); null = sem EAN */
  ean: string | null
  /** validade do código de barras: EAN-13, GTIN-14 (código da caixa) ou inválido */
  eanStatus: EanStatus | null
  /** código da caixa na tabela de caixas (attrs.codigo_caixa); null = não informado */
  boxCode: string | null
  /** especificação resumida ("9 pés × 60 m · 210 µm", "10.000 L") */
  spec: string
  /** dados técnicos completos (dica) */
  tech: string
  /** espessura (µm); null = não informada */
  thicknessUm: number | null
  /** medidas do produto (campos próprios) */
  diameterFt: number | null
  widthM: number | null
  lengthM: number | null
  lengthFt: number | null
  /** silo-bolsa: perímetro real do diâmetro (m); null = não definido (vale o peso da planilha) */
  perimeterM: number | null
  /** silo-bolsa: peso líquido pelo perímetro real (kg, 2 casas); null = sem perímetro ou falta comprimento/espessura */
  calcNetKg: number | null
  /** campos que a família exige (vazios → vermelho) */
  required: TechField[]
  notes: string
  price: number | null
  priceCurrency: string
  priceUnit: string
  pack: null | {
    version: number
    locked: boolean
    packageType: string
    lengthMm: number
    widthMm: number
    heightMm: number
    netKg: number
    grossKg: number
    unitsPerPallet: number | null
    unitsPerPackage: number
    palletTypeId: number | null
    palletCode: string | null
    verification: string
    stackable: boolean
    allowedOrientations: string[]
  }
}

interface Props {
  families: CatalogFamily[]
  rows: CatalogRow[]
  pallets: { id: number; label: string }[]
  editable: boolean
  /** sem can.viewPrices (Expedição): a coluna "Preço" nem aparece (o servidor já manda os preços nulos) */
  showPrices: boolean
}

const dec = (v: number | null | undefined) => (v == null ? '' : String(v).replace('.', ','))
/** número digitado (vírgula ou ponto); vazio ou inválido → null */
const numOf = (s: string) => (/^\d+([.,]\d+)?$/.test(s.trim()) ? Number(s.trim().replace(',', '.')) : null)
/** kg com as 3 casas do banco (116,763): mostra a diferença que separa o cadastrado do calculado */
const kg3 = (x: number) => `${x.toLocaleString('pt-BR', { maximumFractionDigits: 3 })} kg`

/**
 * peso líquido do silo-bolsa pelo perímetro real com as medidas digitadas (a mesma regra do servidor ao salvar:
 * só com 1 unidade por caixa); null = o diâmetro não tem perímetro real. netKg null → `note` diz o que falta.
 */
function siloCalc(v: CatalogItemInput, fam: CatalogFamily | undefined): { netKg: number; formula: string } | { netKg: null; note: string } | null {
  const perimeterM = fam?.perimeters ? perimeterFor(fam.perimeters, numOf(v.diameterFt)) : null
  if (perimeterM == null) return null
  const upk = v.unitsPerPackage.trim() === '' ? 1 : numOf(v.unitsPerPackage)
  if (upk !== 1) return { netKg: null, note: 'Diâmetro com perímetro real, mas a caixa leva mais de 1 unidade: o peso líquido não é calculado' }
  const lengthM = calcLengthM({ lengthM: numOf(v.lengthM), lengthFt: numOf(v.lengthFt) })
  const thicknessUm = /^\d+$/.test(v.thicknessUm.trim()) ? Number(v.thicknessUm.trim()) : null
  const netKg = siloBagNetKg({ perimeterM, lengthM, thicknessUm })
  if (netKg == null || lengthM == null || thicknessUm == null) return { netKg: null, note: 'Diâmetro com perímetro real: informe comprimento e espessura para calcular' }
  return { netKg, formula: siloBagFormulaText({ perimeterM, lengthM, thicknessUm }) }
}

/** peso líquido na tabela: selo "calculado" (perímetro real) ou "≠ cálculo" quando o cadastrado ainda é o da planilha */
function NetKgCell({ r }: { r: CatalogRow }) {
  const p = r.pack
  const lengthM = calcLengthM(r)
  const formula = r.calcNetKg != null && r.perimeterM != null && lengthM != null && r.thicknessUm != null ? siloBagFormulaText({ perimeterM: r.perimeterM, lengthM, thicknessUm: r.thicknessUm }) : null
  return (
    <td className="num" style={p && p.netKg <= 0 ? { color: 'var(--warn)' } : undefined}>
      {p ? (p.netKg > 0 ? kg(p.netKg) : 'não informado') : '—'}
      {p && r.calcNetKg != null && (
        <>
          <br />
          {isCalculatedNet(p.netKg, r.calcNetKg) ? (
            <span className="exp-src calc" title={`${formula} = ${nf2.format(r.calcNetKg)} kg`}>
              calculado
            </span>
          ) : (
            <span className="badge WARNING" title={`Calculado: ${nf2.format(r.calcNetKg)} kg (${formula}); cadastrado: ${kg3(p.netKg)}. ${packRecalcBlocker(p) ?? 'Salve os perímetros em Editar família para recalcular.'}`}>
              ≠ cálculo
            </span>
          )}
        </>
      )}
    </td>
  )
}

export function CatalogClient({ families, rows, pallets, editable, showPrices }: Props) {
  const [q, setQ] = useState('')
  const [famFilter, setFamFilter] = useState<string>('')
  const [brandFilter, setBrandFilter] = useState<string>('')
  const brands = useMemo(() => [...new Set(rows.map((r) => r.brand))].sort((a, b) => (a === 'Pacifil' ? -1 : b === 'Pacifil' ? 1 : a.localeCompare(b))), [rows])
  // guarda as recolhidas: famílias novas aparecem abertas
  const [closed, setClosed] = useState<Set<number>>(new Set())
  const [editing, setEditing] = useState<CatalogItemInput | null>(null)
  const [famEditing, setFamEditing] = useState<FamilyForm | null>(null)
  const [flash, setFlash] = useState<{ type: 'ok' | 'error'; text: string } | null>(null)
  const [, startTransition] = useTransition()

  const toggle = (id: number) => {
    const x = new Set(closed)
    if (x.has(id)) x.delete(id)
    else x.add(id)
    setClosed(x)
  }

  const term = q.trim().toLowerCase()
  const filtered = useMemo(
    () =>
      rows.filter(
        (r) =>
          (!famFilter || String(r.familyId) === famFilter) &&
          (!brandFilter || r.brand === brandFilter) &&
          (!term || `${r.sku} ${r.name} ${r.line} ${r.brand} ${r.spec} ${r.ean ?? ''} ${r.boxCode ?? ''}`.toLowerCase().includes(term)),
      ),
    [rows, famFilter, brandFilter, term],
  )
  const visibleFamilies = families.filter((f) => !famFilter || String(f.id) === famFilter)

  function newItem(familyId?: number) {
    setEditing({
      variantId: null,
      familyId: String(familyId ?? (famFilter ? Number(famFilter) : families[0]?.id ?? '')),
      line: '',
      sku: '',
      name: '',
      lengthMm: '',
      widthMm: '',
      heightMm: '',
      netKg: '',
      grossKg: '',
      unitsPerPallet: '',
      unitsPerPackage: '1',
      palletTypeId: '',
      packageType: 'Caixa',
      verification: 'UNVERIFIED',
      stackable: true,
      allowedOrientations: [...DEFAULT_ORIENTATIONS],
      brand: 'Pacifil',
      thicknessUm: '',
      diameterFt: '',
      widthM: '',
      lengthM: '',
      lengthFt: '',
      ean: '',
      boxCode: '',
      notes: '',
      price: '',
      priceCurrency: 'USD',
      priceUnit: 'UNIT',
    })
  }
  function editItem(r: CatalogRow) {
    const p = r.pack
    setEditing({
      variantId: r.variantId,
      familyId: String(r.familyId),
      line: r.line,
      sku: r.sku,
      name: r.name,
      lengthMm: p ? String(p.lengthMm) : '',
      widthMm: p ? String(p.widthMm) : '',
      heightMm: p ? String(p.heightMm) : '',
      netKg: p ? dec(p.netKg) : '',
      grossKg: p ? dec(p.grossKg) : '',
      unitsPerPallet: p?.unitsPerPallet != null ? String(p.unitsPerPallet) : '',
      unitsPerPackage: p ? String(p.unitsPerPackage) : '1',
      palletTypeId: p?.palletTypeId != null ? String(p.palletTypeId) : '',
      packageType: p?.packageType ?? 'Caixa',
      verification: p?.verification ?? 'UNVERIFIED',
      stackable: p?.stackable ?? true,
      allowedOrientations: p?.allowedOrientations ?? [...DEFAULT_ORIENTATIONS],
      brand: r.brand,
      thicknessUm: r.thicknessUm != null ? String(r.thicknessUm) : '',
      diameterFt: dec(r.diameterFt),
      widthM: dec(r.widthM),
      lengthM: dec(r.lengthM),
      lengthFt: dec(r.lengthFt),
      ean: r.ean ?? '',
      boxCode: r.boxCode ?? '',
      notes: r.notes,
      price: r.price != null ? dec(r.price) : '',
      priceCurrency: r.priceCurrency,
      priceUnit: r.priceUnit,
    })
  }
  function removeItem(r: CatalogRow) {
    if (!confirm(`Excluir o produto ${r.sku} — ${r.name}?\n\nEle deixa de aparecer no catálogo e nos editores. Cargas já salvas não são alteradas.`)) return
    startTransition(async () => {
      const res = await deleteCatalogItemAction(r.variantId)
      setFlash(res.ok ? { type: 'ok', text: `Produto ${r.sku} excluído.` } : { type: 'error', text: res.error ?? 'Erro ao excluir.' })
    })
  }
  function removeFamily(f: CatalogFamily) {
    if (!confirm(`Excluir a família "${f.name}"?`)) return
    startTransition(async () => {
      const res = await deleteFamilyAction(f.id)
      setFlash(res.ok ? { type: 'ok', text: `Família "${f.name}" excluída.` } : { type: 'error', text: res.error ?? 'Erro ao excluir.' })
    })
  }

  return (
    <>
      <div className="page-head">
        <h1>Catálogo logístico</h1>
        {editable && (
          <>
            <button onClick={() => setFamEditing({ id: null, name: '', code: '', tech: '' })}>+ Nova família</button>
            <button className="primary" onClick={() => newItem()} disabled={!families.length}>
              + Adicionar produto
            </button>
          </>
        )}
      </div>
      <p className="muted" style={{ marginTop: -8 }}>
        Embalagem e paletização de cada produto. Medidas em mm, pesos em kg. Alterar medidas/pesos de uma embalagem já usada em carga cria automaticamente uma nova versão.
      </p>
      {flash && (
        <div className={`alert ${flash.type}`} onClick={() => setFlash(null)}>
          {flash.text}
        </div>
      )}

      <div className="panel row" style={{ marginBottom: 12 }}>
        <input placeholder="Buscar por código, descrição, EAN ou caixa…" value={q} onChange={(e) => setQ(e.target.value)} style={{ flex: 1, minWidth: 220 }} />
        <select value={famFilter} onChange={(e) => setFamFilter(e.target.value)}>
          <option value="">Todas as famílias</option>
          {families.map((f) => (
            <option key={f.id} value={f.id}>
              {f.name}
            </option>
          ))}
        </select>
        <select value={brandFilter} onChange={(e) => setBrandFilter(e.target.value)}>
          <option value="">Todas as marcas</option>
          {brands.map((b) => (
            <option key={b} value={b}>
              {b}
            </option>
          ))}
        </select>
        <button className="small" onClick={() => setClosed(new Set())}>
          Expandir tudo
        </button>
        <button className="small" onClick={() => setClosed(new Set(families.map((f) => f.id)))}>
          Recolher tudo
        </button>
        <span className="muted">
          {filtered.length} de {rows.length} produto(s)
        </span>
      </div>

      {visibleFamilies.map((f) => {
        const items = filtered.filter((r) => r.familyId === f.id)
        if (term && items.length === 0) return null
        const isOpen = !closed.has(f.id) || Boolean(term)
        return (
          <section key={f.id} className="panel" style={{ marginBottom: 10, padding: 0 }}>
            <div className="row" style={{ padding: '10px 14px', cursor: 'pointer', userSelect: 'none' }} onClick={() => toggle(f.id)}>
              <span style={{ width: 14, display: 'inline-block' }}>{isOpen ? '▾' : '▸'}</span>
              <strong style={{ fontSize: 15 }}>{f.name}</strong>
              <span className="badge DRAFT">{items.length}</span>
              {f.tech && (
                <span className="badge INFO" title={TECHNOLOGIES[f.tech.key].title}>
                  {techBadge(f.tech)}
                </span>
              )}
              <span className="spacer" />
              {editable && (
                <span className="row" onClick={(e) => e.stopPropagation()}>
                  <button className="small" onClick={() => newItem(f.id)}>
                    + Produto
                  </button>
                  <button className="small" onClick={() => setFamEditing({ id: f.id, name: f.name, code: f.code, tech: techOptionValue(f.tech) })}>
                    Editar família
                  </button>
                  <button className="small danger" onClick={() => removeFamily(f)}>
                    Excluir família
                  </button>
                </span>
              )}
            </div>
            {isOpen &&
              (items.length === 0 ? (
                <p className="muted" style={{ padding: '0 14px 12px', margin: 0 }}>
                  Nenhum produto nesta família.
                </p>
              ) : (
                <table className="data">
                  <thead>
                    <tr>
                      <th>Cód.</th>
                      <th>Marca</th>
                      <th>Descrição</th>
                      <th>Especificação</th>
                      <TechHeaders familyName={f.name} />
                      <th>Caixa</th>
                      <th className="num">Medidas da caixa C × L × A (mm)</th>
                      <th className="num">Peso líquido</th>
                      <th className="num" title="Produto + caixa (sem palete)">Peso c/ embalagem</th>
                      <th className="num">Caixas / palete</th>
                      <th>Palete</th>
                      {showPrices && <th className="num">Preço</th>}
                      <th>Dados</th>
                      {editable && <th />}
                    </tr>
                  </thead>
                  <tbody>
                    {items.map((r) => (
                      <Fragment key={r.variantId}>
                      <tr>
                        <td>
                          <strong>{r.sku}</strong>
                          <EanInfo ean={r.ean} status={r.eanStatus} />
                        </td>
                        <td>
                          <span className={`brand-tag ${r.brand === 'Pacifil' ? 'own' : ''}`}>{r.brand}</span>
                        </td>
                        <td>
                          {r.name}
                          <br />
                          <small className="muted">{r.line}</small>
                        </td>
                        <td title={r.tech || undefined} style={{ whiteSpace: 'nowrap' }}>
                          {r.spec || <span className="muted">—</span>}
                          {r.tech && <small className="muted"> ⓘ</small>}
                        </td>
                        <TechCells familyName={f.name} v={r} />
                        <td style={{ whiteSpace: 'nowrap' }}>{r.boxCode ?? <span className="muted">—</span>}</td>
                        <td className="num">{r.pack ? `${nf0.format(r.pack.lengthMm)} × ${nf0.format(r.pack.widthMm)} × ${nf0.format(r.pack.heightMm)}` : <span className="badge UNVERIFIED">sem embalagem</span>}</td>
                        <NetKgCell r={r} />
                        <td className="num">{r.pack ? kg(r.pack.grossKg) : '—'}</td>
                        <td className="num">{r.pack?.unitsPerPallet ?? '—'}</td>
                        <td style={{ whiteSpace: 'nowrap' }}>{r.pack?.palletCode ?? '—'}</td>
                        {showPrices && (
                          <td className="num" style={{ whiteSpace: 'nowrap' }}>{r.price != null ? `${r.priceCurrency} ${nf2.format(r.price)}${PRICE_UNIT_SHORT[r.priceUnit] ?? ''}` : <span className="muted">—</span>}</td>
                        )}
                        <td>
                          {r.pack && <span className={`badge ${r.pack.verification}`}>{VERIFICATION_LABEL[r.pack.verification]}</span>}{' '}
                          {r.pack && <small className="muted">v{r.pack.version}</small>}
                        </td>
                        {editable && (
                          <td style={{ whiteSpace: 'nowrap' }}>
                            <button className="small" onClick={() => editItem(r)}>
                              Editar
                            </button>{' '}
                            <button className="small danger" onClick={() => removeItem(r)}>
                              Excluir
                            </button>
                          </td>
                        )}
                      </tr>
                      {/* kit com caixas coletivas (ex.: KIT-HF): as opções usadas automaticamente nos paletes */}
                      {r.pack &&
                        kitFamilyOf(r.sku) &&
                        (() => {
                          const fam = kitFamilyOf(r.sku)!
                          return [
                            // caixa exata (ex.: 69488 de 36): só quando o palete leva exatamente essa quantidade
                            ...(fam.exact ?? []).map((b) => ({ k: `x${b.code}`, b, title: `Caixa ${b.code} com ${b.capacity} kits`, note: `Só quando o palete leva exatamente ${b.capacity} kits (palete de ${b.capacity} Hydroforce). Sem altura para ela: caixa de ${fam.big.capacity} + individuais.` })),
                            { k: 'big', b: fam.big, title: `Caixa ${fam.big.code} com ${fam.big.capacity} kits`, note: `Sempre cheia (${fam.big.capacity}). Usada primeiro.` },
                            { k: 'half', b: fam.half, title: `Meia caixa com até ${fam.half.capacity} kits`, note: `Usada para ${fam.halfMinKits >= fam.half.capacity ? fam.half.capacity : `${fam.halfMinKits} a ${fam.half.capacity}`} kits (ou 2 meias caixas para 14 a 25). De 1 a ${fam.halfMinKits - 1} kits: caixas individuais.` },
                          ]
                        })().map(({ k, b, title, note }) => {
                        const kitNet = r.pack!.netKg
                        const kitGross = r.pack!.grossKg
                        return (
                          <tr key={`${r.variantId}-${k}`} className="muted" style={{ background: 'var(--bg-subtle, #f7f9fa)' }}>
                            <td style={{ paddingLeft: 18 }}>↳ {r.sku}</td>
                            <td />
                            <td colSpan={2}>
                              {title}
                              <br />
                              <small>
                                {note} Caixa vazia {kg(b.tareKg)}.
                              </small>
                            </td>
                            <TechCells familyName={f.name} v={r} />
                            {/* meia caixa (79583-M) é código interno: não vai na coluna Caixa */}
                            <td style={{ whiteSpace: 'nowrap' }}>{k === 'half' ? '—' : b.code}</td>
                            <td className="num">{`${nf0.format(b.dims.l)} × ${nf0.format(b.dims.w)} × ${nf0.format(b.dims.h)}`}</td>
                            <td className="num">{kg(b.capacity * kitNet)}</td>
                            <td className="num" title={`${b.capacity} kits × ${kg(kitGross)} + caixa ${kg(b.tareKg)}`}>{kg(b.capacity * kitGross + b.tareKg)}</td>
                            <td className="num">—</td>
                            <td>sobre o palete Hydroforce</td>
                            {showPrices && <td className="num">—</td>}
                            <td>
                              <small>automática</small>
                            </td>
                            {editable && <td />}
                          </tr>
                        )
                      })}
                      </Fragment>
                    ))}
                  </tbody>
                </table>
              ))}
          </section>
        )
      })}
      {visibleFamilies.length === 0 && <p className="muted">Nenhuma família cadastrada. Use “+ Nova família”.</p>}

      {editing && (
        <ItemDialog
          value={editing}
          families={families}
          pallets={pallets}
          showPrices={showPrices}
          locked={rows.find((r) => r.variantId === editing.variantId)?.pack?.locked ?? false}
          onClose={() => setEditing(null)}
          onSaved={(sku, isNew) => {
            setEditing(null)
            setFlash({ type: 'ok', text: isNew ? `Produto ${sku} adicionado.` : `Produto ${sku} atualizado.` })
          }}
        />
      )}
      {famEditing && (
        <FamilyDialog
          value={famEditing}
          family={famEditing.id != null ? families.find((f) => f.id === famEditing.id) : undefined}
          rows={rows}
          onClose={() => setFamEditing(null)}
          onSaved={(name, isNew) => {
            setFamEditing(null)
            setFlash({ type: 'ok', text: isNew ? `Família "${name}" criada.` : `Família "${name}" atualizada.` })
          }}
        />
      )}
    </>
  )
}

function Modal({ title, onClose, children }: { title: string; onClose: () => void; children: React.ReactNode }) {
  const ref = useRef<HTMLDialogElement>(null)
  useEffect(() => {
    ref.current?.showModal()
  }, [])
  return (
    <dialog
      ref={ref}
      onCancel={(e) => {
        e.preventDefault()
        onClose()
      }}
      style={{ border: '1px solid var(--border)', borderRadius: 10, padding: 0, width: 'min(860px, 96vw)', maxHeight: '92vh' }}
    >
      <div className="row" style={{ padding: '12px 18px', borderBottom: '1px solid var(--border)', background: '#fafbfc' }}>
        <strong style={{ fontSize: 16 }}>{title}</strong>
        <span className="spacer" />
        <button className="small" onClick={onClose} aria-label="Fechar">
          ✕
        </button>
      </div>
      <div style={{ padding: 18, overflow: 'auto' }}>{children}</div>
    </dialog>
  )
}

function Field({ label, error, children, unit, wide }: { label: string; error?: string; children: React.ReactNode; unit?: string; wide?: boolean }) {
  return (
    <label className="field" style={wide ? { gridColumn: '1 / -1' } : undefined}>
      <span>
        {label} {unit && <span className="unit">({unit})</span>}
      </span>
      {children}
      {error && <span className="field-error">{error}</span>}
    </label>
  )
}

/** EAN abaixo do código; selo quando não é um EAN-13 válido (GTIN-14 = código da caixa; inválido = conferir) */
function EanInfo({ ean, status }: { ean: string | null; status: EanStatus | null }) {
  if (!ean) return null
  const st = status ?? eanStatusOf(ean).status
  return (
    <>
      <br />
      <small className="muted" style={{ whiteSpace: 'nowrap' }}>
        EAN {ean}
      </small>
      {st === 'GTIN14' && (
        <>
          {' '}
          <span className="badge INFO" style={{ whiteSpace: 'nowrap' }} title="GTIN-14 (DUN-14): código de barras da caixa, não o EAN da unidade">
            GTIN-14 caixa
          </span>
        </>
      )}
      {st === 'INVALID' && (
        <>
          {' '}
          <span className="badge WARNING" style={{ whiteSpace: 'nowrap' }} title={eanStatusOf(ean).note ?? 'EAN inválido'}>
            EAN inválido
          </span>
        </>
      )}
    </>
  )
}

/** dica ao digitar o EAN (não bloqueia: o EAN é guardado como veio, com o estado de validade) */
function EanHint({ ean }: { ean: string }) {
  const e = ean.trim()
  if (!e) return null
  const { status, note } = eanStatusOf(e)
  if (status === 'EAN13') return <small className="muted">EAN-13 válido</small>
  if (status === 'GTIN14') return <small className="muted">GTIN-14: código de barras da caixa</small>
  return <small style={{ color: 'var(--warn)' }}>Inválido: {note}</small>
}

function ItemDialog({
  value,
  families,
  pallets,
  showPrices,
  locked,
  onClose,
  onSaved,
}: {
  value: CatalogItemInput
  families: CatalogFamily[]
  pallets: { id: number; label: string }[]
  showPrices: boolean
  locked: boolean
  onClose: () => void
  onSaved: (sku: string, isNew: boolean) => void
}) {
  // silo-bolsa com perímetro real: o peso líquido acompanha diâmetro/comprimento/espessura e o peso
  // c/ embalagem anda junto (mantém a tara digitada = c/ embalagem − líquido)
  const withCalc = (o: CatalogItemInput): CatalogItemInput => {
    const c = siloCalc(o, families.find((f) => String(f.id) === o.familyId))?.netKg
    if (c == null) return o
    // embalagem em branco (fora o líquido, que aqui é calculado e não editável): o líquido também fica em branco,
    // senão as medidas da caixa passariam a ser exigidas e não haveria como limpá-lo (embalagem é opcional)
    if (![o.lengthMm, o.widthMm, o.heightMm, o.grossKg, o.unitsPerPallet].some((x) => x.trim() !== '')) return o.netKg === '' ? o : { ...o, netKg: '' }
    const net = numOf(o.netKg)
    if (isCalculatedNet(net, c)) return o
    // líquido não informado (0): a tara é desconhecida — o c/ embalagem digitado fica como está (como no servidor)
    const gross = numOf(o.grossKg)
    return { ...o, netKg: dec(c), grossKg: gross != null && net != null && net > 0 ? dec(Math.round((gross + c - net) * 1000) / 1000) : o.grossKg }
  }
  const [v, setV] = useState(() => withCalc(value))
  const [err, setErr] = useState<{ error?: string; fieldErrors?: Record<string, string> }>({})
  const [pending, startTransition] = useTransition()
  const set = <K extends keyof CatalogItemInput>(k: K, x: CatalogItemInput[K]) => setV((o) => withCalc({ ...o, [k]: x }))
  const fe = err.fieldErrors ?? {}
  const fam = families.find((f) => String(f.id) === v.familyId)
  const isNew = v.variantId == null
  const calc = siloCalc(v, fam)
  // peso que estava cadastrado (planilha), quando o calculado é diferente
  const calcFrom = calc?.netKg != null && value.netKg.trim() !== '' && !isCalculatedNet(numOf(value.netKg), calc.netKg) ? numOf(value.netKg) : null

  function submit(e: React.FormEvent) {
    e.preventDefault()
    startTransition(async () => {
      const r = await saveCatalogItemAction(v)
      if (r.ok) onSaved(v.sku.trim().toUpperCase(), isNew)
      else setErr(r)
    })
  }
  const txt = (k: keyof CatalogItemInput, props: React.InputHTMLAttributes<HTMLInputElement> = {}) => (
    <input value={v[k] as string} onChange={(e) => set(k, e.target.value as never)} aria-invalid={Boolean(fe[k])} {...props} />
  )
  const num = (k: keyof CatalogItemInput, mode: 'numeric' | 'decimal') => txt(k, { inputMode: mode, style: { textAlign: 'right' } })

  return (
    <Modal title={isNew ? '+ Adicionar produto' : `Editar ${value.sku}`} onClose={onClose}>
      <form onSubmit={submit}>
        {err.error && <div className="alert error">{err.error}</div>}
        {locked && (
          <div className="alert warn">A embalagem atual já foi usada em carga salva: se alterar medidas, pesos ou paletização, será criada uma nova versão automaticamente.</div>
        )}
        <fieldset>
          <legend>Produto</legend>
          <div className="form-grid">
            <Field label="Família *" error={fe.familyId}>
              <select value={v.familyId} onChange={(e) => set('familyId', e.target.value)}>
                {families.map((f) => (
                  <option key={f.id} value={f.id}>
                    {f.name}
                  </option>
                ))}
              </select>
            </Field>
            <Field label="Linha / produto" error={fe.line}>
              <input list="catalog-lines" value={v.line} onChange={(e) => set('line', e.target.value)} placeholder={fam?.name} />
              <datalist id="catalog-lines">
                {fam?.lines.map((l) => (
                  <option key={l} value={l} />
                ))}
              </datalist>
            </Field>
            <Field label="Marca" error={fe.brand}>
              <input list="catalog-brands" value={v.brand} onChange={(e) => set('brand', e.target.value)} placeholder="Pacifil" />
              <datalist id="catalog-brands">
                {['Pacifil', 'EcoBag', 'ProBag', 'Bridon', 'ADP'].map((b) => (
                  <option key={b} value={b} />
                ))}
              </datalist>
            </Field>
            <Field label="Cód. *" error={fe.sku}>
              {txt('sku', { style: { textTransform: 'uppercase' } })}
            </Field>
            <Field label="Descrição *" error={fe.name} wide>
              {txt('name')}
            </Field>
            {(() => {
              // medidas do produto (campos próprios) conforme a família; exigidas e vazias → vermelho
              const kind = productKind(fam?.name)
              const req = requiredFields(fam?.name)
              const noLength = !v.lengthM.trim() && !v.lengthFt.trim()
              const missing = (k: 'diameterFt' | 'widthM' | 'lengthM' | 'lengthFt' | 'thicknessUm') =>
                k === 'lengthM' || k === 'lengthFt' ? req.includes('length') && noLength : req.includes(k) && !v[k].trim()
              const box = (k: 'diameterFt' | 'widthM' | 'lengthM' | 'lengthFt' | 'thicknessUm', label: string, placeholder: string, mode: 'numeric' | 'decimal' = 'decimal') => (
                <Field key={k} label={label} error={fe[k] ?? (missing(k) ? (k === 'lengthM' || k === 'lengthFt' ? 'Informe o comprimento (m ou pés)' : 'Não informado — complete este dado') : undefined)}>
                  {txt(k, { inputMode: mode, placeholder, style: { textAlign: 'right', ...(missing(k) ? { borderColor: 'var(--crit)', background: 'var(--crit-bg)' } : {}) } })}
                </Field>
              )
              return (
                <>
                  {kind === 'silo' && box('diameterFt', 'Diâmetro (pés)', 'ex.: 9')}
                  {(kind === 'lona' || kind === 'hidro' || kind === 'animal' || kind === 'other') && box('widthM', 'Largura (m)', 'ex.: 8')}
                  {box('lengthM', 'Comprimento (m)', 'ex.: 60')}
                  {kind === 'silo' && box('lengthFt', 'Comprimento (pés)', 'se vendido em pés, ex.: 300')}
                  {box('thicknessUm', 'Espessura (µm)', 'ex.: 220', 'numeric')}
                </>
              )
            })()}
          </div>
        </fieldset>
        {/* hoje quem edita o catálogo sempre vê preços (editCatalog ⊂ viewPrices); se um dia não vir, os campos somem */}
        {showPrices && (
          <fieldset>
            <legend>Preço de referência</legend>
            <div className="form-grid">
              <Field label="Preço" error={fe.price}>
                {num('price', 'decimal')}
              </Field>
              <Field label="Moeda" error={fe.priceCurrency}>
                {txt('priceCurrency', { maxLength: 3, style: { textTransform: 'uppercase' } })}
              </Field>
              <Field label="Por">
                <select value={v.priceUnit} onChange={(e) => set('priceUnit', e.target.value)}>
                  <option value="UNIT">unidade de produto</option>
                  <option value="BOX">caixa</option>
                  <option value="PALLET">palete</option>
                </select>
              </Field>
            </div>
            <small className="muted">Campo preparado: a regra definitiva de precificação será definida depois. Cargas já salvas mantêm o preço da época.</small>
          </fieldset>
        )}
        <fieldset>
          <legend>Caixa / embalagem</legend>
          <div className="form-grid">
            <Field label="Caixa (cód.)" error={fe.boxCode}>
              {txt('boxCode', { placeholder: 'ex.: 69490', inputMode: 'numeric' })}
            </Field>
            <Field label="EAN" error={fe.ean}>
              {txt('ean', { placeholder: '13 dígitos (14 nos pacotes)', inputMode: 'numeric' })}
              {!fe.ean && <EanHint ean={v.ean} />}
            </Field>
            <Field label="Tipo de volume">{txt('packageType')}</Field>
            <Field label="Comprimento" unit="mm" error={fe.lengthMm}>
              {num('lengthMm', 'numeric')}
            </Field>
            <Field label="Largura" unit="mm" error={fe.widthMm}>
              {num('widthMm', 'numeric')}
            </Field>
            <Field label="Altura" unit="mm" error={fe.heightMm}>
              {num('heightMm', 'numeric')}
            </Field>
            <Field label="Peso líquido" unit="kg" error={fe.netKg}>
              {calc?.netKg != null ? (
                <>
                  <input
                    value={dec(calc.netKg)}
                    readOnly
                    tabIndex={-1}
                    title={`${calc.formula} = ${nf2.format(calc.netKg)} kg`}
                    style={{ textAlign: 'right', background: '#f3f5f7', color: 'var(--muted)', cursor: 'default' }}
                  />
                  <small className="muted" title={`${calc.formula} = ${nf2.format(calc.netKg)} kg`}>
                    Calculado pelo perímetro real (Editar família){calcFrom != null && ` — antes ${kg3(calcFrom)}`}
                    {v.netKg.trim() === '' && ' — será gravado ao cadastrar a caixa'}
                  </small>
                </>
              ) : (
                <>
                  {num('netKg', 'decimal')}
                  {calc && <small className="muted">{calc.note}</small>}
                </>
              )}
            </Field>
            <Field label="Peso c/ embalagem (produto + caixa)" unit="kg" error={fe.grossKg}>
              {num('grossKg', 'decimal')}
            </Field>
            <Field label="Unidades por caixa" error={fe.unitsPerPackage}>
              {num('unitsPerPackage', 'numeric')}
            </Field>
          </div>
        </fieldset>
        <fieldset>
          <legend>Paletização</legend>
          <div className="form-grid">
            <Field label="Caixas por palete" error={fe.unitsPerPallet}>
              {num('unitsPerPallet', 'numeric')}
            </Field>
            <Field label="Palete padrão">
              <select value={v.palletTypeId} onChange={(e) => set('palletTypeId', e.target.value)}>
                <option value="">—</option>
                {pallets.map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.label}
                  </option>
                ))}
              </select>
            </Field>
            <Field label="Status dos dados">
              <select value={v.verification} onChange={(e) => set('verification', e.target.value)}>
                <option value="VERIFIED">Verificado</option>
                <option value="ESTIMATED">Estimado / referência</option>
                <option value="UNVERIFIED">Não verificado</option>
              </select>
            </Field>
            <label className="check" style={{ alignSelf: 'end' }}>
              <input type="checkbox" checked={v.stackable} onChange={(e) => set('stackable', e.target.checked)} /> Empilhável
            </label>
          </div>
          <div style={{ marginTop: 10 }}>
            <div className="muted" style={{ fontSize: 12, marginBottom: 4 }}>
              Orientações permitidas — <strong>{POLICY_LABEL[policyOf(v.allowedOrientations.filter(isOrientation))]}</strong>{' '}
              <button type="button" className="small" onClick={() => set('allowedOrientations', [...ORIENTATION_POLICIES.ANY])}>
                Livre
              </button>{' '}
              <button type="button" className="small" onClick={() => set('allowedOrientations', [...ORIENTATION_POLICIES.UPRIGHT])}>
                Manter em pé
              </button>
            </div>
            <div className="row">
              {ORIENTATIONS.map((o) => (
                <label key={o} className="check">
                  <input
                    type="checkbox"
                    checked={v.allowedOrientations.includes(o)}
                    onChange={(e) => set('allowedOrientations', e.target.checked ? [...v.allowedOrientations, o] : v.allowedOrientations.filter((x) => x !== o))}
                  />
                  {ORIENTATION_LABEL[o]}
                </label>
              ))}
            </div>
            {fe.allowedOrientations && <div className="field-error">{fe.allowedOrientations}</div>}
          </div>
        </fieldset>
        <Field label="Observações" wide>
          <textarea rows={2} value={v.notes} onChange={(e) => set('notes', e.target.value)} />
        </Field>
        <div className="row" style={{ marginTop: 14 }}>
          <span className="muted" style={{ fontSize: 12 }}>
            Medidas em mm inteiros; pesos aceitam vírgula (ex.: 52,5). Embalagem é opcional: deixe em branco se ainda não souber.
          </span>
          <span className="spacer" />
          <button type="button" onClick={onClose}>
            Cancelar
          </button>
          <button className="primary" disabled={pending}>
            {pending ? 'Salvando…' : 'Salvar'}
          </button>
        </div>
      </form>
    </Modal>
  )
}

function FamilyDialog({
  value,
  family,
  rows,
  onClose,
  onSaved,
}: {
  value: FamilyForm
  /** família já cadastrada (undefined = nova) */
  family?: CatalogFamily
  rows: CatalogRow[]
  onClose: () => void
  onSaved: (name: string, isNew: boolean) => void
}) {
  const [v, setV] = useState(value)
  const tech = parseTechOption(v.tech)
  const [err, setErr] = useState<{ error?: string; fieldErrors?: Record<string, string> }>({})
  const [pending, startTransition] = useTransition()
  // perímetros digitados e ainda não salvos (botão próprio do editor): fechar ou salvar a família os descartaria
  const [perimDirty, setPerimDirty] = useState(false)
  const discardPerimOk = () =>
    !perimDirty || window.confirm('Os perímetros digitados ainda não foram salvos (use "Salvar perímetros e recalcular pesos") e serão descartados. Continuar?')
  const guardedClose = () => {
    if (discardPerimOk()) onClose()
  }
  return (
    <Modal title={value.id == null ? '+ Nova família' : `Editar família ${value.name}`} onClose={guardedClose}>
      <form
        onSubmit={(e) => {
          e.preventDefault()
          if (!discardPerimOk()) return
          startTransition(async () => {
            const r = await saveFamilyAction(v)
            if (r.ok) onSaved(v.name.trim(), value.id == null)
            else setErr(r)
          })
        }}
      >
        {err.error && <div className="alert error">{err.error}</div>}
        <div className="form-grid">
          <Field label="Nome *" error={err.fieldErrors?.name}>
            <input value={v.name} onChange={(e) => setV({ ...v, name: e.target.value })} autoFocus />
          </Field>
          <Field label="Código" error={err.fieldErrors?.code}>
            <input value={v.code} onChange={(e) => setV({ ...v, code: e.target.value })} placeholder="gerado a partir do nome" style={{ textTransform: 'uppercase' }} />
          </Field>
          <Field label="Tecnologia (PDFs comerciais)" error={err.fieldErrors?.tech} wide>
            <select value={v.tech} onChange={(e) => setV({ ...v, tech: e.target.value })}>
              {TECH_OPTIONS.map((o) => (
                <option key={o.value} value={o.value}>
                  {o.label}
                </option>
              ))}
            </select>
          </Field>
        </div>
        {tech && (
          <div className="row" style={{ gap: 10, marginTop: 8, alignItems: 'center' }}>
            {tech.display === 'SEAL' && (
              // eslint-disable-next-line @next/next/no-img-element -- selo estático pequeno, sem otimização
              <img src={TECHNOLOGIES[tech.key].seal} alt={TECHNOLOGIES[tech.key].label} width={44} height={44} style={{ objectFit: 'contain' }} />
            )}
            <small className="muted">
              {tech.display === 'SEAL'
                ? `Lista de preços: selo + "${TECHNOLOGIES[tech.key].title}" nos grupos desta família. Proforma: selo ao lado de cada item desta família.`
                : `Lista de preços: "${TECHNOLOGIES[tech.key].title}" (só texto) nos grupos desta família.`}
            </small>
          </div>
        )}
        <div className="row" style={{ marginTop: 14 }}>
          <span className="spacer" />
          <button type="button" onClick={guardedClose}>
            Cancelar
          </button>
          <button className="primary" disabled={pending}>
            {pending ? 'Salvando…' : family?.perimeters ? 'Salvar família' : 'Salvar'}
          </button>
        </div>
      </form>
      {/* Silo-bolsa: perímetro real por diâmetro — fora do formulário da família (estado e botão próprios) */}
      {family?.perimeters && <PerimeterEditor family={family} rows={rows} onDirtyChange={setPerimDirty} />}
    </Modal>
  )
}
