/**
 * API Adapters - Replace wx.cloud with fetch for H5 deployment.
 * On WeChat: WX mini-program SDK covers these.
 * On H5/Cloudflare: calls Node backend.
 */
(function (global) {
  const API_BASE = global.API_BASE || '';

  function post(path, data) {
    return fetch(API_BASE + path, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(data || {}),
    }).then(function (r) {
      if (!r.ok) throw new Error('API ' + path + ' failed: ' + r.status);
      return r.json();
    });
  }

  function get(path) {
    return fetch(API_BASE + path).then(function (r) {
      if (!r.ok) throw new Error('API ' + path + ' failed: ' + r.status);
      return r.json();
    });
  }

  global.API = {
    // Chat
    chat: function (data) { return post('/api/chat', data); },

    // createCharacter
    createCharacter: function (data) { return post('/api/createCharacter', data); },

    // manageModel
    modelList: function () { return post('/api/manageModel', { action: 'list' }); },
    modelCreate: function (config) { return post('/api/manageModel', { action: 'create', config: config }); },
    modelUpdate: function (config) { return post('/api/manageModel', { action: 'update', config: config }); },
    modelDelete: function (id) { return post('/api/manageModel', { action: 'delete', config: { _id: id } }); },
    modelSetDefault: function (id) { return post('/api/manageModel', { action: 'setDefault', config: { _id: id } }); },
    modelGet: function (id) { return post('/api/manageModel', { action: 'get', config: { _id: id || null } }); },
    modelTest: function (config) { return post('/api/manageModel', { action: 'test', config: config }); },
    modelListModels: function (config) { return post('/api/manageModel', { action: 'listModels', config: config }); },

    // manageSave
    saveList: function (game_id) { return post('/api/manageSave', { action: 'list', game_id: game_id }); },
    saveGet: function (save_id, game_id) { return post('/api/manageSave', { action: 'get', save_id: save_id, game_id: game_id }); },
    saveCreate: function (game_id, player_name) { return post('/api/manageSave', { action: 'create', game_id: game_id, player_name: player_name }); },
    saveDelete: function (save_id, game_id) { return post('/api/manageSave', { action: 'delete', save_id: save_id, game_id: game_id }); },
    saveUpdateMeta: function (data) { return post('/api/manageSave', { action: 'updateMeta', ...data }); },

    // characters
    charList: function (save_id, type) { return post('/api/characters', { action: 'list', save_id: save_id, type: type }); },

    // conversation history
    history: function (save_id) { return post('/api/history', { save_id: save_id }); },

    // knowledge files
    readFile: function (game_id, filename) { return post('/api/file', { game_id: game_id, filename: filename }); },
  };
})(typeof window !== 'undefined' ? window : globalThis);
