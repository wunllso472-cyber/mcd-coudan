// 凑单优化：在「每人一份主食/小食/饮料」的约束下，搜出价格、热量、优惠三个维度上的帕累托最优组合
// 状态 = 已满足的 (主食, 小食, 饮料) 份数；每个状态保留一组互不支配的方案（标签），按 0/1 背包逐件加入候选

const DIMENSIONS = ['m', 's', 'd'];

export function optimize(candidates, need, { budget = Infinity, maxLabels = 48 } = {}) {
  const size = DIMENSIONS.map((k) => need[k] + 1);
  const index = (st) => (st[0] * size[1] + st[1]) * size[2] + st[2];
  const decode = (i) => [Math.floor(i / (size[1] * size[2])), Math.floor(i / size[2]) % size[1], i % size[2]];
  const total = size[0] * size[1] * size[2];

  let states = Array.from({ length: total }, () => []);
  states[0].push({ price: 0, kcal: 0, saving: 0, pick: null, prev: null });

  for (const cand of candidates) {
    const cap = Math.max(1, Math.min(cand.cap ?? Infinity, need.m + need.s + need.d));
    for (let copy = 0; copy < cap; copy++) {
      const next = states.map((labels) => labels.slice());
      let useful = false;
      for (let i = 0; i < total; i++) {
        if (!states[i].length) continue;
        const st = decode(i);
        // 只允许加入能补上缺口的餐品，避免为了「吃饱」无限往单里塞东西
        if (!DIMENSIONS.some((k, j) => cand[k] > 0 && st[j] < need[k])) continue;
        const to = index(DIMENSIONS.map((k, j) => Math.min(need[k], st[j] + cand[k])));
        for (const label of states[i]) {
          const price = label.price + cand.price;
          if (price > budget) continue;
          next[to].push({ price, kcal: label.kcal + cand.kcal, saving: label.saving + cand.saving, pick: cand, prev: label });
          useful = true;
        }
      }
      if (!useful) break;
      states = next.map((labels) => prune(labels, maxLabels));
    }
  }

  return states[total - 1]
    .map((label) => ({ ...summarize(label), price: label.price, kcal: label.kcal, saving: label.saving }))
    .filter((sol) => isMinimal(sol.items, need));
}

// 去掉任意一件仍然够吃，就说明这件是多点的：结果里不要这种方案
function isMinimal(items, need) {
  const sum = (k) => items.reduce((acc, { cand, qty }) => acc + cand[k] * qty, 0);
  const have = Object.fromEntries(DIMENSIONS.map((k) => [k, sum(k)]));
  return items.every(({ cand }) => DIMENSIONS.some((k) => cand[k] > 0 && have[k] - cand[k] < need[k]));
}

function prune(labels, max) {
  if (labels.length <= 1) return labels;
  labels.sort((a, b) => a.price - b.price || b.kcal - a.kcal || b.saving - a.saving);
  const kept = [];
  for (const l of labels) {
    if (kept.some((k) => k.price <= l.price && k.kcal >= l.kcal && k.saving >= l.saving)) continue;
    kept.push(l);
  }
  if (kept.length <= max) return kept;
  // 太多时三个维度各留一部分，保证最省/最饱/最超值的候选都不会被挤掉
  const third = Math.ceil(max / 3);
  const pickTop = (cmp) => kept.slice().sort(cmp).slice(0, third);
  return [...new Set([
    ...pickTop((a, b) => a.price - b.price),
    ...pickTop((a, b) => b.kcal - a.kcal),
    ...pickTop((a, b) => b.saving - a.saving),
  ])];
}

function summarize(label) {
  const counts = new Map();
  for (let l = label; l.pick; l = l.prev) counts.set(l.pick, (counts.get(l.pick) || 0) + 1);
  const items = [...counts].map(([cand, qty]) => ({ cand, qty }));
  items.sort((a, b) => b.cand.price * b.qty - a.cand.price * a.qty);
  return { items, key: items.map((i) => `${i.cand.id}x${i.qty}`).sort().join('|') };
}

export const STRATEGIES = {
  cheapest: { label: '最省钱', sort: (a, b) => a.price - b.price || b.kcal - a.kcal },
  fullest: { label: '吃最饱', sort: (a, b) => b.kcal - a.kcal || a.price - b.price },
  // 「超值」看比单点省下的比例，而不是绝对金额，否则会偏向点得越多越好
  'best-deal': { label: '最超值', sort: (a, b) => savingRate(b) - savingRate(a) || a.price - b.price },
};

export const savingRate = (s) => s.saving / (s.price + s.saving || 1);

// 每种策略各取前 perStrategy 名作为候选；菜单价和到手价可能不同（促销限购等），校验后再定最终方案
export function pickPlans(solutions, { budget = Infinity, perStrategy = 3 } = {}) {
  const within = solutions.filter((s) => s.price <= budget);
  const seen = new Set();
  const picks = [];
  for (const [strategy, { label, sort }] of Object.entries(STRATEGIES)) {
    for (const plan of within.slice().sort(sort).slice(0, perStrategy)) {
      if (seen.has(plan.key)) continue;
      seen.add(plan.key);
      picks.push({ strategy, label, plan });
    }
  }
  return picks;
}
