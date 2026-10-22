// 麦当劳 MCP 的极简客户端：Streamable HTTP + JSON-RPC，零依赖（Node 18+ 自带 fetch）
import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const DEFAULT_URL = 'https://mcp.mcd.cn';
const PROTOCOL_VERSION = '2025-03-26';

// 优先读环境变量，其次读项目根目录的 .env（已 gitignore）
export function loadToken() {
  if (process.env.MCD_MCP_TOKEN) return process.env.MCD_MCP_TOKEN.trim();
  const envFile = join(dirname(fileURLToPath(import.meta.url)), '..', '.env');
  if (existsSync(envFile)) {
    const m = readFileSync(envFile, 'utf8').match(/^\s*MCD_MCP_TOKEN\s*=\s*(.+?)\s*$/m);
    if (m) return m[1].replace(/^["']|["']$/g, '');
  }
  return '';
}

export class McpError extends Error {
  constructor(message, { status, code } = {}) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

export class McdMcpClient {
  constructor({ token = loadToken(), url = process.env.MCD_MCP_URL || DEFAULT_URL } = {}) {
    if (!token) {
      throw new McpError('没有找到 MCD_MCP_TOKEN：请在 https://open.mcd.cn/mcp 申请 Token，并设置环境变量或写入 .env');
    }
    this.token = token;
    this.url = url;
    this.sessionId = null;
    this.nextId = 1;
    this.initialized = false;
  }

  async #post(body) {
    const headers = {
      'Content-Type': 'application/json',
      Accept: 'application/json, text/event-stream',
      Authorization: `Bearer ${this.token}`,
    };
    if (this.sessionId) headers['Mcp-Session-Id'] = this.sessionId;
    if (this.initialized) headers['MCP-Protocol-Version'] = PROTOCOL_VERSION;

    const res = await fetch(this.url, { method: 'POST', headers, body: JSON.stringify(body) });
    const sid = res.headers.get('mcp-session-id');
    if (sid) this.sessionId = sid;

    if (res.status === 401) throw new McpError('MCP Token 无效、已过期或未提供（401）', { status: 401 });
    if (res.status === 429) throw new McpError('触发限流（每个 Token 每分钟最多 600 次），请稍后再试（429）', { status: 429 });
    if (res.status === 202 || body.id === undefined) return null;
    if (!res.ok) throw new McpError(`MCP 服务返回 HTTP ${res.status}: ${(await res.text()).slice(0, 300)}`, { status: res.status });

    const type = res.headers.get('content-type') || '';
    const text = await res.text();
    const message = type.includes('text/event-stream') ? pickSseResponse(text, body.id) : JSON.parse(text);
    if (!message) throw new McpError('MCP 响应里没有找到对应的 JSON-RPC 结果');
    if (message.error) throw new McpError(`MCP 错误 ${message.error.code}: ${message.error.message}`, { code: message.error.code });
    return message.result;
  }

  async #request(method, params) {
    return this.#post({ jsonrpc: '2.0', id: this.nextId++, method, params });
  }

  async connect() {
    if (this.initialized) return this.serverInfo;
    const result = await this.#request('initialize', {
      protocolVersion: PROTOCOL_VERSION,
      capabilities: {},
      clientInfo: { name: 'mcd-coudan', version: '0.1.0' },
    });
    this.serverInfo = result?.serverInfo;
    this.initialized = true;
    await this.#post({ jsonrpc: '2.0', method: 'notifications/initialized' });
    return this.serverInfo;
  }

  async listTools() {
    await this.connect();
    const tools = [];
    let cursor;
    do {
      const result = await this.#request('tools/list', cursor ? { cursor } : {});
      tools.push(...(result.tools || []));
      cursor = result.nextCursor;
    } while (cursor);
    return tools;
  }

  // 返回 { raw, data, text }：data 为解析出的结构化内容（如果有），text 为原始文本
  async callTool(name, args = {}) {
    await this.connect();
    const raw = await this.#request('tools/call', { name, arguments: args });
    const text = (raw.content || []).filter((c) => c.type === 'text').map((c) => c.text).join('\n');
    if (raw.isError) throw new McpError(`工具 ${name} 调用失败：${text.slice(0, 500)}`);
    const data = raw.structuredContent ?? extractJson(text);
    return { raw, data, text };
  }
}

// 麦当劳 MCP 的文本结果常是「给模型的展示说明 + JSON」，这里取出其中的 JSON 对象
// （JSON 可能在行首，也可能紧跟在 Markdown 表格的 | 后面，所以按括号配对截取）
export function extractJson(text) {
  for (let i = text.indexOf('{"'); i !== -1; i = text.indexOf('{"', i + 1)) {
    const end = matchBrace(text, i);
    if (end === -1) continue;
    try {
      const obj = JSON.parse(text.slice(i, end + 1));
      if ('data' in obj || 'success' in obj) return obj;
    } catch { /* 继续找下一个起点 */ }
  }
  return undefined;
}

function matchBrace(text, start) {
  let depth = 0;
  let inString = false;
  for (let i = start; i < text.length; i++) {
    const ch = text[i];
    if (inString) {
      if (ch === '\\') i++;
      else if (ch === '"') inString = false;
    } else if (ch === '"') inString = true;
    else if (ch === '{') depth++;
    else if (ch === '}' && --depth === 0) return i;
  }
  return -1;
}

function pickSseResponse(text, id) {
  let found = null;
  for (const event of text.split(/\r?\n\r?\n/)) {
    const payload = event.split(/\r?\n/).filter((l) => l.startsWith('data:')).map((l) => l.slice(5).trimStart()).join('\n');
    if (!payload) continue;
    try {
      const msg = JSON.parse(payload);
      if (msg.id === id) found = msg;
    } catch { /* 忽略非 JSON 事件 */ }
  }
  return found;
}
