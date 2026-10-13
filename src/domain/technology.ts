/**
 * TECNOLOGIAS COMERCIAIS da Pacifil (ex.: PACIFIL NXT) associadas às famílias no Catálogo e divulgadas nos
 * PDFs comerciais (lista de preços e Proforma). Sem dependências: a tela e o servidor importam daqui.
 *
 * A família guarda a tecnologia (`technology`, chave deste registro) e como ela aparece (`technologyDisplay`):
 *   MENTION = só o texto "PACIFIL NXT — Next Generation Technology";
 *   SEAL    = o selo (logo) + o texto. O selo vai também ao lado dos itens na Proforma.
 * Uma tecnologia nova (ex.: NXT+EVOH, ainda fora do catálogo) é só uma entrada nova aqui + a imagem do selo.
 */
import type { PdfLang } from '@/lib/pdf/i18n'

export interface Technology {
  /** nome curto (telas e selos) */
  label: string
  /** título nos PDFs (igual em todos os idiomas) */
  title: string
  /** caminho público do selo (PNG com fundo transparente) */
  seal: string
  /** texto de divulgação por idioma */
  text: Record<PdfLang, string>
}

export const TECHNOLOGIES = {
  NXT: {
    label: 'PACIFIL NXT',
    title: 'PACIFIL NXT — Next Generation Technology',
    seal: '/brand/pacifil-nxt-selo.png',
    text: {
      es: 'Tecnología exclusiva de PACIFIL que representa un salto hacia una nueva generación de alto desempeño, integrando nanotecnología, mayor resistencia, propiedades avanzadas de barrera y protección antimicrobiana para ofrecer soluciones innovadoras de máxima eficiencia.',
      pt: 'Tecnologia exclusiva da PACIFIL que representa um salto para uma nova geração de alto desempenho, integrando nanotecnologia, maior resistência, propriedades avançadas de barreira e proteção antimicrobiana para oferecer soluções inovadoras de máxima eficiência.',
      en: "PACIFIL's exclusive technology, a leap into a new generation of high performance that combines nanotechnology, greater strength, advanced barrier properties and antimicrobial protection to deliver innovative, highly efficient solutions.",
    },
  },
} satisfies Record<string, Technology>

export type TechKey = keyof typeof TECHNOLOGIES
export type TechDisplay = 'MENTION' | 'SEAL'
export const TECH_DISPLAYS: readonly TechDisplay[] = ['MENTION', 'SEAL']

/** tecnologia de uma família (ou de um item, herdada da família) */
export interface FamilyTech {
  key: TechKey
  display: TechDisplay
}

export const isTechKey = (x: unknown): x is TechKey => typeof x === 'string' && Object.prototype.hasOwnProperty.call(TECHNOLOGIES, x)
export const isTechDisplay = (x: unknown): x is TechDisplay => x === 'MENTION' || x === 'SEAL'

/** lê as colunas da família; valor desconhecido/incompleto = sem tecnologia (nunca inventa selo) */
export function familyTech(row: { technology?: string | null; technologyDisplay?: string | null }): FamilyTech | null {
  return isTechKey(row.technology) && isTechDisplay(row.technologyDisplay) ? { key: row.technology, display: row.technologyDisplay } : null
}

/** opções do seletor no Catálogo: '' = nenhuma; 'NXT:MENTION' / 'NXT:SEAL' */
export const techOptionValue = (t: FamilyTech | null) => (t ? `${t.key}:${t.display}` : '')
export function parseTechOption(v: string): FamilyTech | null | undefined {
  if (!v) return null
  const [key, display] = v.split(':')
  return isTechKey(key) && isTechDisplay(display) ? { key, display } : undefined
}
export const TECH_OPTIONS: { value: string; label: string }[] = [
  { value: '', label: 'Nenhuma' },
  ...(Object.entries(TECHNOLOGIES) as [TechKey, Technology][]).flatMap(([key, t]) => [
    { value: `${key}:MENTION`, label: `${t.label} — menção (texto)` },
    { value: `${key}:SEAL`, label: `${t.label} — selo + texto` },
  ]),
]

/** rótulo curto (badge no Catálogo / lista de preços) */
export const techBadge = (t: FamilyTech) => `${TECHNOLOGIES[t.key].label}${t.display === 'SEAL' ? ' · selo' : ''}`
