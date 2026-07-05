Page({
  data: {
    strictMode: false,
    threadMode: true,
  },

  onLoad() {
    const strict = wx.getStorageSync('strictMode') || false;
    const thread = wx.getStorageSync('threadMode') !== false;
    this.setData({ strictMode: strict, threadMode: thread });
  },

  toggleStrictMode(e) {
    this.setData({ strictMode: e.detail.value });
    wx.setStorageSync('strictMode', e.detail.value);
  },

  toggleThreadMode(e) {
    this.setData({ threadMode: e.detail.value });
    wx.setStorageSync('threadMode', e.detail.value);
  },

  clearCache() {
    wx.showModal({
      title: '清空缓存',
      content: '确定要清空本地缓存吗？存档数据不受影响。',
      success: (res) => {
        if (res.confirm) {
          wx.clearStorageSync();
          wx.showToast({ title: '缓存已清空' });
        }
      }
    });
  },
});
