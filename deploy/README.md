# 新机器一键部署

两种装法，最后效果一样。

**A. 免构建包**（推荐，目标机器什么都不用有）：

```bash
tar xzf copilot-cc-<日期>-<sha>.tar.gz
cd copilot-cc-<日期>-<sha>
bash install.sh
```

**B. 从源码**：

```bash
git clone -b patched git@github.com:TZHSW/copilot-api.git
cd copilot-api
bash deploy/install.sh
```

跑完开个新终端敲 `claude` 就行。全程只有一步要人工：GitHub 设备码登录（首次没有
`~/.local/share/copilot-api/github_token` 时会弹，需要一个能访问 Copilot Enterprise
的账号）。

脚本按顺序做这些，每步幂等，可以反复跑：

| 步骤 | 动作 |
|------|------|
| 1 | 检查 node ≥ 20；没有就从 nodejs.org 抓官方 tarball 解到 `~/.local/share/node-vX`，软链到 `~/.local/bin`，并把该目录写进 `~/.profile` 和 `~/.bashrc`/`~/.zshrc`（不需要 sudo，不依赖 nvm）|
| 2 | 拿产物：源码模式跑 `bun run build:standalone`；免构建包直接用自带 `dist/` |
| 3 | 产物拷到 `~/.local/share/copilot-api-patched/dist/` |
| 4 | 没有 github_token 就走设备码登录 |
| 5 | 常驻：优先 systemd user 服务（`enable --now` + `enable-linger`）；没有用户 D-Bus 时退到 `copilot-api-ctl`（setsid + pidfile + crontab `@reboot`）|
| 6 | 没有 `claude` 就跑官方安装脚本 |
| 7 | 把 `settings.template.json` 合并进 `~/.claude/settings.json`（先备份） |
| 8 | 查模型在不在目录里，再实发一次 `max_tokens=16` 的请求验证整条链路 |

环境变量：`PORT`（默认 4141）、`CLAUDE_CONFIG_DIR`（默认 `~/.claude`）、
`NODE_VERSION`（默认 22.22.3，仅在需要装 node 时用到）、
`SUPERVISOR=nohup`（强制不用 systemd）。

## node 环境到底需要什么

这套部署**只要 node 运行时**：产物是自包含的，不用 npm 装任何依赖（npm/npx 只是
跟着 tarball 一起来的）。脚本会配好三件事：

- `~/.local/share/node-v<版本>/` 下的 node 本体，软链 `node`/`npm`/`npx` 到 `~/.local/bin`
- `~/.profile` 里的 PATH——**ssh 进去是登录 shell，bash 登录只读 `.profile` 不读 `.bashrc`**，
  所以两处都写（幂等，靠注释 marker 判重）
- systemd unit 不依赖你的 shell：`ExecStart` 是 node 绝对路径，`Environment=PATH`
  里也写死了 `~/.local/bin`。所以「服务能起来」和「你终端里能敲到 node」是两件事

已经有 node ≥ 20 的机器完全不碰这些。

## 没有 systemd user session 怎么办

容器里、或者 `ssh`/`su` 进来没有登录会话时，`systemctl --user` 会报：

```
Failed to connect to bus: $DBUS_SESSION_BUS_ADDRESS and $XDG_RUNTIME_DIR not defined
```

脚本会先尝试自动补救（`/run/user/<uid>` 在的话就补上 `XDG_RUNTIME_DIR`，这能覆盖
大部分「会话在、只是环境变量没带过来」的情况）；补不了就自动改用
`~/.local/bin/copilot-api-ctl`：

```bash
copilot-api-ctl start|stop|restart|status|log
```

它用 setsid 起进程（终端关掉不受影响）、pidfile 记录、日志在
`~/.local/share/copilot-api-patched/run.log`，并挂一条 crontab `@reboot` 做开机自启。
没有 crontab 的机器会明确提示重启后要手动拉起。

## 打包

```bash
bash deploy/pack.sh              # 产物落在仓库根目录
OUT_DIR=/tmp bash deploy/pack.sh
```

产出 `copilot-cc-<日期>-<sha>.tar.gz`（约 2.2 MB），里面是 `dist/`、`install.sh`、
`copilot-api.service`、`settings.template.json`、`README.md`、`VERSION`。

包里的 `dist/` 是 **noExternal 自包含构建**（`tsdown.pack.config.ts`，约 6 MB 解压后，
含 gpt-tokenizer 的数据 chunk），目标机器不需要 `node_modules`、不需要 bun、不需要
联网装依赖。注意默认的 `bun run build` 产物**不是**自包含的（依赖留在
`node_modules`），单独拷走会 `ERR_MODULE_NOT_FOUND`——所以部署走的是
`build:standalone`。

## settings 模板里有什么

从 G4-27 的 `~/.claude/settings.json` 原样派生，只剔除了 orca 的 agent-hooks（路径是
那台机器专有的）。包含：

- `env`：`ANTHROPIC_BASE_URL=http://localhost:4141/v1/native`、
  `ANTHROPIC_API_KEY=copilot-api`（本地反代不校验，占位）、
  `ANTHROPIC_MODEL=claude-opus-5[1m]` 及三档默认模型
- `permissions`：174 条 Bash allowlist + `defaultMode: bypassPermissions`
- `model: opus`、`effortLevel: high`、`theme`、`editorMode` 等偏好
- `enabledPlugins`：superpowers、claude-hud（首次启动 Claude Code 自己拉）
- `statusLine`：claude-hud 状态栏（脚本会把里面硬编码的 node 路径换成本机的）

合并是**模板优先的深合并**：目标机器上原有的其它键（比如你自己的 hooks）保留，旧文件
备份成 `settings.json.bak.<时间戳>`。

## 为什么 env 用 `/v1/native`

`/v1/native` 是本仓库补丁加的直通路由：请求原样转发到 Copilot 自己的 `/v1/messages`，
只翻译模型名，不走 Anthropic↔OpenAI 双向翻译，保真度最高。补丁细节见
[PATCH_NOTES.md](../PATCH_NOTES.md)。

## 模型目录会变

`claude-opus-4.7-1m-internal` 这个曾经的默认模型现在**已经从目录里消失**了。所以
第 8 步会先列一遍目录再验证，模型不在时给出现有的 claude 型号让你改
`deploy/settings.template.json` 里的 `ANTHROPIC_MODEL`。当前用的是 `claude-opus-5[1m]`
（`[1m]` 后缀在 native 路径会被剥掉，目录里没有对应变体也能正常工作）。

随时手查：

```bash
curl -s -H "Authorization: Bearer copilot-api" \
  http://localhost:4141/v1/native/v1/models | python3 -m json.tool | grep '"id"'
```

## 常见问题

| 现象 | 排查 |
|------|------|
| `Failed to connect to bus: $DBUS_SESSION_BUS_ADDRESS ... not defined` | 没有用户 D-Bus，见上一节；脚本会自动退到 `copilot-api-ctl`。想跳过探测直接用它：`SUPERVISOR=nohup bash install.sh` |
| 装完新终端里 `claude` / `node` 找不到 | `source ~/.profile`，或重新登录一次 |
| 反代起不来（systemd） | `journalctl --user -u copilot-api -n 50 --no-pager` |
| 反代起不来（nohup 模式） | `tail -50 ~/.local/share/copilot-api-patched/run.log` |
| 注销后服务没了 | systemd 模式看 `loginctl enable-linger $USER`；nohup 模式看 crontab `@reboot` 在不在 |
| 改了 settings 不生效 | `env` 只在进程启动时读，重开终端 |
| `API Error: operation timed out` | 大请求时慢在反代→Copilot 那一跳，不是网络问题；可在 `env` 里加 `"API_TIMEOUT_MS": "600000"` |
| 模型 400 | 该模型不支持请求里的 effort 档位；native 路径不做 clamp，会直接透传 Copilot 的报错 |
