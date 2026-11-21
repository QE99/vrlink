# 插件模板（`_template`）

这是一个**真的能被宿主编译/加载/运行**的最小 VRlink v2 插件。它做三件事：

1. 用 `events.read` 订阅事件，只在收到 `message.received` 时继续；
2. 用 `storage` 在自己的存储里记「收到第几条」；
3. 用 `messages.send` 回一条 `[模板] 我收到第 N 条消息了。`

> 目录名以下划线开头只是习惯（方便和正式插件区分）；宿主只跳过 `.` 开头的目录，所以本目录会被当成普通插件，清单里的 `id` 是 `template`。

## 目录结构

```
plugins/_template/
├── plugin.json   # 清单（必填）
├── index.mjs     # 入口（默认 export 一个 activate 函数）
└── README.md     # 说明（会被打进 zip）
```

## 从模板开始写自己的插件

1. 把整个 `_template` 目录复制成 `plugins/my-plugin/`（不要直接改模板本身）；
2. 编辑 `plugin.json`：
   - 改 `id`（唯一，小写字母/数字/`-`/`_`，2–41 字符）
   - 改 `name`、`description`、`version`
   - 只保留你真正需要的 `permissions`
3. 编辑 `index.mjs` 里的 `activate(api)`；
4. 在 http://127.0.0.1:5274/ 的「插件」页启用，或：

```powershell
curl.exe -X POST http://127.0.0.1:5274/api/plugins/my-plugin/enable
```

## 调试

用临时数据目录起一个独立实例，不要动真实的 `data/`：

```powershell
cd <repo>
$env:VRLINK_V2_DATA = "$env:TEMP\vl-plugin-dev"
$env:VRLINK_V2_PORT = "5399"
$env:VRLINK_FEDERATION_PORT = "0"
node src/server.mjs
```

`api.log(...)`、插件 stdout/stderr 都会打在宿主控制台，前缀是 `[plugin:template]`。

## 打包

```powershell
node tools/plugin-pack.mjs plugins/my-plugin --out dist/my-plugin-0.1.0.zip
```

工具会校验清单、权限白名单、路径穿越和可执行文件，打印 zip 的 SHA256。

## 安全提醒

装代码插件 = 信任作者。宿主会做进程隔离和权限过滤，但**不是强沙箱**：插件进程理论上可以用 Node 的 `fs`、`http` 等模块碰宿主账号能碰的东西。只装你看过代码的插件。

完整字段与权限说明见 `docs/PLUGIN_API_V2.md`。
