import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import sanitize from 'sanitize-filename';
import { sync as writeFileAtomic } from 'write-file-atomic';
import { chatAnchor } from '../public/scripts/util/chat-anchor.js';
import { isPathUnderParent } from './util.js';

function locate(directories, target) {
    const { file, avatar, group } = target;
    if (typeof group !== 'boolean' || typeof file !== 'string' || !file || /[/\\\0]/.test(file)) throw new Error('Invalid chat name');
    const base = group ? directories.groupChats : directories.chats;
    const card = group ? file : typeof avatar === 'string' && avatar.replace('.png', '');
    if (!card || /[/\\\0]/.test(card) || card === '.' || card === '..') throw new Error('Invalid chat owner');
    const name = sanitize(file + '.jsonl');
    if (!name || name === '.jsonl') throw new Error('Invalid chat name');
    const location = path.join(base, group ? '' : card, name);
    if (!isPathUnderParent(fs.realpathSync(base), fs.realpathSync(location))) throw new Error('Invalid chat location');
    return { location, card };
}

function readChat(location) {
    // Parse strictly. A malformed line must never disappear during a background save.
    const raw = fs.readFileSync(location, 'utf8');
    const rows = raw.replace(/^\uFEFF/, '').trimEnd().split(/\r?\n/).map(line => JSON.parse(line));
    return { raw, rows };
}

function fingerprint(raw) {
    return createHash('sha256').update(raw).digest('hex');
}

function placement(rows, target) {
    const count = rows.length - 1;
    const anchor = n => chatAnchor(n, n ? rows[n] : undefined);
    const header = rows[0];
    if (!header || (!header.chat_metadata && !Object.hasOwn(header, 'user_name') && !Object.hasOwn(header, 'character_name'))) return;
    if (!target.integrity || (header.chat_metadata?.integrity && header.chat_metadata.integrity !== target.integrity)) return;
    if (target.anchor === anchor(count)) return 'append';
    if (count > 0 && target.type === 'regenerate' && !rows[count].is_user &&
        target.replaced === anchor(count) && target.anchor === anchor(count - 1)) return 'replace';
}

export function prepareChatTarget(directories, input) {
    const { file, avatar, name, group, integrity, anchor, replaced, type, revision, groupGenerationId, showThoughts, model, source } = input;
    if (!['normal', 'regenerate'].includes(type) || typeof name !== 'string' || name.length > 1024) throw new Error('Invalid reply destination');
    const target = { file, avatar, name, group, integrity, anchor, replaced, type, revision, groupGenerationId, showThoughts: !!showThoughts, model: String(model ?? ''), source: String(source ?? '') };
    const { location } = locate(directories, target);
    const { rows, raw } = readChat(location);
    if (!placement(rows, target) || (rows[0].chat_metadata?.linpeak_revision ?? null) !== (revision ?? null)) throw new Error('The original chat changed');
    return { ...target, fingerprint: fingerprint(raw) };
}

export async function saveCompletedMessage(user, target, message, stillActive) {
    const { withChatWriteLock, writeChatFile } = await import('./endpoints/chats.js');
    const { location, card } = locate(user.directories, target);
    return withChatWriteLock(location, () => {
        if (!stillActive()) return false;
        locate(user.directories, target);
        const { rows, raw } = readChat(location);
        const action = placement(rows, target);
        if (!action || fingerprint(raw) !== target.fingerprint ||
            (rows[0].chat_metadata?.linpeak_revision ?? null) !== (target.revision ?? null)) return false;
        if (action === 'replace') rows.pop();
        rows.push(message);
        rows[0].chat_metadata ??= {};
        rows[0].chat_metadata.integrity = target.integrity;
        rows[0].chat_metadata.linpeak_revision = message.extra.linpeak_job;
        writeChatFile(rows, location, user.profile.handle, card, user.directories.backups);
        return true;
    });
}

export function hasSavedMessage(directories, target, id) {
    try {
        const { rows } = readChat(locate(directories, target).location);
        return rows[0]?.chat_metadata?.integrity === target.integrity && rows.slice(1).some(row => row.extra?.linpeak_job === id);
    } catch { return false; }
}

// Only unresolved conflicts keep a separate private copy. Explicit dismissal removes it.
export function recoveryFile(directories, id) {
    if (!directories?.root || !/^[\da-f]{8}-(?:[\da-f]{4}-){3}[\da-f]{12}$/i.test(id)) return;
    return path.join(directories.root, 'generation-recovery', id + '.json');
}

export function storeRecovery(directories, id, message) {
    const file = recoveryFile(directories, id);
    fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
    writeFileAtomic(file, JSON.stringify(message), { mode: 0o600 });
}
