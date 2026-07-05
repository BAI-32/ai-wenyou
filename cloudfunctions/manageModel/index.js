const cloud = require('wx-server-sdk');
const { encrypt, decrypt } = require('../shared/encryption');
const { callLLM } = require('../shared/llmGateway');

cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });
const db = cloud.database();

exports.main = async (event) => {
  const wxContext = cloud.getWXContext();
  const user_id = wxContext.OPENID;
  const { action, config } = event;

  try {
    switch (action) {
      case 'create': {
        if (!config.name || !config.api_key) {
          return { error: '名称和API Key不能为空' };
        }

        // 如果设为默认，先把其他都设为非默认
        if (config.is_default !== false) {
          await db.collection('model_configs').where({ user_id }).update({
            data: { is_default: false }
          });
        }

        const encrypted = encrypt(config.api_key);
        const result = await db.collection('model_configs').add({
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
        return { success: true, _id: result._id };
      }

      case 'list': {
        const res = await db.collection('model_configs')
          .where({ user_id })
          .orderBy('is_default', 'desc')
          .orderBy('created_at', 'desc')
          .get();

        // 不返回加密的key，只返回是否有key
        const configs = res.data.map(c => ({
          ...c,
          api_key_enc: undefined,
          has_key: !!c.api_key_enc,
        }));

        // 如果没有配置，返回默认mimo配置提示
        if (configs.length === 0) {
          return {
            configs: [],
            default_config: null,
            hint: '请先添加模型配置，默认推荐mimo中转站'
          };
        }

        const defaultConfig = configs.find(c => c.is_default) || configs[0];
        return { configs, default_config: defaultConfig };
      }

      case 'update': {
        if (!config._id) return { error: '缺少配置ID' };

        const update = {
          name: config.name,
          base_url: config.base_url,
          model: config.model,
          params: config.params,
          headers: config.headers,
          updated_at: db.serverDate(),
        };

        // 如果更新了key
        if (config.api_key) {
          update.api_key_enc = encrypt(config.api_key);
        }

        // 如果设为默认，先取消其他默认
        if (config.is_default) {
          await db.collection('model_configs').where({ user_id }).update({
            data: { is_default: false }
          });
          update.is_default = true;
        }

        // 移除undefined字段
        Object.keys(update).forEach(k => update[k] === undefined && delete update[k]);

        await db.collection('model_configs').doc(config._id).update({ data: update });
        return { success: true };
      }

      case 'delete': {
        if (!config._id) return { error: '缺少配置ID' };

        const doc = await db.collection('model_configs').doc(config._id).get();
        if (!doc.data || doc.data.user_id !== user_id) {
          return { error: '无权删除此配置' };
        }

        await db.collection('model_configs').doc(config._id).remove();

        // 如果删除的是默认配置，把最新的设为默认
        if (doc.data.is_default) {
          const remaining = await db.collection('model_configs')
            .where({ user_id }).orderBy('created_at', 'desc').limit(1).get();
          if (remaining.data.length > 0) {
            await db.collection('model_configs').doc(remaining.data[0]._id).update({
              data: { is_default: true }
            });
          }
        }

        return { success: true };
      }

      case 'setDefault': {
        if (!config._id) return { error: '缺少配置ID' };

        await db.collection('model_configs').where({ user_id }).update({
          data: { is_default: false }
        });
        await db.collection('model_configs').doc(config._id).update({
          data: { is_default: true, updated_at: db.serverDate() }
        });
        return { success: true };
      }

      case 'get': {
        // 获取单个配置（带解密的key，用于云函数内部调用LLM）
        let modelConfig;
        if (config && config._id) {
          const res = await db.collection('model_configs').doc(config._id).get();
          modelConfig = res.data;
        } else {
          const res = await db.collection('model_configs')
            .where({ user_id, is_default: true }).limit(1).get();
          modelConfig = res.data[0];
        }

        if (!modelConfig) {
          return { error: '未找到模型配置，请先添加配置' };
        }

        // 返回解密后的配置供内部使用
        return {
          config: {
            _id: modelConfig._id,
            name: modelConfig.name,
            base_url: modelConfig.base_url,
            api_key: decrypt(modelConfig.api_key_enc),
            model: modelConfig.model,
            params: modelConfig.params,
            headers: modelConfig.headers,
          }
        };
      }

      case 'listModels': {
        // 从给定的base_url拉取模型列表
        const { base_url, api_key_enc } = config || {};
        if (!base_url) return { models: [], error: '缺少Base URL' };

        const api_key = api_key_enc ? decrypt(api_key_enc) : '';

        try {
          const result = await callLLM({
            base_url,
            api_key,
            model: '',
            messages: [],
            stream: false,
            endpoint_type: 'models',
          });
          const models = (result.data || []).map(m => m.id || m).filter(Boolean);
          return { models };
        } catch (e) {
          return { models: [], error: '无法获取模型列表，请手动输入模型ID：' + e.message };
        }
      }

      case 'test': {
        // 测试配置是否可用
        const { base_url, api_key, model } = config || {};
        if (!base_url || !api_key || !model) {
          return { success: false, error: '缺少必要参数' };
        }

        try {
          const { text, cached } = await callLLM({
            base_url,
            api_key,
            model,
            messages: [{ role: 'user', content: '回复"OK"两个字即可' }],
            params: { temperature: 0.1, max_tokens: 10 },
            stream: false,
          });
          return { success: true, response: text.slice(0, 50), cached };
        } catch (e) {
          return { success: false, error: e.message };
        }
      }

      default:
        return { error: '未知操作: ' + action };
    }
  } catch (e) {
    console.error('manageModel error:', e);
    return { error: e.message || '操作失败' };
  }
};
