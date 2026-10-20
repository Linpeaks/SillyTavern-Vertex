import fs from 'node:fs';
import vm from 'node:vm';
import { expect, jest, test } from '@jest/globals';
import * as references from '../public/scripts/native-pdf.js';

const source = fs.readFileSync(new URL('../public/scripts/chats.js', import.meta.url), 'utf8');
const functions = ['populateFileAttachment', 'appendFileContent'].map(name => source.match(new RegExp(`^export async function ${name}\\([^]*?^}`, 'm'))[0].replace(/^export /, '')).join('\n');
const file = { id: '00000000-0000-0000-0000-000000000001', sha256: '1'.repeat(64), pages: 2,
    size: 100, url: 'user/files/synthetic.pdf', name: '中文图表.pdf', mode: 'native' };

function fixture() {
    class Input { files = [{ type: 'application/pdf', name: '中文图表.pdf', size: 100 }]; }
    const input = new Input();
    const fetch = jest.fn(async () => ({ ok: true, json: async () => ({ ...file }) }));
    const getFileAttachment = jest.fn(async () => 'legacy extracted text');
    const deleteFileFromServer = jest.fn(async () => true);
    const getBase64Async = jest.fn(async () => 'data:application/pdf;base64,c3ludGhldGlj');
    const reset = jest.fn();
    const context = vm.createContext({
        ...references, HTMLInputElement: Input, document: { getElementById: () => input },
        $: () => ({ val: () => 'native', trigger: reset }),
        main_api: 'openai', oai_settings: { chat_completion_source: 'vertexai', vertexai_model: 'gemini-4-argon' },
        fetch, getFileAttachment, deleteFileFromServer, getBase64Async,
        getRequestHeaders: () => ({}), t: strings => strings[0], toastr: { error() {} },
    });
    vm.runInContext(functions, context);
    return { context, fetch, getFileAttachment, deleteFileFromServer, getBase64Async, input, reset };
}

test('native references retain filename and coexist with unchanged text attachments', async () => {
    const f = fixture();
    const message = { extra: { files: [{ ...file }, { url: 'legacy.txt' }, { text: 'cached text' }] } };
    expect(await f.context.appendFileContent(message, 'question')).toBe(`${file.name}\n${references.nativePdfMarker(file)}\n\nlegacy extracted text\n\ncached text\n\nquestion`);
    expect(f.getFileAttachment).toHaveBeenCalledTimes(1);
    expect(f.getFileAttachment).toHaveBeenCalledWith('legacy.txt');
    message.extra.files.splice(0, 1);
    expect(await f.context.appendFileContent(message, 'question')).not.toContain('ST_NATIVE_PDF');
});

test('native upload keeps only metadata in chat and resets mode via the form', async () => {
    const f = fixture();
    const message = { is_user: true, extra: {} };
    await f.context.populateFileAttachment(message);
    expect(f.fetch).toHaveBeenCalledTimes(1);
    expect(f.fetch.mock.calls[0][0]).toBe('/api/files/upload-pdf');
    expect(message.extra.files[0]).toMatchObject(file);
    expect(JSON.stringify(message)).not.toContain('c3ludGhldGlj');
    expect(f.reset).toHaveBeenCalledWith('reset');
});

test('a failed batch rolls back only its newly uploaded PDFs and rejects', async () => {
    const f = fixture();
    f.input.files.push({ type: 'application/pdf', name: 'broken.pdf', size: 100 });
    f.fetch.mockResolvedValueOnce({ ok: true, json: async () => file })
        .mockResolvedValueOnce({ ok: false, json: async () => ({ error: 'Invalid PDF' }) });
    const existing = { ...file, url: 'user/files/existing.pdf' };
    const message = { is_user: true, extra: { files: [existing] } };
    await expect(f.context.populateFileAttachment(message)).rejects.toThrow('Invalid PDF');
    expect(message.extra.files).toEqual([existing]);
    expect(f.deleteFileFromServer).toHaveBeenCalledTimes(1);
    expect(f.deleteFileFromServer).toHaveBeenCalledWith(file.url);
});

test('unsupported connection and file count stop before upload or conversion', async () => {
    const f = fixture();
    f.context.oai_settings.chat_completion_source = 'openai';
    await expect(f.context.populateFileAttachment({ is_user: true })).rejects.toThrow(/Vertex/);
    f.context.oai_settings.chat_completion_source = 'vertexai';
    f.input.files = Array(17).fill(f.input.files[0]);
    await expect(f.context.populateFileAttachment({ is_user: true })).rejects.toThrow(/16 attachments/);
    expect(f.fetch).not.toHaveBeenCalled();
    expect(f.getBase64Async).not.toHaveBeenCalled();
});
