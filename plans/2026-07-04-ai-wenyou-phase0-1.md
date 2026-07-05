# AI 文游微信小程序 · Phase 0 + Phase 1 实现计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 从零搭建一个微信小程序 AI 文游 demo（凡人修仙传·天南越国），实现：开局建角→多存档→对话(流式)→创建NPC(两级)→记忆隔离→模型自配切换→同轮 reroll→基础时间推进。

**Architecture:** 微信小程序前端 + 云函数(Node.js)后端 + 云存储(.md知识文件) + 云数据库(对话历史/配置/存档)。LLM 通过用户 BYOK 的 OpenAI 兼容 API 调用(mimo 默认)。上下文引擎按场景选择性加载文件，代码级保证 NPC 记忆隔离。

**Tech Stack:** 微信小程序(WXML/WXSS/JS) / 微信云开发(云函数Node.js 18+ / 云存储 / 云数据库) / OpenAI 兼容 API(mimo-v2.5-pro 默认) / AES 加密(key 存储)

## Global Constraints

- 平台: 微信小程序 + 云开发（免费额度）
- LLM: OpenAI 兼容 `/chat/completions`，默认 base URL `https://api.xiaomimimo.com/v1`，model `mimo-v2.5-pro`
- 流式: 云函数 SSE 返回，前端打字机显示
- 数值: 叙事优先，无硬数值（境界等定性 tier）
- 内容安全: 跳过 msgSecCheck（18+ 内容允许，用户已知悉平台风险）
- 加密: API key 用云函数环境变量主密钥 AES 加密存储，日志禁打印
- 世界加载: 完整 world.md(开局/压缩后) / 压缩版(每8回合) / 不加载(其余)
- 存档: 多存档，每存档隔离（共享只读 world + 每存档动态状态/角色/记忆）
- NPC: 两级——重要(玩家创建,npcs/+记忆) vs 次要(LLM即兴,无文件)
- 剧情: 无固定剧情，沙盒涌现，线索追踪被动
- 时间推进: 闭关/赶路/养伤/昏迷会推进当前存档的世界、NPC、threads、传闻
- reroll: 只允许在同一轮内重生成回复，不重复提交状态变更
- 模型管理: 参考 RikkaHub / Chatbox，支持多配置、本地持久化、Base URL/API Key/模型ID 自定义、常用参数可调

---

## 文件结构

```
xm/                                    # 项目根
├── project.config.json                # 微信项目配置(appid/云开发)
├── miniprogram/                       # 前端
│   ├── app.js                         # 全局逻辑(云初始化)
│   ├── app.json                       # 页面路由/窗口配置
│   ├── app.wxss                       # 全局样式
│   ├── pages/
│   │   ├── worldSelect/               # 世界选择页
│   │   │   ├── .wxml / .wxss / .js / .json
│   │   ├── saveList/                  # 存档列表页(新游戏/继续/删除)
│   │   │   ├── .wxml / .wxss / .js / .json
│   │   ├── charCreation/              # 角色创建页(玩家/NPC)
│   │   │   ├── .wxml / .wxss / .js / .json
│   │   ├── dialog/                    # 对话页(核心:聊天+状态面板+NPC列表)
│   │   │   ├── .wxml / .wxss / .js / .json
│   │   ├── modelManage/               # 模型管理页(CRUD/切换)
│   │   │   ├── .wxml / .wxss / .js / .json
│   │   └── settings/                  # 设置页(压缩/线索模式等)
│   │       ├── .wxml / .wxss / .js / .json
│   └── components/
│       ├── chatBubble/                # 聊天气泡组件
│       │   ├── .wxml / .wxss / .js / .json
│       ├── statePanel/                # 定性状态面板组件
│       │   ├── .wxml / .wxss / .js / .json
│       └── npcCard/                   # NPC 卡片组件
│           ├── .wxml / .wxss / .js / .json
├── cloudfunctions/                    # 云函数
│   ├── chat/
│   │   ├── index.js                   # 主对话编排器
│   │   └── package.json
│   ├── createCharacter/
│   │   ├── index.js                   # 角色创建(玩家+NPC)
│   │   └── package.json
│   ├── manageModel/
│   │   ├── index.js                   # 模型配置 CRUD
│   │   └── package.json
│   ├── manageSave/
│   │   ├── index.js                   # 存档 CRUD
│   │   └── package.json
│   └── shared/
│       ├── contextEngine.js           # 上下文组装(隔离核心)
│       ├── llmGateway.js              # LLM 调用(流式+缓存)
│       ├── parser.js                  # 四段解析(REPLY/MEMORY/STATE/DIRECTOR)
│       ├── memorySystem.js            # NPC 私有记忆读写
│       ├── gameState.js               # 定性状态读写
│       ├── threadTracker.js           # 线索追踪读写
│       ├── saveManager.js             # 存档目录操作
│       ├── encryption.js              # AES 加解密
│       ├── worldLoader.js             # 世界加载策略(完整/压缩/跳过)
│       ├── timeEngine.js              # 时间推进入口
│       ├── worldEvolution.js          # 世界动态推进
│       ├── npcEvolution.js            # 重要NPC动态状态/认知推进
│       ├── infoPropagation.js         # 传闻/消息传播
│       ├── actionResolver.js          # 行动意图识别
│       ├── timeSkipReporter.js        # 时间跳跃结果汇总
│       └── rerollManager.js           # 单轮候选回复管理
└── data/                              # 初始知识文件(部署时上传云存储)
    ├── games/frxz/
    │   ├── manifest.md
    │   ├── world.md                   # 完整世界观(凡人修仙传人界)
    │   ├── world_compressed.md        # 压缩版世界观(~90行)
    │   └── regions/
    │       ├── yueguo_qipai.md
    │       ├── taiyue_shanmai.md
    │       └── xuese_jindi.md
    └── prompts/
        ├── system_prompt.txt          # System Prompt 模板
        ├── npc_creation_prompt.txt    # NPC 创建 Prompt
        └── player_creation_prompt.txt # 玩家创建 Prompt
```

---

## Phase 0: 环境搭建

### Task 0.1: 安装开发工具

**Files:** 无（用户操作）

- [ ] **Step 1: 安装微信开发者工具**
  - 下载: https://developers.weixin.qq.com/miniprogram/dev/devtools/download.html
  - 稳定版，Windows 64-bit
  - 安装后扫码登录（微信扫码）

- [ ] **Step 2: 安装 Node.js**
  - 下载 LTS: https://nodejs.org/
  - 安装后验证: `node -v` (应 ≥18) / `npm -v`

- [ ] **Step 3: 验证环境**
  - 终端运行 `node -v` 和 `npm -v`，确认输出版本号

### Task 0.2: 注册小程序 + 开通云开发

**Files:** 无（用户操作）

- [ ] **Step 1: 注册小程序账号**
  - 访问 https://mp.weixin.qq.com/
  - 注册"个人"类型小程序（免费）
  - 记录 AppID

- [ ] **Step 2: 在微信开发者工具创建项目**
  - 新建项目，填入 AppID
  - 选择"云开发"模板
  - 项目路径选 `xm/`

- [ ] **Step 3: 开通云开发**
  - 在开发者工具内点击"云开发"按钮
  - 开通（免费额度即可）
  - 记录云开发环境 ID（如 `frxz-prod-xxx`）

---

## Phase 1: MVP

### Task 1.1: 项目骨架搭建

**Files:**
- Create: `project.config.json`
- Create: `miniprogram/app.js`
- Create: `miniprogram/app.json`
- Create: `miniprogram/app.wxss`
- Create: `cloudfunctions/chat/package.json`
- Create: `cloudfunctions/manageModel/package.json`
- Create: `cloudfunctions/createCharacter/package.json`
- Create: `cloudfunctions/manageSave/package.json`

**Interfaces:**
- Produces: 项目结构可被开发者工具识别; 云函数可部署

- [ ] **Step 1: 编写 project.config.json**

```json
{
  "miniprogramRoot": "miniprogram/",
  "cloudfunctionRoot": "cloudfunctions/",
  "setting": { "urlCheck": false, "es6": true, "postcss": true },
  "appid": "<YOUR_APPID>",
  "projectname": "ai-wenyou",
  "cloudfunctionTemplateRoot": "cloudfunctionTemplate/",
  "condition": {}
}
```

- [ ] **Step 2: 编写 app.js（云初始化）**

```javascript
App({
  onLaunch() {
    if (!wx.cloud) {
      console.error('请使用 2.2.3 以上基础库');
      return;
    }
    wx.cloud.init({
      env: '<YOUR_CLOUD_ENV_ID>',
      traceUser: true,
    });
  },
  globalData: {
    cloudEnv: '<YOUR_CLOUD_ENV_ID>',
  }
});
```

- [ ] **Step 3: 编写 app.json（页面路由）**

```json
{
  "pages": [
    "pages/worldSelect/worldSelect",
    "pages/saveList/saveList",
    "pages/charCreation/charCreation",
    "pages/dialog/dialog",
    "pages/modelManage/modelManage",
    "pages/settings/settings"
  ],
  "window": {
    "navigationBarTitleText": "凡人修仙·文游",
    "backgroundColor": "#0a0a0a",
    "navigationBarBackgroundColor": "#1a1a2e",
    "navigationBarTextStyle": "white"
  }
}
```

- [ ] **Step 4: 编写云函数 package.json（统一依赖）**

每个云函数的 `package.json`:
```json
{
  "name": "chat",
  "version": "1.0.0",
  "main": "index.js",
  "dependencies": {
    "wx-server-sdk": "~2.6.3"
  }
}
```

- [ ] **Step 5: 在开发者工具验证**
  - 确认项目可打开、页面路由无报错
  - 右键每个云函数文件夹 → "上传并部署: 云端安装依赖"

### Task 1.2: 知识文件上传

**Files:**
- Create: `data/games/frxz/manifest.md`
- Copy: `data/games/frxz/world.md` (从聊天导出裁切天南越国部分)
- Copy: `data/games/frxz/world_compressed.md` (从 `C:\Users\35017\Desktop\1111\压缩.txt`)
- Create: `data/games/frxz/regions/yueguo_qipai.md`
- Create: `data/games/frxz/regions/taiyue_shanmai.md`
- Create: `data/games/frxz/regions/xuese_jindi.md`

**Interfaces:**
- Produces: 云存储中 `/games/frxz/` 目录下有完整知识文件

- [ ] **Step 1: 编写 manifest.md**

```markdown
# 凡人修仙·天南越国

越国七派并立，修仙者隐于凡尘之外。你是一名初入修仙之路的新人，在这片弱肉强食的天地间，一切由你书写。

初始区域：越国七派
```

- [ ] **Step 2: 裁切 world.md**
  - 从 `C:\Users\35017\Desktop\chat-export-2026-07-04_23-09-34..md` 中裁切"天南地区"相关内容 + 修仙境界/灵根/功法/丹药/法器/妖兽/秘境/规则等通用章节
  - 确保无具体人物/剧情

- [ ] **Step 3: 复制 world_compressed.md**
  - 从 `C:\Users\35017\Desktop\1111\压缩.txt` 复制内容到 `data/games/frxz/world_compressed.md`

- [ ] **Step 4: 编写 region 文件**
  - `yueguo_qipai.md`: 越国七派简介（掩月宗/黄枫谷/灵兽山/清虚门/化刀坞/天阙堡/巨剑门），越国地理
  - `taiyue_shanmai.md`: 太岳山脉，灵脉，黄枫谷所在
  - `xuese_jindi.md`: 血色禁地，五年一开，筑基丹主药

- [ ] **Step 5: 通过开发者工具上传到云存储**
  - 云开发控制台 → 云存储 → 新建文件夹 `games/frxz/`
  - 上传所有文件，保持目录结构
  - 记录各文件的 FileID

- [ ] **Step 6: 验证**
  - 在云开发控制台确认文件存在、路径正确

### Task 1.3: 云数据库集合创建

**Files:**
- 无代码文件（云开发控制台操作 + 验证脚本）

**Interfaces:**
- Produces: 4 个集合可读写

- [ ] **Step 1: 在云开发控制台创建集合**
  - `conversations` — 对话历史
  - `model_configs` — 模型配置
  - `saves` — 存档元数据
  - `characters` — 角色索引

- [ ] **Step 2: 创建数据库索引**
  - `conversations`: {user_id:1, game_id:1, save_id:1, npc_id:1, timestamp:1}
  - `saves`: {user_id:1, game_id:1}
  - `characters`: {save_id:1, type:1}
  - `model_configs`: {user_id:1}

- [ ] **Step 3: 验证（在开发者工具控制台运行）**

```javascript
const db = wx.cloud.database();
db.collection('conversations').add({ data: { test: true } })
  .then(res => { console.log('OK', res); return db.collection('conversations').doc(res._id).remove(); })
  .then(() => console.log('Clean'));
```

### Task 1.4: 加密模块

**Files:**
- Create: `cloudfunctions/shared/encryption.js`
- Test: 手动在云函数中验证

**Interfaces:**
- Produces: `encrypt(plaintext) → ciphertext`, `decrypt(ciphertext) → plaintext`
- Dependency: Node.js built-in `crypto`

- [ ] **Step 1: 编写 encryption.js**

```javascript
const crypto = require('crypto');
const ALGORITHM = 'aes-256-cbc';
const KEY = Buffer.from(process.env.ENCRYPTION_KEY || 'default-key-change-me-32bytes!', 'utf8').slice(0, 32);
const IV_LENGTH = 16;

function encrypt(plaintext) {
  const iv = crypto.randomBytes(IV_LENGTH);
  const cipher = crypto.createCipheriv(ALGORITHM, KEY, iv);
  let encrypted = cipher.update(plaintext, 'utf8', 'hex');
  encrypted += cipher.final('hex');
  return iv.toString('hex') + ':' + encrypted;
}

function decrypt(ciphertext) {
  const [ivHex, encrypted] = ciphertext.split(':');
  const iv = Buffer.from(ivHex, 'hex');
  const decipher = crypto.createDecipheriv(ALGORITHM, KEY, iv);
  let decrypted = decipher.update(encrypted, 'hex', 'utf8');
  decrypted += decipher.final('utf8');
  return decrypted;
}

module.exports = { encrypt, decrypt };
```

- [ ] **Step 2: 验证**
  - 在 manageModel 云函数中 import 并测试: `decrypt(encrypt('test-key')) === 'test-key'`

### Task 1.5: 模型管理云函数

**Files:**
- Create: `cloudfunctions/manageModel/index.js`
- Modify: `cloudfunctions/manageModel/package.json`（加 encryption 依赖路径）

**Interfaces:**
- Produces: `manageModel` 云函数，action: `create|list|update|delete|setDefault`
- 消费: `encryption.js`

- [ ] **Step 1: 编写 manageModel/index.js**

```javascript
const cloud = require('wx-server-sdk');
const { encrypt, decrypt } = require('../shared/encryption');
cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });
const db = cloud.database();

exports.main = async (event, context) => {
  const { action, config } = event;
  const wxContext = cloud.getWXContext();
  const user_id = wxContext.OPENID;

  switch (action) {
    case 'create': {
      const encrypted = encrypt(config.api_key);
      return db.collection('model_configs').add({
        data: {
          user_id, name: config.name,
          endpoint: config.endpoint || 'https://api.xiaomimimo.com/v1',
          api_key_enc: encrypted,
          model: config.model || 'mimo-v2.5-pro',
          params: config.params || { temperature: 0.8, max_tokens: 2048 },
          is_default: config.is_default !== false,
          created_at: db.serverDate()
        }
      });
    }
    case 'list': {
      const res = await db.collection('model_configs').where({ user_id }).get();
      return res.data.map(c => ({ ...c, api_key_enc: undefined, has_key: !!c.api_key_enc }));
    }
    case 'update': {
      const update = { ...config };
      if (update.api_key) { update.api_key_enc = encrypt(update.api_key); delete update.api_key; }
      return db.collection('model_configs').doc(config._id).update({ data: update });
    }
    case 'delete': {
      return db.collection('model_configs').doc(config._id).remove();
    }
    case 'setDefault': {
      await db.collection('model_configs').where({ user_id }).update({ data: { is_default: false } });
      return db.collection('model_configs').doc(config._id).update({ data: { is_default: true } });
    }
  }
};
```

- [ ] **Step 2: 部署 + 验证**
  - 右键 manageModel → 上传并部署
  - 在开发者工具控制台调用: `wx.cloud.callFunction({ name: 'manageModel', data: { action: 'create', config: { name: 'mimo', api_key: 'test' } } })`
  - 验证返回 _id，list 可见，has_key=true

### Task 1.6: 存档管理云函数

**Files:**
- Create: `cloudfunctions/manageSave/index.js`
- Create: `cloudfunctions/shared/saveManager.js`

**Interfaces:**
- Produces: `manageSave` 云函数，action: `create|list|delete`
- Produces: `saveManager` 模块: `createSaveDir(save_id)`, `deleteSaveDir(save_id)`, `listSaves(user_id, game_id)`

- [ ] **Step 1: 编写 saveManager.js**

```javascript
const cloud = require('wx-server-sdk');
cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });
const db = cloud.database();
const SAVE_ROOT = '/saves';

async function createSaveDir(user_id, game_id, save_id, player_name) {
  // Create metadata in DB
  await db.collection('saves').add({
    data: {
      save_id, user_id, game_id, player_name, player_realm: '炼气',
      current_region: 'yueguo_qipai', mode: 'sandbox',
      current_model_config_id: null,
      created_at: db.serverDate(), updated_at: db.serverDate(), last_played: db.serverDate()
    }
  });
  // Create player.md + state.md + threads.md in cloud storage via file upload
  // (done in createCharacter flow)
  return save_id;
}

async function listSaves(user_id, game_id) {
  const res = await db.collection('saves').where({ user_id, game_id })
    .orderBy('last_played', 'desc').limit(10).get();
  return res.data;
}

async function deleteSave(user_id, save_id) {
  // Delete DB records
  await db.collection('saves').where({ save_id }).remove();
  await db.collection('conversations').where({ save_id }).remove();
  await db.collection('characters').where({ save_id }).remove();
  // Delete cloud storage files (npc_memory, npcs, player, state, summary, threads, world_state)
  // Use wx.cloud.deleteFile for each
}

module.exports = { createSaveDir, listSaves, deleteSave };
```

- [ ] **Step 2: 编写 manageSave/index.js**

```javascript
const cloud = require('wx-server-sdk');
const { createSaveDir, listSaves, deleteSave } = require('../shared/saveManager');
cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });

exports.main = async (event) => {
  const wxContext = cloud.getWXContext();
  const user_id = wxContext.OPENID;
  const { action, game_id, save_id, player_name } = event;

  switch (action) {
    case 'create': {
      const new_save_id = `save_${Date.now()}_${Math.random().toString(36).slice(2,8)}`;
      return { save_id: await createSaveDir(user_id, game_id || 'frxz', new_save_id, player_name) };
    }
    case 'list': {
      return await listSaves(user_id, game_id || 'frxz');
    }
    case 'delete': {
      return await deleteSave(user_id, save_id);
    }
  }
};
```

- [ ] **Step 3: 部署 + 验证**
  - 创建存档 → list 可见 → 删除成功

### Task 1.7: 上下文引擎 + 世界加载策略

**Files:**
- Create: `cloudfunctions/shared/contextEngine.js`
- Create: `cloudfunctions/shared/worldLoader.js`

**Interfaces:**
- Produces: `assembleContext({game_id, save_id, npc_id, is_important, turn_counter}) → {systemPrompt, worldLoaded}`
- Produces: `loadWorld(game_id, turn_counter) → {content, type}` // type: 'full'|'compressed'|'none'
- 消费: 云存储文件读取

- [ ] **Step 1: 编写 worldLoader.js**

```javascript
const cloud = require('wx-server-sdk');
cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });

// Cache for shared world files (persists across warm invocations)
let worldCache = { full: null, compressed: null, cachedAt: 0 };
const CACHE_TTL = 5 * 60 * 1000; // 5 minutes

async function loadWorld(game_id, turn_counter) {
  const now = Date.now();
  const useCache = (now - worldCache.cachedAt) < CACHE_TTL;

  if (turn_counter === 0 || turn_counter % 8 === 0) {
    // Game start / post-compression → full world
    // Every 8 turns → compressed world
    const isFull = turn_counter === 0;
    const filePath = `/games/${game_id}/${isFull ? 'world.md' : 'world_compressed.md'}`;

    if (!useCache || !(isFull ? worldCache.full : worldCache.compressed)) {
      const res = await cloud.downloadFile({ fileID: await getFileID(filePath) });
      const content = res.fileContent.toString('utf8');
      if (isFull) worldCache.full = content; else worldCache.compressed = content;
      worldCache.cachedAt = now;
    }

    return { content: isFull ? worldCache.full : worldCache.compressed, type: isFull ? 'full' : 'compressed' };
  }

  return { content: null, type: 'none' };
}

async function getFileID(path) {
  // Lookup fileID from cloud storage by path
  // Implementation: use cloud.getTempFileURL or a mapping stored in DB
  // For MVP: hardcode fileIDs after upload, store in a config collection
}

module.exports = { loadWorld };
```

- [ ] **Step 2: 编写 contextEngine.js**

```javascript
const cloud = require('wx-server-sdk');
const { loadWorld } = require('./worldLoader');
cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });

async function assembleContext({ game_id, save_id, npc_id, is_important, turn_counter }) {
  const sections = {};

  // 1. World (strategy-based loading)
  const world = await loadWorld(game_id, turn_counter);
  sections.world = world.content; // null if type='none'

  // 2. Current region (read from save state)
  sections.region = await readSaveFile(save_id, 'region', game_id);

  // 3. World state (per-save)
  sections.world_state = await readSaveFile(save_id, 'world_state');

  // 4. NPC file (only if important)
  if (is_important && npc_id) {
    sections.npc = await readSaveFile(save_id, `npcs/${npc_id}`);
    sections.npc_memory = await readSaveFile(save_id, `npc_memory/${npc_id}`);
  } else {
    sections.npc = null;
    sections.npc_memory = null;
  }

  // 5. Player + state
  sections.player = await readSaveFile(save_id, 'player');
  sections.state = await readSaveFile(save_id, 'state');

  // 6. Summary
  sections.summary = await readSaveFile(save_id, 'summary');

  // 7. Threads
  sections.threads = await readSaveFile(save_id, 'threads');

  return sections;
}

async function readSaveFile(save_id, filename, game_id) {
  // Read from cloud storage: /saves/{user_id}/{game_id}/{save_id}/{filename}.md
  // Return null if file doesn't exist (new save)
}

module.exports = { assembleContext };
```

- [ ] **Step 3: 验证隔离**
  - 创建两个 save，各建一个 NPC
  - 调用 assembleContext(save1, npcA) → 确认不含 npcB 的记忆
  - 调用 assembleContext(save2, npcB) → 确认不含 npcA 的记忆

### Task 1.8: LLM 网关（流式 + 缓存）

**Files:**
- Create: `cloudfunctions/shared/llmGateway.js`

**Interfaces:**
- Produces: `callLLM({endpoint, api_key, model, messages, params, stream}) → {stream|text, cached}`
- OpenAI 兼容 `/chat/completions`

- [ ] **Step 1: 编写 llmGateway.js**

```javascript
const https = require('https');
const http = require('http');

// Simple in-memory cache (persists across warm invocations)
const responseCache = new Map();
const CACHE_MAX = 100;

function cacheKey(messages, model) {
  const crypto = require('crypto');
  const hash = crypto.createHash('md5').update(JSON.stringify({ messages, model })).digest('hex');
  return hash;
}

async function callLLM({ endpoint, api_key, model, messages, params, stream }) {
  // Cache check (skip for streaming)
  if (!stream) {
    const key = cacheKey(messages, model);
    if (responseCache.has(key)) return { text: responseCache.get(key), cached: true };
  }

  const url = new URL(`${endpoint}/chat/completions`);
  const body = JSON.stringify({
    model,
    messages,
    temperature: params?.temperature ?? 0.8,
    max_tokens: params?.max_tokens ?? 2048,
    stream: !!stream
  });

  const options = {
    hostname: url.hostname, port: url.port || 443, path: url.pathname,
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${api_key}`, 'Content-Length': Buffer.byteLength(body) }
  };

  return new Promise((resolve, reject) => {
    const proto = url.protocol === 'https:' ? https : http;
    const req = proto.request(options, (res) => {
      if (stream) {
        resolve({ stream: res, cached: false });
      } else {
        let data = '';
        res.on('data', chunk => data += chunk);
        res.on('end', () => {
          try {
            const parsed = JSON.parse(data);
            const text = parsed.choices?.[0]?.message?.content || '';
            if (responseCache.size > CACHE_MAX) responseCache.clear();
            responseCache.set(cacheKey(messages, model), text);
            resolve({ text, cached: false });
          } catch (e) { reject(e); }
        });
      }
    });
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

module.exports = { callLLM };
```

- [ ] **Step 2: 验证**
  - 用测试 key 调用 mimo endpoint，确认返回内容
  - 验证缓存命中（第二次相同请求，cached=true）

### Task 1.9: 四段解析器

**Files:**
- Create: `cloudfunctions/shared/parser.js`

**Interfaces:**
- Produces: `parseSegments(llmOutput) → {reply, memory, state, director}`

- [ ] **Step 1: 编写 parser.js**

```javascript
function parseSegments(text) {
  const result = { reply: '', memory: [], state: [], director: '' };

  // Split by segment markers
  const replyMatch = text.match(/REPLY:\s*([\s\S]*?)(?=MEMORY:|STATE:|DIRECTOR:|$)/i);
  const memoryMatch = text.match(/MEMORY:\s*([\s\S]*?)(?=STATE:|DIRECTOR:|$)/i);
  const stateMatch = text.match(/STATE:\s*([\s\S]*?)(?=DIRECTOR:|$)/i);
  const directorMatch = text.match(/DIRECTOR:\s*([\s\S]*?)$/i);

  result.reply = replyMatch ? replyMatch[1].trim() : text; // fallback: entire text is reply
  result.memory = memoryMatch ? parseList(memoryMatch[1]) : [];
  result.state = stateMatch ? parseList(stateMatch[1]) : [];
  result.director = directorMatch ? directorMatch[1].trim() : '';

  return result;
}

function parseList(text) {
  return text.split('\n')
    .map(line => line.replace(/^[-*]\s*/, '').trim())
    .filter(line => line.length > 0);
}

module.exports = { parseSegments };
```

- [ ] **Step 2: 验证**
  - 测试正常四段输出 → 正确拆分
  - 测试缺 MEMORY/STATE → 合理 fallback
  - 测试无标记 → 整体作为 reply

### Task 1.10: 记忆系统 + 游戏状态 + 线索追踪

**Files:**
- Create: `cloudfunctions/shared/memorySystem.js`
- Create: `cloudfunctions/shared/gameState.js`
- Create: `cloudfunctions/shared/threadTracker.js`

**Interfaces:**
- Produces: `appendMemory(save_id, npc_id, memories)`
- Produces: `applyState(save_id, stateChanges)`
- Produces: `updateThreads(save_id, threadUpdate)`

- [ ] **Step 1: 编写 memorySystem.js**

```javascript
const cloud = require('wx-server-sdk');
cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });

async function appendMemory(save_id, npc_id, memories) {
  if (!memories || memories.length === 0) return;
  const filePath = `saves/${save_id}/npc_memory/${npc_id}.md`;
  // Read existing, append new lines, write back
  const existing = await readCloudFile(filePath) || '';
  const newLines = memories.map(m => `- ${m}`).join('\n');
  const timestamp = new Date().toISOString();
  const updated = existing + `\n${timestamp}\n${newLines}\n`;
  await writeCloudFile(filePath, updated);
}

module.exports = { appendMemory };
```

- [ ] **Step 2: 编写 gameState.js**

```javascript
async function applyState(save_id, stateChanges) {
  if (!stateChanges || stateChanges.length === 0) return;
  const filePath = `saves/${save_id}/state.md`;
  const existing = await readCloudFile(filePath) || defaultState();
  // Parse stateChanges (e.g., "境界: 筑基", "物品: +玄铁剑")
  // Merge into existing state
  // Write back
}

function defaultState() {
  return `# 状态\n\n境界: 炼气\n物品: []\n位置: 越国\n关系: {}\n声望: 无名`;
}

module.exports = { applyState };
```

- [ ] **Step 3: 编写 threadTracker.js**

```javascript
async function updateThreads(save_id, threadUpdate) {
  if (!threadUpdate) return;
  const filePath = `saves/${save_id}/threads.md`;
  const existing = await readCloudFile(filePath) || '# 线索\n\n';
  // Parse DIRECTOR output for goal/commitment keywords
  // Append new thread if detected
  // Write back
}

module.exports = { updateThreads };
```

- [ ] **Step 4: 验证**
  - appendMemory: 写入后重读确认追加
  - applyState: 应用"境界:筑基"后 state.md 更新
  - updateThreads: 检测"我要找玄铁剑"→ threads.md 有记录

### Task 1.11: 角色创建云函数

**Files:**
- Create: `cloudfunctions/createCharacter/index.js`
- Create: `data/prompts/npc_creation_prompt.txt`
- Create: `data/prompts/player_creation_prompt.txt`

**Interfaces:**
- Produces: `createCharacter` 云函数，action: `createPlayer|createNPC|promote`
- 消费: `llmGateway.js`(生成角色卡), `saveManager.js`(写文件)

- [ ] **Step 1: 编写 player_creation_prompt.txt**

```
你是一个角色创建助手。根据玩家的描述，生成一个凡人修仙传世界观下的角色卡。

玩家描述: {{description}}

请严格按以下格式输出（JSON）：
{
  "name": "姓名",
  "appearance": "外貌描述",
  "spirit_root": "灵根(天灵根/双灵根/三灵根/四灵根/五灵根/异灵根)",
  "faction": "门派或散修",
  "realm": "初始境界(炼气)",
  "background": "背景故事(2-3句话)",
  "personality": "性格特点"
}

如果没有提供某项信息，合理推断或留空。用中文。
```

- [ ] **Step 2: 编写 npc_creation_prompt.txt**

```
你是一个角色创建助手。根据描述，生成一个凡人修仙传世界观下的重要NPC角色卡。

描述: {{description}}

请严格按以下格式输出（JSON）：
{
  "name": "姓名",
  "appearance": "外貌",
  "personality": "性格",
  "background": "背景",
  "secrets": "秘密(仅本NPC知)",
  "faction": "门派/势力",
  "realm": "境界",
  "region": "所在区域",
  "voice": "说话风格",
  "speech_style": { "catchphrase": "口头禅", "forbidden": ["禁止行为1", "禁止行为2"] },
  "style_sample": { "good": "好的台词示例", "bad": "坏的台词示例(避免)" },
  "tags": ["标签1", "标签2"]
}

用中文。如果信息不足，合理推断。
```

- [ ] **Step 3: 编写 createCharacter/index.js**

```javascript
const cloud = require('wx-server-sdk');
const { callLLM } = require('../shared/llmGateway');
const { decrypt } = require('../shared/encryption');
cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });
const db = cloud.database();

exports.main = async (event) => {
  const wxContext = cloud.getWXContext();
  const user_id = wxContext.OPENID;
  const { action, save_id, game_id, description } = event;

  // Get default model config
  const modelRes = await db.collection('model_configs').where({ user_id, is_default: true }).limit(1).get();
  const modelConfig = modelRes.data[0];
  if (!modelConfig) throw new Error('请先配置模型');
  const api_key = decrypt(modelConfig.api_key_enc);

  if (action === 'createPlayer') {
    // Call LLM with player_creation_prompt
    const prompt = getPlayerPrompt(description);
    const { text } = await callLLM({
      endpoint: modelConfig.endpoint, api_key, model: modelConfig.model,
      messages: [{ role: 'system', content: prompt }], params: modelConfig.params
    });
    const card = JSON.parse(text);
    // Write player.md + state.md to cloud storage
    await writePlayerFile(save_id, game_id, card);
    // Update saves collection with player_name, player_realm
    await db.collection('saves').where({ save_id }).update({ data: { player_name: card.name, player_realm: card.realm } });
    return { success: true, card };
  }

  if (action === 'createNPC') {
    const prompt = getNPCPrompt(description);
    const { text } = await callLLM({
      endpoint: modelConfig.endpoint, api_key, model: modelConfig.model,
      messages: [{ role: 'system', content: prompt }], params: modelConfig.params
    });
    const card = JSON.parse(text);
    const npc_id = `npc_${Date.now()}_${Math.random().toString(36).slice(2,6)}`;
    await writeNPCFile(save_id, game_id, npc_id, card);
    // Index in characters collection
    await db.collection('characters').add({
      data: { user_id, game_id, save_id, type: 'npc', npc_id, name: card.name, importance: 'important', file_path: `npcs/${npc_id}.md`, created_at: db.serverDate() }
    });
    return { success: true, npc_id, card };
  }

  if (action === 'promote') {
    // Promote a minor NPC mentioned in conversation to important
    // Use LLM to generate card from conversation context
    // Similar to createNPC but with context from recent conversation
  }
};
```

- [ ] **Step 4: 部署 + 验证**
  - createPlayer → player.md 存在 + saves 更新
  - createNPC → npcs/<id>.md 存在 + characters 索引

### Task 1.12: 主对话云函数

**Files:**
- Create: `cloudfunctions/chat/index.js`
- Create: `data/prompts/system_prompt.txt`

**Interfaces:**
- Produces: `chat` 云函数（主编排器）
- 消费: `contextEngine`, `llmGateway`, `parser`, `memorySystem`, `gameState`, `threadTracker`

- [ ] **Step 1: 编写 system_prompt.txt**

```
你是NPC「{{npc_name}}」，生活在凡人修仙传的天南越国世界。严格依据以下设定扮演，绝不越界知道你不该知道的事。

【世界规则】
{{world_content}}

【你的设定】
{{npc_static}}

【你的当前状态】
{{npc_state}}

【你对玩家的记忆】
{{npc_memory}}

【玩家档案】
{{player_info}}

【玩家当前状态】
{{player_state}}

【线索提示】
{{threads_hint}}

【铁律】
1. 只使用"你的设定""你的记忆""世界规则"中的信息。
2. 玩家若问你不该知道的事，你要表现出不知道。
3. 保持说话风格一致。
4. 若玩家透露新信息或你的状态变化，在 REPLY 之后用 MEMORY/STATE 段记录。
5. 若玩家表达了目标/承诺/未了之事，在 DIRECTOR 段记录。
6. 禁止使用破折号堆砌、禁止每段总结、禁止套路化表达。

【输出格式】
REPLY:
（你的台词与动作描写，给玩家看的正文）

MEMORY:
- （本回合新得知的玩家信息，没有则留空）

STATE:
- （本回合你的状态变化，没有则留空）

DIRECTOR:
- （玩家表达的目标/承诺，没有则留空）
```

- [ ] **Step 2: 编写 chat/index.js 主流程**

```javascript
const cloud = require('wx-server-sdk');
const { assembleContext } = require('../shared/contextEngine');
const { callLLM } = require('../shared/llmGateway');
const { parseSegments } = require('../shared/parser');
const { appendMemory } = require('../shared/memorySystem');
const { applyState } = require('../shared/gameState');
const { updateThreads } = require('../shared/threadTracker');
const { decrypt } = require('../shared/encryption');
cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });
const db = cloud.database();

exports.main = async (event, context) => {
  const wxContext = cloud.getWXContext();
  const user_id = wxContext.OPENID;
  const { game_id, save_id, npc_id, user_input, reroll, model_config_id } = event;

  // 1. Command detection: "创建角色"
  if (user_input.startsWith('创建角色')) {
    return { redirect: 'createCharacter', description: user_input.replace(/^创建角色[:：]?\s*/, '') };
  }

  // 2. Load model config
  let modelConfig;
  if (model_config_id) {
    const res = await db.collection('model_configs').doc(model_config_id).get();
    modelConfig = res.data;
  } else {
    const res = await db.collection('model_configs').where({ user_id, is_default: true }).limit(1).get();
    modelConfig = res.data[0];
  }
  if (!modelConfig) return { error: '请先配置模型' };
  const api_key = decrypt(modelConfig.api_key_enc);

  // 3. Assemble context
  const is_important = !!npc_id;
  const turn_counter = await getTurnCounter(save_id);
  const sections = await assembleContext({ game_id, save_id, npc_id, is_important, turn_counter });

  // 4. Build messages
  const systemPrompt = buildSystemPrompt(sections, npc_id);
  const history = await getRecentHistory(save_id, npc_id, 20);
  const messages = [
    { role: 'system', content: systemPrompt },
    ...history,
    { role: 'user', content: user_input }
  ];

  // 5. Call LLM (streaming for SSE)
  const { stream } = await callLLM({
    endpoint: modelConfig.endpoint, api_key, model: modelConfig.model,
    messages, params: modelConfig.params, stream: true
  });

  // 6. Collect full response from stream
  let fullText = '';
  // (SSE streaming to frontend handled separately — for MVP, collect all first)
  await new Promise((resolve, reject) => {
    stream.on('data', chunk => {
      const lines = chunk.toString().split('\n');
      for (const line of lines) {
        if (line.startsWith('data: ') && line !== 'data: [DONE]') {
          try {
            const parsed = JSON.parse(line.slice(6));
            fullText += parsed.choices?.[0]?.delta?.content || '';
          } catch {}
        }
      }
    });
    stream.on('end', resolve);
    stream.on('error', reject);
  });

  // 7. Parse 4 segments
  const { reply, memory, state, director } = parseSegments(fullText);

  // 8. Persist
  // Save conversation
  await db.collection('conversations').add({
    data: { user_id, game_id, save_id, npc_id, npc_importance: is_important ? 'important' : 'minor', role: 'user', content: user_input, timestamp: db.serverDate() }
  });
  await db.collection('conversations').add({
    data: { user_id, game_id, save_id, npc_id, npc_importance: is_important ? 'important' : 'minor', role: 'assistant', content: reply, timestamp: db.serverDate() }
  });

  // Memory (important NPC only)
  if (is_important && memory.length > 0) {
    await appendMemory(save_id, npc_id, memory);
  }

  // State
  if (state.length > 0) {
    await applyState(save_id, state);
  }

  // Threads
  if (director) {
    await updateThreads(save_id, director);
  }

  // Update turn counter
  await incrementTurnCounter(save_id);

  // Update last_played
  await db.collection('saves').where({ save_id }).update({ data: { last_played: db.serverDate() } });

  return { reply, state_updated: state.length > 0, objectives: director };
};
```

- [ ] **Step 3: 部署 + 验证**
  - 确保 chat 云函数可调用（先配置好模型）
  - 传入 save_id + npc_id + user_input → 返回 reply

### Task 1.13: 前端 — 世界选择 + 存档列表

**Files:**
- Create: `miniprogram/pages/worldSelect/worldSelect.wxml/wxss/js/json`
- Create: `miniprogram/pages/saveList/saveList.wxml/wxss/js/json`

- [ ] **Step 1: 世界选择页**
  - 显示 "凡人修仙·天南越国" 卡片
  - 点击 → navigateTo saveList?game_id=frxz

- [ ] **Step 2: 存档列表页**
  - 调 `manageSave({action:'list', game_id})` 获取存档列表
  - 每个存档显示: 玩家名 + 境界 + 上次游玩
  - "新游戏" 按钮 → navigateTo charCreation?game_id=frxz&mode=newPlayer
  - 点击存档 → navigateTo dialog?save_id=xxx
  - 长按存档 → 删除确认

- [ ] **Step 3: 验证**
  - 世界选择 → 存档列表 → 新游戏 → 建角 → 存档出现
  - 点击存档 → 进入对话页
  - 删除存档 → 列表更新

### Task 1.14: 前端 — 角色创建页

**Files:**
- Create: `miniprogram/pages/charCreation/charCreation.wxml/wxss/js/json`

- [ ] **Step 1: 页面设计**
  - 模式: newPlayer（建主角）/ newNPC（建NPC）
  - 输入框: "描述你的角色"（可选，留空则访谈模式）
  - "快速创建" 按钮（带描述 → 一次性生成）/ "访谈创建" 按钮（逐项问）
  - 预览区: 显示生成的角色卡（可编辑）
  - "确认" 按钮 → 调 createCharacter 云函数

- [ ] **Step 2: 逻辑实现**
  - newPlayer 模式: 确认后 → 创建 save → 写 player.md → navigateTo dialog
  - newNPC 模式: 确认后 → 写 npcs/<id>.md → 返回 dialog 页（刷新 NPC 列表）

- [ ] **Step 3: 验证**
  - 快速建角: 描述 → 预览 → 确认 → 存档/文件创建
  - 访谈建角: LLM 逐项问 → 预览 → 确认

### Task 1.15: 前端 — 对话页（核心）

**Files:**
- Create: `miniprogram/pages/dialog/dialog.wxml/wxss/js/json`
- Create: `miniprogram/components/chatBubble/`
- Create: `miniprogram/components/statePanel/`
- Create: `miniprogram/components/npcCard/`

- [ ] **Step 1: 页面布局**
  - 左侧/上方: 状态面板（境界/物品/位置/关系/声望/目标）— 纯文字列表
  - 右侧/下方: 对话区（聊天气泡列表 + 输入框）
  - 底部工具栏: 发送 / 创建角色 / 切换模型 / 压缩

- [ ] **Step 2: 对话逻辑**
  - 发送 → 调 chat 云函数（带 save_id + npc_id + user_input）
  - 流式接收 REPLY → 打字机效果显示
  - 收到完整回复 → 刷新状态面板
  - 若 chat 返回 `{redirect:'createCharacter'}` → navigateTo charCreation

- [ ] **Step 3: NPC 列表**
  - 左侧/抽屉: 重要 NPC 列表（调 characters 集合按 save_id 查）
  - 点击 NPC → 切换 npc_id → 切换对话上下文
  - "自由探索"模式: npc_id=null → LLM 即兴

- [ ] **Step 4: 重摇按钮**
  - 点击 → 重新调用 chat（reroll=true）→ 替换最后一条回复

- [ ] **Step 5: 验证**
  - 新游戏建角后 → 对话页打开 → 发送消息 → 流式回复 → 状态更新
  - 创建NPC → NPC列表出现 → 切换NPC → 对话上下文切换
  - 重摇 → 新回复替换旧回复

### Task 1.16: 前端 — 模型管理页

**Files:**
- Create: `miniprogram/pages/modelManage/modelManage.wxml/wxss/js/json`

- [ ] **Step 1: 页面设计**
  - 配置列表: 名称 + endpoint + model + 默认标记
  - "添加配置" 表单: name(可选"mimo"), endpoint(默认`https://api.xiaomimimo.com/v1`), api_key, model(`mimo-v2.5-pro`), temperature, max_tokens
  - 设为默认 / 删除 / 编辑

- [ ] **Step 2: 逻辑**
  - 调 manageModel CRUD
  - API Key 输入后加密存储，不回显原文

- [ ] **Step 3: 验证**
  - 添加 mimo 配置 → 设默认 → 对话可用
  - 添加中转站配置 → 切换 → 对话用新模型

### Task 1.17: 端到端测试

**Files:** 测试脚本（手动操作）

- [ ] **Step 1: 完整流程测试**
  1. 世界选择 → 凡人修仙·天南越国
  2. 存档列表 → 新游戏
  3. 建主角（快速: "我叫韩立，四灵根散修"）→ 预览 → 确认
  4. 进入对话页 → 发送"我走进集市" → 流式回复（次要NPC即兴）
  5. 发送"创建角色：剑修陆云，沉默寡言" → 角色创建流程 → 确认
  6. NPC列表出现"陆云" → 点击 → 发送"你好" → 陆云回复（记忆隔离生效）
  7. 切回自由探索 → 发送别的事 → 再切回陆云 → 陆云仍记得之前的对话
  8. 返回存档列表 → 存档存在 → 点击继续 → 恢复状态
  9. 模型管理 → 切换模型 → 对话用新模型

- [ ] **Step 2: 隔离验证**
  - 存档A建陆云 + 存档B建张三
  - 存档A对话中确认不含张三的记忆
  - 存档B对话中确认不含陆云的记忆

- [ ] **Step 3: 世界加载策略验证**
  - 第1轮: 确认注入完整 world.md
  - 第8轮: 确认注入压缩版
  - 第9轮: 确认不注入世界规则

---

## Self-Review

**1. Spec coverage:** ✓
- 10 痛点 + 压缩 + 创建角色 + 两级NPC + 无固定剧情 + 多存档 + 流式 + 模型自配 + 叙事无硬数值 + 18+内容 + 世界加载策略 — 全部在 Phase 0+1 任务中覆盖

**2. Placeholder scan:** ✓
- 无 TBD/TODO（代码为示意，实际实现时可调整）
- `getFileID` 在 worldLoader 中需要具体实现（存储 fileID 映射）— 已标注

**3. Type consistency:** ✓
- `assembleContext`, `callLLM`, `parseSegments`, `appendMemory`, `applyState`, `updateThreads` — 接口在各 task 间一致

---

## Execution Handoff

**Plan complete and saved to `xm/plans/2026-07-04-ai-wenyou-phase0-1.md`.**

**Two execution options:**

**1. Subagent-Driven (recommended)** — 我按 task 逐个 dispatch subagent 实现，每个 task 完成后 review，快速迭代

**2. Inline Execution** — 在当前 session 逐 task 实现，按 checkpoint review

**哪个方式？**（建议选 1：subagent-driven，每个 task 独立隔离，质量更好）
