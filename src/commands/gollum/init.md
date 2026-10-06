---
description: 把当前目录接入 gollum（建/复用 Project + 写 .gollum/project.yaml）
argument-hint: [project-name]
allowed-tools: Bash(gollum:*)
---

把当前工作目录接入 gollum 状态层。

**用户给的参数：** $ARGUMENTS

## 步骤

1. 运行绑定（`$ARGUMENTS` 非空时当作项目名传入）：

   ```bash
   gollum init
   # 若提供了项目名，使用：gollum init --name "项目名"
   ```

   这一条命令会做三件事：按目录名查找已有的 Project（找到就复用，找不到才新建）、
   写 `.gollum/project.yaml`、安装保留用户原文的 CLAUDE.md / AGENTS.md 恢复入口、打印 Project ID。`gollum project` 没有 delete 命令，
   所以复用是必须的。

2. 验证绑定真的生效：

   ```bash
   gollum resolver notify-cwd "$PWD"
   ```

   `project_id` 必须非 null、`source` 必须是 `project-yaml`。如果是 null，
   说明绑定没成 —— **停下来报告，不要继续建 Goal**。

3. 把结果报给用户：三行以内，包含 Project 名、26 位 ID、`.gollum/project.yaml` 路径。

## 边界

- 只做绑定。**不要**顺手建 Goal / Outcome / Task —— 那是后续规划任务的事。
- 已经绑定过时 `gollum init` 会直接返回 "Already bound"，这是正常的，报告一下即可，
  不要加 `--force` 重新绑。
- 如果目录在 git 仓库里，提醒用户把 `.gollum/` 加进 `.gitignore`：里面的 Project ID
  是本机 SQLite 的行 ID，提交上去会误导别人。
- 绑定完成后，接下来直接用自然语言推进即可，例如「用 gollum 记一下：xxx」。
