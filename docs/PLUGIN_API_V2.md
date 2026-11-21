# VRlink v2 插件 API（apiVersion 1）

> 面向玩家/作者的插件说明书。
> 适用：`仓库根目录`（VRlink v002 / 0.6.6；插件 API 版本仍是 `1`），Node.js >= 22。
> 依据（2026-11-08 的代码）：`src/plugin-host.mjs`、`src/plugin-worker.mjs`、`src/plugin-manifest.mjs`、`src/contracts.mjs`、`src/capability-bus.mjs`、`src/server.mjs` 的 `/api/plugins*` 端点。
> **代码和本文冲突时，以代码为准。** 本文只描述 v2 当前真实实现，不描述“以后应该有”的东西。

---

## 0. 30 秒版本

一个 VRlink v2 插件就是**一个目录**：

```
plugins/my-plugin/
├── plugin.json   # 清单：id、名字、入口、要哪些权限
└── index.mjs     # 入口：export default 一个 activate(api) 函数
```

插件在**独立 Node 子进程**里运行，通过宿主给的 `api` 做三件事：

| 能做 | 对应权限 | 效果 |
|---|---|---|
| 收事件 | `events.read` | 宿主把角色的每条新事件推给你的 handler |
| 发消息 | `messages.send` | 以某个角色的身份往事件流里写一条 `message.sent` |
| 存自己的数据 | `storage` | 读写 `data/plugins/<id>/storage.json` |

装插件 = 把目录放进 `plugins/`，重启 v2 server，然后在 UI/API 里**启用**并**逐项授权**。
**装代码插件等于信任作者**：宿主做的是进程隔离 + 权限过滤，不是强沙箱，细节见 §13。

---

## 1. 目录放哪、宿主怎么扫

### 1.1 位置

默认插件目录：`仓库根目录\plugins\`。
启动时由 `src/server.mjs` 传给 `PluginHost`；可以用 `createHub({ pluginsDir })` 换，但命令行启动没有环境变量能改它。

```
仓库根目录\plugins\
├── _template\      # 本仓库的模板插件（可复制）
├── hello-event\    # 最小示例（只读事件、只写日志）
├── hello-memory\   # 早期示例（清单可参考，index.mjs 的 handler 是旧签名，别照抄）
└── my-plugin\      # ← 你的插件
```

### 1.2 扫描规则（以 `src/plugin-manifest.mjs` 为准）

- 扫描发生在 **server 启动时**。运行中新增/删除插件目录**不会**被发现，必须重启 server。
- 只扫 `plugins/` 下一层目录；**以 `.` 开头的目录跳过**。以下划线开头的 `_template` 不会被跳过。
- 每个目录找 `plugin.json`；JSON 坏了、字段缺了、权限名不认识 → 这个插件**不会出现在 `/api/plugins`**，只在宿主控制台留一行：
  `[plugin] skip 仓库根目录\plugins\xxx: <原因>`
- **入口检查**（`readPluginManifest`，2026-11-08 起）：`entry` 必须解析到插件目录内（绝对路径、`../`、符号链接逃逸都拒绝），文件必须存在且是普通文件。不合格同样会整个跳过，日志形如 `plugin <id>: entry must stay inside plugin dir` / `entry not found`。
- 目录名**不要求**等于 `plugin.json` 的 `id`（模板目录叫 `_template`，id 是 `template`）。但推荐保持一致，便于排查。
- **`id` 必须全局唯一**。两个目录写同一个 id 时，后扫描到的会覆盖先扫描到的（`fs.readdir` 顺序，不保证稳定），最终只保留一个。

### 1.3 目录里能放什么

- 入口文件（默认 `index.mjs`，ESM）；
- README、图片、JSON 配置、数据文件等静态资源；
- 任意子目录。

不要放：

- 可执行文件（`.exe/.dll/.bat/.ps1/.sh/.node/...`）——宿主不会执行它们，但分享时会被打包工具拒绝；
- 指向目录外的符号链接；
- 你的插件**不应该**写 `data/`（那是玩家真实数据）。要存东西用 `api.storage`。

---

## 2. `plugin.json` 字段表

清单由 `src/contracts.mjs` 的 `validatePluginManifest()` 校验，再由 `src/plugin-manifest.mjs` 校验权限白名单。

| 字段 | 必填 | 类型/规则 | 说明 |
|---|---|---|---|
| `id` | ✅ | 字符串，`^[a-z0-9][a-z0-9_-]{1,40}$`（2–41 字符） | 唯一标识；也是 storage / permissions 的键 |
| `type` | ✅ | `data` / `panel` / `code` / `adapter` / `brain` / `device` | 目前**只是标注**：宿主对任何 type 都会加载入口。只有 `code` 有明确语义，其余是预留 |
| `name` | ✅ | 非空字符串 | 显示名（可中文） |
| `version` | ✅ | 以 `数字.数字.数字` 开头 | 例 `0.1.0`、`1.2.3-beta`；`1.2` 不行 |
| `apiVersion` | ✅ | 整数且 >= 1 | 当前 API 是 `1`。宿主不检查上限，未来版本会另行说明 |
| `entry` | ✅ | 非空字符串，插件目录内的相对路径 | 入口文件，例 `index.mjs`、`src/main.mjs`。宿主扫描时用 realpath 校验：必须留在插件目录内、存在且是普通文件；`../`、绝对路径、符号链接逃逸都会被拒绝，插件不会加载 |
| `permissions` | ❌ | 数组，元素必须在 §5 白名单里 | 缺省 `[]`；写错一个权限名，整个插件会被跳过 |
| `capabilities` | ❌ | 数组 | 预留/展示用。宿主**不校验名字、不注册、不授予**“调用能力”的权限 |
| `risk` | ❌ | `low` / `medium` / `high` / `forbidden` | 缺省 `low`。目前只影响 UI/API 展示，**不改变执行与权限** |
| `description` | ❌ | 字符串 | 展示用，建议写清楚“这插件会干什么” |
| `license` | ❌ | 字符串 | 展示/约定用，不强制 |
| `author` | ❌ | 字符串 | 展示/约定用，不强制 |
| 其他字段 | ❌ | 任意 | 原样保留，宿主不使用 |

最小可用清单：

```json
{
  "id": "my-plugin",
  "type": "code",
  "apiVersion": 1,
  "version": "0.1.0",
  "name": "我的插件",
  "entry": "index.mjs",
  "permissions": ["events.read"]
}
```

模板插件的完整清单见 `plugins/_template/plugin.json`。

> ⚠️ 注意：`permissions` 默认授予发生在**第一次扫描**（本地还没有 `data/plugins/permissions.json` 里这个 id 的记录时），宿主会把清单里的权限**全部默认授予**。之后清单新增权限**不会**自动授予，需要玩家重新勾选（见 §5.3）。

---

## 3. 入口文件与 `api`

### 3.1 入口约定

```js
// plugins/my-plugin/index.mjs
export default async function activate(api) {
  // 注册 handler；同步/异步都可以
}
```

启动顺序（`src/plugin-worker.mjs`）：

1. 宿主 fork 子进程，把清单里的 `dir` / `entry` / 已授权 `permissions` 通过环境变量 `VRLINK_PLUGIN_CONFIG` 传进去；
2. worker `import(entry)`；
3. 要求模块有 `default` 导出且是函数，否则报 `plugin must export default activate(api)`；
4. 调用 `await activate(api)`；
5. 成功后给宿主发 `ready`，宿主把状态置为 `running`。

失败处理：`activate` 抛错 / 入口 import 失败 / 5 秒内没 `ready` → 宿主返回 `{ok:false,error}`，状态 `error`（或 `crashed`），子进程被杀。错误堆栈会打在宿主控制台。

### 3.2 `api.id` / `api.permissions`

- `api.id`：清单 id。
- `api.permissions`：**启用那一刻**的已授权权限快照（冻结数组）。
  权限之后在 UI/API 里改了，宿主侧会**立即生效**，但 `api.permissions` 不会变。不要用它做运行时判断，只适合打日志。

### 3.3 `api.on("event", handler)`

```js
const off = api.on("event", async (name, event) => {
  // name === event.type，例如 "message.received"
  // event 是完整事件对象，见 §4
});
```

| 项 | 规则 |
|---|---|
| 允许的订阅类型 | 只支持 `"event"`；传别的会 `throw` |
| handler 签名 | `(name, payload)`，`name` 是事件类型字符串，`payload` 是事件对象 |
| 多个 handler | 按注册顺序**串行** await |
| 返回值 | 一个退订函数 |
| 超时 | 单个事件从推送至 `event-done` 最多 **3 秒**；超时宿主记 `event timeout`，插件进程不退出，后续事件继续 |
| 并发 | 同一个插件的事件是串行队列；不同插件之间并行 |
| 初始重放 | **没有**。启用后只收到新事件，不会补发历史事件 |

> React 会自己收到自己 `api.send` 产生的 `message.sent`。处理多类型事件时务必先按 `event.type` 过滤，否则可能自激循环。

### 3.4 `api.log(level, message)`

```js
api.log("info", "启动了");
api.log("warn", `存储不可用：${error.message}`);
```

宿主控制台输出 `[plugin:<id>] <level>: <message>`。`level` 只是字符串，宿主不按级别过滤（`info/warn/error` 是约定）。

### 3.5 `api.send(payload)`

```js
api.send({
  characterId: "lin_wan",
  text: "插件发的消息",
  target: { body: "desktop", thread: "main", visibility: "private" }, // 可选
});
```

- 效果：通过能力总线调用 `message.send`，往事件流写一条 `message.sent` 事件（**不是**直接发到 QQ / B站 / 桌面通知）。
- 必填：`characterId`、`text`（会 trim；空的一律丢弃并写宿主日志）。
- `target` 可省略，默认 `{ body: "desktop", thread: "main" }`；`visibility` 缺省 `private`。
- **没有返回值、没有成功/失败回调**。以下失败只出现在宿主控制台：
  - 没有 `messages.send` 权限：`[plugin:<id>] send denied (no messages.send)`
  - 角色没有覆盖 `message.send` 的低风险同意：`send failed: capability message.send needs consent`
  - 参数不全：`send ignored (characterId/text missing)`
- 宿主**不按插件做角色白名单**：有 `messages.send` 且目标角色有低风险同意（通常就是已创建/种子角色），就能给它发。

### 3.6 `api.storage`

```js
await api.storage.get("key");   // 不存在返回 null
await api.storage.all();        // 返回整个对象
api.storage.set("key", value);  // fire-and-forget，无回执
```

| 项 | 规则 |
|---|---|
| 权限 | 需要 `storage`。没有权限时 `get/all` 会 reject `"no storage permission"`；`set` 被宿主**静默忽略** |
| 落盘 | `data/plugins/<id>/storage.json`（整个插件的键值对象，JSON 文本） |
| 超时 | `get/all` 3 秒超时 → reject `storage get timeout` / `storage all timeout` |
| `set` | 不等待落盘、没有确认。不要在同一个 handler 里 `set` 完立刻依赖读回值 |
| 值类型 | 必须能 JSON 序列化（`Date`、`Map`、函数会丢/变） |
| 大小 | 宿主当前没有限制；自己别写爆（建议 < 1 MB） |
| 生命周期 | **独立于 enable/disable**：停用插件不会清数据，重新启用还在；卸载插件目录也不会自动删 `data/plugins/<id>/` |
| 导出/清空 | `GET /api/plugins/<id>/storage` 导出；`DELETE` 清空（不可恢复）；旧版 UI `/legacy` 有按钮 |

模板插件的写法值得直接抄：先 `get` 计数，再 `set`，并用 try/catch 兜住“存储权限被撤销”的情况。

### 3.7 明确**没有**的 API

以下能力在 v2 的 worker API 里**不存在**：

- ❌ `api.memory.*`（读写角色记忆）
- ❌ `api.capabilities.invoke(...)`（调用其他能力）
- ❌ `api.devices.*`（控制设备）
- ❌ `api.network.*` / 内置 HTTP 客户端
- ❌ `api.emit(...)`（往事件流写任意事件；只能通过 `send` 写 `message.sent`）
- ❌ 自定义 IPC / 与宿主任意通信

如果插件需要网络或文件，只能自己在子进程里 `import "node:https"` / `"node:fs"`——那不受宿主权限表管，见 §13。

---

## 4. 能收到哪些事件

事件对象就是 `data/characters/<id>/events.jsonl` 里的一条记录。插件拿到的 `payload` 形如：

```json
{
  "id": "evt_m3x9_ab12cd",
  "characterId": "lin_wan",
  "at": 1770000000000,
  "type": "message.received",
  "source": {
    "body": "desktop",
    "thread": "main",
    "actor": { "id": "owner", "name": "我" }
  },
  "visibility": "private",
  "content": { "text": "在吗" },
  "seq": 12,
  "prev": "evt_...",
  "origin": "node_...",
  "char": "char_...",
  "sig": "..."
}
```

| 字段 | 说明 |
|---|---|
| `id` | 事件 id |
| `characterId` | 哪个角色的事件 |
| `at` | 毫秒时间戳（不是 ISO 字符串） |
| `type` | 事件类型，见下表 |
| `source` | `{ body, thread, actor }`：来自哪个身体/渠道、线程、谁触发 |
| `visibility` | `private` / `group` / `public` / `internal` |
| `content` | 事件内容对象；不同 type 结构不同 |
| `seq` / `prev` / `origin` / `char` / `sig` | 节点签名链字段（当前默认开启签名）；只做展示/校验，不建议插件依赖 |

### 4.1 当前真的会推给插件的事件类型

以代码为准（`src/contracts.mjs` 的枚举 + 实际写入点）：

| type | 什么时候出现 | `content` 里通常有什么 |
|---|---|---|
| `message.received` | 桌面聊天、`simulate`、B站 `draft`、A2A、OneBot 桥等外部消息进入 | `{ text, draft? }` |
| `message.sent` | 角色回复、插件 `api.send`、其他 `message.send` 调用 | `{ text }` |
| `message.draft` | 草稿模式（B站桥）生成回复时 | `{ text, draft: true }` |
| `thought` | 大脑生成了“内心想法” | `{ text }` |
| `system` | 系统事件，例如预算用完被 mute | `{ text }` |
| `log.genesis` | 旧事件日志第一次补签名时 | `{ legacyDigest, legacyCount }` |

`contracts.mjs` 里还声明了 `action.requested`、`action.result`、`device.state`，但**当前核心代码不产生**这些事件，插件收不到。不要把它们当成已经可用。

### 4.2 事件的三个坑

1. **不会补发历史**：插件启用前的事件看不到。要“补课”只能自己读文件/API，但插件没有文件权限 API（除非自己 `import "node:fs"`——不推荐，绕过权限模型）。
2. **所有角色的事件都会推**：`events.read` 是全局的，不是按角色授权。插件能看到所有已启用角色的生活流。
3. **安全模式会掐断推送**：`POST /api/safe-mode` 之后，事件日志仍然写入，但宿主不再分发给任何插件；`POST /api/safe-mode/off` 恢复。插件自己的 `enable` 仍能成功启动，只是收不到事件。

---

## 5. 权限表（每个权限到底能干什么）

宿主只对**经过宿主的三条通道**做权限检查：事件推送、`api.send`、`api.storage`。权限表里的 9 个名字来自 `PLUGIN_PERMISSIONS`，但**只有 3 个真的被执行**：

| 权限 | 宿主真的检查？ | 允许什么 | 不允许什么 / 现状 |
|---|---|---|---|
| `events.read` | ✅ | 接收所有角色的新事件 | 撤销后立刻停止推送（不需要重启插件）；不提供历史事件、不按角色过滤 |
| `messages.send` | ✅ | `api.send()` 以角色身份写 `message.sent` | 不让你直接发 QQ/B站/通知；还要过角色同意（§5.5）。撤销后 `api.send` 被静默丢弃 |
| `storage` | ✅ | `api.storage.get/all/set` | 撤销后 `get/all` 报错、`set` 被忽略；不提供文件系统访问 |
| `memory.read` | ❌ 未实现 | 清单预留 | 没有对应 API；声明了也读不到记忆 |
| `memory.write` | ❌ 未实现 | 清单预留 | 没有对应 API；`hello-memory` 的 `memory.write` 目前是空转 |
| `capabilities.invoke` | ❌ 未实现 | 清单预留 | 没有调用其他能力的 API |
| `network.lan` | ❌ 未实现 | 清单预留 | **既不提供也不限制**。插件进程本身可以直接联网 |
| `network.internet` | ❌ 未实现 | 清单预留 | 同上；声明这个权限不会阻止插件联网，也不会让它“更安全” |
| `devices.command` | ❌ 未实现 | 清单预留 | 没有设备控制 API |

> 结论：**不要用“权限表里有 network/devices”来理解安全边界**。真正的安全边界只有 §13 写的那几条。

### 5.1 默认授予规则

- 第一次启动、`data/plugins/permissions.json` 里没有这个 id：把清单 `permissions` **全部授予**。
- 之后以 `permissions.json` 为准；只会保留“清单里仍然声明了”的权限。
- 插件升级后清单**新增**权限：不会自动授予，需要玩家重新勾选/调用 PUT。
- 插件升级后清单**删掉**权限：本地记录里对应项在下次启动时被过滤掉。

`data/plugins/permissions.json` 结构：

```json
{
  "template": ["events.read", "messages.send", "storage"]
}
```

### 5.2 撤销/恢复立即生效

`PUT /api/plugins/<id>/permissions` 只接受清单声明的权限子集，其他值会被**静默忽略**（返回的 `granted` 是实际生效值）：

```powershell
# 只留 events.read + storage：等于撤销 messages.send
curl.exe -X PUT http://127.0.0.1:5274/api/plugins/template/permissions `
  -H "content-type: application/json" `
  -d '{"permissions":["events.read","storage"]}'
```

- 不需要重启插件进程，宿主每条消息实时查 `granted`。
- 把权限恢复回来，插件立刻又能发——**进程没有重启，`api.permissions` 快照仍是旧的**。
- `GET /api/plugins/<id>/permissions` 可看 `manifest`（清单声明）与 `granted`（实际授予）。

### 5.3 在 UI 里授权

| 界面 | 路径 | 能做什么 |
|---|---|---|
| v2 UI | `http://127.0.0.1:5274/` → 「插件」 | 看插件列表、类型、权限描述、运行状态；**启用/停用** |
| 旧版 UI | `http://127.0.0.1:5274/legacy` → 右侧「扩展」面板 | 启用/停用、**逐项勾选/撤销权限**、导出数据、清空数据 |

v2 UI 目前**没有逐项勾选权限**的控件；要逐项授权请用 `/legacy` 或上面的 PUT API。

### 5.4 授权/撤销与安全模式

- 「安全模式」（v2 UI 「设置 → 安全」→ 开启；或 `POST /api/safe-mode`）会：
  1. 停掉所有运行中的插件（`disableAll`）；
  2. 在事件分发处直接 return，之后即使手动启用插件也收不到事件。
- 「关闭安全模式」（`POST /api/safe-mode/off`）**不会自动重新启用**插件，需要手动再启用。
- 「紧急停止」（`POST /api/emergency-stop`）只拦 `/api/characters/:id/chat`，**不拦插件事件分发**。要停插件请用安全模式或逐项停用。

### 5.5 第二道门：角色同意（consent）

`api.send` 走的是能力总线的 `message.send`，风险 `low`，但仍要求目标角色有一条覆盖 `message.send` 的低风险同意：

- 新建角色时（`POST /api/characters`）会自动 `ensureDefaultGrant`；
- 种子角色启动时也会补；
- 如果玩家把该角色的同意全部撤销，插件即使有 `messages.send` 也发不出，宿主日志：
  `[plugin:<id>] send failed: capability message.send needs consent`
- 这条链路会写审计：`data/characters/<角色id>/audit/audit.jsonl`，其中 `reason` 形如 `plugin:<id>`。

---

## 6. storage 生命周期

```
data/
└── plugins/
    ├── permissions.json          # 所有插件的授权记录（PluginHost 管理）
    └── <plugin-id>/
        └── storage.json          # 这个插件自己的键值数据
```

- **启用/停用**：不清空。
- **插件崩溃/重启**：不清空。
- **升级**（覆盖插件目录）：不清空，id 不变就还在。
- **卸载**（删除插件目录）：文件仍在。想彻底删：`DELETE /api/plugins/<id>/storage`（删掉 storage.json），或者手动删 `data/plugins/<id>/`。
- **导出**：`GET /api/plugins/<id>/storage` → `{ ok:true, data:{...} }`；旧版 UI 有「导出数据」按钮下载 JSON。
- **并发**：宿主对同一个插件的 storage 有内存缓存，写文件用 `writeFile`（没有原子替换）。同时跑多个实例/手动改文件时可能互相覆盖；玩家单实例使用没问题。
- **权限撤销时**：`get/all` 会收到 reject，`set` 静默丢弃。插件应该像模板那样 try/catch，并在日志里说清楚。

---

## 7. 生命周期与状态

| 状态 | 含义 |
|---|---|
| `stopped` | 未启用（初始状态；disable 后也是它） |
| `starting` | 子进程已 fork，等 `ready`（最多 5 秒） |
| `running` | 已就绪，开始收事件 |
| `error` | 启动失败：入口不存在、没有 `default` 函数、activate 抛错、ready 超时……此时子进程已被杀 |
| `crashed` | 运行中进程退出（`exited with <code>`）。**没有自动重启** |
| `unsupported` | 当前平台不支持（Android 独立包：不能 fork 子进程） |

要点：

- **改代码后**：停用再启用，新进程会重新 `import` 入口，代码改动生效。不要指望热重载。
- **启用失败/崩溃后想重试**：先 `disable` 再 `enable`。原因见 §14 的已知限制：状态 `error/crashed` 时 `enabled` 标志可能还是 `true`，直接再 enable 会直接返回旧状态而不重启。
- **改权限不需要重启**；**改清单/代码需要重启用**（清单变更甚至需要重启 server 才会被重新扫描）。
- 一个进程只跑一个插件；插件之间互不影响（除非恶意代码故意搞破坏）。

---

## 8. 本地调试

### 8.1 用临时数据目录起一个开发实例

永远不要拿真实 `data/` 试插件：

```powershell
cd 仓库根目录
$env:VRLINK_V2_DATA = "$env:TEMP\vl-plugin-dev"
$env:VRLINK_V2_PORT = "5399"
$env:VRLINK_FEDERATION_PORT = "0"      # 0 = 随机端口，避免和正在跑的实例抢 5275
node src/server.mjs
```

- `VRLINK_V2_PORT` 缺省 5274；`VRLINK_V2_HOST` 缺省 `127.0.0.1`。
- `VRLINK_FEDERATION_PORT` 不设时缺省 5275；开发实例建议设 `0`。
- 默认会种入演示角色（`lin_wan` 等）；不想种入可设 `VRLINK_SEED_DEMO=0`。
- 如果设置了 `VRLINK_V2_TOKEN`，所有 API 都要加 `Authorization: Bearer <token>`；本地开发通常不设。

### 8.2 用 curl 走一遍

```powershell
# 1) 看插件列表：确认 template / hello-event 出现
curl.exe http://127.0.0.1:5399/api/plugins

# 2) 启用模板插件
curl.exe -X POST http://127.0.0.1:5399/api/plugins/template/enable

# 3) 对第一个角色说一句话（触发 message.received）
curl.exe -X POST http://127.0.0.1:5399/api/characters/lin_wan/chat `
  -H "content-type: application/json" -d '{"text":"测试一下"}'

# 4) 看事件流：应能找到 [模板] 开头的 message.sent
curl.exe "http://127.0.0.1:5399/api/characters/lin_wan/events?limit=20"

# 5) 撤销 messages.send，再发消息 → 插件不再回，宿主日志出现 send denied
curl.exe -X PUT http://127.0.0.1:5399/api/plugins/template/permissions `
  -H "content-type: application/json" -d '{"permissions":["events.read","storage"]}'

# 6) 看 storage：撤销发送不影响计数
curl.exe http://127.0.0.1:5399/api/plugins/template/storage

# 7) 停用
curl.exe -X POST http://127.0.0.1:5399/api/plugins/template/disable
```

> PowerShell 里 `curl` 是 `Invoke-WebRequest` 的别名，JSON 引号会被吃。用 `curl.exe`（如上），或者用 `Invoke-RestMethod -Method Post -ContentType application/json -Body '...'`。

### 8.3 在哪里看插件日志

- `api.log()`、`console.log`、`console.error` 全部进宿主进程的 stdout/stderr，前缀 `[plugin:<id>]`。
- 开发实例直接看终端即可；后台启动时重定向到文件再 `Get-Content -Wait`。
- 事件处理抛错：宿主记录 `[plugin:<id>] <错误>`，插件进程**不会**因此退出。

### 8.4 不写 UI 也能造事件

| 请求 | 产生的事件 |
|---|---|
| `POST /api/characters/<id>/chat` | `message.received`（body=desktop, thread=main, visibility=private） |
| `POST /api/characters/<id>/simulate` | `message.received`（body/thread/visibility 可指定，模拟 QQ 群） |
| `POST /api/characters/<id>/draft` | `message.received` + 角色的 `message.draft` |
| `POST /api/characters/<id>/events` | 直接投递一条自定义事件（高级用法，字段要符合 `contracts.mjs`） |

### 8.5 调试检查单

1. `/api/plugins` 里有没有你的 id？没有 → 看宿主启动日志里的 `[plugin] skip ...`（多半是 JSON/字段/权限名错）。
2. `enabled` 是不是 true、`status` 是不是 `running`？不是 → 先 disable 再 enable，看返回的 `error`。
3. 有没有事件进来？先确认插件有 `events.read`，且没开安全模式。
4. 有没有发出去？看权限 `granted` 是否含 `messages.send`，角色同意是否还在，宿主日志有没有 `send denied` / `send failed`。
5. storage 读写失败？看 `storage` 权限和宿主日志里的 timeout。

---

## 9. 打包（`tools/plugin-pack.mjs`）

### 9.1 用法

```powershell
cd 仓库根目录
node tools/plugin-pack.mjs plugins/_template --out dist/template-0.1.0.zip

# 等价写法（package.json 里的脚本，参数要放在 -- 后面）
npm run pack:plugin -- plugins/_template --out dist/template-0.1.0.zip
```

不写 `--out` 时，默认输出到当前目录的 `<id>-<version>.zip`。
`--json` 输出机器可读结果。退出码：`0` 成功；`2` 校验/用法错误；`1` 其他错误。

真实输出（本仓库模板插件，输出路径可自定义；SHA256 只取决于包内容）：

```
✔ 校验通过：template 0.1.0（3 个文件）
✔ 打包完成：仓库根目录\dist\template-0.1.0.zip
  大小：3424 字节
SHA256: 101ca43794ba7d0cb3a819eb0f9f21d649af12da26027ea8412acaa8386a0d09
```

### 9.2 它校验什么

| 检查 | 失败时的提示（退出码 2） |
|---|---|
| `plugin.json` 存在、是合法 JSON | `找不到 plugin.json：...` / `plugin.json 不是合法 JSON：...` |
| 必填字段/枚举/semver/id 格式（复用宿主 `validatePluginManifest`） | `plugin.json 校验失败：plugin.name required` 等 |
| 权限必须在 9 个白名单里 | `未知权限：xxx。允许的权限只有：...` |
| `entry` 必须是插件目录内的安全相对路径 | `plugin.json 的 entry 不安全：...` |
| `entry` 指向的文件必须真的在包里 | `plugin.json 的 entry「index.mjs」不在打包文件里` |
| 拒绝 `../`、绝对路径、盘符、反斜杠、控制字符 | `文件路径 ... 不安全：...` |
| 拒绝符号链接 | `拒绝打包符号链接：...` |
| 拒绝可执行文件：扩展名 + 魔数（MZ/ELF/Mach-O/Java class/shebang） | `拒绝打包可执行文件：xxx.exe（...）` |
| 限制：单文件 ≤ 16 MB、总计 ≤ 32 MB、≤ 256 个文件 | `单个文件过大：...` 等 |

### 9.3 ZIP 细节

- 纯 Node 自带模块（`node:zlib`）实现，无第三方依赖；
- deflate（method 8），压不动时退回 stored（method 0）；UTF-8 文件名；无 ZIP64、无加密、无注释；
- **确定性输出**：文件按名字排序，时间戳固定为 1980-01-01。同样内容打两次，SHA256 完全一致（测试里锁死了这一点）；
- 产物已被仓库内 ZIP 读取器（`src/import/zip.mjs`）读回验证，标准 zip 工具也能打开。

### 9.4 给别人的包附上 SHA256

```powershell
Get-FileHash .\dist\template-0.1.0.zip -Algorithm SHA256
# Linux/macOS: sha256sum template-0.1.0.zip
```

> 打包工具是“格式/清单校验器”，**不是安全扫描器**：它不读你的 JS 逻辑，不查依赖，不判断插件是否恶意。SHA256 只能证明“文件没变”，不能证明“作者可信”。

---

## 10. 安装 / 更新 / 卸载 / 分享

### 10.1 安装（当前没有自动安装器）

1. 停掉正在跑的 v2 server；
2. 把 zip 解压到 `仓库根目录\plugins\<目录名>\`（目录里有 `plugin.json`）：

   ```powershell
   Expand-Archive -Path .\template-0.1.0.zip -DestinationPath .\plugins\my-plugin -Force
   ```

3. 重新启动 `node src/server.mjs`（宿主只在启动时扫描插件目录）；
4. v2 UI「插件」页点「启用」，或在 `/legacy` 里逐项确认权限；
5. 对第一个角色说句话，确认插件按预期工作。

当前 v2 **没有**插件市场/工坊/上传接口，也没有签名校验和自动更新。分享方式就是：zip + SHA256 + README，让对方手动安装。

### 10.2 更新

1. 先「停用」插件；
2. 用新目录覆盖 `plugins/<目录名>/`；
3. 重启 server（清单可能变了）；
4. 重新「启用」；如果新版本加了权限，需要重新勾选。

storage 和已授权权限按 `id` 保留；清单里删掉的权限会在下次启动时自动过滤。

### 10.3 卸载

1. 「停用」插件；
2. 删除 `plugins/<目录名>/`；
3. 重启 server；
4. 需要的话清数据：`DELETE /api/plugins/<id>/storage`，或手动删 `data/plugins/<id>/`。

`data/plugins/permissions.json` 里残留的授权记录不会造成危害；同 id 重装时会继续生效（注意这一点）。

### 10.4 分享前的自查

- [ ] 清单 `id` 唯一、`name/description` 说清楚插件干什么；
- [ ] 权限只留真正需要的（尤其 `messages.send`）；
- [ ] 入口不读 `data/`、不写插件目录之外；
- [ ] 不把 API Key / token / 本机路径写进代码；
- [ ] 用临时数据目录跑过一遍（§8）；
- [ ] `node tools/plugin-pack.mjs ...` 通过，记下 SHA256；
- [ ] README 写清楚：做什么、要什么权限、怎么停用、已知限制。

---

## 11. API 速查

| 方法 | 路径 | 作用 |
|---|---|---|
| GET | `/api/plugins` | 列表：id/name/version/type/risk/permissions/granted/capabilities/enabled/status/error + permissionInfo 中文描述 |
| POST | `/api/plugins/<id>/enable` | 启用（启动子进程，等 ready） |
| POST | `/api/plugins/<id>/disable` | 停用（发 shutdown，300ms 后 kill） |
| GET | `/api/plugins/<id>/permissions` | 看清单声明与已授权 |
| PUT | `/api/plugins/<id>/permissions` | 设置已授权子集（body: `{ "permissions": [...] }`） |
| GET | `/api/plugins/<id>/storage` | 导出 storage（`{ ok, data }`） |
| DELETE | `/api/plugins/<id>/storage` | 清空 storage（不可恢复） |
| POST | `/api/safe-mode` | 打开安全模式 + 停用所有插件 |
| POST | `/api/safe-mode/off` | 关闭安全模式（不自动重启用插件） |

`GET /api/plugins` 单条示例：

```json
{
  "id": "template",
  "name": "插件模板",
  "version": "0.1.0",
  "type": "code",
  "risk": "low",
  "permissions": ["events.read", "messages.send", "storage"],
  "granted": ["events.read", "messages.send", "storage"],
  "capabilities": [],
  "enabled": true,
  "status": "running",
  "error": null,
  "permissionInfo": [
    { "permission": "events.read", "description": "读取事件" },
    { "permission": "messages.send", "description": "发送消息" },
    { "permission": "storage", "description": "使用自己的存储" }
  ]
}
```

---

## 12. 失败排查表

| 现象 | 可能原因 | 怎么办 |
|---|---|---|
| `/api/plugins` 里没有我的插件 | 目录在 `plugins/` 下但不是一层；目录名以 `.` 开头；`plugin.json` 缺失/JSON 坏；字段校验失败；权限名不在白名单 | 看 server 启动日志 `[plugin] skip ...: <原因>`；修完重启 server |
| 启用返回 `plugin ready timeout` | 5 秒内没 `ready`：入口 import 慢/死循环/顶层 await 卡住/activate 抛错 | 修入口；先看 `status/error`；disable 后再 enable |
| 启用返回 `plugin must export default activate(api)` | 没有 `export default function` | 按 §3.1 改 |
| `status: "crashed"` | 插件进程自己退出/被 kill/顶层未捕获异常 | 看宿主日志；修代码；disable → enable 重启（不会自动重启） |
| 启用成功但收不到事件 | 没给 `events.read`；开了安全模式；插件是 `stopped` 不是 `running` | 检查 `granted`；关安全模式；看状态 |
| 收到事件但发不出消息 | 没给 `messages.send`；角色同意被撤销；`characterId/text` 为空 | 看宿主日志 `send denied` / `send failed`；补权限/同意；检查参数 |
| `storage get timeout` | 宿主繁忙/文件系统慢；一次 handler 里并发太多 storage 调用 | 减少调用；handler 控制在 3 秒内 |
| `no storage permission` | `storage` 被撤销 | 重新授权；代码里 try/catch |
| 改了代码但行为没变 | 插件还开着旧进程 | 停用→启用（新进程重新 import） |
| 改了 `plugin.json` 但列表没变 | 宿主只在启动时扫描 | 重启 server |
| 权限改了但插件还用旧 `api.permissions` 判断 | `api.permissions` 是启用时快照 | 代码里不要用它做运行时判断 |
| 端口被占用 | 已有实例在跑 5274/5399/5275 | 换 `VRLINK_V2_PORT`/`VRLINK_FEDERATION_PORT`，或先停旧实例 |
| 打包报“未知权限” | 权限名拼错/写了自定义权限 | 只能从 §5 的 9 个里选 |
| 打包报“拒绝可执行文件” | 包里有 `.exe/.bat/...`，或文件头是 MZ/ELF，或以 `#!` 开头 | 删掉；脚本不要带 shebang |
| 打包报“entry 不安全/不在打包文件里” | entry 写了 `../`、绝对路径，或指向了没被打包的文件 | 改成目录内相对路径，确认文件存在 |

---

## 13. 安全边界（实话）

### 13.1 宿主**确实**做了的

- **进程隔离**：每个插件一个 `fork` 子进程；插件崩溃/退出不会让宿主进程退出（宿主会把状态标成 `crashed`）。
- **清单校验**：必填字段、id 格式、类型枚举、版本格式、权限白名单；不合格的插件不加载。
- **入口约束**：扫描时校验 `entry` 必须留在插件目录内（realpath 防 `../`、绝对路径、符号链接逃逸），且必须是存在的普通文件；不合格的插件整个跳过。
- **权限过滤（三条通道）**：
  - 没 `events.read` → 不推送事件；
  - 没 `messages.send` → `api.send` 被宿主丢弃并记日志；
  - 没 `storage` → `storage.get/all` 拒绝、`set` 忽略。
- **同意门**：`messages.send` 还要过角色同意。
- **审计**：经能力总线发出的消息会写入目标角色的 `audit/audit.jsonl`，带 `plugin:<id>` 原因。
- **安全模式**：一键停用所有插件并停止事件分发。
- **打包工具**：发布前拦截路径穿越、符号链接、可执行文件、未知权限（只对走这个工具的包有效）。

### 13.2 宿主**没有**做、也不该被当成做了的

- ❌ **不是 OS 沙箱**：子进程没有 Node 权限模型（没传 `--permission`）、没有容器、没有 seccomp、没有文件/网络限制。
- ❌ **插件代码可以直接用 Node 的一切**：`import fs` 读宿主账号能读的任何文件、`import http` 联网、`child_process` 再开进程、`process.kill` 杀宿主进程。
- ❌ **插件继承宿主全部环境变量**：如果宿主用环境变量放了 `VRLINK_V2_TOKEN`、`VRLINK_BRAIN_API_KEY` 等，插件进程能读到。Key 只放环境变量是给“不装插件”的场景用的；装了不可信插件就等于把 Key 暴露给它。
- ❌ **插件能读 `data/`**：角色、事件日志、密钥文件都在同用户可读范围。权限表管不到直接 `fs`。
- ❌ **没有签名/哈希校验**：宿主不校验插件目录和 zip 的来源；SHA256 只是给你人工核对的。
- ❌ **没有代码扫描**：打包工具不分析 JS 行为。
- ❌ **进程隔离不防恶意**：它只防“插件写崩了”。恶意插件可以读你的数据、联网外发、甚至杀掉宿主进程（同用户权限）。

### 13.3 给玩家的建议

- **只装你看过代码的插件**；不认识的包先解压读一遍 `index.mjs`。
- 优先在**临时数据目录**里试跑（§8），确认行为再装进真实 `data/`。
- 权限逐项收：不需要 `messages.send` 就别给；不需要就停用。
- 不要在有敏感环境变量（API Key、token）的宿主上装不可信插件。
- 分享时附 SHA256；安装前用 `Get-FileHash` 核对。
- **本文不承诺“绝对安全”**。v2 的插件体系是“给愿意承担风险的玩家用的扩展口”，不是应用商店级沙箱。

---

## 14. 已知限制（v2 当前）

1. **没有自动安装/卸载/热加载**：装/删/改清单都要重启 server；改代码要停用→启用。
2. **没有插件市场/提交入口/签名/自动更新**：目前只能本地目录 + zip 分享。
3. **没有自动重启**：插件崩溃后停在 `crashed`，要手动 disable→enable。
4. **`error`/`crashed` 时 `enabled` 可能仍为 true**：直接 `enable` 会返回旧状态而不重启（`PluginHost.enable` 的早退分支）。必须 `disable` 再 `enable`。这是当前实现的已知怪癖。
5. **`type` 除 `code` 外没有专属执行语义**：`panel/adapter/brain/device` 只是清单占位，宿主一样会 fork+加载入口，但没有任何对应 API。
6. **6 个权限名是空声明**：`memory.read`、`memory.write`、`capabilities.invoke`、`network.lan`、`network.internet`、`devices.command`——申请了也没有对应 API，且不构成限制。
7. **事件不重放、不按角色隔离**：启用前的事件看不到；`events.read` 能看所有角色。
8. **单事件 3 秒、storage 3 秒、启动 5 秒**：长任务要自己拆/异步，别卡 handler。
9. **`api.send` 无回执**：失败只能看宿主日志，插件代码拿不到错误。
10. **storage 无大小/并发保护**：不要写超大对象；多实例同时写可能互相覆盖。
11. **Android 独立包不支持代码插件**：`nodejs-mobile` 不能 fork 子进程，`enable` 会返回 `status: "unsupported"`。桌面版（Windows/Linux/macOS）可用。
12. **插件能看到所有角色的消息**：`events.read` 是全局权限，不是“只授权给某条鱼”。
13. **审计只覆盖经能力总线的消息**：storage 写入、事件读取、插件直接 `fs`/网络操作都不在审计里。

---

## 15. 验证记录（本仓库实测）

### 15.1 测试

```powershell
cd 仓库根目录
node --test tests/plugin-pack.test.mjs
```

结果：`9/9 pass`（合法打包、模板打包、缺字段、未知权限、路径穿越、可执行文件、zip 往返、CLI 成功/失败、权限白名单一致）。

全量回归：

```powershell
node --test tests/*.test.mjs
# 本次实测：87/87 全绿
# 其中本任务新增 9 项（基线 66 + 本任务 9 + 并行任务的入口护栏/迁移等 12 项）
```

> 全量数量会随仓库并行任务变化；关键是 `fail 0`。本任务自己的 9 项始终可用 `node --test tests/plugin-pack.test.mjs` 单独跑。

### 15.2 端到端（临时 data，不碰真实数据）

环境：`VRLINK_V2_DATA=%TEMP%\vl-plugin-e2e\data`，`VRLINK_V2_PORT=5399`，`VRLINK_FEDERATION_PORT=0`，仓库自带 `plugins/_template` 与 `plugins/hello-event`。

`GET /api/plugins`（节选）：

```json
{
  "plugins": [
    { "id": "template", "name": "插件模板", "permissions": ["events.read","messages.send","storage"], "granted": ["events.read","messages.send","storage"], "enabled": false, "status": "stopped" },
    { "id": "hello-event", "name": "最小事件示例", "permissions": ["events.read"], "granted": ["events.read"], "enabled": false, "status": "stopped" }
  ]
}
```

`POST /api/plugins/template/enable`：

```json
{ "ok": true, "plugin": { "id": "template", "enabled": true, "status": "running" } }
```

发消息后事件流里出现：

```text
[模板] 我收到第 1 条消息了。
```

`PUT /api/plugins/template/permissions` 撤销 `messages.send`：

```json
{ "ok": true, "permissions": { "id": "template", "manifest": ["events.read","messages.send","storage"], "granted": ["events.read","storage"] } }
```

再次聊天：插件回复数保持 1（没有新增），宿主日志出现：

```text
[plugin:template] send denied (no messages.send)
```

同时 storage 继续计数（撤销发送不影响 storage）：

```json
{ "ok": true, "data": { "received": 2 } }
```

恢复 `messages.send` 后再聊天，回复数变为 2，最新一条是第 3 条；`disable` 后再聊天，回复数不再增加；`POST /api/safe-mode` 返回 `{ "safeMode": true, "disabled": ["hello-event"] }`。

---

## 16. 相关文件

- 模板插件：`plugins/_template/`（`plugin.json` + `index.mjs` + `README.md`）
- 最小示例：`plugins/hello-event/`（只有 `events.read`）
- 打包工具：`tools/plugin-pack.mjs`（npm script：`npm run pack:plugin -- <插件目录>`）
- 打包测试：`tests/plugin-pack.test.mjs`
- 入口护栏：`src/plugin-manifest.mjs` 的 `readPluginManifest()`（含 entry realpath 校验）+ `tests/plugin-entry-guard.test.mjs`
- 宿主实现：`src/plugin-host.mjs`、`src/plugin-worker.mjs`、`src/plugin-manifest.mjs`、`src/contracts.mjs`
- API 端点：`src/server.mjs` 中搜 `/api/plugins`
- 早期（v1）插件文档：`旧 v1 文档目录\PLUGIN_API.md`、`PLUGIN_AUTHORING.md`、`SECURITY_PLUGINS.md`（**和 v2 的 `plugin.json` 体系不同，不要混用**）

---

*最后更新：2026-11-08 · VRlink v002 0.2.0 · apiVersion 1*

