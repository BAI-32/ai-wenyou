Page({
  data: {
    configs: [],
    showForm: false,
    editingId: null,
    saving: false,
    testingId: null,
    form: {
      name: '',
      base_url: 'https://api.xiaomimimo.com/v1',
      api_key: '',
      model: 'mimo-v2.5-pro',
      temperature: 0.8,
      max_tokens: 2048,
      is_default: true,
    },
  },

  onLoad() {
    this.loadConfigs();
  },

  onShow() {
    this.loadConfigs();
  },

  async loadConfigs() {
    try {
      const res = await wx.cloud.callFunction({
        name: 'manageModel',
        data: { action: 'list' },
      });
      if (res.result && res.result.configs) {
        this.setData({ configs: res.result.configs });
      }
    } catch (e) {
      console.error(e);
      wx.showToast({ title: '加载配置失败', icon: 'error' });
    }
  },

  showAddForm() {
    this.setData({
      showForm: true,
      editingId: null,
      form: {
        name: '',
        base_url: 'https://api.xiaomimimo.com/v1',
        api_key: '',
        model: 'mimo-v2.5-pro',
        temperature: 0.8,
        max_tokens: 2048,
        is_default: this.data.configs.length === 0,
      },
    });
  },

  hideAddForm() {
    this.setData({ showForm: false });
  },

  onFormInput(e) {
    const field = e.currentTarget.dataset.field;
    this.setData({
      [`form.${field}`]: e.detail.value,
    });
  },

  onSliderChange(e) {
    const field = e.currentTarget.dataset.field;
    this.setData({
      [`form.${field}`]: e.detail.value,
    });
  },

  async saveConfig() {
    const { form, editingId } = this.data;
    if (!form.name || !form.api_key || !form.model || !form.base_url) {
      wx.showToast({ title: '请填写必填项', icon: 'none' });
      return;
    }

    this.setData({ saving: true });
    try {
      const action = editingId ? 'update' : 'create';
      const res = await wx.cloud.callFunction({
        name: 'manageModel',
        data: {
          action,
          config: { ...form, _id: editingId },
        },
      });
      this.setData({ saving: false });
      if (res.result && res.result.success) {
        wx.showToast({ title: '保存成功' });
        this.hideAddForm();
        this.loadConfigs();
      } else {
        wx.showToast({ title: res.result?.error || '保存失败', icon: 'none' });
      }
    } catch (e) {
      this.setData({ saving: false });
      wx.showToast({ title: '保存失败', icon: 'error' });
    }
  },

  async setDefault(e) {
    const id = e.currentTarget.dataset.id;
    try {
      await wx.cloud.callFunction({
        name: 'manageModel',
        data: { action: 'setDefault', config: { _id: id } },
      });
      wx.showToast({ title: '已设为默认' });
      this.loadConfigs();
    } catch (e) {
      wx.showToast({ title: '操作失败', icon: 'error' });
    }
  },

  async deleteConfig(e) {
    const id = e.currentTarget.dataset.id;
    wx.showModal({
      title: '删除配置',
      content: '确定删除这个配置吗？',
      success: async (res) => {
        if (res.confirm) {
          try {
            await wx.cloud.callFunction({
              name: 'manageModel',
              data: { action: 'delete', config: { _id: id } },
            });
            wx.showToast({ title: '删除成功' });
            this.loadConfigs();
          } catch (e) {
            wx.showToast({ title: '删除失败', icon: 'error' });
          }
        }
      },
    });
  },

  async testConfig(e) {
    const id = e.currentTarget.dataset.id;
    this.setData({ testingId: id });
    try {
      // 先获取配置详情
      const getRes = await wx.cloud.callFunction({
        name: 'manageModel',
        data: { action: 'get', config: { _id: id } },
      });
      if (!getRes.result || !getRes.result.config) {
        throw new Error('获取配置失败');
      }
      const config = getRes.result.config;
      // 调用test接口
      const testRes = await wx.cloud.callFunction({
        name: 'manageModel',
        data: {
          action: 'test',
          config: {
            base_url: config.base_url,
            api_key: config.api_key,
            model: config.model,
          },
        },
      });
      this.setData({ testingId: null });
      if (testRes.result && testRes.result.success) {
        wx.showModal({
          title: '测试成功',
          content: `API连接正常，响应：${testRes.result.response}`,
          showCancel: false,
        });
      } else {
        wx.showModal({
          title: '测试失败',
          content: testRes.result?.error || '未知错误',
          showCancel: false,
        });
      }
    } catch (e) {
      this.setData({ testingId: null });
      wx.showToast({ title: '测试失败', icon: 'error' });
    }
  },
});
