import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { encodeFrame, decodeFrame, acceptUpgrade } from '../src/voice/ws-server.js';
import { VoiceSession, summarizePlans, parseOrder, TOOLS } from '../src/voice/session.js';

// 浏览器发来的帧带掩码，这里模拟一下
function masked(opcode, payload, fin = true) {
  const frame = encodeFrame(opcode, payload);
  const off = frame.length - payload.length;
  const mask = Buffer.from([1, 2, 3, 4]);
  const body = Buffer.from(payload).map((b, i) => b ^ mask[i & 3]);
  const head = Buffer.from(frame.subarray(0, off));
  head[1] |= 0x80;
  if (!fin) head[0] &= 0x7f;
  return Buffer.concat([head, mask, body]);
}

test('帧编解码：短、中、长三种长度和掩码', () => {
  for (const len of [5, 300, 70000]) {
    const payload = Buffer.alloc(len, 7);
    const plain = decodeFrame(encodeFrame(2, payload));
    assert.equal(plain.opcode, 2);
    assert.equal(plain.payload.length, len);
    const m = decodeFrame(masked(1, payload));
    assert.deepEqual(m.payload, payload);
  }
  assert.equal(decodeFrame(encodeFrame(1, Buffer.alloc(300)).subarray(0, 100)), null);
});

test('summarizePlans 给模型的摘要包含序号、价格和人均', () => {
  const result = {
    store: { storeName: '测试门店' },
    plans: [{ label: '最省钱', price: 56.3, discount: 0, kcal: 1714, deliveryFee: 0, packingFee: 0, lines: [{ name: '汉堡', quantity: 3 }] }],
  };
  const s = summarizePlans(result, 3);
  assert.equal(s.store, '测试门店');
  assert.deepEqual(s.plans[0], {
    index: 1, name: '最省钱', price: '56.3元', per_person: '18.77元', saved_vs_single: '0元', kcal: 1714, items: '汉堡×3', fees: undefined,
  });
  assert.ok(summarizePlans({ store: { storeName: 'x' }, plans: [] }, 1).hint);
});

test('parseOrder 从结构化数据或文本里取支付链接和订单号', () => {
  const a = parseOrder({ data: { data: { orderId: 'A1', payUrl: 'https://pay/x' } }, text: '' });
  assert.equal(a.orderId, 'A1');
  assert.equal(a.payUrl, 'https://pay/x');
  // 实际返回的是 scanToPay 地址，订单号从里面取，并生成唤起 App 收银台的链接
  const real = parseOrder({ data: null, text: '支付链接：https://m.mcd.cn/mcp/scanToPay?orderId=1030728930000808593071437883' });
  assert.equal(real.orderId, '1030728930000808593071437883');
  assert.equal(real.jumpUrl, 'https://m.mcd.cn/mcp/jumpToApp?orderId=1030728930000808593071437883');
  assert.ok(real.appUrl.startsWith('mcdapp://page?'));
  const params = JSON.parse(decodeURIComponent(new URL(real.appUrl.replace('mcdapp://', 'http://x/')).searchParams.get('parameters')));
  assert.deepEqual(params, { orderId: '1030728930000808593071437883', openCashierDesk: '1' });
  const r = parseOrder({ data: null, text: '订单号：1234567\n支付链接：https://m.mcd.cn/pay?id=9）' });
  assert.equal(r.orderId, '1234567');
  assert.equal(r.payUrl, 'https://m.mcd.cn/pay?id=9');
});

test('工具声明都是 Seeduplex 要求的扁平 function 结构', () => {
  for (const t of TOOLS) {
    assert.equal(t.type, 'function');
    assert.ok(t.name && t.description && t.parameters?.type === 'object');
  }
});

// 端到端：假浏览器 ⇄ VoiceSession ⇄ 假豆包上游（用本项目的 ws-server 扮演），麦当劳 MCP 用假客户端
test('语音会话：建会话、转发音频、函数调用回传、只有页面确认才下单', async () => {
  const upstreamGot = [];
  let upstreamConn;
  const server = createServer();
  server.on('upgrade', (req, socket, head) => {
    assert.equal(req.headers['x-api-key'], 'test-key');
    upstreamConn = acceptUpgrade(req, socket, head);
    upstreamConn.on('text', (t) => upstreamGot.push(JSON.parse(t)));
  });
  server.listen(0);
  await once(server, 'listening');

  const toBrowser = [];
  const browser = { sendJson: (m) => toBrowser.push(m), sendBinary: (b) => toBrowser.push({ type: 'audio', bytes: b.length }) };
  const mcdCalls = [];
  const plan = {
    label: '最省钱', price: 30, discount: 5, kcal: 900, deliveryFee: 0, packingFee: 0,
    lines: [{ name: '套餐', quantity: 1 }], takeWays: [{ code: 'eat-in', title: '堂食' }, { code: 'take-out', title: '外带' }],
    orderItems: [{ productCode: '9900', quantity: 1 }],
  };
  const mcd = {
    async callTool(name, args) {
      mcdCalls.push({ name, args });
      if (name === 'create-order') return { data: { data: { orderId: 'O-1', payUrl: 'https://pay.example/1' } }, text: 'ok' };
      throw new Error(`unexpected ${name}`);
    },
  };

  const session = new VoiceSession(browser, { apiKey: 'test-key', voice: 'v1', mcd, url: `ws://127.0.0.1:${server.address().port}` });
  // 跳过真实凑单，直接注入一份方案，专注测协议和下单门槛
  session.last = { store: { storeCode: 'S1', storeName: '测试店', orderType: 1, beType: 1 }, plans: [plan], people: 1, createdAt: Date.now() };
  session.start();

  const waitFor = async (pred, list) => {
    for (let i = 0; i < 100; i++) {
      const hit = list.find(pred);
      if (hit) return hit;
      await new Promise((r) => setTimeout(r, 20));
    }
    throw new Error('timeout');
  };

  const create = await waitFor((m) => m.type === 'session.create', upstreamGot);
  assert.equal(create.session.model, '1.2.6.1');
  assert.equal(create.session.audio.input.format.sample_rate, 16000);
  assert.equal(create.session.audio.output.format.type, 'pcm_s16le');
  assert.equal(create.session.audio.output.voice, 'v1');
  assert.deepEqual(create.session.tools.map((t) => t.name), ['make_plans', 'prepare_order', 'order_status']);

  upstreamConn.sendJson({ type: 'session.created', session: { id: 'd1' } });
  await waitFor((m) => m.type === 'ready', toBrowser);
  await waitFor((m) => m.type === 'speech_text_buffer.commit', upstreamGot);
  assert.ok(toBrowser.some((m) => m.type === 'bot_text_done' && m.text.includes('凑单大师')));

  session.onBrowserAudio(Buffer.alloc(640, 1));
  const append = await waitFor((m) => m.type === 'input_audio_buffer.append', upstreamGot);
  assert.equal(Buffer.from(append.audio, 'base64').length, 640);

  upstreamConn.sendJson({ type: 'response.output_audio.delta', delta: Buffer.alloc(480).toString('base64') });
  assert.equal((await waitFor((m) => m.type === 'audio', toBrowser)).bytes, 480);

  // 模型要求下单：只弹确认卡片，不能调用 create-order
  upstreamConn.sendJson({
    type: 'response.function_call_arguments.done',
    items: [{ call_id: 'c1', name: 'prepare_order', arguments: JSON.stringify({ plan_index: 1, take_way: '外带' }) }],
  });
  const reply = await waitFor((m) => m.type === 'conversation.item.create', upstreamGot);
  assert.equal(reply.items[0].call_id, 'c1');
  assert.equal(reply.items[0].role, 'tool');
  assert.equal(JSON.parse(reply.items[0].content[0].text).shown_on_screen, true);
  const confirm = await waitFor((m) => m.type === 'confirm', toBrowser);
  assert.equal(confirm.takeWay, 'take-out');
  assert.equal(mcdCalls.length, 0);

  // 用户在页面点确认后才真正下单
  await session.onBrowserCommand({ type: 'confirm_order', index: 1, takeWay: 'take-out' });
  assert.equal(mcdCalls.length, 1);
  assert.equal(mcdCalls[0].name, 'create-order');
  assert.equal(mcdCalls[0].args.takeWayCode, 'take-out');
  assert.equal(mcdCalls[0].args.storeCode, 'S1');
  const order = await waitFor((m) => m.type === 'order', toBrowser);
  assert.equal(order.payUrl, 'https://pay.example/1');

  // 同一张确认卡片不能重复下单
  await session.onBrowserCommand({ type: 'confirm_order', index: 1 });
  assert.equal(mcdCalls.length, 1);

  // 未知工具的错误也要按 call_id 回传，模型才不会卡住
  upstreamConn.sendJson({ type: 'response.function_call_arguments.done', items: [{ call_id: 'c2', name: 'nope', arguments: '{}' }] });
  const err = await waitFor((m) => m.type === 'conversation.item.create' && m.items[0].call_id === 'c2', upstreamGot);
  assert.equal(JSON.parse(err.items[0].content[0].text).ok, false);

  session.close();
  await waitFor((m) => m.type === 'session.close', upstreamGot);
  upstreamConn.close();
  server.close();
});
