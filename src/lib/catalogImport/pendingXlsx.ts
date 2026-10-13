import ExcelJS from 'exceljs'
import type { ImportPlan } from '@/domain/catalogImport/types'

/**
 * Planilha dos PENDENTES de uma prévia (produtos importados sem caixa): para a equipe definir caixa e
 * unidades por caixa. Código e EAN como TEXTO (o Excel não pode transformar em número/notação científica).
 */
export async function pendingWorkbook(plan: ImportPlan, importId: number): Promise<Buffer> {
  const famName = new Map(plan.families.map((f) => [f.key, f.name]))
  const byCode = new Map(plan.products.map((p) => [p.code, p]))
  const wb = new ExcelJS.Workbook()
  wb.creator = 'Pacifil Load Planner'
  wb.created = new Date(plan.generatedAt)
  const ws = wb.addWorksheet('Pendentes', { views: [{ state: 'frozen', ySplit: 1 }] })
  ws.columns = [
    { header: 'Cód.', key: 'code', width: 10, style: { numFmt: '@' } },
    { header: 'Família', key: 'family', width: 18 },
    { header: 'Descrição', key: 'name', width: 52 },
    { header: 'Medida (planilha)', key: 'measure', width: 24 },
    { header: 'Espessura', key: 'thickness', width: 20 },
    { header: 'Marca', key: 'brand', width: 12 },
    { header: 'Peso líquido', key: 'net', width: 13, style: { numFmt: '#,##0.000' } },
    { header: 'Peso bruto', key: 'gross', width: 13, style: { numFmt: '#,##0.000' } },
    { header: 'EAN', key: 'ean', width: 17, style: { numFmt: '@' } },
    { header: 'Motivo', key: 'reason', width: 60 },
    { header: 'Caixa sugerida', key: 'box', width: 14, style: { numFmt: '@' } },
    { header: 'Medidas da caixa sugerida', key: 'dims', width: 24 },
    { header: 'Unid./caixa (pacotes)', key: 'units', width: 12 },
  ]
  ws.getRow(1).font = { bold: true }
  for (const x of plan.pending) {
    const p = byCode.get(x.code)
    ws.addRow({
      code: x.code,
      family: famName.get(x.family) ?? x.family,
      name: x.name,
      measure: p?.source.measure ?? '',
      thickness: p?.source.thickness ?? '',
      brand: p?.brand ?? p?.source.brand ?? '',
      net: p?.source.netKg ?? null,
      gross: p?.source.grossKg ?? null,
      ean: p?.ean ?? '',
      reason: x.reason,
      box: x.suggestion?.boxCode ?? '',
      dims: x.suggestion?.dims ?? '',
      units: x.unitsPerPackHint ?? null,
    })
  }
  ws.autoFilter = { from: 'A1', to: 'M1' }
  const info = wb.addWorksheet('Sobre')
  info.addRows([
    ['Prévia da importação', `#${importId}`],
    ['Gerada em', plan.generatedAt],
    ['Planilha de produtos', `${plan.files.products.name} (sha256 ${plan.files.products.sha256.slice(0, 12)})`],
    ['Tabela de caixas', `${plan.files.boxes.name} (sha256 ${plan.files.boxes.sha256.slice(0, 12)})`],
    ['Pendentes', plan.pending.length],
    [],
    ['Os produtos pendentes são importados SEM embalagem: não aparecem nos editores de carga até a caixa ser definida na tela Catálogo.'],
  ])
  info.getColumn(1).width = 24
  info.getColumn(2).width = 60
  return Buffer.from(await wb.xlsx.writeBuffer())
}
