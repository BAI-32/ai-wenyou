const cloud = require('wx-server-sdk');
const { readSaveFile, writeSaveFile, deleteCloudDirectory, getSaveCloudPath } = require('../shared/fileStorage');

cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });
const db = cloud.database();

const DEFAULT_GAME_ID = 'frxz';
const SAVE_LIMIT_PER_USER = 10;

exports.main = async (event) => {
  const wxContext = cloud.getWXContext();
  const user_id = wxContext.OPENID;
  const { action, game_id, save_id, player_name } = event;
  const effectiveGameId = game_id || DEFAULT_GAME_ID;

  try {
    switch (action) {
      case 'create': {
        // 检查存档数量限制
        const countRes = await db.collection('saves').where({
          user_id,
          game_id: effectiveGameId,
        }).count();

        if (countRes.total >= SAVE_LIMIT_PER_USER) {
          return { error: `每个世界最多创建${SAVE_LIMIT_PER_USER}个存档，请先删除旧存档` };
        }

        const newSaveId = `save_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
        const now = db.serverDate();

        // 创建存档元数据
        await db.collection('saves').add({
          data: {
            save_id: newSaveId,
            user_id,
            game_id: effectiveGameId,
            player_name: player_name || '新玩家',
            player_realm: '炼气',
            current_region: 'yueguo_qipai',
            current_npc: null,
            mode: 'sandbox',
            current_model_config_id: null,
            current_date: '天南历412年三月初七',
            world_time_days: 0,
            turn_counter: 0,
            created_at: now,
            updated_at: now,
            last_played: now,
          }
        });

        // 创建初始空文件
        const initFiles = {
          'player': `# 主角\n\n待创建...\n`,
          'state': `# 状态\n\n境界: 炼气\n位置: 越国七派\n物品:\n关系:\n声望: 无名小辈\n目标:\n`,
          'world_state': `# 世界动态状态\n\n越国七派表面平静，暗潮涌动。\n`,
          'summary': `# 对话摘要\n\n游戏刚开始。\n`,
          'threads': `# 线索追踪\n\n尚无主动目标。\n`,
        };

        for (const [filename, content] of Object.entries(initFiles)) {
          await writeSaveFile(user_id, effectiveGameId, newSaveId, filename, content);
        }

        return {
          success: true,
          save_id: newSaveId,
          game_id: effectiveGameId,
        };
      }

      case 'list': {
        const res = await db.collection('saves')
          .where({ user_id, game_id: effectiveGameId })
          .orderBy('last_played', 'desc')
          .limit(SAVE_LIMIT_PER_USER)
          .get();

        // 格式化存档列表显示
        const saves = res.data.map(s => ({
          save_id: s.save_id,
          player_name: s.player_name,
          player_realm: s.player_realm,
          current_region: s.current_region,
          current_date: s.current_date,
          last_played: s.last_played,
          created_at: s.created_at,
        }));

        return { saves };
      }

      case 'delete': {
        if (!save_id) return { error: '缺少save_id' };

        // 验证所有权
        const saveRes = await db.collection('saves').where({ save_id, user_id }).limit(1).get();
        if (saveRes.data.length === 0) {
          return { error: '存档不存在或无权删除' };
        }

        const save = saveRes.data[0];

        // 删除云存储上的存档目录
        const saveDir = getSaveCloudPath(user_id, effectiveGameId, save_id, '').replace(/\/[^/]+\.md$/, '');
        await deleteCloudDirectory(saveDir);

        // 删除数据库记录
        await db.collection('saves').where({ save_id }).remove();
        await db.collection('conversations').where({ save_id }).remove();
        await db.collection('characters').where({ save_id }).remove();

        return { success: true };
      }

      case 'get': {
        if (!save_id) return { error: '缺少save_id' };

        const saveRes = await db.collection('saves').where({ save_id, user_id }).limit(1).get();
        if (saveRes.data.length === 0) {
          return { error: '存档不存在' };
        }

        const save = saveRes.data[0];

        // 读取核心状态文件
        const [player, state, world_state, summary, threads] = await Promise.all([
          readSaveFile(user_id, effectiveGameId, save_id, 'player'),
          readSaveFile(user_id, effectiveGameId, save_id, 'state'),
          readSaveFile(user_id, effectiveGameId, save_id, 'world_state'),
          readSaveFile(user_id, effectiveGameId, save_id, 'summary'),
          readSaveFile(user_id, effectiveGameId, save_id, 'threads'),
        ]);

        // 获取重要NPC列表
        const charsRes = await db.collection('characters')
          .where({ save_id, type: 'npc' })
          .get();

        return {
          save,
          files: { player, state, world_state, summary, threads },
          npcs: charsRes.data,
        };
      }

      case 'updateMeta': {
        // 更新存档元数据（last_played, current_npc, turn_counter等）
        if (!save_id) return { error: '缺少save_id' };

        const update = { updated_at: db.serverDate() };
        if (event.player_name) update.player_name = event.player_name;
        if (event.player_realm) update.player_realm = event.player_realm;
        if (event.current_region) update.current_region = event.current_region;
        if (event.current_npc !== undefined) update.current_npc = event.current_npc;
        if (event.current_date) update.current_date = event.current_date;
        if (event.turn_counter !== undefined) update.turn_counter = event.turn_counter;
        if (event.last_played) update.last_played = event.last_played;
        if (event.mode) update.mode = event.mode;

        await db.collection('saves').where({ save_id, user_id }).update({ data: update });
        return { success: true };
      }

      default:
        return { error: '未知操作: ' + action };
    }
  } catch (e) {
    console.error('manageSave error:', e);
    return { error: e.message || '操作失败' };
  }
};
