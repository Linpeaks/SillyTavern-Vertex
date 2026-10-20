import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import vm from 'node:vm';
import { afterEach, beforeAll, beforeEach, expect, jest, test } from '@jest/globals';

process.env.SILLYTAVERN_BACKUPS_CHAT_ENABLED = 'false';
process.env.SILLYTAVERN_BACKUPS_CHAT_THROTTLEINTERVAL = '0';
process.env.SILLYTAVERN_BACKUPS_CHAT_MAXTOTALBACKUPS = '-1';
process.env.SILLYTAVERN_BACKUPS_CHAT_CHECKINTEGRITY = 'true';
let getChatData;
let root;
beforeAll(async () => ({ getChatData } = await import('../src/endpoints/chats.js')));
beforeEach(() => { root = fs.mkdtempSync(path.join(os.tmpdir(), 'st-new-chat-')); });
afterEach(() => {
    jest.restoreAllMocks();
    if (path.dirname(root) !== path.resolve(os.tmpdir()) || !path.basename(root).startsWith('st-new-chat-')) throw new Error('Unsafe cleanup');
    fs.rmSync(root, { recursive: true, force: true });
});

test('a declared new chat may be absent without warning or creating a file', () => {
    const warning = jest.spyOn(console, 'warn').mockImplementation(() => {});
    const file = path.join(root, 'new.jsonl');
    expect(getChatData(file, { allowMissing: true })).toEqual([]);
    expect(warning).not.toHaveBeenCalled();
    expect(fs.existsSync(file)).toBe(false);
});

test('ordinary missing files and existing empty files still warn', () => {
    const warning = jest.spyOn(console, 'warn').mockImplementation(() => {});
    const file = path.join(root, 'existing.jsonl');
    expect(getChatData(file)).toEqual([]);
    fs.writeFileSync(file, '');
    expect(getChatData(file, { allowMissing: true })).toEqual([]);
    expect(warning).toHaveBeenCalledTimes(2);
});

test('new-chat option cannot erase or replace existing valid content', () => {
    const file = path.join(root, 'existing.jsonl');
    const bytes = '{"chat_metadata":{"integrity":"synthetic"}}\n{"mes":"synthetic greeting"}';
    fs.writeFileSync(file, bytes);
    expect(getChatData(file, { allowMissing: true })).toEqual([{ chat_metadata: { integrity: 'synthetic' } }, { mes: 'synthetic greeting' }]);
    expect(fs.readFileSync(file, 'utf8')).toBe(bytes);
});

test('the explicit new-chat workflow declares the first read as new', async () => {
    const source = fs.readFileSync(new URL('../public/script.js', import.meta.url), 'utf8');
    const getChat = jest.fn();
    const context = vm.createContext({
        selected_group: null, this_chid: 0, menu_type: '', isChatSaving: false,
        waitUntilCondition: async predicate => predicate(), debounce_timeout: { extended: 0 },
        clearChat: async () => {}, getCurrentChatDetails: () => ({ sessionName: 'old' }),
        chat_file_for_del: null, chat_metadata: {}, characters: [{}], name2: 'Synthetic',
        humanizedDateTime: () => 'new-date', $: () => ({ val() {} }), getChat,
        createOrEditCharacter: async () => {}, CustomEvent: class {},
    });
    vm.runInContext(source.match(/^export async function doNewChat\([^]*?^}/m)[0].replace('export ', ''), context);
    await context.doNewChat();
    expect(getChat).toHaveBeenCalledWith({ allowMissing: true });
});
