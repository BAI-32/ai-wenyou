// H5 version - worldSelect.js
(function(){
  document.addEventListener('DOContentLoaded', () => {
    document.querySelectorAll('[data-world]').forEach(el => {
      el.onclick = () => location.href = `/pages/saveList/saveList?game_id=${el.dataset.world}`;
    });
    const m = $('#btn-model-manage');
    if (m) m.onclick = () => location.href = '/pages/modelManage/modelManage';
    const s = $('#btn-settings');
    if (s) s.onclick = () => location.href = '/pages/settings/settings';
  });
})();
