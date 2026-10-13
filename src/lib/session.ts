import 'server-only'
import { jwtVerify, SignJWT } from 'jose'
import { cookies } from 'next/headers'

export const SESSION_COOKIE = 'plp_session'
const MAX_AGE_S = 60 * 60 * 12 // 12 h

export interface SessionPayload {
  uid: number
  role: string
  /** versão da sessão do usuário (trocar a senha invalida as sessões antigas) */
  sv?: number
}

function secret() {
  const s = process.env.SESSION_SECRET
  if (!s || s.length < 32) throw new Error('SESSION_SECRET ausente ou curto demais')
  return s
}

function key() {
  return new TextEncoder().encode(secret())
}

export async function encrypt(p: SessionPayload) {
  return new SignJWT({ ...p })
    .setProtectedHeader({ alg: 'HS256' })
    .setIssuedAt()
    .setExpirationTime(`${MAX_AGE_S}s`)
    .sign(key())
}

export async function decrypt(token: string | undefined): Promise<SessionPayload | null> {
  if (!token) return null
  try {
    const { payload } = await jwtVerify(token, key(), { algorithms: ['HS256'] })
    if (typeof payload.uid !== 'number') return null
    return { uid: payload.uid, role: String(payload.role), sv: typeof payload.sv === 'number' ? payload.sv : 0 }
  } catch {
    return null
  }
}

export async function createSession(p: SessionPayload) {
  const token = await encrypt(p)
  const store = await cookies()
  store.set(SESSION_COOKIE, token, {
    httpOnly: true,
    secure: process.env.NODE_ENV === 'production',
    sameSite: 'lax',
    path: '/',
    maxAge: MAX_AGE_S,
  })
}

export async function deleteSession() {
  const store = await cookies()
  store.delete(SESSION_COOKIE)
}

export async function readSession() {
  const store = await cookies()
  return decrypt(store.get(SESSION_COOKIE)?.value)
}

/**
 * Dispositivo conhecido: depois de um login certo o navegador guarda por 30 dias um token (só o id do usuário).
 * Com ele, o bloqueio da CONTA inteira (ataque de muitos endereços) não impede o dono de entrar; o limite
 * conta+endereço e o limite por IP continuam valendo. Chave própria, derivada do SESSION_SECRET: um token de
 * dispositivo nunca vale como sessão, nem o contrário.
 */
const DEVICE_COOKIE = 'plp_device'
const DEVICE_MAX_AGE_S = 60 * 60 * 24 * 30 // 30 dias
const DEVICE_PURPOSE = 'dispositivo-conhecido'

function deviceKey() {
  return new TextEncoder().encode(`${secret()}:${DEVICE_PURPOSE}`)
}

export async function rememberDevice(uid: number) {
  const token = await new SignJWT({ uid, p: DEVICE_PURPOSE })
    .setProtectedHeader({ alg: 'HS256' })
    .setIssuedAt()
    .setExpirationTime(`${DEVICE_MAX_AGE_S}s`)
    .sign(deviceKey())
  const store = await cookies()
  // só o login lê este cookie
  store.set(DEVICE_COOKIE, token, { httpOnly: true, secure: process.env.NODE_ENV === 'production', sameSite: 'lax', path: '/login', maxAge: DEVICE_MAX_AGE_S })
}

/** id do usuário que já entrou por este navegador (null = desconhecido, vencido ou inválido) */
export async function knownDeviceUid(): Promise<number | null> {
  const token = (await cookies()).get(DEVICE_COOKIE)?.value
  if (!token) return null
  try {
    const { payload } = await jwtVerify(token, deviceKey(), { algorithms: ['HS256'] })
    return payload.p === DEVICE_PURPOSE && typeof payload.uid === 'number' ? payload.uid : null
  } catch {
    return null
  }
}
