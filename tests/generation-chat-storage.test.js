import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { once } from 'node:events';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import express from 'express';
import { beforeEach, afterEach, test, expect } from '@jest/globals';
import { setConfigFilePath } from '../src/util.js';
import { chatAnchor } from '../public/scripts/util/chat-anchor.js';
import { createGenerationJobsRouter } from '../src/vertex-jobs.js';

setConfigFilePath(fileURLToPath(new URL('../default/config.yaml', import.meta.url)));
process.env.SILLYTAVERN_BACKUPS_CHAT_THROTTLEINTERVAL = '0';
const { trySaveChat } = await import('../src/endpoints/chats.js');
const post = body => ({ method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
const header = { chat_metadata: { integrity: 'original-chat' } };
const prompt = { is_user: true, name: 'User', send_date: 'today', mes: 'synthetic prompt', extra: {} };
const oldReply = { is_user: false, name: 'Speaker', send_date: 'earlier', mes: 'older answer', extra: {} };
const records = file => fs.readFileSync(file, 'utf8').split('\n').map(line => JSON.parse(line));
const write = (file, rows) => fs.writeFileSync(file, rows.map(row => JSON.stringify(row)).join('\n'));
let root, directories, server, url, finish, requests;

async function boot() {
    const app = express();
    app.use(express.json(), (req, res, next) => { req.user = { profile: { handle: 'fixture' }, directories }; next(); });
    app.use(createGenerationJobsRouter({ openai: async (req, res) => {
        requests++;
        await new Promise(resolve => { finish = resolve; });
        res.send({ choices: [{ message: { content: 'completed while closed' } }] });
    } }).router);
    server = app.listen(0, '127.0.0.1');
    await once(server, 'listening');
    url = 'http://127.0.0.1:' + server.address().port;
}
async function shutdown() { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
beforeEach(async () => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'linpeak-chat-'));
    directories = { root, chats: path.join(root, 'chats'), groupChats: path.join(root, 'groups'), backups: path.join(root, 'backups') };
    for (const dir of [path.join(directories.chats, 'Speaker'), directories.groupChats, directories.backups]) fs.mkdirSync(dir, { recursive: true });
    requests = 0;
    await boot();
});
afterEach(async () => { await shutdown(); fs.rmSync(root, { recursive: true, force: true }); });

async function start(group = false, regenerate = false) {
    const file = path.join(group ? directories.groupChats : path.join(directories.chats, 'Speaker'), 'conversation.jsonl');
    const original = regenerate ? [header, prompt, oldReply] : [header, prompt];
    write(file, original);
    const target = { file: 'conversation', name: 'Speaker', avatar: 'Speaker.png', group, integrity: header.chat_metadata.integrity,
        anchor: chatAnchor(1, prompt), type: regenerate ? 'regenerate' : 'normal', replaced: regenerate ? chatAnchor(2, oldReply) : undefined };
    const reservation = await fetch(url, post({ target }));
    expect(reservation.status).toBe(201);
    const { id } = await reservation.json();
    expect((await fetch(url + '/' + id + '/start', post({ chat_completion_source: 'custom', model: 'original-model', stream: false }))).status).toBe(202);
    return { id, target, file, original };
}

async function waitFor(test) {
    for (let i = 0; i < 150; i++) { if (await test()) return; await delay(10); }
    throw new Error('Background write did not finish');
}

test.each([[false, false], [true, false], [false, true], [true, true]])('saves without a result or claim request (group %s, regenerate %s)', async (group, regenerate) => {
    const { id, target, file, original } = await start(group, regenerate);
    finish();
    await waitFor(() => records(file).at(-1).extra?.linpeak_job === id);
    expect(records(file)).toHaveLength(3);
    expect(records(file)[2]).toMatchObject({ name: 'Speaker', mes: 'completed while closed', extra: { api: 'custom', model: 'original-model' } });
    await expect(trySaveChat(original, file, false, 'fixture', 'Speaker', directories.backups)).rejects.toThrow();
    await shutdown();
    await boot(); // empty job map, same private chat files
    expect((await fetch(url + '/' + id)).status).toBe(404);
    expect(await (await fetch(url + '/saved/' + id, post(target))).json()).toEqual({ saved: true });
    const edited = records(file);
    expect(await trySaveChat(edited, file, false, 'fixture', 'Speaker', directories.backups)).toBe(id);
    expect(records(file)[0].chat_metadata.linpeak_revision).toBe(id);
    edited[2].mes = 'my edit';
    await trySaveChat(edited, file, false, 'fixture', 'Speaker', directories.backups);
    expect(records(file)[2].mes).toBe('my edit');
    expect(requests).toBe(1);
});

test('a concurrent edit survives, and its recovery copy is readable after a restart until dismissed', async () => {
    const { id, file } = await start(false, true);
    const changed = [header, prompt, { ...oldReply, extra: { manuallyEdited: true } }];
    write(file, changed);
    finish();
    await waitFor(async () => (await (await fetch(url + '/' + id)).json()).state === 'conflict');
    await shutdown();
    await boot();
    expect(records(file)).toEqual(changed);
    expect((await (await fetch(url + '/' + id)).json()).state).toBe('conflict');
    expect(await (await fetch(url + '/' + id + '/result')).json()).toMatchObject({ mes: 'completed while closed' });
    expect((await fetch(url + '/' + id, { method: 'DELETE' })).status).toBe(204);
    expect((await fetch(url + '/' + id)).status).toBe(404);
    expect(requests).toBe(1);
});

test('saving metadata from a second tab during generation preserves it on disk', async () => {
    const { id, file, original } = await start();
    original[0] = { chat_metadata: { ...header.chat_metadata, note: 'new metadata' } };
    write(file, original);
    finish();
    await waitFor(async () => (await (await fetch(url + '/' + id)).json()).state === 'conflict');
    expect(records(file)[0].chat_metadata.note).toBe('new metadata');
});

test('a legacy chat can receive its first integrity slug when the reply is written', async () => {
    const { prepareChatTarget, saveCompletedMessage } = await import('../src/generation-chat-storage.js');
    const file = path.join(directories.groupChats, 'legacy.jsonl');
    write(file, [{ user_name: 'unused', character_name: 'unused' }, prompt]);
    const target = prepareChatTarget(directories, { group: true, file: 'legacy', integrity: 'new-slug', name: 'Bot', type: 'normal', anchor: chatAnchor(1, prompt) });
    const reply = { mes: 'saved', extra: { linpeak_job: 'test' } };
    expect(await saveCompletedMessage({ profile: { handle: 'fixture' }, directories }, target, reply, () => true)).toBe(true);
    expect(records(file)[0].chat_metadata.integrity).toBe('new-slug');
});

test('cancelling before upstream completion leaves the original file intact', async () => {
    const { id, original, file } = await start();
    await fetch(url + '/' + id, { method: 'DELETE' });
    finish();
    await delay(30);
    expect(records(file)).toEqual(original);
});
