'use client'

/**
 * PERÍMETRO REAL POR DIÂMETRO da família Silo-bolsa ("Editar família"; decidido com o Matías em 14/10/2026).
 * O silo-bolsa é fabricado com perímetro maior que π × diâmetro; com o perímetro real definido, o peso líquido de
 * TODOS os silo-bolsas do diâmetro (todas as marcas) = perímetro × comprimento × espessura × 0,932 g/cm³.
 * Diâmetro sem perímetro → vale o peso da planilha. Salvar grava a tabela inteira e recalcula os pesos
 * (nova versão de embalagem, mantendo a tara da caixa); cargas salvas guardam o snapshot e não mudam.
 */
import { useRouter } from 'next/navigation'
import { useEffect, useMemo, useState, useTransition } from 'react'
import { nf2, nf3 } from '@/components/format'
import { decideRecalc, diameterKey, perimeterRowError, roundPerimeterM, theoreticalPerimeterM } from '@/domain/siloPerimeter'
import type { PerimeterRecalcResult } from '@/lib/siloPerimeters'
import { saveSiloPerimetersAction } from './actions'
import type { CatalogFamily, CatalogRow } from './CatalogClient'

/** perímetro no campo: 2 a 3 casas com vírgula (8,70 · 9,655) */
const perimText = (v: number) => v.toLocaleString('pt-BR', { minimumFractionDigits: 2, maximumFractionDigits: 3, useGrouping: false })
/** valor digitado (vírgula ou ponto): '' → null (não definido); inválido → NaN */
function parsePerim(s: string): number | null {
  const t = s.trim()
  if (!t) return null
  return /^\d+([.,]\d+)?$/.test(t) ? Number(t.replace(',', '.')) : NaN
}
const sameDiameter = (a: number, b: number) => Math.abs(a - b) < 0.01
const MAX_TITLE_LINES = 20
const pctF = new Intl.NumberFormat('pt-BR', { maximumFractionDigits: 1, signDisplay: 'always' })

/** motivos de "sem cálculo" agrupados: "motivo (SKU1, SKU2 e mais N)" — os textos de decideRecalc (servidor e prévia) */
function skipLines(skipped: readonly { sku: string; reason: string }[]): string[] {
  const byReason = new Map<string, string[]>()
  for (const s of skipped) byReason.set(s.reason, [...(byReason.get(s.reason) ?? []), s.sku])
  return [...byReason].map(([reason, skus]) => `${reason.replace(/\.$/, '')} (${skus.slice(0, 4).join(', ')}${skus.length > 4 ? ` e mais ${skus.length - 4}` : ''})`)
}

/** "Perímetros salvos: X produto(s) recalculado(s); Y sem cálculo: motivo (SKUs); …" */
function resultText(r: PerimeterRecalcResult): string {
  let t = `Perímetros salvos: ${r.changed.length} produto(s) recalculado(s)`
  if (r.skipped.length) t += `; ${r.skipped.length} sem cálculo: ${skipLines(r.skipped).join('; ')}`
  return `${t}.`
}

export function PerimeterEditor({
  family,
  rows,
  onDirtyChange,
}: {
  family: CatalogFamily
  rows: CatalogRow[]
  /** avisa o diálogo da família quando há perímetros digitados e ainda não salvos (fechar/salvar a família os perderia) */
  onDirtyChange?: (dirty: boolean) => void
}) {
  const router = useRouter()
  const [last, setLast] = useState<PerimeterRecalcResult | null>(null)
  // tabela gravada: a do último salvamento já vale antes do router.refresh() trazer a família atualizada
  const saved = useMemo(() => (last && !last.dryRun ? last.perimeters : (family.perimeters ?? [])), [last, family.perimeters])
  const famRows = useMemo(() => rows.filter((r) => r.familyId === family.id), [rows, family.id])
  const [input, setInput] = useState<Record<string, string>>(() => Object.fromEntries(saved.map((p) => [diameterKey(p.diameterFt), perimText(p.perimeterM)])))
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({})
  const [msg, setMsg] = useState<{ type: 'ok' | 'error'; text: string } | null>(null)
  const [pending, startTransition] = useTransition()

  // linhas: diâmetros dos produtos ∪ perímetros cadastrados, em ordem numérica
  const diameters = useMemo(() => {
    const out: number[] = []
    for (const d of [...famRows.map((r) => r.diameterFt), ...saved.map((p) => p.diameterFt)]) if (d != null && !out.some((x) => sameDiameter(x, d))) out.push(d)
    return out.sort((a, b) => a - b)
  }, [famRows, saved])
  const noDiameter = famRows.filter((r) => r.diameterFt == null).length

  // prévia no navegador: quais produtos mudam de peso líquido com o perímetro digitado
  const table = diameters.map((d) => {
    const key = diameterKey(d)
    const raw = input[key] ?? ''
    // o valor que o servidor grava e usa no cálculo (3 casas): prévia, validação e "alterado" usam o mesmo
    const parsed = parsePerim(raw)
    const perim = parsed != null && Number.isFinite(parsed) ? roundPerimeterM(parsed) : parsed
    // a MESMA validação do servidor (saveSiloPerimetersAction, com o diâmetro como é enviado): 87 em vez de 8,70
    // já fica destacado aqui e bloqueia o botão
    const rowError = perim == null ? null : Number.isNaN(perim) ? 'Número em metros (ex.: 8,70)' : perimeterRowError(Number(key), perim)
    const invalid = rowError != null
    const before = saved.find((p) => sameDiameter(p.diameterFt, d))?.perimeterM ?? null
    const products = famRows.filter((r) => r.diameterFt != null && sameDiameter(r.diameterFt, d))
    const changes: { r: CatalogRow; from: number; to: number }[] = []
    const skips: { sku: string; reason: string }[] = []
    if (perim != null && !invalid)
      for (const r of products) {
        // a MESMA regra do servidor (decideRecalc): o número de "mudam" é o que o botão grava
        const dec = decideRecalc([{ diameterFt: d, perimeterM: perim }], r, r.pack ? { version: r.pack.version, netKg: r.pack.netKg, grossKg: r.pack.grossKg, unitsPerPackage: r.pack.unitsPerPackage } : null)
        if (dec.kind === 'skip') skips.push({ sku: r.sku, reason: dec.reason })
        else if (dec.kind === 'change') changes.push({ r, from: r.pack!.netKg, to: dec.netKg })
      }
    const dirty = invalid || (perim == null ? before != null : before == null || Math.abs(perim - before) > 0.0005)
    // erro do servidor: chave "perimeter:<diâmetro>" (aceita 9.00, 9 ou 9,5)
    const errorKeys = [`perimeter:${key}`, `perimeter:${d}`, `perimeter:${String(d).replace('.', ',')}`]
    const error = errorKeys.map((k) => fieldErrors[k]).find(Boolean)
    return { d, key, raw, perim, rowError, invalid, before, products, changes, skips, dirty, errorKeys, error }
  })
  const nChanges = table.reduce((n, t) => n + t.changes.length, 0)
  const dirty = table.some((t) => t.dirty)
  const invalid = table.some((t) => t.invalid)

  // perímetros digitados e não salvos: o diálogo da família pergunta antes de fechar ou salvar a família
  useEffect(() => {
    onDirtyChange?.(dirty)
  }, [dirty, onDirtyChange])

  function save() {
    if (nChanges > 0 && !window.confirm(`Recalcular o peso líquido de ${nChanges} produto(s) (todas as marcas)? Será criada uma nova versão de embalagem; cargas salvas não mudam.`)) return
    setMsg(null)
    startTransition(async () => {
      // a tabela inteira: diâmetro ausente ou perímetro vazio = removido
      const res = await saveSiloPerimetersAction(
        family.id,
        table.map((t) => ({ diameterFt: t.key, perimeterM: t.raw.trim() })),
      ).catch(() => ({ ok: false, error: 'Falha de comunicação com o servidor. Recarregue a página para ver se os perímetros foram salvos.' }) as Awaited<ReturnType<typeof saveSiloPerimetersAction>>)
      setFieldErrors(res.fieldErrors ?? {})
      if (!res.ok) {
        setMsg({ type: 'error', text: res.error ?? 'Erro ao salvar os perímetros.' })
        return
      }
      if (res.result) {
        setInput(Object.fromEntries(res.result.perimeters.map((p) => [diameterKey(p.diameterFt), perimText(p.perimeterM)])))
        setLast(res.result)
      }
      setMsg({ type: 'ok', text: res.result ? resultText(res.result) : 'Perímetros salvos.' })
      router.refresh()
    })
  }

  return (
    <fieldset style={{ marginTop: 18 }}>
      <legend>Perímetro real por diâmetro</legend>
      <p className="muted" style={{ margin: '0 0 10px', fontSize: 12 }}>
        O silo-bolsa é fabricado com perímetro maior que π × diâmetro. Com o perímetro real definido, o peso líquido de todos os silo-bolsas do diâmetro (todas as
        marcas) = perímetro × comprimento × espessura × 0,932 g/cm³; o peso c/ embalagem mantém a tara da caixa. Sem perímetro, vale o peso da planilha.
      </p>
      {msg && (
        <div className={`alert ${msg.type}`} onClick={() => setMsg(null)}>
          {msg.text}
        </div>
      )}
      {diameters.length === 0 ? (
        <p className="muted" style={{ margin: 0 }}>
          Nenhum produto desta família tem diâmetro cadastrado.
        </p>
      ) : (
        <table className="data">
          <thead>
            <tr>
              <th className="num">Diâmetro (pés)</th>
              <th className="num">Teórico π × D (m)</th>
              <th className="num">Perímetro real (m)</th>
              <th className="num">Produtos</th>
              <th>Peso líquido (prévia)</th>
            </tr>
          </thead>
          <tbody>
            {table.map((t) => {
              const brands = new Map<string, number>()
              for (const r of t.products) brands.set(r.brand, (brands.get(r.brand) ?? 0) + 1)
              const changeList = t.changes.map((c) => `${c.r.sku} (${c.r.brand}): ${nf2.format(c.from)} → ${nf2.format(c.to)} kg`)
              const changeTitle = changeList.length > MAX_TITLE_LINES ? [...changeList.slice(0, MAX_TITLE_LINES), `… e mais ${changeList.length - MAX_TITLE_LINES}`] : changeList
              const bad = t.invalid || Boolean(t.error)
              return (
                <tr key={t.key}>
                  <td className="num">
                    <strong>{nf2.format(t.d)}</strong>
                  </td>
                  <td className="num muted">{nf3.format(theoreticalPerimeterM(t.d))}</td>
                  <td className="num">
                    <input
                      value={t.raw}
                      onChange={(e) => {
                        const v = e.target.value
                        setInput((o) => ({ ...o, [t.key]: v }))
                        // o erro do servidor era do valor anterior: some ao editar (a validação da tela continua)
                        if (t.error)
                          setFieldErrors((fe) => {
                            const n = { ...fe }
                            for (const k of t.errorKeys) delete n[k]
                            return n
                          })
                      }}
                      inputMode="decimal"
                      placeholder="não definido"
                      aria-label={`Perímetro real de ${nf2.format(t.d)} pés (m)`}
                      aria-invalid={bad}
                      disabled={pending}
                      style={{ width: 110, textAlign: 'right', ...(bad ? { borderColor: 'var(--crit)', background: 'var(--crit-bg)' } : {}) }}
                    />
                    {bad ? (
                      <div className="field-error">{t.error ?? t.rowError}</div>
                    ) : (
                      t.perim != null && (
                        // quanto o real passa do π × D (ajuda a ver erro de digitação: 87 em vez de 8,70)
                        <div className="muted" style={{ fontSize: 11 }}>
                          {pctF.format((t.perim / theoreticalPerimeterM(t.d) - 1) * 100)}% sobre π × D
                        </div>
                      )
                    )}
                  </td>
                  <td className="num" title={[...brands].map(([b, n]) => `${b}: ${n}`).join('\n') || undefined}>
                    {t.products.length || <span className="muted">0</span>}
                  </td>
                  <td>
                    {t.invalid ? (
                      <span className="muted">—</span>
                    ) : t.products.length === 0 ? (
                      <span className="muted">sem produtos ativos</span>
                    ) : t.perim == null ? (
                      <span className="muted">{t.before != null ? 'removido: os pesos atuais ficam' : 'não definido: vale o peso da planilha'}</span>
                    ) : t.changes.length ? (
                      <span className="badge WARNING" title={changeTitle.join('\n')}>
                        {t.changes.length === 1 ? '1 muda' : `${t.changes.length} mudam`}
                      </span>
                    ) : t.products.length > t.skips.length ? (
                      <span className="badge ok">nenhum muda</span>
                    ) : (
                      <span className="muted">nenhum produto calculável</span>
                    )}
                    {!t.invalid && t.perim != null && t.skips.length > 0 && (
                      // os mesmos motivos que o servidor devolve ao salvar (decideRecalc)
                      <small className="muted" title={['Sem cálculo (o peso atual fica):', ...skipLines(t.skips)].join('\n')}>
                        {' '}
                        · {t.skips.length} sem cálculo
                      </small>
                    )}
                  </td>
                </tr>
              )
            })}
          </tbody>
        </table>
      )}
      {noDiameter > 0 && (
        <small className="muted" style={{ display: 'block', marginTop: 6 }}>
          {noDiameter} produto(s) sem diâmetro cadastrado: não entram no cálculo.
        </small>
      )}
      {last && last.changed.length > 0 && (
        <details style={{ marginTop: 8, fontSize: 12 }}>
          <summary>Ver os {last.changed.length} produto(s) recalculado(s)</summary>
          <table className="data" style={{ marginTop: 6 }}>
            <thead>
              <tr>
                <th>Cód.</th>
                <th>Marca</th>
                <th className="num">Diâmetro</th>
                <th className="num">Peso líquido (kg)</th>
                <th className="num">Peso c/ embalagem (kg)</th>
                <th className="num">Versão</th>
              </tr>
            </thead>
            <tbody>
              {last.changed.map((c) => (
                <tr key={c.sku}>
                  <td>
                    <strong>{c.sku}</strong>
                    <br />
                    <small className="muted">{c.name}</small>
                  </td>
                  <td>{c.brand}</td>
                  <td className="num">{nf2.format(c.diameterFt)}</td>
                  <td className="num" style={{ whiteSpace: 'nowrap' }}>
                    {nf2.format(c.fromNetKg)} → {nf2.format(c.toNetKg)}
                  </td>
                  <td className="num" style={{ whiteSpace: 'nowrap' }}>
                    {nf2.format(c.fromGrossKg)} → {nf2.format(c.toGrossKg)}
                  </td>
                  <td className="num">v{c.newVersion}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </details>
      )}
      <div className="row" style={{ marginTop: 12 }}>
        <small className="muted">
          {invalid
            ? 'Corrija os perímetros destacados.'
            : nChanges
              ? `${nChanges} produto(s) mudam de peso líquido ao salvar.`
              : dirty
                ? 'Nenhum peso muda: só a tabela de perímetros é salva.'
                : 'Sem alterações.'}
        </small>
        <span className="spacer" />
        <button type="button" onClick={save} disabled={pending || invalid || (!dirty && nChanges === 0)}>
          {pending ? 'Salvando…' : 'Salvar perímetros e recalcular pesos'}
        </button>
      </div>
    </fieldset>
  )
}
