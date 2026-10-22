// 一个浏览器连接对应一个语音会话：浏览器 ⇄ 本服务 ⇄ 豆包实时语音（Seeduplex 全双工）
// 豆包负责听和说，凑单与下单通过 Function Calling 回到本服务，由本服务调用麦当劳 MCP
import { randomUUID } from 'node:crypto';
import { McdMcpClient } from '../mcp-client.js';
import { makePlans, resolveStore, normalizeAvoid, placeOrder } from '../planner.js';

export const UPSTREAM_URL = 'wss://openspeech.bytedance.com/api/v3/duplex/realtime/dialogue';
const MODEL = '1.2.6.1';
const PLAN_TTL_MS = 60 * 60 * 1000;

const GREETING = '你好，我是麦门凑单大师。告诉我几个人、多少预算，到店还是外送，我帮你凑最划算的一单。';

const INSTRUCTIONS = `# 角色
你是「麦门凑单大师」，在电话里帮用户点麦当劳。用户告诉你人数、预算和取餐方式，你调用工具算出最划算的方案并帮他下单。

# 说话方式
- 这是语音对话，每次回复控制在两三句话，口语化，不要念列表符号、括号和英文编码。
- 金额说成「五十六块三」这类口语，不用念「人民币」或小数点后的零。
- 用户插话时立刻停下来听。

# 收集需求
- 必须知道：人数；到店自取还是外送。到店自取还需要城市和附近地点（比如「上海人民广场」）。
- 预算没说就问一句，用户说不限也可以。
- 可选：每人要不要小食、要不要饮料（默认都要），忌口（牛肉、猪肉、鱼、辣、咖啡），不想要的餐品。
- 信息够了就调用 make_plans，不要反复确认。调用前说一句「好的，我算一下，稍等」。

# 介绍方案
- make_plans 会返回最多三套方案，屏幕上会同时显示详细卡片。
- 先用一句话说门店名，再依次说每套方案：序号、名字、到手价、人均，以及最有特点的一点（比如比单点省多少或热量最高）。不要逐个念餐品，用户问了再说。
- 如果没有方案，按返回的提示建议用户调整预算或条件。
- 价格以工具返回为准，绝不编造餐品、价格或优惠。

# 下单
- 用户明确选定方案（比如「就要第二个」）后，调用 prepare_order。到店自取要问清堂食还是外带。
- prepare_order 不会真正下单，只会在屏幕上弹出确认卡片。你要告诉用户「请在屏幕上核对后点确认下单」，不要说已经下单成功。
- 用户说下好了、付好了或问订单状态时，调用 order_status，按返回结果回答。
- 支付需要用户在屏幕上的支付链接或麦当劳 App 里完成。`;

export const TOOLS = [
  {
    type: 'function',
    name: 'make_plans',
    description: '根据人数、预算和取餐方式，读取麦当劳门店实时菜单和可用券，算出最省钱、吃最饱、最超值三套方案，价格已由麦当劳官方实时校验',
    parameters: {
      type: 'object',
      properties: {
        people: { type: 'integer', minimum: 1, maximum: 20, description: '用餐人数' },
        budget: { type: 'number', description: '总预算（元），用户说不限时不传' },
        mode: { type: 'string', enum: ['pickup', 'delivery'], description: 'pickup 到店自取，delivery 麦乐送外送' },
        city: { type: 'string', description: '到店自取时的城市，如「上海」' },
        near: { type: 'string', description: '到店自取时的附近地点，如「人民广场」' },
        side: { type: 'boolean', description: '每人是否需要小食，默认 true' },
        drink: { type: 'boolean', description: '每人是否需要饮料，默认 true' },
        avoid: { type: 'array', items: { type: 'string', enum: ['牛肉', '猪肉', '鱼', '辣', '咖啡'] }, description: '忌口' },
        exclude: { type: 'array', items: { type: 'string' }, description: '不想要的餐品关键词' },
        variety: { type: 'boolean', description: '口味丰富一些，同一款餐品最多点人数的一半' },
      },
      required: ['people', 'mode'],
    },
  },
  {
    type: 'function',
    name: 'prepare_order',
    description: '用户选定方案后调用，在屏幕上弹出下单确认卡片，由用户亲手点击确认后才会真正下单',
    parameters: {
      type: 'object',
      properties: {
        plan_index: { type: 'integer', minimum: 1, description: '方案序号，从 1 开始' },
        take_way: { type: 'string', description: '到店自取时的取餐方式，如「堂食」或「外带」' },
        remark: { type: 'string', description: '外送备注，最多 50 字' },
      },
      required: ['plan_index'],
    },
  },
  {
    type: 'function',
    name: 'order_status',
    description: '查询本次对话里已创建订单的最新状态（是否已支付、制作和配送进度）',
    parameters: { type: 'object', properties: {} },
  },
];

const yuan = (n) => `${Number(n.toFixed(2))}元`;

// 给模型看的方案摘要：够它口播，又不至于太长
export function summarizePlans(result, people) {
  const { store, plans } = result;
  if (!plans.length) {
    return { store: store.storeName, plans: [], hint: '预算内凑不出满足条件的方案，可以建议提高预算、不要小食或饮料，或减少忌口' };
  }
  return {
    store: store.storeName,
    address: store.addressText,
    plans: plans.map((p, i) => ({
      index: i + 1,
      name: p.label,
      price: yuan(p.price),
      per_person: yuan(p.price / people),
      saved_vs_single: yuan(p.discount),
      kcal: p.kcal,
      items: p.lines.map((l) => `${l.name}×${l.quantity}`).join('，'),
      fees: p.deliveryFee || p.packingFee ? `含配送费${yuan(p.deliveryFee)}、打包费${yuan(p.packingFee)}` : undefined,
    })),
  };
}

// 麦当劳官方支付跳转：create-order 返回的 scanToPay 页只是一张指向 jumpToApp 的二维码，
// jumpToApp 再用下面的 mcdapp:// 链接打开 App 订单详情并弹出收银台（可选支付宝/微信支付）
export function payLinks(orderId) {
  const params = encodeURIComponent(JSON.stringify({ orderId, openCashierDesk: '1' }));
  return {
    appUrl: `mcdapp://page?iosPageName=MCDOrderDetailViewController&androidPageName=ComponentOrder&androidPageAction=order_detail&harmonyPageName=OrderDetailPage&parameters=${params}`,
    jumpUrl: `https://m.mcd.cn/mcp/jumpToApp?orderId=${encodeURIComponent(orderId)}`,
  };
}

// 从下单结果里找支付链接和订单号
export function parseOrder(res) {
  const data = res.data?.data ?? res.data ?? {};
  const text = res.text || '';
  const payUrl = data.payUrl || data.paymentUrl || data.payLink || text.match(/https?:\/\/[^\s)"'<>）]+/)?.[0];
  const orderId = data.orderId || data.orderNo
    || payUrl?.match(/[?&]orderId=([A-Za-z0-9]+)/)?.[1]
    || text.match(/订单(?:号|编号|ID)[:：\s]*([A-Za-z0-9]+)/)?.[1];
  return { payUrl, orderId, text, ...(orderId ? payLinks(orderId) : {}) };
}

export class VoiceSession {
  constructor(browser, { apiKey, voice, mcd, url = UPSTREAM_URL, log = () => {} }) {
    this.browser = browser;
    this.url = url;
    this.apiKey = apiKey;
    this.voice = voice;
    this.mcd = mcd ?? new McdMcpClient();
    this.log = log;
    this.upstream = null;
    this.last = null;        // 最近一次 make_plans 的结果
    this.pending = null;     // 等待用户在屏幕上确认的订单
    this.orders = [];
    this.muted = false;
  }

  start() {
    this.status('正在连接豆包实时语音…');
    const ws = new WebSocket(this.url, {
      headers: { 'X-Api-Key': this.apiKey, 'X-Api-Connect-Id': randomUUID() },
    });
    this.upstream = ws;
    ws.onopen = () => {
      this.send({
        type: 'session.create',
        session: {
          model: MODEL,
          instructions: INSTRUCTIONS,
          audio: {
            input: { format: { type: 'pcm', sample_rate: 16000 } },
            output: { format: { type: 'pcm_s16le', sample_rate: 24000 }, voice: this.voice, speed: 0, loudness: 0 },
          },
          tools: TOOLS,
        },
      });
    };
    ws.onmessage = (e) => {
      let msg;
      try { msg = JSON.parse(e.data); } catch { return; }
      this.#onUpstream(msg).catch((err) => this.error(err.message));
    };
    ws.onerror = () => this.error('连接豆包实时语音失败，请检查 VOLC_API_KEY 是否正确、是否已开通端到端实时语音服务');
    ws.onclose = (e) => {
      this.browser.sendJson({ type: 'closed', code: e.code, reason: e.reason });
    };
  }

  send(event) {
    if (this.upstream?.readyState === WebSocket.OPEN) {
      this.upstream.send(JSON.stringify({ event_id: randomUUID(), ...event }));
    }
  }

  status(text) { this.browser.sendJson({ type: 'status', text }); }
  error(message) { this.log(`✖ ${message}`); this.browser.sendJson({ type: 'error', message }); }

  // 浏览器上行：二进制帧是 16k/int16/单声道 PCM，文本帧是控制指令
  onBrowserAudio(buf) {
    if (!this.muted) this.send({ type: 'input_audio_buffer.append', audio: buf.toString('base64') });
  }

  async onBrowserCommand(msg) {
    switch (msg.type) {
      case 'mute':
        this.muted = true;
        return this.send({ type: 'input_audio_mute.commit' });
      case 'unmute':
        this.muted = false;
        return this.send({ type: 'input_audio_unmute.commit' });
      case 'commit':
        return this.send({ type: 'input_audio_buffer.commit' });
      case 'cancel':
        return this.send({ type: 'response.cancel' });
      case 'choose_plan':
        return this.#prepare({ plan_index: msg.index, take_way: msg.takeWay });
      case 'confirm_order':
        return this.#confirmOrder(msg);
      case 'cancel_order':
        this.pending = null;
        return this.browser.sendJson({ type: 'confirm_cleared' });
      default:
    }
  }

  async #onUpstream(msg) {
    switch (msg.type) {
      case 'session.created':
        this.status('已连接，请直接说话');
        this.browser.sendJson({ type: 'ready' });
        this.send({ type: 'speech_text_buffer.commit', text: GREETING });
        // 打招呼只下发音频，没有文本事件，字幕由这里补上
        this.browser.sendJson({ type: 'bot_text', text: GREETING });
        this.browser.sendJson({ type: 'bot_text_done', text: GREETING });
        break;
      case 'conversation.item.input_audio_transcription.started':
        // 用户开口就打断正在播放的回复
        this.browser.sendJson({ type: 'interrupt' });
        break;
      case 'conversation.item.input_audio_transcription.delta':
        // 实测 delta 是当前整句识别结果，不是增量
        this.browser.sendJson({ type: 'user_text', text: msg.delta ?? msg.text ?? '', final: false });
        break;
      case 'conversation.item.input_audio_transcription.completed':
        this.browser.sendJson({ type: 'user_text', text: msg.transcript ?? msg.text ?? '', final: true });
        break;
      case 'response.output_text.delta':
        this.browser.sendJson({ type: 'bot_text', text: msg.delta ?? '' });
        break;
      case 'response.output_text.done':
        this.browser.sendJson({ type: 'bot_text_done', text: msg.text });
        break;
      case 'response.output_audio.delta':
        if (msg.delta) this.browser.sendBinary(Buffer.from(msg.delta, 'base64'));
        break;
      case 'response.function_call_arguments.done':
        await this.#onFunctionCall(msg);
        break;
      case 'error':
        this.error(`豆包返回错误：${msg.error?.message ?? msg.message ?? JSON.stringify(msg).slice(0, 200)}`);
        break;
      default:
    }
  }

  // 同一事件里可能有多个调用，全部执行完一次性回传
  async #onFunctionCall(msg) {
    const items = Array.isArray(msg.items) ? msg.items : [msg.items ?? msg].filter(Boolean);
    const results = [];
    for (const item of items) {
      const name = item.name ?? item.function?.name;
      let args = item.arguments ?? item.function?.arguments ?? '{}';
      let output;
      try {
        if (typeof args === 'string') args = JSON.parse(args || '{}');
        this.log(`→ ${name} ${JSON.stringify(args)}`);
        output = await this.runTool(name, args);
      } catch (err) {
        output = { ok: false, error: err.message };
      }
      this.log(`← ${name} ${JSON.stringify(output).slice(0, 200)}`);
      results.push({
        call_id: item.call_id,
        role: 'tool',
        content: [{ type: 'input_text', text: JSON.stringify(output) }],
      });
    }
    if (results.length) this.send({ type: 'conversation.item.create', items: results });
  }

  async runTool(name, args) {
    if (name === 'make_plans') return this.#makePlans(args);
    if (name === 'prepare_order') return this.#prepare(args);
    if (name === 'order_status') return this.#orderStatus();
    throw new Error(`未知工具 ${name}`);
  }

  async #makePlans(args) {
    const people = Number(args.people);
    if (!Number.isInteger(people) || people < 1 || people > 20) throw new Error('人数需要是 1 到 20 之间的整数');
    const budget = args.budget > 0 ? Number(args.budget) : undefined;
    this.browser.sendJson({ type: 'working', text: '正在读取门店菜单和优惠券…' });
    const store = await resolveStore(this.mcd, {
      delivery: args.mode === 'delivery', city: args.city, near: args.near,
    });
    const result = await makePlans(this.mcd, {
      store, people, budget,
      side: args.side !== false,
      drink: args.drink !== false,
      avoid: normalizeAvoid(args.avoid ?? []),
      exclude: args.exclude ?? [],
      variety: !!args.variety,
    }, (text) => this.browser.sendJson({ type: 'working', text }));
    this.last = { ...result, people, createdAt: Date.now() };
    this.pending = null;
    this.browser.sendJson({ type: 'plans', people, store: result.store, need: result.need, budget, plans: result.plans });
    return summarizePlans(result, people);
  }

  #prepare({ plan_index: index, take_way: takeWay, remark }) {
    if (!this.last) throw new Error('还没有方案，请先告诉我人数、预算和取餐方式');
    if (Date.now() - this.last.createdAt > PLAN_TTL_MS) throw new Error('方案已超过 1 小时，价格可能变了，需要重新计算');
    const plan = this.last.plans[Number(index) - 1];
    if (!plan) throw new Error(`没有第 ${index} 套方案，一共 ${this.last.plans.length} 套`);
    const { store } = this.last;
    const ways = store.orderType === 1 ? plan.takeWays : [];
    const way = takeWay ? ways.find((w) => w.code === takeWay || w.title?.includes(takeWay)) : undefined;
    this.pending = { index: Number(index), plan, store, takeWay: way?.code, remark };
    this.browser.sendJson({
      type: 'confirm',
      index: Number(index),
      store: store.storeName,
      address: store.addressText,
      plan,
      takeWays: ways,
      takeWay: way?.code ?? ways[0]?.code,
    });
    return { ok: true, shown_on_screen: true, note: '确认卡片已显示在屏幕上，需要用户亲手点击「确认下单」才会下单，现在还没有下单' };
  }

  // 只有页面上点了「确认下单」才会走到这里
  async #confirmOrder({ index, takeWay }) {
    const p = this.pending;
    if (!p || p.index !== index) return this.error('确认卡片已失效，请重新选择方案');
    this.pending = null;
    this.browser.sendJson({ type: 'working', text: '正在下单…' });
    try {
      const res = await placeOrder(this.mcd, p.store, p.plan, { takeWay: takeWay ?? p.takeWay, remark: p.remark });
      const order = { ...parseOrder(res), price: p.plan.price, label: p.plan.label, createdAt: Date.now() };
      this.orders.push(order);
      this.browser.sendJson({ type: 'order', ...order });
      this.send({ type: 'speech_text_buffer.commit', text: '下单成功，点屏幕上的去支付，会打开麦当劳 App 的收银台，可以选支付宝付款。' });
    } catch (err) {
      this.error(err.message);
    }
  }

  async #orderStatus() {
    const order = this.orders.at(-1);
    if (!order) return { ok: false, note: '这次对话里还没有下过单。如果用户刚看到确认卡片，提醒他点「确认下单」' };
    if (!order.orderId) return { ok: true, note: '订单已创建，但没拿到订单号，请用户在麦当劳 App 的订单页查看', detail: order.text.slice(0, 500) };
    const res = await this.mcd.callTool('query-order', { orderId: order.orderId });
    this.browser.sendJson({ type: 'order_status', orderId: order.orderId, text: res.text });
    return { ok: true, orderId: order.orderId, detail: (res.text || JSON.stringify(res.data)).slice(0, 1500) };
  }

  close() {
    const ws = this.upstream;
    if (!ws) return;
    this.upstream = null;
    if (ws.readyState === WebSocket.OPEN) {
      // 先发 session.close 再断开，直接断开服务端会报 ContextCanceled
      ws.send(JSON.stringify({ type: 'session.close', event_id: randomUUID() }));
      setTimeout(() => ws.close(), 1000).unref();
    } else {
      ws.close();
    }
  }
}
