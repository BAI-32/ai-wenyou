App({
  onLaunch() {
    if (!wx.cloud) {
      console.error('请使用微信 2.2.3 以上基础库版本');
      wx.showModal({
        title: '版本过低',
        content: '请升级微信到最新版本后使用',
        showCancel: false
      });
      return;
    }

    wx.cloud.init({
      env: 'YOUR_CLOUD_ENV_ID',
      traceUser: true,
    });

    this.globalData = {
      cloudEnv: 'YOUR_CLOUD_ENV_ID',
      userInfo: null,
      currentSave: null,
    };
  },

  globalData: {
    cloudEnv: 'YOUR_CLOUD_ENV_ID',
  }
});
