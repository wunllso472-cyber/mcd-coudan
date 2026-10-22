// 编排麦当劳 MCP 调用：选门店 → 拉菜单与套餐组成 → 查券 → 优化 → 用 calculate-price 校验到手价
import { mkdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildProfile, filterProfiles, needsSubDetail, parseNutrition } from './catalog.js';
import { optimize, pickPlans, STRATEGIES } from './optimizer.js';

const CACHE_DIR = join(tmpdir(), 'mcd-coudan-cache');

// 从工具返回里取业务数据，success=false 时抛出服务端给的原因
function payload(res, tool) {
  const body = res.data;
  if (body && body.success === false) throw new Error(`${tool}：${body.message || '请求失败'}`);
  return body?.data ?? body;
}

async function call(client, tool, args) {
  return payload(await client.callTool(tool, args), tool);
}

async function mapLimit(list, limit, fn) {
  const out = new Array(list.length);
  let next = 0;
  const workers = Array.from({ length: Math.min(limit, list.length) }, async () => {
    while (next < list.length) {
      const i = next++;
      out[i] = await fn(list[i], i);
    }
  });
  await Promise.all(workers);
  return out;
}

// 场景参数：到店自取 / 麦乐送
export function sceneArgs(store) {
  const args = { storeCode: store.storeCode, orderType: store.orderType, beType: store.beType };
  if (store.beCode) args.beCode = store.beCode;
  return args;
}

export async function findPickupStores(client, { city, near }) {
  const list = await call(client, 'query-nearby-stores', near
    ? { beType: 1, searchType: 2, city, keyword: near }
    : { beType: 1, searchType: 1 });
  return (list || []).map((s) => ({ ...s, orderType: 1, beType: 1, beCode: undefined }));
}

export async function findDeliveryStore(client, { addressId } = {}) {
  const addrs = await call(client, 'delivery-query-addresses', {});
  const list = Array.isArray(addrs) ? addrs : addrs?.addresses ?? addrs?.list ?? [];
  if (!list.length) throw new Error('账户里还没有配送地址，请先在麦当劳 App 或通过 delivery-create-address 添加');
  const addr = addressId ? list.find((a) => String(a.addressId) === String(addressId)) : list[0];
  if (!addr) throw new Error(`没有找到配送地址 ${addressId}`);
  const stores = await call(client, 'delivery-query-stores', { addressId: String(addr.addressId), beType: 2 });
  const list2 = Array.isArray(stores) ? stores : stores?.stores ?? [];
  const store = list2.find((s) => s.businessStatus !== false) ?? list2[0];
  if (!store) throw new Error('这个地址附近暂时没有可配送的门店');
  return { ...store, orderType: 2, beType: 2, addressId: String(addr.addressId), addressText: addr.fullAddress ?? [addr.address, addr.addressDetail].filter(Boolean).join(' ') };
}

// 按参数选门店：外送 / 指定门店编号 / 城市+地点搜最近的营业门店
export async function resolveStore(client, { delivery, store, city, near, addressId } = {}) {
  if (delivery) return findDeliveryStore(client, { addressId });
  if (store) return { storeCode: store, storeName: `门店 ${store}`, orderType: 1, beType: 1 };
  if (!city || !near) throw new Error('到店自取需要城市和附近地点（或门店编号）；也可以改成外送');
  const stores = await findPickupStores(client, { city, near });
  const open = stores.filter((s) => s.businessStatus !== false);
  if (!open.length) throw new Error(`${city}${near} 附近没有找到营业中的门店`);
  return open[0];
}

// 中文忌口转成 catalog 里的标签名
export const AVOID_ALIASES = { 牛肉: 'beef', 猪肉: 'pork', 鱼: 'fish', 辣: 'spicy', 咖啡: 'coffee' };
export const normalizeAvoid = (list) => list.map((a) => AVOID_ALIASES[a] ?? a);

// 按方案创建订单。takeWay 可传取餐方式编码或名称（如「外带」），不传用第一个
export async function placeOrder(client, store, plan, { takeWay, remark } = {}) {
  const args = { ...sceneArgs(store), items: plan.orderItems };
  if (store.orderType === 1) {
    const ways = plan.takeWays;
    const way = takeWay ? ways.find((w) => w.code === takeWay || w.title?.includes(takeWay)) : ways[0];
    if (!way) throw new Error(`取餐方式只能是：${ways.map((w) => `${w.code}(${w.title})`).join('、')}`);
    args.takeWayCode = way.code;
  } else {
    args.addressId = store.addressId;
    if (remark) args.remark = remark.slice(0, 50);
  }
  const res = await client.callTool('create-order', args);
  if (res.data?.success === false) throw new Error(`下单失败：${res.data.message}`);
  return res;
}

// 套餐详情量大且一天内基本不变，按「门店+场景+日期」缓存到系统临时目录
async function loadDetails(client, store, codes, log) {
  mkdirSync(CACHE_DIR, { recursive: true });
  const day = new Date().toISOString().slice(0, 10);
  const file = join(CACHE_DIR, `${store.storeCode}-${store.beType}-${day}.json`);
  const cache = existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) : {};
  const missing = codes.filter((c) => !(c in cache));
  if (missing.length) log(`正在读取 ${missing.length} 个套餐的组成…`);
  await mapLimit(missing, 6, async (code) => {
    try {
      cache[code] = await call(client, 'query-meal-detail', { ...sceneArgs(store), code });
    } catch {
      cache[code] = null; // 个别餐品详情查不到时按单品处理
    }
  });
  if (missing.length) writeFileSync(file, JSON.stringify(cache));
  return cache;
}

// 门店可用券：每张券的到手价要靠 calculate-price 带券试算才能知道
async function couponCandidates(client, store, profiles, log) {
  const coupons = await call(client, 'query-store-coupons', sceneArgs(store)).catch(() => []);
  if (!Array.isArray(coupons) || !coupons.length) return [];
  const groups = new Map();
  for (const c of coupons) {
    const g = groups.get(c.couponId) ?? { couponId: c.couponId, title: c.title, codes: [], products: c.products || [] };
    g.codes.push(c.couponCode);
    groups.set(c.couponId, g);
  }
  log(`门店有 ${groups.size} 种可用券，正在试算券后价…`);
  const byCode = new Map(profiles.map((p) => [p.code, p]));
  const out = [];
  for (const g of groups.values()) {
    for (const prod of g.products) {
      const base = byCode.get(prod.productCode);
      if (!base) continue;
      try {
        const priced = await call(client, 'calculate-price', {
          ...sceneArgs(store),
          items: [{ productCode: base.code, quantity: 1, couponId: g.couponId, couponCode: g.codes[0] }],
        });
        const price = priced.productPrice ?? priced.price;
        if (price < base.price) {
          out.push({ ...base, id: `${base.code}@${g.couponId}`, price, saving: base.saving + base.price - price, cap: g.codes.length, coupon: g });
        }
      } catch { /* 这张券在当前组合下不可用，跳过 */ }
    }
  }
  return out;
}

// 把方案里的餐品展开成 calculate-price / create-order 需要的 items，券码逐张分配
export function toOrderItems(plan) {
  const items = [];
  for (const { cand, qty } of plan.items) {
    if (cand.coupon) {
      for (let i = 0; i < qty; i++) items.push({ productCode: cand.code, quantity: 1, couponId: cand.coupon.couponId, couponCode: cand.coupon.codes[i] });
    } else {
      items.push({ productCode: cand.code, quantity: qty });
    }
  }
  return items;
}

export async function makePlans(client, opts, log = () => {}) {
  const { store, people, budget, side = true, drink = true, avoid = [], exclude = [], variety = false } = opts;
  const need = { m: people, s: side ? people : 0, d: drink ? people : 0 };

  log(`正在读取 ${store.storeName} 的菜单…`);
  const menu = await call(client, 'query-meals', sceneArgs(store));
  const meals = menu?.meals || {};
  const codes = Object.keys(meals);
  const [details, nutritionRaw] = await Promise.all([
    loadDetails(client, store, codes.filter(needsSubDetail), log),
    call(client, 'list-nutrition-foods', {}).catch(() => ''),
  ]);
  const nutrition = parseNutrition(nutritionRaw);

  const profiles = codes.map((code) => buildProfile(code, meals[code], details[code], nutrition)).filter(Boolean);
  const allowed = filterProfiles(profiles, { avoid, exclude });
  const sameCap = variety ? Math.max(1, Math.ceil(people / 2)) : people;
  const candidates = allowed.map((p) => ({ ...p, id: p.code, cap: sameCap }));
  candidates.push(...await couponCandidates(client, store, allowed, log));
  log(`可选餐品 ${candidates.length} 个，正在搜索最划算的组合…`);

  const budgetFen = budget ? Math.round(budget * 100) : Infinity;
  const solutions = optimize(candidates, need, { budget: budgetFen });
  const picks = pickPlans(solutions, { budget: budgetFen });
  if (!picks.length) return { store, need, budget, plans: [], candidates: candidates.length };

  log(`正在用 calculate-price 校验 ${picks.length} 个方案的到手价…`);
  const verified = await mapLimit(picks, 3, async (pick) => {
    const items = toOrderItems(pick.plan);
    try {
      const priced = await call(client, 'calculate-price', { ...sceneArgs(store), items });
      // 「省了多少」按单点原价算：套餐价本身已含优惠，calculate-price 的 discount 只反映额外促销
      const menuOriginal = pick.plan.price + pick.plan.saving;
      const productPrice = priced.productPrice ?? priced.price;
      return { ...pick, items, priced, price: priced.price, kcal: pick.plan.kcal, saving: Math.max(0, menuOriginal - productPrice) };
    } catch (err) {
      return { ...pick, items, error: err.message };
    }
  });

  // 校验后按真实到手价重新排序，每种策略选出一个，不重复
  const ok = verified.filter((v) => v.priced && v.price <= budgetFen);
  const final = [];
  const seen = new Set();
  for (const [strategy, { label, sort }] of Object.entries(STRATEGIES)) {
    const best = ok.filter((v) => !seen.has(v.plan.key)).sort(sort)[0];
    if (!best) continue;
    seen.add(best.plan.key);
    final.push({ ...best, label, strategy });
  }

  return {
    store,
    need,
    budget,
    candidates: candidates.length,
    plans: final.map(formatPlan),
    rejected: verified.filter((v) => !v.priced).map((v) => ({ label: v.label, error: v.error })),
  };
}

function formatPlan(v) {
  const priced = v.priced;
  const lines = (priced.productList || []).map((p) => ({
    code: p.productCode,
    name: p.productName,
    quantity: p.quantity,
    subtotal: p.subtotal / 100,
    originalSubtotal: p.originalSubtotal / 100,
  }));
  const parts = new Map(v.plan.items.map(({ cand }) => [cand.code, { parts: cand.parts, coupon: cand.coupon?.title }]));
  // 外送时 productList 里会混入「打包服务费」等费用行，只展示方案里真正点的餐品
  const picked = lines.filter((l) => parts.has(l.code));
  return {
    label: v.label,
    strategy: v.strategy,
    price: priced.price / 100,
    originalPrice: priced.originalPrice / 100,
    discount: v.saving / 100,
    deliveryFee: (priced.deliveryPrice ?? 0) / 100,
    packingFee: (priced.packingPrice ?? 0) / 100,
    kcal: v.plan.kcal,
    lines: picked.map((l) => ({ ...l, ...parts.get(l.code) })),
    takeWays: priced.takeWayList || [],
    orderItems: v.items,
  };
}
