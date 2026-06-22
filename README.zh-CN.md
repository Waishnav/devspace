<p align="center">
  <picture>
    <img src="docs/assets/devspace-logo-light.png" alt="DevSpace logo" width="140">
  </picture>
</p>

<h1 align="center">DevSpace</h1>

<p align="center">把类似 Codex 的编程工作流带到 ChatGPT。</p>

<p align="center">
  <a href="https://www.npmjs.com/package/@waishnav/devspace"><img alt="npm" src="https://img.shields.io/npm/v/%40waishnav%2Fdevspace?style=flat-square" /></a>
  <a href="https://github.com/Waishnav/devspace/actions/workflows/ci.yml"><img alt="CI" src="https://img.shields.io/github/actions/workflow/status/Waishnav/devspace/ci.yml?style=flat-square&branch=main" /></a>
  <a href="https://github.com/Waishnav/devspace/blob/main/LICENSE"><img alt="License" src="https://img.shields.io/npm/l/%40waishnav%2Fdevspace?style=flat-square" /></a>
</p>

<p align="center">
  <a href="./README.md">English</a> | 简体中文
</p>

[![DevSpace connected to ChatGPT](docs/assets/devspace-screenshot.png)](docs/assets/devspace-screenshot.png)

**为 ChatGPT 提供一条安全连接到你自己机器的通道，把 ChatGPT 变成 Codex**

DevSpace 是一个自托管的 MCP 服务器，让 ChatGPT 可以直接在你真实的本地项目里读取、编辑、搜索和运行代码，也就是使用你的文件、你的工具、你的终端，而无需把内容上传到第三方。它运行在你的机器上，通过你自己控制的隧道暴露出去，并使用只有你知道的密码来批准连接。

## 安装

DevSpace 需要 Node `>=20.12 <27`，推荐使用 Node 22 LTS。

安装 DevSpace CLI：

```bash
npm install -g @waishnav/devspace
```

然后初始化并启动服务：

```bash
devspace init
devspace serve
```

如果你不想全局安装，也可以直接运行：

```bash
npx @waishnav/devspace init
npx @waishnav/devspace serve
```

在安装过程中，DevSpace 会询问你：

- ChatGPT 被允许通过 DevSpace 打开的本地项目目录
- 本地端口，通常为 `7676`
- 你的公网 HTTPS 基础地址，可以来自 Cloudflare Tunnel、ngrok、Pinggy、Tailscale Funnel 或其他反向代理

在初始化时，请填写不带 `/mcp` 的公网基础地址：

```text
https://your-tunnel-host.example.com
```

完成设置后，再把带 `/mcp` 的公网地址配置到你的 MCP 客户端中。

当客户端连接时，DevSpace 会打开一个 Owner 密码确认页面。输入 `devspace init` 打印出来的 Owner 密码即可。这个密码也会保存到：

```text
~/.devspace/auth.json
```

请妥善保管，不要泄露。

## 连接你的 MCP 客户端

默认的本地端点是：

```text
http://127.0.0.1:7676/mcp
```

大多数用户应该通过公网 HTTPS 隧道连接：

```text
https://your-tunnel-host.example.com/mcp
```

## 配置管理

你可以用这些简短命令更新本地服务配置：

```bash
# 查看当前生效配置
devspace config show

# 修改本地监听端口
devspace config port 7676

# 修改本地绑定地址
devspace config host 127.0.0.1

# 设置公网域名或 URL
devspace config domain devspace.example.com

# 轮换 Owner 密码
devspace config key
```

配置修改后会立即保存。如果当前有由 DevSpace 管理的后台服务正在运行，DevSpace 会自动重启它，让新设置立刻生效。

`devspace config show` 会显示生效中的绑定地址、端口、MCP 路径、公网 URL、工作区列表、服务状态，以及打码后的访问密钥。如果当前 Owner 密码来自 `DEVSPACE_OAUTH_OWNER_TOKEN`，DevSpace 会显示打码后的实际值，而不是把它报告为缺失。

`devspace config key` 会轮换现有的 DevSpace Owner 密码、清除已保存的 OAuth 批准和令牌，并强制已连接客户端重新授权。

## 工作区管理

持久化保存 DevSpace 被允许打开的工作区根目录：

```bash
# 添加工作区，并设为默认工作区
devspace workspace add ~/workspace/project-a --default

# 再添加一个工作区，但不修改默认项
devspace workspace add ~/workspace/project-b

# 查看当前工作区列表
devspace workspace list

# 把默认工作区切换到 project-b
devspace workspace default ~/workspace/project-b

# 删除一个工作区配置
devspace workspace remove ~/workspace/project-a
```

你也可以只在当前这次运行中临时允许额外路径：

```bash
devspace serve --add-dir ~/scratch/project-c --workspace ~/workspace/project-b
```

工作区路径就是 DevSpace 与 MCP 文件工具的授权边界。添加某个工作区，只会授权这个路径及其子路径。

如果你启动 DevSpace 时既没有已配置工作区，也没有设置 `DEVSPACE_ALLOWED_ROOTS`，DevSpace 现在会默认拒绝访问：服务可以启动，但在你显式添加允许路径之前，工作区访问会被拒绝。

## 服务管理

DevSpace 的服务管理只负责管理 DevSpace 本身。`devspace service start` 是统一入口：如果后台服务不存在，DevSpace 会按当前平台创建并启动；如果已经存在，则只执行启动。它不会管理任意系统服务。

```bash
# 启动 DevSpace 后台服务
devspace service start

# 查看服务当前状态
devspace service status

# 查看服务日志
devspace service logs

# 重启服务
devspace service restart

# 停止服务
devspace service stop

# 禁用服务自启动
devspace service disable

# 删除已安装的 DevSpace 后台服务
devspace service remove

# 检查服务管理环境和健康状态
devspace service doctor
```

平台行为如下：

- macOS 使用按用户安装的 LaunchAgent
- Linux 和 Ubuntu 在可用时使用按用户安装的 systemd 服务
- Windows 使用任务计划程序
- WSL 优先使用用户级 systemd，否则会提示回退到 Windows 任务计划程序

DevSpace 不会自动帮你配置 DNS、反向代理、TLS 证书或防火墙规则。

## ChatGPT 能做什么

连接建立后，ChatGPT 可以把你已批准的某个项目目录作为工作区打开。之后它就可以检查仓库、做有限范围的修改、运行命令，并向你展示变更内容。

DevSpace 为 ChatGPT 提供了这些能力：

- 读取、写入和编辑已打开工作区内的文件
- 搜索代码并查看目录结构
- 运行测试、构建、Git 和包管理脚本相关命令
- 使用隔离的 Git worktree 并行处理多个编码会话
- 遵循项目里的 `AGENTS.md` 和 `CLAUDE.md` 指令
- 从你的技能目录中发现本地 agent skills
- 在兼容 ChatGPT Apps 的宿主中显示工具卡片和可选的变更摘要

DevSpace 内置一组稳定的工作流与工程技能，用于 Plan、Goal、跨会话恢复、架构审查和 Skill 编写。

项目技能目录按用途拆分为：

- `skills/.system`：DevSpace 自己维护的 5 个系统技能：`plan`、`goal`、`workflow`、`architecture-review`、`skill-authoring`
- `skills/local`：你希望随项目版本控制保存的项目自定义技能
- `skills/installed`：按需安装的外部技能，默认被 git 忽略

网页版 ChatGPT Plus 不能原生安装或注册 Codex Skills。DevSpace 改为在 MCP 这一侧提供技能安装、发现和解析这一层能力。

`@devspace /plan` 和 `@devspace /goal` 只是别名风格的工作流约定，不是 ChatGPT 原生斜杠命令。`/plan` 固定对应系统 `plan`，`/goal` 固定对应系统 `goal`；本地、已安装和全局技能都不能覆盖它们。

用这些命令管理已安装技能：

```bash
# 为当前上下文安装 skill
devspace skills install --repo openai/skills --path skills/.curated/research

# 只为某个工作区安装 skill
devspace skills install --workspace /path/to/project --repo openai/skills --path skills/.curated/research

# 查看当前上下文可用的 skill
devspace skills list

# 查看指定工作区的 skill
devspace skills list --workspace /path/to/project

# 从当前上下文移除 skill
devspace skills remove research

# 从指定工作区移除 skill
devspace skills remove --workspace /path/to/project research

# 安装全局 skill
devspace skills install -g --repo openai/skills --path skills/.curated/research

# 查看全局 skill 列表
devspace skills list -g

# 删除全局 skill
devspace skills remove -g research
```

`--repo/--path` 和 `--local-path` 必须直接指向一个标准技能目录，并且其中包含 `SKILL.md`。仓库根目录、插件根目录、命令目录和 agent-rules 目录都会被拒绝。

## 心智模型

DevSpace 本质上是对选定本地目录的远程访问。

你来决定哪些根目录被允许访问。MCP 客户端在已打开工作区内仍然具备很强的本地能力，包括执行 shell 命令。因此，你应该把一个已连接的客户端视为一位受信任的编程协作者，它能够访问你的机器。

对于一次普通的 ChatGPT 编程会话：

1. 启动你的隧道。
2. 运行 `devspace serve`。
3. 把 MCP 客户端连接到你的公网 `/mcp` URL。
4. 使用 Owner 密码批准连接。
5. 让 ChatGPT 在你的某个允许根目录内打开项目。

## 平台支持

DevSpace 支持 Linux、macOS、Windows 环境下带 Bash 兼容 shell 的主 CLI，并支持在 macOS、Linux、Windows 和 WSL 上进行原生的按用户服务控制。

| 平台 | 状态 | 说明 |
| --- | --- | --- |
| Linux | 支持 | 需要 Node、npm、Git 和 Bash。 |
| macOS | 支持 | 需要 Node、npm、Git 和 Bash。 |
| Windows with Git Bash, WSL, MSYS2, or Cygwin Bash | 支持 | 原生 Windows 环境下最简单的是 Git Bash。 |
| Windows PowerShell or `cmd.exe` only | 暂不支持 | 请安装 Git Bash 或使用 WSL。 |

你可以运行下面的命令检查本地环境：

```bash
devspace doctor
```

## 文档

- [安装指南](docs/setup.md)
- [ChatGPT 编码工作流](docs/chatgpt-coding-workflow.md)
- [配置参考](docs/configuration.md)
- [安全模型](docs/security.md)
- [常见问题与排障](docs/gotchas.md)

## 理念

每一类软件都正在变得可对话。自然语言正在重新定义我们与工具、工作流和系统交互的方式。

我的判断是，ChatGPT 会成为一切的操作系统。一旦抵达 AGI，我们大概只需要和 ChatGPT 对话，它就会替我们提示、协调、编排子代理，并搭建合适的执行闭环。

但现在还没到那一步。

DevSpace 是一次试图把那个未来往前拉近的尝试：让像 ChatGPT、Claude 这样支持 MCP 的宿主，可以通过显式、可检查的工具，直接操作本地项目文件。

## Built by Waishnav

我是 Waishnav，[GitCMS](https://gitcms.dev/) 的创建者。GitCMS 是一个面向 Markdown 网站、基于 Git 的 CMS。

我喜欢做带有明确产品判断的工具，而 DevSpace 也是这样的产品之一。我正在尝试建立一家由单人运营、能做到数百万营收的公司。如果你想围观其中的失败、胜利、经验和过程，欢迎在 [X](https://x.com/wshxnv) 上关注我。

## 本地开发

如果你要开发 DevSpace 自身，可以使用：

```bash
npm install --include=dev
npm run dev
npm run typecheck
npm test
npm run build
npm run start
```
