import { cfopAreaWarning, normalizeCfop } from '@/domain/cfop'
import { normalizePaymentTerms, type PaymentTerms } from '@/domain/paymentTerms'
import { specialTransportCompany } from '@/domain/transportCompany'

/** dados comerciais do pedido mostrados (só leitura) no diálogo "Confirmar pedido"; editam-se em "Proforma, transporte e fiscal" */
export interface ConfirmCommercial {
  /** condição de pagamento em português (null = não definida) */
  paymentTerms: string | null
  /** mostrar a condição (quem vê preços) */
  showPaymentTerms: boolean
  cfop: string | null
  transportCompany: { code: string; name: string } | null
  /** as outras unidades a confirmar junto têm transportadora ou condição diferente desta */
  siblingsDiffer: boolean
}

/** Avisos do diálogo "Confirmar pedido" — NUNCA bloqueiam a confirmação. */
export function confirmWarnings(c: ConfirmCommercial, withSiblings: boolean): string[] {
  const w: string[] = []
  if (c.showPaymentTerms && !c.paymentTerms) w.push('Condição de pagamento não definida.')
  if (!c.cfop) w.push('CFOP não informado.')
  else {
    const a = cfopAreaWarning(c.cfop, 'EXPORT')
    if (a) w.push(a)
  }
  if (!c.transportCompany) w.push('Transportadora não definida.')
  else if (specialTransportCompany(c.transportCompany) === 'to_define') w.push('Transportadora ainda “A definir”.')
  if (withSiblings && c.siblingsDiffer) w.push('As outras unidades deste pedido têm transportadora ou condição de pagamento diferente — confira no painel de cada uma.')
  return w
}

/** chave para comparar condições: a forma normalizada (a mesma que o servidor grava), sem depender da ordem das chaves nem de campos ausentes x null */
export const termsKey = (t: PaymentTerms | null | undefined) => JSON.stringify(normalizePaymentTerms(t))

type Commercial = { transportCompanyId: number | null; paymentTerms: PaymentTerms | null }

/** Alguma das outras unidades tem transportadora diferente da desta carga? */
export function carrierDiffers(plan: Commercial, others: Commercial[]): boolean {
  return others.some((o) => o.transportCompanyId !== plan.transportCompanyId)
}

/** Alguma das outras unidades tem condição de pagamento diferente da desta carga? */
export function termsDiffer(plan: Commercial, others: Commercial[]): boolean {
  return others.some((o) => termsKey(o.paymentTerms) !== termsKey(plan.paymentTerms))
}

/** Alguma das outras unidades tem transportadora ou condição de pagamento diferente da desta carga? */
export function commercialDiffers(plan: Commercial, others: Commercial[]): boolean {
  return carrierDiffers(plan, others) || termsDiffer(plan, others)
}

/** o que o "Salvar" do painel muda numa outra unidade do pedido */
export interface SiblingChange<S extends Commercial & { id: number } = Commercial & { id: number }> {
  sibling: S
  /** recebe a transportadora desta carga */
  carrier: boolean
  /** recebe a condição de pagamento desta carga */
  terms: boolean
}

/**
 * Outras unidades do pedido alteradas ao salvar o painel de uma carga:
 * - condição de pagamento: na Exportação vale SEMPRE para todas as unidades do pedido (no Mercado Interno não muda);
 * - transportadora: só com `applyCarrier` (caixa "Aplicar a transportadora a todas as unidades").
 * Só entram as unidades em que algo de fato muda.
 */
export function siblingCommercialChanges<S extends Commercial & { id: number }>(
  next: Commercial,
  siblings: S[],
  o: { exportArea: boolean; applyCarrier: boolean },
): SiblingChange<S>[] {
  const out: SiblingChange<S>[] = []
  for (const s of siblings) {
    const carrier = o.applyCarrier && s.transportCompanyId !== next.transportCompanyId
    const terms = o.exportArea && termsKey(s.paymentTerms) !== termsKey(next.paymentTerms)
    if (carrier || terms) out.push({ sibling: s, carrier, terms })
  }
  return out
}

/**
 * Transportadora INATIVA só pode continuar na unidade que já a tinha: levá-la para outra unidade é escolha
 * nova, e escolha nova só vale para transportadora ativa. Devolve o erro ou null.
 */
export function inactiveCarrierToSiblingsError(changes: SiblingChange[], carrier: { active: boolean; label: string } | null): string | null {
  if (!carrier || carrier.active || !changes.some((c) => c.carrier)) return null
  return `A transportadora ${carrier.label} está inativa: não dá para aplicá-la às outras unidades do pedido. Escolha uma ativa ou desmarque “Aplicar a transportadora a todas as unidades”.`
}

/**
 * CFOP (é do PEDIDO) a enviar pelo painel de uma carga: só se foi alterado ali, junto com o valor que o
 * painel carregou (`cfopExpected`), para o servidor recusar se outra pessoa o mudou nesse meio-tempo.
 * Sem alteração → null (o servidor mantém o gravado; um painel desatualizado não o reverte).
 */
export function cfopEdit(typed: string | null | undefined, loaded: string | null | undefined): { cfop: string | null; cfopExpected: string | null } | null {
  const cfop = normalizeCfop(typed)
  const cfopExpected = normalizeCfop(loaded)
  return cfop === cfopExpected ? null : { cfop, cfopExpected }
}

export const CFOP_CONFLICT_ERROR = 'O CFOP do pedido foi alterado por outra pessoa — recarregue a página.'

/**
 * O CFOP gravado mudou desde que o painel o carregou (`expected`)? Se o gravado já é o valor novo, não há
 * conflito (nada a mudar — por exemplo, o mesmo usuário salvou duas vezes antes de a página recarregar).
 */
export function cfopConflict(stored: string | null | undefined, expected: string | null | undefined, next: string | null): boolean {
  const s = normalizeCfop(stored)
  return s !== normalizeCfop(expected) && s !== next
}
