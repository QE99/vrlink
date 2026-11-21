# 第三方组件与素材许可（v0.1）

> 适用：本仓库（VRlink V2 源码）。发布包（Windows 安装器 / Android APK）另含运行时与平台组件，见文末。
> 本文件是工作稿；上传/发版前逐项核对版本、许可证原文和署名。

## 1. 代码依赖

| 组件 | 版本 | 许可证 | 位置/说明 |
|---|---|---|---|
| qrcode | 1.5.4 | MIT | `package.json`；二维码生成 |
| qrcode 的传递依赖 | 见 `package-lock.json` | 22 个 MIT + 7 个 ISC | 含 `pngjs`、`dijkstrajs`、`yargs` 等；各包 license 文件随 npm 包分发 |
| jsQR | 见 `ui/vendor/jsqr.js` 头部 | Apache-2.0 | `ui/vendor/jsqr.LICENSE.txt`；本地二维码解码 |
| Microsoft WebView2 DLL | 2024 版 | Microsoft 再分发条款 | `launcher/lib/`；仅 Windows 启动器使用 |

> 说明：`qrcode` 及其传递依赖的完整版本/完整性哈希以 `package-lock.json` 为准。若发布二进制包，需在包内保留各依赖的 license 文件。

## 2. 界面音效

| 素材 | 许可证 | 位置/说明 |
|---|---|---|
| UI 音效 17 个 `.wav` | CC0-1.0 | `ui/sfx/sounds/manifest.json`；可商用、可再分发、不要求署名 |

> 注意：Android APK 的 `res/raw/notify.wav` 是另外一套通知铃声，日志标注为 **CC BY 4.0**（Wikimedia Commons，Gravity Sound）。它与 `ui/sfx` 不是同一套文件；在补齐作者/来源/许可链接前，不要把 APK 作为公开 Release 附件。

## 3. 本地模型（Standard 安装包）

| 模型 | 许可证 | 说明 |
|---|---|---|
| Qwen2.5-1.5B-Instruct-GGUF（q4_k_m） | Apache-2.0 | Standard 安装包自带；来源 ModelScope；文件 `qwen2.5-1.5b-instruct-q4_k_m.gguf`，SHA256 `6a1a2eb6d15622bf3c96857206351ba97e1af16c30d7a74ee38970e434e9407e` |

## 4. 发布包额外组件（不在源码仓库）

### Windows seed 包

- Node.js 24.18.0：MIT；包内 `node.exe` 为官方 Windows x64 构建。
- Microsoft WebView2 Runtime / WebView2 DLLs：按 Microsoft 的再分发条款；包内 `THIRD_PARTY_NOTICES.txt` 目前未提及，发版前补。
- `qrcode` / `pngjs` / `dijkstrajs`：MIT；包内已有 license 文件。

### Android APK

- Node.js / libnode：MIT 及其第三方组件；见 Node.js 分发许可证。
- React Native、react-native-webview：MIT。
- AndroidX / Kotlin 标准库等：Apache-2.0；APK 内已有部分 license 条目。
- `starlite-inochi2d`、`three` 等：见 APK 内 `assets/ui/vendor/...` 的 LICENSE/THIRD_PARTY 文件。
- `res/raw/notify.wav`：CC BY 4.0（Gravity Sound，Wikimedia Commons）；**必须先补署名**。
- APK 0.6.6 目前没有一份汇总的 `THIRD_PARTY_NOTICES.md`；发版前必须补。

## 5. 明确不包含

- **Steamworks SDK**：不在本仓库、不随源码分发；只有 `redistributable_bin/` 可按 Valve 条款随目标码分发。
- 模型权重（GGUF）：不随源码仓库分发；各模型按自己的许可证（Qwen 系 Apache-2.0、Gemma 按 Gemma Terms 等）。
- WebView2 Evergreen Runtime：不随源码仓库分发；安装包检测/提示用户安装。
- 游戏内容（剧本/美术/音乐）：不在本仓库；专有，见 `CONTENT-LICENSE.md`。

## 6. 发版检查单

- [ ] `package-lock.json` 与 `package.json` 版本一致
- [ ] qrcode 依赖 license 文件随包
- [ ] jsQR Apache-2.0 许可证副本
- [ ] UI sfx CC0 manifest
- [ ] Windows 包补 WebView2 声明
- [ ] APK 补 Node/RN/AndroidX/inochi2d/three + CC BY 4.0 铃声署名
- [ ] 不含 Steamworks SDK
- [ ] 不含未授权的游戏素材/模型权重
