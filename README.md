# AI 文游 · 凡人修仙传（H5 + Node 版）

原版是微信小程序（云开发），这是改造后的 **纯 HTML5 + Node 后端**版本。

- 前端：5 个 HTML 页，`fetch` 调后端
- 后端：单文件 `server.js`（合并 4 个云函数，JSON + Markdown 文件持久化）
- 本地：`node server.js`，浏览器 <http://localhost:3001>
- 云端：推荐 Cloudflare Pages（前端静态）+ 后端 fly.io/Deno Deploy

---

## 一、目录结构

```
.
├── server.js                 ← 后端 Node 服务（合并 4 个云函数）
├── miniprogram/
│   ├── lib/api.js            ← fetch 封装，替代 wx.cloud
│   ├── pages/
│   │   ├── worldSelect/      ← 选择世界
│   │   ├── saveList/         ← 存档列表
│   │   ├── charCreation/     ← 创建角色
│   │   ├── dialog/           ← 对话
│   │   ├── modelManage/      ← 模型配置
│   │   └── settings/         ← 设置
│   ├── app.js                ← 入口（设置 API_BASE）
│   └── wx-server-sdk/...     ← 原项目文件（小程序编译用，H5 不用）
├── public/style.css          ← 全局样式
├── data/
│   ├── games/frxz/           ← 游戏知识文件（原样保留）
│   │   ├── manifest.md
│   │   ├── world.md
│   │   ├── world_compressed.md
│   │   └── regions/yueguo_qipai.md
│   ├── db/                   ← 运行时生成（JSON 数据库）
│   └── saves/                ← 存档文件（每个存档一个目录）
└── README.md
```

---

## 二、本地运行（5 分钟）

### 前置
- Node.js ≥ 18

### 启动

```bash
# 安装依赖（无第三方依赖，纯 Node 内置模块）
cd ai-wenyou
node server.js
```

### 配置

打开浏览器 <http://localhost:3001>，进入：

- 首页 → 世界选择 → 凡人修仙·天南越国
- 首次进入会看到空的存档列表，点 **"+ 新游戏"**
- 但先点右上角 **"模型"** 配置 mimo API

### 配置 mimo

1. **模型管理** → **"+ 添加模型"**
2. 填写：

| 字段 | 值 |
|---|---|
| 名称 | 任意（如：mimo 主力） |
| Base URL | `https://api.xiaomimimo.com/v1` |
| API Key | 你的 mimo API Key（sk-...） |
| 模型 | `mimo-v2.5-pro` |

3. 保存 → 点行内 **"设默认"**

### 开始游戏

返回首页 → 凡人修仙 → **新游戏** → 填角色描述（如"我叫韩立，四灵根，黄枫谷外门弟子"）→ 生成角色 → 进入对话

---

## 三、关电脑也能玩的云端部署

> 项目默认在 <http://localhost:3001> 启动。关电脑后 localhost 就挂了。下面两种方案都能让**其他人 / 手机**玩。

### 方案 A：Cloudflare Pages（前端）+ fly.io（后端）

> 适合想让所有朋友都能玩的场景

#### 1. 部署前端到 Cloudflare Pages（免费）

1. 注册 <https://dash.cloudflare.com>
2. **Workers & Pages** → **创建应用程序** → **Pages** → **连接到 Git**
3. 选 `BAI-32/ai-wenyou` 仓库
4. 构建设置：
   - Framework preset: **None**
   - Build command: 留空
   - Output directory: `miniprogram/pages`（但 server.js 有内置路由，直接 Pages Functions 即可）

更简单方案：**用 Pages Functions**，把 UI 放根目录：

5. 项目根创建 `functions/` 目录，Cloudflare 会用 Functions 替代 server.js 做 API（高级用户）

#### 2. 部署后端到 fly.io（免费 3 台共享机）

```bash
# 安装 flyctl
npm i -g flyctl
flyctl auth login

# 在项目根建 fly.toml
cat > fly.toml << 'EOF'
app = 'ai-wenyou'
primary_region = 'hkg'

[build]

[env]
  ENCRYPTION_KEY = '替换为你的32位密钥'

[http_service]
  internal_port = 8080
  force_https = true

[[vm]]
  size = 'shared-cpu-1x'
EOF

flyctl launch --no-deploy
flyctl deploy
```

部署后 `https://ai-wenyou.fly.dev` 就是 API 根 URL。

#### 3. 修改前端 API_BASE

在 `miniprogram/app.js`：

```js
apiBase: 'https://ai-wenyou.fly.dev'
```

推送代码 → Cloudflare 自动部署 → 完成。

---

### 方案 B：单 VPS 或国内云服务器 24 小时运行

> 适合单人玩、想最简配置

```bash
# 在任意 linux 服务器（最轻 1 核 512MB）
apt update; apt install -y nodejs npm
git clone https://github.com/BAI-32/ai-wenyou.git
cd ai-wenyou
PORT=80 node server.js
```

或配 nginx 反向代理 + HTTPS。

---

## 四、加密 API Key

后端 `data/db/model_configs.json` 里 API Key 以 AES-256-CBC 加密。

**默认密钥**：`frxz-default-key-32-bytes-long!!`（不安全，生产环境必须换！）

启动时指定环境变量：

```bash
ENCRYPTION_KEY=你的32位密钥字符串 node server.js
```

或在 Cloudflare Pages / fly.io 的环境变量里设置 `ENCRYPTION_KEY`。

---

## 五、存档数据

| 文件 | 作用 |
|---|---|
| `data/db/saves.json` | 存档元数据列表 |
| `data/db/model_configs.json` | 模型配置（含加密的 API Key） |
| `data/db/conversations.json` | 对话历史 |
| `data/db/characters.json` | 角色索引 |
| `data/saves/<save_id>/` | 每个存档的 markdown 文件（player.md, state.md 等）|

定期备份 `data/` 目录即可。

---

## 六、从微信小程序版迁移

如果你要保留小程序版 + H5 版双版本：

1. 另建一分支 `miniprogram-wx`
2. 在 master 上做 H5 改造
3. 在 wx 分支保留原云函数
4. UI 逻辑共享（差异只在于调 API 时 base URL 不同）

---

## 七、已知问题与改进

- [ ] 时间跳跃提示未实际持久化到 world_time（待 Phase 3 完善）
- [ ] Reroll 暂未保存候选版本（每次覆盖）
- [ ] 对话压缩尚未实现
- [ ] 多语言系统尚未完整（仅中文）

欢迎 PR 修 bug & 加功能。

---

## 八、米墨 mimo 接入参考

Base URL: <https://api.xiaomimimo.com/v1>

模型列表:
- `mimo-v2.5-pro`
- `mimo-v2.5`

API Key 获取: <https://www.xiaomimimo.com> 注册后生成

---

## License

MIT
