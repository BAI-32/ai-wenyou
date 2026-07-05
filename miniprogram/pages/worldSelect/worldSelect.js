Page({
  data: {},

  selectWorld(e) {
    const gameId = e.currentTarget.dataset.gameId;
    wx.navigateTo({
      url: `/pages/saveList/saveList?game_id=${gameId}`,
    });
  },

  goToModelManage() {
    wx.navigateTo({
      url: '/pages/modelManage/modelManage',
    });
  },
});
