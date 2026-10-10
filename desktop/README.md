# 桌面版打包说明（Electron 套壳）

这个目录把仓库根目录的**零依赖静态站点**（`index.html` + `assets/` + `src/`）
套进一个 Electron 壳，产出 Windows 可双击运行的 `.exe`。

> 应用本体没有被修改。这里只新增打包外壳，`../index.html`、`../assets`、`../src`
> 仍是唯一的事实来源——修 bug、加功能照旧改根目录的文件，重新构建即可。

## 产物

| 文件 | 说明 |
| --- | --- |
| `dist/ShuangpinPractice-<版本>-portable.exe` | **单文件便携版**，约 71 MB，双击即用，不安装、不写注册表 |

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
| 体积 | 约 0（就是源码） | 约 71 MB |

两者**读取的是同一份静态资源，练习记录各自独立**
（`.bat` 走 `http://127.0.0.1:8781` 的 localStorage；桌面版走 `app://local` 的 localStorage）。
从 `.bat` 切换到桌面版，**原有练习记录不会自动带过去**。

## 已知事项

- 应用图标未设置，exe 使用 Electron 默认图标。要换图标：放入 `build/icon.ico`
  （256×256），并移除 `signAndEditExecutable: false` 后用管理员权限构建。
- 仅提供 x64；如需 arm64 / ia32，在 `win.target` 的 `arch` 中追加。
- 未做代码签名，首次运行 Windows SmartScreen 可能提示「未知发布者」。
