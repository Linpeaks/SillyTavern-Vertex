import fs from 'node:fs';
import vm from 'node:vm';
import util from 'node:util';
import { EventEmitter } from 'node:events';
import { beforeAll, describe, expect, jest, test } from '@jest/globals';
import { Response } from 'node-fetch';
import * as constants from '../src/constants.js';
import * as geminiModels from '../public/scripts/gemini-models.js';

jest.unstable_mockModule('../src/util.js', () => ({
    getConfigValue: (_key, fallback) => fallback,
    tryParse: value => { try { return JSON.parse(value); } catch { return undefined; } },
}));

let converters;
beforeAll(async () => {
    converters = await import('../src/prompt-converters.js');
});

// Exercise the entire production handler, with unrelated authentication/server imports
// isolated. No credentials, user settings, or Google requests are used by these tests.
const source = fs.readFileSync(new URL('../src/endpoints/backends/chat-completions.js', import.meta.url), 'utf8');
const handlerSource = source.match(/^async function sendMakerSuiteRequest\([^]*?^}/m)?.[0];
if (!handlerSource) throw new Error('Google request handler not found');

const gemini4Models = ['gemini-4-argon', 'gemini-4-carbon', 'gemini-4-hydrogen'];

async function makeRequest(sourceName, effort, includeThoughts, overrides = {}, result = null, expectedStatus = 200) {
    const fetchMock = jest.fn(async () => new Response(JSON.stringify(result ?? {
        candidates: [{ content: { parts: [{ text: 'synthetic reply' }] } }],
    }), { status: 200 }));
    const forward = jest.fn(async (upstream, response) => response.send(await upstream.json()));
    const context = vm.createContext({
        ...constants, ...converters, ...geminiModels, URL, AbortController, util,
        API_VERTEX_AI: 'https://aiplatform.googleapis.com',
        API_MAKERSUITE: 'https://generativelanguage.googleapis.com',
        getConfigValue: (_key, fallback) => fallback,
        getVertexAIAuth: async request => ({ authType: request.body.vertexai_auth_mode || 'full', authHeader: 'Bearer synthetic' }),
        getProjectIdFromServiceAccount: account => account.project_id,
        SECRET_KEYS: { VERTEXAI_SERVICE_ACCOUNT: 'service' },
        readSecret: () => '{"project_id":"synthetic-project"}',
        getPromptNames: () => ({ charName: '', userName: '', groupNames: [], startsWithGroupName: () => false }),
        console: { debug() {}, info() {}, warn() {}, error: (...args) => { throw new Error(util.format(...args)); } },
        fetch: fetchMock,
        getVertexHttp2Proxy: async () => '',
        fetchVertexHttp2: fetchMock,
        forwardVertexResponse: forward,
        forwardFetchResponse: forward,
    });
    vm.runInContext(handlerSource, context);
    const request = {
        body: {
            chat_completion_source: sourceName, model: 'gemini-4-argon',
            reasoning_effort: effort, include_reasoning: includeThoughts,
            max_tokens: 65535, vertexai_region: 'global', stream: false,
            messages: [{ role: 'user', content: 'synthetic prompt' }],
            ...overrides,
        },
        user: { directories: {} },
        socket: new EventEmitter(),
    };
    const response = Object.assign(new EventEmitter(), {
        headersSent: false, statusCode: 200,
        status(value) { this.statusCode = value; return this; },
        send(value) { this.value = value; return this; },
    });
    await context.sendMakerSuiteRequest(request, response);
    expect(response.statusCode).toBe(expectedStatus);
    expect(fetchMock).toHaveBeenCalledTimes(expectedStatus === 200 ? 1 : 0);
    expect(forward).toHaveBeenCalledTimes(expectedStatus === 200 && request.body.stream ? 1 : 0);
    expect(response.value?.error).toBe(expectedStatus === 200 ? undefined : true);
    expect(response.listenerCount('close')).toBe(0);
    const outbound = fetchMock.mock.calls[0];
    return { body: outbound && JSON.parse(outbound[1].body), url: outbound?.[0], response };
}

describe.each(['vertexai', 'makersuite'])('%s Google request thinking config', sourceName => {
    test.each(gemini4Models)('%s preserves preset images after merging and builds one native Google image part', async model => {
        const data = Buffer.from('synthetic-image-bytes').toString('base64');
        const messages = converters.postProcessPrompt([
            { role: 'user', content: 'synthetic question' },
            { role: 'assistant', content: [{ type: 'text', text: 'before\n' },
                { type: 'image_url', image_url: { url: `data:image/jpeg;base64,${data}` } }, { type: 'text', text: 'after' }] },
        ], 'merge_tools', { charName: '', userName: '', startsWithGroupName: () => false });
        const part = { functionCall: { name: 'emit_story', args: { body: 'synthetic answer' } }, thoughtSignature: 'synthetic' };
        const { body, response } = await makeRequest(sourceName, 'high', true, {
            model,
            messages,
            tools: [{ type: 'function', function: { name: 'emit_story', parameters: { type: 'object', properties: { body: { type: 'string' } } } } }],
            tool_choice: 'required',
        }, { candidates: [{ content: { parts: [part] }, finishReason: 'STOP' }] });
        expect(body.contents.flatMap(content => content.parts).filter(part => part.inlineData)).toEqual([
            { inlineData: { mimeType: 'image/jpeg', data } },
        ]);
        expect(body.generationConfig.thinkingConfig).toEqual({ includeThoughts: true, thinkingLevel: 'HIGH' });
        expect(body.toolConfig.functionCallingConfig).toEqual({ mode: 'ANY' });
        expect(response.value.responseContent.parts).toEqual([part]);
    });

    describe.each(gemini4Models)('%s thinking levels', model => {
        test.each([
            ['auto', undefined], ['min', 'LOW'], ['low', 'LOW'],
            ['medium', 'MEDIUM'], ['high', 'HIGH'], ['max', 'HIGH'],
        ])('sends the effective %s level with either thoughts setting', async (effort, level) => {
            const expectedLevel = model === 'gemini-4-hydrogen' && effort === 'max' ? 'XHIGH' : level;
            for (const includeThoughts of [false, true]) {
                const { body } = await makeRequest(sourceName, effort, includeThoughts, { model });
                expect(body.generationConfig.thinkingConfig).toEqual({
                    includeThoughts, ...(expectedLevel ? { thinkingLevel: expectedLevel } : {}),
                });
                expect(body.generationConfig.thinkingConfig).not.toHaveProperty('thinkingBudget');
            }
        });
    });

    test.each([
        ['gemini-4-argon', 32_768], ['gemini-4-carbon', 32_768], ['gemini-4-hydrogen', 65_536],
    ])('%s honors the streaming and direct REST output limits and omits fixed sampling parameters', async (model, nonStreamingCap) => {
        for (const stream of [false, true]) {
            const { body, url } = await makeRequest(sourceName, 'max', false, {
                model, stream, max_tokens: 1_048_576,
                temperature: 0.3, top_p: 0.7, top_k: 12, frequency_penalty: 0.8, presence_penalty: 0.4, n: 2,
            });
            expect(body.generationConfig.maxOutputTokens).toBe(stream ? 65_536 : nonStreamingCap);
            expect(body.generationConfig.thinkingConfig).toEqual({ includeThoughts: false, thinkingLevel: model === 'gemini-4-hydrogen' ? 'XHIGH' : 'HIGH' });
            for (const parameter of ['temperature', 'topP', 'topK', 'candidateCount', 'frequencyPenalty', 'presencePenalty']) {
                expect(body.generationConfig).not.toHaveProperty(parameter);
            }
            const endpoint = new URL(url);
            const studio = sourceName === 'makersuite';
            const prefix = studio ? '/v1beta' : '/v1/projects/synthetic-project/locations/global/publishers/google';
            expect(endpoint.origin).toBe(studio ? 'https://generativelanguage.googleapis.com' : 'https://aiplatform.googleapis.com');
            expect(endpoint.pathname).toBe(`${prefix}/models/${model}:${stream ? 'streamGenerateContent' : 'generateContent'}`);
            expect(endpoint.searchParams.get('alt')).toBe(stream ? 'sse' : null);
        }
    });

    test('keeps the requested lower output budget', async () => {
        const { body } = await makeRequest(sourceName, 'max', true, { model: 'gemini-4-hydrogen', max_tokens: 4096 });
        expect(body.generationConfig.maxOutputTokens).toBe(4096);
    });

    test.each([
        ['gemini-3.8-flash', 'min', { includeThoughts: true, thinkingLevel: 'low' }],
        ['gemini-3.7-flash', 'medium', { includeThoughts: true, thinkingLevel: 'medium' }],
        ['gemini-3.0-pro', 'medium', { includeThoughts: true, thinkingLevel: 'low' }],
        ['gemini-2.5-pro', 'low', { includeThoughts: true, thinkingBudget: 6553 }],
        ['gemini-2.5-flash-image', 'high', undefined],
        ['gemini-4-unknown', 'high', undefined],
    ])('preserves %s compatibility', async (model, effort, expected) => {
        const { body } = await makeRequest(sourceName, effort, true, { model });
        expect(body.generationConfig.thinkingConfig).toEqual(expected);
    });

    test('keeps pre-Gemini 4 output and configurable sampling behavior', async () => {
        const { body } = await makeRequest(sourceName, 'low', false, {
            model: 'gemini-2.5-pro', max_tokens: 65_535, temperature: 0.3, top_p: 0.7, top_k: 12,
        });
        expect(body.generationConfig).toMatchObject({ maxOutputTokens: 65_535, temperature: 0.3, topP: 0.7, topK: 12, candidateCount: 1 });
    });

    test('keeps 3.8 Flash on its own output and thinking limits', async () => {
        const { body } = await makeRequest(sourceName, 'max', true, {
            model: 'gemini-3.8-flash', max_tokens: 1_048_576, temperature: 0.3, top_p: 0.7, top_k: 12,
        });
        expect(body.generationConfig.maxOutputTokens).toBe(65_536);
        expect(body.generationConfig.thinkingConfig).toEqual({ includeThoughts: true, thinkingLevel: 'high' });
        for (const parameter of ['temperature', 'topP', 'topK', 'candidateCount']) {
            expect(body.generationConfig).not.toHaveProperty(parameter);
        }
    });

    test('Hydrogen replays signed model text and a signed parallel tool turn', async () => {
        const args = { body: '第一段\n\n第二段 "保留引号"' };
        const calls = [
            { id: 'local-first', signature: 'first-tool-signature', function: { name: 'emit_story', arguments: JSON.stringify(args) } },
            { id: 'local-second', function: { name: 'emit_title', arguments: '{"body":"标题"}' } },
        ];
        const messages = [
            { role: 'user', content: 'synthetic prompt' },
            { role: 'assistant', content: 'past answer', signature: 'past-text-signature' },
            { role: 'assistant', content: 'continued answer', signature: 'continued-text-signature' },
            { role: 'user', content: 'continue with tools' },
            { role: 'assistant', content: '', tool_calls: calls },
            { role: 'tool', tool_call_id: 'local-first', content: 'story received' },
            { role: 'tool', tool_call_id: 'local-second', content: 'title received' },
        ];
        const { body } = await makeRequest(sourceName, 'max', true, { model: 'gemini-4-hydrogen', messages });
        expect(body.contents[1]).toEqual({ role: 'model', parts: [
            { text: 'past answer', thoughtSignature: 'past-text-signature' },
            { text: 'continued answer', thoughtSignature: 'continued-text-signature' },
        ] });
        expect(body.contents[3]).toEqual({ role: 'model', parts: [
            { functionCall: { name: 'emit_story', args }, thoughtSignature: 'first-tool-signature' },
            { functionCall: { name: 'emit_title', args: { body: '标题' } } },
        ] });
        expect(body.contents[4]).toEqual({ role: 'user', parts: [
            { functionResponse: { name: 'emit_story', response: { name: 'emit_story', content: 'story received' } } },
            { functionResponse: { name: 'emit_title', response: { name: 'emit_title', content: 'title received' } } },
        ] });
    });

    test.each([...gemini4Models, 'gemini-3.8-flash'])('%s avoids a trailing model prefill', async model => {
        const messages = [{ role: 'user', content: 'synthetic prompt' }, { role: 'assistant', content: 'prefill text' }];
        const { body } = await makeRequest(sourceName, 'high', false, { model, messages });
        expect(body.contents.at(-1).role).toBe('user');
        expect(body.contents.at(-1).parts.some(part => part.text?.includes('prefill text'))).toBe(true);
    });

    test('preserves tool-only replies, arguments and signatures', async () => {
        const part = { functionCall: { name: 'emit_story', args: { body: 'synthetic story' } }, thoughtSignature: 'synthetic' };
        const { body, response } = await makeRequest(sourceName, 'high', true, {
            tools: [{ type: 'function', function: { name: 'emit_story', parameters: { type: 'object', properties: { body: { type: 'string' } } } } }],
            tool_choice: 'required',
        }, { candidates: [{ content: { parts: [part] }, finishReason: 'STOP' }] });
        expect(body.toolConfig.functionCallingConfig).toEqual({ mode: 'ANY' });
        expect(response.value.responseContent.parts).toEqual([part]);
    });
});

describe.each(gemini4Models)('%s Vertex routing', model => {
    test.each(['us', 'eu'])('uses the official %s multi-region hostname', async region => {
        const { url } = await makeRequest('vertexai', 'low', false, { model, vertexai_region: region });
        expect(url).toBe(`https://aiplatform.${region}.rep.googleapis.com/v1/projects/synthetic-project/locations/${region}/publishers/google/models/${model}:generateContent`);
    });

    test('defaults to global with no region selected', async () => {
        const { url } = await makeRequest('vertexai', 'low', false, { model, vertexai_region: undefined });
        expect(url).toBe(`https://aiplatform.googleapis.com/v1/projects/synthetic-project/locations/global/publishers/google/models/${model}:generateContent`);
    });
});

test.each(['gemini-4-carbon', 'gemini-4-hydrogen'])('%s rejects unsupported Vertex regions before any upstream request', async model => {
    const { response } = await makeRequest('vertexai', 'low', false, { model, vertexai_region: 'us-central1' }, null, 400);
    expect(response.value.message).toMatch(/global, us, or eu/);
});

test('Argon retains its regional Vertex connection', async () => {
    const { url } = await makeRequest('vertexai', 'low', false, { model: 'gemini-4-argon', vertexai_region: 'asia-southeast1' });
    expect(url).toBe('https://asia-southeast1-aiplatform.googleapis.com/v1/projects/synthetic-project/locations/asia-southeast1/publishers/google/models/gemini-4-argon:generateContent');
});

test.each([
    ['gemini-4-hydrogen', 'eu', 'aiplatform.eu.rep.googleapis.com'],
    ['gemini-3.8-flash', 'asia-northeast1', 'asia-northeast1-aiplatform.googleapis.com'],
    ['gemini-2.5-flash', 'us-central1', 'aiplatform.googleapis.com'],
])('routes %s with a project-scoped Vertex API key', async (model, region, host) => {
    const { url } = await makeRequest('vertexai', 'auto', false, {
        model, vertexai_region: region, vertexai_auth_mode: 'express', vertexai_express_project_id: 'synthetic-project',
    });
    expect(url).toBe(`https://${host}/v1/projects/synthetic-project/locations/${region}/publishers/google/models/${model}:generateContent?key=synthetic`);
});

test.each(['model_google_select', 'model_vertexai_select'])('%s includes each supported built-in model once', id => {
    const index = fs.readFileSync(new URL('../public/index.html', import.meta.url), 'utf8');
    const options = index.split(`<select id="${id}">`)[1].split('</select>')[0];
    const values = [...options.matchAll(/<option\b[^>]*\bvalue="([^"]+)"/g)].map(match => match[1]);
    for (const model of [...gemini4Models, 'gemini-3.8-flash']) {
        expect(values.filter(value => value === model)).toHaveLength(1);
    }
});

test.each(gemini4Models)('%s honors its unified context cap even when unlocked', model => {
    const frontend = fs.readFileSync(new URL('../public/scripts/openai.js', import.meta.url), 'utf8');
    const context = vm.createContext({ ...geminiModels, model_list: [{ id: model, inputTokenLimit: 2_000_000 }] });
    vm.runInContext(frontend.match(/^function getGeminiMaxContext\([^]*?^}/m)[0], context);
    expect(context.getGeminiMaxContext(model, false)).toBe(1_048_576);
    expect(context.getGeminiMaxContext(model, true)).toBe(1_048_576);
});
