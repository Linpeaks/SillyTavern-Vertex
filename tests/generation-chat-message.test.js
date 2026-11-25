/* eslint-disable playwright/no-standalone-expect -- Jest test.each is not a Playwright test. */
import { describe, expect, test } from '@jest/globals';
import { generationChatMessage } from '../src/generation-chat-message.js';

const defaults = {
    id: 'synthetic-job', source: 'custom', mainApi: 'openai', model: 'test-model', stream: false,
    showThoughts: true, started: 1735689600000, finished: 1735689601000, name: 'Test character',
};
const sse = (...events) => events.map(event => `data: ${typeof event === 'string' ? event : JSON.stringify(event)}\n\n`).join('');
const jsonMessage = (data, job = {}) => generationChatMessage(JSON.stringify(data), { ...defaults, ...job });
const streamMessage = (body, job = {}) => generationChatMessage(Buffer.from(body), { ...defaults, stream: true, ...job });
const toolCall = (name, args, id = 'tool_synthetic') => ({ id, type: 'function', function: { name, arguments: args } });

test('projects a native assistant message with a stable group avatar and independent swipe metadata', () => {
    const message = jsonMessage({ choices: [
        { index: 1, message: { content: [{ type: 'text', text: 'Second choice' }], reasoning: 'Second thought' } },
        { index: 0, message: { content: '  First choice\n', reasoning_content: 'First thought' } },
    ] }, { group: true, avatar: '测试 character.png', groupGenerationId: 54 });

    expect(message).toMatchObject({
        name: 'Test character', is_user: false, mes: '  First choice\n', swipe_id: 0,
        original_avatar: '测试 character.png', force_avatar: '/thumbnail?type=avatar&file=%E6%B5%8B%E8%AF%95%20character.png',
        send_date: '2025-01-01T00:00:01.000Z', gen_started: '2025-01-01T00:00:00.000Z', gen_finished: '2025-01-01T00:00:01.000Z',
        swipes: ['  First choice\n', 'Second choice'],
        extra: { api: 'custom', model: 'test-model', reasoning: 'First thought', gen_id: 54, linpeak_job: 'synthetic-job', linpeak_autosaved: true },
    });
    expect(message.swipe_info[0].extra).toEqual(message.extra);
    expect(message.swipe_info[0].extra).not.toBe(message.extra);
    expect(message.swipe_info[1].extra.reasoning).toBe('Second thought');
});

describe('Google completions', () => {
    test('renders all text parts and safe attachments from the normal backend wrapper', () => {
        const message = jsonMessage({ choices: [{ message: { content: 'fallback' } }], responseContent: { parts: [
            { text: '思考', thought: true },
            { text: '正文第一段', thoughtSignature: 'text-signature' },
            { text: '正文第二段' },
            { inlineData: { mimeType: 'image/png', data: 'aW1hZ2U=' } },
            { inlineData: { mimeType: 'image/png', data: 'aGlkZGVu' }, thought: true },
            { inlineData: { mimeType: 'image/svg+xml', data: 'c3Zn' } },
        ] } }, { source: 'vertexai', showThoughts: false });
        expect(message.mes).toBe('正文第一段\n\n正文第二段');
        expect(message.extra).toMatchObject({ reasoning: '', reasoning_signature: 'text-signature', inline_image: true,
            media: [{ url: 'data:image/png;base64,aW1hZ2U=', type: 'image', source: 'api' }] });
    });

    test('keeps streamed candidate indexes, signatures, complete arguments, and readable tool-only prose', () => {
        const message = streamMessage(': keepalive\r\n\r\n' +
            'data: {"candidates":[{"index":0,"content":{"parts":\r\ndata: [{"text":"思考","thought":true}]}}]}\r\n\r\n' + sse(
            { candidates: [{ index: 1, content: { parts: [{ text: 'Alternative' }] }, finishReason: 'STOP' }] },
            { candidates: [{ index: 0, content: { parts: [{ thoughtSignature: 'signed-call', functionCall: {
                id: 'provider-call', name: 'write_story', args: { body: '# Chapter\n\n正文', chapter: 1 },
            } }] }, finishReason: 'STOP' }] },
        ), { source: 'makersuite' });

        expect(message.swipes).toEqual(['# Chapter\n\n正文', 'Alternative']);
        expect(message.extra).toMatchObject({ reasoning: '思考', pending_tool_calls: [{
            id: 'provider-call', googleCallId: 'provider-call', signature: 'signed-call',
            function: { name: 'write_story', arguments: { body: '# Chapter\n\n正文', chapter: 1 } },
        }] });
        expect(message.extra).not.toHaveProperty('tool_invocations');
        expect(message.swipe_info[1].extra).not.toHaveProperty('pending_tool_calls');
    });

    test('accepts multiple native JSON candidates with per-candidate images and thoughts', () => {
        const message = jsonMessage({ candidates: [
            { index: 0, content: { parts: [{ text: 'first' }] }, finishReason: 'STOP' },
            { index: 1, content: { parts: [{ text: 'second' }, { text: 'reasoning', thought: true }, { inlineData: { mimeType: 'image/jpeg', data: 'aW1hZ2U=' } }] } },
        ] }, { source: 'vertexai' });
        expect(message.swipes).toEqual(['first', 'second']);
        expect(message.swipe_info[1].extra).toMatchObject({ reasoning: 'reasoning', media: [{ url: 'data:image/jpeg;base64,aW1hZ2U=' }] });
    });

    test.each([
        [{ functionCall: { name: 'write_story', partialArgs: [{ jsonPath: '$.body', stringValue: 'fragment' }], willContinue: true } }, 'STOP'],
        [{ functionCall: { name: 'write_story', args: { body: 'looks complete' } } }, undefined],
        [{ functionCall: { name: 'write_story', args: { body: 'looks complete' } } }, 'MAX_TOKENS'],
    ])('rejects an unverified or partial streamed Google tool call', (part, finishReason) => {
        expect(() => streamMessage(sse({ candidates: [{ content: { parts: [part] }, finishReason }] }), { source: 'vertexai' })).toThrow('incomplete reply');
    });
});

describe('OpenAI-compatible completions', () => {
    test('assembles a complete indexed tool call and preserves reasoning and late OpenRouter tool signatures', () => {
        const message = streamMessage(sse(
            { choices: [{ index: 1, delta: { content: 'Second' }, finish_reason: 'stop' }, { index: 0, delta: { reasoning: 'Thinking' } }] },
            { choices: [{ index: 0, delta: { tool_calls: [{ index: 2, ...toolCall('write_story', '{"body":"first') }] } }] },
            { choices: [{ index: 0, delta: { tool_calls: [{ index: 2, ...toolCall('write_story', '\\nsecond"}') }] } }] },
            { choices: [{ index: 0, delta: { reasoning_details: [
                { type: 'reasoning.encrypted', id: 'tool_synthetic', data: 'tool-signature' },
                { type: 'reasoning.encrypted', id: 'thought', data: 'reasoning-signature' },
            ] }, finish_reason: 'tool_calls' }] }, '[DONE]',
        ), { source: 'openrouter' });
        expect(message.swipes).toEqual(['first\nsecond', 'Second']);
        expect(message.extra).toMatchObject({ reasoning: 'Thinking', reasoning_signature: 'reasoning-signature', pending_tool_calls: [{
            id: 'tool_synthetic', signature: 'tool-signature', function: { name: 'write_story', arguments: '{"body":"first\\nsecond"}' },
        }] });
    });

    test('keeps visible text and images alongside tools, and presents structured tool-only replies as arguments', () => {
        const message = jsonMessage({ choices: [
            { message: { content: 'Image caption', images: [
                { type: 'image_url', image_url: { url: 'data:image/webp;base64,aW1hZ2U=' } },
                { type: 'image_url', image_url: { url: 'https://example.invalid/image.png' } },
            ], tool_calls: [toolCall('select_scene', '{"choice":2}')] } },
            { message: { tool_calls: [toolCall('select_scene', '{"choice":3}')] }, finish_reason: 'tool_calls' },
        ] }, { source: 'openrouter' });
        expect(message.mes).toBe('Image caption');
        expect(message.swipes[1]).toBe('```json\n{\n  "select_scene": {\n    "choice": 3\n  }\n}\n```');
        expect(message.extra.media).toEqual([{ url: 'data:image/webp;base64,aW1hZ2U=', type: 'image', source: 'api' }]);
        expect(message.swipe_info[1].extra).not.toHaveProperty('media');
    });

    test.each([
        ['{"body":"valid"}', undefined, ''],
        ['{"body":', 'tool_calls', '[DONE]'],
        ['{"body":"valid"}', 'length', '[DONE]'],
        ['null', 'tool_calls', '[DONE]'],
        [undefined, 'tool_calls', '[DONE]'],
    ])('rejects an unverified, truncated, or malformed tool call', (args, finish_reason, terminator) => {
        const events = [{ choices: [{ delta: { tool_calls: [toolCall('write_story', args)] }, finish_reason }] }];
        if (terminator) events.push(terminator);
        expect(() => streamMessage(sse(...events))).toThrow('incomplete reply');
    });
});

describe('Claude and Cohere', () => {
    test('reads Claude wrapped and native JSON content blocks', () => {
        const content = [
            { type: 'thinking', thinking: 'A thought', signature: 'opaque' },
            { type: 'text', text: 'Part 1' }, { type: 'text', text: 'Part 2' },
            { type: 'tool_use', id: 'toolu_1', name: 'post_script', input: { text: 'A tool argument' } },
        ];
        for (const data of [{ content }, { content, choices: [{ message: { content: 'Part 1' } }] }]) {
            const message = jsonMessage(data, { source: 'claude' });
            expect(message.mes).toBe('Part 1\n\nPart 2');
            expect(message.extra).toMatchObject({ reasoning: 'A thought', reasoning_signature: 'opaque', pending_tool_calls: [{
                id: 'toolu_1', function: { name: 'post_script', arguments: { text: 'A tool argument' } },
            }] });
        }
    });

    test('assembles Claude input JSON and signature fragments and requires a complete tool block', () => {
        const frames = [
            { type: 'content_block_start', index: 0, content_block: { type: 'thinking', thinking: '' } },
            { type: 'content_block_delta', index: 0, delta: { type: 'thinking_delta', thinking: 'A reason' } },
            { type: 'content_block_delta', index: 0, delta: { type: 'signature_delta', signature: 'first' } },
            { type: 'content_block_delta', index: 0, delta: { type: 'signature_delta', signature: 'second' } },
            { type: 'content_block_stop', index: 0 },
            { type: 'content_block_start', index: 1, content_block: { type: 'tool_use', id: 'toolu_1', name: 'post_script', input: {} } },
            { type: 'content_block_delta', index: 1, delta: { type: 'input_json_delta', partial_json: '{"text":' } },
            { type: 'content_block_delta', index: 1, delta: { type: 'input_json_delta', partial_json: '"Claude draft"}' } },
        ];
        const stopped = 'event: message_stop\rdata: {}\r\r';
        const job = { source: 'claude' };
        const message = streamMessage(sse(...frames, { type: 'content_block_stop', index: 1 }) + stopped, job);
        expect(message.mes).toBe('Claude draft');
        expect(message.extra).toMatchObject({ reasoning: 'A reason', reasoning_signature: 'firstsecond', pending_tool_calls: [{
            id: 'toolu_1', function: { name: 'post_script', arguments: { text: 'Claude draft' } },
        }] });
        expect(() => streamMessage(sse(...frames) + stopped, job)).toThrow('incomplete reply');
    });

    test('uses Cohere answer content and stores tool plan arguments for both stream and non-stream responses', () => {
        const call = toolCall('write_story', '{"body":"Cohere draft"}');
        const normal = jsonMessage({ message: { content: [{ type: 'text', text: 'Cohere answer' }], tool_plan: 'Plan', tool_calls: [call] } }, { source: 'cohere' });
        expect(normal.mes).toBe('Cohere answer');
        expect(normal.extra.pending_tool_calls).toEqual([{ id: call.id, function: call.function }]);

        const frames = [
            { type: 'message-start', delta: { message: { role: 'assistant' } } },
            { type: 'tool-plan-delta', delta: { message: { tool_plan: 'Plan' } } },
            { type: 'tool-call-start', index: 1, delta: { message: { tool_calls: toolCall('write_story', '') } } },
            { type: 'tool-call-delta', index: 1, delta: { message: { tool_calls: { function: { arguments: '{"body":' } } } } },
            { type: 'tool-call-delta', index: 1, delta: { message: { tool_calls: { function: { arguments: '"Cohere draft"}' } } } } },
        ];
        const end = { type: 'message-end', delta: { finish_reason: 'COMPLETE' } };
        const message = streamMessage(sse(...frames,
            { type: 'tool-call-end', index: 1 },
            end,
        ), { source: 'cohere' });
        expect(message.mes).toBe('Cohere draft');
        expect(message.extra.pending_tool_calls).toEqual(normal.extra.pending_tool_calls);
        expect(() => streamMessage(sse(...frames, end), { source: 'cohere' })).toThrow('incomplete reply');
    });
});

describe('text completions', () => {
    test.each([
        ['kobold', { results: [{ text: 'The text' }] }],
        ['novel', { output: 'The text' }],
        ['koboldhorde', { text: 'The text' }],
        ['textgenerationwebui', [{ content: 'The text' }]],
        ['textgenerationwebui', { response: 'The text' }],
        ['textgenerationwebui', { choices: [{ text: 'The text' }] }],
    ])('decodes %s JSON', (mainApi, data) => {
        expect(jsonMessage(data, { mainApi, source: mainApi }).mes).toBe('The text');
    });

    test.each(['kobold', 'novel'])('decodes %s token stream terminated by EOF', mainApi => {
        expect(streamMessage(sse({ token: 'The ' }, { token: 'text' }), { mainApi, source: mainApi }).mes).toBe('The text');
    });

    test('keeps alternative textgen indexes, reasoning and all UTF-8 tokens', () => {
        const message = streamMessage(sse(
            { choices: [{ index: 0, text: '中', thinking: '想' }] },
            { choices: [{ index: 2, text: 'Another' }, { index: 0, text: '文' }] },
            { choices: [{ index: 2, text: ' reply' }] }, '[DONE]',
        ), { mainApi: 'textgenerationwebui', source: 'ollama', showThoughts: false });
        expect(message.swipes).toEqual(['中文', 'Another reply']);
        expect(message.extra.reasoning).toBe('想');
    });

    test('uses the actual Horde worker attribution and model', () => {
        const message = jsonMessage({ text: 'Horde reply', workerName: 'Synthetic worker [actual]', model: 'actual' }, { mainApi: 'koboldhorde', source: 'koboldhorde' });
        expect(message).toMatchObject({ mes: 'Horde reply', title: 'Synthetic worker [actual]', extra: { api: 'koboldhorde', model: 'actual' } });
    });
});

test('throws on HTTP, provider, malformed stream and empty reply failures', () => {
    const valid = { choices: [{ message: { content: 'valid' } }] };
    expect(() => jsonMessage(valid, { statusCode: 502 })).toThrow('HTTP 502');
    expect(() => jsonMessage({ ...valid, error: { message: 'Synthetic error' } })).toThrow('generation error');
    expect(() => streamMessage('event: error\ndata: {}\n\n')).toThrow('generation error');
    expect(() => streamMessage(sse({ choices: [{ delta: { content: 'partial' } }] }) + 'data: {')).toThrow('incomplete reply');
    expect(() => jsonMessage({ choices: [{ message: { content: '', reasoning: 'hidden' } }] }, { showThoughts: false })).toThrow('incomplete reply');
});
