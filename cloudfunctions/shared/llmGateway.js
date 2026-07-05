const https = require('https');
const http = require('http');
const crypto = require('crypto');

// 简单内存缓存（热调用期间持久化）
const responseCache = new Map();
const CACHE_MAX = 100;
const CACHE_TTL = 10 * 60 * 1000; // 10分钟

function cacheKey(messages, model, params) {
  const hash = crypto.createHash('md5')
    .update(JSON.stringify({ messages, model, params }))
    .digest('hex');
  return hash;
}

/**
 * 调用 OpenAI 兼容 LLM API
 * @param {Object} opts
 * @param {string} opts.base_url - API base URL, e.g. https://api.xiaomimimo.com/v1
 * @param {string} opts.api_key - API Key
 * @param {string} opts.model - 模型ID
 * @param {Array} opts.messages - 消息列表 [{role, content}]
 * @param {Object} opts.params - {temperature, max_tokens, top_p, presence_penalty, frequency_penalty}
 * @param {boolean} opts.stream - 是否流式
 * @param {Object} opts.headers - 额外headers
 * @param {string} opts.endpoint_type - 'chat' (default) | 'models'
 * @returns {Promise<{stream?: ReadableStream, text?: string, cached: boolean}>}
 */
async function callLLM(opts) {
  const {
    base_url = 'https://api.xiaomimimo.com/v1',
    api_key,
    model = 'mimo-v2.5-pro',
    messages = [],
    params = {},
    stream = false,
    headers = {},
    endpoint_type = 'chat',
  } = opts;

  // 非流式请求检查缓存
  if (!stream && endpoint_type === 'chat') {
    const key = cacheKey(messages, model, params);
    const cached = responseCache.get(key);
    if (cached && Date.now() - cached.ts < CACHE_TTL) {
      return { text: cached.text, cached: true };
    }
  }

  const url = new URL(base_url);
  let endpoint;
  let body;
  let method = 'POST';

  if (endpoint_type === 'models') {
    endpoint = '/models';
    body = null;
    method = 'GET';
  } else {
    endpoint = '/chat/completions';
    body = JSON.stringify({
      model,
      messages,
      temperature: params.temperature ?? 0.8,
      max_tokens: params.max_tokens ?? 2048,
      top_p: params.top_p ?? 1,
      presence_penalty: params.presence_penalty ?? 0,
      frequency_penalty: params.frequency_penalty ?? 0,
      stream: !!stream,
    });
  }

  const reqHeaders = {
    'Authorization': `Bearer ${api_key}`,
    ...headers,
  };
  if (body) {
    reqHeaders['Content-Type'] = 'application/json';
    reqHeaders['Content-Length'] = Buffer.byteLength(body);
  }

  const options = {
    hostname: url.hostname,
    port: url.port || (url.protocol === 'https:' ? 443 : 80),
    path: url.pathname.replace(/\/$/, '') + endpoint,
    method,
    headers: reqHeaders,
    timeout: 60000,
  };

  return new Promise((resolve, reject) => {
    const proto = url.protocol === 'https:' ? https : http;
    const req = proto.request(options, (res) => {
      // 处理错误状态码
      if (res.statusCode >= 400) {
        let errData = '';
        res.on('data', chunk => errData += chunk);
        res.on('end', () => {
          reject(new Error(`LLM API Error ${res.statusCode}: ${errData.slice(0, 500)}`));
        });
        return;
      }

      if (stream) {
        resolve({ stream: res, cached: false });
      } else {
        let data = '';
        res.on('data', chunk => data += chunk);
        res.on('end', () => {
          try {
            const parsed = JSON.parse(data);
            if (endpoint_type === 'models') {
              resolve({ data: parsed.data || [], cached: false });
            } else {
              const text = parsed.choices?.[0]?.message?.content || '';
              // 缓存非流式结果
              if (endpoint_type === 'chat') {
                if (responseCache.size > CACHE_MAX) {
                  // 清空最早的一半
                  const keys = Array.from(responseCache.keys());
                  keys.slice(0, Math.floor(CACHE_MAX / 2)).forEach(k => responseCache.delete(k));
                }
                responseCache.set(cacheKey(messages, model, params), { text, ts: Date.now() });
              }
              resolve({ text, cached: false });
            }
          } catch (e) {
            reject(new Error(`Parse response failed: ${e.message}, raw: ${data.slice(0, 200)}`));
          }
        });
      }
    });

    req.on('error', reject);
    req.on('timeout', () => {
      req.destroy();
      reject(new Error('LLM request timeout (60s)'));
    });

    if (body) {
      req.write(body);
    }
    req.end();
  });
}

/**
 * 从流式响应中收集完整文本
 * @param {ReadableStream} stream - SSE流
 * @returns {Promise<string>} 完整文本
 */
async function collectStream(stream) {
  return new Promise((resolve, reject) => {
    let fullText = '';
    stream.on('data', chunk => {
      const lines = chunk.toString().split('\n');
      for (const line of lines) {
        const trimmed = line.trim();
        if (trimmed.startsWith('data: ')) {
          const data = trimmed.slice(6);
          if (data === '[DONE]') continue;
          try {
            const parsed = JSON.parse(data);
            const delta = parsed.choices?.[0]?.delta?.content || '';
            fullText += delta;
          } catch {
            // 忽略解析失败的chunk
          }
        }
      }
    });
    stream.on('end', () => resolve(fullText));
    stream.on('error', reject);
  });
}

/**
 * 转发SSE流到前端（云函数中使用）
 * @param {ReadableStream} stream - LLM返回的流
 * @param {Object} cloud - 微信云函数SDK
 * @returns {Promise<string>} 完整文本
 */
async function forwardSSE(stream, cloud) {
  return new Promise((resolve, reject) => {
    let fullText = '';

    // 使用微信云函数的SSE返回方式
    // 注意：微信云函数流式返回需要用 cloud.getSSEContext 或返回可读流
    // 这里返回完整文本，实际SSE转发在chat/index.js中处理

    stream.on('data', chunk => {
      const lines = chunk.toString().split('\n');
      for (const line of lines) {
        const trimmed = line.trim();
        if (trimmed.startsWith('data: ')) {
          const data = trimmed.slice(6);
          if (data === '[DONE]') continue;
          try {
            const parsed = JSON.parse(data);
            const delta = parsed.choices?.[0]?.delta?.content || '';
            fullText += delta;
          } catch {}
        }
      }
    });
    stream.on('end', () => resolve(fullText));
    stream.on('error', reject);
  });
}

module.exports = { callLLM, collectStream, forwardSSE };
