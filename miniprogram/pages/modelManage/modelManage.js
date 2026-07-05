// H5 version - modelManage.js
(function(){
  const FORMS = {
    name: '', base_url: 'https://api.xiaomimimo.com/v1',
    api_key: '', model: 'mimo-v2.5-pro',
    temperature: 0.8, max_tokens: 2048, is_default: true,
  };

  const data = {
    configs: [], showForm: false, editingId: null,
    saving: false, testingId: null,
    form: { ...FORMS },
  };

  function $(sel) { return document.querySelector(sel); }
  function setData(obj) { Object.assign(data, obj); render(); }

  function render() {
    const list = $('#config-list');
    if (list) {
      list.innerHTML = data.configs.length ? data.configs.map(c => `
        <div class="config-card" data-id="${c._id}">
          <div class="row"><b>${escapeHtml(c.name || '(未命名)')}</b>
            ${c.is_default ? '<span class="badge">默认</span>' : ''}
            <span class="badge">${escapeHtml(c.model)}</span>
          </div>
          <div class="row muted">${escapeHtml(c.base_url)}</div>
          <div class="row">${c.has_key ? '✓ 已配置 Key' : '✗ 未配置'}</div>
          <div class="actions">
            <button class="btn-test" data-id="${c._id}">测试</button>
            <button class="btn-set-default" data-id="${c._id}">设默认</button>
            <button class="btn-edit" data-id="${c._id}">编辑</button>
            <button class="btn-danger btn-delete" data-id="${c._id}">删除</button>
          </div>
        </div>
      `).join('') : '<p class="empty">还没有模型配置，请添加（推荐 mimo 中转站）</p>';

      list.querySelectorAll('.btn-test').forEach(b => b.onclick = e => testConfig(e.target.dataset.id));
      list.querySelectorAll('.btn-set-default').forEach(b => b.onclick = e => setDefault(e.target.dataset.id));
      list.querySelectorAll('.btn-edit').forEach(b => b.onclick = e => showEditForm(e.target.dataset.id));
      list.querySelectorAll('.btn-delete').forEach(b => b.onclick = e => deleteConfig(e.target.dataset.id));
    }

    const formEl = $('#config-form');
    if (formEl) formEl.style.display = data.showForm ? 'block' : 'none';

    const formTitle = $('#form-title');
    if (formTitle) formTitle.textContent = data.editingId ? '编辑配置' : '添加配置';

    if (data.showForm) {
      $('[name=name]').value = data.form.name;
      $('[name=base_url]').value = data.form.base_url;
      $('[name=api_key]').value = data.form.api_key;
      $('[name=model]').value = data.form.model;
      $('[name=temperature]').value = data.form.temperature;
      $('[name=max_tokens]').value = data.form.max_tokens;
    }

    const saveBtn = $('#btn-save');
    if (saveBtn) { saveBtn.disabled = data.saving; saveBtn.textContent = data.saving ? '...保存中' : '保存'; }

    const testBtn = $('#btn-test-inline');
    if (testBtn) testBtn.disabled = data.saving;
  }

  function escapeHtml(s) { return String(s).replace(/[&<>"']/c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c])); }

  async function load() {
    try {
      const res = await API.modelList();
      setData({ configs: res.configs || [] });
    } catch (e) { alert('加载失败：' + e.message); }
  }

  function showAddForm() {
    setData({
      showForm: true, editingId: null,
      form: { ...FORMS, is_default: data.configs.length === 0 },
    });
  }

  async function showEditForm(id) {
    const cfg = data.configs.find(c => c._id === id);
    if (!cfg) return;
    setData({
      showForm: true, editingId: id,
      form: {
        name: cfg.name, base_url: cfg.base_url, api_key: '',
        model: cfg.model, temperature: cfg.params?.temperature ?? 0.8,
        max_tokens: cfg.params?.max_tokens ?? 2048, is_default: cfg.is_default,
      },
    });
  }

  function hideForm() { setData({ showForm: false, editingId: null }); }

  function onFormInput(e) {
    const f = e.target.dataset.field;
    if (f) setData({ form: { ...data.form, [f]: e.target.value } });
  }

  async function saveConfig() {
    if (!data.form.name || !data.form.base_url || !data.form.model) {
      alert('名称、Base URL、模型必填'); return;
    }
    if (!data.editingId && !data.form.api_key) { alert('请输入 API Key'); return; }

    setData({ saving: true });
    try {
      const payload = { ...data.form, _id: data.editingId };
      const res = data.editingId
        ? await API.modelUpdate(payload)
        : await API.modelCreate(payload);
      setData({ saving: false });
      if (res.success) {
        hideForm();
        load();
      } else {
        alert(res.error || '保存失败');
      }
    } catch (e) {
      setData({ saving: false });
      alert('保存失败：' + e.message);
    }
  }

  async function setDefault(id) {
    try {
      const res = await API.modelSetDefault(id);
      if (res.success) { alert('已设为默认'); load(); }
      else alert(res.error || '操作失败');
    } catch (e) { alert(e.message); }
  }

  async function deleteConfig(id) {
    if (!confirm('确定删除？此操作不可恢复。')) return;
    try {
      const res = await API.modelDelete(id);
      if (res.success) { alert('删除成功'); load(); }
      else alert(res.error || '删除失败');
    } catch (e) { alert(e.message); }
  }

  async function testConfig(id) {
    try {
      const cfgRes = await API.modelGet(id);
      if (!cfgRes.config) { alert('获取配置失败'); return; }
      const testRes = await API.modelTest(cfgRes.config);
      if (testRes.success) {
        alert('测试成功！响应：' + (testRes.response || '(空)'));
      } else {
        alert('测试失败：' + (testRes.error || '未知错误'));
      }
    } catch (e) { alert('测试失败：' + e.message); }
  }

  async function testInline() {
    if (!data.form.base_url || !data.form.api_key || !data.form.model) {
      alert('先填 base_url / api_key / model'); return;
    }
    setData({ saving: true });
    try {
      const res = await API.modelTest({
        base_url: data.form.base_url, api_key: data.form.api_key, model: data.form.model,
      });
      setData({ saving: false });
      if (res.success) alert('测试成功！响应：' + (res.response || '(空)'));
      else alert('测试失败：' + (res.error || '未知'));
    } catch (e) {
      setData({ saving: false });
      alert('测试失败：' + e.message);
    }
  }

  document.addEventListener('DOMContentLoaded', () => {
    $('#btn-add').onclick = showAddForm;
    $('#btn-cancel').onclick = hideForm;
    $('#btn-save').onclick = saveConfig;
    $('#btn-test-inline').onclick = testInline;
    document.querySelectorAll('[data-field]').forEach(el => el.oninput = onFormInput);
    load();
  });
})();
