Page({
  data: {
    game_id: 'frxz',
    save_id: null,
    saveInfo: {},
    currentNpcId: null,
    messages: [],
    inputText: '',
    sending: false,
    rerolling: false,
    currentTurnId: null,
    showState: false,
    showNPCList: false,
    npcList: [],
    stateText: '',
    showCompressionHint: false,
    scrollToView: '',
  },

  onLoad(options) {
    if (!options.save_id) {
      wx.showToast({ title: '参数错误', icon: 'error' });
      wx.navigateBack();
      return;
    }
    this.setData({
      save_id: options.save_id,
      game_id: options.game_id || 'frxz',
    });
    this.loadSaveInfo();
    this.loadNPCList();
    this.loadHistory();
  },

  async loadSaveInfo() {
    try {
      const res = await wx.cloud.callFunction({
        name: 'manageSave',
        data: {
          action: 'get',
          save_id: this.data.save_id,
          game_id: this.data.game_id,
        },
      });
      if (res.result && res.result.save) {
        this.setData({ saveInfo: res.result.save });
        if (res.result.files && res.result.files.state) {
          this.setData({ stateText: res.result.files.state });
        }
      }
    } catch (e) {
      console.error(e);
    }
  },

  async loadNPCList() {
    try {
      const db = wx.cloud.database();
      const res = await db.collection('characters')
        .where({ save_id: this.data.save_id, type: 'npc' })
        .get();
      this.setData({ npcList: res.data });
    } catch (e) {
      console.error(e);
    }
  },

  async loadHistory() {
    try {
      const db = wx.cloud.database();
      const res = await db.collection('conversations')
        .where({
          save_id: this.data.save_id,
          is_final: true,
        })
        .orderBy('timestamp', 'asc')
        .limit(50)
        .get();

      const messages = res.data.map(m => ({
        role: m.role,
        content: m.content,
        turn_id: m.turn_id,
        rerollable: false,
      }));

      // 最后一条AI消息允许reroll（简化版，只有最新一轮可reroll）
      if (messages.length > 0 && messages[messages.length - 1].role === 'assistant') {
        messages[messages.length - 1].rerollable = true;
        this.setData({ currentTurnId: messages[messages.length - 1].turn_id });
      }

      this.setData({ messages });
      this.scrollToBottom();
    } catch (e) {
      console.error(e);
    }
  },

  toggleStatePanel() {
    this.setData({ showState: !this.data.showState, showNPCList: false });
  },

  toggleNPCList() {
    this.setData({ showNPCList: !this.data.showNPCList, showState: false });
  },

  selectNPC(e) {
    const npcId = e.currentTarget.dataset.npcId || null;
    this.setData({ currentNpcId: npcId, showNPCList: false });
    wx.showToast({ title: npcId ? '已切换对话对象' : '进入自由探索模式', icon: 'none' });
  },

  goCreateNPC() {
    this.setData({ showNPCList: false });
    wx.navigateTo({
      url: `/pages/charCreation/charCreation?game_id=${this.data.game_id}&save_id=${this.data.save_id}&mode=newNPC`,
    });
  },

  createNPCCommand() {
    const text = this.data.inputText.trim();
    if (text.startsWith('创建角色')) {
      this.send();
      return;
    }
    this.setData({ inputText: '创建角色：' });
  },

  goToModel() {
    wx.navigateTo({ url: '/pages/modelManage/modelManage' });
  },

  onInput(e) {
    this.setData({ inputText: e.detail.value });
  },

  scrollToBottom() {
    const length = this.data.messages.length;
    if (length > 0) {
      this.setData({ scrollToView: `msg-${length - 1}` });
    }
  },

  async send() {
    const text = this.data.inputText.trim();
    if (!text || this.data.sending) return;

    // 先处理"创建角色"命令
    if (text.startsWith('创建角色')) {
      const desc = text.replace(/^创建角色[:：]?\s*/, '');
      this.setData({ inputText: '' });
      wx.navigateTo({
        url: `/pages/charCreation/charCreation?game_id=${this.data.game_id}&save_id=${this.data.save_id}&mode=newNPC&description=${encodeURIComponent(desc)}`,
      });
      return;
    }

    this.setData({ sending: true });
    const userMsg = { role: 'user', content: text };
    const messages = [...this.data.messages, userMsg];
    this.setData({ messages, inputText: '' });
    this.scrollToBottom();

    try {
      const res = await wx.cloud.callFunction({
        name: 'chat',
        data: {
          game_id: this.data.game_id,
          save_id: this.data.save_id,
          npc_id: this.data.currentNpcId,
          user_input: text,
          reroll: false,
        },
      });

      this.setData({ sending: false });

      if (res.result && res.result.error) {
        wx.showToast({ title: res.result.error, icon: 'none' });
        // 移除失败的用户消息
        this.setData({ messages: this.data.messages.slice(0, -1) });
        return;
      }

      if (res.result && res.result.success) {
        const aiMsg = {
          role: 'assistant',
          content: res.result.reply,
          turn_id: res.result.turn_id,
          rerollable: true,
        };
        const newMessages = [...this.data.messages, aiMsg];
        // 之前的消息不可reroll
        if (newMessages.length > 2) {
          newMessages[newMessages.length - 2].rerollable = false;
        }
        this.setData({
          messages: newMessages,
          currentTurnId: res.result.turn_id,
          showCompressionHint: res.result.shouldSuggestCompression || false,
        });
        this.scrollToBottom();
        // 刷新存档信息
        this.loadSaveInfo();
      }
    } catch (e) {
      this.setData({ sending: false });
      wx.showToast({ title: '发送失败', icon: 'error' });
      // 移除失败的用户消息
      this.setData({ messages: this.data.messages.slice(0, -1) });
      console.error(e);
    }
  },

  async reroll() {
    if (this.data.rerolling || !this.data.currentTurnId) return;

    // 获取最后一条用户消息
    const messages = [...this.data.messages];
    const lastUserMsgIndex = messages.map(m => m.role).lastIndexOf('user');
    if (lastUserMsgIndex === -1) return;
    const userInput = messages[lastUserMsgIndex].content;

    this.setData({ rerolling: true });

    try {
      const res = await wx.cloud.callFunction({
        name: 'chat',
        data: {
          game_id: this.data.game_id,
          save_id: this.data.save_id,
          npc_id: this.data.currentNpcId,
          user_input: userInput,
          reroll: true,
          turn_id: this.data.currentTurnId,
        },
      });

      this.setData({ rerolling: false });

      if (res.result && res.result.success) {
        // 替换最后一条AI消息
        const newMessages = [...this.data.messages];
        newMessages[newMessages.length - 1] = {
          role: 'assistant',
          content: res.result.reply,
          turn_id: res.result.turn_id,
          rerollable: true,
        };
        this.setData({ messages: newMessages });
        this.scrollToBottom();
      } else {
        wx.showToast({ title: '重摇失败', icon: 'none' });
      }
    } catch (e) {
      this.setData({ rerolling: false });
      wx.showToast({ title: '重摇失败', icon: 'error' });
    }
  },

  async compress() {
    wx.showLoading({ title: '压缩中...' });
    try {
      // 预留压缩云函数调用，Phase2实现
      await new Promise(resolve => setTimeout(resolve, 1000));
      wx.hideLoading();
      wx.showToast({ title: '压缩功能开发中', icon: 'none' });
      this.setData({ showCompressionHint: false });
    } catch (e) {
      wx.hideLoading();
    }
  },

  onShow() {
    // 从创建角色页返回时刷新NPC列表
    this.loadNPCList();
    this.loadSaveInfo();
  },
});
