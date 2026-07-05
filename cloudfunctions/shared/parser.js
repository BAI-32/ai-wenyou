/**
 * 四段解析器：解析LLM返回的REPLY/MEMORY/STATE/DIRECTOR格式
 * @param {string} text - LLM返回的完整文本
 * @returns {Object} {reply: string, memory: string[], state: string[], director: string}
 */
function parseSegments(text) {
  const result = {
    reply: '',
    memory: [],
    state: [],
    director: '',
    raw: text,
  };

  if (!text || typeof text !== 'string') {
    return result;
  }

  // 使用正则匹配各段，支持大小写和各种空白
  const segmentRegex = /^(REPLY|MEMORY|STATE|DIRECTOR)\s*:\s*([\s\S]*?)(?=^(?:REPLY|MEMORY|STATE|DIRECTOR)\s*:|$)/gim;

  let match;
  const segments = {};
  while ((match = segmentRegex.exec(text)) !== null) {
    const segName = match[1].toUpperCase();
    const segContent = match[2].trim();
    segments[segName] = segContent;
  }

  // 如果没有匹配到任何标记，将整个文本作为reply
  if (Object.keys(segments).length === 0) {
    result.reply = text.trim();
    return result;
  }

  // 解析REPLY
  result.reply = segments.REPLY || '';

  // 解析MEMORY（列表项）
  if (segments.MEMORY) {
    result.memory = parseListItems(segments.MEMORY);
  }

  // 解析STATE（列表项）
  if (segments.STATE) {
    result.state = parseListItems(segments.STATE);
  }

  // 解析DIRECTOR
  result.director = segments.DIRECTOR || '';

  return result;
}

/**
 * 解析列表项，支持-、*、数字开头的列表
 * @param {string} text
 * @returns {string[]}
 */
function parseListItems(text) {
  if (!text) return [];
  return text
    .split('\n')
    .map(line => line.trim())
    .map(line => line.replace(/^[-*•·]\s*/, '')) // 移除- * • ·开头
    .map(line => line.replace(/^\d+[.)、]\s*/, '')) // 移除数字列表开头
    .filter(line => line.length > 0);
}

/**
 * 简单的角色卡JSON解析，处理LLM返回中可能的多余文本
 * @param {string} text
 * @returns {Object|null}
 */
function parseCharacterCard(text) {
  if (!text) return null;

  // 尝试直接解析
  try {
    return JSON.parse(text);
  } catch {}

  // 尝试提取第一个JSON对象
  const jsonMatch = text.match(/\{[\s\S]*\}/);
  if (jsonMatch) {
    try {
      return JSON.parse(jsonMatch[0]);
    } catch {}
  }

  return null;
}

module.exports = {
  parseSegments,
  parseListItems,
  parseCharacterCard,
};
