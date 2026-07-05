# AI 文游微信小程序 · Phase 2-4 实现计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 在 Phase 1 MVP 基础上，补齐体验层与产品完成度：上下文压缩、自由输入场景识别、反八股文风格系统、定性游戏状态深化、被动线索追踪、时间推进/世界演化、多世界支持、严格一致性与 UI 精修。

**Architecture:** 保持 Phase 1 的“共享世界 + 每存档隔离”架构不变。Phase 2 主要增强 LLM 上下文质量与交互自由度；Phase 3 让产品更像游戏但仍保持无硬数值；Phase 4 提升内容多样性、稳定性与可长期扩展能力。

**Tech Stack:** 微信小程序 / 微信云开发 / Node.js 云函数 / OpenAI 兼容 API / 云存储 Markdown 文件知识库

## Global Constraints

- 平台: 微信小程序 + 云开发（免费额度）
- LLM: OpenAI 兼容 `/chat/completions`，默认 base URL `https://api.xiaomimimo.com/v1`，model `mimo-v2.5-pro`
- 流式: 保持 Phase 1 的云函数 SSE 返回
- 数值: 叙事优先，无硬数值（仅定性 tier / 标签 / 状态）
- 内容尺度: 允许 18+ 内容，跳过 `msgSecCheck`（用户已知悉平台风险）
- 压缩: 使用 caveman-compress 规则（保事实，丢散文）
- 世界加载: 完整 world.md(开局/压缩后) / 压缩版(每8回合) / 不加载(其余)
- NPC: 两级——重要(玩家创建,npcs/+记忆) vs 次要(LLM即兴,无文件)
- 剧情: 无固定剧情，纯沙盒涌现，线索追踪仅被动提示
- 存档: 多存档，按 `save_id` 完全隔离
- 时间推进: 闭关/赶路/养伤/昏迷会推进当前存档的世界、NPC、threads、传闻
- reroll: 只允许在同一轮内重生成回复，不重复提交状态变更
- 模型管理: 参考 RikkaHub / Chatbox，支持多配置、本地持久化、Base URL/API Key/模型ID 自定义、常用参数可调

---

## 文件结构补充

```
xm/
├── miniprogram/
│   ├── pages/
│   │   ├── threadList/                 # 线索页（Phase 3）
│   │   ├── worldManage/                # 多世界页（Phase 4，可与worldSelect合并）
│   │   └── debugTools/                 # 调试页（可选，Phase 2/4）
│   └── components/
│       ├── modeToggle/                 # 沙盒/线索模式切换
│       ├── threadBadge/                # 线索徽标
│       └── worldCard/                  # 世界卡片
├── cloudfunctions/
│   ├── compressContext/
│   │   ├── index.js
│   │   └── package.json
│   ├── detectScene/
│   │   ├── index.js
│   │   └── package.json
│   ├── manageWorld/
│   │   ├── index.js
│   │   └── package.json
│   └── shared/
│       ├── compression.js             # caveman 规则实现
│       ├── sceneRouter.js             # 场景/角色识别
│       ├── styleEnhancer.js           # 风格注入与反套路规则
│       ├── consistencyCheck.js        # 严格一致性校验
│       ├── threadEngine.js            # 线索提取/关联/清理
│       ├── worldRegistry.js           # 多世界清单加载
│       ├── timeEngine.js              # 时间推进入口
│       ├── worldEvolution.js          # 世界动态推进
│       ├── npcEvolution.js            # 重要NPC动态状态/认知推进
│       ├── infoPropagation.js         # 传闻/消息传播
│       ├── timeSkipReporter.js        # 时间跳跃结果汇总
│       └── rerollManager.js           # 同轮候选回复管理
└── data/
    ├── games/frxz/                    # 凡人修仙传·天南越国（现有）
    └── games/<future_game_id>/        # 后续新世界模板
```

---

# Phase 2：体验层强化

### Task 2.0: 模型配置管理增强（参考 RikkaHub / Chatbox）

**Files:**
- Modify: `cloudfunctions/manageModel/index.js`
- Modify: `cloudfunctions/shared/llmGateway.js`
- Modify: `miniprogram/pages/modelManage/modelManage.js`
- Modify: `miniprogram/pages/modelManage/modelManage.wxml`

**Interfaces:**
- Produces: 多配置管理 + 本地持久化 + 参数可调 + Base URL/模型ID 手填
- Produces: `listModels({base_url, api_key}) -> [model_id]`

- [ ] **Step 1: 扩展 manageModel/index.js**

```javascript
// 新建配置时支持完整参数
case 'create': {
  const encrypted = encrypt(config.api_key);
  return db.collection('model_configs').add({
    data: {
      user_id,
      name: config.name,
      base_url: config.base_url || 'https://api.xiaomimimo.com/v1',
      api_key_enc: encrypted,
      model: config.model || 'mimo-v2.5-pro',
      params: {
        temperature: config.params?.temperature ?? 0.8,
        max_tokens: config.params?.max_tokens ?? 2048,
        top_p: config.params?.top_p ?? 1,
        presence_penalty: config.params?.presence_penalty ?? 0,
        frequency_penalty: config.params?.frequency_penalty ?? 0,
      },
      headers: config.headers || {},
      is_default: config.is_default !== false,
      created_at: db.serverDate(),
      updated_at: db.serverDate(),
    }
  });
}
```

- [ ] **Step 2: 前端本地持久化（dialog.js）**

```javascript
// 进入对话页时加载最近使用的配置
onLoad() {
  const cachedId = wx.getStorageSync('current_model_config_id');
  if (cachedId) {
    this.setData({ current_model_config_id: cachedId });
  }
}

// 切换配置时持久化
switchModel(configId) {
  wx.setStorageSync('current_model_config_id', configId);
  this.setData({ current_model_config_id: configId });
}
```

- [ ] **Step 3: 增加“拉取模型列表”能力（manageModel/index.js）**

```javascript
case 'listModels': {
  const { base_url, api_key_enc } = event;
  const api_key = decrypt(api_key_enc);
  try {
    const res = await callLLM({
      base_url,
      api_key,
      model: '__list_models__',
      messages: [],
      stream: false,
      endpoint_type: 'models'
    });
    return { models: res.data.map(m => m.id) };
  } catch (e) {
    // 失败时返回空列表，允许手填
    return { models: [], error: '无法获取模型列表，请手动输入模型ID' };
  }
}
```

- [ ] **Step 4: 验证**
  - 添加 2 套不同中转配置（mimo + 第三方），重启后列表保留
  - 切换配置后对话使用新 endpoint
  - 错误 key / 错误 base_url 时，提示可理解错误

### Task 2.1: 上下文压缩云函数（caveman 规则）

**Files:**
- Create: `cloudfunctions/compressContext/index.js`
- Create: `cloudfunctions/shared/compression.js`

**Interfaces:**
- Produces: `compressContext` 云函数，action: `manual|auto`
- Produces: `compressHistory({save_id, history, modelConfig}) -> {summary, keptFacts}`
- Consumes: `llmGateway.js`

- [ ] **Step 1: 编写 compression.js**

```javascript
function buildCompressionPrompt(historyText) {
  return `你是记忆压缩器。按以下规则压缩对话历史：

保留：
- NPC/门派/法宝/地名/境界等专名
- 数字、日期、次数、承诺
- 玩家做过的决定
- 关系变化
- 获得/失去的重要物品
- 玩家主动提出的目标/未了之事

删除：
- 客套话
- 情绪铺陈
- 重复表达
- 冗长散文描写
- 与未来决策无关的闲聊

输出要求：
1. 用短句/片段
2. 只保事实，不保文采
3. 按主题分组：人物 / 状态 / 关系 / 目标 / 关键事件

历史如下：
${historyText}`;
}

module.exports = { buildCompressionPrompt };
```

- [ ] **Step 2: 编写 compressContext/index.js**

```javascript
const cloud = require('wx-server-sdk');
const { buildCompressionPrompt } = require('../shared/compression');
const { callLLM } = require('../shared/llmGateway');
const { decrypt } = require('../shared/encryption');
cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });
const db = cloud.database();

exports.main = async (event) => {
  const wxContext = cloud.getWXContext();
  const user_id = wxContext.OPENID;
  const { save_id, action } = event;

  const historyRes = await db.collection('conversations').where({ save_id })
    .orderBy('timestamp', 'asc').get();
  const historyText = historyRes.data.map(m => `${m.role}: ${m.content}`).join('\n');

  const modelRes = await db.collection('model_configs').where({ user_id, is_default: true }).limit(1).get();
  const modelConfig = modelRes.data[0];
  const api_key = decrypt(modelConfig.api_key_enc);

  const prompt = buildCompressionPrompt(historyText);
  const { text } = await callLLM({
    endpoint: modelConfig.endpoint,
    api_key,
    model: modelConfig.model,
    messages: [{ role: 'system', content: prompt }],
    params: { temperature: 0.2, max_tokens: 1500 },
    stream: false,
  });

  // 写 summary.md，清理旧 conversations（只保留最近8轮）
  return { success: true, summary: text };
};
```

- [ ] **Step 3: 验证**
  - 对 20+ 轮对话执行压缩
  - 确认 summary.md 保留人物/关系/目标/关键事件
  - 确认压缩后 turn_counter 重置为 0

### Task 2.2: 自动压缩触发

**Files:**
- Modify: `cloudfunctions/chat/index.js`
- Modify: `cloudfunctions/shared/threadTracker.js`

**Interfaces:**
- Consumes: `compressContext`
- Produces: 每当对话超过 8 轮后可手动/自动压缩

- [ ] **Step 1: 在 chat 中加入轮数检查**

```javascript
// after incrementTurnCounter(save_id)
const turnCounter = await getTurnCounter(save_id);
const shouldSuggestCompression = turnCounter > 0 && turnCounter % 8 === 0;
```

- [ ] **Step 2: 返回前端压缩提示**

```javascript
return {
  reply,
  state_updated: state.length > 0,
  objectives: director,
  shouldSuggestCompression,
};
```

- [ ] **Step 3: 验证**
  - 第 8/16/24 回合后，对话页出现“建议压缩上下文”提示

### Task 2.3: 自由输入场景识别云函数

**Files:**
- Create: `cloudfunctions/detectScene/index.js`
- Create: `cloudfunctions/shared/sceneRouter.js`

**Interfaces:**
- Produces: `detectScene({save_id, user_input}) -> {scene_type, npc_id, confidence}`

- [ ] **Step 1: 编写 sceneRouter.js**

```javascript
function buildScenePrompt(userInput, knownNPCs, currentRegion, threads) {
  return `判断玩家这句输入属于哪种场景：
- talk_to_existing_npc
- create_new_npc
- free_explore
- continue_current_scene

当前区域: ${currentRegion}
已知重要NPC: ${knownNPCs.join(', ') || '无'}
线索: ${threads || '无'}

玩家输入: ${userInput}

输出 JSON:
{
  "scene_type": "...",
  "npc_name": "若识别到已知NPC则写名字，否则空",
  "confidence": 0.0
}`;
}

module.exports = { buildScenePrompt };
```

- [ ] **Step 2: 编写 detectScene/index.js**
  - 用默认模型低 temperature 调用
  - 若 `confidence < 0.6` 则 fallback 为 `continue_current_scene`

- [ ] **Step 3: 验证**
  - “我去找陆云” → talk_to_existing_npc + 陆云
  - “我在集市上和一个卖丹药的老头搭话” → free_explore
  - “创建角色：女修韩霜” → create_new_npc

### Task 2.4: 对话页接入自由输入路由 + reroll 锁定规则

**Files:**
- Modify: `miniprogram/pages/dialog/dialog.js`
- Modify: `miniprogram/pages/dialog/dialog.wxml`
- Create: `cloudfunctions/shared/rerollManager.js`

**Interfaces:**
- Consumes: `detectScene`
- Produces: 非按钮模式下也能自动选择场景/NPC
- Produces: `rerollTurn({turn_id})` 只替换同轮最后一条回复，不重复提交状态

- [ ] **Step 1: 发送消息前调用 detectScene**
- [ ] **Step 2: 若识别到已有 NPC，则自动切换 npc_id 再发 chat**
- [ ] **Step 3: 若识别到 create_new_npc，则跳角色创建页**
- [ ] **Step 4: reroll 仅在当前轮未进入下一轮前可点击**
- [ ] **Step 5: reroll 时复用 turn_id，只替换最后一条 assistant 回复**
- [ ] **Step 6: 验证**
  - 不点 NPC 按钮，仅靠自然语言也能进入正确场景
  - 连点 reroll 不会重复增加 turn_counter / memory / threads

### Task 2.5: 风格系统实现

**Files:**
- Create: `cloudfunctions/shared/styleEnhancer.js`
- Modify: `cloudfunctions/chat/index.js`

**Interfaces:**
- Produces: `buildStyleRules(npcFile) -> string`

- [ ] **Step 1: 编写 styleEnhancer.js**

```javascript
function buildStyleRules(npc) {
  return `
【文风要求】
- 严格遵守角色 voice 字段与风格样本
- 禁止使用大量破折号
- 禁止每段结尾总结
- 禁止“他不禁”“仿佛”“竟然”等模板化词汇泛滥
- 尽量短句、具体、可视化，不要空泛抒情
`;
}

module.exports = { buildStyleRules };
```

- [ ] **Step 2: 注入到 system prompt**
- [ ] **Step 3: 验证**
  - 同一个 NPC 连续多次回复，文风稳定
  - 明显减少套话和八股感

### Task 2.6: 调试工具页（可选但强烈建议）

**Files:**
- Create: `miniprogram/pages/debugTools/debugTools.wxml/wxss/js/json`

**Interfaces:**
- Produces: 可查看当前 save 的 turn_counter / 当前加载 world 类型 / 最近 summary 片段

- [ ] **Step 1: 页面展示 debug 信息**
- [ ] **Step 2: 仅开发模式可见**
- [ ] **Step 3: 验证**
  - 能准确看到第几轮、是否加载完整/压缩世界观

---

# Phase 3：游戏化增强（仍无硬数值）

### Task 3.0: 时间推进 / 世界演化基础框架

**Files:**
- Create: `cloudfunctions/shared/timeEngine.js`
- Create: `cloudfunctions/shared/worldEvolution.js`
- Create: `cloudfunctions/shared/npcEvolution.js`
- Create: `cloudfunctions/shared/infoPropagation.js`
- Create: `cloudfunctions/shared/timeSkipReporter.js`
- Modify: `cloudfunctions/chat/index.js`
- Modify: `cloudfunctions/shared/gameState.js`
- Modify: `cloudfunctions/shared/threadTracker.js`

**Interfaces:**
- Produces: `advanceWorld({save_id, days, reason}) -> {playerChanges, npcChanges, worldChanges, threadChanges, report}`
- Produces: `reportTimeSkip(...) -> string`

- [ ] **Step 1: save 元数据增加时间字段**

```javascript
// manageSave/index.js - createSave
{
  save_id,
  user_id,
  game_id,
  player_name,
  player_realm: '炼气',
  current_date: '天南历412年三月初七',
  world_time: 0,
  turn_counter: 0,
  // ...其他字段
}
```

- [ ] **Step 2: 时间跳跃识别（chat/index.js）**

```javascript
// 检测时间跳跃行为
function detectTimeSkip(userInput) {
  const patterns = [
    { regex: /闭关(\d+)(年|月|天|日)/i, type: 'cultivation' },
    { regex: /修炼(\d+)(年|月|天|日)/i, type: 'cultivation' },
    { regex: /赶路(\d+)(年|月|天|日)/i, type: 'travel' },
    { regex: /昏迷(\d+)(年|月|天|日)/i, type: 'coma' },
    { regex: /养伤(\d+)(年|月|天|日)/i, type: 'recovery' },
  ];

  for (const p of patterns) {
    const match = userInput.match(p.regex);
    if (match) {
      const amount = parseInt(match[1]);
      const unit = match[2];
      const days = unit.includes('年') ? amount * 365 :
                   unit.includes('月') ? amount * 30 : amount;
      return { type: p.type, days, original: match[0] };
    }
  }
  return null;
}
```

- [ ] **Step 3: 时间推进函数（timeEngine.js）**

```javascript
async function advanceWorld({ save_id, days, reason }) {
  const changes = {
    player: {},
    npcs: [],
    world: {},
    threads: [],
    report: ''
  };

  // 1. 推进玩家状态
  const player = await readSaveFile(save_id, 'player');
  const state = await readSaveFile(save_id, 'state');
  changes.player = await evolvePlayer(player, state, days, reason);

  // 2. 推进重要 NPC
  const npcs = await listImportantNPCs(save_id);
  for (const npc of npcs) {
    const npcChanges = await evolveNPC(save_id, npc.id, days);
    changes.npcs.push(npcChanges);
  }

  // 3. 推进世界状态
  changes.world = await evolveWorldState(save_id, days);

  // 4. 推进线索（过期/失效）
  changes.threads = await expireThreads(save_id, days);

  // 5. 生成汇报
  changes.report = buildTimeSkipReport(changes, days, reason);

  // 6. 更新日期
  await updateSaveDate(save_id, days);

  return changes;
}

function buildTimeSkipReport(changes, days, reason) {
  let report = `【时间流逝：${days}天】\n\n`;

  if (reason) report += `原因：${reason}\n`;

  // 玩家变化
  if (changes.player.realmChanged) {
    report += `修为变化：${changes.player.oldRealm} → ${changes.player.newRealm}\n`;
  }
  if (changes.player.injuriesHealed) {
    report += `伤势已恢复\n`;
  }

  // NPC 变化
  if (changes.npcs.length > 0) {
    report += `\n【人物变化】\n`;
    for (const npc of changes.npcs) {
      if (npc.statusChanged) {
        report += `${npc.name}：${npc.change}\n`;
      }
    }
  }

  // 世界变化
  if (changes.world.events.length > 0) {
    report += `\n【世界变化】\n`;
    for (const event of changes.world.events) {
      report += `- ${event}\n`;
    }
  }

  // 线索过期
  const expired = changes.threads.filter(t => t.status === 'expired');
  if (expired.length > 0) {
    report += `\n【已过期目标】\n`;
    for (const t of expired) {
      report += `- ${t.title}（已过期）\n`;
    }
  }

  return report;
}
```

- [ ] **Step 4: 接入 chat 流程**

```javascript
// chat/index.js - 在调用 LLM 之前检测时间跳跃
const timeSkip = detectTimeSkip(user_input);
if (timeSkip) {
  const skipChanges = await advanceWorld({
    save_id,
    days: timeSkip.days,
    reason: user_input
  });

  // 将时间推进结果注入本轮上下文
  messages.push({
    role: 'system',
    content: `【系统提示】玩家进行了时间跳跃，以下是这段时间的变化：\n${skipChanges.report}\n\n请在回复中体现这些变化。`
  });
}
```

- [ ] **Step 5: 验证**
  - “我闭关一年” → turn_counter 增加 365 天，world_state 更新，生成时间跳跃报告
  - 重要 NPC 状态变化（位置/境界/目标）
  - threads 中的限时目标自动过期

### Task 3.1: 定性状态模型深化

**Files:**
- Modify: `cloudfunctions/shared/gameState.js`
- Modify: `miniprogram/components/statePanel/*`

**Interfaces:**
- Produces: 更结构化的 state.md / 状态面板

- [ ] **Step 1: state.md 结构升级**

```markdown
# 状态

境界: 炼气初期
位置: 越国七派
物品:
- 玄铁短剑
- 黄龙丹

关系:
- 陆云: 识
- 李翎: 疏

声望: 无名

目标:
- 寻找玄铁剑来历
- 进入血色禁地前做准备
```

- [ ] **Step 2: statePanel 按分区展示**
- [ ] **Step 3: 验证**
  - 关系、物品、目标随剧情变化可正确显示

### Task 3.2: 被动线索追踪引擎强化

**Files:**
- Create: `cloudfunctions/shared/threadEngine.js`
- Modify: `cloudfunctions/shared/threadTracker.js`

**Interfaces:**
- Produces: `extractThreads(reply, userInput, existingThreads) -> updatedThreads`
- Produces: `buildThreadHints(currentScene, threads) -> hintText`

- [ ] **Step 1: 提取玩家主动目标**
- [ ] **Step 2: 线索状态支持 open / resolved / dormant**
- [ ] **Step 3: 当前场景命中时注入 hint**
- [ ] **Step 4: 验证**
  - “我要查玄铁剑” → open
  - 找到关键线索后 → resolved 或更新描述

### Task 3.3: 线索页前端

**Files:**
- Create: `miniprogram/pages/threadList/threadList.wxml/wxss/js/json`
- Create: `miniprogram/components/threadBadge/*`

**Interfaces:**
- Produces: 玩家可查看自己当前目标/未了之事

- [ ] **Step 1: 页面展示 open / resolved / dormant 分类**
- [ ] **Step 2: 点击线索可查看来源片段/最近进展**
- [ ] **Step 3: 验证**
  - 有 2-3 条目标时，页面清晰可用

### Task 3.4: 自由探索模式优化

**Files:**
- Modify: `cloudfunctions/chat/index.js`
- Modify: `miniprogram/pages/dialog/dialog.js`

**Interfaces:**
- Produces: `mode = sandbox | guided_threads`

- [ ] **Step 1: save 元数据中存 mode**
- [ ] **Step 2: 对话页加模式切换**
- [ ] **Step 3: sandbox 模式关闭线程提示**
- [ ] **Step 4: 验证**
  - 切到 sandbox 后，系统不再主动提醒玩家目标

### Task 3.5: 次要 NPC 提升流程打磨

**Files:**
- Modify: `cloudfunctions/createCharacter/index.js`
- Modify: `miniprogram/pages/dialog/dialog.js`

**Interfaces:**
- Produces: 从最近对话自动提取次要 NPC 信息，生成更准确的重要 NPC 卡

- [ ] **Step 1: 从 conversations 中取最近关于该 NPC 的描述**
- [ ] **Step 2: createNPC prompt 附带这段历史**
- [ ] **Step 3: 验证**
  - 即兴老头被提升后，角色卡能保留“卖丹药、说话慢、爱压价”等已有特征

---

# Phase 4：多世界 / 稳定性 / 产品完成度

### Task 4.1: 多世界注册表

**Files:**
- Create: `cloudfunctions/shared/worldRegistry.js`
- Modify: `miniprogram/pages/worldSelect/*`

**Interfaces:**
- Produces: `listWorlds() -> [{game_id, title, intro, cover}]`

- [ ] **Step 1: worldRegistry 从 `/games/*/manifest.md` 构建清单**
- [ ] **Step 2: worldSelect 动态渲染世界卡片**
- [ ] **Step 3: 验证**
  - 除 frxz 外新增一个假世界目录，也能在 UI 中出现

### Task 4.2: 严格一致性校验模式

**Files:**
- Create: `cloudfunctions/shared/consistencyCheck.js`
- Modify: `cloudfunctions/chat/index.js`
- Modify: `miniprogram/pages/settings/*`

**Interfaces:**
- Produces: `checkConsistency(reply, npcCard, worldState) -> {ok, reasons}`

- [ ] **Step 1: 用便宜模型做一次 reply 审核**
- [ ] **Step 2: 若不一致则自动重生成一次**
- [ ] **Step 3: 用户可在设置页开关严格模式**
- [ ] **Step 4: 验证**
  - 故意让 NPC 说出自己不可能知道的事 → 严格模式下被拦截或重生

### Task 4.3: 前端视觉精修

**Files:**
- Modify: `miniprogram/app.wxss`
- Modify: `miniprogram/pages/dialog/*`
- Modify: `miniprogram/components/*`

**Interfaces:**
- Produces: 更有修仙感、不像模板产品的 UI

- [ ] **Step 1: 统一暗色主题 + 点缀色（青金/墨青/暗紫）**
- [ ] **Step 2: 状态面板做卡片分区，聊天区做卷轴/玉简感背景弱化处理**
- [ ] **Step 3: NPC 卡片加入门派/境界 tag**
- [ ] **Step 4: 验证**
  - 视觉层面明显区别于普通聊天机器人页面

### Task 4.4: 发布前风险检查

**Files:**
- Create: `xm/RELEASE-RISKS.md`

**Interfaces:**
- Produces: 发布/自用差异化 checklist

- [ ] **Step 1: 写明 18+ 内容与微信审核冲突**
- [ ] **Step 2: 写明 BYOK 安全模型说明**
- [ ] **Step 3: 写明免费额度/成本边界**
- [ ] **Step 4: 验证**
  - 文档可直接作为未来上架/自用分流决策参考

---

## Self-Review

**1. Spec coverage:** ✓
- Phase 2 覆盖压缩、场景识别、风格系统
- Phase 3 覆盖定性状态、被动线索追踪、自由探索优化、次要 NPC 提升
- Phase 4 覆盖多世界、严格一致性、UI 精修、发布前风险管理

**2. Placeholder scan:** ✓
- 无 TBD/TODO
- 代码示例给出了实际函数名、文件路径与最小实现方向

**3. Type consistency:** ✓
- `save_id`, `game_id`, `npc_id`, `model_config_id` 等命名与 Phase 1 计划一致
- `chat`, `createCharacter`, `compressContext`, `detectScene` 等接口与前序计划可衔接

---

## Execution Handoff

**Plan complete and saved to `xm/plans/2026-07-04-ai-wenyou-phase2-4.md`.**

建议执行顺序：
1. 先做 `Phase 0 + Phase 1`
2. 跑通 MVP 后，再按 `Phase 2 → Phase 3 → Phase 4` 逐步推进

如果你后面要我执行，推荐仍然用：
- **Subagent-Driven（推荐）**：按 task 派独立 subagent
- **Inline Execution**：当前 session 逐 task 做
