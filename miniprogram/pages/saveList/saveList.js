// H5 version - saveList.js
(function(){
  const params = new URLSearchParams(location.search);
  const game_id = params.get('game_id') || 'frxz';

  const data = { game_id, saves: [] };

  function $(sel) { return document.querySelector(sel); }
  function setData(obj) { Object.assign(data, obj); render(); }

  function render() {
    const list = $('#save-list');
    if (!list) return;
    if (!data.saves.length) {
      list.innerHTML = '<p class="empty">还没有存档，点下方创建</p>';
    } else {
      list.innerHTML = data.saves.map(s => `
        <div class="save-card" data-id="${s.save_id}">
          <div class="save-name">${escapeHtml(s.player_name)}</div>
          <div class="save-info">${escapeHtml(s.player_realm)} · ${escapeHtml(s.current_region)}</div>
          <div class="save-time">最后游玩：${s.last_played_str || '刚刚'}</div>
          <button class="btn-danger btn-delete" data-id="${s.save_id}">删除</button>
        </div>
      `).join('');
      list.querySelectorAll('.save-card').forEach(el => {
        el.onclick = (e) => {
          if (e.target.classList.contains('btn-delete')) return;
          location.href = `/pages/dialog/dialog?save_id=${el.dataset.id}&game_id=${data.game_id}`;
        };
      });
      list.querySelectorAll('.btn-delete').forEach(el => {
        el.onclick = (e) => { e.stopPropagation(); confirmDelete(el.dataset.id); };
      });
    }
  }

  function escapeHtml(s) { return String(s).replace(/[&<>"']/c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c])); }

  async function loadSaves() {
    try {
      const res = await API.saveList(data.game_id);
      const saves = (res.saves || []).map(s => ({
        ...s,
        last_played_str: s.last_played ? new Date(s.last_played).toLocaleString('zh-CN') : '刚刚',
      }));
      setData({ saves });
    } catch (e) { alert('加载失败：' + e.message); }
  }

  function newGame() {
    location.href = `/pages/charCreation/charCreation?game_id=${data.game_id}&mode=newPlayer`;
  }

  function confirmDelete(saveId) {
    if (!confirm('确定删除？此操作不可恢复。')) return;
    deleteSave(saveId);
  }

  async function deleteSave(saveId) {
    try {
      const res = await API.saveDelete(saveId, data.game_id);
      if (res.success) {
        alert('删除成功');
        loadSaves();
      } else {
        alert(res.error || '删除失败');
      }
    } catch(e) { alert('删除失败：' + e.message); }
  }

  document.addEventListener('DOMContentLoaded', () => {
    const newBtn = $('#btn-new');
    if (newBtn) newBtn.onclick = newGame;
    loadSaves();
  });
})();
