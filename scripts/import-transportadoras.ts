/**
 * Importa TRANSPORTADORAS de uma planilha (.xlsx) ou CSV. Colunas reconhecidas (pt/es/en, sem
 * diferenciar maiúsculas/acentos): Código/Codigo/Code · Empresa/Nome/Nombre/Razão social/Name ·
 * Contato/Contacto/Contact · Telefone/Teléfono/Phone/Celular/WhatsApp · E-mail/Email/Correo ·
 * Observações/Observaciones/Notas/Notes.
 *  - Código é a chave (único, sem diferenciar maiúsculas). Existente → atualiza o que mudou; novo → cria.
 *  - Transportadoras do banco que não estão no arquivo NÃO são alteradas (só listadas).
 * Uso: npx tsx --env-file=.env scripts/import-transportadoras.ts arquivo.xlsx|csv [--dry]
 */
import fs from 'node:fs'
import ExcelJS from 'exceljs'
import { eq } from 'drizzle-orm'
import { db, schema as s } from '../src/db'

type Field = 'code' | 'name' | 'contact' | 'phone' | 'email' | 'notes'
const norm = (x: string) => x.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^a-z0-9]/g, '')
const ALIASES: Record<Field, string[]> = {
  code: ['codigo', 'code', 'cod', 'id', 'sigla'],
  name: ['empresa', 'nome', 'nombre', 'razaosocial', 'razonsocial', 'name', 'transportadora', 'transportista', 'company'],
  contact: ['contato', 'contacto', 'contact', 'responsavel', 'responsable'],
  phone: ['telefone', 'telefono', 'phone', 'celular', 'whatsapp', 'fone', 'tel'],
  email: ['email', 'mail', 'correo', 'correoelectronico'],
  notes: ['observacoes', 'observaciones', 'obs', 'notas', 'notes', 'comentarios'],
}
const fieldOf = (h: string): Field | null => (Object.keys(ALIASES) as Field[]).find((f) => ALIASES[f].includes(norm(h))) ?? null
const str = (v: unknown) => {
  if (v == null) return ''
  if (typeof v === 'object' && v && 'text' in v) return String((v as { text: string }).text).trim()
  if (typeof v === 'object' && v && 'result' in v) return String((v as { result: unknown }).result ?? '').trim()
  return String(v).trim()
}

async function readRows(file: string): Promise<Record<Field, string>[]> {
  let table: string[][] = []
  if (/\.csv$/i.test(file)) {
    const text = fs.readFileSync(file, 'utf8').replace(/^﻿/, '')
    const sep = (text.split('\n')[0].match(/;/g)?.length ?? 0) > (text.split('\n')[0].match(/,/g)?.length ?? 0) ? ';' : ','
    table = text.split(/\r?\n/).filter((l) => l.trim()).map((l) => l.split(sep).map((c) => c.replace(/^"|"$/g, '').trim()))
  } else {
    const wb = new ExcelJS.Workbook()
    await wb.xlsx.readFile(file)
    const ws = wb.worksheets[0]
    ws.eachRow((r) => table.push((r.values as unknown[]).slice(1).map(str)))
  }
  // linha de cabeçalho = a primeira com colunas de código e nome reconhecidas
  const hi = table.findIndex((r) => r.some((c) => fieldOf(c) === 'code') && r.some((c) => fieldOf(c) === 'name'))
  if (hi < 0) throw new Error('Cabeçalho não encontrado: preciso de uma coluna de Código e uma de Empresa/Nome.')
  const map = table[hi].map(fieldOf)
  return table.slice(hi + 1).map((r) => {
    const o = { code: '', name: '', contact: '', phone: '', email: '', notes: '' } as Record<Field, string>
    map.forEach((f, i) => {
      if (f && r[i]) o[f] = o[f] ? `${o[f]} / ${r[i]}` : r[i]
    })
    return o
  }).filter((o) => o.code || o.name)
}

async function main() {
  const file = process.argv[2]
  const dry = process.argv.includes('--dry')
  if (!file) throw new Error('Uso: import-transportadoras.ts arquivo.xlsx|csv [--dry]')
  const rows = await readRows(file)
  const existing = await db.select().from(s.transportCompanies)
  const byCode = new Map(existing.map((c) => [c.code.toLowerCase(), c]))
  const seen = new Set<string>()
  const rep = { created: [] as string[], updated: [] as string[], unchanged: 0, errors: [] as string[] }
  for (const [i, r] of rows.entries()) {
    const code = r.code.trim().toUpperCase()
    if (!code) rep.errors.push(`linha ${i + 1}: sem código (${r.name})`)
    if (!r.name.trim()) rep.errors.push(`linha ${i + 1}: sem nome (${code})`)
    if (!code || !r.name.trim()) continue
    if (seen.has(code.toLowerCase())) {
      rep.errors.push(`código repetido no arquivo: ${code}`)
      continue
    }
    seen.add(code.toLowerCase())
    const data = { name: r.name.trim(), contact: r.contact || null, phone: r.phone || null, email: r.email || null, notes: r.notes || null }
    const cur = byCode.get(code.toLowerCase())
    if (!cur) {
      if (!dry) await db.insert(s.transportCompanies).values({ code, ...data, active: true })
      rep.created.push(`${code} — ${data.name}`)
      continue
    }
    const diff = (Object.keys(data) as (keyof typeof data)[]).filter((k) => (cur[k] ?? null) !== data[k])
    if (!diff.length) {
      rep.unchanged++
      continue
    }
    if (!dry) await db.update(s.transportCompanies).set({ ...data, updatedAt: new Date() }).where(eq(s.transportCompanies.id, cur.id))
    rep.updated.push(`${cur.code}: ${diff.join(', ')}`)
  }
  if (!dry) await db.insert(s.auditLog).values({ entity: 'transport_company', entityId: null, action: 'import', diff: { file: file.split(/[\\/]/).pop(), created: rep.created.length, updated: rep.updated.length } })
  const missing = existing.filter((c) => !seen.has(c.code.toLowerCase())).map((c) => c.code)
  console.log(`${dry ? '[SIMULAÇÃO] ' : ''}Linhas: ${rows.length}`)
  console.log(`\nNOVAS (${rep.created.length}):\n  ${rep.created.join('\n  ')}`)
  console.log(`\nALTERADAS (${rep.updated.length}):\n  ${rep.updated.join('\n  ')}`)
  console.log(`\nSem alteração: ${rep.unchanged}`)
  console.log(`No banco e não no arquivo (não alteradas): ${missing.join(', ') || '—'}`)
  if (rep.errors.length) console.log(`\nProblemas:\n  ${rep.errors.join('\n  ')}`)
  process.exit(0)
}
main().catch((e) => {
  console.error(e instanceof Error ? e.message : e)
  process.exit(1)
})
