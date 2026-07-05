Page({
  data: {
    game_id: 'frxz',
    mode: 'newPlayer', // newPlayer | newNPC
    save_id: null,
    description: '',
    generating: false,
    card: null,
    cardJson: '',
    editing: false,
  },

  onLoad(options) {
    this.setData({
      game_id: options.game_id || 'frxz',
      mode: options.mode || 'newPlayer',
      save_id: options.save_id || null,
    });

    // 如果是创建NPC，需要save_id
    if (this.data.mode === 'newNPC' && !this.data.save_id) {
      wx.showToast({ title: '参数错误', icon: 'error' });
      wx.navigateBack();
    }

    // 如果是新玩家，先创建存档
    if (this.data.mode === 'newPlayer' && !this.data.save_id) {
      this.createSaveFirst();
    }
  },

  async createSaveFirst() {
    wx.showLoading({ title: '初始化存档...' });
    try {
      const res = await wx.cloud.callFunction({
        name: 'manageSave',
        data: {
          action: 'create',
          game_id: this.data.game_id,
        },
      });
      wx.hideLoading();
      if (res.result && res.result.save_id) {
        this.setData({ save_id: res.result.save_id });
      } else {
        wx.showToast({ title: '创建存档失败', icon: 'error' });
        wx.navigateBack();
      }
    } catch (e) {
      wx.hideLoading();
      wx.showToast({ title: '创建存档失败', icon: 'error' });
      wx.navigateBack();
    }
  },

  onInputDesc(e) {
    this.setData({ description: e.detail.value });
  },

  async generate() {
    if (this.data.generating) return;
    this.setData({ generating: true });

    try {
      const action = this.data.mode === 'newPlayer' ? 'createPlayer' : 'createNPC';
      const res = await wx.cloud.callFunction({
        name: 'createCharacter',
        data: {
          action,
          save_id: this.data.save_id,
          game_id: this.data.game_id,
          description: this.data.description,
        },
      });

      this.setData({ generating: false });
      if (res.result && res.result.success) {
        this.setData({
          card: res.result.card,
          cardJson: JSON.stringify(res.result.card, null, 2),
          editing: false,
        });
      } else {
        wx.showToast({ title: res.result?.error || '生成失败', icon: 'none' });
      }
    } catch (e) {
      this.setData({ generating: false });
      wx.showToast({ title: '生成失败', icon: 'error' });
      console.error(e);
    }
  },

  regenerate() {
    this.generate();
  },

  editCard() {
    this.setData({ editing: !this.data.editing });
  },

  onEditCard(e) {
    this.setData({ cardJson: e.detail.value });
  },

  async confirmCard() {
    let card = this.data.card;
    if (this.data.editing) {
      try {
        card = JSON.parse(this.data.cardJson);
      } catch (e) {
        wx.showToast({ title: 'JSON格式错误', icon: 'error' });
        return;
      }
    }

    wx.showLoading({ title: '创建中...' });
    try {
      if (this.data.mode === 'newPlayer') {
        // 主角已经在创建时写入了，直接进入对话页
        wx.hideLoading();
        wx.redirectTo({
          url: `/pages/dialog/dialog?save_id=${this.data.save_id}&game_id=${this.data.game_id}`,
        });
      } else {
        // NPC创建成功，返回对话页
        wx.hideLoading();
        wx.showToast({ title: '创建成功' });
        setTimeout(() => {
          wx.navigateBack();
        }, 1000);
      }
    } catch (e) {
      wx.hideLoading();
      wx.showToast({ title: '创建失败', icon: 'error' });
    }
  },
});
