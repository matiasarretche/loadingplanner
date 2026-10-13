/**
 * Aplica as migrações do Drizzle (drizzle/*.sql) no NEON — e só no Neon.
 *
 *   npx tsx scripts/migrate-neon.ts
 *
 * Lê a URL do .env.neon (NEON_DATABASE_URL_UNPOOLED ou, como o Vercel mostra, DATABASE_URL_UNPOOLED; com ou sem
 * aspas) e RECUSA antes de migrar se ela faltar, não for do Neon (neon.tech), for a "pooled" (-pooler) ou for local.
 * A URL vai só para o ambiente do drizzle-kit (processo filho): nunca fica na sessão do terminal nem aparece na tela
 * (host e senha mascarados). Sem isso, um .env.neon mal escrito deixaria o drizzle-kit migrar o banco LOCAL do .env
 * e mostrar "sucesso".
 */
import { spawn } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { parse } from 'dotenv'
import { Client } from 'pg'

const ROOT = process.cwd()
const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '::1'])

const secrets: [string, string][] = []
const redact = (text: string) => secrets.reduce((t, [s, r]) => t.split(s).join(r), text)
function addSecret(value: string, replacement: string) {
  if (value && value !== replacement) secrets.push([value, replacement])
  secrets.sort((a, b) => b[0].length - a[0].length) // a URL inteira antes do host/senha que ela contém
}

function fail(msg: string): never {
  console.error(redact(`\nERRO: ${msg}`))
  process.exit(1)
}

/** mesmo leitor do migrate-to-neon.ts: tolera UTF-16 e BOM (arquivo salvo pelo Bloco de Notas/PowerShell) */
function readEnvFile(name: string): Record<string, string> | null {
  const file = path.join(ROOT, name)
  if (!fs.existsSync(file)) return null
  const buf = fs.readFileSync(file)
  const text = buf[0] === 0xff && buf[1] === 0xfe ? buf.toString('utf16le') : buf.toString('utf8')
  return parse(text.replace(/^﻿/, ''))
}

function maskHost(host: string) {
  const [first, ...rest] = host.split('.')
  return [`${first.slice(0, 3)}***`, ...rest].join('.')
}

/** roda o drizzle-kit com a URL só no ambiente dele, repassando a saída já mascarada */
function runDrizzleMigrate(url: string) {
  const bin = path.join(ROOT, 'node_modules', 'drizzle-kit', 'bin.cjs')
  if (!fs.existsSync(bin)) fail('drizzle-kit não encontrado em node_modules (rode npm install na raiz do projeto).')
  return new Promise<void>((resolve, reject) => {
    const p = spawn(process.execPath, [bin, 'migrate'], { cwd: ROOT, env: { ...process.env, DATABASE_URL: url }, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true })
    p.stdout.on('data', (d: Buffer) => process.stdout.write(redact(d.toString())))
    p.stderr.on('data', (d: Buffer) => process.stderr.write(redact(d.toString())))
    p.on('error', (e) => reject(new Error(`não foi possível executar o drizzle-kit: ${e.message}`)))
    p.on('close', (code) => (code === 0 ? resolve() : reject(new Error(`drizzle-kit terminou com código ${code}.`))))
  })
}

async function main() {
  const env = readEnvFile('.env.neon')
  if (!env) fail('.env.neon não encontrado na raiz do projeto. Crie-o com UMA linha:\n  NEON_DATABASE_URL_UNPOOLED=<URL "unpooled" do Neon>')
  const raw = (env.NEON_DATABASE_URL_UNPOOLED || env.DATABASE_URL_UNPOOLED || '').trim()
  if (!raw) fail('.env.neon sem NEON_DATABASE_URL_UNPOOLED (nem DATABASE_URL_UNPOOLED). Nada foi migrado.')
  let u: URL
  try {
    u = new URL(raw)
  } catch {
    fail('a URL do .env.neon não é válida (esperado postgresql://usuario:senha@host/banco?sslmode=require). Nada foi migrado.')
  }
  const host = decodeURIComponent(u.hostname).replace(/^\[(.*)\]$/, '$1').toLowerCase()
  const shown = `postgresql://***@${maskHost(host)}${u.pathname}`
  addSecret(raw, shown)
  addSecret(u.toString(), shown)
  addSecret(u.password, '***')
  addSecret(decodeURIComponent(u.password), '***')
  addSecret(host, maskHost(host))
  if (u.protocol !== 'postgres:' && u.protocol !== 'postgresql:') fail('a URL do .env.neon precisa começar com postgresql://. Nada foi migrado.')
  if (LOCAL_HOSTS.has(host)) fail('a URL do .env.neon aponta para um banco LOCAL, não para o Neon. Nada foi migrado.')
  if (!/\.neon\.tech$/.test(host)) fail(`o host ${maskHost(host)} não é do Neon (neon.tech). Nada foi migrado.`)
  if (/-pooler\./.test(host)) fail('a URL do .env.neon é a "pooled" (host com -pooler). Use a UNPOOLED (direta). Nada foi migrado.')
  // remoto sem sslmode: exige SSL (o Neon recusa conexão sem SSL)
  if (!u.searchParams.has('sslmode')) u.searchParams.set('sslmode', 'require')
  const url = u.toString()
  addSecret(url, shown)

  console.log(redact(`Destino: ${shown}`))
  console.log('Aplicando as migrações do Drizzle no Neon…\n')
  await runDrizzleMigrate(url)

  // confirmação: o destino tem todas as migrações do drizzle/meta/_journal.json
  const journal = JSON.parse(fs.readFileSync(path.join(ROOT, 'drizzle', 'meta', '_journal.json'), 'utf8')) as { entries: unknown[] }
  const check = new URL(url)
  if (['prefer', 'require', 'verify-ca'].includes(check.searchParams.get('sslmode') ?? '')) check.searchParams.set('sslmode', 'verify-full')
  const client = new Client({ connectionString: check.toString(), connectionTimeoutMillis: 30_000, enableChannelBinding: check.searchParams.get('channel_binding') === 'require' })
  client.on('error', (e) => console.error(redact(`AVISO: conexão caiu (${e.message})`)))
  await client.connect()
  try {
    const { rows } = await client.query<{ n: string }>('select count(*) as n from drizzle.__drizzle_migrations')
    const applied = Number(rows[0].n)
    if (applied < journal.entries.length) fail(`o Neon tem ${applied} migrações registradas e o projeto ${journal.entries.length}. Confira a saída acima.`)
    console.log(redact(`\nNeon (${maskHost(host)}): ${applied} migrações registradas; projeto: ${journal.entries.length}. Tudo aplicado.`))
  } finally {
    await client.end().catch(() => {})
  }
}

main().catch((e: unknown) => fail(e instanceof Error ? e.message : String(e)))
