#!/usr/bin/env node
// AI 文游 H5 后端：合并原 4 微信云函数
// 存储：本地文件系统（./data/db/*.json + ./data/saves/<save_id>/*.md）
// 运行：node server.js  默认 3001 端口

const http = require('http');
const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const crypto = require('crypto');
const { URL } = require('url');

// === 配置 ===
const PORT = process.env.PORT || 3001;
const DATA_DIR = path.join(__dirname, 'data');
const DB_DIR = path.join(DATA_DIR, 'db');
const SAVE_DIR = path.join(DATA_DIR, 'saves');
const GAME_DIR = path.join(DATA_DIR, 'games');
const CORS = { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': 'Content-Type', 'Access-Control-Allow-Methods': 'GET,POST,OPTIONS' };

// === 加密（对齐原 shared/encryption.js）===
const ALGO = 'aes-256-cbc';
const IV_LEN = 16;
function getKey() {
  const raw = process.env.ENCRYPTION_KEY || 'frxz-default-key-32-bytes-long!!';
  return Buffer.from(raw, 'utf8').slice(0, 32);
}
function encrypt(txt) {
  if (!txt) return '';
  const iv = crypto.randomBytes(IV_LEN);
  const c = crypto.createCipheriv(ALGO, getKey(), iv);
  let r = c.update(txt, 'utf8', 'hex') + c.final('hex');
  return iv.toString('hex') + ':' + r;
}
function decrypt(payload) {
  if (!payload) return '';
  const [ivHex, enc] = payload.split(':');
  if (!ivHex || !enc) return '';
  try {
    const iv = Buffer.from(ivHex, 'hex');
    const d = crypto.createDecipheriv(ALGO, getKey(), iv);
    return d.update(enc, 'hex', 'utf8') + d.final('utf8');
  } catch (e) { return ''; }
}

// === JSON DB 文件持久化 ===
const DB_FILE = {
  saves: path.join(DB_DIR, 'saves.json'),
  model_configs: path.join(DB_DIR, 'model_configs.json'),
  characters: path.join(DB_DIR, 'characters.json'),
  conversations: path.join(DB_DIR, 'conversations.json'),
};

const MEMORY = {};
async function loadDb(name) {
  if (MEMORY[name]) return MEMORY[name];
  try {
    const raw = await fsp.readFile(DB_FILE[name], 'utf8');
    MEMORY[name] = JSON.parse(raw);
  } catch (e) { MEMORY[name] = []; }
  return MEMORY[name];
}
async function saveDb(name) {
  await fsp.mkdir(DB_DIR, { recursive: true });
  await fsp.writeFile(DB_FILE[name], JSON.stringify(MEMORY[name], null, 2), 'utf8');
}
function genId(p) { return `${p}_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`; }

// === 存档文件层 ===
function saveFile(p) { return path.join(SAVE_DIR, p); }
async function readSaveFile(saveId, filename) {
  try { return await fsp.readFile(saveFile(`${saveId}/${filename}.md`), 'utf8'); }
  catch (e) { return ''; }
}
async function writeSaveFile(saveId, filename, content) {
  const fp = saveFile(`${saveId}/${filename}.md`);
  await fsp.mkdir(path.dirname(fp), { recursive: true });
  await fsp.writeFile(fp, content, 'utf8');
}
async function appendSaveFile(saveId, filename, add) {
  const old = await readSaveFile(saveId, filename);
  await writeSaveFile(saveId, filename, old + add);
}
async function readGameFile(gameId, filename) {
  try { return await fsp.readFile(path.join(GAME_DIR, `${gameId}/${filename}`), 'utf8'); }
  catch (e) { return ''; }
}

// === LLM 网关（流 -> 完整文本）===
async function callLLM({ base_url, api_key, model, params = {}, messages, stream = true }) {
  const url = `${base_url.replace(/\/$/, '')}/chat/completions`;
  const body = {
    model, messages,
    temperature: params.temperature ?? 0.8,
    max_tokens: params.max_tokens ?? 2048,
    stream,
  };
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${api_key}` },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`LLM ${res.status}: ${await res.text()}`);
  if (!stream) {
    const j = await res.json();
    return { full: j.choices?.[0]?.message?.content || '' };
  }
  const reader = res.body.getReader();
  const dec = new TextDecoder();
  let buf = '';
  let full = '';
  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    buf += dec.decode(value, { stream: true });
    const lines = buf.split('\n');
    buf = lines.pop();
    for (const l of lines) {
      const line = l.trim();
      if (!line.startsWith('data:')) continue;
      const data = line.slice(5).trim();
      if (data === '[DONE]') continue;
      try {
        const j = JSON.parse(data);
        full += j.choices?.[0]?.delta?.content || '';
      } catch (e) {}
    }
  }
  return { full };
}

// === 回复解析 ===
function parseSegments(text) {
  const segs = { REPLY: '', MEMORY: '', STATE: '', DIRECTOR: '' };
  const lines = text.split('\n');
  let cur = 'REPLY';
  for (const l of lines) {
    const m = l.match(/^(REPLY|MEMORY|STATE|DIRECTOR)\s*[:：]/i);
    if (m) { cur = m[1].toUpperCase(); continue; }
    segs[cur] += l + '\n';
  }
  const clean = (s, bullet) => {
    const arr = s.split('\n).filter(x => x.trim());
    if (bullet) return arr.map(x => x.replace(/^-\s*/, '').trim()).filter(Boolean);
    return arr.join('\n').trim();
  };
  return {
    reply: segs.REPLY.trim(),
    memory: segs.MEMORY.split('\n').map(x => x.replace(/^-\s*/, '').trim()).filter(Boolean),
    state: segs.STATE.split('\n').map(x => x.replace(/^-\s*/, '').trim()).filter(Boolean),
    director: segs.DIRECTOR.split('\n').map(x => x.replace(/^-\s*/, '').trim()).filter(Boolean),
  };
}

// === 时间跳跃检测（对齐原函数）===
function detectTimeSkip(input) {
  const ps = [
    { regex: /闭关(\d+)(年|个月|月|天|日)/i, type: 'cultivation' },
    { regex: /修炼(\d+)(年|个月|月|天|日)/i, type: 'cultivation' },
    { regex: /修炼一(年|个月|月|天|日)/i, type: 'cultivation', fixed: 1 },
    { regex: /赶路(\d+)(年|个月|月|天|日)/i, type: 'travel' },
    { regex: /昏迷(\d+)(年|个月|月|天|日)/i, type: 'coma' },
    { regex: /养伤(\d+)(年|个月|月|天|日)/i, type: 'recovery' },
    { regex: /打坐(\d+)(年|个月|月|天|日)/i, type: 'cultivation' },
  ];
  for (const p of ps) {
    const m = input.match(p.regex);
    if (!m) continue;
    const amt = p.fixed || parseInt(m[1]);
    const u = m[2];
    let days = u.includes('年') ? amt * 365 : u.includes('月') ? amt * 30 : amt;
    return { type: p.type, days, original: m[0], amount: amt, unit: u };
  }
  return null;
}

// === 系统 Prompt ===
function buildSystemPrompt(sections, npc) {
  const { world, region, world_state, npc: npcCard, npc_memory, player, state, summary, threads, timeSkipReport } = sections;
  let p = '';
  if (world) p += `【世界规则】\n${world}\n\n`;
  if (region) p += `【当前区域】\n${region}\n\n`;
  if (world_state) p += `【世界当前动态】\n${world_state}\n\n`;
  if (npcCard) p += `【你扮演的角色】\n${npcCard}\n\n`;
  else p += `【当前场景】\n自由探索模式，请根据玩家描述即兴扮演当前遇到的人物/叙述环境。\n\n`;
  if (npc_memory && npcCard) p += `【你对玩家的记忆】\n${npc_memory}\n\n`;
  if (player) p += `【玩家档案】\n${player}\n\n`;
  if (state) p += `【玩家当前状态】\n${state}\n\n`;
  if (summary) p += `【之前对话摘要】\n${summary}\n\n`;
  if (threads && threads.length) p += `【玩家主动目标/未了之事】\n${threads}\n\n`;
  if (timeSkipReport) p += `【系统提示：时间流逝】\n${timeSkipReport}\n请在回复中自然体现这些变化。\n\n`;
  p += `【铁律】
1. 严格使用提供的信息，不要编造世界设定，不知道的事情就说不知道。
2. 保持角色说话风格一致，不要OOC。
3. 禁止滥用破折号、禁止每段总结、禁止八股套话，要自然有修仙味。
4. 如果玩家透露了新信息、状态变化、或者提出目标，在REPLY之后用MEMORY/STATE/DIRECTOR段记录。
5. 如果是重要NPC，MEMORY段写你新知道的关于玩家的事实；次要NPC不需要写MEMORY。
6. STATE段写状态变化（境界提升、获得物品、关系变化、位置变化）。
7. DIRECTOR段只写玩家主动提出的目标、承诺、未了之事，不要强推剧情。

【输出格式】
REPLY:
（你的回复，给玩家看的正文，包含对话和动作描写）

MEMORY:
- （新事实，没有就留空，每行一条）

STATE:
- （状态变化，没有就留空，每行一条）

DIRECTOR:
- （玩家目标/承诺，没有就留空，每行一条）`;
  return p;
}

// === HTTP 工具 ===
function sendJSON(res, code, body) {
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', ...CORS });
  res.end(JSON.stringify(body));
}
async function readBody(req) {
  return new Promise((done) => {
    let b = '';
    req.on('data', c => b += c);
    req.on('end', () => {
      try { done(JSON.parse(b || '{}')); } catch (e) { done({}); }
    });
  });
}

// === 路由：chat ===
async function handleChat(body) {
  const { game_id = 'frxz', save_id, npc_id = null, user_input, reroll = false, turn_id = null } = body;
  if (!save_id) return { error: '缺少 save_id' };
  if (!user_input || !user_input.trim()) return { error: '请输入内容' };

  const saves = await loadDb('saves');
  const save = saves.find(s => s.save_id === save_id);
  if (!save) return { error: '存档不存在' };

  const cfgs = await loadDb('model_configs');
  let cfg;
  if (body.model_config_id) cfg = cfgs.find(c => c._id === body.model_config_id);
  else if (save.current_model_config_id) cfg = cfgs.find(c => c._id === save.current_model_config_id);
  else cfg = cfgs.find(c => c.is_default);
  if (!cfg) return { error: '请先在模型管理配置 API Key' };
  if (!cfg.api_key_enc) return { error: '该配置没有存储 API Key' };

  const api_key = decrypt(cfg.api_key_enc);
  const turn_counter = save.turn_counter || 0;

  const sections = {
    world: turn_counter === 0 || turn_counter % 8 === 0
      ? await readGameFile(game_id, turn_counter === 0 ? 'world.md' : 'world_compressed.md')
      : null,
    region: await readGameFile(game_id, `regions/${save.current_region}.md`),
    world_state: await readSaveFile(save_id, 'world_state'),
    npc: npc_id ? await readSaveFile(save_id, `npcs/${npc_id}`) : null,
    npc_memory: npc_id ? await readSaveFile(save_id, `npc_memory/${npc_id}`) : null,
    player: await readSaveFile(save_id, 'player'),
    state: await readSaveFile(save_id, 'state'),
    summary: await readSaveFile(save_id, 'summary'),
    threads: await readSaveFile(save_id, 'threads'),
    timeSkipReport: null,
  };

  if (!reroll) {
    const ts = detectTimeSkip(user_input.trim());
    if (ts) {
      const y = ts.days >= 365 ? `${Math.floor(ts.days / 365)}年` : '';
      const mo = ts.days % 365 >= 30 ? `${Math.floor((ts.days % 365) / 30)}个月` : '';
      const d = ts.days % 30 > 0 ? `${ts.days % 30}天` : '';
      const ts2 = ts.type === 'cultivation' ? '闭关修炼' : ts.type === 'travel' ? '赶路' : ts.type === 'coma' ? '昏迷' : '养伤';
      sections.timeSkipReport = `时间过去了${[y, mo, d].filter(Boolean).join('')}（${ts.original}）。\n请根据「${ts2}」合理推演：\n1. 玩家的修为/伤势/位置变化\n2. 这段时间世界上可能发生的小事\n3. NPC们的变化\n不要夸张，符合凡人修仙传世界观，节奏平稳。`;
    }
  }

  const convs = await loadDb('conversations');
  const history = convs
    .filter(c => c.save_id === save_id)
    .sort((a, b) => (a.timestamp || 0) - (b.timestamp || 0))
    .slice(-20)
    .map(c => ({ role: c.role, content: c.content }));

  const effectiveTurn = reroll ? turn_id : genId('turn');
  const sysPrompt = buildSystemPrompt(sections, { npc_id });
  const msgs = [
    { role: 'system', content: sysPrompt },
    ...history,
    { role: 'user', content: user_input.trim() },
  ];

  const { full } = await callLLM({ base_url: cfg.base_url, api_key, model: cfg.model, params: cfg.params, messages: msgs, stream: true });
  const { reply, memory, state, director } = parseSegments(full);
  if (!reply) return { error: 'AI 回复为空，请重试' };

  if (!reroll) {
    const now = Date.now();
    const newConvs = [
      { id: genId('conv'), user_id: 'local', game_id, save_id, npc_id, npc_importance: npc_id ? 'important' : 'minor', role: 'user', content: user_input.trim(), timestamp: now, turn_id: effectiveTurn, candidate_version: 1, is_final: true },
      { id: genId('conv'), user_id: 'local', game_id, save_id, npc_id, npc_importance: npc_id ? 'important' : 'minor', role: 'assistant', content: reply, timestamp: now, turn_id: effectiveTurn, candidate_version: 1, is_final: true, reroll_count: 0 },
    ];
    MEMORY.conversations.push(...newConvs);
    await saveDb('conversations');

    if (npc_id && memory.length) await appendSaveFile(save_id, `npc_memory/${npc_id}`, `\n## ${new Date().toLocaleString('zh-CN')}\n${memory.map(m => `- ${m}`).join('\n')}\n`);
    if (state.length) await appendSaveFile(save_id, 'state', `\n## ${new Date().toLocaleString('zh-CN')} 状态更新\n${state.map(s => `- ${s}`).join('\n')}\n`);
    if (director.length) await appendSaveFile(save_id, 'threads', `\n${director.map(d => `- ${d}`).join('\n')}`);

    save.turn_counter = turn_counter + 1;
    save.last_played = now;
    if (npc_id) save.current_npc = npc_id;
    await saveDb('saves');

    return {
      success: true, reply, turn_id: effectiveTurn,
      state_updated: state.length > 0, memory_updated: memory.length > 0,
      objectives: director, turn_counter: save.turn_counter,
      shouldSuggestCompression: save.turn_counter > 0 && save.turn_counter % 8 === 0,
      rerollable: true, time_skipped: 0,
    };
  }

  return { success: true, reply, turn_id: effectiveTurn, reroll: true, state_updated: false, memory_updated: false, rerollable: true };
}

// === 路由：createCharacter ===
async function handleCreateCharacter(body) {
  const { action, save_id, game_id = 'frxz', description } = body;
  if (!['createPlayer', 'createNPC'].includes(action) || !save_id || !description) {
    return { error: '参数错误' };
  }
  const prompt = `你是角色卡生成器。根据玩家描述，仅输出合法的 JSON，格式固定：
{ "name": "姓名", "appearance": "外貌", "gender": "男/女", "identity": "身份背景", "realm": "", "personality": ["性格标签1","性格标签2"], "abilities": ["能力1","能力2"], "background": "1-2句背景" }
玩家描述：${description}
只输出 JSON，不要其他文字：`;
  const cfgs = await loadDb('model_configs');
  const cfg = cfgs.find(c => c.is_default) || cfgs[0];
  if (!cfg) return { error: '请先配置默认模型' };
  const { full } = await callLLM({
    base_url: cfg.base_url, api_key: decrypt(cfg.api_key_enc), model: cfg.model,
    params: cfg.params, messages: [{ role: 'user', content: prompt }], stream: false,
  });
  const m = full.match(/\{[\s\S]*\}/);
  if (!m) return { error: '生成失败：无效的模型响应' };
  let card;
  try { card = JSON.parse(m[0]); }
  catch (e) { return { error: '生成失败：JSON 解析错误' }; }

  if (action === 'createNPC') {
    const chars = await loadDb('characters');
    const cid = genId('npc');
    chars.push({ npc_id: cid, save_id, game_id, type: 'npc', name: card.name || '新 NPC', card, created_at: Date.now() });
    MEMORY.characters = chars;
    await saveDb('characters');
    await writeSaveFile(save_id, `npcs/${cid}`, `# ${card.name}\n\n${JSON.stringify(card, null, 2)}\n`);
    await writeSaveFile(save_id, `npc_memory/${cid}`, `## 初次见面\n\n（刚创建，暂无记忆）\n`);
    return { success: true, card, npc_id: cid };
  }

  await writeSaveFile(save_id, 'player', `# ${card.name || '主角'}\n\n${JSON.stringify(card, null, 2)}\n`);
  const saves = await loadDb('saves');
  const save = saves.find(s => s.save_id === save_id);
  if (save) {
    save.player_name = card.name || save.player_name;
    save.player_realm = card.realm || save.player_realm;
    await saveDb('saves');
  }
  return { success: true, card };
}

// === 路由：manageSave ===
async function handleManageSave(body) {
  const { action, game_id = 'frxz', save_id, player_name } = body;
  const saves = await loadDb('saves');

  switch (action) {
    case 'create': {
      if (saves.filter(s => s.game_id === game_id).length >= 10)
        return { error: '每个世界最多 10 个存档' };
      const id = genId('save');
      const now = Date.now();
      const save = {
        save_id: id, user_id: 'local', game_id,
        player_name: player_name || '新玩家', player_realm: '炼气',
        current_region: 'yueguo_qipai', current_npc: null,
        mode: 'sandbox', current_model_config_id: null,
        current_date: '天南历 412 年三月初七', world_time_days: 0, turn_counter: 0,
        created_at: now, updated_at: now, last_played: now,
      };
      saves.push(save);
      MEMORY.saves = saves;
      await saveDb('saves');
      const init = {
        player: `# 主角\n\n待创建...\n`,
        state: `# 状态\n\n境界: 炼气\n位置: 越国七派\n物品:\n关系:\n声望: 无名小辈\n目标:\n`,
        world_state: `# 世界动态状态\n\n越国七派表面平静，暗潮涌动。\n`,
        summary: `# 对话摘要\n\n游戏刚开始。\n`,
        threads: `# 线索追踪\n\n尚无主动目标。\n`,
      };
      for (const [f, c] of Object.entries(init)) await writeSaveFile(id, f, c);
      return { success: true, save_id: id, game_id };
    }
    case 'list': {
      return {
        saves: saves
          .filter(s => s.game_id === game_id)
          .sort((a, b) => (b.last_played || 0) - (a.last_played || 0))
          .slice(0, 10),
      };
    }
    case 'get': {
      const s = saves.find(x => x.save_id === save_id);
      if (!s) return { error: '存档不存在' };
      const files = {};
      for (const f of ['player', 'state', 'world_state', 'summary', 'threads']) files[f] = await readSaveFile(save_id, f);
      const chars = await loadDb('characters');
      return { save: s, files, npcs: chars.filter(c => c.save_id === save_id && c.type === 'npc') };
    }
    case 'delete': {
      const i = saves.findIndex(s => s.save_id === save_id);
      if (i < 0) return { error: '存档不存在' };
      saves.splice(i, 1);
      MEMORY.saves = saves;
      await saveDb('saves');
      const convs = await loadDb('conversations');
      MEMORY.conversations = convs.filter(c => c.save_id !== save_id);
      await saveDb('conversations');
      const chars = await loadDb('characters');
      MEMORY.characters = chars.filter(c => c.save_id !== save_id);
      await saveDb('characters');
      try { await fsp.rm(saveFile(save_id), { recursive: true, force: true }); } catch (e) {}
      return { success: true };
    }
    case 'updateMeta': {
      const s = saves.find(x => x.save_id === save_id);
      if (!s) return { error: '存档不存在' };
      for (const k of ['player_name', 'player_realm', 'current_region', 'current_npc', 'current_date', 'turn_counter', 'last_played', 'mode']) {
        if (body[k] !== undefined) s[k] = body[k];
      }
      s.updated_at = Date.now();
      MEMORY.saves = saves;
      await saveDb('saves');
      return { success: true };
    }
    default: return { error: `未知操作：${action}` };
  }
}

// === 路由：manageModel ===
async function handleManageModel(body) {
  const { action, config } = body;
  const cfgs = await loadDb('model_configs');
  switch (action) {
    case 'list': return { configs: cfgs.map(c => ({ _id: c._id, name: c.name, base_url: c.base_url, model: c.model, is_default: c.is_default, has_key: !!c.api_key_enc })) };
    case 'get': {
      if (!config?._id) return { config: null };
      const c = cfgs.find(x => x._id === config._id);
      if (!c) return { config: null };
      return { config: { _id: c._id, name: c.name, base_url: c.base_url, model: c.model, is_default: c.is_default, params: c.params, has_key: !!c.api_key_enc } };
    }
    case 'create': {
      if (!config.name || !config.base_url || !config.model) return { error: '名称、Base URL、模型必填' };
      if (!config.api_key) return { error: '请填写 API Key' };
      const id = genId('cfg');
      const newCfg = {
        _id: id, name: config.name, base_url: config.base_url,
        api_key_enc: encrypt(config.api_key),
        model: config.model, is_default: cfgs.length === 0,
        params: { temperature: +config.temperature || 0.8, max_tokens: +config.max_tokens || 2048 },
      };
      if (newCfg.is_default) cfgs.forEach(c => c.is_default = false);
      cfgs.push(newCfg);
      MEMORY.model_configs = cfgs;
      await saveDb('model_configs');
      return { success: true, _id: id };
    }
    case 'update': {
      const c = cfgs.find(x => x._id === config._id);
      if (!c) return { error: '配置不存在' };
      if (config.name) c.name = config.name;
      if (config.base_url) c.base_url = config.base_url;
      if (config.model) c.model = config.model;
      if (config.api_key) c.api_key_enc = encrypt(config.api_key);
      if (config.temperature !== undefined) c.params = { ...(c.params || {}), temperature: +config.temperature };
      if (config.max_tokens !== undefined) c.params = { ...(c.params || {}), max_tokens: +config.max_tokens };
      MEMORY.model_configs = cfgs;
      await saveDb('model_configs');
      return { success: true };
    }
    case 'delete': {
      const i = cfgs.findIndex(c => c._id === config._id);
      if (i < 0) return { error: '配置不存在' };
      cfgs.splice(i, 1);
      MEMORY.model_configs = cfgs;
      await saveDb('model_configs');
      return { success: true };
    }
    case 'setDefault': {
      const target = cfgs.find(c => c._id === config._id);
      if (!target) return { error: '配置不存在' };
      cfgs.forEach(c => c.is_default = c._id === target._id);
      MEMORY.model_configs = cfgs;
      await saveDb('model_configs');
      return { success: true };
    }
    case 'test': {
      const { base_url, api_key, model } = config;
      if (!base_url || !api_key || !model) return { error: 'Base URL / API Key / Model 必填' };
      try {
        const { full } = await callLLM({ base_url, api_key, model, messages: [{ role: 'user', content: '你好，请回复 OK 确认连通。' }], stream: false, params: { max_tokens: 50 } });
        return { success: true, response: full.slice(0, 200) };
      } catch (e) { return { error: e.message }; }
    }
    case 'listModels': {
      const { base_url, api_key } = config;
      if (!base_url || !api_key) return { error: 'Base URL / API Key 必填' };
      try {
        const res = await fetch(`${base_url.replace(/\/$/, '')}/models`, { headers: { Authorization: `Bearer ${api_key}` } });
        if (!res.ok) return { error: `API 返回 ${res.status}` };
        const j = await res.json();
        return { models: (j.data || []).map(m => ({ id: m.id, name: m.name || m.id })) };
      } catch (e) { return { error: e.message }; }
    }
    default: return { error: `未知操作：${action}` };
  }
}

// === 路由：characters ===
async function handleCharacters(body) {
  const { action, save_id, type } = body;
  const chars = await loadDb('characters');
  if (action === 'list') {
    return { data: chars.filter(c => c.save_id === save_id && (!type || c.type === type)) };
  }
  if (action === 'delete') {
    const i = chars.findIndex(c => c.npc_id === body.npc_id);
    if (i < 0) return { error: 'NPC 不存在' };
    const npc = chars[i];
    chars.splice(i, 1);
    MEMORY.characters = chars;
    await saveDb('characters');
    return { success: true };
  }
  return { error: `未知操作：${action}` };
}

// === 路由：history ===
async function handleHistory(body) {
  const convs = await loadDb('conversations');
  return { data: convs.filter(c => c.save_id === body.save_id && c.is_final).sort((a, b) => (a.timestamp || 0) - (b.timestamp || 0)).slice(-50) };
}

// === 路由：file（知识文件）===
async function handleFile(body) {
  const { game_id = 'frxz', filename } = body;
  const blocked = ['..', '~', '//'];
  if (blocked.some(b => filename.includes(b))) return { error: '非法文件路径' };
  const content = await readGameFile(game_id, filename);
  return { content };
}

// === 路由：index ===
async function serveStatic(urlPath) {
  let rel = urlPath === '/' ? '/index' : urlPath;
  const page = rel.replace(/^\//, '');
  const candidates = [
    path.join(__dirname, 'miniprogram', 'pages', page, `${page}.html`),
    path.join(__dirname, 'public', page + '.html'),
    path.join(__dirname, 'public', 'index.html'),
  ];
  for (const c of candidates) {
    try {
      const data = await fsp.readFile(c);
      return { body: data, type: c.endsWith('.css') ? 'text/css' : c.endsWith('.js') ? 'application/javascript' : c.endsWith('.svg') ? 'image/svg+xml' : 'text/html; charset=utf-8' };
    } catch (e) {}
  }
  return null;
}

// === 服务器 ===
const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://localhost:${PORT}`);
  const pathname = url.pathname;

  if (req.method === 'OPTIONS') { res.writeHead(204, CORS); return res.end(); }

  // API 路由
  if (pathname.startsWith('/api/') && req.method === 'POST') {
    const body = await readBody(req);
    let r = { error: 'not found' };
    if (pathname === '/api/chat') r = await handleChat(body);
    else if (pathname === '/api/createCharacter') r = await handleCreateCharacter(body);
    else if (pathname === '/api/manageSave') r = await handleManageSave(body);
    else if (pathname === '/api/manageModel') r = await handleManageModel(body);
    else if (pathname === '/api/characters') r = await handleCharacters(body);
    else if (pathname === '/api/history') r = await handleHistory(body);
    else if (pathname === '/api/file') r = await handleFile(body);
    else if (pathname === '/api/health') r = { ok: true, ts: Date.now() };
    sendJSON(res, 200, r);
    return;
  }

  // 静态文件（UI）
  const file = await serveStatic(pathname);
  if (file) {
    res.writeHead(200, { 'Content-Type': file.type, ...CORS });
    return res.end(file.body);
  }

  sendJSON(res, 404, { error: 'Not found', path: pathname });
});

// 启动：确保目录存在
(async () => {
  await fsp.mkdir(DB_DIR, { recursive: true });
  await fsp.mkdir(SAVE_DIR, { recursive: true });
  for (const f of Object.values(DB_FILE)) {
    try { await fsp.access(f); } catch (e) { await fsp.writeFile(f, '[]', 'utf8'); }
  }
  server.listen(PORT, () => console.log(`AI 文游后端已启动：http://localhost:${PORT}`));
})();
