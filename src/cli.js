#!/usr/bin/env node
// 麦门凑单大师 CLI
import { parseArgs } from 'node:util';
import { mkdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { McdMcpClient } from './mcp-client.js';
import { findPickupStores, makePlans, resolveStore, normalizeAvoid, placeOrder } from './planner.js';

const STATE_DIR = '.mcd-coudan';
const LAST_PLAN = join(STATE_DIR, 'last-plan.json');

const HELP = `麦门凑单大师 —— 给定人数和预算，用麦当劳 MCP 凑出最划算的一单

用法:
  mcd-coudan stores --city 上海 --near 人民广场      查附近门店（不带参数查收藏门店）
  mcd-coudan plan --people 3 --budget 100 [门店] [口味]  生成 最省钱 / 吃最饱 / 最超值 三套方案
  mcd-coudan order --pick 1 --confirm [--take-way eat-in]  按上次方案下单，返回支付链接
  mcd-coudan claim --confirm                         麦麦省一键领券（领完再 plan 会自动用券）

门店（三选一）:
  --store <storeCode>          指定到店自取门店
  --city <城市> --near <地点>   自动选最近的营业门店
  --delivery [--address-id ID] 麦乐送，默认用账户里第一个配送地址

口味与搭配:
  --no-side / --no-drink       每人不需要小食 / 饮料
  --avoid beef,spicy           忌口：beef 牛肉 / pork 猪肉 / fish 鱼 / spicy 辣 / coffee 咖啡（也可写中文）
  --exclude 关键词,关键词        排除名称包含关键词的餐品
  --variety                    同一款餐品最多点人数的一半，口味更丰富
  --json                       输出 JSON（给 Agent 使用）

Token 读取顺序：环境变量 MCD_MCP_TOKEN → 项目根目录 .env`;

const { values: opt, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    people: { type: 'string', default: '1' },
    budget: { type: 'string' },
    store: { type: 'string' },
    city: { type: 'string' },
    near: { type: 'string' },
    delivery: { type: 'boolean', default: false },
    'address-id': { type: 'string' },
    'no-side': { type: 'boolean', default: false },
    'no-drink': { type: 'boolean', default: false },
    avoid: { type: 'string', default: '' },
    exclude: { type: 'string', default: '' },
    variety: { type: 'boolean', default: false },
    pick: { type: 'string', default: '1' },
    'take-way': { type: 'string' },
    remark: { type: 'string' },
    confirm: { type: 'boolean', default: false },
    json: { type: 'boolean', default: false },
    help: { type: 'boolean', short: 'h', default: false },
  },
});

const split = (s) => s.split(/[,，]/).map((x) => x.trim()).filter(Boolean);
const yuan = (n) => `¥${n.toFixed(2).replace(/\.00$/, '')}`;
const log = (msg) => { if (!opt.json) console.error(`… ${msg}`); };

async function cmdStores(client) {
  const stores = await findPickupStores(client, { city: opt.city, near: opt.near });
  if (opt.json) return console.log(JSON.stringify(stores, null, 2));
  if (!stores.length) return console.log('没有找到门店');
  for (const s of stores) {
    const status = s.businessStatus === false ? '休息中' : `${s.businessStartTime}-${s.businessEndTime}`;
    console.log(`${s.storeCode}  ${s.storeName}  ${s.distance ?? '?'}m  ${status}\n          ${s.address}`);
  }
}

async function cmdPlan(client) {
  const people = Number(opt.people);
  if (!Number.isInteger(people) || people < 1 || people > 20) throw new Error('--people 需要是 1~20 的整数');
  const budget = opt.budget ? Number(opt.budget) : undefined;
  if (opt.budget && !(budget > 0)) throw new Error('--budget 需要是正数（元）');
  const avoid = normalizeAvoid(split(opt.avoid));

  const store = await resolveStore(client, {
    delivery: opt.delivery, store: opt.store, city: opt.city, near: opt.near, addressId: opt['address-id'],
  });
  const result = await makePlans(client, {
    store, people, budget, avoid,
    side: !opt['no-side'],
    drink: !opt['no-drink'],
    exclude: split(opt.exclude),
    variety: opt.variety,
  }, log);

  mkdirSync(STATE_DIR, { recursive: true });
  writeFileSync(LAST_PLAN, JSON.stringify({ createdAt: new Date().toISOString(), ...result }, null, 2));
  if (opt.json) return console.log(JSON.stringify(result, null, 2));
  printPlans(result, people);
}

function printPlans(result, people) {
  const { store, need, budget, plans } = result;
  const needText = ['主食', need.s && '小食', need.d && '饮料'].filter(Boolean).join('+');
  console.log(`\n🍔 ${store.storeName}${store.addressText ? `（送到 ${store.addressText}）` : ''}`);
  console.log(`   ${people} 人 · 每人 ${needText}${budget ? ` · 预算 ${yuan(budget)}` : ''} · 候选 ${result.candidates} 个\n`);
  if (!plans.length) {
    console.log('预算内凑不出满足条件的方案，可以试试：提高预算、加 --no-side / --no-drink，或者减少忌口。');
    for (const r of result.rejected || []) console.log(`  · ${r.label} 校验失败：${r.error}`);
    return;
  }
  plans.forEach((p, i) => {
    const per = p.price / people;
    console.log(`【${i + 1}】${p.label}  到手 ${yuan(p.price)}（人均 ${yuan(per)}）  比单点省 ${yuan(p.discount)}  约 ${p.kcal} 千卡`);
    for (const l of p.lines) {
      const was = l.originalSubtotal > l.subtotal ? `  原价 ${yuan(l.originalSubtotal)}` : '';
      const coupon = l.coupon ? `  🎟 ${l.coupon}` : '';
      console.log(`    ${l.name} ×${l.quantity}  ${yuan(l.subtotal)}${was}${coupon}`);
      if (l.parts?.length > 1) console.log(`      └ ${l.parts.join(' / ')}`);
    }
    const fees = [p.deliveryFee && `配送费 ${yuan(p.deliveryFee)}`, p.packingFee && `打包费 ${yuan(p.packingFee)}`].filter(Boolean);
    if (fees.length) console.log(`    ${fees.join('  ')}`);
    console.log('');
  });
  console.log('价格已由麦当劳 calculate-price 实时校验。下单：mcd-coudan order --pick <序号> --confirm');
  console.log('（项目输出仅供参考，餐品、价格及供应状态以麦当劳官方渠道实时结果为准）');
}

async function cmdOrder(client) {
  if (!existsSync(LAST_PLAN)) throw new Error('还没有方案，请先运行 plan');
  const last = JSON.parse(readFileSync(LAST_PLAN, 'utf8'));
  const plan = last.plans[Number(opt.pick) - 1];
  if (!plan) throw new Error(`方案 ${opt.pick} 不存在，上次共有 ${last.plans.length} 个方案`);
  const ageMin = (Date.now() - Date.parse(last.createdAt)) / 60000;
  if (ageMin > 60) throw new Error('方案已超过 1 小时，菜单和价格可能已变化，请重新 plan');

  const store = last.store;
  const summary = plan.lines.map((l) => `${l.name}×${l.quantity}`).join('、');
  if (!opt.confirm) {
    console.log(`将在 ${store.storeName} 下单「${plan.label}」：${summary}，预计 ${yuan(plan.price)}。`);
    console.log('确认无误后加上 --confirm 再运行一次。下单后需在支付链接或麦当劳 App 内完成支付。');
    return;
  }
  const res = await placeOrder(client, store, plan, { takeWay: opt['take-way'], remark: opt.remark });
  console.log(opt.json ? JSON.stringify(res.data ?? res.text, null, 2) : res.text);
}

async function cmdClaim(client) {
  if (!opt.confirm) {
    const res = await client.callTool('available-coupons', {});
    console.log(res.text);
    console.log('\n以上是麦麦省当前可领的券。加上 --confirm 一键全部领取。');
    return;
  }
  const res = await client.callTool('auto-bind-coupons', {});
  console.log(res.text);
}

async function main() {
  const cmd = positionals[0];
  if (opt.help || !cmd) return console.log(HELP);
  const commands = { stores: cmdStores, plan: cmdPlan, order: cmdOrder, claim: cmdClaim };
  if (!commands[cmd]) throw new Error(`未知命令 ${cmd}，运行 --help 查看用法`);
  await commands[cmd](new McdMcpClient());
}

main().catch((err) => {
  console.error(`✖ ${err.message}`);
  process.exitCode = 1;
});
