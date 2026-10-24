#!/usr/bin/env node
// 麦门凑单大师 · 实时语音点餐服务
//   node src/voice/server.js          只在本机 http://localhost:8787 提供服务（电脑端）
//   node src/voice/server.js --lan    局域网 HTTPS（手机端，浏览器要求 HTTPS 才能用麦克风）
//   部署到 Render 等平台时自动监听 0.0.0.0:$PORT，HTTPS 由平台提供
import { createServer as createHttp } from 'node:http';
import { createServer as createHttps } from 'node:https';
import { readFileSync, existsSync, mkdirSync } from 'node:fs';
import { join, dirname, extname, normalize, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { networkInterfaces } from 'node:os';
import { execFileSync } from 'node:child_process';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { parseArgs } from 'node:util';
import { acceptUpgrade } from './ws-server.js';
import { VoiceSession } from './session.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const WEB = join(ROOT, 'web');
const CERT_DIR = join(ROOT, '.mcd-coudan', 'cert');
const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png' };

const { values: opt } = parseArgs({
  options: {
    lan: { type: 'boolean', default: false },
    port: { type: 'string', default: process.env.PORT || '8787' },
    host: { type: 'string', default: process.env.HOST || '' },
    help: { type: 'boolean', short: 'h', default: false },
  },
});

if (opt.help) {
  console.log(`实时语音点餐服务

  node src/voice/server.js            电脑端：http://localhost:8787
  node src/voice/server.js --lan      手机端：局域网 HTTPS，自动生成自签证书
  --port <端口>                        默认 8787（或环境变量 PORT）
  --host <地址>                        默认只监听本机；--lan 或在 Render 上运行时为 0.0.0.0

需要的配置（环境变量或项目根目录 .env）：
  MCD_MCP_TOKEN   麦当劳 MCP Token
  VOLC_API_KEY    火山引擎豆包语音 API Key（控制台 > API Key 管理）
  VOLC_VOICE      可选，音色 ID，默认 zh_female_vv_jupiter_bigtts
  VOICE_ACCESS_KEY 可选，访问口令，不设则每次启动随机生成`);
  process.exit(0);
}

// 环境变量优先，其次读 .env
function env(name) {
  if (process.env[name]) return process.env[name].trim();
  const file = join(ROOT, '.env');
  if (!existsSync(file)) return '';
  const m = readFileSync(file, 'utf8').match(new RegExp(`^\\s*${name}\\s*=\\s*(.+?)\\s*$`, 'm'));
  return m ? m[1].replace(/^["']|["']$/g, '') : '';
}

const apiKey = env('VOLC_API_KEY');
const voice = env('VOLC_VOICE') || 'zh_female_vv_jupiter_bigtts';
const upstreamUrl = env('VOLC_REALTIME_URL') || undefined; // 一般不用设，调试时可指向模拟服务
const accessKey = env('VOICE_ACCESS_KEY') || randomBytes(6).toString('hex');
if (!apiKey) {
  console.error('✖ 没有找到 VOLC_API_KEY：请在火山引擎控制台 > 豆包语音 > API Key 管理 创建，并写入 .env');
  process.exit(1);
}
if (!env('MCD_MCP_TOKEN')) {
  console.error('✖ 没有找到 MCD_MCP_TOKEN：请在 https://open.mcd.cn/mcp 申请，并写入 .env');
  process.exit(1);
}

// 只要真正的局域网地址；198.18.x 是代理软件 TUN 模式的虚拟网卡，手机连不上
function lanIps() {
  const rank = (ip) => (/^192\.168\./.test(ip) ? 0 : /^10\./.test(ip) ? 1 : /^172\.(1[6-9]|2\d|3[01])\./.test(ip) ? 2 : 9);
  return Object.values(networkInterfaces()).flat()
    .filter((n) => n && n.family === 'IPv4' && !n.internal)
    .map((n) => n.address)
    .filter((ip) => rank(ip) < 9)
    .sort((a, b) => rank(a) - rank(b));
}

// 局域网用自签证书：手机首次打开需要在浏览器里选择「继续访问」
function ensureCert(ips) {
  const key = join(CERT_DIR, 'key.pem');
  const cert = join(CERT_DIR, 'cert.pem');
  if (!existsSync(key) || !existsSync(cert)) {
    mkdirSync(CERT_DIR, { recursive: true });
    const san = ['DNS:localhost', 'IP:127.0.0.1', ...ips.map((ip) => `IP:${ip}`)].join(',');
    try {
      execFileSync('openssl', [
        'req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-sha256', '-days', '825',
        '-keyout', key, '-out', cert, '-subj', '/CN=mcd-coudan-voice', '-addext', `subjectAltName=${san}`,
      ], { stdio: 'ignore' });
    } catch {
      console.error('✖ 生成 HTTPS 证书需要 openssl（Git for Windows 自带）。也可以自己把 key.pem / cert.pem 放到 .mcd-coudan/cert/');
      process.exit(1);
    }
  }
  return { key: readFileSync(key), cert: readFileSync(cert) };
}

const sameKey = (a = '') => a.length === accessKey.length && timingSafeEqual(Buffer.from(a), Buffer.from(accessKey));
const isLocal = (req) => ['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(req.socket.remoteAddress);
const port = Number(opt.port);
const scheme = opt.lan ? 'https' : 'http';
const ips = opt.lan ? lanIps() : [];
// Render 会设置 RENDER 和 RENDER_EXTERNAL_URL，平台在前面做 HTTPS 终结，本服务只需监听 HTTP
const publicUrl = process.env.RENDER_EXTERNAL_URL || '';
const host = opt.host || (opt.lan || process.env.RENDER ? '0.0.0.0' : '127.0.0.1');

function handle(req, res) {
  const url = new URL(req.url, 'http://x');
  // 电脑页面用来生成手机扫码地址，只回答本机请求
  if (url.pathname === '/api/info') {
    const phone = isLocal(req) && ips.length ? `https://${ips[0]}:${port}/?k=${accessKey}` : null;
    res.writeHead(200, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify({ phone }));
  }
  const rel = normalize(url.pathname === '/' ? '/index.html' : decodeURIComponent(url.pathname)).replace(/^([/\\])+/, '');
  const file = join(WEB, rel);
  if (!file.startsWith(WEB + sep) || !existsSync(file)) {
    res.writeHead(404);
    return res.end('not found');
  }
  res.writeHead(200, { 'Content-Type': TYPES[extname(file)] ?? 'application/octet-stream', 'Cache-Control': 'no-cache' });
  res.end(readFileSync(file));
}

const server = opt.lan ? createHttps(ensureCert(ips), handle) : createHttp(handle);
let seq = 0;

server.on('upgrade', (req, socket, head) => {
  const url = new URL(req.url, 'http://x');
  if (url.pathname !== '/ws' || !sameKey(url.searchParams.get('k') ?? '')) {
    socket.end('HTTP/1.1 403 Forbidden\r\n\r\n');
    return;
  }
  const browser = acceptUpgrade(req, socket, head);
  if (!browser) return socket.destroy();
  const id = ++seq;
  const log = (m) => console.log(`[会话 ${id}] ${m}`);
  log(`已连接 ${req.socket.remoteAddress}`);
  const session = new VoiceSession(browser, { apiKey, voice, url: upstreamUrl, log });
  browser.on('binary', (buf) => session.onBrowserAudio(buf));
  browser.on('text', (text) => {
    let msg;
    try { msg = JSON.parse(text); } catch { return; }
    session.onBrowserCommand(msg).catch((err) => session.error(err.message));
  });
  browser.on('close', () => { log('已断开'); session.close(); });
  session.start();
});

server.listen(port, host, () => {
  console.log('🍔 麦门凑单大师 · 实时语音点餐\n');
  if (publicUrl) {
    console.log(`   线上地址：${publicUrl}/?k=${accessKey}`);
    if (!process.env.VOICE_ACCESS_KEY) console.log('   ⚠ 没有设置 VOICE_ACCESS_KEY，口令每次重启都会变；建议在平台环境变量里固定一个足够长的随机口令。');
    console.log('   链接里的 k 是访问口令，持有链接的人可以用你的账户下单，不要外传。\n');
    return;
  }
  console.log(`   电脑打开：${scheme}://localhost:${port}/?k=${accessKey}`);
  for (const ip of ips) console.log(`   手机打开：https://${ip}:${port}/?k=${accessKey}`);
  if (opt.lan) console.log('\n   手机需和电脑在同一个 Wi-Fi；首次打开会提示证书不受信任，选「继续访问」即可。');
  else console.log('\n   要在手机上用，请加 --lan 重新启动。');
  console.log('   链接里的 k 是访问口令，持有链接的人可以用你的账户下单，不要外传。\n');
});
