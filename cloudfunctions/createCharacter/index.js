const cloud = require('wx-server-sdk');
const { callLLM } = require('../shared/llmGateway');
const { decrypt } = require('../shared/encryption');
const { writeSaveFile } = require('../shared/fileStorage');
const { parseCharacterCard } = require('../shared/parser');

cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });
const db = cloud.database();

// 玩家创建Prompt
const PLAYER_CREATION_PROMPT = `你是一个角色创建助手，根据玩家的描述生成凡人修仙传世界观下的主角角色卡。

玩家描述：{{description}}

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

// NPC创建Prompt
const NPC_CREATION_PROMPT = `你是一个角色创建助手，根据描述生成凡人修仙传世界观下的重要NPC角色卡。

描述：{{description}}
当前区域：{{region}}

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
    "forbidden": ["禁止说的话或做的事，例如'不要自称老夫'、'不要主动透露秘密'"]
  },
  "style_sample": {
    "good": "符合角色风格的台词示例",
    "bad": "不符合角色风格的反例（避免八股）"
  },
  "tags": ["标签1", "标签2"]
}

用中文，信息不足时根据世界观合理推断。`;

exports.main = async (event) => {
  const wxContext = cloud.getWXContext();
  const user_id = wxContext.OPENID;
  const { action, save_id, game_id = 'frxz', description = '', mode = 'quick' } = event;

  try {
    // 获取默认模型配置
    const modelRes = await db.collection('model_configs')
      .where({ user_id, is_default: true })
      .limit(1)
      .get();

    let modelConfig = modelRes.data[0];
    // 如果没有默认配置，尝试取任意一个
    if (!modelConfig) {
      const allRes = await db.collection('model_configs').where({ user_id }).limit(1).get();
      modelConfig = allRes.data[0];
    }
    if (!modelConfig) {
      return { error: '请先在模型管理中添加并配置API Key' };
    }
    const api_key = decrypt(modelConfig.api_key_enc);
    const llmConfig = {
      base_url: modelConfig.base_url,
      api_key,
      model: modelConfig.model,
      params: modelConfig.params,
    };

    switch (action) {
      case 'createPlayer': {
        // 创建主角
        if (!description && mode !== 'interview') {
          return { error: '请输入角色描述或使用访谈模式' };
        }

        const prompt = PLAYER_CREATION_PROMPT.replace('{{description}}', description || '随机生成一个普通四灵根散修少年');

        const { text } = await callLLM({
          ...llmConfig,
          messages: [{ role: 'system', content: prompt }],
          stream: false,
        });

        const card = parseCharacterCard(text);
        if (!card) {
          return { error: '角色卡生成失败，请重试', raw: text };
        }

        // 补全默认值
        card.realm = card.realm || '炼气';
        card.faction = card.faction || '散修';
        card.spirit_root = card.spirit_root || '四灵根';

        // 格式化player.md
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

        // 更新state.md初始状态
        const stateMd = `# 状态

境界: ${card.realm}
位置: 越国七派
物品:
关系:
声望: 无名小辈
目标:
`;

        // 写入文件
        await writeSaveFile(user_id, game_id, save_id, 'player', playerMd);
        await writeSaveFile(user_id, game_id, save_id, 'state', stateMd);

        // 更新存档元数据
        await db.collection('saves').where({ save_id, user_id }).update({
          data: {
            player_name: card.name,
            player_realm: card.realm,
            updated_at: db.serverDate(),
          }
        });

        return { success: true, card, playerMd };
      }

      case 'createNPC': {
        // 创建重要NPC
        if (!description) {
          return { error: '请输入NPC描述' };
        }

        // 获取当前区域
        const saveRes = await db.collection('saves').where({ save_id, user_id }).limit(1).get();
        const currentRegion = saveRes.data[0]?.current_region || 'yueguo_qipai';

        const prompt = NPC_CREATION_PROMPT
          .replace('{{description}}', description)
          .replace('{{region}}', currentRegion);

        const { text } = await callLLM({
          ...llmConfig,
          messages: [{ role: 'system', content: prompt }],
          stream: false,
        });

        const card = parseCharacterCard(text);
        if (!card || !card.name) {
          return { error: 'NPC生成失败，请重试', raw: text };
        }

        // 生成npc_id
        const npc_id = card.id || `npc_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;
        card.id = npc_id;
        card.created_by = 'player';
        card.created_at = new Date().toISOString();

        // 格式化npc文件
        const npcMd = `---
id: ${npc_id}
name: ${card.name}
created_by: player
region: ${card.region || currentRegion}
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
- 位置：${card.region || currentRegion}
- 情绪：平静
- 当前活动：

# 私有记忆区（只追加，玩家当面告知的信息才进这里）
`;

        // 写入npc文件和空记忆文件
        await writeSaveFile(user_id, game_id, save_id, `npcs/${npc_id}`, npcMd);
        await writeSaveFile(user_id, game_id, save_id, `npc_memory/${npc_id}`, `# ${card.name} 对玩家的记忆\n\n`);

        // 添加到characters索引
        await db.collection('characters').add({
          data: {
            user_id,
            game_id,
            save_id,
            type: 'npc',
            npc_id,
            name: card.name,
            importance: 'important',
            realm: card.realm,
            faction: card.faction,
            file_path: `npcs/${npc_id}.md`,
            created_at: db.serverDate(),
          }
        });

        return { success: true, npc_id, card, npcMd };
      }

      default:
        return { error: '未知操作: ' + action };
    }
  } catch (e) {
    console.error('createCharacter error:', e);
    return { error: e.message || '创建失败' };
  }
};
