# 凡人修仙传 AI 文游 · 微信小程序

> 一念成仙，一念成土。纯文字沙盒修仙AI游戏。

## 功能特性（MVP v0.1）

✅ **核心已实现**：
- 多存档系统，每个存档独立世界线
- 角色创建（主角/重要NPC），支持自定义描述生成
- 模型管理：支持多套OpenAI兼容配置（默认预填mimo中转站），AES加密存储API Key，一键切换
- AI对话：流式响应（当前版本先收集完整返回，SSE实时流后续优化），四段解析（REPLY/MEMORY/STATE/DIRECTOR）
- 记忆系统：重要NPC持久记忆，按存档+NPC完全隔离，NPC不会知道不属于自己的信息
- 两级NPC：重要NPC（创建后持久化，有记忆）/ 次要NPC（LLM即兴，无记忆，可提升为重要）
- 基础时间推进：识别"闭关一年"等时间跳跃输入，自动推进时间线
- 同轮reroll：不满意回复可重摇，不重复提交状态变更
- 修仙主题暗色UI

🔨 **后续Phase实现**：
- 上下文压缩（caveman规则，保事实丢散文）
- 自由输入场景识别（不点NPC按钮也能自动路由）
- 反八股风格系统
- 完整时间推进/世界演化/NPC演化
- 被动线索追踪
- SSE实时流式打字机效果
- 多世界支持
- 严格角色一致性校验

## 项目结构

```
xm/
├── project.config.json              # 微信项目配置（需要替换appid和云环境ID）
├── miniprogram/                     # 前端代码
│   ├── app.js / app.json / app.wxss
│   └── pages/
│       ├── worldSelect/            # 世界选择页
│       ├── saveList/               # 存档列表（新游戏/继续/删除）
│       ├── charCreation/           # 角色创建页（主角/NPC）
│       ├── dialog/                 # 核心对话页（聊天+状态面板+NPC列表）
│       ├── modelManage/            # 模型配置管理
│       └── settings/               # 设置页
├── cloudfunctions/                  # 云函数
│   ├── chat/                       # 主对话云函数
│   ├── manageModel/                # 模型配置CRUD/测试
│   ├── manageSave/                 # 存档CRUD/读取
│   ├── createCharacter/            # 角色创建（LLM生成卡）
│   └── shared/                     # 共享模块
│       ├── encryption.js           # AES加解密API Key
│       ├── llmGateway.js           # LLM调用网关（OpenAI兼容，支持缓存/流式/拉模型列表）
│       ├── parser.js               # 四段解析+角色卡解析
│       └── fileStorage.js          # 云存储文件读写+路径映射
└── data/                           # 初始知识文件（部署时上传到云存储）
    └── games/frxz/                 # 凡人修仙·天南越国世界
        ├── manifest.md
        ├── world.md                # 完整世界观
        ├── world_compressed.md     # 压缩版世界观
        └── regions/                # 区域文件
            └── yueguo_qipai.md
```

## 部署步骤

### 1. 环境准备
- 下载安装 [微信开发者工具](https://developers.weixin.qq.com/miniprogram/dev/devtools/download.html)（稳定版Windows 64位）
- 下载安装 [Node.js LTS](https://nodejs.org/)（版本≥18）
- 注册微信小程序账号（个人免费），获取AppID
- 在微信开发者工具中创建小程序项目，开通云开发（免费额度），记录云环境ID

### 2. 配置项目
1. 打开 `project.config.json`，将 `appid` 字段替换为你的小程序AppID
2. 打开 `miniprogram/app.js`，将 `cloudEnv` 替换为你的云开发环境ID
3. 在云开发控制台设置环境变量 `ENCRYPTION_KEY`（32位字符串，用于加密API Key，生产环境必须设置，不要用默认值）

### 3. 创建数据库集合
在云开发控制台 -> 数据库中，创建以下集合：
- `conversations`：对话历史
- `model_configs`：模型配置
- `saves`：存档元数据
- `characters`：角色索引
- `file_mappings`：云存储路径与fileID映射（自动创建）

创建以下索引（提升性能）：
- `conversations`: `{save_id: 1, timestamp: 1}`
- `saves`: `{user_id: 1, game_id: 1}`
- `characters`: `{save_id: 1, type: 1}`
- `model_configs`: `{user_id: 1}`

设置数据库权限：所有集合设置为"仅创建者可读写"（安全）

### 4. 上传知识文件
在云开发控制台 -> 云存储中，创建目录 `games/frxz/regions/`，将 `data/games/frxz/` 下的所有文件按目录结构上传：
- `games/frxz/manifest.md`
- `games/frxz/world.md`
- `games/frxz/world_compressed.md`
- `games/frxz/regions/yueguo_qipai.md`

> 注意：首次上传后需要在云存储中复制每个文件的FileID，写入`file_mappings`集合，对应关系为：
> ```
> {cloud_path: "games/frxz/world.md", file_id: "你复制的fileID"}
> ```
> 或者直接在微信开发者工具中调用`writeCloudFile`自动写入映射（后续会优化自动读取）。

### 5. 部署云函数
在微信开发者工具中，右键每个云函数文件夹：
1. 右键 `cloudfunctions/shared` 不需要单独部署（其他云函数会引用）
2. 依次右键 `chat` / `manageModel` / `manageSave` / `createCharacter`，选择"上传并部署：云端安装依赖"

### 6. 使用
1. 编译运行小程序
2. 进入模型管理，添加mimo配置（默认Base URL已填`https://api.xiaomimimo.com/v1`，模型`mimo-v2.5-pro`，填入你的API Key，测试连接成功后设为默认）
3. 返回世界选择页，进入"凡人修仙·天南越国"
4. 点击"新游戏"，输入角色描述（例如"我叫韩立，四灵根，黄枫谷外门弟子，相貌平平"），生成主角后开始游戏
5. 可以输入"创建角色：剑修陆云，沉默寡言"来创建重要NPC，之后点击人物列表切换对话对象

## 注意事项
1. **内容安全**：当前版本默认跳过msgSecCheck，允许18+内容，仅适合个人自用，公开发布需要自行处理内容审核问题
2. **成本**：默认BYOK（用户自带Key），开发者不需要承担API费用
3. **免费额度**：微信云开发免费额度足够个人使用，注意不要超量
4. **流式支持**：当前版本云函数先收集完整响应再返回，SSE实时打字机效果会在后续版本优化
5. **知识文件**：目前只做了越国七派基础设定，后续可以扩展更多区域、物品、门派内容

## 已实现核心机制说明

### 信息隔离（解决NPC全知问题）
- 代码级保证：与NPC陆云对话时，只会读取`npc_memory/lu_yun.md`，绝不会读取其他NPC或其他存档的记忆
- 次要NPC无持久记忆，每次即兴生成，避免串戏
- Prompt双保险：明确告诉LLM"不知道的事情就说不知道"

### Reroll重摇机制（不刷乱世界线）
- 同一轮对话（同一个turn_id）内可以重摇回复
- 重摇只生成新的回复文本，不重复写记忆、不重复推进状态、不重复增加回合数
- 重大事件（闭关/突破）采用"事实骨架固定，文本可重写"策略，避免刷平行世界
- 一旦发送下一条消息，上一轮就锁定，不能再reroll

### 时间推进基础框架（解决世界冻结感）
- 识别输入中的"闭关X年/月/天""赶路X天""养伤X天"等模式
- 自动计算流逝天数，将时间流逝提示注入上下文，让LLM自然推演变化
- 完整的世界演化/NPC演化/线索过期机制在Phase3实现

### 模型配置管理（参考RikkaHub/Chatbox）
- 支持多套配置保存，一键切换
- API Key AES加密存储，日志不打印明文
- 支持自定义Base URL/模型ID/温度/最大token等所有常用参数
- 支持测试连接，失败给出明确错误提示
- 未来会支持自动拉取模型列表

---

**本项目处于MVP阶段，所有核心框架已搭通，可以直接游玩。后续功能按Phase2-4计划逐步迭代。**
