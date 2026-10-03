# 贡献代码

没有上游写入权限时，先 Fork 仓库，再从自己的分支提交 PR。每个 PR 聚焦一个问题，说明触发条件、修改后的行为和验证结果。

## 准备分支

在 GitHub 仓库页面创建 Fork，复制自己的 Fork 与上游仓库的 HTTPS 地址。下面的占位内容需替换为实际地址和分支名：

```sh
git clone <fork-url>
cd ai-watch-panel
git remote add upstream <upstream-url>
git fetch upstream
git switch -c <branch-name> upstream/main
npm ci
```

Git 的提交署名和邮箱需要预先配置。GitHub 登录负责仓库访问权限；登录不会自动设置提交身份。使用 HTTPS 时可通过 `gh auth login` 登录，再用 `gh auth setup-git` 配置 Git 凭据助手。

## 验证变更

代码变更先运行单元测试和构建：

```sh
npm test
npm run build
```

Kimi、ZCode 适配器可先单独验证，以下合成测试无需真实账号或付费套餐：

```sh
node --test tests/kimi-status.test.cjs tests/zcode-status.test.cjs
```

合成测试覆盖登录切换、额度字段、缓存和本地活动证据等逻辑。真实客户端接口、当前套餐与任务变化仍需现场验证；在 PR 中分别写明合成测试和实机结果。接入范围见 [Kimi](docs/KIMI-INTEGRATION.md) 与 [ZCode](docs/ZCODE-INTEGRATION.md)。

涉及界面、窗口或启动行为时，补跑 README 中对应的桌面检查。macOS 是当前验收平台，未验证的 Windows / Linux 行为需注明。仅修改文档时检查链接、命令和差异，不必将未运行的检查写成通过。

## 提交 PR

每次修改同步更新 README 的相关说明与更新记录，并遵守 [项目约定](AGENTS.md)。提交前检查差异：

```sh
git diff --check
git diff
git add <changed-files>
git commit -m "<commit-message>"
git push -u origin <branch-name>
```

在 GitHub 创建 PR，目标设为上游 `main`，来源设为自己的 Fork 分支。尚待实机验证的改动先提交草稿 PR，并说明待验证的客户端版本和功能。

不要提交登录材料、真实会话内容、本地偏好、用户图片或构建输出。复现接口问题时，只提供必要的脱敏字段结构与客户端版本；保持现有适配器的只读边界。
