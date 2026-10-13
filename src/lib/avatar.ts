/**
 * AVATAR DO USUÁRIO (sem dependências de servidor). Valor guardado em app_user.avatar (ÚNICO):
 *  - um emoji da lista abaixo, ou
 *  - 'foto:<hash>' quando o usuário subiu uma foto (a imagem fica em avatar_image e é servida em /avatar/[id]).
 * Para as telas, o avatar vira `AvatarRef`: emoji, URL da foto ou null (iniciais do nome).
 */
export const AVATAR_EMOJIS = [
  '🦊', '🐻', '🐼', '🐨', '🦁', '🐯', '🐮', '🐷', '🐸', '🐵', '🦉', '🦅',
  '🐬', '🐳', '🐢', '🦋', '🐝', '🐞', '🌻', '🌵', '🌳', '🍀', '🌾', '🌽',
  '🚜', '🚚', '🚢', '✈️', '🏗️', '📦', '🧭', '⚓', '🌎', '🌞', '⭐', '🔥',
  '⚡', '💧', '🎯', '🚀', '🎸', '⚽', '🏆', '🧉', '☕', '🍕', '🍇', '🍋',
]

/** O que as telas recebem: emoji, URL da foto ou null. */
export type AvatarRef = string | null

export const isPhotoKey = (v: string | null | undefined) => Boolean(v?.startsWith('foto:'))
export const photoUrl = (userId: number, key: string) => `/avatar/${userId}?v=${key.slice(5, 13)}`

/** Converte o valor guardado no banco no que a tela mostra. */
export function avatarRef(userId: number, stored: string | null | undefined): AvatarRef {
  if (!stored) return null
  return isPhotoKey(stored) ? photoUrl(userId, stored) : stored
}

/** Foto aceita: JPEG/PNG/WebP em data URL, até ~200 KB (a tela reduz para ~160 px antes de enviar). */
export const MAX_PHOTO_CHARS = 280_000
export const isPhotoDataUrl = (v: string) => /^data:image\/(jpeg|png|webp);base64,[A-Za-z0-9+/=]+$/.test(v) && v.length <= MAX_PHOTO_CHARS

/** Iniciais e cor estável para quem ainda não escolheu avatar. */
export function initials(name: string) {
  const p = name.trim().split(/\s+/)
  return ((p[0]?.[0] ?? '?') + (p.length > 1 ? p[p.length - 1][0] : '')).toUpperCase()
}
export function nameColor(name: string) {
  let h = 0
  for (const c of name) h = (h * 31 + c.charCodeAt(0)) % 360
  return `hsl(${h} 45% 42%)`
}
