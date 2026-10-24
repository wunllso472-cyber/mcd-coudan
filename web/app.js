// 浏览器端：麦克风上行、语音播放、方案卡片与下单确认
const $ = (id) => document.getElementById(id);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const yuan = (n) => `¥${Number(n).toFixed(2).replace(/\.00$/, '')}`;

// 二维码库按需从 CDN 加载，加载失败不影响点餐，只是不显示二维码
let qrLib;
function qrcode(el, text) {
  qrLib ??= new Promise((resolve, reject) => {
    const s = document.createElement('script');
    s.src = 'https://cdnjs.cloudflare.com/ajax/libs/qrcodejs/1.0.0/qrcode.min.js';
    s.onload = () => resolve(window.QRCode);
    s.onerror = reject;
    document.head.append(s);
  });
  return qrLib.then((QR) => { new QR(el, { text, width: 160, height: 160 }); return true; }).catch(() => false);
}

const accessKey = new URLSearchParams(location.search).get('k') || '';
const els = {
  orb: $('orb'), hint: $('hint'), conn: $('conn'), controls: $('controls'), muteBtn: $('muteBtn'),
  commitBtn: $('commitBtn'), stopBtn: $('stopBtn'), halfDuplex: $('halfDuplex'), working: $('working'),
  workingText: $('workingText'), chat: $('chat'), plansBox: $('plansBox'), plans: $('plans'),
  plansTitle: $('plansTitle'), plansMeta: $('plansMeta'), orderBox: $('orderBox'), sheet: $('sheet'),
  sheetBody: $('sheetBody'), sheetOk: $('sheetOk'), sheetCancel: $('sheetCancel'),
};

let ws = null;
let ctx = null;
let mic = null;
let player = null;
let muted = false;
let wakeLock = null;
let confirming = null;
let userBubble = null;
let botBubble = null;

// 24kHz / int16 PCM 流式播放；用户插话时整体停掉
class PcmPlayer {
  constructor(ctx) { this.ctx = ctx; this.next = 0; this.sources = new Set(); this.onchange = () => {}; }
  get active() { return this.sources.size > 0; }
  push(buf) {
    const pcm = new Int16Array(buf);
    if (!pcm.length) return;
    const audio = this.ctx.createBuffer(1, pcm.length, 24000);
    const ch = audio.getChannelData(0);
    for (let i = 0; i < pcm.length; i++) ch[i] = pcm[i] / 0x8000;
    const src = this.ctx.createBufferSource();
    src.buffer = audio;
    src.connect(this.ctx.destination);
    this.next = Math.max(this.next, this.ctx.currentTime + 0.06);
    src.start(this.next);
    this.next += audio.duration;
    this.sources.add(src);
    src.onended = () => { this.sources.delete(src); if (!this.active) this.onchange(false); };
    if (this.sources.size === 1) this.onchange(true);
  }
  stop() {
    for (const s of this.sources) { s.onended = null; try { s.stop(); } catch {} }
    this.sources.clear();
    this.next = 0;
    this.onchange(false);
  }
}

function setConn(state, text) { els.conn.dataset.state = state; els.conn.textContent = text; }
function setOrb(state) { els.orb.dataset.state = state; }
function setHint(text) { els.hint.textContent = text; }

function bubble(cls, text) {
  const div = document.createElement('div');
  div.className = `msg ${cls}`;
  div.textContent = text;
  els.chat.append(div);
  div.scrollIntoView({ block: 'end', behavior: 'smooth' });
  return div;
}

function working(text) {
  els.working.hidden = !text;
  els.workingText.textContent = text || '';
}

async function start() {
  if (!accessKey) {
    bubble('err', '链接缺少访问口令，请使用启动服务时终端里打印的完整链接打开');
    return;
  }
  if (!navigator.mediaDevices?.getUserMedia) {
    bubble('err', '当前页面拿不到麦克风：手机上需要用 --lan 启动，并通过 https 链接打开');
    return;
  }
  setOrb('connecting');
  setConn('connecting', '连接中');
  setHint('正在打开麦克风…');
  try {
    ctx = new AudioContext();
    await ctx.resume();
    const stream = await navigator.mediaDevices.getUserMedia({
      audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true, autoGainControl: true },
    });
    await ctx.audioWorklet.addModule('mic-worklet.js');
    const node = new AudioWorkletNode(ctx, 'mic-processor');
    const source = ctx.createMediaStreamSource(stream);
    // 接一个静音输出，部分浏览器不接到 destination 就不会驱动 worklet
    const sink = ctx.createGain();
    sink.gain.value = 0;
    source.connect(node).connect(sink).connect(ctx.destination);
    mic = { stream, node, source };
  } catch (err) {
    setOrb('idle');
    setConn('error', '麦克风不可用');
    bubble('err', `打开麦克风失败：${err.message}`);
    return;
  }

  player = new PcmPlayer(ctx);
  player.onchange = (speaking) => setOrb(speaking ? 'speaking' : muted ? 'muted' : 'listening');

  const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
  ws = new WebSocket(`${proto}//${location.host}/ws?k=${encodeURIComponent(accessKey)}`);
  ws.binaryType = 'arraybuffer';
  ws.onopen = () => { const token = customToken(); if (token) send({ type: 'set_token', token }); };
  ws.onmessage = (e) => (typeof e.data === 'string' ? onEvent(JSON.parse(e.data)) : player.push(e.data));
  ws.onclose = () => stop('连接已断开');
  ws.onerror = () => bubble('err', '无法连接到本地服务，请确认服务还在运行、访问口令正确');

  const silence = new Int16Array(320).buffer;
  mic.node.port.onmessage = ({ data }) => {
    els.orb.style.setProperty('--level', muted ? 0 : Math.min(1, data.level * 3).toFixed(2));
    if (ws?.readyState !== WebSocket.OPEN || muted) return;
    // 外放时播报期间送静音帧：保持上行节奏，又不会把自己的声音录进去
    ws.send(els.halfDuplex.checked && player.active ? silence : data.pcm);
  };

  try { wakeLock = await navigator.wakeLock?.request('screen'); } catch {}
}

function stop(reason) {
  if (ws) { const w = ws; ws = null; w.onclose = null; try { w.close(); } catch {} }
  if (mic) { mic.stream.getTracks().forEach((t) => t.stop()); mic.source.disconnect(); mic = null; }
  player?.stop();
  ctx?.close();
  ctx = null;
  wakeLock?.release?.();
  muted = false;
  els.muteBtn.setAttribute('aria-pressed', 'false');
  els.muteBtn.textContent = '静音';
  els.controls.hidden = true;
  els.orb.style.setProperty('--level', 0);
  setOrb('idle');
  setConn('idle', '未连接');
  setHint('点一下重新开始');
  working('');
  if (reason) bubble('sys', reason);
}

function send(obj) { if (ws?.readyState === WebSocket.OPEN) ws.send(JSON.stringify(obj)); }

function onEvent(ev) {
  switch (ev.type) {
    case 'status':
      setHint(ev.text);
      break;
    case 'ready':
      setConn('ready', '通话中');
      setOrb('listening');
      els.controls.hidden = false;
      setHint('直接说话就行，说话时可以随时打断我');
      break;
    case 'interrupt':
      player.stop();
      break;
    case 'user_text':
      if (!userBubble) userBubble = bubble('user partial', '');
      if (ev.final) {
        if (ev.text) userBubble.textContent = ev.text;
        userBubble.classList.remove('partial');
        if (!userBubble.textContent) userBubble.remove();
        userBubble = null;
      } else {
        userBubble.textContent = ev.text;
      }
      break;
    case 'bot_text':
      if (!botBubble) botBubble = bubble('bot', '');
      botBubble.textContent += ev.text;
      break;
    case 'bot_text_done':
      if (botBubble && ev.text) botBubble.textContent = ev.text;
      botBubble = null;
      break;
    case 'working':
      working(ev.text);
      break;
    case 'plans':
      working('');
      renderPlans(ev);
      break;
    case 'confirm':
      openConfirm(ev);
      break;
    case 'confirm_cleared':
      closeConfirm();
      break;
    case 'order':
      working('');
      renderOrder(ev);
      break;
    case 'order_status':
      bubble('sys', `订单 ${ev.orderId} 状态已更新`);
      break;
    case 'error':
      working('');
      bubble('err', ev.message);
      break;
    case 'closed':
      stop(ev.reason ? `语音会话已结束：${ev.reason}` : '语音会话已结束');
      break;
    default:
  }
}

function renderPlans({ store, people, budget, need, plans }) {
  els.plansBox.hidden = false;
  els.plansTitle.textContent = store.storeName;
  const needText = ['主食', need.s && '小食', need.d && '饮料'].filter(Boolean).join('+');
  els.plansMeta.textContent = `${people} 人 · 每人 ${needText}${budget ? ` · 预算 ${yuan(budget)}` : ''}${store.addressText ? ` · 送到 ${store.addressText}` : ''}`;
  if (!plans.length) {
    els.plans.innerHTML = '<p class="meta">预算内凑不出满足条件的方案，试试提高预算、不要小食或饮料，或减少忌口。</p>';
    return;
  }
  els.plans.innerHTML = plans.map((p, i) => `
    <article class="plan" data-index="${i + 1}">
      <div class="plan-head">
        <span class="plan-name"><span class="no">${i + 1}</span>${esc(p.label)}</span>
        <span class="price">${yuan(p.price)}<small> 人均 ${yuan(p.price / people)}</small></span>
      </div>
      <div class="tags">
        ${p.discount > 0 ? `<span class="tag">比单点省 ${yuan(p.discount)}</span>` : ''}
        <span class="tag">约 ${p.kcal} 千卡</span>
      </div>
      <ul class="lines">
        ${p.lines.map((l) => `<li>${esc(l.name)} ×${l.quantity} · ${yuan(l.subtotal)}${l.coupon ? ` 🎟 ${esc(l.coupon)}` : ''}
          ${l.parts?.length > 1 ? `<span class="parts">${esc(l.parts.join(' / '))}</span>` : ''}</li>`).join('')}
      </ul>
      ${p.deliveryFee || p.packingFee ? `<p class="fees">含配送费 ${yuan(p.deliveryFee)}、打包费 ${yuan(p.packingFee)}</p>` : ''}
      <button class="btn ghost block" data-choose="${i + 1}">选这个</button>
    </article>`).join('');
  if (window.matchMedia('(max-width: 899px)').matches) els.plansBox.scrollIntoView({ behavior: 'smooth' });
}

els.plans.addEventListener('click', (e) => {
  const btn = e.target.closest('[data-choose]');
  if (!btn) return;
  if (!ws) return bubble('err', '语音会话已结束，请重新开始后再选择');
  send({ type: 'choose_plan', index: Number(btn.dataset.choose) });
});

function openConfirm({ index, store, address, plan, takeWays, takeWay }) {
  confirming = { index };
  document.querySelectorAll('.plan').forEach((el) => el.classList.toggle('chosen', Number(el.dataset.index) === index));
  els.sheetBody.innerHTML = `
    <p class="meta">${esc(store)}${address ? `<br>送到 ${esc(address)}` : ''}</p>
    <ul class="lines">${plan.lines.map((l) => `<li>${esc(l.name)} ×${l.quantity} · ${yuan(l.subtotal)}</li>`).join('')}</ul>
    ${takeWays.length ? `<div class="ways">${takeWays.map((w) => `
      <label><input type="radio" name="way" value="${esc(w.code)}" ${w.code === takeWay ? 'checked' : ''}>${esc(w.title)}</label>`).join('')}</div>` : ''}
    <div class="total"><span>到手价（${esc(plan.label)}）</span><span class="price">${yuan(plan.price)}</span></div>
    <p class="meta">确认后会用你的麦当劳账户创建真实订单，需要在支付链接或麦当劳 App 里完成支付。</p>`;
  els.sheetOk.disabled = false;
  els.sheet.hidden = false;
}

function closeConfirm() {
  els.sheet.hidden = true;
  confirming = null;
}

els.sheetOk.addEventListener('click', () => {
  if (!confirming) return;
  const way = els.sheetBody.querySelector('input[name="way"]:checked')?.value;
  els.sheetOk.disabled = true;
  send({ type: 'confirm_order', index: confirming.index, takeWay: way });
  closeConfirm();
});
els.sheetCancel.addEventListener('click', () => { send({ type: 'cancel_order' }); closeConfirm(); });

const inWechat = /micromessenger/i.test(navigator.userAgent);
$('wxTip').hidden = !inWechat;

// 唤起麦当劳 App 收银台；2 秒内页面没被切走（没装 App 或被拦截）就退回官方跳转页
function openPay(appUrl, jumpUrl) {
  if (inWechat) {
    // 微信会拦截自定义协议，只能去官方跳转页手动拉起 App，且实测不会带上订单直接进收银台
    location.href = jumpUrl;
    return;
  }
  const timer = setTimeout(() => { if (!document.hidden) location.href = jumpUrl; }, 2000);
  document.addEventListener('visibilitychange', () => { if (document.hidden) clearTimeout(timer); }, { once: true });
  location.href = appUrl;
}

function renderOrder({ payUrl, orderId, appUrl, jumpUrl, text, price, label }) {
  els.orderBox.hidden = false;
  const desktop = window.matchMedia('(min-width: 900px)').matches;
  // 扫码要用 jumpToApp 地址：scanToPay 页本身又是一张二维码，手机扫了也付不了
  const scanUrl = jumpUrl || payUrl;
  els.orderBox.innerHTML = `
    <h2>下单成功</h2>
    <p class="meta">${esc(label)} · ${yuan(price)}${orderId ? ` · 订单号 ${esc(orderId)}` : ''}</p>
    ${appUrl
      ? '<button class="btn primary block pay" id="payBtn">去支付</button><p class="meta">会打开麦当劳 App 的收银台，在收银台选支付宝付款。需要已安装麦当劳 App 并用同一手机号登录。</p>'
      : payUrl ? `<a class="btn primary pay" href="${esc(payUrl)}" target="_blank" rel="noopener">去支付</a>` : '<p class="meta">请打开麦当劳 App 的订单页完成支付。</p>'}
    ${scanUrl && desktop ? '<p class="meta">用手机扫码，打开麦当劳 App 付款：</p><div class="qr" id="payQr"></div>' : ''}
    <details><summary class="meta">麦当劳返回的原始信息</summary><pre>${esc(text)}</pre></details>`;
  if (appUrl) $('payBtn').addEventListener('click', () => openPay(appUrl, jumpUrl));
  if (scanUrl && desktop) qrcode($('payQr'), scanUrl).then((ok) => { if (!ok) $('payQr').remove(); });
  els.orderBox.scrollIntoView({ behavior: 'smooth' });
  // 手机上「确认下单」的点击还有效时直接拉起收银台，省掉再点一次「去支付」；
  // 点击已失效（下单太慢）或浏览器不支持判断时，浏览器会拦截跳转，所以只留按钮
  const mobile = /android|iphone|ipad|harmonyos|openharmony/i.test(navigator.userAgent);
  if (appUrl && mobile && navigator.userActivation?.isActive) openPay(appUrl, jumpUrl);
}

els.orb.addEventListener('click', () => {
  if (!ws) return start();
  // 播报时点一下就打断
  if (player?.active) { player.stop(); send({ type: 'cancel' }); }
});
els.muteBtn.addEventListener('click', () => {
  muted = !muted;
  send({ type: muted ? 'mute' : 'unmute' });
  els.muteBtn.setAttribute('aria-pressed', String(muted));
  els.muteBtn.textContent = muted ? '取消静音' : '静音';
  setOrb(muted ? 'muted' : player?.active ? 'speaking' : 'listening');
});
els.commitBtn.addEventListener('click', () => send({ type: 'commit' }));
els.stopBtn.addEventListener('click', () => stop('已结束通话'));

// 电脑端显示手机扫码入口（仅 --lan 启动时有）
if (window.matchMedia('(min-width: 900px)').matches) {
  fetch('/api/info').then((r) => r.json()).then(async ({ phone }) => {
    if (!phone || !(await qrcode($('phoneQr'), phone))) return;
    $('phoneBox').hidden = false;
  }).catch(() => {});
}

// ---- 设置页：MCP Token ----
// 自定义 Token 只存在本机浏览器；没有时用服务器默认 Token。读写失败（隐私模式等）就当没有
const TOKEN_KEY = 'mcd-coudan.token';
function customToken() { try { return localStorage.getItem(TOKEN_KEY) || ''; } catch { return ''; } }
function storeToken(token) {
  try { token ? localStorage.setItem(TOKEN_KEY, token) : localStorage.removeItem(TOKEN_KEY); return true; } catch { return false; }
}
const maskToken = (t) => (t.length > 8 ? `${t.slice(0, 4)}…${t.slice(-4)}` : '****');

const st = {
  sheet: $('settings'), now: $('tokenNow'), input: $('tokenInput'), show: $('tokenShow'), msg: $('tokenMsg'),
  save: $('tokenSave'), reset: $('tokenReset'), close: $('settingsClose'),
};
let defaultHint = '';

function tokenApi(path, body) {
  return fetch(path, {
    method: body ? 'POST' : 'GET',
    headers: { 'X-Access-Key': accessKey, ...(body ? { 'Content-Type': 'application/json' } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  }).then((r) => r.json());
}

function tokenMsg(text, state = '') { st.msg.textContent = text; st.msg.dataset.state = state; }

function renderTokenNow() {
  const custom = customToken();
  st.now.textContent = custom
    ? `正在使用：自定义 Token（${maskToken(custom)}）`
    : `正在使用：服务器默认 Token${defaultHint ? `（${defaultHint}）` : ''}`;
  st.reset.disabled = !custom;
}

// 正在对话时立即切换（之前的方案作废，需要重新说一遍需求），否则下次开始对话时生效
function applyToken(token) {
  if (ws?.readyState !== WebSocket.OPEN) return '';
  send({ type: 'set_token', token });
  return '，本次对话已切换，之前的方案需要重新生成';
}

$('settingsBtn').addEventListener('click', async () => {
  st.sheet.hidden = false;
  st.input.value = '';
  tokenMsg('');
  renderTokenNow();
  try {
    const r = await tokenApi('/api/token');
    if (r.hint) { defaultHint = r.hint; renderTokenNow(); } else if (r.error) tokenMsg(r.error, 'error');
  } catch { tokenMsg('读取默认 Token 失败，请确认服务还在运行', 'error'); }
});

st.show.addEventListener('click', () => {
  const hidden = st.input.type === 'password';
  st.input.type = hidden ? 'text' : 'password';
  st.show.textContent = hidden ? '隐藏' : '显示';
});

st.save.addEventListener('click', async () => {
  const token = st.input.value.trim().replace(/^Bearer\s+/i, '');
  if (!token) return tokenMsg('请先粘贴新的 Token', 'error');
  st.save.disabled = true;
  tokenMsg('正在用这个 Token 访问麦当劳账户…');
  try {
    const r = await tokenApi('/api/token/check', { token });
    if (!r.ok) return tokenMsg(`没有保存：${r.error}`, 'error');
    if (!storeToken(token)) return tokenMsg('校验通过，但浏览器不允许保存（可能是隐私模式）', 'error');
    st.input.value = '';
    renderTokenNow();
    tokenMsg(`✓ 已保存，账户里有 ${r.addresses} 个配送地址${applyToken(token)}`, 'ok');
  } catch {
    tokenMsg('校验失败，请确认服务还在运行', 'error');
  } finally {
    st.save.disabled = false;
  }
});

st.reset.addEventListener('click', () => {
  storeToken('');
  renderTokenNow();
  tokenMsg(`已恢复为服务器默认 Token${applyToken('')}`, 'ok');
});

st.close.addEventListener('click', () => { st.sheet.hidden = true; });
st.sheet.addEventListener('click', (e) => { if (e.target === st.sheet) st.sheet.hidden = true; });
