# 桌面版打包说明（Electron 套壳）

这个目录把仓库根目录的**零依赖静态站点**（`index.html` + `assets/` + `src/`）
套进一个 Electron 壳，产出 Windows 可双击运行的 `.exe`。

> 应用本体没有被修改。这里只新增打包外壳，`../index.html`、`../assets`、`../src`
> 仍是唯一的事实来源——修 bug、加功能照旧改根目录的文件，重新构建即可。

## 产物

| 文件 | 说明 |
| --- | --- |
| `dist/ShuangpinPractice-<版本>-portable.exe` | **单文件便携版**，约 65 MB，双击即用，不安装、不写注册表 |

### 关于这 65 MB

体积几乎全部来自 Electron 运行时，**跟应用代码无关**：

| 组成 | 未压缩体积 | 能否优化 |
| --- | --- | --- |
| `双拼练习.exe`（Electron：V8 + Chromium + Node） | 181 MB | ❌ 硬依赖 |
| `icudtl.dat`（Unicode 数据） + 图形 DLL（swiftshader / GLES / d3dcompiler） | ~31 MB | ❌ 硬依赖 |
| `locales/` 语言包 | 41 MB → **~1 MB** | ✅ 已只留 `zh-CN` / `en-US` |
| **应用本体**（`index.html` + `assets/` + `src/`） | **约 0.8 MB** | — |

也就是说：**你写的代码只占不到 1 MB，其余 99% 是「让网页变成桌面程序」所必需的浏览器内核。**
这条路（Electron）的体积下限就在 60 MB 量级，已经接近了。

想再小一个数量级只能换技术路线，但都有明显代价：

- **Tauri**（系统 WebView + Rust）：约 3–10 MB，但依赖系统 WebView2，
  且 Windows 10 以前 / 精简系统上可能缺失，需引导用户另装 —— 与本项目
  「零依赖、打开即用」的定位相冲突。
- **原地保留 `.bat` 方式**：0 MB，但要求机器上有 Python / Node / PowerShell。

当前选择（Electron）是为了**「双击就能用、不要求用户装任何东西」**这个目标付出的代价。

## 构建

```bash
cd desktop
npm install          # 首次
npm run build        # 产出 dist/ShuangpinPractice-<版本>-portable.exe
```

其他目标：

```bash
npm run build:dir        # 只产出 dist/win-unpacked/（调试用，最快）
npm run build:installer  # NSIS 安装包（需签名工具解压权限，见下）
```

## 为什么要 `signAndEditExecutable: false`

打包机上如果当前用户**没有创建符号链接的权限**（Windows 非管理员账户的默认状态），
electron-builder 下载的 `winCodeSign` 工具包会卡在解压 `darwin/*.dylib` 符号链接上而失败，
报错形如：

```
ERROR: Cannot create symbolic link : 客户端没有所需的特权 : ...\winCodeSign\...\libcrypto.dylib
```

本应用**不需要代码签名**，因此关闭该步骤即可绕过。若要加图标 / 正式签名：

1. 删掉 `package.json` 中 `win.signAndEditExecutable` 一行；
2. **以管理员身份**运行构建（或用组策略给账户授予 `SeCreateSymbolicLinkPrivilege`）。

## 与 `.bat` 启动方式的区别

| | `启动双拼练习.bat` | Electron 桌面版 |
| --- | --- | --- |
| 依赖 | 需 Python / Node / PowerShell 之一 | 无，全部打包在内 |
| 打开方式 | 浏览器标签页 | 独立应用窗口 |
| 体积 | 约 0（就是源码） | 约 65 MB（见上「关于这 65 MB」） |

两者**读取的是同一份静态资源，练习记录各自独立**
（`.bat` 走 `http://127.0.0.1:8781` 的 localStorage；桌面版走 `app://local` 的 localStorage）。
从 `.bat` 切换到桌面版，**原有练习记录不会自动带过去**。

## 已知事项

- 应用图标未设置，exe 使用 Electron 默认图标。要换图标：放入 `build/icon.ico`
  （256×256），并移除 `signAndEditExecutable: false` 后用管理员权限构建。
- 仅提供 x64；如需 arm64 / ia32，在 `win.target` 的 `arch` 中追加。
- 未做代码签名，首次运行 Windows SmartScreen 可能提示「未知发布者」。
