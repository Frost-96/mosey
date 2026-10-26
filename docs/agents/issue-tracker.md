# Issue tracker: GitHub

待办规格、任务与历史记录保存在 Frost-96/mosey 的 GitHub Issues。
仓库：https://github.com/Frost-96/mosey

使用 gh CLI，所有命令显式指定 --repo Frost-96/mosey，
不依赖本地 Git remote。

## 操作约定

- “发布到 issue tracker”表示创建 GitHub issue。
- “读取任务”表示读取对应 issue 的正文、标签和评论。
- 发布前检查是否已有对应 issue，避免重复创建。
- 多行正文使用 --body-file，保留原始换行。
- 标签按 triage-labels.md 中的映射应用；已有标签直接复用。
- 更新、评论或关闭任务时，操作已确认的 issue 编号。
- 已关闭 Issue 保留历史，不持续同步当前实现；未完成的要求与验收缺口继续由开放 Issue 承接。

## Pull requests as a triage surface

PRs as a request surface: no.
