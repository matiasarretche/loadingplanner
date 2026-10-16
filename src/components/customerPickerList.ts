/**
 * Lista do seletor de clientes (CustomerPicker), sem React: que opções aparecem e em que ordem.
 * Separada do componente para poder ser testada.
 */

/** grupo mostrado no topo antes de digitar (ex.: homônimos do pedido; parecidos com o do pedido) */
export interface PickerGroup {
  label: string
  ids: number[]
}

/** opções desenhadas por vez (o resto aparece ao refinar a busca): leve com centenas de clientes */
export const MAX_SHOWN = 60

export interface PickerList<T> {
  /** grupos do topo (só sem busca), na ordem recebida, sem repetir cliente nem grupo vazio */
  groups: { label: string; items: T[] }[]
  /** demais clientes desenhados (até `max`; sem busca, o escolhido entra sempre — primeiro, se estava de fora) */
  shown: T[]
  /** quantos ficaram de fora (continue digitando) */
  hidden: number
  /** opções na ordem da tela (null = novo cliente): base da navegação pelo teclado */
  items: (T | null)[]
}

/**
 * Opções do seletor. `results` = clientes que batem com a busca (sem busca, todos, em ordem alfabética);
 * `selected` = cliente escolhido agora (sem busca ele sempre aparece, para ficar destacado ao abrir,
 * mesmo fora dos primeiros `max`).
 */
export function pickerList<T extends { id: number }>(
  results: T[],
  o: { query: string; featured?: PickerGroup[]; byId: Map<number, T>; selected: T | null; max?: number },
): PickerList<T> {
  const q = o.query.trim()
  const used = new Set<number>()
  const groups = (q ? [] : (o.featured ?? []))
    .map((g) => ({
      label: g.label,
      items: g.ids.flatMap((id) => {
        const c = o.byId.get(id)
        if (!c || used.has(id)) return []
        used.add(id)
        return [c]
      }),
    }))
    .filter((g) => g.items.length > 0)
  const rest = used.size ? results.filter((c) => !used.has(c.id)) : results
  const shown = rest.slice(0, o.max ?? MAX_SHOWN)
  if (!q && o.selected && !used.has(o.selected.id) && !shown.includes(o.selected) && rest.includes(o.selected)) shown.unshift(o.selected)
  return { groups, shown, hidden: rest.length - shown.length, items: [null, ...groups.flatMap((g) => g.items), ...shown] }
}
