// H5 version - replaces wx.cloud.callFunction with API.*
(function(){
  const params = new URLSearchParams(location.search);
  const game_id = params.get('game_id') || 'frxz';
  const save_id = params.get('save_id');

  if (!save_id) {
    alert('参数错误：缺少 save_id');
    location.href = '/';
    return;
  }

  const data = {
    game_id: game_id,
    save_id: save_id,
    saveInfo: {},
    currentNpcId: null,
    messages: [],
    inputText: '',
    sending: false,
    rerolling: false,
    currentTurnId: null,
    showState: false,
    showNPCList: false,
    npcList: [],
    stateText: '',
    showCompressionHint: false,
  };

  function $(sel) { return document.querySelector(sel); }
  function $all(sel) { return Array.from(document.querySelectorAll(sel)); }

  function setData(obj) {
    Object.assign(data, obj);
    render();
  }

  function render() {
    if (data.saving === false) {/*noop*/}

    const msgsEl = $('#messages');
    if (msgsEl) {
      msgsEl.innerHTML = data.messages.map((m, i) => {
        const who = m.role === 'user' ? 'msg-user' : 'msg-ai';
        return `<div class="msg ${who}" id="msg-${i}">${escapeHtml(m.content)}</div>`;
      }).join('');
      msgsEl.scrollTop = msgsEl.scrollHeight;
    }

    const input = $('#input');
    if (input) input.value = data.inputText;

    const sendBtn = $('#btn-send');
    if (sendBtn) {
      sendBtn.disabled = data.sending;
      sendBtn.textContent = data.sending ? '...发送中' : '发送';
    }

    const title = $('#save-title');
    if (title && data.saveInfo.player_name) {
      title.textContent = data.saveInfo.player_name + (data.saveInfo.player_realm ? ' · ' + data.saveInfo.player_realm : '');
    }

    const statePanel = $('#state-panel');
    if (statePanel) statePanel.style.display = data.showState ? 'block' : 'none';

    const npcPanel = $('#npc-panel');
    if (npcPanel) npcPanel.style.display = data.showNPCList ? 'block' : 'none';

    const npcList = $('#npc-list');
    if (npcList) {
      npcList.innerHTML = '<div class="npc-item" data-id="">自由探索</div>' +
        data.npcList.map(n => `<div class="npc-item" data-id="${n.npc_id}">${escapeHtml(n.name)}</div>`).join('');
      $all('.npc-item').forEach(el => {
        el.onclick = () => selectNPC(el.dataset.id || null);
      });
    }

    if (data.stateText) {
      const t = $('#state-text');
      if (t) t.textContent = data.stateText.substring(0, 500);
    }

    const compHint = $('#compression-hint');
    if (compHint) compHint.style.display = data.showCompressionHint ? 'block' : 'none';
  }

  function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, c => ({
      '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'
    }[c]));
  }

  // ===== Loaders =====
  async function loadSaveInfo() {
    const res = await API.saveGet(data.save_id, data.game_id);
    if (res.save) {
      setData({ saveInfo: res.save });
      if (res.files && res.files.state) setData({ stateText: res.files.state });
    }
  }

  async function loadNPCList() {
    const res = await API.charList(data.save_id, 'npc');
    setData({ npcList: res.data || [] });
  }

  async function loadHistory() {
    const res = await API.history(data.save_id);
    const messages = (res.data || []).map(m => ({
      role: m.role,
      content: m.content,
      turn_id: m.turn_id,
      rerollable: false,
    }));
    if (messages.length && messages[messages.length - 1].role === 'assistant') {
      messages[messages.length - 1].rerollable = true;
      setData({ currentTurnId: messages[messages.length - 1].turn_id });
    }
    setData({ messages });
  }

  // ===== UI actions =====
  function toggleState() { setData({ showState: !data.showState, showNPCList: false }); }
  function toggleNPCList() { setData({ showNPCList: !data.showNPCList, showState: false }); }

  function selectNPC(npcId) {
    setData({ currentNpcId: npcId, showNPCList: false });
    alert(npcId ? '已切换对话对象：' + npcId : '进入自由探索模式');
  }

  function goCreateNPC() {
    location.href = `/pages/charCreation/charCreation?game_id=${data.game_id}&save_id=${data.save_id}&mode=newNPC`;
  }

  function goToModel() {
    location.href = '/pages/modelManage/modelManage';
  }

  function onInput(e) { setData({ inputText: e.target.value }); }

  // ===== Send =====
  async function send() {
    const text = data.inputText.trim();
    if (!text || data.sending) return;

    if (text.startsWith('创建角色')) {
      const desc = text.replace(/^创建角色[:：]?\s*/, '');
      location.href = `/pages/charCreation/charCreation?game_id=${data.game_id}&save_id=${data.save_id}&mode=newNPC&description=${encodeURIComponent(desc)}`;
      return;
    }

    setData({ sending: true, inputText: '' });
    const userMsg = { role: 'user', content: text };
    setData({ messages: [...data.messages, userMsg] });

    try {
      const res = await API.chat({
        game_id: data.game_id,
        save_id: data.save_id,
        npc_id: data.currentNpcId,
        user_input: text,
        reroll: false,
      });

      setData({ sending: false });

      if (res.error) {
        alert(res.error);
        setData({ messages: data.messages.slice(0, -1) });
        return;
      }

      if (res.success) {
        const aiMsg = {
          role: 'assistant',
          content: res.reply,
          turn_id: res.turn_id,
          rerollable: true,
        };
        const newMessages = [...data.messages, aiMsg];
        if (newMessages.length > 2) newMessages[newMessages.length - 2].rerollable = false;
        setData({
          messages: newMessages,
          currentTurnId: res.turn_id,
          showCompressionHint: !!res.shouldSuggestCompression,
        });
        loadSaveInfo();
      }
    } catch (e) {
      setData({ sending: false });
      alert('发送失败：' + e.message);
      setData({ messages: data.messages.slice(0, -1) });
    }
  }

  async function reroll() {
    if (data.rerolling || !data.currentTurnId) return;
    const idx = data.messages.map(m => m.role).lastIndexOf('user');
    if (idx === -1) return;
    const userInput = data.messages[idx].content;
    setData({ rerolling: true });

    try {
      const res = await API.chat({
        game_id: data.game_id,
        save_id: data.save_id,
        npc_id: data.currentNpcId,
        user_input: userInput,
        reroll: true,
        turn_id: data.currentTurnId,
      });

      setData({ rerolling: false });
      if (res.success) {
        const m = [...data.messages];
        m[m.length - 1] = { role: 'assistant', content: res.reply, turn_id: res.turn_id, rerollable: true };
        setData({ messages: m, currentTurnId: res.turn_id });
      } else {
        alert('重摇失败');
      }
    } catch (e) {
      setData({ rerolling: false });
      alert('重摇失败');
    }
  }

  async function compress() {
    alert('压缩功能开发中');
    setData({ showCompressionHint: false });
  }

  // ===== Init =====
  document.addEventListener('DOMContentLoaded', () => {
    // 绑定事件
    const bState = $('#btn-state');
    if (bState) bState.onclick = toggleState;
    const bNpc = $('#btn-npc');
    if (bNpc) bNpc.onclick = toggleNPCList;
    const bModel = $('#btn-model');
    if (bModel) bModel.onclick = goToModel;
    const bSend = $('#btn-send');
    if (bSend) bSend.onclick = send;
    const bReroll = $('#btn-reroll');
    if (bReroll) bReroll.onclick = reroll;
    const bComp = $('#btn-compress');
    if (bComp) bComp.onclick = compress;
    const bNewNpc = $('#btn-new-npc');
    if (bNewNpc) bNewNpc.onclick = goCreateNPC;

    const input = $('#input');
    if (input) input.oninput = onInput;

    // 启动
    loadSaveInfo();
    loadNPCList();
    loadHistory();
  });

  // 暴露给测试
  window.__dialogApp = { data, setData };
})();
