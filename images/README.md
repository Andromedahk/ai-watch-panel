# 助手图片

当前四张 SVG 是界面占位图。图片随构建打包并在 HiDPI 显示器上保持清晰。

可替换对应文件为自己的视觉素材，或在应用配置中选择 PNG、JPG、WebP 图片。配置中选择的图片只保存在本机应用数据中，不会写入仓库或上传。

| 工具 | 默认文件 |
| --- | --- |
| Claude Code | `claude.svg` |
| Codex | `codex.svg` |
| Antigravity | `antigravity.svg` |
| DeepSeek Harness | `deepseek.svg` |

如需更改文件类型，同时更新 `src/data.ts` 中的相对文件名。此目录是 Vite 的公共资源目录，构建时复制到输出根目录。
