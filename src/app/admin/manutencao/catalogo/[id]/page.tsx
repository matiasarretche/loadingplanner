import Link from 'next/link'
import { notFound } from 'next/navigation'
import { eq, sql } from 'drizzle-orm'
import { alias } from 'drizzle-orm/pg-core'
import { db, schema } from '@/db'
import { dt, nf0, nf2 } from '@/components/format'
import { requireUser } from '@/lib/auth'
import type { FamilyKey, ImportPlan, PlannedProduct } from '@/domain/catalogImport/types'
import { IMPORT_STATUS } from '../../labels'
import css from '../../manutencao.module.css'
import { ImportActions } from './ImportActions'

/** aplicar a importação (server action desta página) e a atualização das montagens depois dela */
export const maxDuration = 300

const PAGE = 200
const TABS = [
  { key: 'resumo', label: 'Resumo' },
  { key: 'produtos', label: 'Produtos' },
  { key: 'pendentes', label: 'Pendentes' },
  { key: 'repetidos', label: 'Repetidos descartados' },
  { key: 'saem', label: 'Saem do catálogo' },
  { key: 'caixas', label: 'Caixas da planilha' },
] as const
type Tab = (typeof TABS)[number]['key']

const n0 = (v: number | null | undefined) => (v == null ? '—' : nf0.format(v))
const n2 = (v: number | null | undefined) => (v == null ? '—' : nf2.format(v))
const one = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v) ?? ''
const norm = (x: string) => x.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase()

/** medidas do produto: "9 pés × 60 m · 210 µm", "8 × 50 m · 150 µm", "2 × 10 m · 600 µm" */
function measures(p: PlannedProduct): string {
  const len = p.lengthM != null ? `${n2(p.lengthM)} m` : p.lengthFt != null ? `${n0(p.lengthFt)} pés` : ''
  const size = p.diameterFt != null ? `${n2(p.diameterFt)} pés${len ? ` × ${len}` : ''}` : p.widthM != null ? `${n2(p.widthM)}${len ? ` × ${len}` : ' m'}` : len
  return [size, p.thicknessUm != null ? `${n0(p.thicknessUm)} µm` : ''].filter(Boolean).join(' · ') || '—'
}

function EanCell({ p }: { p: PlannedProduct }) {
  if (!p.ean) return <span className="muted">—</span>
  return (
    <span title={p.eanNote ?? undefined}>
      <span className={css.mono}>{p.ean}</span>
      {p.eanStatus === 'INVALID' && (
        <>
          {' '}
          <span className="badge CRITICAL">inválido</span>
        </>
      )}
      {p.eanStatus === 'GTIN14' && (
        <>
          {' '}
          <span className="badge INFO">GTIN-14 caixa</span>
        </>
      )}
    </span>
  )
}

/**
 * PRÉVIA DA IMPORTAÇÃO do catálogo oficial: tudo o que a aplicação vai fazer, para conferir antes.
 * Renderizada no servidor (o plano completo não vai para o navegador); abas e filtros pela URL.
 */
export default async function CatalogImportPage({ params, searchParams }: PageProps<'/admin/manutencao/catalogo/[id]'>) {
  await requireUser('manageUsers')
  const id = Number((await params).id)
  if (!Number.isInteger(id) || id <= 0) notFound()
  const sp = await searchParams
  const creator = alias(schema.users, 'creator')
  const applier = alias(schema.users, 'applier')
  const [row] = await db
    .select({
      imp: schema.catalogImports,
      createdByName: creator.name,
      appliedByName: applier.name,
      // atualização das montagens presa: SYNCING há mais de 6 min (a função dura no máx. 300 s)
      syncStale: sql<boolean>`(${schema.catalogImports.status} = 'SYNCING' AND (${schema.catalogImports.syncedAt} IS NULL OR ${schema.catalogImports.syncedAt} < now() - interval '6 minutes'))`,
    })
    .from(schema.catalogImports)
    .leftJoin(creator, eq(creator.id, schema.catalogImports.createdBy))
    .leftJoin(applier, eq(applier.id, schema.catalogImports.appliedBy))
    .where(eq(schema.catalogImports.id, id))
  if (!row) notFound()
  const imp = row.imp
  const plan = imp.plan as ImportPlan
  const sum = plan.summary
  const tab: Tab = (TABS.find((t) => t.key === one(sp.aba))?.key ?? 'resumo') as Tab
  const famName = new Map(plan.families.map((f) => [f.key, f.name]))
  const blockers = plan.warnings.filter((w) => w.level === 'BLOCKER')
  const status = IMPORT_STATUS[imp.status] ?? { label: imp.status, badge: 'INFO' }
  const href = (o: Record<string, string | number | undefined>) => {
    const q = new URLSearchParams()
    const merged: Record<string, string | number | undefined> = { aba: tab, familia: one(sp.familia) || undefined, q: one(sp.q) || undefined, ...o }
    for (const [k, v] of Object.entries(merged)) if (v !== undefined && v !== '') q.set(k, String(v))
    return `/admin/manutencao/catalogo/${id}?${q}`
  }

  return (
    <>
      <div className={css.head}>
        <h1>Prévia da importação #{id}</h1>
        <span className={`badge ${status.badge}`}>{status.label}</span>
        <Link href="/admin/manutencao" className="small">
          ← Manutenção
        </Link>
      </div>
      <div className={css.meta} style={{ marginBottom: 12 }}>
        <span>
          Gerada em {dt(imp.createdAt)} por {row.createdByName ?? '—'}
        </span>
        <span>
          Produtos: {imp.productsFile} <small title={imp.productsSha256}>({imp.productsSha256.slice(0, 8)})</small>
        </span>
        <span>
          Caixas: {imp.boxesFile} <small title={imp.boxesSha256}>({imp.boxesSha256.slice(0, 8)})</small>
        </span>
        <span>
          Motor {plan.engineVersion} · decisões {plan.decisionsId}
        </span>
      </div>

      <div className="kpis" style={{ marginBottom: 12 }}>
        <Kpi k="Produtos" v={n0(sum.planned)} s={`${n0(sum.toCreate)} novos · ${n0(sum.toUpdate)} atualizados`} />
        <Kpi k="Com caixa" v={n0(sum.withPackaging)} s={`${n0(sum.confidence.HIGH)} alta · ${n0(sum.confidence.MEDIUM)} média confiança`} />
        <Kpi k="Pendentes" v={n0(sum.pending)} s="importados sem caixa" warn={sum.pending > 0} />
        <Kpi k="Repetidos descartados" v={n0(sum.duplicatesDiscarded)} s={`${n0(sum.duplicateGroups)} grupos`} />
        <Kpi k="Saem do catálogo" v={n0(sum.deactivations)} s="desativados (não apagados)" />
        <Kpi k="Montagens a gerar" v={n0(sum.refPalletsEstimate)} s="paletes de referência" />
      </div>

      {plan.warnings.length > 0 && (
        <div className="panel" style={{ marginBottom: 12 }}>
          <ul className={css.warnings}>
            {plan.warnings.map((w, i) => (
              <li key={i} className={css[w.level]}>
                <strong>{w.level === 'BLOCKER' ? 'Bloqueio' : w.level === 'WARN' ? 'Atenção' : 'Info'}:</strong> {w.message}
                {w.codes && w.codes.length > 0 && (
                  <small>
                    Cód.: {w.codes.slice(0, 40).join(', ')}
                    {w.codes.length > 40 ? ` … (+${w.codes.length - 40})` : ''}
                  </small>
                )}
              </li>
            ))}
          </ul>
        </div>
      )}

      <ImportActions
        id={id}
        status={imp.status}
        blocked={blockers.length > 0}
        toCreate={sum.toCreate}
        toUpdate={sum.toUpdate}
        pending={sum.pending}
        deactivations={sum.deactivations}
        applied={imp.appliedAt ? { at: imp.appliedAt.toISOString(), by: row.appliedByName ?? '—' } : null}
        result={imp.result}
        syncReport={imp.syncReport}
        syncedAt={imp.syncedAt?.toISOString() ?? null}
        syncStale={row.syncStale}
        error={imp.error}
      />

      <nav className={css.tabs}>
        {TABS.map((t) => (
          <Link key={t.key} href={href({ aba: t.key, p: undefined })} className={t.key === tab ? css.on : undefined} scroll={false}>
            {t.label}
            {t.key === 'pendentes' ? ` (${plan.pending.length})` : t.key === 'repetidos' ? ` (${plan.discarded.length})` : t.key === 'saem' ? ` (${plan.deactivations.variants.length})` : t.key === 'produtos' ? ` (${plan.products.length})` : ''}
          </Link>
        ))}
      </nav>

      {tab === 'resumo' && <Resumo plan={plan} />}
      {tab === 'produtos' && <Produtos id={id} plan={plan} famName={famName} familia={one(sp.familia)} q={one(sp.q)} page={Math.max(1, Number(one(sp.p)) || 1)} href={href} />}
      {tab === 'pendentes' && <Pendentes plan={plan} famName={famName} id={id} />}
      {tab === 'repetidos' && <Repetidos plan={plan} />}
      {tab === 'saem' && <Saem plan={plan} />}
      {tab === 'caixas' && <Caixas plan={plan} />}
    </>
  )
}

function Kpi({ k, v, s, warn }: { k: string; v: string; s?: string; warn?: boolean }) {
  return (
    <div className={`kpi${warn ? ' WARNING' : ''}`}>
      <div className="k">{k}</div>
      <div className="v">{v}</div>
      {s && <div className="s">{s}</div>}
    </div>
  )
}

function Resumo({ plan }: { plan: ImportPlan }) {
  const sum = plan.summary
  return (
    <div className={css.twoCols}>
      <section>
        <h3>Por família</h3>
        <div className={css.tableWrap}>
          <table className="data compact">
            <thead>
              <tr>
                <th>Família</th>
                <th className="num">Produtos</th>
                <th className="num">Com caixa</th>
                <th className="num">Pendentes</th>
              </tr>
            </thead>
            <tbody>
              {sum.byFamily.map((f) => (
                <tr key={f.family}>
                  <td>
                    {f.name}
                    {plan.families.find((x) => x.key === f.family)?.action === 'CREATE' && (
                      <>
                        {' '}
                        <span className="badge INFO">nova</span>
                      </>
                    )}
                  </td>
                  <td className="num">{n0(f.total)}</td>
                  <td className="num">{n0(f.withPackaging)}</td>
                  <td className="num">{n0(f.pending)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <h3>Por linha</h3>
        <div className={css.tableWrap}>
          <table className="data compact">
            <thead>
              <tr>
                <th>Linha</th>
                <th className="num">Produtos</th>
              </tr>
            </thead>
            <tbody>
              {sum.byLine.map((l) => (
                <tr key={l.line}>
                  <td>
                    {l.line}
                    {sum.newLines.includes(l.line) && (
                      <>
                        {' '}
                        <span className="badge INFO">nova</span>
                      </>
                    )}
                  </td>
                  <td className="num">{n0(l.total)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>
      <section>
        <h3>Planilha</h3>
        <ul className={css.result}>
          <li>
            {n0(sum.sheetRows)} linha(s) na planilha · {n0(sum.parsedRows)} lidas · {n0(sum.skippedRows)} ignoradas
          </li>
          <li>
            {n0(sum.duplicateGroups)} grupos de repetidos → {n0(sum.duplicatesDiscarded)} códigos descartados
          </li>
          <li>{n0(sum.grossReplaced)} peso(s) bruto(s) recalculados (líquido + tara da caixa)</li>
          <li>
            EAN: {n0(sum.ean.EAN13)} EAN-13 válidos · {n0(sum.ean.GTIN14)} GTIN-14 (caixa) · {n0(sum.ean.INVALID)} inválidos · {n0(sum.ean.missing)} sem EAN
          </li>
          {sum.newFamilies.length > 0 && <li>Famílias novas: {sum.newFamilies.join(', ')}</li>}
          {sum.familiesWithoutActiveProducts.length > 0 && <li>Ficam sem produtos ativos: {sum.familiesWithoutActiveProducts.join(', ')}</li>}
          {plan.deactivations.keptActive.map((k) => (
            <li key={k.sku}>
              Mantido ativo: {k.sku} — {k.reason}
            </li>
          ))}
        </ul>
        <h3>Caixas usadas</h3>
        <div className={css.tableWrap}>
          <table className="data compact">
            <thead>
              <tr>
                <th>Caixa</th>
                <th>Medidas (mm)</th>
                <th className="num">Produtos</th>
              </tr>
            </thead>
            <tbody>
              {sum.boxesUsed.map((b) => (
                <tr key={`${b.boxCode}|${b.dims}`}>
                  <td className={css.mono}>{b.boxCode}</td>
                  <td className={css.mono}>{b.dims}</td>
                  <td className="num">{n0(b.products)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>
    </div>
  )
}

function Produtos({ id, plan, famName, familia, q, page, href }: { id: number; plan: ImportPlan; famName: Map<FamilyKey, string>; familia: string; q: string; page: number; href: (o: Record<string, string | number | undefined>) => string }) {
  const needle = norm(q.trim())
  const rows = plan.products.filter((p) => {
    if (familia && p.family !== familia) return false
    if (!needle) return true
    return norm([p.code, p.name, p.productLine, p.source.group, p.source.measure, p.source.thickness ?? '', p.ean ?? '', p.packaging?.boxCode ?? '', p.match?.sku ?? ''].join(' ')).includes(needle)
  })
  const pages = Math.max(1, Math.ceil(rows.length / PAGE))
  const cur = Math.min(page, pages)
  const shown = rows.slice((cur - 1) * PAGE, cur * PAGE)
  return (
    <>
      <form className={css.filters} action={`/admin/manutencao/catalogo/${id}`} method="get">
        <input type="hidden" name="aba" value="produtos" />
        <label className="field">
          Família
          <select name="familia" defaultValue={familia}>
            <option value="">Todas</option>
            {plan.families
              .filter((f) => plan.products.some((p) => p.family === f.key))
              .map((f) => (
                <option key={f.key} value={f.key}>
                  {f.name}
                </option>
              ))}
          </select>
        </label>
        <label className="field">
          Buscar
          <input type="search" name="q" defaultValue={q} placeholder="Cód., descrição, EAN, caixa…" />
        </label>
        <button>Filtrar</button>
        {(familia || q) && (
          <Link href={href({ familia: undefined, q: undefined, p: undefined })} className="btn">
            Limpar
          </Link>
        )}
        <span className={css.small}>
          {n0(rows.length)} produto(s){pages > 1 ? ` · página ${cur} de ${pages}` : ''}
        </span>
      </form>
      <div className={css.tableWrap}>
        <table className={`data compact ${css.wide}`}>
          <thead>
            <tr>
              <th>Cód.</th>
              <th>Família / linha</th>
              <th>Descrição</th>
              <th>Medidas</th>
              <th>EAN</th>
              <th className="num">Líq./bruto kg</th>
              <th>Caixa</th>
              <th>Medidas da caixa</th>
              <th>Palete × caixas</th>
              <th>Confiança</th>
              <th>Equivale a (atual)</th>
              <th>Observações</th>
            </tr>
          </thead>
          <tbody>
            {shown.map((p) => {
              const pk = p.packaging
              const obs = [pk?.reason, pk?.grossNote, pk?.palletNote, ...(pk?.notes ?? []), p.eanNote, ...p.dataIssues].filter(Boolean)
              return (
                <tr key={p.code}>
                  <td className={css.mono}>
                    {p.code}
                    {p.action === 'UPDATE' && (
                      <>
                        <br />
                        <span className="badge INFO">atualiza</span>
                      </>
                    )}
                  </td>
                  <td>
                    {famName.get(p.family) ?? p.family}
                    <br />
                    <small>{p.productLine}</small>
                  </td>
                  <td>
                    {p.name}
                    <br />
                    <small>
                      {p.source.group} · {p.source.measure}
                      {p.source.thickness ? ` · ${p.source.thickness}` : ''}
                    </small>
                  </td>
                  <td className={css.mono}>{measures(p)}</td>
                  <td>
                    <EanCell p={p} />
                  </td>
                  <td className="num">
                    {/* pendente: a importação não grava peso — o par fica o da planilha (como na planilha dos pendentes) */}
                    {n2(pk?.netKg ?? p.source.netKg)} / {n2(pk?.grossKg ?? p.source.grossKg)}
                    {pk?.netSource === 'REAL_PERIMETER' && (
                      <>
                        <br />
                        <span className="badge INFO" title={`Líquido pelo perímetro real × comprimento × espessura × 0,932 g/cm³ (planilha: ${n2(p.source.netKg)} kg)`}>
                          perímetro real
                        </span>
                      </>
                    )}
                    {!pk && p.calcNetKg != null && (
                      <>
                        <br />
                        <span className="badge INFO" title="Pendente: a importação não grava peso. Ao definir a caixa no Catálogo, grava este líquido pelo perímetro real × comprimento × espessura × 0,932 g/cm³ (bruto = líquido + tara).">
                          perímetro real: {n2(p.calcNetKg)}
                        </span>
                      </>
                    )}
                    {pk?.grossSource === 'NET_PLUS_BOX_TARE' && (
                      <>
                        <br />
                        <span className="badge WARNING" title={pk.grossNote ?? undefined}>
                          bruto recalculado
                        </span>
                      </>
                    )}
                  </td>
                  <td className={css.mono}>{pk ? (pk.boxCode ?? 'atual') : <span className="badge WARNING">pendente</span>}</td>
                  <td className={css.mono}>{pk ? `${pk.lengthMm} × ${pk.widthMm} × ${pk.heightMm}` : '—'}</td>
                  <td className={css.mono}>
                    {pk?.palletTypeCode ? `${pk.palletTypeCode} × ${pk.unitsPerPallet ?? '—'}` : '—'}
                    {pk && (
                      <>
                        <br />
                        <small>{pk.palletSource === 'CATALOG' ? 'do catálogo' : 'da planilha'}</small>
                      </>
                    )}
                  </td>
                  <td>{pk ? <span className={`badge ${pk.confidence === 'HIGH' ? 'ok' : 'WARNING'}`}>{pk.confidence === 'HIGH' ? 'alta' : 'média'}</span> : '—'}</td>
                  <td>
                    {p.match ? (
                      <span title={p.match.why}>
                        <span className={css.mono}>{p.match.sku}</span>
                        <br />
                        <small>
                          {p.match.lineRelation === 'SAME' ? 'mesma linha' : p.match.lineRelation === 'COMPATIBLE' ? 'linha compatível' : p.match.lineRelation === 'EXACT_CODE' ? 'mesmo código' : 'outra linha'} · {p.match.confidence === 'HIGH' ? 'alta' : p.match.confidence === 'MEDIUM' ? 'média' : 'baixa'}
                        </small>
                      </span>
                    ) : (
                      <span className="muted">—</span>
                    )}
                  </td>
                  <td className={css.cellNotes}>{obs.join(' · ') || '—'}</td>
                </tr>
              )
            })}
            {shown.length === 0 && (
              <tr>
                <td colSpan={12} className="muted">
                  Nenhum produto com esse filtro.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
      {pages > 1 && (
        <div className={css.pager}>
          {cur > 1 && (
            <Link href={href({ p: cur - 1 })} className="btn small">
              ← Anterior
            </Link>
          )}
          <span>
            Página {cur} de {pages}
          </span>
          {cur < pages && (
            <Link href={href({ p: cur + 1 })} className="btn small">
              Próxima →
            </Link>
          )}
        </div>
      )}
    </>
  )
}

function Pendentes({ plan, famName, id }: { plan: ImportPlan; famName: Map<FamilyKey, string>; id: number }) {
  return (
    <>
      <p className="muted" style={{ marginTop: 0 }}>
        Importados SEM caixa: não aparecem nos editores de carga até a caixa ser definida na tela Catálogo.{' '}
        <a href={`/admin/manutencao/catalogo/${id}/pendentes`}>Baixar pendentes (.xlsx)</a>
      </p>
      <div className={css.tableWrap}>
        <table className="data compact">
          <thead>
            <tr>
              <th>Cód.</th>
              <th>Descrição</th>
              <th>Motivo</th>
              <th>Caixa sugerida</th>
            </tr>
          </thead>
          <tbody>
            {plan.pending.map((x) => (
              <tr key={x.code}>
                <td className={css.mono}>{x.code}</td>
                <td>
                  {x.name}
                  <br />
                  <small>{famName.get(x.family) ?? x.family}</small>
                </td>
                <td>
                  {x.reason}
                  {x.unitsPerPackHint != null && (
                    <>
                      <br />
                      <small>pacote: {x.unitsPerPackHint} un. por caixa?</small>
                    </>
                  )}
                </td>
                <td className={css.mono}>{x.suggestion ? `${x.suggestion.boxCode} (${x.suggestion.dims})` : '—'}</td>
              </tr>
            ))}
            {plan.pending.length === 0 && (
              <tr>
                <td colSpan={4} className="muted">
                  Nenhum pendente.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </>
  )
}

function Repetidos({ plan }: { plan: ImportPlan }) {
  return (
    <>
      <p className="muted" style={{ marginTop: 0 }}>
        Mesma descrição (grupo, medida, espessura e marca) com vários códigos: fica só um — o mais recente (maior número) sem dados ruins. Os outros não são importados.
      </p>
      <div className={css.tableWrap}>
        <table className="data compact">
          <thead>
            <tr>
              <th>Cód.</th>
              <th>Mantido</th>
              <th>Descrição</th>
              <th>Motivo</th>
            </tr>
          </thead>
          <tbody>
            {plan.discarded.map((d) => (
              <tr key={d.code}>
                <td className={css.mono}>
                  {d.code}
                  <br />
                  <small>linha {d.row}</small>
                </td>
                <td className={css.mono}>{d.keptCode}</td>
                <td>{d.description}</td>
                <td className={css.cellNotes}>{d.reason}</td>
              </tr>
            ))}
            {plan.discarded.length === 0 && (
              <tr>
                <td colSpan={4} className="muted">
                  Nenhum repetido.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </>
  )
}

function Saem({ plan }: { plan: ImportPlan }) {
  return (
    <>
      <p className="muted" style={{ marginTop: 0 }}>
        Produtos atuais que não estão na planilha oficial: são DESATIVADOS (nunca apagados). As cargas salvas não mudam (guardam a cópia da época).
        {plan.deactivations.keptActive.length > 0 && ` Continuam ativos: ${plan.deactivations.keptActive.map((k) => `${k.sku} (${k.reason})`).join('; ')}.`}
      </p>
      <div className={css.tableWrap}>
        <table className="data compact">
          <thead>
            <tr>
              <th>Cód. atual</th>
              <th>Nome</th>
              <th>Família</th>
              <th>Substituído por</th>
            </tr>
          </thead>
          <tbody>
            {plan.deactivations.variants.map((d) => (
              <tr key={d.variantId}>
                <td className={css.mono}>{d.sku}</td>
                <td>{d.name}</td>
                <td>{d.family}</td>
                <td className={css.mono}>{d.replacedBy.length ? d.replacedBy.join(', ') : <span className="muted">—</span>}</td>
              </tr>
            ))}
            {plan.deactivations.variants.length === 0 && (
              <tr>
                <td colSpan={4} className="muted">
                  Nenhum produto sai do catálogo.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </>
  )
}

function Caixas({ plan }: { plan: ImportPlan }) {
  const used = new Map<string, number>()
  for (const p of plan.products) if (p.packaging?.boxSheetRow != null) used.set(String(p.packaging.boxSheetRow), (used.get(String(p.packaging.boxSheetRow)) ?? 0) + 1)
  return (
    <div className={css.tableWrap}>
      <table className={`data compact ${css.wide}`}>
        <thead>
          <tr>
            <th>Caixa</th>
            <th>Referência</th>
            <th>Medidas (mm)</th>
            <th className="num">Tara kg</th>
            <th>Palete</th>
            <th>Caixas/palete</th>
            <th>Reconhecida</th>
            <th className="num">Produtos</th>
          </tr>
        </thead>
        <tbody>
          {plan.boxes.map((b) => (
            <tr key={b.sheetRow} style={b.hidden ? { opacity: 0.6 } : undefined}>
              <td className={css.mono}>
                {b.code ?? '—'}
                <br />
                <small>linha {b.sheetRow}</small>
              </td>
              <td>
                {b.reference}
                {b.rangeText && (
                  <>
                    <br />
                    <small>{b.rangeText}</small>
                  </>
                )}
              </td>
              <td className={css.mono}>
                {b.lengthMm} × {b.widthMm} × {b.heightMm}
              </td>
              <td className="num" title={b.tareNote ?? undefined}>
                {n2(b.tareKg)}
                {b.tareNote && ' *'}
              </td>
              <td className={css.mono}>
                {b.palletTypeCode ?? '—'}
                {b.palletText && (
                  <>
                    <br />
                    <small>{b.palletText}</small>
                  </>
                )}
              </td>
              <td className={css.mono}>
                {b.boxesPerPallet ?? '—'}
                {b.boxesPerPalletText && String(b.boxesPerPalletText) !== String(b.boxesPerPallet) && (
                  <>
                    <br />
                    <small>“{b.boxesPerPalletText}”</small>
                  </>
                )}
              </td>
              <td>
                {b.recognized ? <span className="badge ok">sim</span> : <span className="badge WARNING">não</span>}
                {b.hidden && (
                  <>
                    {' '}
                    <span className="badge DRAFT">oculta</span>
                  </>
                )}
                {b.notes.length > 0 && (
                  <>
                    <br />
                    <small>{b.notes.join(' · ')}</small>
                  </>
                )}
              </td>
              <td className="num">{n0(used.get(String(b.sheetRow)) ?? 0)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}
