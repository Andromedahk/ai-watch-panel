# WorkBuddy 二次元立绘

- 素材：`images/anime/WorkBuddy-二次元.png`。
- 来源分类：`generated-edit`；使用 Codex 内置 imagegen 生成原创角色后继续编辑，不是 WorkBuddy 官方角色或官方素材。
- 设计：参考面板现有助手的二次元表现和 WorkBuddy 薄荷绿品牌配色；最终保留人类喜欢的双马尾造型，减少头发和服装的细碎高光、渐变与质感，采用轻度扁平化的赛璐璐阴影。
- 用途：三皮肤中的默认 WorkBuddy 二次元头像及看板娘；已有自选图片仍优先显示。
- 文件：原生生成尺寸 1254 × 1254，RGBA PNG，保留生成的透明通道，未插值放大。旧 SVG 占位图仍保留在素材目录。
- SHA-256：`4e7b4b05767d75b088335998cf1bdce34299529beda39406ef17d74309dbb840`。
- 署名：Codex（GPT-6 / Codex 桌面本地执行环境），2026-10-23。

## 最终编辑提示词

输入是一张此前生成的薄荷绿双马尾角色透明立绘。使用内置 imagegen，`transparent_background: true`。

```text
Use case: style-transfer.
Asset type: transparent anime portrait for the WorkBuddy AI assistant in a desktop dashboard.
Input image 1 is the exact EDIT TARGET, not a loose inspiration.
Primary request: 用户说“再稍微扁平化一点点，我喜欢这个双马尾”。Keep this exact adorable mint-haired twin-tail character and make the rendering just a little flatter.
Change ONLY the rendering: simplify the numerous fine hair highlights into cleaner broader highlight shapes; reduce the soft gradients, painterly texture, tiny fabric shading, and metallic specular shine. Use crisp anime line art and restrained two-to-three-tone cel shading, keeping sufficient detail and the lively eyes. This is a modest simplification, not a radical flat vector redesign.
Preserve precisely: the fluffy curled twin-tail silhouette, dark teal hair bows with gold star clasps, loop ahoge, gold star hairclip, mint-green hair, large emerald green eyes, face identity and proportions, small warm smile, cream capelet and frills, mint vest, dark teal neck ribbon and gold star brooch, pose, square close-up bust framing, placement and scale.
Background: genuine transparent alpha outside the character; preserve transparency and clean hair edges. No background panel, scene, text, watermark, extra objects, border, drop shadow, or new costume elements.
```
