import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const cwd = fileURLToPath(new URL('../', import.meta.url));
const git = (...args) => execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'inherit'] }).trim();

function checkCheckout() {
    if (git('branch', '--show-current') !== 'main') throw new Error('Switch to personal main before updating.');
    const origin = git('remote', 'get-url', 'origin');
    if (!/^(?:https:\/\/github\.com\/|git@github\.com:)Linpeaks\/SillyTavern-Vertex(?:\.git)?\/?$/i.test(origin)) {
        throw new Error('Expected origin to point to Linpeaks/SillyTavern-Vertex.');
    }
    if (git('status', '--porcelain', '--untracked-files=normal')) {
        throw new Error('Local changes detected. Review git status and save your work before updating.');
    }
}

try {
    checkCheckout();
    git('fetch', '--no-tags', 'origin', 'refs/heads/main:refs/remotes/origin/main');
    const target = git('rev-parse', 'refs/remotes/origin/main');
    checkCheckout();
    try {
        git('merge-base', '--is-ancestor', 'HEAD', target);
    } catch {
        throw new Error('Local main has unpublished commits. Review git status before updating.');
    }
    console.log(git('merge', '--ff-only', target));
} catch (error) {
    console.error(error.message);
    process.exitCode = 1;
}
