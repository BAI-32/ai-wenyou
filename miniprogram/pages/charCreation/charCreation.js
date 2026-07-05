// H5 version - charCreation.js
(function(){
  const params = new URLSearchParams(location.search);
  const game_id = params.get('game_id') || 'frxz';
  const mode = params.get('mode') || 'newPlayer';
  const initialSaveId = params.get('save_id') || null;
  const initialDesc = params.get('description') || '';

  const data = {
    game_id, mode,
    save_id: initialSaveId,
    description: decodeURIComponent(initialDesc),
    generating: false,
    card: null,
    cardJson: '',
    editing: false,
  };

  function $(sel) { return document.querySelector(sel); }
  function setData(obj) { Object.assign(data, obj); render(); }

  function render() {
    const genBtn = $('#btn-generate');
    if (genBtn) {
      genBtn.disabled = data.generating;
      genBtn.textContent = data.generating ? '...生成中' : '生成角色';
    }

    const descInput = $('#description');
    if (descInput && document.activeElement !== descInput) descInput.value = data.description;

    const cardEl = $('#card-display');
    if (cardEl) {
      if (data.card) {
        cardEl.innerHTML = '<pre>' + escapeHtml(JSON.stringify(data.card, null, 2)) + '</pre>';
      } else {
        cardEl.innerHTML = '<p class="hint">还没有角色卡，填入描述后点生成</p>';
      }
    }

    const cardJsonEl = $('#card-json');
    if (cardJsonEl && data.editing) cardJsonEl.value = data.cardJson;

    const editBtn = $('#btn-edit');
    if (editBtn) editBtn.textContent = data.editing ? '取消编辑' : '编辑 JSON';

    const editArea = $('#edit-area');
    if (editArea) editArea.style.display = data.editing ? 'block' : 'none';

    const confirmBtn = $('#btn-confirm');
    if (confirmBtn && data.card) confirmBtn.style.display = 'inline-block';
  }

  function escapeHtml(s) { return String(s).replace(/[&<>"']/c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c])); }

  // 新玩家模式：先创建存档
  async function ensureSave() {
    if (data.save_id) return true;
    const res = await API.saveCreate(data.game_id);
    if (res.save_id) { setData({ save_id: res.save_id }); return true; }
    alert('创建存档失败：' + (res.error || '未知'));
    return false;
  }

  async function generate() {
    if (data.mode === 'newPlayer') {
      const ok = await ensureSave();
      if (!ok) return;
    }
    if (data.mode === 'newNPC' && !data.save_id) {
      alert('参数错误：缺少 save_id');
      return;
    }

    setData({ generating: true });
    try {
      const action = data.mode === 'newPlayer' ? 'createPlayer' : 'createNPC';
      const res = await API.createCharacter({
        action, save_id: data.save_id, game_id: data.game_id, description: data.description
      });
      setData({ generating: false });

      if (res.success) {
        setData({ card: res.card, cardJson: JSON.stringify(res.card, null, 2) });
      } else {
        alert(res.error || '生成失败');
      }
    } catch (e) {
      setData({ generating: false });
      alert('生成失败：' + e.message);
    }
  }

  function regenerate() { generate(); }
  function toggleEdit() { setData({ editing: !data.editing }); }

  function onEditCard(e) { setData({ cardJson: e.target.value }); }

  async function confirmCard() {
    let card = data.card;
    if (data.editing) {
      try { card = JSON.parse(data.cardJson); }
      catch (e) { alert('JSON 格式错误'); return; }
    }

    if (data.mode === 'newPlayer') {
      alert('主角创建成功！进入对话...');
      location.href = `/pages/dialog/dialog?save_id=${data.save_id}&game_id=${data.game_id}`;
    } else {
      alert('NPC 创建成功！');
      history.back();
    }
  }

  document.addEventListener('DOMContentLoaded', () => {
    const genBtn = $('#btn-generate');
    if (genBtn) genBtn.onclick = generate;
    const regenBtn = $('#btn-regenerate');
    if (regenBtn) regenBtn.onclick = regenerate;
    const editBtn = $('#btn-edit');
    if (editBtn) editBtn.onclick = toggleEdit;
    const confirmBtn = $('#btn-confirm');
    if (confirmBtn) confirmBtn.onclick = confirmCard;
    const descEl = $('#description');
    if (descEl) descEl.oninput = e => setData({ description: e.target.value });
    const cardJsonEl = $('#card-json');
    if (cardJsonEl) cardJsonEl.oninput = onEditCard;
    render();
  });
})();
