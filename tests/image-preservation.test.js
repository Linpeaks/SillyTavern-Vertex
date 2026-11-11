import fs from 'node:fs';
import vm from 'node:vm';
import { webcrypto } from 'node:crypto';
import { expect, jest, test } from '@jest/globals';
import { preserveMediaParts, mediaPartSignatures, assertMediaParts, getGoogleProtectedMediaTypes } from '../public/scripts/media-preservation.js';

const image = label => ({ type: 'image_url', image_url: { url: `data:image/png;base64,${Buffer.from(label).toString('base64')}`, detail: 'auto' } });
const textOnly = messages => messages.map(message => ({ ...message,
    content: JSON.stringify({ history: Array.isArray(message.content) ? message.content.filter(part => part.type === 'text').map(part => part.text).join('\n') : message.content }),
}));

test('a text-only preset reproduces image loss; preservation restores both images in order', async () => {
    const before = [{ role: 'user', content: [{ type: 'text', text: 'before' }, image('one'), { type: 'text', text: 'between' }, image('two')] }];
    expect(mediaPartSignatures(textOnly(before))).toHaveLength(0);
    let messages = structuredClone(before);
    await preserveMediaParts(() => messages, async () => { messages = textOnly(messages); });
    expect(mediaPartSignatures(messages)).toEqual(mediaPartSignatures(before));
    expect(messages[0].content.filter(part => part.type === 'image_url')).toEqual([image('one'), image('two')]);
    expect(JSON.stringify(messages)).not.toContain('ST_IMAGE_');
    expect(messages[0].content[0].text).toContain('before');
    expect(messages[0].content[2].text).toContain('between');
});

test('multiple messages, duplicate images, tool metadata and PDF references survive', async () => {
    const messages = [{ role: 'user', content: [image('same'), image('same'), { type: 'text', text: '[[ST_NATIVE_PDF:synthetic]]' }] },
        { role: 'assistant', content: 'text', tool_calls: [{ id: 'synthetic', function: { name: 'emit', arguments: '{}' } }], signature: 'synthetic' },
        { role: 'user', content: [image('three')] }];
    const before = structuredClone(messages);
    await preserveMediaParts(() => messages, async () => {});
    expect(messages).toEqual(before);
});

for (const action of ['remove', 'duplicate', 'damage']) test(`a preset that ${action}s an image reference stops generation`, async () => {
    const messages = [{ role: 'user', content: [image('one')] }];
    const submitted = jest.fn();
    await expect((async () => {
        await preserveMediaParts(() => messages, async () => {
            const marker = messages[0].content[0].text;
            messages[0].content = action === 'remove' ? 'removed' : action === 'duplicate' ? marker + marker : marker.slice(0, -1);
        });
        submitted();
    })()).rejects.toThrow(/removed or duplicated/);
    expect(submitted).not.toHaveBeenCalled();
});

test('a failed event restores attached images and preserves the original error', async () => {
    const messages = [{ role: 'user', content: [image('one')] }];
    const failure = new Error('synthetic event failure');
    await expect(preserveMediaParts(() => messages, async () => { throw failure; })).rejects.toBe(failure);
    expect(messages[0].content).toEqual([image('one')]);
});

test('text-only messages and an unrelated marker remain unchanged', async () => {
    const messages = [{ role: 'user', content: '[[ST_IMAGE_other_0]] text' }];
    const before = structuredClone(messages);
    await preserveMediaParts(() => messages, async () => {});
    expect(messages).toEqual(before);
});

test('later-event checks catch image loss and replacement without exposing image content', () => {
    const expected = mediaPartSignatures([{ content: [image('one')] }]);
    expect(() => assertMediaParts(expected, [{ content: [image('one')] }])).not.toThrow();
    expect(() => assertMediaParts(expected, [{ content: 'text only' }])).toThrow(/changed image attachments/);
    expect(() => assertMediaParts(expected, [{ content: [image('two')] }])).toThrow(/changed image attachments/);
});

test('the real GENERATE_AFTER_DATA hook protects the enabled Google preset only', async () => {
    const source = fs.readFileSync(new URL('../public/script.js', import.meta.url), 'utf8');
    const start = source.indexOf('    const processGenerationData =');
    const block = source.slice(start, source.indexOf('\n    if (dryRun)', start));
    const context = vm.createContext({
        crypto: webcrypto, preserveMediaParts, getGoogleProtectedMediaTypes, getChatCompletionModel: () => 'gemini-4-carbon', main_api: 'openai', dryRun: false,
        chat_completion_sources: { VERTEXAI: 'vertexai', MAKERSUITE: 'makersuite' },
        oai_settings: { chat_completion_source: 'vertexai', extensions: { SPreset: { ChatSquash: { squashed_post_script_enable: true } } } },
        generate_data: { prompt: [{ role: 'user', content: [image('one')] }] },
        event_types: { GENERATE_AFTER_DATA: 'after' },
        eventSource: { emit: async (_event, data) => { data.prompt = textOnly(data.prompt); } },
    });
    await vm.runInContext(`(async () => { ${block} })()`, context);
    expect(mediaPartSignatures(context.generate_data.prompt)).toHaveLength(1);
});
