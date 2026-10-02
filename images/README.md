# 助手图片

当前默认图片为用户提供并批准同步的三张 SVG 与一张 ICO，随构建打包；SVG 支持 HiDPI，ICO 由系统选择合适的内嵌尺寸。

可替换对应文件为自己的视觉素材，或在应用配置中选择 PNG、JPG、WebP 图片。配置中选择的图片只保存在本机应用数据中，不会写入仓库或上传。

| 工具 | 默认文件 |
| --- | --- |
| Claude Code | `Claude.svg` |
| Codex | `Codex.svg` |
| Antigravity | `Antigravity.svg` |
| DeepSeek Harness | `DeepSeek.ico` |

如需更改文件类型，同时更新 `src/data.ts` 中的相对文件名。此目录是 Vite 的公共资源目录，构建时复制到输出根目录。
