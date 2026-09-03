# Copilot Codex 私有离线迁移包

这个包离线部署 patched `copilot-api`，并迁移打包机上的 Codex 功能配置、用户 skills、插件缓存、Codex 登录凭据和 Copilot GitHub token。

包内包含实时凭据。只能通过可信私有渠道传输，不要上传到 Git、公开网盘、聊天附件或公共制品库；用完后删除多余副本。

## 前提

目标机器已经安装：

- Node.js 20 或更新版本；
- Codex CLI；
- Linux 上的 Bash、curl 和 sha256sum，或 Windows PowerShell 5.1/7。

安装过程不下载依赖。Copilot 推理本身仍需要访问 GitHub/Copilot 网络。

## Linux

```bash
tar xzf copilot-codex-*.tar.gz
cd copilot-codex-*
OFFLINE=1 bash install.sh
```

有网络并希望安装时完成端到端验证，可省略 `OFFLINE=1`。默认端口为 4141；换端口使用 `PORT=4142 bash install.sh`。

服务优先使用 systemd user。不可用时自动安装：

```bash
~/.local/bin/copilot-api-ctl status|restart|stop|log
```

## 原生 Windows

```powershell
Expand-Archive .\copilot-codex-*.zip
Set-ExecutionPolicy -Scope Process Bypass
cd .\copilot-codex-*
.\install.ps1 -Offline
```

省略 `-Offline` 会运行在线端到端验证。换端口使用 `.\install.ps1 -Port 4142`。安装器创建当前用户的 `CopilotApiPatched` 登录计划任务，不需要管理员权限。

服务管理脚本位于：

```powershell
& "$env:LOCALAPPDATA\Programs\copilot-api-ctl.ps1" status
& "$env:LOCALAPPDATA\Programs\copilot-api-ctl.ps1" restart
& "$env:LOCALAPPDATA\Programs\copilot-api-ctl.ps1" stop
& "$env:LOCALAPPDATA\Programs\copilot-api-ctl.ps1" log
```

## 迁移与备份

安装器会：

- 替换 `config.toml`、`auth.json` 和平台适用的 hooks；
- 合并 skills/plugins，同名文件以包内快照为准；
- 重写本地 API/MCP 端口；
- 删除属于源机器的项目信任路径；
- 不迁移 sessions、history、日志和 SQLite 状态。

Linux 备份位于 `~/.local/share/copilot-codex-backups/`。Windows 备份位于 `%LOCALAPPDATA%\copilot-codex-backups\`。本地安装失败时自动恢复；成功安装的备份仍会保留。

Windows 无法原生执行 Unix Orca hooks，因此原文件保存为 `.codex\hooks.linux.json`，活动 `hooks.json` 为空。Linux 会迁移对应 Orca hook 脚本。

## 诊断

```bash
OFFLINE=1 bash diagnose.sh
```

```powershell
.\diagnose.ps1 -Offline
```

诊断脚本只读，并只显示凭据是否存在及文件大小，不打印凭据内容。

## 自动打包

在源码仓库运行：

```bash
bash deploy/codex/pack.sh
OUT_DIR=/tmp/private-bundle bash deploy/codex/pack.sh
```

脚本构建 standalone API、快照当前用户配置、生成 manifest，同时输出内容一致的 `.tar.gz` 和 `.zip`。
