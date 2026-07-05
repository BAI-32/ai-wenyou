const cloud = require('wx-server-sdk');
const { readSaveFile, writeSaveFile, appendToSaveFile, readGameFile } = require('../shared/fileStorage');
const { callLLM, collectStream } = require('../shared/llmGateway');
const { parseSegments } = require('../shared/parser');
const { decrypt } = require('../shared/encryption');

cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });
const db = cloud.database();

const DEFAULT_GAME_ID = 'frxz';
const RECENT_HISTORY_LIMIT = 20;

/**
 * 检测用户输入中的时间跳跃
 */
function detectTimeSkip(userInput) {
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
    const match = userInput.match(p.regex);
    if (match) {
      let amount = p.fixed || parseInt(match[1]);
      const unit = match[2];
      let days;
      if (unit.includes('年')) {
        days = amount * 365;
      } else if (unit.includes('月')) {
        days = amount * 30;
      } else {
        days = amount;
      }
      return { type: p.type, days, original: match[0], amount, unit };
    }
  }
  return null;
}

/**
 * 组装系统Prompt
 */
function buildSystemPrompt(sections, npcInfo) {
  const { world, region, world_state, npc, npc_memory, player, state, summary, threads, timeSkipReport } = sections;

  let prompt = '';

  // 世界规则
  if (world) {
    prompt += `【世界规则】
${world}

`;
  }

  // 区域信息
  if (region) {
    prompt += `【当前区域】
${region}

`;
  }

  // 世界动态状态
  if (world_state) {
    prompt += `【世界当前动态】
${world_state}

`;
  }

  // NPC设定
  if (npc) {
    prompt += `【你扮演的角色】
${npc}

`;
  } else {
    // 自由探索模式，即兴NPC
    prompt += `【当前场景】
自由探索模式，请根据玩家描述即兴扮演当前遇到的人物/叙述环境。次要角色不需要记忆和一致性。

`;
  }

  // NPC对玩家的记忆
  if (npc_memory && npc) {
    prompt += `【你对玩家的记忆】
${npc_memory}

`;
  }

  // 玩家档案
  if (player) {
    prompt += `【玩家档案】
${player}

`;
  }

  // 玩家当前状态
  if (state) {
    prompt += `【玩家当前状态】
${state}

`;
  }

  // 对话摘要
  if (summary) {
    prompt += `【之前对话摘要】
${summary}

`;
  }

  // 线索提示
  if (threads && threads.length > 0) {
    prompt += `【玩家主动目标/未了之事】
${threads}

`;
  }

  // 时间跳跃提示
  if (timeSkipReport) {
    prompt += `【系统提示：时间流逝】
${timeSkipReport}
请在回复中自然体现这些变化。

`;
  }

  // 铁律
  prompt += `【铁律】
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

  return prompt;
}

exports.main = async (event, context) => {
  const wxContext = cloud.getWXContext();
  const user_id = wxContext.OPENID;
  const {
    game_id = DEFAULT_GAME_ID,
    save_id,
    npc_id = null,
    user_input,
    reroll = false,
    turn_id = null,
    model_config_id = null,
  } = event;

  try {
    if (!save_id) return { error: '缺少save_id，请先选择或创建存档' };
    if (!user_input || !user_input.trim()) return { error: '请输入内容' };

    // 1. 获取存档信息
    const saveRes = await db.collection('saves').where({ save_id, user_id }).limit(1).get();
    if (saveRes.data.length === 0) {
      return { error: '存档不存在' };
    }
    const save = saveRes.data[0];

    // 2. 获取模型配置
    let modelConfig;
    if (model_config_id) {
      const mcRes = await db.collection('model_configs').doc(model_config_id).get();
      modelConfig = mcRes.data;
    } else if (save.current_model_config_id) {
      const mcRes = await db.collection('model_configs').doc(save.current_model_config_id).get();
      modelConfig = mcRes.data;
    } else {
      const mcRes = await db.collection('model_configs')
        .where({ user_id, is_default: true })
        .limit(1).get();
      modelConfig = mcRes.data[0];
    }
    if (!modelConfig) {
      return { error: '请先在模型管理中配置API Key' };
    }
    const api_key = decrypt(modelConfig.api_key_enc);
    const llmConfig = {
      base_url: modelConfig.base_url,
      api_key,
      model: modelConfig.model,
      params: modelConfig.params,
    };

    // 3. Reroll处理：如果是重摇，检查是否在同一轮
    let effectiveTurnId = turn_id;
    if (reroll && !effectiveTurnId) {
      return { error: 'reroll需要turn_id' };
    }
    if (!reroll) {
      effectiveTurnId = `turn_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;
    }

    // 4. 组装上下文
    const is_important = !!npc_id;
    const turn_counter = save.turn_counter || 0;

    // 并行读取所有需要的文件
    const readPromises = {
      // 世界规则：根据turn_counter决定加载全量/压缩/不加载
      world: (async () => {
        if (turn_counter === 0 || turn_counter % 8 === 0) {
          const filename = turn_counter === 0 ? 'world.md' : 'world_compressed.md';
          return await readGameFile(game_id, filename);
        }
        return null;
      })(),
      region: readGameFile(game_id, `regions/${save.current_region}.md`),
      world_state: readSaveFile(user_id, game_id, save_id, 'world_state'),
      npc: is_important ? readSaveFile(user_id, game_id, save_id, `npcs/${npc_id}`) : Promise.resolve(null),
      npc_memory: is_important ? readSaveFile(user_id, game_id, save_id, `npc_memory/${npc_id}`) : Promise.resolve(null),
      player: readSaveFile(user_id, game_id, save_id, 'player'),
      state: readSaveFile(user_id, game_id, save_id, 'state'),
      summary: readSaveFile(user_id, game_id, save_id, 'summary'),
      threads: readSaveFile(user_id, game_id, save_id, 'threads'),
    };

    const sections = {};
    for (const [key, promise] of Object.entries(readPromises)) {
      sections[key] = await promise;
    }

    // 5. 时间跳跃检测与处理（非reroll时才推进时间）
    sections.timeSkipReport = null;
    let timeSkip = null;
    if (!reroll) {
      timeSkip = detectTimeSkip(user_input.trim());
      if (timeSkip) {
        // 简单版时间推进：生成报告，实际完整演化在Phase3实现
        // 这里先生成基础的时间流逝提示注入给LLM，让LLM处理变化
        const yearUnit = timeSkip.days >= 365 ? `${Math.floor(timeSkip.days/365)}年` : '';
        const monthUnit = timeSkip.days % 365 >= 30 ? `${Math.floor((timeSkip.days%365)/30)}个月` : '';
        const dayUnit = timeSkip.days % 30 > 0 ? `${timeSkip.days%30}天` : '';
        const timeStr = [yearUnit, monthUnit, dayUnit].filter(Boolean).join('');
        sections.timeSkipReport = `时间过去了${timeStr}（${timeSkip.original}）。
请根据「${timeSkip.type === 'cultivation' ? '闭关修炼' : timeSkip.type === 'travel' ? '赶路' : timeSkip.type === 'coma' ? '昏迷' : '养伤'}」合理推演：
1. 玩家的修为/伤势/位置变化
2. 这段时间世界上可能发生的小事
3. NPC们的变化
不要夸张，符合凡人修仙传世界观，节奏平稳。`;
      }
    }

    // 6. 读取最近对话历史
    const historyRes = await db.collection('conversations')
      .where({ save_id })
      .orderBy('timestamp', 'desc')
      .limit(RECENT_HISTORY_LIMIT)
      .get();
    const history = historyRes.data.reverse().map(c => ({
      role: c.role,
      content: c.content,
    }));

    // 7. 构建系统Prompt和消息列表
    const systemPrompt = buildSystemPrompt(sections, { npc_id, is_important });
    const messages = [
      { role: 'system', content: systemPrompt },
      ...history,
      { role: 'user', content: user_input.trim() },
    ];

    // 8. 调用LLM（暂先收集完整流，后续再做SSE实时转发）
    const { stream } = await callLLM({
      ...llmConfig,
      messages,
      stream: true,
    });
    const fullText = await collectStream(stream);

    // 9. 解析四段
    const { reply, memory, state, director } = parseSegments(fullText);

    if (!reply || reply.length === 0) {
      return { error: 'AI回复为空，请重试' };
    }

    // 10. 非reroll时持久化
    if (!reroll) {
      // 写用户消息和AI回复到对话历史
      const now = db.serverDate();
      await db.collection('conversations').add({
        data: {
          user_id,
          game_id,
          save_id,
          npc_id,
          npc_importance: is_important ? 'important' : 'minor',
          role: 'user',
          content: user_input.trim(),
          timestamp: now,
          turn_id: effectiveTurnId,
          candidate_version: 1,
          is_final: true,
        }
      });
      await db.collection('conversations').add({
        data: {
          user_id,
          game_id,
          save_id,
          npc_id,
          npc_importance: is_important ? 'important' : 'minor',
          role: 'assistant',
          content: reply,
          timestamp: now,
          turn_id: effectiveTurnId,
          candidate_version: 1,
          is_final: true,
          reroll_count: 0,
        }
      });

      // 追加NPC记忆（仅重要NPC）
      if (is_important && memory.length > 0) {
        const memoryText = `## ${new Date().toLocaleString('zh-CN')}\n${memory.map(m => `- ${m}`).join('\n')}\n`;
        await appendToSaveFile(user_id, game_id, save_id, `npc_memory/${npc_id}`, memoryText);
      }

      // 更新state.md（简单追加，Phase3做结构化更新）
      if (state.length > 0) {
        const stateText = `\n## ${new Date().toLocaleString('zh-CN')} 状态更新\n${state.map(s => `- ${s}`).join('\n')}\n`;
        await appendToSaveFile(user_id, game_id, save_id, 'state', stateText);
      }

      // 更新threads.md
      if (director && director.length > 0) {
        const threadText = `\n- ${director}`;
        await appendToSaveFile(user_id, game_id, save_id, 'threads', threadText);
      }

      // 更新存档元数据
      const newTurnCounter = turn_counter + 1;
      const updateData = {
        turn_counter: newTurnCounter,
        last_played: now,
      };
      if (npc_id) {
        updateData.current_npc = npc_id;
      }
      if (timeSkip) {
        // 更新世界时间（简单计算，后续替换为正式历法）
        updateData.world_time_days = (save.world_time_days || 0) + timeSkip.days;
      }
      await db.collection('saves').where({ save_id, user_id }).update({ data: updateData });

      // 提示是否需要压缩
      const shouldSuggestCompression = newTurnCounter > 0 && newTurnCounter % 8 === 0;

      return {
        success: true,
        reply,
        turn_id: effectiveTurnId,
        state_updated: state.length > 0,
        memory_updated: memory.length > 0,
        objectives: director,
        turn_counter: newTurnCounter,
        shouldSuggestCompression,
        rerollable: true,
        time_skipped: timeSkip ? timeSkip.days : 0,
      };
    } else {
      // Reroll：只返回新回复，不持久化（前端替换最后一条消息，用户确认后再持久化）
      // MVP简化版：reroll直接替换当前轮回复，暂不做候选保留
      return {
        success: true,
        reply,
        turn_id: effectiveTurnId,
        reroll: true,
        state_updated: false,
        memory_updated: false,
        rerollable: true,
      };
    }

  } catch (e) {
    console.error('chat error:', e);
    return { error: e.message || '对话失败，请重试' };
  }
};
