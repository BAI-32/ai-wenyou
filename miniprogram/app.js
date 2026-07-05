App({
  onLaunch() {
    // API_BASE: replace with Cloudflare pages.dev domain or your own
    this.globalData = {
      apiBase: 'https://ai-wenyou.pages.dev',
      userInfo: null,
      currentSave: null,
    };
    window.API_BASE = this.globalData.apiBase;
  },

  globalData: {
    apiBase: 'https://ai-wenyou.pages.dev',
  }
});
