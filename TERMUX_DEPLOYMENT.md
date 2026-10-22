# 手机部署与后续维护

本仓库是 `Linpeaks/SillyTavern-Vertex`，基于官方 SillyTavern 1.19.0，
保留本地已经提交的 Vertex HTTP/2 保活、Argon 思考等级、Google 文本片段、
有界流诊断、新建聊天提示、图片与原生 PDF 附件修复。手机使用本仓库 `main`。
原项目与许可证保留；本管理脚本同样采用 AGPL-3.0。

## 手机第一次安装

安装 [Termux 官方发行版](https://github.com/termux/termux-app#installation)，
打开 Termux，粘贴一整行：

```bash
pkg update -y && pkg install -y curl && curl -fL https://raw.githubusercontent.com/Linpeaks/SillyTavern-Vertex/main/termux.sh -o "$TMPDIR/st-vertex-install.sh" && bash "$TMPDIR/st-vertex-install.sh"
```

喜欢教程中的写法，也可以用（需已有 curl）：

```bash
bash <(curl -fsSL https://raw.githubusercontent.com/Linpeaks/SillyTavern-Vertex/main/termux.sh)
```

上面第一种写法只会在下载成功后执行脚本，网络出错更容易发现。首次会自动安装
缺少的 Git、Node.js LTS、npm，然后浅克隆 `main`、用 `npm ci` 安装锁定的生产
依赖，并启动酒馆。已有 Node.js 20 及以上时保留现有版本，不执行整机包升级。
32 位 ARM 按官方说明补装 `esbuild`。不会自动切换镜像、关闭白名单或关闭 CSRF。

看到服务器就绪后，在手机浏览器打开 **http://127.0.0.1:8000**。
安装在 **`~/SillyTavern-Vertex`**；有普通版 `~/SillyTavern` 时两者保持独立。
同一手机不能同时有两个进程使用 8000 端口，先停掉另一份，或者运行
`ST_PORT=8001 st start`，访问 `http://127.0.0.1:8001`。

本脚本启动时用参数固定本机监听、`./data` 数据目录和端口，不改已有配置文件。
自建其他数据目录或需要远程访问的安装请自行用官方 `start.sh` 管理。

## 平时使用

| 命令 | 操作 |
| --- | --- |
| `st` | 管理菜单；首次安装时安装并启动 |
| `st start` | 前台启动；Ctrl+C 停止 |
| `st update` | 停服后检查源码、备份、更新，不自动启动 |
| `st backup` | 停服后备份数据、配置、服务端插件和公共第三方扩展 |
| `st status` | 当前提交、分支和源码修改状态 |
| `st install` | 安装或补全依赖；已有安装不自动更新源码 |

`st` 是 `$PREFIX/bin/st` 中的小启动器，不修改 `.bashrc`。
如果原来已有其他 `st` 命令，会保留原命令；此时使用：

```bash
bash ~/SillyTavern-Vertex/termux.sh
```

保持 Termux 运行，并在系统设置中按需允许后台活动。
可手动执行 `termux-wake-lock`，用完执行 `termux-wake-unlock`；Android 仍可能
回收进程。停止酒馆用启动终端的 Ctrl+C。脚本不托管后台服务、不扫描或结束其他酒馆。

## 更新和备份

先停止生成和酒馆，然后：

```bash
st update
st start
```

更新只读取你自己的 GitHub `main`，不跟随官方 `release/staging`。
未提交源码、未跟踪文件、分支不符、来源不符、历史分叉时会停止，
不执行强制重置、自动暂存、重装删除或数据恢复。网络或依赖安装失败会返回失败；
可在解决网络问题后再次运行 `st install`，再启动。

每次确实要快进更新时，先把安装目录内的 `data`、`config.yaml`、`secrets.json`、
`plugins`、`public/scripts/extensions/third-party` 里存在的项目保存为
`~/SillyTavern-Vertex-backups/backup-日期-时间-进程号.tar.gz`。
备份失败不继续更新；未完成归档保留 `.partial` 后缀。没有改动时不会重复备份。
日常启动/更新只在锁文件、Node.js 主版本变化或首次安装时重装依赖；
显式 `st install` 会重新安装依赖以修复不完整的安装。

备份只在手机本地，可能含聊天、密钥和私有扩展，**不要上传 GitHub**。
备份会占手机空间，脚本不自动删除旧备份。这里不提供一键覆盖恢复；恢复前先停服并
额外保存当前数据，再检查归档内容。用其他方式手动启动的进程也必须先自行停止。

## 把电脑里的内容迁到手机

公开仓库只有源码及已有合成测试，不含电脑 `data`、`config.yaml`、密钥、聊天、
私人预设、角色或第三方扩展。手机初次安装是干净的用户环境，API 凭据需要重新配置。

如需完整迁移，先停止两端酒馆，在本地私下备份并传输：

1. 电脑 `data/` → 手机 `~/SillyTavern-Vertex/data/`，保留内部目录结构。
2. 公共第三方扩展另在 `public/scripts/extensions/third-party/`；服务端插件在
   `plugins/`。先核实插件支持 Android，不要复制 Windows 的 `node_modules/`。
3. 先保留手机生成的 `config.yaml`；电脑配置可能含 Windows 绝对路径或监听设置，
   应逐项核对后再移植。`data` 可能已经包含 API 密钥，只通过自己控制的私密方式传输。
4. 原生 PDF 的文件在用户的 `files` 目录中，必须随 `data` 一起迁移；仅导出聊天
   JSON 不包含 PDF 原文件。迁移后先检查角色、聊天、预设、附件，再正常使用。

两端数据彼此独立，Git 更新不提供聊天同步。此轮未执行任何用户数据迁移。

## 电脑后续改动如何送到手机

电脑工作区：`D:\AIsoftware\SillyTavern`。
`origin` 指向你的仓库，`upstream` 保留官方仓库并禁用推送。
本地开发分支 `codex/termux-deployment` 跟踪 `origin/main`。

每次修改后更新 `VERTEX_GEMINI_INVESTIGATION_LOG.md`，验证并只暂存相关源码/文档：

```powershell
git status --short
git add <本次明确修改的源码或文档>
git add VERTEX_GEMINI_INVESTIGATION_LOG.md
git commit -m "说明本次修改"
git push origin HEAD:main
```

然后手机运行 `st update` 和 `st start`。新增本地分支时继续明确推送到你自己的
目标分支；不要直接把官方更新覆盖到 `main`。需要合并上游时，先 `git fetch upstream`，
在单独分支检查差异和冲突，再合并并验证。回滚源码优先 `git revert <提交号>`，
验证后推送，再由手机正常更新；不要用 `reset --hard` 或 `clean` 清理用户文件。

## 网络与验证范围

手机必须能访问 GitHub、raw.githubusercontent.com、npm registry，以及你使用的
Google/API 地址。若 `pkg` 镜像失败，使用 `termux-change-repo` 选择可用镜像后重试。
脚本不会绕过手机网络设置，也不会自动重提交模型生成。

本地脚本测试使用临时 Git 仓库、合成用户数据和模拟 npm/Node 服务，验证安装、快进、
备份、失败中止及保留数据；不能代替 Android 的真实包安装、后台存活、浏览器、
TUN/Google 和大 PDF 内存实测。实际验收结果记在同一变更日志中。

GitHub 的 `Termux deployment checks` 工作流在 `main` 更新时运行 Bash 隔离测试、
Node.js 24 的干净生产依赖安装和空数据启动探测。它运行于 Ubuntu，仍不等于 Android
实机验收；不会携带你的密钥或调用模型生成。

参考：[官方 Android 安装说明](https://docs.sillytavern.app/installation/android-(termux)/)、
[用户提供的 Angler Toolbox](https://github.com/mc10091009/st_manager.sh)。
参考的是安装与管理流程，未复制其脚本或重新分发其代码。
