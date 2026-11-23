# 本仓库维护约定

- 日常功能改动与正式发版分开。先审查修改、运行相关测试；不要因一次代码修改自行增加版本、创建标签、推送 `main`，或重启 DSH。
- 人工维护者通过根目录「更新编辑器.cmd」或 `npm run release:editor` 发布；只读查看可用 `npm run release:status`。流程：保存草稿 → 准备 → 校验 → 明确确认目标版本后发布。
- 不再用 `git add -A` 或旧的 `tools/push-update.ps1` 代替守卫。不得改写守卫状态、覆盖版本标签、强推、跳过测试；不要为通过校验撤销用户修改。
- `package.json` 是包版本来源。正式版本、安装目录 HEAD 与当前运行的宿主版本是不同概念。普通工作台的检查/拉取按钮没有发布权限。
- 修改守卫本身后，执行 `npm run test:release-guard` 在隔离仓库演练。完整维护与失败恢复说明见 [发布守卫](docs/RELEASE-GUARD.md)。
