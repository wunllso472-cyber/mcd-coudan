# 🍔 麦门凑单大师 mcd-coudan

> 「3 个人，100 块，麦当劳怎么点最划算？」——交给它。

麦门凑单大师是一个基于 **麦当劳 MCP** 的 Skill + 零依赖 Node CLI。告诉它人数、预算和取餐方式，它会读取门店的**实时菜单、套餐组成和你账户里的可用券**，在所有组合里搜出三套方案，并逐个用麦当劳官方 `calculate-price` 校验**到手价**：

| 方案 | 含义 |
|---|---|
| 💰 最省钱 | 保证每人都有主食（+小食+饮料），到手价最低 |
| 🍗 吃最饱 | 预算内总热量最高 |
| 🏷 最超值 | 比单点省下的比例最高 |

挑好方案后，一句命令就能下单，拿到支付链接。

也可以**直接开口点**：接入豆包端到端实时语音（全双工），电脑和手机浏览器都能用。说一句「三个人一百块，到店自取，上海人民广场」，它边听边算，把三套方案念给你听，同时显示在屏幕上；你说「就要第三个，外带」，屏幕上会弹出确认卡片，点一下就下单。

## 为什么不直接问 AI？

让大模型自己凑单，常见的坑有这几个：

- **算错价**：带「随单购麦金卡优惠」的套餐，菜单上显示 32 元，可不随单购卡的话实际要 58.5 元。本项目统一按不买卡的真实价格计算，最后再用 `calculate-price` 兜底校验。
- **漏组合**：一家门店有 100 多个餐品、60 多个套餐，人工或大模型很难穷举。本项目用帕累托动态规划，一次搜出价格、热量、优惠三个维度上的最优解。
- **多点了**：自动剔除「去掉也够吃」的冗余餐品。
- **漏券**：会读取门店可用券，逐张试算券后价，再放进组合里比较。

## 真实运行示例

以下是 2026-10-22 在上海一家门店的真实输出（价格由麦当劳 MCP 实时返回）：

```
$ node src/cli.js plan --people 3 --budget 100 --city 上海 --near 人民广场

🍔 麦当劳上海黄浦华旭国际大厦餐厅
   3 人 · 每人 主食+小食+饮料 · 预算 ¥100 · 候选 113 个

【1】最省钱  到手 ¥56.30（人均 ¥18.77）  比单点省 ¥0  约 1714 千卡
    精选超值随心配 ×2  ¥27.80
      └ 那么大鸡排（椒盐风味） / 怡泉+C麦炫酷
    汉堡开心乐园餐 ×1  ¥23.50
      └ 汉堡包 / 迷你薯条 / 苹果片一袋(60g) / 纯牛奶
    圆筒冰淇淋 ×1  ¥5

【2】吃最饱  到手 ¥75.60（人均 ¥25.20）  比单点省 ¥60.80  约 2745 千卡
    大堡口福三件套 ×2  ¥45.80
      └ Hold不住鸡排堡（椒盐风味） / 中薯条 / 可乐中杯
    “我就喜欢”鸡薯双全盒 ×1  ¥15.90
      └ 5块心形薯饼 / 5块麦乐鸡
    精选超值随心配 ×1  ¥13.90
      └ 那么大鸡排（椒盐风味） / 怡泉+C麦炫酷

【3】最超值  到手 ¥68.70（人均 ¥22.90）  比单点省 ¥72.30  约 2538 千卡
    大堡口福三件套 ×3  ¥68.70
      └ Hold不住鸡排堡（椒盐风味） / 中薯条 / 可乐中杯

价格已由麦当劳 calculate-price 实时校验。下单：mcd-coudan order --pick <序号> --confirm
```

外送场景的到手价会自动算上配送费和打包费：

```
$ node src/cli.js plan --people 2 --budget 80 --delivery
【2】吃最饱  到手 ¥78.80（人均 ¥39.40）  比单点省 ¥66.20  约 1904 千卡
    大堡口福四件套（双层脆鸡堡） ×2  ¥69.80
      └ 双层脆鸡堡 / 中薯条 / 麦乐鸡5块 / 可口可乐中杯
    配送费 ¥6  打包费 ¥3
```

> 菜单和价格随门店、时间变化，以上仅为示例。

## 安装

需要 Node.js 22 或更高版本（语音点餐用到 Node 自带的 WebSocket 客户端），不需要 `npm install`，没有任何第三方依赖。

```bash
git clone <本仓库地址>
cd mcd-coudan
cp .env.example .env      # 在 .env 中填入 MCD_MCP_TOKEN=你的Token
```

Token 申请方法：登录 https://open.mcd.cn/mcp → 控制台 → 激活，然后复制 Token。也可以直接设置环境变量 `MCD_MCP_TOKEN`。

## 使用

```bash
# 查附近门店
node src/cli.js stores --city 上海 --near 人民广场

# 生成方案（到店自取：自动选最近的营业门店；也可以用 --store 指定门店编号）
node src/cli.js plan --people 3 --budget 100 --city 上海 --near 人民广场

# 麦乐送（默认用账户里的第一个配送地址，可用 --address-id 指定）
node src/cli.js plan --people 2 --budget 80 --delivery

# 忌口 & 搭配
node src/cli.js plan --people 4 --budget 150 --store 1450713 --avoid 牛肉,辣 --no-side --variety

# 下单：先预览，确认后加 --confirm
node src/cli.js order --pick 3
node src/cli.js order --pick 3 --confirm --take-way eat-in

# 麦麦省领券：先预览，确认后一键领取，再凑单时会自动用上
node src/cli.js claim
node src/cli.js claim --confirm
```

| 参数 | 说明 |
|---|---|
| `--people` | 人数，1~20 |
| `--budget` | 总预算（元），含配送费和打包费 |
| `--no-side` / `--no-drink` | 每人不需要小食 / 饮料 |
| `--avoid` | 忌口：`beef/pork/fish/spicy/coffee`，或中文：牛肉/猪肉/鱼/辣/咖啡 |
| `--exclude` | 排除名称包含关键词的餐品，逗号分隔 |
| `--variety` | 同款餐品最多点人数的一半 |
| `--json` | 输出 JSON，给 Agent 用 |

## 语音点餐（电脑 + 手机）

在 `.env` 里加上 `VOLC_API_KEY`（火山引擎控制台 → 豆包语音 → API Key 管理，需要开通端到端实时语音），然后：

```bash
npm run voice              # 电脑：打开终端里打印的 http://localhost:8787/?k=… 链接
npm run voice -- --lan     # 手机：局域网 HTTPS，电脑页面右侧会出现扫码入口
```

- **全双工对话**：可以随时插话打断。页面默认开启「播报时不收音」，避免外放时把自己的声音录进去；戴耳机时可以关掉，体验真正的边说边听。
- **手机为什么要 `--lan`**：浏览器只在 HTTPS 或 localhost 下开放麦克风。`--lan` 会用 openssl 生成自签证书（Git for Windows 自带 openssl），手机第一次打开时选「继续访问」即可。手机和电脑要连同一个 Wi-Fi。
- **访问口令**：链接里的 `k` 是访问口令，每次启动随机生成（也可以用 `VOICE_ACCESS_KEY` 固定下来）。拿到链接的人能用你的账户下单，不要外传。
- **下单只能手点**：语音模型最多只能弹出确认卡片，必须在屏幕上点「确认下单」才会调用 `create-order`。

```
浏览器（麦克风 16k PCM / 播放 24k PCM）
   ⇅ WebSocket（本机或局域网）
本地服务 src/voice/  ──持有 VOLC_API_KEY 和 MCD_MCP_TOKEN，浏览器里没有任何密钥
   ⇅ wss://openspeech.bytedance.com/api/v3/duplex/realtime/dialogue（Seeduplex，JSON 事件）
豆包实时语音：听 → 理解 → Function Calling
   └─ make_plans / prepare_order / order_status ─► 麦当劳 MCP
```

## 作为 Skill 使用

`skills/mcd-coudan/SKILL.md` 是给 AI Agent 用的 Skill 说明，WorkBuddy、Claude Code 等支持 Skill 的客户端都能用。它支持两种模式：

- **CLI 模式**：Agent 先问清人数、预算和取餐方式，再调用 `node src/cli.js plan --json`，把结果整理后展示给用户。
- **纯 MCP 模式**：客户端里只配置了 `mcd-mcp` 连接器（见 `mcp-config.example.json`）时，Agent 按 SKILL.md 里的调用顺序，直接调用麦当劳 MCP 工具完成凑单。

无论哪种模式，下单前都必须得到用户的明确确认。

## 目标用户

- 和同事、同学一起点麦当劳，想在预算内让每个人都吃上一份完整套餐的人
- 月底钱包紧张、想把每一块钱都花明白的麦门信徒
- 想要「多少钱吃最饱」这种直接答案的打工人

## 工作原理

```
门店 ─► query-meals（实时菜单） ─► query-meal-detail（套餐组成，按日缓存）
                                   │
list-nutrition-foods（热量） ──────┤
query-store-coupons（可用券）──► calculate-price 试算券后价
                                   ▼
             餐品画像：每份能喂饱几份 主食/小食/饮料 + 热量 + 真实单价
                                   ▼
    帕累托 DP：状态 = 已满足的(主食,小食,饮料)份数，保留价格/热量/优惠互不支配的组合
                                   ▼
        每种策略取前 3 名 ─► calculate-price 校验到手价 ─► 选出三套方案
```

更详细的 MCP 调用说明见 [MCP_INTEGRATION.md](MCP_INTEGRATION.md)。

## 开发

```bash
npm test                     # 单元测试（优化器、分类、营养匹配、价格规则、语音会话协议）
node src/probe.js            # 拉取 MCP 全部工具的 schema，写入 debug/（已 gitignore）
node src/probe.js query-meals '{"storeCode":"1450713","orderType":1,"beType":1}'
```

## 声明

本项目是麦当劳程序员节创意开发大赛的参赛作品，由参赛者独立开发，不是麦当劳官方产品。项目输出仅供参考，不构成医疗、营养或其他专业建议；餐品信息、价格和供应状态以麦当劳官方渠道的实时结果为准。仓库中不包含任何真实 Token，配置文件只使用环境变量占位符。详见 [CONTEST_DECLARATION.md](CONTEST_DECLARATION.md)。

License: MIT
