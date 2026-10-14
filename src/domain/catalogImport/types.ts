/**
 * IMPORTAÇÃO DO CATÁLOGO OFICIAL (planilha de PRODUTOS + TABELA DAS CAIXAS) — tipos compartilhados.
 * O motor é puro (sem banco, sem exceljs): recebe as linhas cruas das planilhas e o catálogo atual e
 * devolve um plano (prévia) que o servidor grava e, depois de conferido, aplica.
 */
import type { ImportDecisions } from './decisions'

export const ENGINE_VERSION = '2026-10-14.3'
export type Confidence = 'HIGH' | 'MEDIUM' | 'LOW'
export type EanStatus = 'EAN13' | 'GTIN14' | 'INVALID'
export type FamilyKey = 'SILO_BAG' | 'SILAGE_TARP' | 'HIDROSILO' | 'HYDROFORCE' | 'SILAGE_BAG' | 'ACCESSORY' | 'FILM_ROLL' | 'HIDROPESO'
export type ProductKindKey = 'SILO_BAG' | 'TARP' | 'FILM_ROLL' | 'HIDROSILO' | 'HYDROFORCE' | 'SILAGE_BAG_BOX' | 'HIDROPESO' | 'TAPE_PE' | 'TAPE_PE_BOX' | 'TAPE_BUTYL' | 'TAPE_BUTYL_BOX' | 'REPAIR_PATCH_PVC'
export type LineKey = 'SB_STD' | 'SB_ECO' | 'SB_PRO' | 'TARP_BPF' | 'TARP_STD' | 'TARP_PLUS' | 'TARP_BPF_PLUSX3' | 'TARP_BPF_BP' | 'TARP_BARRIER_PA' | 'TARP_BIGSAFE' | 'TARP_BIGSAFE_PLUSX3' | 'TARP_BIGFORT' | 'TARP_BIGSILO' | 'TARP_BIGSILO_PLUSX3' | 'FILM_BPF' | 'FILM_BIGSAFE' | 'HS' | 'HS_PLUSX3' | 'HF' | 'SILAGE_BAG' | 'HIDROPESO' | 'TAPE_PE' | 'TAPE_BUTYL' | 'PATCH'
export type BoxLine = 'STD' | 'ECO' | 'PRO' | 'SI' | 'BRIDON' | 'URU' | 'BPF' | 'LP' | 'BIGSAFE' | 'BIGSILO' | 'ESP' | 'ESP-EUA' | 'HS' | 'HS-OLD'
export type CatalogImportStatus = 'PREVIEW' | 'APPLIED' | 'SYNCING' | 'SYNCED' | 'SYNC_FAILED' | 'DISCARDED' | 'SUPERSEDED'
export type CellValue = string | number | null

export interface RawProductRow { row: number; code: CellValue; group: CellValue; measure: CellValue; thickness: CellValue; brand: CellValue; netKg: CellValue; grossKg: CellValue; ean: CellValue }
export interface RawBoxRow { row: number; hidden: boolean; code: CellValue; rangeText: CellValue; reference: CellValue; palletText: CellValue; lengthMm: CellValue; widthMm: CellValue; heightMm: CellValue; boxKg: CellValue; kitKg: CellValue; plasticKg: CellValue; totalKg: CellValue; totalIsFormula: boolean; boxesPerPalletText: CellValue }
export interface FileInfo { name: string; bytes: number; sha256: string; sheetName: string; lastDataRow: number; declaredRows: number | null }

export interface CurrentPack { packagingVersionId: number; version: number; locked: boolean; lengthMm: number; widthMm: number; heightMm: number; netKg: number; grossKg: number; unitsPerPackage: number; unitsPerPallet: number | null; palletTypeCode: string | null; verification: 'VERIFIED' | 'ESTIMATED' | 'UNVERIFIED' }
export interface CurrentVariant { variantId: number; productId: number; sku: string; name: string; familyCode: string; familyName: string; line: string; brand: string; active: boolean /* variant && product && family */; thicknessUm: number | null; diameterFt: number | null; widthM: number | null; lengthM: number | null; lengthFt: number | null; attrs: Record<string, string | number | null>; ean: string | null; pack: CurrentPack | null /* highest version */ }
export interface FamilyRef { id: number; code: string; name: string; active: boolean; sort: number }
export interface LineRef { id: number; familyId: number; name: string; active: boolean }
export interface PalletTypeRef { id: number; code: string; lengthMm: number; widthMm: number; /** altura do tabuleiro (mm) */ heightMm?: number | null; overhangAllowed?: boolean; overhangMaxMm?: number; active: boolean }
/** perímetro REAL de fabricação de um diâmetro (tabela family_perimeter; domain/siloPerimeter.ts) */
export interface RealPerimeterRef { familyCode: string; diameterFt: number; perimeterM: number }
export interface CurrentCatalog { variants: CurrentVariant[]; families: FamilyRef[]; lines: LineRef[]; palletTypes: PalletTypeRef[]; /** perímetros reais cadastrados (sem a tabela = peso da planilha para todos) */ realPerimeters?: RealPerimeterRef[] }

export interface BoxMeasure { d?: number; lenM?: number | null; lenFt?: number | null; w?: number; capacityL?: number }
export interface BoxModel { sheetRow: number; code: string | null; reference: string; refKey: string; recognized: boolean; family: 'SILO_BAG' | 'SILAGE_TARP' | 'HIDROSILO' | null; line: BoxLine | null; measures: BoxMeasure[]; thicknessUm: number[] | null; lengthMm: number; widthMm: number; heightMm: number /* l ≥ w, overrides applied */; tareKg: number /* K+L+M */; tareNote: string | null; rangeText: string | null; netKgMin: number | null; netKgMax: number | null; ignoreWeightRange: boolean; palletText: string | null; palletTypeCode: string | null; boxesPerPalletText: string | null; boxesPerPallet: number | null /* highest option */; hidden: boolean; notes: string[] }

export interface PlannedPackaging { boxCode: string | null; boxSheetRow: number | null; boxSource: 'SHEET' | 'CURRENT_CATALOG'; lengthMm: number; widthMm: number; heightMm: number; boxTareKg: number; netKg: number; grossKg: number; grossSource: 'OFFICIAL' | 'NET_PLUS_BOX_TARE'; grossNote: string | null; unitsPerPackage: number; palletTypeCode: string | null; unitsPerPallet: number | null; palletSource: 'CATALOG' | 'SHEET'; palletNote: string | null; /** altura estimada do palete padrão (mm) */ palletHeightMm: number | null; allowedOrientations: ('LWH' | 'WLH' | 'LHW' | 'HLW' | 'WHL' | 'HWL')[]; verification: 'VERIFIED' | 'ESTIMATED'; confidence: 'HIGH' | 'MEDIUM'; reason: string; notes: string[]; /** de onde vem o líquido gravado: planilha ou perímetro real do silo-bolsa (bruto = líquido + a mesma tara) */ netSource?: 'SHEET' | 'REAL_PERIMETER'; /** líquido da planilha (só com netSource REAL_PERIMETER) */ sheetNetKg?: number; realPerimeterM?: number }
export interface ProductMatch { sku: string; variantId: number; confidence: Confidence; lineRelation: 'SAME' | 'COMPATIBLE' | 'DIFFERENT' | 'EXACT_CODE'; why: string }
export interface PlannedProduct { code: string; row: number; action: 'CREATE' | 'UPDATE'; existingVariantId: number | null; family: FamilyKey; productLine: string; name: string; brand: string; kind: ProductKindKey; lineKey: LineKey; thicknessUm: number | null; diameterFt: number | null; widthM: number | null; lengthM: number | null; lengthFt: number | null; ean: string | null; eanStatus: EanStatus | null; eanNote: string | null; attrs: Record<string, string | number | null>; notes: string | null; match: ProductMatch | null; packaging: PlannedPackaging | null; /** silo-bolsa: líquido pelo perímetro real (null = diâmetro sem perímetro real) */ calcNetKg?: number | null; dataIssues: string[]; source: { group: string; measure: string; thickness: string | null; brand: string | null; netKg: number | null; grossKg: number | null } }
export type PendingReason = 'NO_BOX_RULE' | 'PACK_UNITS' | 'ACCESSORY' | 'FILM' | 'HIDROPESO' | 'SILAGE_BAG' | 'SILO_BAG_WEIGHT_GAP' | 'TARP_OVER_100KG' | 'BIGSAFE_SIZE' | 'AMBIGUOUS' | 'NO_NET_WEIGHT' | 'OTHER'
export interface Pending { code: string; row: number; name: string; family: FamilyKey; reasonCode: PendingReason; reason: string; suggestion: { boxCode: string; sheetRow: number; dims: string } | null; unitsPerPackHint: number | null }
export interface Discarded { code: string; row: number; keptCode: string; description: string; reason: string }
export interface Deactivation { variantId: number; sku: string; name: string; family: string; replacedBy: string[] }
export interface Deactivations { variants: Deactivation[]; keptActive: { sku: string; reason: string }[] }
export interface FamilyChange { key: FamilyKey; code: string; name: string; action: 'CREATE' | 'EXISTS'; sort: number | null }
export interface LineChange { family: FamilyKey; name: string; action: 'CREATE' | 'EXISTS' }
export interface PlanWarning { level: 'BLOCKER' | 'WARN' | 'INFO'; code: string; message: string; codes?: string[] }
export interface Summary { sheetRows: number; parsedRows: number; skippedRows: number; duplicateGroups: number; duplicatesDiscarded: number; planned: number; toCreate: number; toUpdate: number; withPackaging: number; pending: number; confidence: { HIGH: number; MEDIUM: number }; byFamily: { family: FamilyKey; name: string; total: number; withPackaging: number; pending: number }[]; byLine: { line: string; total: number }[]; ean: { EAN13: number; GTIN14: number; INVALID: number; missing: number }; grossReplaced: number; deactivations: number; newFamilies: string[]; newLines: string[]; boxesUsed: { boxCode: string; dims: string; products: number }[]; refPalletsEstimate: number; familiesWithoutActiveProducts: string[] }
export interface ImportPlan { engineVersion: string; generatedAt: string; decisionsId: string; files: { products: FileInfo; boxes: FileInfo }; catalogFingerprint: string; boxes: BoxModel[]; families: FamilyChange[]; lines: LineChange[]; products: PlannedProduct[]; pending: Pending[]; discarded: Discarded[]; deactivations: Deactivations; warnings: PlanWarning[]; summary: Summary }
export interface BuildPlanInput { products: RawProductRow[]; boxes: RawBoxRow[]; current: CurrentCatalog; files: { products: FileInfo; boxes: FileInfo }; catalogFingerprint: string; decisions?: ImportDecisions; now?: Date }
export interface ApplyResult { dryRun: boolean; familiesCreated: string[]; linesCreated: string[]; variantsCreated: number; variantsUpdated: number; packagingCreated: number; packagingNewVersions: number; packagingUnchanged: number; deactivated: number; reactivated: string[]; pendingWithoutPackaging: number; durationMs: number }
export interface SyncReport { updated: number; regenerated: number; archived: number; review: number; created: number; lines: string[] /* ≤ 300 */; durationMs: number }
export type { ImportDecisions } from './decisions'
