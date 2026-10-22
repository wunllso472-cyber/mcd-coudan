#!/usr/bin/env node
// 开发用：拉取工具 schema，并对只读工具做一次真实调用，结果写到 debug/（已 gitignore）
// 用法：node src/probe.js            列出全部工具 schema
//       node src/probe.js <tool> '<json参数>'   调用单个工具并保存返回
import { mkdirSync, writeFileSync } from 'node:fs';
import { McdMcpClient } from './mcp-client.js';

const client = new McdMcpClient();
mkdirSync('debug', { recursive: true });

const [tool, argJson] = process.argv.slice(2);
if (!tool) {
  const info = await client.connect();
  const tools = await client.listTools();
  writeFileSync('debug/tools.json', JSON.stringify({ serverInfo: info, tools }, null, 2));
  for (const t of tools) {
    const props = Object.keys(t.inputSchema?.properties || {});
    const required = t.inputSchema?.required || [];
    console.log(`${t.name}(${props.map((p) => (required.includes(p) ? p : p + '?')).join(', ')})`);
  }
  console.log(`\n共 ${tools.length} 个工具，完整 schema 已写入 debug/tools.json`);
} else {
  const res = await client.callTool(tool, argJson ? JSON.parse(argJson) : {});
  const file = `debug/${tool}.json`;
  writeFileSync(file, JSON.stringify(res.data ?? res.raw, null, 2));
  console.log(res.text.slice(0, 3000));
  console.log(`\n完整返回已写入 ${file}`);
}
