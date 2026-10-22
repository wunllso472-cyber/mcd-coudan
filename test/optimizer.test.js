import { test } from 'node:test';
import assert from 'node:assert/strict';
import { optimize, pickPlans } from '../src/optimizer.js';
import { classify, parseNutrition, lookupKcal, effectivePriceFen, buildProfile, filterProfiles } from '../src/catalog.js';

const cand = (id, price, m, s, d, kcal = 500, saving = 0, extra = {}) => ({ id, code: id, name: id, price, m, s, d, kcal, saving, ...extra });

test('两个人优先选能覆盖全部需求的最便宜组合', () => {
  const cands = [
    cand('combo', 3000, 1, 1, 1, 900, 1000),
    cand('burger', 1500, 1, 0, 0, 500),
    cand('fries', 1000, 0, 1, 0, 300),
    cand('coke', 800, 0, 0, 1, 150),
    cand('duo', 5000, 2, 2, 2, 1700, 3000),
  ];
  const sols = optimize(cands, { m: 2, s: 2, d: 2 });
  const cheapest = sols.sort((a, b) => a.price - b.price)[0];
  assert.equal(cheapest.price, 5000);
  assert.deepEqual(cheapest.items.map((i) => [i.cand.id, i.qty]), [['duo', 1]]);
});

test('结果里没有多点的冗余餐品', () => {
  const cands = [cand('combo', 2000, 1, 1, 1, 900), cand('burger', 1000, 1, 0, 1, 600)];
  const sols = optimize(cands, { m: 1, s: 1, d: 1 }, { budget: 10000 });
  assert.deepEqual(sols.map((s) => s.key), ['combox1']);
});

test('预算之外的方案会被剔除', () => {
  const cands = [cand('combo', 3000, 1, 1, 1)];
  assert.equal(optimize(cands, { m: 2, s: 2, d: 2 }, { budget: 5000 }).length, 0);
  assert.equal(optimize(cands, { m: 2, s: 2, d: 2 }, { budget: 6000 })[0].price, 6000);
});

test('不会为了凑热量加入补不上缺口的餐品', () => {
  const cands = [cand('combo', 3000, 1, 1, 1, 900), cand('pie', 500, 0, 1, 0, 300)];
  const sols = optimize(cands, { m: 1, s: 1, d: 1 }, { budget: 10000 });
  assert.ok(sols.every((s) => s.items.every((i) => i.cand.id !== 'pie')));
});

test('pickPlans 给出最省、最饱、最超值并去重', () => {
  const cands = [
    cand('cheap', 2000, 1, 1, 1, 600, 0),
    cand('big', 3500, 1, 1, 1, 1300, 500),
    cand('deal', 2800, 1, 1, 1, 800, 2500),
  ];
  const plans = pickPlans(optimize(cands, { m: 1, s: 1, d: 1 }), { budget: 4000, perStrategy: 1 });
  const by = Object.fromEntries(plans.map((p) => [p.strategy, p.plan.items[0].cand.id]));
  assert.equal(by.cheapest, 'cheap');
  assert.equal(by.fullest, 'big');
  assert.equal(by['best-deal'], 'deal');
});

test('餐品分类', () => {
  assert.equal(classify('巨无霸'), 'm');
  assert.equal(classify('可乐中杯'), 'd');
  assert.equal(classify('中薯条'), 's');
  assert.equal(classify('奥利奥麦旋风'), 's');
  assert.equal(classify('北美招牌牧场酱'), null);
  assert.equal(classify('5块心形薯饼+韩式辣椒黄油风味酱'), 's');
  assert.equal(classify('海绵宝宝×航海王系列玩具'), null);
});

test('营养表解析与模糊匹配', () => {
  const table = parseNutrition('[2]{productName,nutritionDescription,energyKj,energyKcal}:\n  中薯条,null,1210,289\n  麦乐鸡5块,null,890,213');
  assert.equal(lookupKcal(table, '中薯条', 's'), 289);
  assert.equal(lookupKcal(table, '麦乐鸡-5块', 's'), 213);
  assert.equal(lookupKcal(table, '不存在的东西', 'd'), 140);
});

test('随单购优惠价不计入，按原价', () => {
  assert.equal(effectivePriceFen({ currentPrice: '32', originalPrice: '58.5', discountType: '随单购麦金卡优惠' }), 5850);
  assert.equal(effectivePriceFen({ currentPrice: '15.9', originalPrice: '24', discountType: '促销优惠' }), 1590);
});

test('套餐画像：麦乐鸡套餐的小食升格为主食，并能按口味过滤', () => {
  const detail = { rounds: [
    { quantity: 1, choices: [{ name: '麦乐鸡5块', isDefault: 1 }] },
    { quantity: 1, choices: [{ name: '中薯条', isDefault: 1 }] },
    { quantity: 1, choices: [{ name: '可乐中杯', isDefault: 1 }] },
  ] };
  const p = buildProfile('99001', { name: '麦乐鸡套餐', currentPrice: '25', originalPrice: '37.5' }, detail, new Map());
  assert.deepEqual([p.m, p.s, p.d], [1, 1, 1]);
  assert.equal(p.saving, 1250);
  const beef = buildProfile('1100', { name: '巨无霸', currentPrice: '25.5' }, null, new Map());
  assert.deepEqual(filterProfiles([p, beef], { avoid: ['beef'] }).map((x) => x.code), ['99001']);
});
