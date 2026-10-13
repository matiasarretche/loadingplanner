/**
 * Regras comerciais da Pacifil aplicadas pelo motor.
 *
 * EMPILHAMENTO: todos os paletes e caixas, de todos os produtos e em todas as modalidades, aceitam
 * carga por cima sempre que houver altura útil (o limite físico continua: altura, porta, apoio
 * mínimo, payload e, se informado, peso máximo por cima). Os campos "empilhável" do cadastro e dos
 * snapshots antigos são ignorados enquanto esta regra estiver ativa.
 *
 * OBJETIVO DE CARGA: colocar a maior quantidade de produto (kg) possível, até o payload efetivo:
 * o preenchimento automático usa o piso e depois empilha.
 */
export const ALWAYS_STACKABLE = true

/** Aplica a regra de empilhamento sobre o valor cadastrado. */
export const stackable = (flag: boolean | null | undefined): boolean => ALWAYS_STACKABLE || Boolean(flag)
