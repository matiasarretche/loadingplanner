/**
 * Copia o banco LOCAL inteiro (todas as tabelas e schemas, inclusive drizzle.__drizzle_migrations) para o Neon.
 *
 *   npx tsx scripts/migrate-to-neon.ts           → copia (recusa se o destino já tiver tabelas)
 *   npx tsx scripts/migrate-to-neon.ts --check   → só confere conexões, versões e contagens; não copia nada
 *   npx tsx scripts/migrate-to-neon.ts --force   → sobrescreve as tabelas que já existem no destino
 *
 * Origem: DATABASE_URL do .env (lido do arquivo, nunca da variável do shell).
 * Destino: NEON_DATABASE_URL_UNPOOLED do .env.neon (arquivo que o dono cria; ignorado pelo git).
 *
 * Segurança:
 * - nunca imprime as URLs: host e senha aparecem mascarados (inclusive nas mensagens do pg_dump/pg_restore);
 * - a senha chega ao pg_dump/pg_restore só pela variável PGPASSWORD do processo filho, nunca na linha de comando;
 * - o dump (dados comerciais) fica numa pasta temporária apagada no fim, mesmo com erro ou Ctrl+C;
 * - a restauração roda numa única transação: se algo falhar, o destino fica como estava.
 * Rodar a partir da raiz do projeto. Ferramentas: pg_dump/pg_restore 17 (PG_BIN muda a pasta).
 */
import { spawn } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { parse } from 'dotenv'
import { Client } from 'pg'

const ROOT = process.cwd()
const PG_BIN = process.env.PG_BIN || 'C:/Program Files/PostgreSQL/17/bin'
const EXE = process.platform === 'win32' ? '.exe' : ''
/** versão do pg_dump/pg_restore instalada: o destino precisa ser igual ou mais novo (o dump traz SETs do PG 17) */
const TOOLS_MAJOR = 17

const argv = process.argv.slice(2)
const FORCE = argv.includes('--force')
const CHECK = argv.includes('--check')
const unknownArgs = argv.filter((a) => a !== '--force' && a !== '--check')

const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '::1'])

/** parâmetros da URL que o libpq entende como variáveis de ambiente (o resto é ignorado com aviso) */
const LIBPQ_ENV: Record<string, string> = {
  sslmode: 'PGSSLMODE',
  channel_binding: 'PGCHANNELBINDING',
  sslnegotiation: 'PGSSLNEGOTIATION',
  sslrootcert: 'PGSSLROOTCERT',
  sslcert: 'PGSSLCERT',
  sslkey: 'PGSSLKEY',
  options: 'PGOPTIONS',
  connect_timeout: 'PGCONNECT_TIMEOUT',
  application_name: 'PGAPPNAME',
  target_session_attrs: 'PGTARGETSESSIONATTRS',
  gssencmode: 'PGGSSENCMODE',
}

type Conn = {
  label: string
  url: string
  host: string
  port: string
  user: string
  password: string
  database: string
  params: URLSearchParams
  isLocal: boolean
  /** forma segura de mostrar a conexão no log */
  shown: string
}

// ---------- mascaramento ----------

/** "ep-cool-name-123456.sa-east-1.aws.neon.tech" → "ep-***.sa-east-1.aws.neon.tech" */
function maskHost(host: string) {
  if (LOCAL_HOSTS.has(host)) return host
  const [first, ...rest] = host.split('.')
  return [`${first.slice(0, 3)}***`, ...rest].join('.')
}

/** segredos conhecidos → substituto; aplicado a TUDO que o script imprime */
const secrets: [string, string][] = []
function addSecret(value: string, replacement: string) {
  if (value && value !== replacement && !secrets.some(([s]) => s === value)) secrets.push([value, replacement])
  secrets.sort((a, b) => b[0].length - a[0].length) // a URL inteira antes do host/senha que ela contém
}
function redact(text: string) {
  let out = text
  for (const [s, r] of secrets) out = out.split(s).join(r)
  return out
}
const log = (msg = '') => console.log(redact(msg))
const warn = (msg: string) => console.warn(redact(`AVISO: ${msg}`))

// ---------- configuração ----------

function readEnvFile(name: string): Record<string, string> | null {
  const file = path.join(ROOT, name)
  if (!fs.existsSync(file)) return null
  const buf = fs.readFileSync(file)
  // tolera arquivo salvo pelo PowerShell/Bloco de Notas em UTF-16 ou com BOM
  const text = buf[0] === 0xff && buf[1] === 0xfe ? buf.toString('utf16le') : buf.toString('utf8')
  return parse(text.replace(/^﻿/, ''))
}

function parseConn(label: string, raw: string | undefined, origin: string): Conn {
  if (!raw?.trim()) throw new Error(`${label}: ${origin} não está definida.`)
  let u: URL
  try {
    u = new URL(raw.trim())
  } catch {
    throw new Error(`${label}: ${origin} não é uma URL válida (esperado postgresql://usuario:senha@host/banco?sslmode=require).`)
  }
  if (u.protocol !== 'postgres:' && u.protocol !== 'postgresql:') throw new Error(`${label}: ${origin} precisa começar com postgresql://`)
  const host = decodeURIComponent(u.hostname).replace(/^\[(.*)\]$/, '$1')
  const password = decodeURIComponent(u.password)
  const database = decodeURIComponent(u.pathname.replace(/^\//, ''))
  if (!host || !database) throw new Error(`${label}: ${origin} sem host ou sem nome do banco.`)
  const isLocal = LOCAL_HOSTS.has(host)
  // banco remoto sem sslmode na URL: exige SSL (o Neon recusa conexão sem SSL)
  if (!isLocal && !u.searchParams.has('sslmode')) u.searchParams.set('sslmode', 'require')
  const c: Conn = {
    label,
    url: u.toString(),
    host,
    port: u.port || '5432',
    user: decodeURIComponent(u.username),
    password,
    database,
    params: u.searchParams,
    isLocal,
    shown: `postgresql://***@${maskHost(host)}${u.port ? `:${u.port}` : ''}/${database}`,
  }
  addSecret(raw.trim(), c.shown)
  addSecret(c.url, c.shown)
  addSecret(u.password, '***')
  addSecret(password, '***')
  if (!isLocal) addSecret(host, maskHost(host))
  return c
}

/** URL para o driver pg: sslmode=require vira verify-full (é o que o pg já faz, mas sem o aviso de depreciação) */
function pgUrl(c: Conn) {
  const u = new URL(c.url)
  const mode = u.searchParams.get('sslmode')
  if (mode && ['prefer', 'require', 'verify-ca'].includes(mode)) u.searchParams.set('sslmode', 'verify-full')
  return u.toString()
}

/** ambiente do processo filho: conexão inteira por variáveis PG* (nada de URL nem senha na linha de comando) */
function childEnv(c: Conn) {
  const env = { ...process.env }
  for (const k of Object.keys(env)) if (/^PG/i.test(k)) delete env[k]
  Object.assign(env, { PGHOST: c.host, PGPORT: c.port, PGUSER: c.user, PGPASSWORD: c.password, PGDATABASE: c.database })
  if (!c.params.has('connect_timeout')) env.PGCONNECT_TIMEOUT = '30'
  for (const [k, v] of c.params) {
    const name = LIBPQ_ENV[k]
    if (name) env[name] = v
    else warn(`${c.label}: parâmetro "${k}" da URL ignorado pelo pg_dump/pg_restore.`)
  }
  return env
}

// ---------- processos e consultas ----------

/** roda pg_dump/pg_restore repassando a saída linha a linha, já mascarada */
function runTool(tool: 'pg_dump' | 'pg_restore', args: string[], env: NodeJS.ProcessEnv) {
  return new Promise<void>((resolve, reject) => {
    const p = spawn(path.join(PG_BIN, tool + EXE), args, { env, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true })
    const pipe = (stream: NodeJS.ReadableStream, out: NodeJS.WriteStream) => {
      let buf = ''
      stream.on('data', (d: Buffer) => {
        buf += d.toString()
        const lines = buf.split(/\r?\n/)
        buf = lines.pop() ?? ''
        for (const l of lines) out.write(`  [${tool}] ${redact(l)}\n`)
      })
      stream.on('end', () => {
        if (buf) out.write(`  [${tool}] ${redact(buf)}\n`)
      })
    }
    pipe(p.stdout, process.stdout)
    pipe(p.stderr, process.stderr)
    p.on('error', (e) => reject(new Error(`não foi possível executar ${tool}: ${e.message}`)))
    p.on('close', (code) => (code === 0 ? resolve() : reject(new Error(`${tool} terminou com código ${code}.`))))
  })
}

async function connect(c: Conn) {
  const client = new Client({
    connectionString: pgUrl(c),
    connectionTimeoutMillis: 30_000,
    // o Neon manda channel_binding=require na URL; o driver pg só entende a opção explícita
    enableChannelBinding: c.params.get('channel_binding') === 'require',
  })
  // erro de um cliente ocioso não derruba o script sem mensagem
  client.on('error', (e) => warn(`${c.label}: conexão caiu (${e.message})`))
  await client.connect()
  return client
}

async function majorVersion(client: Client) {
  const { rows } = await client.query<{ v: string }>("select current_setting('server_version_num') as v")
  return Math.floor(Number(rows[0].v) / 10000)
}

/** tabelas de usuário (todos os schemas, exceto os do sistema) */
async function userTables(client: Client) {
  const { rows } = await client.query<{ s: string; t: string }>(
    `select table_schema as s, table_name as t from information_schema.tables
     where table_type = 'BASE TABLE' and table_schema not in ('pg_catalog', 'information_schema') and table_schema not like 'pg\\_%'
     order by 1, 2`,
  )
  return rows
}

/** contagem exata de linhas por tabela (o banco é pequeno: ~17 MB) */
async function countRows(client: Client) {
  const counts = new Map<string, number>()
  for (const { s, t } of await userTables(client)) {
    const { rows } = await client.query<{ n: string }>(`select count(*) as n from ${client.escapeIdentifier(s)}.${client.escapeIdentifier(t)}`)
    counts.set(`${s}.${t}`, Number(rows[0].n))
  }
  return counts
}

function printComparison(source: Map<string, number>, target: Map<string, number> | null) {
  const names = [...new Set([...source.keys(), ...(target?.keys() ?? [])])].sort()
  const w = Math.max(...names.map((n) => n.length), 6)
  const fmt = (n: number | undefined) => (n === undefined ? '—' : n.toLocaleString('pt-BR')).padStart(10)
  log(`  ${'tabela'.padEnd(w)}  ${'local'.padStart(10)}  ${target ? 'neon'.padStart(10) : ''}`)
  let diffs = 0
  for (const n of names) {
    const a = source.get(n)
    const b = target?.get(n)
    let status = ''
    if (target) {
      if (a === undefined) status = 'só no Neon'
      else if (b === undefined) status = 'FALTA no Neon'
      else if (a !== b) status = 'DIFERENTE'
      else status = 'ok'
      if (status !== 'ok') diffs++
    }
    log(`  ${n.padEnd(w)}  ${fmt(a)}  ${target ? `${fmt(b)}  ${status}` : ''}`)
  }
  return diffs
}

// ---------- fluxo principal ----------

let tmpDir: string | null = null
function cleanup() {
  if (!tmpDir) return
  try {
    fs.rmSync(tmpDir, { recursive: true, force: true })
    log('Arquivo de dump temporário apagado.')
  } catch (e) {
    warn(`não consegui apagar a pasta temporária ${tmpDir}: ${(e as Error).message} — apague-a manualmente.`)
  }
  tmpDir = null
}
process.on('SIGINT', () => {
  cleanup()
  process.exit(130)
})

async function main() {
  if (unknownArgs.length) throw new Error(`opção desconhecida: ${unknownArgs.join(' ')} (use --check ou --force)`)

  const localEnv = readEnvFile('.env')
  if (!localEnv) throw new Error('.env não encontrado — rode o script a partir da raiz do projeto.')
  const neonEnv = readEnvFile('.env.neon')
  if (!neonEnv) {
    throw new Error('.env.neon não encontrado. Crie-o na raiz do projeto com UMA linha:\n  NEON_DATABASE_URL_UNPOOLED=<URL "unpooled" do Neon, sem "-pooler" no host>')
  }

  const source = parseConn('origem (local)', localEnv.DATABASE_URL, 'DATABASE_URL do .env')
  const target = parseConn('destino (Neon)', neonEnv.NEON_DATABASE_URL_UNPOOLED || neonEnv.DATABASE_URL_UNPOOLED, 'NEON_DATABASE_URL_UNPOOLED do .env.neon')

  log(`Origem : ${source.shown}`)
  log(`Destino: ${target.shown}`)
  log(`Modo   : ${CHECK ? 'verificação (não copia nada)' : FORCE ? 'cópia com --force (sobrescreve o destino)' : 'cópia'}`)
  log()

  if (/-pooler\./i.test(target.host)) {
    throw new Error('o destino é a URL "pooled" (host com "-pooler"). Use a URL UNPOOLED (direta) no .env.neon: o pg_restore não funciona pelo pooler.')
  }
  if (source.host === target.host && source.port === target.port && source.database === target.database) {
    throw new Error('origem e destino são o mesmo banco — confira o .env.neon.')
  }
  if (!source.isLocal) warn('a origem não é um banco local (localhost). Confira se o .env é mesmo o do seu computador.')
  if (target.isLocal) warn('o destino é um banco local, não o Neon.')
  for (const tool of ['pg_dump', 'pg_restore'] as const) {
    if (!fs.existsSync(path.join(PG_BIN, tool + EXE))) throw new Error(`${tool} não encontrado em ${PG_BIN} (instale o PostgreSQL 17 ou defina PG_BIN).`)
  }

  const src = await connect(source)
  const tgt = await connect(target)
  try {
    const [srcMajor, tgtMajor] = [await majorVersion(src), await majorVersion(tgt)]
    log(`Postgres: local ${srcMajor}, Neon ${tgtMajor}; ferramentas ${TOOLS_MAJOR}.`)
    if (srcMajor > TOOLS_MAJOR) throw new Error(`o banco local é Postgres ${srcMajor}; o pg_dump ${TOOLS_MAJOR} não consegue copiá-lo.`)
    if (tgtMajor < TOOLS_MAJOR) throw new Error(`o Neon está em Postgres ${tgtMajor}. Crie o projeto Neon com Postgres ${TOOLS_MAJOR} (ou mais novo).`)

    const existing = await userTables(tgt)
    if (existing.length) {
      const msg = `o destino já tem ${existing.length} tabela(s)`
      if (CHECK) warn(`${msg}; a cópia vai exigir --force.`)
      else if (!FORCE) throw new Error(`${msg}. Para sobrescrevê-las, rode de novo com --force.`)
      else warn(`${msg}; serão apagadas e recriadas a partir do banco local (--force).`)
    } else log('Destino vazio: ok.')

    // instantâneo único da origem: o dump e as contagens enxergam exatamente os mesmos dados
    await src.query('BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY')
    const { rows: snap } = await src.query<{ id: string }>('select pg_export_snapshot() as id')

    if (CHECK) {
      log('\nLinhas por tabela:')
      const srcCounts = await countRows(src)
      await src.query('COMMIT')
      printComparison(srcCounts, existing.length ? await countRows(tgt) : null)
      log('\nVerificação concluída. Nada foi copiado.')
      return
    }

    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pacifil-neon-'))
    const dumpFile = path.join(tmpDir, 'pacifil.dump')

    log('\n1/4 Exportando o banco local (pg_dump)…')
    await runTool('pg_dump', ['--format=custom', '--no-owner', '--no-acl', `--snapshot=${snap[0].id}`, `--file=${dumpFile}`], childEnv(source))
    const srcCounts = await countRows(src)
    await src.query('COMMIT')
    log(`    dump: ${(fs.statSync(dumpFile).size / 1024 / 1024).toFixed(1)} MB`)

    log('2/4 Restaurando no Neon (pg_restore, transação única)…')
    // --dbname leva só o NOME do banco; host, usuário e senha vão pelas variáveis PG* do processo filho
    const restoreArgs = ['--no-owner', '--no-acl', '--single-transaction', ...(FORCE ? ['--clean', '--if-exists'] : []), `--dbname=${target.database}`, dumpFile]
    await runTool('pg_restore', restoreArgs, childEnv(target))
    cleanup()

    log('3/4 Ajustes pós-restauração no Neon…')
    const qaEmail = localEnv.QA_EMAIL?.trim().toLowerCase()
    if (qaEmail) {
      const r = await tgt.query('update app_user set active = false, session_version = session_version + 1 where lower(email) = $1', [qaEmail])
      log(r.rowCount ? '    usuário de QA (QA_EMAIL) desativado.' : '    usuário de QA (QA_EMAIL) não existe no destino — nada a fazer.')
    } else log('    QA_EMAIL não definido no .env — nenhum usuário de QA para desativar.')
    const { rows: admins } = await tgt.query<{ n: string }>("select count(*) as n from app_user where active and role = 'ADMIN'")
    if (Number(admins[0].n) === 0) warn('nenhum ADMIN ativo no destino — ninguém conseguirá administrar a plataforma.')
    else log(`    administradores ativos: ${admins[0].n}`)
    await tgt.query('ANALYZE')
    log('    estatísticas do planejador atualizadas (ANALYZE).')

    log('4/4 Conferindo linhas por tabela (local × Neon):')
    const diffs = printComparison(srcCounts, await countRows(tgt))
    if (diffs) {
      warn(`${diffs} tabela(s) com diferença. Confira acima antes de publicar.`)
      process.exitCode = 1
    } else log('\nCópia concluída: todas as tabelas conferem.')
  } finally {
    cleanup()
    await src.end().catch(() => {})
    await tgt.end().catch(() => {})
  }
}

main().then(
  () => process.exit(process.exitCode ?? 0),
  (e: unknown) => {
    cleanup()
    console.error(redact(`\nERRO: ${e instanceof Error ? e.message : String(e)}`))
    process.exit(1)
  },
)
