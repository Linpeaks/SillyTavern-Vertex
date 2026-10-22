#!/usr/bin/env bash
# Isolated workflow checks: real temporary Git, synthetic data, no npm/network.
set -Eeuo pipefail

script_path="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd -P)/termux.sh"
scratch_parent="$(cd -- "${TMPDIR:-/tmp}" && pwd -P)"
test_root="$(mktemp -d "$scratch_parent/st-vertex-test.XXXXXX")"
passed=0
cleanup() {
    local resolved
    resolved="$(cd -- "$test_root" && pwd -P)"
    case "$resolved" in
        "$scratch_parent"/st-vertex-test.*) rm -rf -- "$resolved" ;;
        *) printf 'Refusing cleanup outside test directory: %s\n' "$resolved" >&2 ;;
    esac
}
trap cleanup EXIT

export TEST_ROOT="$test_root"
export TEST_SCRIPT="$script_path"
export PATH="$test_root/bin:$PATH"
mkdir -p "$test_root/bin"
cat > "$test_root/bin/npm" <<'MOCK'
#!/usr/bin/env bash
printf '%s\n' "$*" >> "$TEST_ROOT/npm-calls"
[[ "${TEST_NPM_FAIL:-0}" != 1 ]] || exit 42
mkdir -p node_modules
MOCK
cat > "$test_root/bin/node" <<'MOCK'
#!/usr/bin/env bash
case "${1:-}" in
    -e) exit 0 ;;
    -p)
        if [[ "$2" == process.arch ]]; then printf 'arm64\n'; else printf '24\n'; fi ;;
    server.js) printf '%s\n' "$*" >> "$TEST_ROOT/node-calls" ;;
    *) exit 90 ;;
esac
MOCK
chmod +x "$test_root/bin/npm" "$test_root/bin/node"

pass() { passed=$((passed + 1)); printf 'ok %s - %s\n' "$passed" "$*"; }
nope() { printf 'FAIL: %s\n' "$*" >&2; exit 1; }
commit_fixture() {
    git -C "$1" -c user.name='Synthetic Test' -c user.email='test@example.invalid' commit -qm "$2"
}
setup_fixture() {
    local case_name="$1"
    export HOME="$test_root/$case_name/home"
    export PREFIX="$test_root/$case_name/prefix"
    export TEST_REMOTE="file://$test_root/$case_name/remote"
    mkdir -p "$HOME" "$PREFIX/bin" "$test_root/$case_name/remote"
    printf '#!/usr/bin/env bash\nexit 0\n' > "$PREFIX/bin/pkg"
    chmod +x "$PREFIX/bin/pkg"
    remote_dir="$test_root/$case_name/remote"
    git init -q -b main "$remote_dir"
    git -C "$remote_dir" config core.autocrlf false
    git -C "$remote_dir" config core.hooksPath "$test_root/no-hooks"
    printf '{}\n' > "$remote_dir/package.json"
    printf '{"lockfileVersion":3}\n' > "$remote_dir/package-lock.json"
    printf 'synthetic source\n' > "$remote_dir/server.js"
    printf 'data/\nconfig.yaml\nsecrets.json\nplugins/\nnode_modules/\npublic/scripts/extensions/third-party/\n' > "$remote_dir/.gitignore"
    cp "$script_path" "$remote_dir/termux.sh"
    git -C "$remote_dir" add .
    commit_fixture "$remote_dir" initial
    app_dir="$HOME/SillyTavern-Vertex"
}
run_manager() {
    # Separate Bash preserves errexit even when the caller expects failure.
    bash -c 'source "$TEST_SCRIPT"; ST_REPO_URL="$TEST_REMOTE"; "$@"' bash "$@"
}
must_fail() {
    if run_manager "$@" > "$test_root/failure-output" 2>&1; then
        nope "Expected failure: $*"
    fi
}
add_data() {
    mkdir -p "$app_dir/data/default-user/files" "$app_dir/plugins" "$app_dir/public/scripts/extensions/third-party/demo"
    printf 'synthetic chat\n' > "$app_dir/data/chat.txt"
    printf 'synthetic pdf bytes\n' > "$app_dir/data/default-user/files/document.pdf"
    printf 'synthetic: config\n' > "$app_dir/config.yaml"
    printf 'synthetic secret\n' > "$app_dir/secrets.json"
    printf 'synthetic plugin\n' > "$app_dir/plugins/demo.js"
    printf 'synthetic extension\n' > "$app_dir/public/scripts/extensions/third-party/demo/index.js"
}
advance_remote() {
    printf 'updated source\n' >> "$remote_dir/server.js"
    git -C "$remote_dir" add server.js
    commit_fixture "$remote_dir" update
}

PREFIX='' bash "$script_path" help > "$test_root/help"
grep -q 'st update' "$test_root/help"
if PREFIX='' bash "$script_path" install > "$test_root/non-termux" 2>&1; then nope 'Non-Termux was accepted'; fi
pass 'help works anywhere; actual install rejects non-Termux'

setup_fixture install
run_manager main > "$test_root/install-output" 2>&1
[[ -d "$app_dir/.git" && -d "$app_dir/node_modules" ]] || nope 'fresh install missing'
[[ "$(git -C "$app_dir" branch --show-current)" == main ]] || nope 'wrong branch'
[[ -x "$PREFIX/bin/st" ]] || nope 'shortcut missing'
grep -q -- '--listen false --browserLaunchEnabled false --dataRoot ./data --port 8000' "$test_root/node-calls"
bash "$PREFIX/bin/st" help > "$test_root/shortcut-help"
pass 'default action clones main, installs dependencies, creates working shortcut, starts localhost server'

add_data
before_hash="$(git -C "$app_dir" hash-object data/chat.txt)"
run_manager install_app > "$test_root/reinstall-output" 2>&1
[[ "$(git -C "$app_dir" hash-object data/chat.txt)" == "$before_hash" ]] || nope 'data overwritten'
pass 'repeat install preserves existing data and private configuration'

calls_before="$(wc -l < "$test_root/npm-calls")"
run_manager update_app > "$test_root/current-output" 2>&1
[[ "$(wc -l < "$test_root/npm-calls")" == "$calls_before" ]] || nope 'unnecessary npm install'
[[ ! -e "$HOME/SillyTavern-Vertex-backups" ]] || nope 'unnecessary backup'
pass 'unchanged remote skips backup and reinstall'

advance_remote
run_manager update_app > "$test_root/update-output" 2>&1
[[ "$(git -C "$app_dir" rev-parse HEAD)" == "$(git -C "$remote_dir" rev-parse HEAD)" ]] || nope 'did not fast-forward'
[[ "$(git -C "$app_dir" hash-object data/chat.txt)" == "$before_hash" ]] || nope 'update lost data'
archive="$(find "$HOME/SillyTavern-Vertex-backups" -name '*.tar.gz' -print -quit)"
[[ -n "$archive" ]] || nope 'no backup'
tar -tzf "$archive" > "$test_root/archive-list"
for entry in data/chat.txt data/default-user/files/document.pdf config.yaml secrets.json plugins/demo.js public/scripts/extensions/third-party/demo/index.js; do
    grep -Fxq "$entry" "$test_root/archive-list" || nope "backup omitted $entry"
done
mkdir "$test_root/extracted"
tar -xzf "$archive" -C "$test_root/extracted"
cmp "$app_dir/data/chat.txt" "$test_root/extracted/data/chat.txt"
pass 'real fast-forward creates readable backup containing data, original attachment, config, secrets and extensions'

printf 'dirty\n' >> "$app_dir/server.js"
dirty_head="$(git -C "$app_dir" rev-parse HEAD)"
must_fail update_app
[[ "$(git -C "$app_dir" rev-parse HEAD)" == "$dirty_head" ]] || nope 'dirty branch moved'
git -C "$app_dir" restore server.js
printf 'untracked\n' > "$app_dir/local-source.js"
must_fail update_app
rm -- "$app_dir/local-source.js"
pass 'tracked and untracked source edits block updates without reset or stash'

git -C "$app_dir" remote set-url origin https://example.invalid/other.git
must_fail update_app
git -C "$app_dir" remote set-url origin "$TEST_REMOTE"
git -C "$app_dir" switch -qc other
must_fail update_app
git -C "$app_dir" switch -q main
pass 'wrong origin and wrong branch are rejected'

printf '%s\n' "$$" > "$app_dir/.git/termux-server.pid"
must_fail update_app
must_fail backup_data
rm -- "$app_dir/.git/termux-server.pid"
pass 'running managed server blocks update and backup'

printf '# custom st\n' > "$PREFIX/bin/st"
run_manager install_shortcut > "$test_root/collision-output" 2>&1
grep -Fxq '# custom st' "$PREFIX/bin/st"
pass 'unrelated st command is preserved'

setup_fixture existing
mkdir -p "$app_dir"
printf 'precious\n' > "$app_dir/keep.txt"
must_fail install_app
grep -Fxq precious "$app_dir/keep.txt"
pass 'pre-existing unrelated directory is never deleted or adopted'

setup_fixture divergence
run_manager install_app > "$test_root/diverge-install" 2>&1
printf 'local commit\n' > "$app_dir/local.js"
git -C "$app_dir" add local.js
commit_fixture "$app_dir" local
local_head="$(git -C "$app_dir" rev-parse HEAD)"
advance_remote
must_fail update_app
[[ "$(git -C "$app_dir" rev-parse HEAD)" == "$local_head" && -f "$app_dir/local.js" ]] || nope 'divergence lost local history'
pass 'diverged committed history is preserved and update stops'

setup_fixture backup-failure
run_manager install_app > "$test_root/backup-install" 2>&1
add_data
advance_remote
old_head="$(git -C "$app_dir" rev-parse HEAD)"
printf '#!/usr/bin/env bash\nexit 43\n' > "$test_root/bin/tar"
chmod +x "$test_root/bin/tar"
must_fail update_app
[[ "$(git -C "$app_dir" rev-parse HEAD)" == "$old_head" ]] || nope 'update continued after backup failure'
rm -- "$test_root/bin/tar"
pass 'backup failure prevents merging new source'

setup_fixture npm-failure
run_manager install_app > "$test_root/npm-install" 2>&1
add_data
printf '{"lockfileVersion":3,"test":1}\n' > "$remote_dir/package-lock.json"
git -C "$remote_dir" add package-lock.json
commit_fixture "$remote_dir" lock-update
export TEST_NPM_FAIL=1
must_fail update_app
[[ "$(git -C "$app_dir" hash-object data/chat.txt)" == "$before_hash" ]] || nope 'npm failure lost data'
unset TEST_NPM_FAIL
run_manager install_app > "$test_root/npm-repair" 2>&1
run_manager start_app > "$test_root/start-repaired" 2>&1
pass 'npm failure returns failure, preserves data and permits explicit install/repair'

setup_fixture download-failure
TEST_REMOTE="file://$test_root/does-not-exist"
must_fail install_app
[[ ! -e "$app_dir/data" ]] || nope 'failed clone created user data'
pass 'clone failure stops before package installation or server startup'

printf '\nAll %s isolated Termux manager checks passed.\n' "$passed"
