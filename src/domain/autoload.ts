/**
 * Auto-carga determinística (sem IA): coloca paletes no espaço de carga usando o mesmo
 * motor de geometria e de limites da edição manual (findFreePosition, effectiveLimits, validateLoad).
 * Heurística "primeiro encaixe": do fundo (x=0) para a porta, piso antes de empilhar,
 * testando as duas orientações (giro de 90°) e respeitando porta, altura e payload efetivo.
 */
import { canSupport } from "./bodies";
import { AABB, Orientation, orientDims, Vec3 } from "./geometry";
import {
  effectiveLimits,
  loadBodies,
  loadGeometries,
  loadSummary,
} from "./load";
import { palletEnvelope, palletSummary } from "./pallet";
import { findFreePosition, Obstacle } from "./placement";
import { ALWAYS_STACKABLE, stackable } from "./policy";
import { autoOrientations, naturalOrientations } from "./orientation";
import type { LoadDoc, LoadUnit, PackSnapshot, PalletDoc } from "./types";

export type StopReason = "done" | "no_space" | "payload" | "door" | "height";

export interface PlaceOptions {
  /** empilhar sobre o que já está carregado (padrão: sim — regra Pacifil, ver policy.ts); false = só piso */
  allowStacking?: boolean;
  /** prefixo do id das unidades novas (determinístico para testes) */
  idPrefix?: string;
}

export interface PlaceResult {
  doc: LoadDoc;
  placed: number;
  requested: number | null;
  stopReason: StopReason;
  /** ids das unidades criadas */
  unitIds: string[];
  /** padrão de piso escolhido (quando avaliado) */
  pattern?: "primeiro-encaixe" | "intercalado";
}

let seq = 0;
const nextId = (prefix: string) =>
  `${prefix}${(++seq).toString(36)}${Date.now().toString(36).slice(-4)}`;

function obstaclesOf(doc: LoadDoc): Obstacle[] {
  return loadGeometries(doc).map((g) => ({
    box: g.box,
    stackable: g.stackable,
  }));
}

function heightLimit(doc: LoadDoc) {
  const h = effectiveLimits(doc).heightMm.value ?? doc.space.inner.h;
  return Math.min(h, doc.space.inner.h);
}

/** Orientações possíveis do palete (sem girar / girado) que passam pela porta e cabem na altura. */
export function palletOrientations(
  doc: LoadDoc,
  pallet: PalletDoc,
): { yaw: boolean; size: Vec3 }[] {
  const e = palletEnvelope(pallet).size;
  const opts = [
    { yaw: false, size: { x: e.x, y: e.y, z: e.z } },
    { yaw: true, size: { x: e.y, y: e.x, z: e.z } },
  ];
  const H = heightLimit(doc);
  return opts.filter(
    (o) =>
      o.size.y <= doc.space.door.w &&
      o.size.z <= doc.space.door.h &&
      o.size.z <= H &&
      o.size.y <= doc.space.inner.w,
  );
}

/** Por que um palete não entra, independentemente do espaço livre. */
export function palletBlocker(
  doc: LoadDoc,
  pallet: PalletDoc,
): StopReason | null {
  if (palletOrientations(doc, pallet).length) return null;
  const e = palletEnvelope(pallet).size;
  return e.z > heightLimit(doc) ? "height" : "door";
}

function bestSpot(
  doc: LoadDoc,
  pallet: PalletDoc,
  obstacles: Obstacle[],
  allowStacking: boolean,
) {
  const H = heightLimit(doc);
  const lo = { x: 0, y: 0, z: 0 };
  const hi = { x: doc.space.inner.l, y: doc.space.inner.w, z: H };
  const minSupportPct = effectiveLimits(doc).thresholds.minSupportPct;
  let best: { pos: Vec3; yaw: boolean; size: Vec3 } | null = null;
  for (const o of palletOrientations(doc, pallet)) {
    const pos = findFreePosition(obstacles, o.size, {
      lo,
      hi,
      allowStacking,
      minSupportPct,
    });
    if (!pos) continue;
    // piso primeiro; depois a que termina mais perto do fundo; empate: a que começa antes (encostada
    // no palete de trás, sem vão — paletes travados entre si); depois a mais à esquerda
    const key = (p: Vec3, s: Vec3) => [p.z, p.x + s.x, p.x, p.y];
    if (!best) best = { pos, ...o };
    else {
      const a = key(pos, o.size),
        b = key(best.pos, best.size);
      const k = a.findIndex((v, i) => v !== b[i]);
      if (k >= 0 && a[k] < b[k]) best = { pos, ...o };
    }
  }
  return best;
}

/** Coloca até `count` paletes (ou o máximo possível, se count = null) de uma montagem. */
/** Primeiro encaixe (fundo → porta), escolhendo a melhor orientação a cada palete. */
export function placePalletsGreedy(
  doc0: LoadDoc,
  key: string,
  pallet: PalletDoc,
  count: number | null,
  opts: PlaceOptions = {},
): PlaceResult {
  let doc: LoadDoc = doc0.pallets[key]
    ? doc0
    : { ...doc0, pallets: { ...doc0.pallets, [key]: pallet } };
  const p = doc.pallets[key];
  const blocker = palletBlocker(doc, p);
  if (blocker)
    return {
      doc: doc0,
      placed: 0,
      requested: count,
      stopReason: blocker,
      unitIds: [],
    };
  const limit = effectiveLimits(doc).payloadKg.value;
  const kg = palletSummary(p).grossKg;
  let payload = loadSummary(doc).payloadKg;
  const obstacles = obstaclesOf(doc);
  const units = [...doc.units];
  const ids: string[] = [];
  let stop: StopReason = "done";
  const max = count ?? 10000;
  while (ids.length < max) {
    if (limit != null && payload + kg > limit + 1e-6) {
      stop = "payload";
      break;
    }
    const spot = bestSpot(doc, p, obstacles, Boolean(opts.allowStacking));
    if (!spot) {
      stop = "no_space";
      break;
    }
    const id = nextId(opts.idPrefix ?? "a");
    units.push({
      id,
      kind: "PALLET",
      palletKey: key,
      pos: spot.pos,
      yaw: spot.yaw,
      locked: false,
    });
    obstacles.push({
      box: { min: spot.pos, size: spot.size } as AABB,
      stackable: stackable(p.stackable),
    });
    payload += kg;
    ids.push(id);
  }
  doc = { ...doc, units };
  if (!ids.length && !doc0.pallets[key]) doc = doc0; // nada colocado: não deixa snapshot órfão
  // 'done' = colocou tudo o que foi pedido; senão, o que impediu (espaço ou payload)
  return {
    doc,
    placed: ids.length,
    requested: count,
    stopReason: ids.length === max ? "done" : stop,
    unitIds: ids,
  };
}

/** Máximo de paletes de uma montagem que ainda cabem (simulação, não altera o documento). */
export function maxAdditional(
  doc: LoadDoc,
  key: string,
  pallet: PalletDoc,
  opts: PlaceOptions = {},
): { max: number; limitedBy: StopReason } {
  const r = placePallets(doc, key, pallet, null, opts);
  return { max: r.placed, limitedBy: r.stopReason };
}

export interface MixItem {
  key: string;
  pallet: PalletDoc;
  /** fração do total de paletes (0–1); soma das frações = 1 */
  share: number;
}

/** Divide `total` em inteiros proporcionais às frações (maiores restos). */
export function apportion(total: number, shares: number[]): number[] {
  const sum = shares.reduce((a, b) => a + b, 0) || 1;
  const raw = shares.map((s) => (s / sum) * total);
  const base = raw.map(Math.floor);
  let rest = total - base.reduce((a, b) => a + b, 0);
  const order = raw
    .map((r, i) => ({ i, f: r - Math.floor(r) }))
    .sort((a, b) => b.f - a.f || a.i - b.i);
  for (const o of order) {
    if (rest <= 0) break;
    base[o.i]++;
    rest--;
  }
  return base;
}

const footprint = (p: PalletDoc) => {
  const e = palletEnvelope(p).size;
  return e.x * e.y;
};

/**
 * Mistura por percentual de PALETES: maior total N tal que todos os N (repartidos pelas frações)
 * cabem fisicamente e respeitam o payload. Paletes maiores são colocados primeiro.
 */
export function composeMix(
  doc: LoadDoc,
  items: MixItem[],
  opts: PlaceOptions = {},
): { doc: LoadDoc; counts: number[]; total: number; limitedBy: StopReason } {
  if (!items.length) return { doc, counts: [], total: 0, limitedBy: "done" };
  const upper = Math.max(
    ...items.map((it) => maxAdditional(doc, it.key, it.pallet, opts).max),
  );
  // maiores primeiro; com a mesma base, os mais PESADOS primeiro (ficam no piso; os leves vão por cima)
  const order = items
    .map((it, i) => ({ it, i }))
    .sort(
      (a, b) =>
        footprint(b.it.pallet) - footprint(a.it.pallet) ||
        palletSummary(b.it.pallet).grossKg -
          palletSummary(a.it.pallet).grossKg ||
        a.i - b.i,
    );
  let lastReason: StopReason = "no_space";
  for (let N = upper; N > 0; N--) {
    const counts = apportion(
      N,
      items.map((x) => x.share),
    );
    let d = doc;
    let ok = true;
    for (const { it, i } of order) {
      if (!counts[i]) continue;
      const r = placePallets(d, it.key, it.pallet, counts[i], opts);
      d = r.doc;
      if (r.placed < counts[i]) {
        ok = false;
        lastReason = r.stopReason;
        break;
      }
    }
    if (ok)
      return {
        doc: d,
        counts,
        total: N,
        limitedBy: N === upper ? "no_space" : lastReason,
      };
  }
  return { doc, counts: items.map(() => 0), total: 0, limitedBy: lastReason };
}

/** Remove unidades que satisfazem o filtro: `last` = as últimas adicionadas; `door` = as mais próximas da porta. */
export function removeUnits(
  doc: LoadDoc,
  match: (u: LoadUnit) => boolean,
  quantity: number | null,
  which: "last" | "door" = "last",
): { doc: LoadDoc; removed: LoadUnit[] } {
  const candidates = doc.units
    .map((u, i) => ({ u, i }))
    .filter((x) => match(x.u) && !x.u.locked);
  if (which === "door") {
    const geo = new Map(loadGeometries(doc).map((g) => [g.unit.id, g.box]));
    candidates.sort(
      (a, b) =>
        (geo.get(b.u.id)?.min.x ?? 0) - (geo.get(a.u.id)?.min.x ?? 0) ||
        b.i - a.i,
    );
  } else candidates.sort((a, b) => b.i - a.i);
  const pick = new Set(
    candidates.slice(0, quantity ?? candidates.length).map((x) => x.u.id),
  );
  const removed = doc.units.filter((u) => pick.has(u.id));
  const units = doc.units.filter((u) => !pick.has(u.id));
  // limpa snapshots sem uso
  const usedP = new Set(
    units.flatMap((u) => (u.kind === "PALLET" ? [u.palletKey] : [])),
  );
  const usedK = new Set(
    units.flatMap((u) => (u.kind === "PACKAGE" ? [u.packId] : [])),
  );
  return {
    doc: {
      ...doc,
      units,
      pallets: Object.fromEntries(
        Object.entries(doc.pallets).filter(([k]) => usedP.has(k)),
      ),
      packs: Object.fromEntries(
        Object.entries(doc.packs).filter(([k]) => usedK.has(k)),
      ),
    },
    removed,
  };
}

/**
 * Reposiciona todas as unidades de palete do zero (ex.: após trocar o equipamento ou para compactar).
 * Unidades travadas e volumes soltos ficam onde estão. Retorna as que não couberam.
 */
export function repack(
  doc: LoadDoc,
  opts: PlaceOptions = {},
): { doc: LoadDoc; unplaced: { palletKey: string; count: number }[] } {
  const fixed = doc.units.filter((u) => u.locked || u.kind !== "PALLET");
  const movable = doc.units.filter(
    (u): u is Extract<LoadUnit, { kind: "PALLET" }> =>
      !u.locked && u.kind === "PALLET",
  );
  const byKey = new Map<string, number>();
  for (const u of movable)
    byKey.set(u.palletKey, (byKey.get(u.palletKey) ?? 0) + 1);
  const keys = [...byKey.keys()].sort(
    (a, b) =>
      footprint(doc.pallets[b]) - footprint(doc.pallets[a]) ||
      palletSummary(doc.pallets[b]).grossKg -
        palletSummary(doc.pallets[a]).grossKg,
  );
  let d: LoadDoc = { ...doc, units: fixed };
  const unplaced: { palletKey: string; count: number }[] = [];
  for (const k of keys) {
    const want = byKey.get(k)!;
    const r = placePallets(d, k, doc.pallets[k], want, opts);
    d = r.doc;
    if (r.placed < want)
      unplaced.push({ palletKey: k, count: want - r.placed });
  }
  return { doc: d, unplaced };
}

// ---------------------------------------------------------------------------
// Caixas soltas (no piso ou por cima de paletes já carregados)
// ---------------------------------------------------------------------------

/** Superfícies físicas para apoiar CAIXAS: caixas do topo dos paletes, tabuleiros vazios e caixas soltas. */
export function boxObstacles(doc: LoadDoc): Obstacle[] {
  const probe = { role: "box" } as Parameters<typeof canSupport>[1];
  return loadBodies(doc).map((b) => ({
    box: b.box,
    stackable: canSupport(b, probe),
  }));
}

export interface LooseBoxResult extends PlaceResult {
  /** orientação usada em cada caixa colocada */
  orientations: Orientation[];
}

/**
 * Coloca até `count` caixas soltas (ou o máximo, se null), preferindo o PISO e depois o TOPO
 * dos paletes, testando as orientações permitidas do produto. Respeita altura útil, porta,
 * payload efetivo e empilhabilidade (validação completa continua em validateLoad).
 */
export function placeLooseBoxes(
  doc0: LoadDoc,
  packId: string,
  pack: PackSnapshot,
  count: number | null,
  opts: {
    orientations?: Orientation[];
    idPrefix?: string;
    onTopOnly?: boolean;
    /** só no piso (nunca por cima de paletes/caixas) */
    floorOnly?: boolean;
  } = {},
): LooseBoxResult {
  let doc: LoadDoc = doc0.packs[packId]
    ? doc0
    : { ...doc0, packs: { ...doc0.packs, [packId]: pack } };
  const H = heightLimit(doc);
  const lo = { x: 0, y: 0, z: 0 };
  const hi = { x: doc.space.inner.l, y: doc.space.inner.w, z: H };
  const minSupportPct = effectiveLimits(doc).thresholds.minSupportPct;
  const limit = effectiveLimits(doc).payloadKg.value;
  let payload = loadSummary(doc).payloadKg;
  // orientação: a pedida; senão a NATURAL (menor altura, maior apoio — domain/orientation), e as demais
  // permitidas só se a natural não couber em lugar nenhum
  const orients = opts.orientations?.length
    ? opts.orientations.filter((o) => pack.allowedOrientations.includes(o))
    : naturalOrientations(pack.dims, pack.allowedOrientations);
  const natural = opts.orientations?.length
    ? null
    : new Set(autoOrientations(pack.dims, pack.allowedOrientations));
  const fits = orients.filter((o) => {
    const s = orientDims(pack.dims, o);
    return s.y <= doc.space.door.w && s.z <= doc.space.door.h && s.z <= H;
  });
  if (!fits.length)
    return {
      doc: doc0,
      placed: 0,
      requested: count,
      stopReason: "door",
      unitIds: [],
      orientations: [],
    };
  const obstacles = boxObstacles(doc);
  const units = [...doc.units];
  const ids: string[] = [];
  const used: Orientation[] = [];
  let stop: StopReason = "done";
  const max = count ?? 10000;
  while (ids.length < max) {
    if (limit != null && payload + pack.grossKg > limit + 1e-6) {
      stop = "payload";
      break;
    }
    let best: { pos: Vec3; o: Orientation; size: Vec3 } | null = null;
    const tiers = natural
      ? [
          fits.filter((o) => natural.has(o)),
          fits.filter((o) => !natural.has(o)),
        ]
      : [fits];
    for (const tier of tiers) {
      if (best) break;
      for (const o of tier) {
        const size = orientDims(pack.dims, o);
        const pos = findFreePosition(obstacles, size, {
          lo,
          hi,
          allowStacking: true,
          minSupportPct,
        });
        if (!pos || (opts.onTopOnly && pos.z === 0) || (opts.floorOnly && pos.z > 0)) continue;
        // piso antes de empilhar; depois mais ao fundo; depois mais à esquerda
        const k = (p: Vec3, s: Vec3) => [p.z, p.x + s.x, p.y];
        if (!best) best = { pos, o, size };
        else {
          const a = k(pos, size),
            b = k(best.pos, best.size);
          if (
            a[0] < b[0] ||
            (a[0] === b[0] && (a[1] < b[1] || (a[1] === b[1] && a[2] < b[2])))
          )
            best = { pos, o, size };
        }
      }
    }
    if (!best) {
      stop = "no_space";
      break;
    }
    const id = nextId(opts.idPrefix ?? "b");
    units.push({
      id,
      kind: "PACKAGE",
      packId,
      pos: best.pos,
      orientation: best.o,
      locked: false,
    });
    obstacles.push({
      box: { min: best.pos, size: best.size },
      stackable: stackable(pack.stackable),
    });
    payload += pack.grossKg;
    ids.push(id);
    used.push(best.o);
  }
  doc = ids.length ? { ...doc, units } : doc0;
  return {
    doc,
    placed: ids.length,
    requested: count,
    stopReason: ids.length === max ? "done" : stop,
    unitIds: ids,
    orientations: used,
  };
}

// ---------------------------------------------------------------------------
// Padrões de piso: o motor avalia alternativas e escolhe a melhor
// ---------------------------------------------------------------------------

interface Slot {
  pos: Vec3;
  yaw: boolean;
  size: Vec3;
}

/**
 * Padrão INTERCALADO em duas faixas: cada faixa alterna as orientações (A-B-A-B…) e a faixa vizinha
 * começa pela outra (B-A-B-A…). Faixa 1 encostada na parede esquerda, faixa 2 na direita.
 * Retorna null se o palete não admite as duas orientações ou se as faixas não cabem lado a lado.
 */
export function interlacedSlots(
  doc: LoadDoc,
  pallet: PalletDoc,
  startWithYaw: boolean,
): Slot[] | null {
  const oris = palletOrientations(doc, pallet);
  const A = oris.find((o) => !o.yaw),
    B = oris.find((o) => o.yaw);
  if (!A || !B) return null;
  if (A.size.x === B.size.x && A.size.y === B.size.y) return null; // quadrado: intercalar não muda nada
  const W = doc.space.inner.w,
    L = doc.space.inner.l;
  const lanes: Slot[][] = [[], []];
  for (let lane = 0; lane < 2; lane++) {
    let useYaw = lane === 0 ? startWithYaw : !startWithYaw;
    let x = 0;
    for (;;) {
      const pref = useYaw ? B : A;
      const alt = useYaw ? A : B;
      const pick = [pref, alt].find((o) => x + o.size.x <= L);
      if (!pick) break;
      const y = lane === 0 ? 0 : W - pick.size.y;
      if (y < 0) return null;
      lanes[lane].push({ pos: { x, y, z: 0 }, yaw: pick.yaw, size: pick.size });
      x += pick.size.x;
      useYaw = !pick.yaw;
    }
  }
  // as faixas não podem invadir uma à outra: descarta da faixa 2 as posições em conflito (normalmente só no fim)
  const overlaps = (a: Slot, b: Slot) =>
    Math.min(a.pos.x + a.size.x, b.pos.x + b.size.x) -
      Math.max(a.pos.x, b.pos.x) >
      0 &&
    Math.min(a.pos.y + a.size.y, b.pos.y + b.size.y) -
      Math.max(a.pos.y, b.pos.y) >
      0;
  const lane2 = lanes[1].filter((b) => !lanes[0].some((a) => overlaps(a, b)));
  // se o conflito for no meio (não só no fim), o padrão não serve
  if (lanes[1].length - lane2.length > 1) return null;
  const all = [...lanes[0], ...lane2];
  return all.sort((p, q) => p.pos.x - q.pos.x || p.pos.y - q.pos.y);
}

function buildFromSlots(
  doc0: LoadDoc,
  key: string,
  pallet: PalletDoc,
  slots: Slot[],
  count: number | null,
  opts: PlaceOptions,
): PlaceResult {
  const doc: LoadDoc = doc0.pallets[key]
    ? doc0
    : { ...doc0, pallets: { ...doc0.pallets, [key]: pallet } };
  const limit = effectiveLimits(doc).payloadKg.value;
  const kg = palletSummary(pallet).grossKg;
  let payload = loadSummary(doc).payloadKg;
  const max = count ?? 10000;
  const units = [...doc.units];
  const ids: string[] = [];
  let stop: StopReason = "no_space";
  for (const s of slots) {
    if (ids.length >= max) break;
    if (limit != null && payload + kg > limit + 1e-6) {
      stop = "payload";
      break;
    }
    const id = nextId(opts.idPrefix ?? "a");
    units.push({
      id,
      kind: "PALLET",
      palletKey: key,
      pos: s.pos,
      yaw: s.yaw,
      locked: false,
    });
    payload += kg;
    ids.push(id);
  }
  return {
    doc: { ...doc, units },
    placed: ids.length,
    requested: count,
    stopReason: ids.length === max ? "done" : stop,
    unitIds: ids,
  };
}

export type FloorPattern = "primeiro-encaixe" | "intercalado";

/**
 * Coloca até `count` paletes (ou o máximo, se null). Com o piso vazio, avalia padrões alternativos
 * (primeiro encaixe e intercalado A-B / B-A) e escolhe: mais paletes → melhor equilíbrio lateral
 * → menor comprimento usado. Com carga existente, usa primeiro encaixe a partir do que já está lá.
 */
export function placePallets(
  doc0: LoadDoc,
  key: string,
  pallet: PalletDoc,
  count: number | null,
  opts: PlaceOptions = {},
): PlaceResult {
  // Objetivo: o máximo de produto (kg). Primeiro o PISO (melhor padrão), depois EMPILHA sobre o que já
  // está carregado, até acabar a altura útil, o espaço ou o payload. allowStacking=false só usa o piso.
  const floor = placeOnFloor(doc0, key, pallet, count, opts);
  const stack = opts.allowStacking ?? ALWAYS_STACKABLE;
  const missing = count == null ? null : count - floor.placed;
  if (
    !stack ||
    missing === 0 ||
    floor.stopReason === "payload" ||
    floor.stopReason === "door" ||
    floor.stopReason === "height"
  )
    return floor;
  const up = placePalletsGreedy(floor.doc, key, pallet, missing, {
    ...opts,
    allowStacking: true,
  });
  return {
    doc: up.doc,
    placed: floor.placed + up.placed,
    requested: count,
    stopReason: up.stopReason,
    unitIds: [...floor.unitIds, ...up.unitIds],
    pattern: floor.pattern,
  };
}

/** Só no piso: com o piso vazio avalia os padrões (primeiro encaixe × intercalado); senão, primeiro encaixe. */
function placeOnFloor(
  doc0: LoadDoc,
  key: string,
  pallet: PalletDoc,
  count: number | null,
  opts: PlaceOptions,
): PlaceResult {
  opts = { ...opts, allowStacking: false };
  const greedy = {
    ...placePalletsGreedy(doc0, key, pallet, count, opts),
    pattern: "primeiro-encaixe" as FloorPattern,
  };
  if (
    doc0.units.length > 0 ||
    greedy.stopReason === "door" ||
    greedy.stopReason === "height"
  )
    return greedy;
  const p = doc0.pallets[key] ?? pallet;
  const cands: { r: PlaceResult; name: FloorPattern }[] = [
    { r: greedy, name: "primeiro-encaixe" },
  ];
  for (const start of [false, true]) {
    const slots = interlacedSlots(doc0, p, start);
    if (slots)
      cands.push({
        r: buildFromSlots(doc0, key, p, slots, count, opts),
        name: "intercalado",
      });
  }
  const score = (r: PlaceResult) => {
    const s = loadSummary(r.doc);
    return {
      n: r.placed,
      lat: Math.abs(s.cgLatDevPct ?? 0),
      len: s.usedLengthMm,
    };
  };
  let best = cands[0];
  let bs = score(best.r);
  for (const c of cands.slice(1)) {
    const cs = score(c.r);
    const better =
      cs.n > bs.n ||
      (cs.n === bs.n &&
        (cs.lat < bs.lat - 0.05 ||
          (Math.abs(cs.lat - bs.lat) <= 0.05 && cs.len < bs.len)));
    if (better) {
      best = c;
      bs = cs;
    }
  }
  return { ...best.r, pattern: best.name };
}
