// 双拼练习 — 打包后裁剪（可选，opt-in）
//
// 只在设置了环境变量 SHUANGPIN_SLIM=1 时生效；默认构建**完全不受影响**。
//
// 用法（Git Bash / WSL / macOS / Linux）：
//     SHUANGPIN_SLIM=1 node_modules/.bin/electron-builder --win portable
// 用法（Windows cmd）：
//     set SHUANGPIN_SLIM=1 && node_modules\.bin\electron-builder --win portable
//
// ---------------------------------------------------------------------------
// 为什么要有这个文件
//
// Electron 会把整个 Chromium 运行时打进来，其中相当一部分本应用根本用不到：
// 本应用是纯文本练习器，不播音频/视频、不用 WebGL、不用 Vulkan，
// 而且桌面壳里已经关掉了 GPU 合成（见 main.cjs 的 disable-gpu-compositing）。
//
// 这些库即使被删掉，Chromium 也会在运行时**优雅降级**（软件渲染 / 不播媒体），
// 而不是崩溃。但这属于「理论成立、未在本机逐一验证」的改动 ——
// 所以它默认关闭，由使用者显式开启，并且**保留原始文件清单**便于回滚。
//
// 为什么不删 icudtl.dat（10 MB）和 LICENSES.chromium.html（8.8 MB）：
//   · icudtl.dat 是 ICU 数据，删掉会破坏 Intl / toLocaleDateString 等
//     （书架列表就用了 toLocaleDateString 显示「上次练习时间」）；
//   · LICENSES.chromium.html 是 Chromium 的许可证文本，分发时必须随附，
//     删掉是许可证问题，不是技术问题。
// ---------------------------------------------------------------------------

const fs = require('node:fs');
const path = require('node:path');

/**
 * 可安全删除的运行时组件。
 *
 * 每一项都注明「它是干什么的」与「删掉之后会失去什么」——
 * 将来有人想加一项进来时，能照着判断该不该加。
 */
const REMOVABLE = [
  {
    file: 'vk_swiftshader.dll',
    why: 'Vulkan 软件渲染器（SwiftShader）',
    lose: '无 GPU 时的 Vulkan 软件渲染。本应用不用 WebGL / 3D。'
  },
  {
    file: 'vk_swiftshader_icd.json',
    why: 'Vulkan 软件渲染器的驱动描述文件',
    lose: '同上。'
  },
  {
    file: 'vulkan-1.dll',
    why: 'Vulkan 加载器',
    lose: 'Vulkan 后端。本应用不用。'
  },
  {
    file: 'libGLESv2.dll',
    why: 'ANGLE —— 把 OpenGL ES 转到 D3D 的翻译层',
    lose: 'GPU 加速的 Canvas / WebGL。Canvas 会退回 CPU 软件渲染（本应用已禁用 GPU 合成）。'
  },
  {
    file: 'libEGL.dll',
    why: 'ANGLE 的 EGL 接口层',
    lose: '同上（与 libGLESv2 成对）。'
  },
  {
    file: 'd3dcompiler_47.dll',
    why: 'D3D 着色器编译器（ANGLE 用）',
    lose: '同上。ANGLE 移除后它没有使用者。'
  },
  {
    file: 'ffmpeg.dll',
    why: '音视频解码（Chromium 内置）',
    lose: '页面内播放音视频文件。本应用用 WebAudio 实时合成音效，不含任何媒体文件。'
  }
];

module.exports = async function afterPack(context) {
  if (process.env.SHUANGPIN_SLIM !== '1') return;

  const dir = context.appOutDir;
  let removed = 0;
  let bytes = 0;
  const gone = [];

  for (const item of REMOVABLE) {
    const target = path.join(dir, item.file);
    try {
      const st = fs.statSync(target);
      fs.unlinkSync(target);
      removed++;
      bytes += st.size;
      gone.push(`${item.file}（${(st.size / 1048576).toFixed(2)} MB）`);
    } catch (err) {
      if (err && err.code !== 'ENOENT') {
        // 删不掉不该让构建失败 —— 那会得到一个「构建成功但没裁剪」的包，
        // 比直接失败更难查。这里如实打印出来。
        console.warn(`[slim] 删除 ${item.file} 失败：${err.message}`);
      }
    }
  }

  if (removed) {
    console.log(`[slim] 已裁剪 ${removed} 个运行时组件，解包体积减少约 ${(bytes / 1048576).toFixed(2)} MB`);
    for (const g of gone) console.log(`[slim]   - ${g}`);
    console.log('[slim] 注意：这是实验性裁剪，请在目标机器上确认应用能正常启动与显示。');
  }
};
