# VRlink Windows 启动器（C# 源码）

`VRlink.cs` 是 Windows 安装包里的 `VRlink.exe` 源码：它负责：

- 启动本地 Hub（`node.exe app/src/server.mjs` 或随包的启动脚本）；
- 等待 `http://127.0.0.1:5274/api/health` 就绪；
- 用 WebView2 打开应用窗口；
- 托盘、关闭到托盘、`--stop` 停止。

## 依赖

- Windows 10/11 x64
- .NET Framework 4.x（系统自带）
- `lib/` 下的 Microsoft WebView2 DLL（随包，按 Microsoft 再分发条款）
- WebView2 Evergreen Runtime（Windows 11 通常自带；Windows 10 可能需要安装）

## 构建

```powershell
pwsh -File .\build-launcher.ps1
```

输出：`dist\VRlink.exe` + `dist\*.dll`。
如果本机只有 .NET Framework 的 `csc.exe` 且源码用了较新的 C# 语法，构建可能失败；
安装包里的 `VRlink.exe` 是预编译版本，源码用于审计/复现，不要求每个用户自己编译。

## 许可

启动器源码：MIT，见仓库根 `LICENSE`。
`lib/` 下的 WebView2 DLL 是 Microsoft 的再分发组件，见 `THIRD_PARTY_NOTICES.md`。
