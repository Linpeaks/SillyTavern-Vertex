import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import vm from 'node:vm';
import util from 'node:util';
import http from 'node:http';
import { once } from 'node:events';
import { Readable } from 'node:stream';
import { setTimeout as delay } from 'node:timers/promises';
import express from 'express';
import fetch, { Response } from 'node-fetch';
import { afterAll, beforeAll, expect, jest, test } from '@jest/globals';
import * as constants from '../src/constants.js';
import * as pdf from '../src/native-pdf.js';
import * as references from '../public/scripts/native-pdf.js';
import * as geminiModels from '../public/scripts/gemini-models.js';
import * as media from '../public/scripts/media-preservation.js';
import { forwardVertexResponse } from '../src/vertex-http2.js';
import { makePdf } from './fixtures/native-pdf.js';

jest.unstable_mockModule('../src/util.js', () => ({
    getConfigValue: (_key, fallback) => fallback,
    tryParse: value => { try { return JSON.parse(value); } catch { return undefined; } },
}));
const converters = await import('../src/prompt-converters.js');
const source = fs.readFileSync(new URL('../src/endpoints/backends/chat-completions.js', import.meta.url), 'utf8');
const uploadSource = fs.readFileSync(new URL('../src/endpoints/files.js', import.meta.url), 'utf8');
let server, url, directories;
const calls = [];
const logs = [];
const toolReply = { candidates: [{ content: { parts: [{ functionCall: { name: 'emit', args: { body: 'synthetic tool response' } } }] }, finishReason: 'STOP' }] };
const carbonStory = '第一段🧪\n\n第二段 "保留引号"';
const carbonSignature = 'synthetic-carbon-tool-signature';

async function* carbonEvents() {
    const frames = [
        { candidates: [{ content: { parts: [{ thought: true, text: '思考摘要' }] } }] },
        { candidates: [{ content: { parts: [{
            functionCall: { name: 'emit', args: { body: carbonStory } }, thoughtSignature: carbonSignature,
        }] } }] },
        { candidates: [{ finishReason: 'STOP' }], usageMetadata: { candidatesTokenCount: 10 } },
    ];
    for (const frame of frames) {
        const bytes = Buffer.from('data: ' + JSON.stringify(frame) + '\r\n\r\n');
        const unicodeStart = bytes.indexOf(Buffer.from('🧪'));
        const split = unicodeStart >= 0 ? unicodeStart + 1 : 9;
        yield bytes.subarray(0, split);
        await delay(8);
        yield bytes.subarray(split);
    }
}

beforeAll(async () => {
    const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'st-pdf-route-test-'));
    directories = { root, files: path.join(root, 'user', 'files') };
    await fsp.mkdir(directories.files, { recursive: true });
    const router = express.Router();
    const context = vm.createContext({
        ...constants, ...converters, ...pdf, ...references, ...geminiModels, router, express, URL, AbortController, util, forwardVertexResponse,
        API_VERTEX_AI: 'https://aiplatform.googleapis.com', API_MAKERSUITE: 'https://generativelanguage.googleapis.com',
        getConfigValue: (_key, fallback) => fallback,
        getVertexAIAuth: async () => ({ authType: 'full', authHeader: 'Bearer synthetic' }),
        getProjectIdFromServiceAccount: account => account.project_id,
        SECRET_KEYS: { VERTEXAI_SERVICE_ACCOUNT: 'service' }, readSecret: () => '{"project_id":"synthetic-project"}',
        getPromptNames: () => ({ charName: '', userName: '', groupNames: [], startsWithGroupName: () => false }),
        console: Object.fromEntries(['debug', 'info', 'warn', 'error'].map(method => [method, (...args) => logs.push(args)])),
        getVertexHttp2Proxy: async () => '',
        fetchVertexHttp2: async (url, init) => {
            calls.push({ url, body: JSON.parse(init.body), signal: init.signal });
            const events = url.includes('gemini-4-carbon:') ? carbonEvents() : ['data: ' + JSON.stringify(toolReply) + '\n\n'];
            return new Response(Readable.from(events), { headers: { 'content-type': 'text/event-stream' } });
        },
    });
    vm.runInContext(source.match(/^async function sendMakerSuiteRequest\([^]*?^}/m)[0], context);
    vm.runInContext(source.match(/^router.post\('\/generate', async function[^]*?^}\);/m)[0], context);
    vm.runInContext(uploadSource.match(/^router.post\('\/upload-pdf', async[^]*?^}\);/m)[0], context);
    const app = express();
    app.use(express.json({ limit: '70mb' }));
    app.use((req, _res, next) => { req.user = { directories }; next(); });
    app.use(router);
    server = http.createServer(app).listen(0, '127.0.0.1');
    await once(server, 'listening');
    url = `http://127.0.0.1:${server.address().port}`;
});
afterAll(async () => {
    await new Promise(resolve => server.close(resolve));
    if (path.dirname(directories.root) !== path.resolve(os.tmpdir()) || !path.basename(directories.root).startsWith('st-pdf-route-test-')) throw new Error('Unsafe cleanup path');
    await fsp.rm(directories.root, { recursive: true, force: true });
});
const post = (route, body) => fetch(url + route, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });

test('real upload and generate routes preserve PDF bytes, merge_tools and tool-only response', async () => {
    const bytes = makePdf('synthetic large document ' + 'x'.repeat(6 * 1024 * 1024));
    const upload = await fetch(url + '/upload-pdf', { method: 'POST', headers: { 'Content-Type': 'application/pdf' }, body: bytes });
    expect(upload.status).toBe(200);
    const file = await upload.json();
    expect(file.url).toMatch(/^user\/files\//);
    const marker = references.nativePdfMarker(file);
    const count = calls.length;
    const response = await post('/generate', {
        chat_completion_source: 'vertexai', vertexai_auth_mode: 'full', vertexai_region: 'global', model: 'gemini-4-argon',
        stream: true, max_tokens: 65535, include_reasoning: true, reasoning_effort: 'high',
        custom_prompt_post_processing: 'merge_tools', messages: [{ role: 'user', content: marker + '\nquestion' }],
        native_pdf_refs: [marker], tools: [{ type: 'function', function: { name: 'emit', parameters: { type: 'object' } } }],
    });
    expect(response.status).toBe(200);
    expect(await response.text()).toBe('data: ' + JSON.stringify(toolReply) + '\n\n');
    expect(calls).toHaveLength(count + 1);
    expect(calls.at(-1).body.contents[0].parts[0].inlineData).toEqual({ mimeType: 'application/pdf', data: bytes.toString('base64') });
    expect(calls.at(-1).body.generationConfig.thinkingConfig).toEqual({ includeThoughts: true, thinkingLevel: 'HIGH' });
    expect(JSON.stringify(logs)).not.toContain(bytes.toString('base64'));
});

test('Carbon sends a PDF and image and delivers the complete streamed tool body to a registered tool', async () => {
    const bytes = makePdf('synthetic Carbon document');
    const upload = await fetch(url + '/upload-pdf', { method: 'POST', headers: { 'Content-Type': 'application/pdf' }, body: bytes });
    expect(upload.status).toBe(200);
    const marker = references.nativePdfMarker(await upload.json());
    const image = Buffer.from('synthetic Carbon image bytes').toString('base64');
    const count = calls.length;

    const readFrontend = file => fs.readFileSync(new URL(`../public/scripts/${file}`, import.meta.url), 'utf8');
    const openai = readFrontend('openai.js');
    const sse = readFrontend('sse-stream.js');
    const toolCalling = readFrontend('tool-calling.js');
    const settings = {
        chat_completion_source: 'vertexai', vertexai_model: 'gemini-4-carbon', show_thoughts: true,
        function_calling: true, custom_prompt_post_processing: 'merge_tools',
    };
    const context = vm.createContext({
        ...references, ...media, oai_settings: settings, chat_completion_sources: constants.CHAT_COMPLETION_SOURCES,
        main_api: 'openai', model_list: [], custom_prompt_post_processing_types: converters.PROMPT_PROCESSING_TYPE,
        TextDecoderStream, TransformStream, MessageEvent, AbortController,
        fetch: (_path, options) => global.fetch(url + '/generate', options),
        getRequestHeaders: () => ({ 'Content-Type': 'application/json' }),
        getChatCompletionModel: () => settings.vertexai_model,
        createGenerationParameters: async (_settings, model, _type, messages) => ({
            stream: true, canMultiSwipe: false, generate_data: {
                chat_completion_source: 'vertexai', vertexai_auth_mode: 'full', vertexai_region: 'global', model,
                stream: true, max_tokens: 128_000, include_reasoning: true, reasoning_effort: 'high', tool_choice: 'required',
                custom_prompt_post_processing: 'merge_tools', messages,
                tools: [{ type: 'function', function: { name: 'emit', parameters: {
                    type: 'object', properties: { body: { type: 'string' } }, required: ['body'],
                } } }],
            },
        }),
        event_types: { CHAT_COMPLETION_SETTINGS_READY: 'ready' }, eventSource: { emit: async () => {} },
        parseChatCompletionLogprobs: () => null, tryParseStreamingError: () => {},
        toastr: { info() {}, clear() {} },
    });
    vm.runInContext([
        sse.match(/^class EventSourceStream \{[^]*?^}/m)[0],
        'const getEventSourceStream = () => new EventSourceStream();',
        toolCalling.replace(/^import [^\n]*\n/gm, '').replace('export class ToolManager', 'class ToolManager'),
        openai.match(/^export function getStreamingReply\([^]*?^}/m)[0].replace('export ', ''),
        openai.match(/^async function sendOpenAIRequest\([^]*?^}/m)[0],
    ].join('\n'), context);
    const toolManager = vm.runInContext('ToolManager', context);
    const action = jest.fn(({ body }) => body);
    toolManager.registerFunctionTool({ name: 'emit', displayName: 'Emit', action });
    const generator = await context.sendOpenAIRequest('normal', [
        { role: 'user', content: [
            { type: 'text', text: marker + '\nquestion\n' },
            { type: 'image_url', image_url: { url: `data:image/png;base64,${image}` } },
        ] },
    ]);
    let final;
    for await (const item of generator()) final = item;
    expect(final.text).toBe('');
    expect(final.state.reasoning).toBe('思考摘要');
    expect(toolManager.hasToolCalls(final.toolCalls)).toBe(true);
    const result = await toolManager.invokeFunctionTools(final.toolCalls, { reasoningText: final.state.reasoning });
    expect(result.errors).toEqual([]);
    expect(result.invocations).toEqual([expect.objectContaining({
        name: 'emit', parameters: JSON.stringify({ body: carbonStory }), result: carbonStory, signature: carbonSignature,
    })]);
    expect(action).toHaveBeenCalledTimes(1);
    expect(action).toHaveBeenCalledWith({ body: carbonStory });

    expect(calls).toHaveLength(count + 1);
    const request = calls.at(-1);
    expect(request.url).toContain('/locations/global/publishers/google/models/gemini-4-carbon:streamGenerateContent?alt=sse');
    expect(request.body.generationConfig).toMatchObject({ maxOutputTokens: 65_536, thinkingConfig: { includeThoughts: true, thinkingLevel: 'HIGH' } });
    expect(request.body.toolConfig.functionCallingConfig).toEqual({ mode: 'ANY' });
    const attachments = request.body.contents.flatMap(content => content.parts).flatMap(part => part.inlineData ? [part.inlineData] : []);
    expect(attachments).toEqual([
        { mimeType: 'application/pdf', data: bytes.toString('base64') },
        { mimeType: 'image/png', data: image },
    ]);
    expect(JSON.stringify(request.body)).not.toContain(marker);
    expect(JSON.stringify(logs)).not.toContain(carbonStory);
});

test('unsupported source, stripped manifest and missing file make zero generation calls', async () => {
    const count = calls.length;
    const marker = references.nativePdfMarker({ id: '00000000-0000-0000-0000-000000000000', sha256: '0'.repeat(64), pages: 1 });
    for (const overrides of [{ chat_completion_source: 'openai' }, { messages: [{ role: 'user', content: 'stripped' }] }, {}]) {
        const response = await post('/generate', { model: 'gemini-4-argon', chat_completion_source: 'vertexai', vertexai_auth_mode: 'full',
            messages: [{ role: 'user', content: marker }], native_pdf_refs: [marker], ...overrides });
        expect(response.status).toBe(400);
        expect((await response.json()).error).toBe(true);
    }
    expect(calls).toHaveLength(count);
});

test('upload errors are explicit and never expose local paths', async () => {
    const response = await post('/upload-pdf', { data: Buffer.from('broken').toString('base64') });
    expect(response.status).toBe(400);
    const value = await response.json();
    expect(value.error).toMatch(/PDF upload failed/);
    expect(JSON.stringify(value)).not.toContain(directories.root);
});

test('legacy base64 PDF uploads remain compatible', async () => {
    const response = await post('/upload-pdf', { data: makePdf().toString('base64') });
    expect(response.status).toBe(200);
    expect((await response.json()).pages).toBe(1);
});

test('oversized binary uploads return a clear 413 and store no file', async () => {
    const before = await fsp.readdir(directories.files);
    const response = await fetch(url + '/upload-pdf', { method: 'POST', headers: { 'Content-Type': 'application/pdf' },
        body: Buffer.alloc(references.NATIVE_PDF_LIMITS.fileBytes + 1) });
    expect(response.status).toBe(413);
    expect((await response.json()).error).toBe(references.NATIVE_PDF_SIZE_ERROR);
    expect(await fsp.readdir(directories.files)).toEqual(before);
});

test('a chunked upload is bounded even without Content-Length', async () => {
    const before = await fsp.readdir(directories.files);
    const chunk = Buffer.alloc(8_000_000);
    const response = await fetch(url + '/upload-pdf', { method: 'POST', headers: { 'Content-Type': 'application/pdf' },
        body: Readable.from((function* () { for (let i = 0; i < 7; i++) yield chunk; })()) });
    expect(response.status).toBe(413);
    expect((await response.json()).error).toBe(references.NATIVE_PDF_SIZE_ERROR);
    expect(await fsp.readdir(directories.files)).toEqual(before);
});

test('disconnecting during a binary upload creates no file or generation', async () => {
    const before = await fsp.readdir(directories.files);
    const count = calls.length;
    await new Promise(resolve => {
        const req = http.request(url + '/upload-pdf', { method: 'POST', headers: { 'Content-Type': 'application/pdf', 'Content-Length': 2_000_000 } });
        req.on('error', () => {});
        req.on('close', resolve);
        req.write(makePdf());
        setTimeout(() => req.destroy(), 40);
    });
    expect(await fsp.readdir(directories.files)).toEqual(before);
    expect(calls).toHaveLength(count);
});
