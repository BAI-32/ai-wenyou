Page({
  data: {
    game_id: 'frxz',
    saves: [],
  },

  onLoad(options) {
    if (options.game_id) {
      this.setData({ game_id: options.game_id });
    }
    this.loadSaves();
  },

  onShow() {
    this.loadSaves();
  },

  async loadSaves() {
    wx.showLoading({ title: '加载中...' });
    try {
      const res = await wx.cloud.callFunction({
        name: 'manageSave',
        data: {
          action: 'list',
          game_id: this.data.game_id,
        },
      });
      wx.hideLoading();
      if (res.result && res.result.saves) {
        // 格式化时间
        const saves = res.result.saves.map(s => ({
          ...s,
          last_played_str: s.last_played ? new Date(s.last_played).toLocaleString('zh-CN') : '刚刚',
        }));
        this.setData({ saves });
      }
    } catch (e) {
      wx.hideLoading();
      wx.showToast({ title: '加载失败', icon: 'error' });
      console.error(e);
    }
  },

  newGame() {
    wx.navigateTo({
      url: `/pages/charCreation/charCreation?game_id=${this.data.game_id}&mode=newPlayer`,
    });
  },

  continueGame(e) {
    const saveId = e.currentTarget.dataset.saveId;
    wx.navigateTo({
      url: `/pages/dialog/dialog?save_id=${saveId}&game_id=${this.data.game_id}`,
    });
  },

  confirmDelete(e) {
    const saveId = e.currentTarget.dataset.saveId;
    wx.showModal({
      title: '删除存档',
      content: '确定要删除这个存档吗？删除后无法恢复。',
      success: async (res) => {
        if (res.confirm) {
          wx.showLoading({ title: '删除中...' });
          try {
            await wx.cloud.callFunction({
              name: 'manageSave',
              data: {
                action: 'delete',
                save_id: saveId,
                game_id: this.data.game_id,
              },
            });
            wx.hideLoading();
            wx.showToast({ title: '删除成功' });
            this.loadSaves();
          } catch (e) {
            wx.hideLoading();
            wx.showToast({ title: '删除失败', icon: 'error' });
          }
        }
      },
    });
  },
});
