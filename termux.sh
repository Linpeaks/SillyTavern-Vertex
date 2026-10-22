#!/usr/bin/env bash
# Personal SillyTavern deployment. Original implementation; AGPL-3.0.
set -Eeuo pipefail

ST_REPO_URL='https://github.com/Linpeaks/SillyTavern-Vertex.git'
ST_BRANCH='main'
ST_DIR="${HOME}/SillyTavern-Vertex"
ST_BACKUP_DIR="${HOME}/SillyTavern-Vertex-backups"
ST_PORT="${ST_PORT:-8000}"

info() { printf '\n[酒馆] %s\n' "$*"; }
fail() { printf '\n[错误] %s\n' "$*" >&2; exit 1; }

usage() {
    cat <<'HELP'
SillyTavern Vertex 手机管理
  st                 首次安装并启动；已安装时显示菜单
  st start           启动（Ctrl+C 停止）
  st update          备份后更新源码和依赖，不自动启动
  st backup          备份手机本地数据、配置和扩展
  st status          查看版本和源码状态
  st install         安装/补全依赖，不更新已有源码
  st help            显示帮助

安装目录：~/SillyTavern-Vertex
备份目录：~/SillyTavern-Vertex-backups（可能含密钥，请勿上传）
浏览器地址：http://127.0.0.1:8000（ST_PORT 可临时指定端口）
HELP
}

require_termux() {
    [[ -n "${PREFIX:-}" && -x "${PREFIX}/bin/pkg" ]] ||
        fail '请在 Android 的 Termux 内运行此脚本。'
    [[ "${HOME}" == /* && "${HOME}" != / ]] || fail 'HOME 不是有效的绝对目录。'
    # Do not place Node/Git projects on Android shared storage.
    case "$(cd -- "${HOME}" && pwd -P)" in
        /sdcard|/sdcard/*|/storage/*|/mnt/media_rw/*)
            fail '请使用 Termux 自带的 HOME，不能在手机共享存储中安装。' ;;
    esac
    [[ "$ST_PORT" =~ ^[0-9]{1,5}$ ]] &&
        (( 10#$ST_PORT >= 1 && 10#$ST_PORT <= 65535 )) || fail 'ST_PORT 必须是 1 到 65535。'
}

ensure_dependencies() {
    local packages=()
    command -v git >/dev/null 2>&1 || packages+=(git)
    command -v node >/dev/null 2>&1 || packages+=(nodejs-lts)
    command -v npm >/dev/null 2>&1 || packages+=(npm)
    if (( ${#packages[@]} )); then
        info "安装缺失的 Termux 依赖：${packages[*]}"
        pkg update -y
        pkg install -y "${packages[@]}"
    fi
    node -e 'if (Number(process.versions.node.split(".")[0]) < 20) process.exit(1)' ||
        fail '需要 Node.js 20 或更高版本。请先用 pkg upgrade 更新 Termux。'
    command -v npm >/dev/null 2>&1 || fail 'npm 不可用，请运行 pkg install npm。'
    # Official Termux workaround for 32-bit Android.
    if [[ "$(node -p 'process.arch')" == arm ]] && ! command -v esbuild >/dev/null 2>&1; then
        pkg install -y esbuild
    fi
}

assert_checkout() {
    [[ -d "$ST_DIR/.git" && ! -L "$ST_DIR" && ! -L "$ST_DIR/.git" ]] ||
        fail "目录不是本脚本管理的 Git 安装：$ST_DIR。不会删除或覆盖它。"
    [[ -z "$(git -C "$ST_DIR" rev-parse --show-prefix)" ]] ||
        fail 'Git 根目录与安装目录不一致。'
    [[ "$(git -C "$ST_DIR" remote get-url origin)" == "$ST_REPO_URL" ]] ||
        fail 'origin 不是你的修改版仓库，已停止，避免更新错版本。'
    [[ "$(git -C "$ST_DIR" branch --show-current)" == "$ST_BRANCH" ]] ||
        fail "当前不是 $ST_BRANCH 分支，已停止。"
}

assert_stopped() {
    local pid_file="$ST_DIR/.git/termux-server.pid" pid=''
    if [[ -f "$pid_file" ]]; then
        read -r pid < "$pid_file" || true
        if [[ "$pid" =~ ^[0-9]+$ ]] && kill -0 "$pid" 2>/dev/null; then
            fail '此安装正在运行。请在启动酒馆的终端按 Ctrl+C，停止后再操作。'
        fi
    fi
}

install_shortcut() {
    local shortcut="$PREFIX/bin/st"
    if [[ -e "$shortcut" || -L "$shortcut" ]]; then
        if ! grep -q '^# SillyTavern-Vertex managed shortcut$' "$shortcut" 2>/dev/null; then
            info "已有其他 st 命令，保留它。请用 bash \"$ST_DIR/termux.sh\" 管理酒馆。"
            return
        fi
    fi
    {
        printf '#!%s/bin/bash\n' "$PREFIX"
        printf '# SillyTavern-Vertex managed shortcut\n'
        printf 'exec bash %q "$@"\n' "$ST_DIR/termux.sh"
    } > "$shortcut"
    chmod 700 "$shortcut"
}

install_node_modules() {
    local fingerprint stamp="$ST_DIR/.git/termux-dependencies"
    fingerprint="$(git -C "$ST_DIR" hash-object package-lock.json):$(node -p 'process.versions.node.split(".")[0]')"
    if [[ "${1:-cached}" != force && -d "$ST_DIR/node_modules" && -f "$stamp" && "$(cat "$stamp")" == "$fingerprint" ]]; then
        return
    fi
    info '安装锁定版本的运行依赖（首次可能需要几分钟）……'
    # Match upstream start.sh's ignore-scripts policy; never change the lockfile.
    (
        cd -- "$ST_DIR"
        NODE_ENV=production npm ci --omit=dev --ignore-scripts --no-audit --no-fund --loglevel=error
    )
    printf '%s\n' "$fingerprint" > "$stamp"
}

install_app() {
    ensure_dependencies
    if [[ -e "$ST_DIR" || -L "$ST_DIR" ]]; then
        assert_checkout
        assert_stopped
        info '发现已有修改版安装，保留源码和数据。'
    else
        info "安装你的修改版到 $ST_DIR"
        git clone --depth 1 --single-branch --branch "$ST_BRANCH" "$ST_REPO_URL" "$ST_DIR"
        assert_checkout
    fi
    install_node_modules force
    install_shortcut
    info '安装完成。以后输入 st 即可管理。'
}

backup_data() {
    assert_checkout
    assert_stopped
    local items=() item archive
    for item in data config.yaml secrets.json plugins public/scripts/extensions/third-party; do
        [[ ! -e "$ST_DIR/$item" ]] || items+=("$item")
    done
    if (( ${#items[@]} == 0 )); then
        info '还没有需要备份的数据。'
        return
    fi
    # A failed archive is retained as .partial, never advertised as a backup.
    (
        umask 077
        mkdir -p -- "$ST_BACKUP_DIR"
        archive="$ST_BACKUP_DIR/backup-$(date +%Y%m%d-%H%M%S)-$$.tar.gz"
        tar -czf "$archive.partial" -C "$ST_DIR" -- "${items[@]}"
        mv -- "$archive.partial" "$archive"
        info "备份完成：$archive"
    )
}

update_app() {
    ensure_dependencies
    assert_checkout
    assert_stopped
    [[ -z "$(git -C "$ST_DIR" status --porcelain --untracked-files=normal)" ]] ||
        fail '手机端源码存在修改或未跟踪文件。请先提交/处理；不会自动覆盖、暂存或清理。'
    info '检查你自己的 GitHub main 分支……'
    git -C "$ST_DIR" fetch origin "refs/heads/$ST_BRANCH:refs/remotes/origin/$ST_BRANCH"
    if [[ "$(git -C "$ST_DIR" rev-parse HEAD)" == "$(git -C "$ST_DIR" rev-parse "origin/$ST_BRANCH")" ]]; then
        install_node_modules
        install_shortcut
        info '已是最新版本。输入 st start 启动。'
        return
    fi
    git -C "$ST_DIR" merge-base --is-ancestor HEAD "origin/$ST_BRANCH" ||
        fail '本地与远端历史已分叉，停止更新。请先人工检查，不会强制重置。'
    backup_data
    git -C "$ST_DIR" merge --ff-only "origin/$ST_BRANCH"
    install_node_modules
    install_shortcut
    info '更新完成。输入 st start 启动。'
}

start_app() {
    ensure_dependencies
    assert_checkout
    assert_stopped
    install_node_modules
    install_shortcut
    info "启动后在手机浏览器打开 http://127.0.0.1:$ST_PORT；Ctrl+C 停止。"
    info '只监听本机；保持 Termux 运行。生成中的请求不会由管理脚本自动重试。'
    (
        cd -- "$ST_DIR"
        # Record the actual Node PID so another manager terminal refuses updates.
        bash -c 'printf "%s\n" "$$" > .git/termux-server.pid; exec node server.js --listen false --browserLaunchEnabled false --dataRoot ./data --port "$1"' bash "$ST_PORT"
    )
}

show_status() {
    assert_checkout
    info "目录：$ST_DIR"
    git -C "$ST_DIR" log -1 --format='%h %cs %s'
    git -C "$ST_DIR" status --short --branch
    printf '\n备份目录：%s\n' "$ST_BACKUP_DIR"
}

menu() {
    local choice
    while true; do
        printf '\nSillyTavern Vertex\n1) 启动\n2) 更新（先备份）\n3) 备份\n4) 查看版本\n0) 退出\n'
        read -r -p '请选择 [1]: ' choice || return 0
        case "${choice:-1}" in
            1) start_app ;;
            2) update_app ;;
            3) backup_data ;;
            4) show_status ;;
            0) return ;;
            *) info '请输入 0 到 4。' ;;
        esac
    done
}

main() {
    local action="${1:-auto}"
    case "$action" in
        help|-h|--help) usage; return ;;
        auto|install|start|update|backup|status) ;;
        *) usage; fail "未知操作：$action" ;;
    esac
    require_termux
    case "$action" in
        auto)
            if [[ -e "$ST_DIR" || -L "$ST_DIR" ]]; then
                assert_checkout
                menu
            else
                install_app
                start_app
            fi ;;
        install) install_app ;;
        start) start_app ;;
        update) update_app ;;
        backup) backup_data ;;
        status) show_status ;;
    esac
}

# Sourcing is only used by the isolated shell tests.
if [[ "${BASH_SOURCE[0]}" == "$0" ]]; then
    main "$@"
fi
