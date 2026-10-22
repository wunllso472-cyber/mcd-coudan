// 把 query-meals / query-meal-detail / list-nutrition-foods 的原始数据整理成可优化的「餐品画像」
// 画像：一份餐品能满足几个人的 主食(m)/小食(s)/饮料(d)，估算热量，口味标签，以及不靠随单购卡的真实单价

const IGNORE = /玩具|周边|帽|丝巾|星愿贴|痒痒挠|徽章|钥匙扣|麦金卡|早餐卡/;
const DRINK = /可乐|雪碧|芬达|红茶|奶茶|柠檬茶|咖啡|奶铁|美式|拿铁|卡布奇诺|浓缩|奶昔|果汁|苹果汁|橙橙|柠柠|牛奶|纯悦|怡泉|麦炫酷|黑巧|燕麦奶|豆浆|矿泉水|饮/;
const MAIN = /堡|巨无霸|麦香鸡|麦香鱼|麦满分|卷|饭|三明治|帕尼尼|汉堡包/;
const CONDIMENT = /酱$/;

export const TAG_RULES = {
  beef: /牛|巨无霸|吉士汉堡|安格斯|不素之霸|汉堡包/,
  pork: /猪|培根|烟肉|火腿/,
  fish: /鱼|鳕/,
  spicy: /辣|龙焰/,
  coffee: /咖啡|奶铁|美式|拿铁|卡布奇诺|浓缩|阿芙佳朵/,
};

// 查不到营养数据时按角色估一个热量，宁可保守
const DEFAULT_KCAL = { m: 450, s: 250, d: 140 };
// 新品/联名款常查不到营养数据，按品类映射到基础款
const KCAL_ALIASES = [[/圆筒/, '圆筒冰淇淋'], [/麦旋风/, '奥利奥麦旋风'], [/新地/, '朱古力新地']];

export function classify(name) {
  if (IGNORE.test(name)) return null;
  if (CONDIMENT.test(name) && !name.includes('+')) return null;
  if (DRINK.test(name) && !/麦旋风|新地|派/.test(name)) return 'd';
  if (MAIN.test(name)) return 'm';
  return 's';
}

const norm = (s) => s.replace(/[\s（）()【】“”"'·\-—™+]/g, '').replace(/(中杯|大杯|小杯|一袋\d+g|\d+g)/g, '');

// list-nutrition-foods 的 data 是一段紧凑表格：首行字段，之后每行一条，逗号分隔
export function parseNutrition(data) {
  const table = new Map();
  if (typeof data !== 'string') return table;
  const lines = data.split('\n');
  const header = lines[0].match(/\{(.+)\}/)?.[1].split(',') ?? [];
  const nameIdx = header.indexOf('productName');
  const kcalIdx = header.indexOf('energyKcal');
  for (const line of lines.slice(1)) {
    const cols = line.trim().split(',');
    if (cols.length < header.length) continue;
    const kcal = Number(cols[kcalIdx]);
    if (Number.isFinite(kcal)) table.set(norm(cols[nameIdx]), kcal);
  }
  return table;
}

export function lookupKcal(nutrition, name, role) {
  const key = norm(name);
  if (nutrition.has(key)) return nutrition.get(key);
  let best = null;
  for (const [k, v] of nutrition) {
    if ((key.includes(k) || k.includes(key)) && (!best || k.length > best[0].length)) best = [k, v];
  }
  if (best) return best[1];
  const alias = KCAL_ALIASES.find(([re]) => re.test(name));
  if (alias && nutrition.has(norm(alias[1]))) return nutrition.get(norm(alias[1]));
  return DEFAULT_KCAL[role];
}

const yuanToFen = (s) => Math.round(Number(s) * 100);

// 随单购优惠价要另买麦金卡/早餐卡才有，凑单默认不买卡，所以按原价计
export function effectivePriceFen(meal) {
  const current = yuanToFen(meal.currentPrice);
  const original = yuanToFen(meal.originalPrice ?? meal.currentPrice);
  if (meal.discountType && meal.discountType.includes('随单购')) return original;
  return current;
}

// 套餐：按每轮默认选项计；单品：按名称计
export function buildProfile(code, meal, detail, nutrition) {
  const parts = [];
  if (detail?.rounds?.length) {
    for (const round of detail.rounds) {
      const choice = round.choices?.find((c) => c.isDefault === 1) ?? round.choices?.[0];
      const name = choice?.name ?? round.name;
      const role = classify(name);
      if (role) parts.push({ name, role, qty: round.quantity || 1 });
    }
    // 麦乐鸡套餐这类没有汉堡的套餐，把第一份小食当主食
    if (!parts.some((p) => p.role === 'm') && parts.some((p) => p.role === 'd')) {
      const first = parts.find((p) => p.role === 's');
      if (first) first.role = 'm';
    }
  } else {
    const role = classify(meal.name);
    if (role) parts.push({ name: meal.name, role, qty: 1 });
  }
  if (!parts.length) return null;

  const count = { m: 0, s: 0, d: 0 };
  let kcal = 0;
  for (const p of parts) {
    count[p.role] += p.qty;
    kcal += lookupKcal(nutrition, p.name, p.role) * p.qty;
  }
  const text = [meal.name, ...parts.map((p) => p.name)].join(' ');
  const tags = Object.keys(TAG_RULES).filter((t) => TAG_RULES[t].test(text));
  const price = effectivePriceFen(meal);
  const original = Math.max(price, yuanToFen(meal.originalPrice ?? meal.currentPrice));
  return {
    code,
    name: meal.name,
    price,
    saving: original - price,
    kcal: Math.round(kcal),
    ...count,
    tags,
    parts: parts.map((p) => (p.qty > 1 ? `${p.name}×${p.qty}` : p.name)),
  };
}

// 按用户口味过滤：avoid 是标签名列表（beef/pork/fish/spicy/coffee），exclude 是关键词列表
export function filterProfiles(profiles, { avoid = [], exclude = [] } = {}) {
  return profiles.filter((p) => {
    if (avoid.some((t) => p.tags.includes(t))) return false;
    const text = [p.name, ...p.parts].join(' ');
    return !exclude.some((kw) => kw && text.includes(kw));
  });
}

export function needsSubDetail(code) {
  return code.startsWith('99');
}
