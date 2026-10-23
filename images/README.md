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

## 二次元图片

`anime` 内的默认素材为七张用户提供并批准同步的 PNG，以及一张使用 Codex 内置 imagegen 制作的 WorkBuddy 原创立绘 PNG。WorkBuddy 的来源分类为 `generated-edit`，不是官方角色或官方素材；设计、原生尺寸、文件摘要和最终编辑提示词见[素材说明](../docs/WORKBUDDY-ART.md)。旧 `workbuddy.svg` 保留作历史素材，已不作为默认头像。

原文件保持不变，界面按用途等比缩放并裁成脸部头像或半身像。内置角色有各自的脸部对焦位置，自选图片使用默认对焦位置；透明立绘在看板娘中保留侧边及底部渐隐。普通 LOGO 与二次元图片分别保存，已有自选图优先于内置图。

| 工具 | 二次元默认文件 |
| --- | --- |
| Claude Code | `anime/Claude-二次元.png` |
| Codex | `anime/ChatGPT-二次元.png` |
| Antigravity | `anime/Gemini-二次元.png` |
| DeepSeek Harness | `anime/DeepSeek-二次元.png` |
| ZCode | `anime/ZCODE-GLM-二次元.png` |
| Kimi Code | `anime/KIMI-二次元.png` |
| Qwen（千问） | `anime/Qwen-二次元.png` |
| WorkBuddy | `anime/WorkBuddy-二次元.png`（原创生成立绘） |

文件映射在 `src/data.ts`。也可在配置的“二次元图片”部分单独替换；配置内自选图片仅本机保存，不写入仓库。
