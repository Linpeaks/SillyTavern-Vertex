import { once } from 'node:events';
import express from 'express';
import { afterAll, beforeAll, beforeEach, describe, expect, jest, test } from '@jest/globals';

const upstreamFetch = jest.fn();
const readSecret = jest.fn((_directories, key) => {
    if (key === 'vertexai') return 'synthetic-vertex-key';
    if (key === 'makersuite') return 'synthetic-studio-key';
    throw new Error(`Unexpected secret lookup: ${key}`);
});
jest.unstable_mockModule('node-fetch', () => ({ default: upstreamFetch }));
jest.unstable_mockModule('../src/endpoints/secrets.js', () => ({
    readSecret,
    SECRET_KEYS: { VERTEXAI: 'vertexai', MAKERSUITE: 'makersuite' },
}));
jest.unstable_mockModule('../src/util.js', () => ({
    delay: jest.fn(),
    getConfigValue: (_key, fallback) => fallback,
    trimTrailingSlash: value => value.replace(/\/$/, ''),
}));

let server;
let origin;
const imageData = Buffer.from('synthetic image bytes').toString('base64');
const prompt = 'Describe this image';
const parts = [
    { thought: true, text: 'Synthetic private reasoning' },
    { text: 'A blue ' },
    { inlineData: { mimeType: 'image/png', data: imageData } },
    { text: 'square.' },
];

beforeAll(async () => {
    jest.spyOn(console, 'debug').mockImplementation(() => {});
    jest.spyOn(console, 'info').mockImplementation(() => {});
    const { router } = await import('../src/endpoints/google.js');
    const app = express();
    app.use(express.json());
    app.use((request, _response, next) => {
        request.user = { directories: {} };
        next();
    });
    app.use('/api/google', router);
    server = app.listen(0, '127.0.0.1');
    await once(server, 'listening');
    origin = `http://127.0.0.1:${server.address().port}`;
});

afterAll(async () => {
    if (server) await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    jest.restoreAllMocks();
});

beforeEach(() => {
    readSecret.mockClear();
    upstreamFetch.mockReset();
    upstreamFetch.mockResolvedValue(new Response(JSON.stringify({ candidates: [{ content: { parts } }] })));
});

function requestCaption(overrides) {
    return fetch(`${origin}/api/google/caption-image`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
            api: 'vertexai', model: 'gemini-4-hydrogen',
            image: `data:image/png;base64,${imageData}`, prompt, ...overrides,
        }),
    });
}

describe.each(['gemini-4-argon', 'gemini-4-carbon', 'gemini-4-hydrogen'])('%s Vertex captions', model => {
    test.each([
        ['global', 'aiplatform.googleapis.com'],
        ['us', 'aiplatform.us.rep.googleapis.com'],
        ['eu', 'aiplatform.eu.rep.googleapis.com'],
    ])('posts once to the native %s endpoint and returns every final text part', async (region, host) => {
        const response = await requestCaption({
            model, vertexai_region: region, vertexai_auth_mode: 'express',
            vertexai_express_project_id: 'synthetic-project',
        });
        expect(response.status).toBe(200);
        expect(await response.json()).toEqual({ caption: 'A blue square.' });
        expect(upstreamFetch).toHaveBeenCalledTimes(1);
        const [[url, request]] = upstreamFetch.mock.calls;
        expect(url).toBe(`https://${host}/v1/projects/synthetic-project/locations/${region}/publishers/google/models/${model}:generateContent`);
        expect(request.method).toBe('POST');
        expect(request.headers['x-goog-api-key']).toBe('synthetic-vertex-key');
        expect(JSON.parse(request.body).contents).toEqual([{
            role: 'user',
            parts: [{ text: prompt }, { inlineData: { mimeType: 'image/png', data: imageData } }],
        }]);
    });
});

test('keeps the proxy route and credentials independent of the native region check', async () => {
    const response = await requestCaption({
        vertexai_region: 'us-central1',
        reverse_proxy: 'https://vertex-proxy.example/',
        proxy_password: 'synthetic-proxy-key',
    });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ caption: 'A blue square.' });
    expect(upstreamFetch).toHaveBeenCalledTimes(1);
    expect(upstreamFetch).toHaveBeenCalledWith(
        'https://vertex-proxy.example/v1/publishers/google/models/gemini-4-hydrogen:generateContent',
        expect.objectContaining({ headers: expect.objectContaining({ Authorization: 'Bearer synthetic-proxy-key' }) }),
    );
    expect(readSecret).not.toHaveBeenCalled();
});

test('keeps the no-caption error when AI Studio returns only thoughts and image data', async () => {
    upstreamFetch.mockResolvedValueOnce(new Response(JSON.stringify({
        candidates: [{ content: { parts: [parts[0], parts[2]] } }],
    })));
    const response = await requestCaption({ api: 'google' });
    expect(response.status).toBe(500);
    expect(await response.text()).toBe('No caption found');
    expect(upstreamFetch).toHaveBeenCalledTimes(1);
    expect(upstreamFetch).toHaveBeenCalledWith(
        'https://generativelanguage.googleapis.com/v1beta/models/gemini-4-hydrogen:generateContent',
        expect.objectContaining({ headers: expect.objectContaining({ 'x-goog-api-key': 'synthetic-studio-key' }) }),
    );
});
