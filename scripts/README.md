# 材料生成

题库原文与逐字复核读音保存在 corpus-source.mjs，语境修正在 src/data/context-readings.js。
运行 `npm run corpus:generate` 更新静态题库，`npm run corpus:check` 检查生成结果。运行时不依赖注音库或网络。

新材料请先填写原文和 reading，标点保留空音节，与原文逐字对齐。编辑语境规则后重新生成；quality.mjs 对助词“地”和名词“地图/地方”使用独立预期检查。

聊天对话原文在 chat-source.mjs。先运行 `npm ci --prefix scripts` 安装锁定的开发依赖，再运行 `node scripts/generate-chat.mjs`。工具初标后仍需复核语境并补充独立预期。

开发依赖仅安装在 scripts/node_modules，不进入桌面包或静态网站。网页和桌面版均使用同一份 index.html、assets、src；版本通过 `_test/tools/bump_version.mjs` 统一修改。
