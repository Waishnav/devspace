# DevSpace 两主机最终验收与维护交接

更新时间：2026-07-31（UTC+8）

## 最终状态

**PASS**

本次验收采用用户确认的双机维护口径：

- `local_agent_nick_work` 是正式功能验收主机，负责真实图片、Chrome Use、Computer Use 和应用审批链路验收；
- `local_agent` 主机 A 是同构运行主机，负责代码与维护文件一致、8-action 工具快照、测试构建和服务健康，不再重复相同的原生桌面动作；
- 后续只有机器相关实现、系统版本、ChatGPT/Codex 运行时或权限模型发生差异时，才要求主机 A 补做独立桌面验收。

长期权威文档：

1. `docs/computer-use.md`：架构、安全边界与验收矩阵；
2. `docs/local-maintenance.md`：升级、工具 schema、Refresh 和日常维护经验；
3. `docs/security.md`：Owner password、OAuth 与单客户端授权；
4. `docs/artifact-exchange.md`：图片和二进制文件交换；
5. 本文件：当前最终状态和可复现证据摘要。

## Claim → Evidence

### 1. 两个 ChatGPT App 都暴露正确工具

**Claim：PASS**

两端均为 8 actions：

```text
open_workspace
read
bash
edit
write
show_changes
computer_use
chrome_use
```

均不包含：

```text
capture_screen
computer_action
```

关键维护经验：用户只执行了账号级 **Refresh**，没有卸载、重装、Reconnect、重复 OAuth 或修改任何网络配置；Refresh 后两个 App 均恢复为 8 actions。

### 2. 本地图片原生读取

**Claim：PASS**

两端均通过模型直接调用：

```text
open_workspace("/Users/you/path/to/devspace")
read("docs/assets/devspace-logo-light.png")
```

模型收到原生 `image/png`，不是路径、base64 或文字替代。

### 3. Chrome Use

**Claim：PASS**

两端均使用仓库 fixture 和隔离测试标签完成：

- `new_tab` 返回 DOM 与截图；
- `fill #value` 写入 `devspace-chrome-probe`；
- `click #apply`；
- DOM 断言出现 `Accepted: devspace-chrome-probe`；
- 动作后截图模型可见；
- 测试标签关闭，未操作用户已有标签页。

### 4. Computer Use

**Claim：PASS**

`local_agent_nick_work` 完成模型直接调用：

- `list_apps`；
- Finder `get_app_state`，返回原生截图和 Accessibility tree；
- `press_key Escape`，返回新状态；
- System Settings 首次调用安全返回 `approvalRequired` 和官方审批提示；
- 在用户已授权低风险验收范围内，以显式 `appApproval=accept` 重试；
- System Settings 返回截图和 Accessibility tree；
- `press_key Escape` 返回新状态。

该链路证明正式 ChatGPT → DevSpace → signed Codex Computer Use 路径可用。主机 A 运行同一实现，按用户确认不重复相同桌面动作。

### 5. 安全和无 Codex turn 边界

**Claim：PASS**

- 正式验收未使用 Work/Codex 模式；
- Chrome/Computer 能力由模型直接调用 `chrome_use` / `computer_use`，未用 bash、CDP 或内部测试替代；
- 未伪造 Codex thread/turn metadata；
- app-server 只允许 `initialize`、`process/spawn`、`process/writeStdin`、`process/kill`；
- 无 `thread/start`、`turn/start`；
- `nick-work` 正式动作前后 Codex session 聚合哈希一致：
  `ab4dfcabb42ccda85bbbcf0bd8c1a28f9a70560963cc5c76643705f7f4affefc`；
- 未修改系统代理、PAC、Clash Verge、度管家、Tailscale 或全机网络配置。

### 6. 构建、同步与运行状态

**Claim：PASS**

两端均完成：

```bash
npm run typecheck
npm test
npm run build
```

两端服务均使用：

```text
DEVSPACE_WIDGETS=changes
DEVSPACE_COMPUTER_USE=1
DEVSPACE_COMPUTER_USE_BACKEND=codex
```

本地和公网 `/healthz` 正常。最终维护文件和核心实现以 SHA-256 一致为同步完成标准。

### 7. 清理

**Claim：PASS**

- 两端 `chrome_use list_tabs` 均无测试标签；
- `devspace-chrome-acceptance` tmux 会话已关闭；
- 正式服务保持运行；
- 运行日志包含真实 `computer_use_tool_call` 与 `chrome_use_tool_call`。

## 旧 Swift fallback 决策

**状态：暂时保留，但不是生产路径。**

当前生产默认和 ChatGPT 工具快照只使用 Codex 后端。旧 Swift 代码仅在显式配置 `DEVSPACE_COMPUTER_USE_BACKEND=swift` 时生效，不会自动回退，也不会暴露在正常 8-action App 中。

暂未删除的明确原因：

1. 删除需要同时移除三个文件、配置类型、服务启动分支、工具注册、测试和多份文档，必须作为一个原子变更完成；
2. 当前 Chat 模式的 DevSpace 工具面没有文件删除 action，且维护规范禁止使用 bash 修改或删除项目文件；
3. 半删除会留下不可构建或误导性的残余路径，风险高于继续保持显式禁用。

退出条件：在具备原子文件删除能力的独立代码维护变更中，一次性删除：

```text
scripts/macos-computer-use.swift
src/computer-use.ts
src/computer-use.test.ts
```

同时清理 `swift` 配置分支、服务脚本、注册逻辑、测试与文档，并重新执行完整测试、构建和工具快照回归。在此之前不得将 Swift 设为默认或自动 fallback。

## 后续维护规则

- 新增或删除 MCP 工具后，先在账号级 App 执行一次 **Refresh**，再检查 “Tools for this app”；不要默认卸载重装；
- 只有真实鉴权失败才使用 Reconnect/OAuth；
- 服务重启后的短暂 502 先等待健康恢复，不视为绑定失效；
- 功能回归优先在 `local_agent_nick_work` 完成，主机 A 验证同构同步、测试构建和健康；
- 机器相关差异、系统升级、ChatGPT/Codex 版本变化或权限模型变化时，两端分别实测；
- 任何完成声明继续采用 `claim -> evidence`。
