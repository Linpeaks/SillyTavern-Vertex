import http from 'node:http';
import { Readable } from 'node:stream';
import { once } from 'node:events';
import { fileURLToPath } from 'node:url';
import { setConfigFilePath } from '../src/util.js';
import { setTimeout as delay } from 'node:timers/promises';
import express from 'express';
import * as fetchModule from 'node-fetch';
import { beforeAll, afterAll, beforeEach, test, expect, jest } from '@jest/globals';
import { createGenerationJobsRouter } from '../src/vertex-jobs.js';

const upstream = jest.fn();
jest.unstable_mockModule('node-fetch', () => ({ ...fetchModule, default: upstream }));
setConfigFilePath(fileURLToPath(new URL('../default/config.yaml', import.meta.url)));
const secrets = await import('../src/endpoints/secrets.js');
jest.unstable_mockModule('../src/endpoints/secrets.js', () => ({ ...secrets, readSecret: () => 'synthetic-test-key' }));
const { generateNovel } = await import('../src/endpoints/novelai.js');
const { generateHordeJob } = await import('../src/endpoints/horde.js');
const { generateTextCompletion } = await import('../src/endpoints/backends/text-completions.js');
const { generateKobold } = await import('../src/endpoints/backends/kobold.js');

const json = value => new fetchModule.Response(JSON.stringify(value), { headers: { 'content-type': 'application/json' } });
const post = value => ({ method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(value) });
let server, url, complete;
beforeAll(async () => {
    const app = express();
    app.use(express.json(), (req, res, next) => { req.user = { profile: { handle: 'test' }, directories: {} }; next(); });
    app.use('/jobs', createGenerationJobsRouter({ novel: generateNovel, koboldhorde: generateHordeJob, textgenerationwebui: generateTextCompletion, kobold: generateKobold,
        openai: async (_req, res) => { await new Promise(resolve => { complete = resolve; }); res.send({ text: 'complete' }); } }).router);
    server = http.createServer(app);
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    url = 'http://127.0.0.1:' + server.address().port + '/jobs';
});
beforeEach(() => upstream.mockReset());
afterAll(async () => { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); });
async function start(transport, body) {
    const { id } = await (await fetchModule.default(url, post({}))).json();
    const location = url + '/' + id;
    expect((await fetchModule.default(location + '/start?transport=' + transport, post(body))).status).toBe(202);
    return location;
}
async function result(location, format = 'json') {
    for (let n = 0; n < 100; n++) {
        const status = await (await fetchModule.default(location)).json();
        if (status.state === 'ready') return (await fetchModule.default(location + '/result'))[format]();
        await delay(10);
    }
    throw new Error('No stored result');
}

test.each([
    ['novel', { model: 'kayra', input: 'synthetic' }, { output: 'Novel result' }],
    ['kobold', { api_server: 'http://127.0.0.1:1', prompt: 'synthetic' }, { results: [{ text: 'Kobold result' }] }],
    ['textgenerationwebui', { api_type: 'generic', api_server: 'http://127.0.0.1:1', prompt: 'synthetic' }, { choices: [{ text: 'Completion result' }] }],
])('%s uses its normal provider handler and retains its reply', async (transport, body, reply) => {
    upstream.mockResolvedValueOnce(json(reply));
    const location = await start(transport, body);
    try {
        expect(await result(location)).toEqual(reply);
        expect(await result(location)).toEqual(reply);
        expect(upstream).toHaveBeenCalledTimes(1);
    } finally { await fetchModule.default(location, { method: 'DELETE' }); }
});

test('Ollama preserves split UTF-8 tokens and multiple records from one read', async () => {
    const bytes = Buffer.from('{"response":"中","done":false}\n{"response":"文","thinking":"想","done":true}');
    const split = bytes.indexOf(Buffer.from('中')) + 1;
    upstream.mockResolvedValueOnce(new fetchModule.Response(Readable.from([bytes.subarray(0, split), bytes.subarray(split)])));
    const location = await start('textgenerationwebui', { api_type: 'ollama', api_server: 'http://127.0.0.1:1', prompt: 'test', stream: true });
    try {
        const events = (await result(location, 'text')).trim().split('\n\n').map(frame => frame.slice(6));
        expect(events.pop()).toBe('[DONE]');
        expect(events.map(frame => JSON.parse(frame).choices[0])).toEqual([{ text: '中', thinking: '' }, { text: '文', thinking: '想' }]);
        expect(upstream).toHaveBeenCalledTimes(1);
    } finally { await fetchModule.default(location, { method: 'DELETE' }); }
});

test('Horde submits one job, polls that ID and returns its worker attribution', async () => {
    upstream.mockResolvedValueOnce(json({ id: 'remote-task' })).mockResolvedValueOnce(json({
        done: true, generations: [{ text: 'Horde result', model: 'worker-model', worker_name: 'worker' }],
    }));
    const location = await start('koboldhorde', { prompt: 'synthetic', params: {}, models: ['selected-model'] });
    try {
        expect(await result(location)).toMatchObject({ text: 'Horde result', model: 'worker-model' });
        expect(upstream.mock.calls.map(([target, options]) => [target, options.method || 'GET'])).toEqual([
            ['https://aihorde.net/api/v2/generate/text/async', 'POST'], ['https://aihorde.net/api/v2/generate/text/status/remote-task', 'GET'],
        ]);
    } finally { await fetchModule.default(location, { method: 'DELETE' }); }
});

test('stopping a queued Horde job cancels its original ID without another submission', async () => {
    let polled;
    const pending = new Promise(resolve => { polled = resolve; });
    let cancelled;
    const stopped = new Promise(resolve => { cancelled = resolve; });
    upstream.mockResolvedValueOnce(json({ id: 'queued-task' })).mockImplementationOnce(async () => {
        polled();
        return json({ done: false, is_possible: true });
    }).mockImplementationOnce(async (target, options) => {
        cancelled([target, options.method]);
        return json({});
    });
    const job = await start('koboldhorde', { prompt: 'test', params: {}, models: ['selected-model'] });
    await pending;
    expect((await fetchModule.default(job, { method: 'DELETE' })).status).toBe(204);
    await expect(stopped).resolves.toEqual(['https://aihorde.net/api/v2/generate/text/status/queued-task', 'DELETE']);
    expect(upstream).toHaveBeenCalledTimes(3);
});

test('completion starts a fresh hour, and reading or claiming does not extend it', async () => {
    const now = Date.now();
    const clock = jest.spyOn(Date, 'now').mockReturnValue(now);
    const location = await start('openai', {});
    try {
        const status = async () => (await fetchModule.default(location)).json();
        expect((await status()).expiresAt).toBe(now + 3600000);
        clock.mockReturnValue(now + 600000);
        complete();
        expect(await result(location)).toEqual({ text: 'complete' });
        expect((await status()).expiresAt).toBe(now + 4200000);
        clock.mockReturnValue(now + 700000);
        await fetchModule.default(location + '/claim', post({ consumer: '11111111-1111-4111-8111-111111111111' }));
        expect((await status()).expiresAt).toBe(now + 4200000);
    } finally {
        clock.mockRestore();
        await fetchModule.default(location, { method: 'DELETE' });
    }
});
