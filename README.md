# VRlink v002（0.6.6）

**一个意识，多个身体。** 本地优先的 AI 运行时：一个 AI 有身份、记忆、状态和能力边界；它住在你的电脑里，不登录、不云同步、没有遥测。

> **状态**：0.6.6 源码 / Windows 安装版。V2 是组网强化版，不是“另一个完全不同的产品”，也不是 V1 的“阉割版”。
> 源码与说明书：https://github.com/QE99/vrlink 。本仓库只放源码 + 使用说明；安装包/国内镜像后续发布。

## 下载

| 安装包 | 大小 | 说明 |
|---|---:|---|
| `VRlink-v0.6.6-Lite-setup.exe` | 约 24 MB | VRlink 本体 + node.exe + 启动器；默认 mock，可 BYOK/自接本地 llama-server |
| `VRlink-v0.6.6-Standard-setup.exe` | 约 1.1 GB | 在 Lite 基础上自带 llama-server + Qwen2.5-1.5B，可离线跑本地模型 |
| `VRlink-v0.6.6-Downloader-setup.exe` | 约 24 MB | 在 Lite 基础上带“下载本地模型”脚本；首次运行再下载运行时/模型 |

安装包默认装到 `%LOCALAPPDATA%\Programs\VRlink`，按用户安装，不需要管理员权限；卸载默认保留 `data\`。
安装包暂不随本仓库分发；国内下载渠道后续补齐。源码在本仓库，代码 MIT。

## 源码运行

要求：Windows 10/11 x64、Node.js >= 22。

```powershell
npm ci
npm start
# http://127.0.0.1:5274
```

常用命令：

```powershell
npm test          # 122/122
npm run e2e       # 端到端彩排
npm run accept:m1 # 双节点直连验收
npm run accept:m2 # 离线驿站验收
npm run federation -- status|card|connect|tank|chat|revoke
npm run courier   # 自建驿站
npm run mcp       # MCP server
npm run acp       # ACP server
npm run pack:plugin -- plugins/my-plugin --out dist/my-plugin.zip
```

源码运行默认 `VRLINK_EDITION=dev`，会 seed 一个演示角色；种子/安装版由启动器设置 `VRLINK_EDITION=seed`，不塞演示角色。

## 本地模型

V2 的 `local` 大脑调用 OpenAI 兼容的 llama-server，默认 `http://127.0.0.1:12345`。

- Standard 安装包：开始菜单「VRlink（本地模型）」→ 启动 `llama-server` + `VRlink`；新建 Agent 时大脑选 `local`。
- Downloader：先运行「下载本地模型」→ 下载运行时/模型 → 自动启动。
- 源码：自备 `llama-server.exe` + GGUF，设置 `VRLINK_LOCAL_BASE_URL` / `VRLINK_LOCAL_MODEL`，再启动 `VRlink`。

## 目录

```text
src/       Hub、角色运行时、事件日志、联邦/组网、插件、设备、AGI 接口
ui/        wx.html/css/js（分层界面）、guest、icon、vendor/jsqr、sfx
tools/     验收、迁移、插件打包、发布清单、驿站
tests/     Node test + fixtures（122 项）
plugins/   插件模板/示例
docs/      PLUGIN_API_V2.md、使用说明
launcher/  Windows 启动器 C# 源码 + WebView2 DLL + 构建脚本
```

## 组网

- 界面端口 `5274`，组网端口 `5275`；默认只监听 `127.0.0.1`。
- 「我 → 一键组网」把组网监听切到 `0.0.0.0`；或启动时加 `-Lan`（会同时开放界面/API 到局域网，仅限可信网络）。
- 跨网络用 Tailscale / WireGuard / 反向代理；本版本没有 TLS、没有 NAT 穿透，不要把 5275 直接暴露公网。
- 没有官方中心服务器；好友/群是节点之间直连，SAS 防中间人。

## 数据与隐私

- 数据在安装目录 `data\`：节点身份私钥、角色、事件、记忆、人-人消息、好友/群、授权。
- 默认本机；没有账号、没有遥测；云端 API 只在显式配置 BYOK 时使用。
- `data\` 和备份含私钥，不要上传网盘、不要发群。
- 卸载默认保留 `data\` 和 `backups\`；要彻底删除请手动删。

## 安全边界

- 插件是子进程 + 权限过滤 + 审计，**不是强沙箱**；装代码插件 = 信任作者。
- 高风险设备动作需要本机批准；安全模式会停插件、拦设备。
- `-Lan` 当前默认不生成访问 token，同网段的人可能直接打开界面；只在可信网络使用，或自行加反向代理/鉴权。
- 没有 DRM/在线激活；官方包免费；第三方付费安装/支持与官方无关。

## 许可

- 代码与文档：**MIT**，见 [`LICENSE`](LICENSE)。
- 名称/Logo/官方身份：不随 MIT 授权，见 [`TRADEMARK.md`](TRADEMARK.md)。
- 游戏内容（剧本/美术/音乐/角色）：专有，不在本仓库，见 [`CONTENT-LICENSE.md`](CONTENT-LICENSE.md)。
- 第三方组件/素材：见 [`THIRD_PARTY_NOTICES.md`](THIRD_PARTY_NOTICES.md)。
- **不包含 Steamworks SDK**；Steam 构建单独隔离，只有 `redistributable_bin` 可按 Valve 条款分发。
- 不包含模型权重；模型按各自许可证分发。

## 文档

- [`docs/PLUGIN_API_V2.md`](docs/PLUGIN_API_V2.md) — 插件 API（apiVersion 1）
- `docs/VRlink-使用说明.pdf` — Windows 安装/使用说明
- [`launcher/README.md`](launcher/README.md) — Windows 启动器源码/构建
