// H5 version - settings.js
(function(){
  const data = { strictMode: false, threadMode: true };

  function $(s) { return document.querySelector(s); }
  function setData(o) { Object.assign(data, o); render(); }

  function render() {
    const s = $('#strict-mode');
    if (s) s.checked = data.strictMode;
    const t = $('#thread-mode');
    if (t) t.checked = data.threadMode;
  }

  function save() {
    try {
      localStorage.setItem('strictMode', JSON.stringify(data.strictMode));
      localStorage.setItem('threadMode', JSON.stringify(data.threadMode));
      alert('已保存');
    } catch(e) { alert('保存失败：' + e.message); }
  }

  function load() {
    try {
      const s = JSON.parse(localStorage.getItem('strictMode') || 'false');
      const t = JSON.parse(localStorage.getItem('threadMode') !== null ? localStorage.getItem('threadMode') : 'true');
      setData({ strictMode: s, threadMode: t });
    } catch(e) {}
  }

  function clearCache() {
    if (!confirm('清空本地缓存？存档数据不受影响。')) return;
    try { localStorage.clear(); alert('已清空'); }
    catch(e) { alert('失败：' + e.message); }
  }

  document.addEventListener('DOMContentLoaded', () => {
    load();
    $('#strict-mode').onchange = e => { setData({ strictMode: e.target.checked }); save(); };
    $('#thread-mode').onchange = e => { setData({ threadMode: e.target.checked }); save(); };
    $('#btn-clear').onclick = clearCache;
  });
})();
