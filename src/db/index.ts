import { attachDatabasePool } from '@vercel/functions'
import { drizzle } from 'drizzle-orm/node-postgres'
import { Pool } from 'pg'
import * as schema from './schema'

const globalForDb = globalThis as unknown as { pgPool?: Pool }

/**
 * Pool pensado para serverless (Vercel Fluid compute + Neon):
 * - em produção DATABASE_URL é a URL POOLED do Neon (host "-pooler"), então poucas conexões por instância bastam;
 * - conexões ociosas fecham em 5 s para não acumular conexões abertas entre instâncias;
 * - se o banco não responder em 10 s, a consulta falha com erro claro em vez de ficar pendurada.
 */
function createPool() {
  const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    max: 5,
    idleTimeoutMillis: 5_000,
    connectionTimeoutMillis: 10_000,
  })
  // um cliente ocioso que cai (reinício do banco, rede) não pode derrubar o processo
  pool.on('error', (e) => console.error('[pg pool]', e.message))
  // na Vercel mantém a instância viva até as conexões ociosas fecharem; fora da Vercel não faz nada
  attachDatabasePool(pool)
  return pool
}

// em desenvolvimento o hot reload recarrega o módulo: reaproveita o mesmo pool
const pool = globalForDb.pgPool ?? createPool()
if (process.env.NODE_ENV !== 'production') globalForDb.pgPool = pool

export const db = drizzle(pool, { schema })
export type Db = typeof db
export { schema }
