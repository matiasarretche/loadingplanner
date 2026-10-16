/**
 * RESPALDO COMPLETO DO NEON (produção) para um arquivo local — SÓ LEITURA.
 *
 *   npx tsx scripts/backup-neon.ts
 *
 * O Neon roda PostgreSQL 18 e o pg_dump instalado nesta máquina é o 17 (não lê servidor mais novo), por isso o
 * respaldo é lógico: TODAS as tabelas dos esquemas public e drizzle (inclusive o registro das migrações), linha por
 * linha, numa transação REPEATABLE READ READ ONLY (uma foto consistente do banco), gravadas em
 * backups/neon-completo-AAAA-MM-DDTHH-MM.json.gz. bytea vai em base64; numeric e datas como texto (sem perder
 * precisão). No fim relê o arquivo e confere as contagens de cada tabela com o banco.
 *
 * Lê a URL do .env.neon (NEON_DATABASE_URL_UNPOOLED ou DATABASE_URL_UNPOOLED) e RECUSA se ela faltar, não for do Neon
 * ou for a "pooled". A URL nunca aparece na tela.
 */
import fs from 'node:fs'
import path from 'node:path'
import { gunzipSync, gzipSync } from 'node:zlib'
import { parse } from 'dotenv'
import { Client, types } from 'pg'

const ROOT = process.cwd()

function fail(msg: string): never {
  console.error(`\nERRO: ${msg}`)
  process.exit(1)
}

/** mesmo leitor do migrate-neon.ts: tolera UTF-16 e BOM (arquivo salvo pelo Bloco de Notas/PowerShell) */
function readEnvNeon(): Record<string, string> {
  const file = path.join(ROOT, '.env.neon')
  if (!fs.existsSync(file)) fail('.env.neon não encontrado na raiz do projeto.')
  const buf = fs.readFileSync(file)
  const text = buf[0] === 0xff && buf[1] === 0xfe ? buf.toString('utf16le') : buf.toString('utf8')
  return parse(text.replace(/^﻿/, ''))
}

function neonUrl(): string {
  const env = readEnvNeon()
  const raw = (env.NEON_DATABASE_URL_UNPOOLED || env.DATABASE_URL_UNPOOLED || '').trim().replace(/^["']|["']$/g, '')
  if (!raw) fail('.env.neon sem NEON_DATABASE_URL_UNPOOLED (nem DATABASE_URL_UNPOOLED).')
  let host = ''
  try {
    host = new URL(raw).hostname
  } catch {
    fail('a URL do .env.neon não é válida (não exibida).')
  }
  if (!/\.neon\.tech$/.test(host)) fail('a URL do .env.neon não é do Neon (neon.tech).')
  if (/-pooler\./.test(host)) fail('a URL do .env.neon é a "pooled" (-pooler). Use a UNPOOLED.')
  return raw
}

// numeric, int8, datas e horários chegam como TEXTO: o respaldo guarda exatamente o que está no banco
for (const oid of [20, 1700, 1082, 1114, 1184, 1083, 1266]) types.setTypeParser(oid, (v: string) => v)

const stamp = () => {
  const p = new Intl.DateTimeFormat('sv-SE', { timeZone: 'America/Sao_Paulo', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false }).format(new Date())
  return p.replace(' ', 'T').replace(':', '-')
}

const plain = (v: unknown): unknown => (Buffer.isBuffer(v) ? { $bytea: v.toString('base64') } : v)

async function main() {
  const c = new Client({ connectionString: neonUrl() })
  await c.connect()
  const tables: Record<string, { columns: string[]; rows: unknown[][] }> = {}
  const counts: Record<string, number> = {}
  let serverVersion = ''
  try {
    await c.query('BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY')
    serverVersion = (await c.query(`SELECT current_setting('server_version') AS v`)).rows[0].v
    const list = await c.query(`SELECT schemaname, tablename FROM pg_tables WHERE schemaname IN ('public', 'drizzle') ORDER BY schemaname, tablename`)
    for (const { schemaname, tablename } of list.rows as { schemaname: string; tablename: string }[]) {
      const name = `${schemaname}.${tablename}`
      const r = await c.query({ text: `SELECT * FROM "${schemaname}"."${tablename}"`, rowMode: 'array' })
      tables[name] = { columns: r.fields.map((f) => f.name), rows: r.rows.map((row: unknown[]) => row.map(plain)) }
      counts[name] = r.rows.length
      process.stdout.write(`  ${name}: ${r.rows.length}\n`)
    }
    await c.query('ROLLBACK')
  } finally {
    await c.end()
  }

  const doc = { kind: 'pacifil-backup-neon-completo', version: 1, createdAt: new Date().toISOString(), serverVersion, counts, tables }
  const gz = gzipSync(Buffer.from(JSON.stringify(doc)), { level: 9 })
  const dir = path.join(ROOT, 'backups')
  fs.mkdirSync(dir, { recursive: true })
  const file = path.join(dir, `neon-completo-${stamp()}.json.gz`)
  fs.writeFileSync(file, gz)

  // conferência: relê o arquivo e compara as contagens
  const back = JSON.parse(gunzipSync(fs.readFileSync(file)).toString('utf8')) as typeof doc
  const bad = Object.entries(counts).filter(([t, n]) => back.tables[t]?.rows.length !== n)
  if (bad.length) fail(`o arquivo relido não confere: ${bad.map(([t]) => t).join(', ')}`)
  const total = Object.values(counts).reduce((s, n) => s + n, 0)
  console.log(`\nRespaldo OK: ${Object.keys(counts).length} tabelas, ${total} linhas, PostgreSQL ${serverVersion}`)
  console.log(`Arquivo: ${path.relative(ROOT, file)} (${(gz.length / 1024 / 1024).toFixed(2)} MB)`)
}

main().catch((e) => fail(String((e as Error)?.message ?? e).replace(/postgres(ql)?:\/\/\S+/g, '<url>')))
