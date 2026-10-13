/** textos fixos da LISTA DE PREÇOS, sem pdf-lib (a tela importa daqui) */
import { TECHNOLOGIES } from '@/domain/technology'
import type { PdfLang } from './i18n'

/** dias de validade da lista a partir da emissão */
export const PRICE_LIST_VALID_DAYS = 10

/** descrição comercial padrão (a mesma para todos os produtos); {marca} = marca do produto */
export const PRICE_LIST_DESCRIPTION: Record<PdfLang, string> = {
  es: 'USO EXCLUSIVO PARA ALMACENAMIENTO AGRÍCOLA, composición: polietileno PEBD/PEBDL, color: Externa: blanco / Interna: negro. Marca: {marca}',
  pt: 'USO EXCLUSIVO PARA ARMAZENAMENTO AGRÍCOLA, composição: polietileno PEBD/PEBDL, cor: Externa: branca / Interna: preta. Marca: {marca}',
  en: 'FOR AGRICULTURAL STORAGE USE ONLY, composition: LDPE/LLDPE polyethylene, color: Outer: white / Inner: black. Brand: {marca}',
}

/**
 * PACIFIL NXT: tecnologia exclusiva divulgada nas listas de preços (título igual em todos os idiomas).
 * QUAIS famílias levam NXT (menção ou selo) é definido no Catálogo (src/domain/technology.ts).
 */
export const NXT_TITLE = TECHNOLOGIES.NXT.title
export const PRICE_LIST_NXT: Record<PdfLang, string> = TECHNOLOGIES.NXT.text
