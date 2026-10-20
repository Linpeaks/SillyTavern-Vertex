import fs from 'node:fs';
import vm from 'node:vm';
import { expect, jest, test } from '@jest/globals';

jest.unstable_mockModule('../src/util.js', () => ({
    getConfigValue: (_key, fallback) => fallback,
    tryParse: value => { try { return JSON.parse(value); } catch { return undefined; } },
}));
const { convertGooglePrompt, postProcessPrompt, PROMPT_PROCESSING_TYPE } = await import('../src/prompt-converters.js');
const source = fs.readFileSync(new URL('../public/scripts/openai.js', import.meta.url), 'utf8');
const attachmentSource = fs.readFileSync(new URL('../public/scripts/chats.js', import.meta.url), 'utf8');

function fixture(sourceName = 'vertexai') {
    const settings = { chat_completion_source: sourceName, vertexai_model: 'gemini-4-argon', google_model: 'gemini-4-argon', media_inlining: true };
    const context = vm.createContext({ main_api: 'openai', oai_settings: settings,
        chat_completion_sources: { VERTEXAI: 'vertexai', MAKERSUITE: 'makersuite' } });
    vm.runInContext(source.match(/^export function isImageInliningSupported\([^]*?^}/m)[0].replace('export ', ''), context);
    return { settings, context };
}

for (const sourceName of ['vertexai', 'makersuite']) test(`Argon images require the explicit media setting on ${sourceName}`, () => {
    const { settings, context } = fixture(sourceName);
    expect(context.isImageInliningSupported()).toBe(true);
    settings.media_inlining = false;
    expect(context.isImageInliningSupported()).toBe(false);
    settings.media_inlining = true;
    context.main_api = 'textgenerationwebui';
    expect(context.isImageInliningSupported()).toBe(false);
});

test('existing supported models remain supported without enabling arbitrary future models', () => {
    const { settings, context } = fixture();
    settings.vertexai_model = 'gemini-3-pro';
    expect(context.isImageInliningSupported()).toBe(true);
    settings.vertexai_model = 'gemini-4-unknown';
    expect(context.isImageInliningSupported()).toBe(false);
});

test('a stored image reaches Google inlineData through the actual message and merge_tools converters', async () => {
    const bytes = Buffer.from('synthetic-image-bytes');
    const dataUrl = 'data:image/png;base64,' + bytes.toString('base64');
    const fetch = jest.fn(async () => ({ ok: true, blob: async () => bytes }));
    const context = vm.createContext({ fetch, getBase64Async: async value => 'data:image/png;base64,' + value.toString('base64'),
        isDataURL: value => value.startsWith('data:'), oai_settings: { inline_image_quality: 'auto' } });
    const methods = ['ensureContentIsArray', 'addImage'].map(name => source.match(new RegExp(`^    (?:async )?${name}\\([^]*?^    }`, 'm'))[0]).join('\n');
    vm.runInContext(`class Message { content = 'synthetic question'; tokens = 0; async compressImage(value) { return value; } async getImageTokenCost() { return 1; } ${methods} }; globalThis.message = new Message();`, context);
    await context.message.addImage('/synthetic-stored-image.png');
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(context.message.content[1].image_url.url).toBe(dataUrl);
    const names = { charName: '', userName: '', startsWithGroupName: () => false };
    const messages = [{ role: 'user', content: context.message.content }];
    const body = convertGooglePrompt(postProcessPrompt(messages, PROMPT_PROCESSING_TYPE.MERGE_TOOLS, names), 'gemini-4-argon', false, names);
    expect(body.contents[0].parts).toContainEqual({ inlineData: { mimeType: 'image/png', data: bytes.toString('base64') } });
});

for (const enabled of [true, false]) test(`an unsupported image attachment warns once per batch and preserves settings (enabled=${enabled})`, () => {
    // Execute the upload preflight up to the first conversion/upload, using real source.
    const fn = attachmentSource.match(/^export async function populateFileAttachment\([^]*?^}/m)[0];
    const preflight = fn.slice(fn.indexOf('        if (main_api === \'openai\''), fn.indexOf('        if (nativePdf)'));
    const warning = jest.fn();
    const settings = { media_inlining: enabled };
    const context = vm.createContext({ main_api: 'openai', oai_settings: settings,
        fileInput: { files: [{ type: 'image/png' }, { type: 'image/jpeg' }] },
        isImageInliningSupported: () => false, toastr: { warning }, t: strings => strings[0] });
    vm.runInContext(preflight, context);
    expect(warning).toHaveBeenCalledTimes(1);
    expect(warning.mock.calls[0][0]).toContain(enabled ? 'does not support' : 'Enable Send inline media');
    expect(settings.media_inlining).toBe(enabled);
});
