---
name: mcd-coudan
description: 麦门凑单大师：给定人数和预算，用麦当劳 MCP 实时菜单、门店券和 calculate-price 算出「最省钱 / 吃最饱 / 最超值」三套点单方案，确认后可直接下单。当用户说"几个人多少钱怎么点麦当劳最划算""帮我凑一单麦当劳""预算 XX 元点麦当劳""麦当劳怎么点最省钱""聚餐点麦当劳"，或提到麦当劳凑单、麦门省钱时使用。
---

# 麦门凑单大师

把「N 个人、X 元预算，麦当劳怎么点最划算」变成三套经过麦当劳官方实时算价的方案：

- **最省钱**：满足每人主食（+小食+饮料）的前提下，到手价最低
- **吃最饱**：预算内总热量最高
- **最超值**：比单点省下的比例最高

## 前置条件

- 已在 https://open.mcd.cn/mcp 申请麦当劳 MCP Token
- 二选一：
  - **CLI 模式**（推荐）：Node.js 18+，Token 放在环境变量 `MCD_MCP_TOKEN` 或项目根目录 `.env`
  - **纯 MCP 模式**：客户端（WorkBuddy / Cursor / Claude Code 等）已配置 `mcd-mcp` 连接器，见 `mcp-config.example.json`

## 第一步：问清需求

开始前确认以下信息，缺什么问什么，不要自行假设预算：

| 信息 | 例子 | 默认 |
|---|---|---|
| 人数 | 3 人 | 必问 |
| 预算（总额，元） | 100 元 | 可不设，不设时只按价格优化 |
| 取餐方式 | 到店自取（城市 + 地点）/ 麦乐送 | 必问 |
| 每人需要什么 | 主食+小食+饮料 / 只要主食+饮料 | 主食+小食+饮料 |
| 忌口 | 不吃牛肉、不吃辣、不喝咖啡 | 无 |

## 第二步：生成方案

### CLI 模式

在项目根目录运行（加 `--json` 方便解析）：

```bash
node src/cli.js plan --people 3 --budget 100 --city 上海 --near 人民广场 --json
node src/cli.js plan --people 2 --budget 80 --delivery --avoid 牛肉,辣 --json
```

参数说明：`--no-side` 不要小食，`--no-drink` 不要饮料，`--avoid beef,pork,fish,spicy,coffee`（也可写中文：牛肉/猪肉/鱼/辣/咖啡），`--exclude 关键词` 排除指定餐品，`--variety` 让同款餐品不超过人数的一半。

JSON 里 `plans[]` 的每一项包含：`label` 策略名、`price` 到手价（元，含配送费和打包费）、`discount` 比单点省的金额、`kcal` 估算热量、`lines[]` 餐品明细（`parts` 是套餐组成）。

### 纯 MCP 模式（没有 Node 环境时）

按下面的顺序调用 mcd-mcp 工具：

1. **定门店**
   - 到店：`query-nearby-stores`（`beType=1, searchType=2, city, keyword`），选最近且 `businessStatus=true` 的门店。后续调用都不传 `beCode`，`orderType=1`。
   - 外送：`delivery-query-addresses` → `delivery-query-stores`（`beType=2`），拿到 `storeCode + beCode`，`orderType=2`。
2. **拉菜单**：`query-meals`。价格以 `currentPrice` 为准，但 `discountType` 含「随单购」时必须按 `originalPrice` 算，因为那个优惠价要另买麦金卡/早餐卡才有。
3. **看套餐组成**：对编码以 `99` 开头的套餐调用 `query-meal-detail`，按每轮 `isDefault=1` 的选项判断它能覆盖几份主食/小食/饮料。
4. **查券**：`query-store-coupons`；有券时，用 `calculate-price` 带 `couponId + couponCode` 试算券后价。
5. **搭配**：每人一份主食（汉堡/卷/麦满分等）、一份小食、一份饮料，在预算内分别找出最省钱、热量最高、比单点省比例最高的组合。不要加入补不上缺口的多余餐品。热量可参考 `list-nutrition-foods`。
6. **校验**：每个方案都必须用 `calculate-price` 校验，以返回的 `price`（单位：分，要除以 100）为准。超预算的方案直接淘汰。

## 第三步：展示方案

每个方案展示：策略名、到手价、人均、比单点省多少、约多少千卡、餐品明细（套餐写出组成），外送还要列出配送费和打包费。结尾提示：价格已由麦当劳实时校验，餐品和价格以官方渠道为准。

## 第四步：下单（必须用户明确确认）

- **只有用户明确说「就这个，下单」并指定了方案时才能下单。** 下单前复述门店、餐品、金额，到店还要复述取餐方式（堂食/外带）。
- CLI：`node src/cli.js order --pick <序号>` 先预览，用户确认后再加 `--confirm`。到店可加 `--take-way eat-in`，外送可加 `--remark`。
- 纯 MCP：`create-order`，`items` 与校验时完全一致；到店必须带 `takeWayCode`（取值来自 `calculate-price` 返回的 `takeWayList`），外送必须带 `addressId`。
- 下单后给出支付链接，提醒用户在链接里或麦当劳 App 内完成支付。之后可以用 `query-order` 查进度。

## 可选：先领券再凑单

麦麦省里有可领的券时，先问用户要不要领：`node src/cli.js claim` 预览，确认后 `claim --confirm`（MCP 工具是 `available-coupons` / `auto-bind-coupons`）。领完重新生成方案，可用的券会被自动算进去。

## 语音点餐

用户想「直接说话点餐」或在手机上用时，提示他在 `.env` 里配置 `VOLC_API_KEY`（豆包端到端实时语音），然后运行 `npm run voice`（电脑）或 `npm run voice -- --lan`（手机，局域网 HTTPS），打开终端里打印的链接。语音模型只能弹出确认卡片，下单必须由用户在页面上点击确认。

## 注意

- 不要编造餐品、价格或优惠。所有价格以 MCP 实时返回为准。
- 热量是按默认搭配估算的，仅供参考，不构成营养建议。
- 每个 Token 每分钟最多 600 次请求。CLI 会把套餐详情按门店和日期缓存，避免重复请求。
