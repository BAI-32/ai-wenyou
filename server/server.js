/**
 * Backend server for AI 文游 H5 version.
 * Runs as Node.js server OR Cloudflare Worker (via _worker.js wrapper).
 *
 * Merges 4 cloud functions: chat, createCharacter, manageModel, manageSave.
 * Persistence: file system + JSON files (KV-compatible for Worker mode).
 */

const crypto = require('crypto');
const https = require('https');
const http = require('http');
const fs = require('fs');
const path = require('path');
const url = require('url');

// ===== Config =====
const ENCRYPTION_KEY = process.env.ENCRYPTION_KEY || 'frxz-default-key-32-bytes-long!!';
const ENC_KEY_BUF = Buffer.from(ENCRYPTION_KEY, 'utf8').slice(0, 32);
const SAVE_ROOT = process.env.SAVE_ROOT || path.join(__dirname, 'data', 'saves');
const GAME_ROOT = process.env.GAME_ROOT || path.join(__dirname, '..', 'data', 'games');
const DATA_ROOT = process.env.DATA_ROOT || path.join(__dirname, 'data');
const DEFAULT_GAME_ID = 'frxz';
const RECENT_HISTORY_LIMIT = 20;
const SAVE_LIMIT_PER_USER = 10;

// ===== Helper: simple file store (JSON files per collection) =====
class JsonStore {
  constructor(collection) {
    this.file = path.join(DATA_ROOT, collection + '.json');
    this._ensureDir();
  }
  _ensureDir() {
    const dir = path.dirname(this.file);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  }
  _read() {
    try {
      if (!fs.existsSync(this.file)) return [];
      return JSON.parse(fs.readFileSync(this.file, 'utf8'));
    } catch (e) { return []; }
  }
  _write(list) { fs.writeFileSync(this.file, JSON.stringify(list, null, 2), 'utf8'); }
  all(filter) {
    const list = this._read();
    return filter ? list.filter(filter) : list;
  }
  first(filter) { return this.all(filter)[0] || null; }
  add(item) {
    const list = this._read();
    const now = new Date().toISOString();
    const rec = { _id: 'id_' + Date.now() + '_' + Math.random().toString(36).slice(2, 8), created_at: now, ...item };
    list.push(rec);
    this._write(list);
    return rec;
  }
  update(filter, patch) {
    const list = this._read();
    let count = 0;
    for (let i = 0; i < list.length; i++) {
      if (filter(list[i])) { list[i] = { ...list[i], ...patch, updated_at: new Date().toISOString() }; count++; }
    }
    this._write(list);
    return count;
  }
  remove(filter) {
    const list = this._read();
    const before = list.length;
    const remain = list.filter(x => !filter(x));
    this._write(remain);
    return before - remain.length;
  }
}

const savesStore = new JsonStore('saves');
const modelConfigsStore = new JsonStore('model_configs');
const conversationsStore = new JsonStore('conversations');
const charactersStore = new JsonStore('characters');

// ===== Encryption =====
const IV_LENGTH = 16;
function encrypt(plaintext) {
  if (!plaintext) return '';
  const iv = crypto.randomBytes(IV_LENGTH);
  const cipher = crypto.createCipheriv('aes-256-cbc', ENC_KEY_BUF, iv);
  let e = cipher.update(plaintext, 'utf8', 'hex');
  e += cipher.final('hex');
  return iv.toString('hex') + ':' + e;
}
function decrypt(ciphertext) {
  if (!ciphertext) return '';
  const parts = ciphertext.split(':');
  if (parts.length !== 2) return '';
  try {
    const iv = Buffer.from(parts[0], 'hex');
    const decipher = crypto.createDecipheriv('aes-256-cbc', ENC_KEY_BUF, iv);
    let d = decipher.update(parts[1], 'hex', 'utf8');
    d += decipher.final('utf8');
    return d;
  } catch (e) { console.error('Decrypt failed:', e.message); return ''; }
}

// ===== LLM Gateway =====
function callLLM(opts) {
  const {
    base_url = 'https://api.xiaomimimo.com/v1',
    api_key, model = 'mimo-v2.5-pro', messages = [],
    params = {}, stream = false, endpoint_type = 'chat',
  } = opts;
  const u = new URL(base_url);
  let endpoint, body, method = 'POST';
  if (endpoint_type === 'models') {
    endpoint = '/models'; body = null; method = 'GET';
  } else {
    endpoint = '/chat/completions';
    body = JSON.stringify({
      model, messages,
      temperature: params.temperature ?? 0.8,
      max_tokens: params.max_tokens ?? 2048,
      top_p: params.top_p ?? 1,
      presence_penalty: params.presence_penalty ?? 0,
      frequency_penalty: params.frequency_penalty ?? 0,
      stream: !!stream,
    });
  }
  const headers = { 'Authorization': `Bearer ${api_key}` };
  if (body) {
    headers['Content-Type'] = 'application/json';
    headers['Content-Length'] = Buffer.byteLength(body);
  }
  const options = {
    hostname: u.hostname,
    port: u.port || (u.protocol === 'https:' ? 443 : 80),
    path: u.pathname.replace(/\/$/, '') + endpoint,
    method, headers, timeout: 60000,
  };
  return new Promise((resolve, reject) => {
    const proto = u.protocol === 'https:' ? https : http;
    const req = proto.request(options, res => {
      if (res.statusCode >= 400) {
        let d = '';
        res.on('data', c => d += c);
        res.on('end', () => reject(new Error(`LLM API Error ${res.statusCode}: ${d.slice(0, 500)}`)));
        return;
      }
      if (stream) resolve({ stream: res });
      else {
        let d = '';
        res.on('data', c => d += c);
        res.on('end', () => {
          try {
            const p = JSON.parse(d);
            if (endpoint_type === 'models') resolve({ data: p.data || [] });
            else resolve({ text: p.choices?.[0]?.message?.content || '' });
          } catch (e) { reject(new Error('Parse failed: ' + e.message)); }
        });
      }
    });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error('LLM timeout (60s)')); });
    if (body) req.write(body);
    req.end();
  });
}
async function collectStream(stream) {
  return new Promise((resolve, reject) => {
    let full = '';
    stream.on('data', chunk => {
      const lines = chunk.toString().split('\n');
      for (const line of lines) {
        const t = line.trim();
        if (t.startsWith('data: ')) {
          const d = t.slice(6);
          if (d === '[DONE]') continue;
          try {
            const p = JSON.parse(d);
            full += p.choices?.[0]?.delta?.content || '';
          } catch {}
        }
      }
    });
    stream.on('end', () => resolve(full));
    stream.on('error', reject);
  });
}

// ===== Parser =====
function parseSegments(text) {
  const r = { reply: '', memory: [], state: [], director: '', raw: text };
  if (!text || typeof text !== 'string') return r;
  const re = /^(REPLY|MEMORY|STATE|DIRECTOR)\s*:\s*([\s\S]*?)(?=^(?:REPLY|MEMORY|STATE|DIRECTOR)\s*:|$)/gim;
  let m; const segs = {};
  while ((m = re.exec(text)) !== null) segs[m[1].toUpperCase()] = m[2].trim();
  if (Object.keys(segs).length === 0) { r.reply = text.trim(); return r; }
  r.reply = segs.REPLY || '';
  if (segs.MEMORY) r.memory = segs.MEMORY.split('\n').map(l => l.trim()).filter(l => l.length > 0).map(l => l.replace(/^[-*•·]\s*/, '').replace(/^\d+[.)、]\s*/, ''));
  if (segs.STATE) r.state = segs.STATE.split('\n').map(l => l.trim()).filter(l => l.length > 0).map(l => l.replace(/^[-*•·]\s*/, '').replace(/^\d+[.)、]\s*/, ''));
  r.director = segs.DIRECTOR || '';
  return r;
}
function parseCharacterCard(text) {
  if (!text) return null;
  try { return JSON.parse(text); } catch {}
  const m = text.match(/\{[\s\S]*\}/);
  if (m) try { return JSON.parse(m[0]); } catch {}
  return null;
}

// ===== File storage (local files, save/knowledge) =====
function ensureDir(p) { if (!fs.existsSync(p)) fs.mkdirSync(p, { recursive: true }); }
function savePath(user_id, game_id, save_id, filename) {
  const dir = path.join(SAVE_ROOT, user_id, game_id, save_id);
  ensureDir(dir);
  return path.join(dir, filename + '.md');
}
function gamePath(game_id, filename) {
  return path.join(GAME_ROOT, game_id, filename);
}
function readFileSafe(filePath) {
  try {
    if (fs.existsSync(filePath)) return fs.readFileSync(filePath, 'utf8');
    return null;
  } catch (e) { return null; }
}
function writeFileSafe(filePath, content) {
  ensureDir(path.dirname(filePath));
  fs.writeFileSync(filePath, content, 'utf8');
}
function appendFileSafe(filePath, contentToAppend) {
  const existing = readFileSafe(filePath) || '';
  const sep = existing.length > 0 && !existing.endsWith('\n') ? '\n' : '';
  writeFileSafe(filePath, existing + sep + contentToAppend + '\n');
}
function deleteDirSafe(dirPath) {
  if (fs.existsSync(dirPath)) fs.rmSync(dirPath, { recursive: true, force: true });
}

// ===== Utils =====
function detectTimeSkip(input) {
  const patterns = [
    { regex: /闭关(\d+)(年|个月|月|天|日)/i, type: 'cultivation' },
    { regex: /修炼(\d+)(年|个月|月|天|日)/i, type: 'cultivation' },
    { regex: /修炼一(年|个月|月|天|日)/i, type: 'cultivation', fixed: 1 },
    { regex: /赶路(\d+)(年|个月|月|天|日)/i, type: 'travel' },
    { regex: /昏迷(\d+)(年|个月|月|天|日)/i, type: 'coma' },
    { regex: /养伤(\d+)(年|个月|月|天|日)/i, type: 'recovery' },
    { regex: /打坐(\d+)(年|个月|月|天|日)/i, type: 'cultivation' },
  ];
  for (const p of patterns) {
    const m = input.match(p.regex);
    if (m) {
      let amount = p.fixed || parseInt(m[1]);
      const unit = m[2];
      let days;
      if (unit.includes('年')) days = amount * 365;
      else if (unit.includes('月')) days = amount * 30;
      else days = amount;
      return { type: p.type, days, original: m[0], amount, unit };
    }
  }
  return null;
}
function getUserFromRequest(req) {
  // Simple user id: device cookie (first visit generates a uuid)
  const cookies = parseCookies(req.headers.cookie || '');
  let uid = cookies.wenyou_uid;
  if (!uid) {
    uid = 'user_' + Date.now() + '_' + Math.random().toString(36).slice(2, 10);
    return { uid, needSetCookie: true };
  }
  return { uid, needSetCookie: false };
}
function parseCookies(str) {
  const o = {};
  str.split(';').forEach(p => {
    const idx = p.indexOf('=');
    if (idx > 0) o[p.slice(0, idx).trim()] = p.slice(idx + 1).trim();
  });
  return o;
}

// ===== Model configs =====
function getDefaultModelConfig(user_id) {
  const list = modelConfigsStore.all(x => x.user_id === user_id);
  return list.find(x => x.is_default) || list[0] || null;
}
function getLLMConfig(modelConfig) {
  const api_key = decrypt(modelConfig.api_key_enc);
  return { base_url: modelConfig.base_url, api_key, model: modelConfig.model, params: modelConfig.params };
}

// ===== Endpoint handlers =====
const handlers = {
  // ---------- manageModel ----------
  manageModel: async ({ action, config }, user_id) => {
    switch (action) {
      case 'create': {
        if (!config.name || !config.api_key) return { error: '名称和API Key不能为空' };
        if (config.is_default !== false) {
          modelConfigsStore.update(x => x.user_id === user_id, { is_default: false });
        }
        const encrypted = encrypt(config.api_key);
        const rec = modelConfigsStore.add({
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
        });
        return { success: true, _id: rec._id };
      }
      case 'list': {
        const list = modelConfigsStore.all(x => x.user_id === user_id).map(c => ({
          ...c, api_key_enc: undefined, has_key: !!c.api_key_enc,
        }));
        if (!list.length) return { configs: [], default_config: null, hint: '请先添加模型配置，默认推荐mimo中转站' };
        const def = list.find(c => c.is_default) || list[0];
        return { configs: list, default_config: def };
      }
      case 'update': {
        if (!config._id) return { error: '缺少配置ID' };
        const existing = modelConfigsStore.first(x => x._id === config._id && x.user_id === user_id);
        if (!existing) return { error: '配置不存在' };
        const patch = { name: config.name, base_url: config.base_url, model: config.model, params: config.params, headers: config.headers };
        if (config.api_key) patch.api_key_enc = encrypt(config.api_key);
        if (config.is_default) {
          modelConfigsStore.update(x => x.user_id === user_id, { is_default: false });
          patch.is_default = true;
        }
        Object.keys(patch).forEach(k => patch[k] === undefined && delete patch[k]);
        modelConfigsStore.update(x => x._id === config._id && x.user_id === user_id, patch);
        return { success: true };
      }
      case 'delete': {
        if (!config._id) return { error: '缺少配置ID' };
        const doc = modelConfigsStore.first(x => x._id === config._id);
        if (!doc || doc.user_id !== user_id) return { error: '无权删除此配置' };
        const wasDefault = doc.is_default;
        modelConfigsStore.remove(x => x._id === config._id);
        if (wasDefault) {
          const rest = modelConfigsStore.all(x => x.user_id === user_id).sort((a, b) => new Date(b.created_at) - new Date(a.created_at));
          if (rest[0]) modelConfigsStore.update(x => x._id === rest[0]._id, { is_default: true });
        }
        return { success: true };
      }
      case 'setDefault': {
        if (!config._id) return { error: '缺少配置ID' };
        modelConfigsStore.update(x => x.user_id === user_id, { is_default: false });
        modelConfigsStore.update(x => x._id === config._id && x.user_id === user_id, { is_default: true });
        return { success: true };
      }
      case 'get': {
        let mc;
        if (config && config._id) mc = modelConfigsStore.first(x => x._id === config._id && x.user_id === user_id);
        else mc = getDefaultModelConfig(user_id);
        if (!mc) return { error: '未找到模型配置，请先添加配置' };
        return {
          config: {
            _id: mc._id, name: mc.name, base_url: mc.base_url,
            api_key: decrypt(mc.api_key_enc),
            model: mc.model, params: mc.params, headers: mc.headers,
          }
        };
      }
      case 'listModels': {
        const { base_url, api_key_enc } = config || {};
        if (!base_url) return { models: [], error: '缺少Base URL' };
        const api_key = api_key_enc ? decrypt(api_key_enc) : '';
        try {
          const r = await callLLM({ base_url, api_key, model: '', messages: [], stream: false, endpoint_type: 'models' });
          return { models: (r.data || []).map(m => m.id || m).filter(Boolean) };
        } catch (e) { return { models: [], error: '无法获取模型列表：' + e.message }; }
      }
      case 'test': {
        const { base_url, api_key, model } = config || {};
        if (!base_url || !api_key || !model) return { success: false, error: '缺少必要参数' };
        try {
          const r = await callLLM({ base_url, api_key, model, messages: [{ role: 'user', content: '回复"OK"两个字即可' }], params: { temperature: 0.1, max_tokens: 10 }, stream: false });
          return { success: true, response: r.text.slice(0, 50) };
        } catch (e) { return { success: false, error: e.message }; }
      }
      default: return { error: '未知操作: ' + action };
    }
  },

  // ---------- manageSave ----------
  manageSave: async ({ action, game_id, save_id, player_name, ...rest }, user_id) => {
    const gid = game_id || DEFAULT_GAME_ID;
    switch (action) {
      case 'create': {
        const count = savesStore.all(x => x.user_id === user_id && x.game_id === gid).length;
        if (count >= SAVE_LIMIT_PER_USER) return { error: `每个世界最多创建${SAVE_LIMIT_PER_USER}个存档` };
        const newSaveId = 'save_' + Date.now() + '_' + Math.random().toString(36).slice(2, 8);
        const now = new Date().toISOString();
        savesStore.add({
          save_id: newSaveId, user_id, game_id: gid,
          player_name: player_name || '新玩家',
          player_realm: '炼气',
          current_region: 'yueguo_qipai',
          current_npc: null,
          mode: 'sandbox',
          current_model_config_id: null,
          current_date: '天南历412年三月初七',
          world_time_days: 0,
          turn_counter: 0,
          created_at: now, updated_at: now, last_played: now,
        });
        // Create initial files
        const initFiles = {
          'player': '# 主角\n\n待创建...\n',
          'state': '# 状态\n\n境界: 炼气\n位置: 越国七派\n物品:\n关系:\n声望: 无名小辈\n目标:\n',
          'world_state': '# 世界动态状态\n\n越国七派表面平静，暗潮涌动。\n',
          'summary': '# 对话摘要\n\n游戏刚开始。\n',
          'threads': '# 线索追踪\n\n尚无主动目标。\n',
        };
        for (const [fn, c] of Object.entries(initFiles)) {
          writeFileSafe(savePath(user_id, gid, newSaveId, fn), c);
        }
        return { success: true, save_id: newSaveId, game_id: gid };
      }
      case 'list': {
        const list = savesStore.all(x => x.user_id === user_id && x.game_id === gid)
          .sort((a, b) => new Date(b.last_played) - new Date(a.last_played))
          .slice(0, SAVE_LIMIT_PER_USER);
        return {
          saves: list.map(s => ({
            save_id: s.save_id, player_name: s.player_name, player_realm: s.player_realm,
            current_region: s.current_region, current_date: s.current_date,
            last_played: s.last_played, created_at: s.created_at,
          }))
        };
      }
      case 'delete': {
        if (!save_id) return { error: '缺少save_id' };
        const s = savesStore.first(x => x.save_id === save_id && x.user_id === user_id);
        if (!s) return { error: '存档不存在或无权删除' };
        deleteDirSafe(path.join(SAVE_ROOT, user_id, gid, save_id));
        savesStore.remove(x => x.save_id === save_id && x.user_id === user_id);
        conversationsStore.remove(x => x.save_id === save_id && x.user_id === user_id);
        charactersStore.remove(x => x.save_id === save_id && x.user_id === user_id);
        return { success: true };
      }
      case 'get': {
        if (!save_id) return { error: '缺少save_id' };
        const s = savesStore.first(x => x.save_id === save_id && x.user_id === user_id);
        if (!s) return { error: '存档不存在' };
        const [player, state, world_state, summary, threads] = await Promise.all([
          readFileSafe(savePath(user_id, gid, save_id, 'player')),
          readFileSafe(savePath(user_id, gid, save_id, 'state')),
          readFileSafe(savePath(user_id, gid, save_id, 'world_state')),
          readFileSafe(savePath(user_id, gid, save_id, 'summary')),
          readFileSafe(savePath(user_id, gid, save_id, 'threads')),
        ]);
        const npcs = charactersStore.all(x => x.save_id === save_id && x.type === 'npc');
        return { save: s, files: { player, state, world_state, summary, threads }, npcs };
      }
      case 'updateMeta': {
        if (!save_id) return { error: '缺少save_id' };
        const patch = { updated_at: new Date().toISOString() };
        if (rest.player_name) patch.player_name = rest.player_name;
        if (rest.player_realm) patch.player_realm = rest.player_realm;
        if (rest.current_region) patch.current_region = rest.current_region;
        if (rest.current_npc !== undefined) patch.current_npc = rest.current_npc;
        if (rest.current_date) patch.current_date = rest.current_date;
        if (rest.turn_counter !== undefined) patch.turn_counter = rest.turn_counter;
        if (rest.last_played) patch.last_played = rest.last_played;
        if (rest.mode) patch.mode = rest.mode;
        savesStore.update(x => x.save_id === save_id && x.user_id === user_id, patch);
        return { success: true };
      }
      default: return { error: '未知操作: ' + action };
    }
  },

  // ---------- createCharacter ----------
  createCharacter: async ({ action, save_id, game_id, description }, user_id) => {
    const gid = game_id || DEFAULT_GAME_ID;
    const mc = getDefaultModelConfig(user_id);
    if (!mc) return { error: '请先在模型管理中添加并配置API Key' };
    const llm = getLLMConfig(mc);

    if (action === 'createPlayer') {
      if (!description) return { error: '请输入角色描述' };
      const prompt = `你是一个角色创建助手，根据玩家的描述生成凡人修仙传世界观下的主角角色卡。

玩家描述：${description}

请严格按以下JSON格式输出，不要输出其他内容：
{
  "name": "姓名（中文）",
  "appearance": "外貌描述（1-2句话）",
  "spirit_root": "灵根类型，只能是：天灵根/双灵根/三灵根/四灵根/五灵根/异灵根",
  "faction": "所属门派或散修",
  "realm": "初始境界，固定为炼气",
  "background": "背景故事（2-3句话）",
  "personality": "性格特点"
}

如果玩家没有提供某项信息，根据凡人修仙传的世界观合理推断。用中文。`;
      const { text } = await callLLM({ ...llm, messages: [{ role: 'system', content: prompt }], stream: false });
      const card = parseCharacterCard(text);
      if (!card) return { error: '角色卡生成失败，请重试', raw: text };
      card.realm = card.realm || '炼气';
      card.faction = card.faction || '散修';
      card.spirit_root = card.spirit_root || '四灵根';

      const playerMd = `# ${card.name}

## 基本信息
- 姓名：${card.name}
- 灵根：${card.spirit_root}
- 门派：${card.faction}
- 境界：${card.realm}

## 外貌
${card.appearance}

## 性格
${card.personality}

## 背景
${card.background}
`;
      const stateMd = `# 状态

境界: ${card.realm}
位置: 越国七派
物品:
关系:
声望: 无名小辈
目标:
`;
      writeFileSafe(savePath(user_id, gid, save_id, 'player'), playerMd);
      writeFileSafe(savePath(user_id, gid, save_id, 'state'), stateMd);
      savesStore.update(x => x.save_id === save_id && x.user_id === user_id, {
        player_name: card.name, player_realm: card.realm, updated_at: new Date().toISOString(),
      });
      return { success: true, card, playerMd };
    }

    if (action === 'createNPC') {
      if (!description) return { error: '请输入NPC描述' };
      const save = savesStore.first(x => x.save_id === save_id && x.user_id === user_id);
      const region = save?.current_region || 'yueguo_qipai';
      const prompt = `你是一个角色创建助手，根据描述生成凡人修仙传世界观下的重要NPC角色卡。

描述：${description}
当前区域：${region}

请严格按以下JSON格式输出，不要输出其他内容：
{
  "id": "英文id，小写字母加下划线，例如 lu_yun",
  "name": "姓名（中文）",
  "appearance": "外貌描写",
  "personality": "性格",
  "background": "背景故事",
  "secrets": "秘密（仅该NPC知道，不轻易告诉别人）",
  "faction": "门派/势力",
  "realm": "境界（炼气/筑基/结丹/元婴/化神等）",
  "region": "所在区域",
  "voice": "说话风格概括",
  "speech_style": {
    "catchphrase": "口头禅，没有就留空",
    "forbidden": ["禁止说的话或做的事"]
  },
  "style_sample": {
    "good": "符合角色风格的台词示例",
    "bad": "不符合角色风格的反例"
  },
  "tags": ["标签1", "标签2"]
}

用中文，信息不足时根据世界观合理推断。`;
      const { text } = await callLLM({ ...llm, messages: [{ role: 'system', content: prompt }], stream: false });
      const card = parseCharacterCard(text);
      if (!card || !card.name) return { error: 'NPC生成失败，请重试', raw: text };
      const npc_id = card.id || `npc_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;
      card.id = npc_id;
      card.created_by = 'player';
      card.created_at = new Date().toISOString();
      const npcMd = `---
id: ${npc_id}
name: ${card.name}
created_by: player
region: ${card.region || region}
faction: ${card.faction || '散修'}
realm: ${card.realm || '炼气'}
tags: ${JSON.stringify(card.tags || [])}
voice: ${card.voice || '正常'}
---

# 静态设定

## 外貌
${card.appearance}

## 性格
${card.personality}

## 背景
${card.background}

## 秘密
${card.secrets}

# 说话风格
- 口头禅：${card.speech_style?.catchphrase || '无'}
- 禁止行为：
${(card.speech_style?.forbidden || []).map(f => `- ${f}`).join('\n')}

# 风格样本
- 好的示例：${card.style_sample?.good || ''}
- 坏的示例（避免）：${card.style_sample?.bad || ''}

# 关系
- 玩家：初识

# 当前状态
- 位置：${card.region || region}
- 情绪：平静
- 当前活动：

# 私有记忆区（只追加，玩家当面告知的信息才进这里）
`;
      writeFileSafe(savePath(user_id, gid, save_id, `npcs/${npc_id}`), npcMd);
      writeFileSafe(savePath(user_id, gid, save_id, `npc_memory/${npc_id}`), `# ${card.name} 对玩家的记忆\n\n`);
      charactersStore.add({
        user_id, game_id: gid, save_id,
        type: 'npc', npc_id, name: card.name,
        importance: 'important', realm: card.realm, faction: card.faction,
        file_path: `npcs/${npc_id}.md`,
        created_at: new Date().toISOString(),
      });
      return { success: true, npc_id, card, npcMd };
    }

    return { error: '未知操作: ' + action };
  },

  // ---------- chat ----------
  chat: async ({ game_id, save_id, npc_id, user_input, reroll, turn_id, model_config_id }, user_id) => {
    const gid = game_id || DEFAULT_GAME_ID;
    if (!save_id) return { error: '缺少save_id，请先选择或创建存档' };
    if (!user_input || !user_input.trim()) return { error: '请输入内容' };

    const save = savesStore.first(x => x.save_id === save_id && x.user_id === user_id);
    if (!save) return { error: '存档不存在' };

    // Get model config
    let mc;
    if (model_config_id) mc = modelConfigsStore.first(x => x._id === model_config_id && x.user_id === user_id);
    else if (save.current_model_config_id) mc = modelConfigsStore.first(x => x._id === save.current_model_config_id);
    else mc = getDefaultModelConfig(user_id);
    if (!mc) return { error: '请先在模型管理中配置API Key' };
    const llm = getLLMConfig(mc);

    let effectiveTurnId = turn_id;
    if (reroll && !effectiveTurnId) return { error: 'reroll需要turn_id' };
    if (!reroll) effectiveTurnId = `turn_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;

    const is_important = !!npc_id;
    const turn_counter = save.turn_counter || 0;

    // Read files
    const reads = {
      world: (async () => {
        if (turn_counter === 0 || turn_counter % 8 === 0) {
          const fn = turn_counter === 0 ? 'world.md' : 'world_compressed.md';
          return readFileSafe(gamePath(gid, fn));
        }
        return null;
      })(),
      region: readFileSafe(gamePath(gid, `regions/${save.current_region}.md`)),
      world_state: readFileSafe(savePath(user_id, gid, save_id, 'world_state')),
      npc: is_important ? readFileSafe(savePath(user_id, gid, save_id, `npcs/${npc_id}`)) : Promise.resolve(null),
      npc_memory: is_important ? readFileSafe(savePath(user_id, gid, save_id, `npc_memory/${npc_id}`)) : Promise.resolve(null),
      player: readFileSafe(savePath(user_id, gid, save_id, 'player')),
      state: readFileSafe(savePath(user_id, gid, save_id, 'state')),
      summary: readFileSafe(savePath(user_id, gid, save_id, 'summary')),
      threads: readFileSafe(savePath(user_id, gid, save_id, 'threads')),
    };
    const sections = {};
    for (const [k, p] of Object.entries(reads)) sections[k] = await p;

    // Time skip
    sections.timeSkipReport = null;
    let timeSkip = null;
    if (!reroll) {
      timeSkip = detectTimeSkip(user_input.trim());
      if (timeSkip) {
        const y = timeSkip.days >= 365 ? `${Math.floor(timeSkip.days/365)}年` : '';
        const mo = timeSkip.days % 365 >= 30 ? `${Math.floor((timeSkip.days%365)/30)}个月` : '';
        const d = timeSkip.days % 30 > 0 ? `${timeSkip.days%30}天` : '';
        const ts = [y, mo, d].filter(Boolean).join('');
        const typeLabel = timeSkip.type === 'cultivation' ? '闭关修炼' : timeSkip.type === 'travel' ? '赶路' : timeSkip.type === 'coma' ? '昏迷' : '养伤';
        sections.timeSkipReport = `时间过去了${ts}（${timeSkip.original}）。
请根据「${typeLabel}」合理推演：
1. 玩家的修为/伤势/位置变化
2. 这段时间世界上可能发生的小事
3. NPC们的变化
不要夸张，符合凡人修仙传世界观，节奏平稳。`;
      }
    }

    // Recent history
    const hist = conversationsStore.all(x => x.save_id === save_id && x.is_final)
      .sort((a, b) => new Date(b.timestamp) - new Date(a.timestamp))
      .slice(0, RECENT_HISTORY_LIMIT)
      .reverse()
      .map(c => ({ role: c.role, content: c.content }));

    const systemPrompt = buildSystemPrompt(sections);
    const messages = [
      { role: 'system', content: systemPrompt },
      ...hist,
      { role: 'user', content: user_input.trim() },
    ];

    // Call LLM
    const { stream } = await callLLM({ ...llm, messages, stream: true });
    const fullText = await collectStream(stream);
    const { reply, memory, state, director } = parseSegments(fullText);
    if (!reply || reply.length === 0) return { error: 'AI回复为空，请重试' };

    // Persist
    if (!reroll) {
      const now = new Date().toISOString();
      conversationsStore.add({
        user_id, game_id: gid, save_id, npc_id,
        npc_importance: is_important ? 'important' : 'minor',
        role: 'user', content: user_input.trim(),
        timestamp: now, turn_id: effectiveTurnId,
        candidate_version: 1, is_final: true,
      });
      conversationsStore.add({
        user_id, game_id: gid, save_id, npc_id,
        npc_importance: is_important ? 'important' : 'minor',
        role: 'assistant', content: reply,
        timestamp: now, turn_id: effectiveTurnId,
        candidate_version: 1, is_final: true, reroll_count: 0,
      });

      if (is_important && memory.length > 0) {
        const mt = `## ${new Date().toLocaleString('zh-CN')}\n${memory.map(m => `- ${m}`).join('\n')}\n`;
        appendFileSafe(savePath(user_id, gid, save_id, `npc_memory/${npc_id}`), mt);
      }
      if (state.length > 0) {
        const st = `\n## ${new Date().toLocaleString('zh-CN')} 状态更新\n${state.map(s => `- ${s}`).join('\n')}\n`;
        appendFileSafe(savePath(user_id, gid, save_id, 'state'), st);
      }
      if (director && director.length > 0) {
        appendFileSafe(savePath(user_id, gid, save_id, 'threads'), `\n- ${director}`);
      }

      const newTurnCounter = turn_counter + 1;
      const patch = { turn_counter: newTurnCounter, last_played: now };
      if (npc_id) patch.current_npc = npc_id;
      if (timeSkip) patch.world_time_days = (save.world_time_days || 0) + timeSkip.days;
      savesStore.update(x => x.save_id === save_id && x.user_id === user_id, patch);

      const shouldSuggestCompression = newTurnCounter > 0 && newTurnCounter % 8 === 0;
      return {
        success: true, reply, turn_id: effectiveTurnId,
        state_updated: state.length > 0, memory_updated: memory.length > 0,
        objectives: director, turn_counter: newTurnCounter,
        shouldSuggestCompression, rerollable: true,
        time_skipped: timeSkip ? timeSkip.days : 0,
      };
    } else {
      return {
        success: true, reply, turn_id: effectiveTurnId, reroll: true,
        state_updated: false, memory_updated: false, rerollable: true,
      };
    }
  },

  // ---------- characters list ----------
  characters: async ({ action, save_id, type }, user_id) => {
    if (action === 'list') {
      const list = charactersStore.all(x => x.save_id === save_id && x.type === type);
      return { data: list };
    }
    return { error: '未知操作' };
  },

  // ---------- history ----------
  history: async ({ save_id }, user_id) => {
    const list = conversationsStore.all(x => x.save_id === save_id && x.is_final)
      .sort((a, b) => new Date(a.timestamp) - new Date(b.timestamp))
      .slice(0, 50);
    return { data: list };
  },

  // ---------- knowledge file ----------
  file: async ({ game_id, filename }, user_id) => {
    const gid = game_id || DEFAULT_GAME_ID;
    const content = readFileSafe(gamePath(gid, filename));
    if (content === null) return { error: '文件不存在' };
    return { content };
  },
};

// ===== Build system prompt =====
function buildSystemPrompt(sections) {
  const { world, region, world_state, npc, npc_memory, player, state, summary, threads, timeSkipReport } = sections;
  let p = '';
  if (world) p += `【世界规则】\n${world}\n\n`;
  if (region) p += `【当前区域】\n${region}\n\n`;
  if (world_state) p += `【世界当前动态】\n${world_state}\n\n`;
  if (npc) {
    p += `【你扮演的角色】\n${npc}\n\n`;
  } else {
    p += `【当前场景】\n自由探索模式，请根据玩家描述即兴扮演当前遇到的人物/叙述环境。次要角色不需要记忆和一致性。\n\n`;
  }
  if (npc_memory && npc) p += `【你对玩家的记忆】\n${npc_memory}\n\n`;
  if (player) p += `【玩家档案】\n${player}\n\n`;
  if (state) p += `【玩家当前状态】\n${state}\n\n`;
  if (summary) p += `【之前对话摘要】\n${summary}\n\n`;
  if (threads && threads.length > 0) p += `【玩家主动目标/未了之事】\n${threads}\n\n`;
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
- （玩家目标/承诺，没有就留空，每行一条）
`;
  return p;
}

// ===== HTTP Server =====
function sendJson(res, status, data, extraHeaders = {}) {
  const body = JSON.stringify(data);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
    ...extraHeaders,
  });
  res.end(body);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let d = '';
    req.on('data', c => d += c);
    req.on('end', () => {
      try { resolve(d ? JSON.parse(d) : {}); }
      catch (e) { reject(new Error('Invalid JSON body: ' + e.message)); }
    });
    req.on('error', reject);
  });
}

async function handleRequest(req, res) {
  // CORS
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return; }

  const parsedUrl = url.parse(req.url, true);
  const pathname = parsedUrl.pathname;

  // User session
  const { uid, needSetCookie } = getUserFromRequest(req);
  const extraHeaders = needSetCookie ? { 'Set-Cookie': `wenyou_uid=${uid}; Path=/; SameSite=Lax; Max-Age=31536000` } : {};

  try {
    if (req.method !== 'POST') {
      sendJson(res, 405, { error: 'Method not allowed' }, extraHeaders);
      return;
    }

    const body = await readBody(req);
    let result;

    if (pathname === '/api/manageModel') result = await handlers.manageModel(body, uid);
    else if (pathname === '/api/manageSave') result = await handlers.manageSave(body, uid);
    else if (pathname === '/api/createCharacter') result = await handlers.createCharacter(body, uid);
    else if (pathname === '/api/chat') result = await handlers.chat(body, uid);
    else if (pathname === '/api/characters') result = await handlers.characters(body, uid);
    else if (pathname === '/api/history') result = await handlers.history(body, uid);
    else if (pathname === '/api/file') result = await handlers.file(body, uid);
    else { sendJson(res, 404, { error: 'Not found: ' + pathname }, extraHeaders); return; }

    sendJson(res, 200, result, extraHeaders);
  } catch (e) {
    console.error('Handler error:', e);
    sendJson(res, 500, { error: e.message || 'Internal error' }, extraHeaders);
  }
}

// Start server if run directly
if (require.main === module) {
  const PORT = process.env.PORT || 3000;
  // Serve static files from /miniprogram and /data/games
  const STATIC_DIR = path.join(__dirname, '..');
  const server = http.createServer(async (req, res) => {
    const parsedUrl = url.parse(req.url, true);
    const pathname = parsedUrl.pathname;
    if (pathname.startsWith('/api/')) {
      handleRequest(req, res);
      return;
    }
    // Static file
    let filePath = pathname === '/' ? '/index.html' : decodeURIComponent(pathname);
    // Map /pages/xxx/xxx.html to /miniprogram/pages/xxx/xxx.html
    if (filePath.startsWith('/pages/') || filePath.startsWith('/lib/')) {
      filePath = '/miniprogram' + filePath;
    }
    const fullPath = path.join(STATIC_DIR, filePath);
    // Security: prevent path traversal
    if (!fullPath.startsWith(STATIC_DIR)) { res.writeHead(403); res.end('Forbidden'); return; }
    try {
      if (fs.existsSync(fullPath) && fs.statSync(fullPath).isFile()) {
        const ext = path.extname(fullPath).toLowerCase();
        const mime = {
          '.html': 'text/html; charset=utf-8',
          '.js': 'application/javascript; charset=utf-8',
          '.css': 'text/css; charset=utf-8',
          '.json': 'application/json; charset=utf-8',
          '.md': 'text/markdown; charset=utf-8',
          '.png': 'image/png', '.jpg': 'image/jpeg', '.gif': 'image/gif',
          '.svg': 'image/svg+xml',
        }[ext] || 'application/octet-stream';
        const content = fs.readFileSync(fullPath);
        res.writeHead(200, { 'Content-Type': mime, 'Content-Length': content.length });
        res.end(content);
      } else {
        res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
        res.end('404 Not Found: ' + filePath);
      }
    } catch (e) {
      res.writeHead(500, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end('500: ' + e.message);
    }
  });
  server.listen(PORT, () => {
    console.log(`AI 文游服务器运行在 http://localhost:${PORT}`);
  });
}

module.exports = { handlers, handleRequest, JsonStore, encrypt, decrypt, callLLM, parseSegments, buildSystemPrompt };
