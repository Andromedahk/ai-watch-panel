# 助手图片

当前默认图片为用户提供的五张 SVG、一张 ICO 和两张 PNG，随对应模块支持一同打包和同步；SVG 支持 HiDPI，ICO 由系统选择合适的内嵌尺寸。ZCode 的默认黑色图形在深色外观下由样式转换为白色，不修改原文件或自选图片。

可替换对应文件为自己的视觉素材，或在应用配置中选择 PNG、JPG、WebP 图片。配置中选择的图片只保存在本机应用数据中，不会写入仓库或上传。

| 工具 | 默认文件 |
| --- | --- |
| Claude Code | `Claude.svg` |
| Codex | `Codex.svg` |
| Antigravity | `Antigravity.svg` |
| DeepSeek Harness | `DeepSeek.ico` |
| ZCode | `Zcode.svg` |
| Kimi Code | `Kimi.png` |
| Qwen（千问） | `Qwen.svg` |
| WorkBuddy | `WorkBuddy.png` |

如需更改文件类型，同时更新 `src/data.ts` 中的相对文件名。此目录是 Vite 的公共资源目录，构建时复制到输出根目录。
