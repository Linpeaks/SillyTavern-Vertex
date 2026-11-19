/* eslint-disable playwright/no-standalone-expect -- Jest test.each is not a Playwright test. */
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
    app.use(express.json({ limit: '21mb' }));
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

describe.each(['gemini-4-argon', 'gemini-4-carbon', 'gemini-4-hydrogen', 'gemini-4-neon'])('%s Vertex captions', model => {
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

test.each(['gemini-4-hydrogen', 'gemini-4-neon'])('%s preserves the no-caption error when AI Studio returns only thoughts and image data', async model => {
    upstreamFetch.mockResolvedValueOnce(new Response(JSON.stringify({
        candidates: [{ content: { parts: [parts[0], parts[2]] } }],
    })));
    const response = await requestCaption({ api: 'google', model });
    expect(response.status).toBe(500);
    expect(await response.text()).toBe('No caption found');
    expect(upstreamFetch).toHaveBeenCalledTimes(1);
    expect(upstreamFetch).toHaveBeenCalledWith(
        `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`,
        expect.objectContaining({ headers: expect.objectContaining({ 'x-goog-api-key': 'synthetic-studio-key' }) }),
    );
});

describe('Google caption Flex', () => {
    const project = { vertexai_auth_mode: 'express', vertexai_express_project_id: 'synthetic-project' };

    test('sends the top-level AI Studio service tier once and returns the caption', async () => {
        const response = await requestCaption({ api: 'google', model: 'gemini-4-neon', google_use_flex: true });
        expect(response.status).toBe(200);
        expect(await response.json()).toEqual({ caption: 'A blue square.' });
        expect(upstreamFetch).toHaveBeenCalledTimes(1);
        const [[url, request]] = upstreamFetch.mock.calls;
        expect(url).toBe('https://generativelanguage.googleapis.com/v1beta/models/gemini-4-neon:generateContent');
        expect(JSON.parse(request.body).service_tier).toBe('flex');
        const headers = new Headers(request.headers);
        expect(headers.has('X-Vertex-AI-LLM-Request-Type')).toBe(false);
        expect(headers.has('X-Vertex-AI-LLM-Shared-Request-Type')).toBe(false);
    });

    test('sends the Vertex Flex headers once on the global endpoint and returns the caption', async () => {
        const response = await requestCaption({
            ...project, model: 'gemini-3.8-flash', vertexai_region: 'global', google_use_flex: true,
        });
        expect(response.status).toBe(200);
        expect(await response.json()).toEqual({ caption: 'A blue square.' });
        expect(upstreamFetch).toHaveBeenCalledTimes(1);
        const [[url, request]] = upstreamFetch.mock.calls;
        expect(url).toBe('https://aiplatform.googleapis.com/v1/projects/synthetic-project/locations/global/publishers/google/models/gemini-3.8-flash:generateContent');
        expect(JSON.parse(request.body)).not.toHaveProperty('service_tier');
        const headers = new Headers(request.headers);
        expect(headers.get('X-Vertex-AI-LLM-Request-Type')).toBe('shared');
        expect(headers.get('X-Vertex-AI-LLM-Shared-Request-Type')).toBe('flex');
    });

    describe.each([
        ['google', 'gemini-4-neon'],
        ['vertexai', 'gemini-3.8-flash'],
    ])('%s Flex opt-in and upstream errors', (api, model) => {
        test.each([undefined, false])('omits Flex settings with google_use_flex=%s', async google_use_flex => {
            const response = await requestCaption({ ...project, api, model, google_use_flex });
            expect(response.status).toBe(200);
            expect(upstreamFetch).toHaveBeenCalledTimes(1);
            const [[, request]] = upstreamFetch.mock.calls;
            expect(JSON.parse(request.body)).not.toHaveProperty('service_tier');
            const headers = new Headers(request.headers);
            expect(headers.has('X-Vertex-AI-LLM-Request-Type')).toBe(false);
            expect(headers.has('X-Vertex-AI-LLM-Shared-Request-Type')).toBe(false);
        });

        test.each([429, 503])('returns the upstream %s capacity response after one submission', async status => {
            const errorLog = jest.spyOn(console, 'error').mockImplementation(() => {});
            try {
                upstreamFetch.mockResolvedValueOnce(new Response(JSON.stringify({
                    error: { code: status, message: 'Synthetic capacity error' },
                }), { status }));
                const response = await requestCaption({ ...project, api, model, google_use_flex: true });
                expect(response.status).toBe(status);
                expect(await response.json()).toEqual({ error: true, message: 'Synthetic capacity error' });
                expect(upstreamFetch).toHaveBeenCalledTimes(1);
            } finally {
                errorLog.mockRestore();
            }
        });
    });

    test.each([
        ['gemini-4-neon', 'global'],
        ['gemini-2.5-pro', 'global'],
        ['gemini-3.8-flash', 'us-central1'],
    ])('rejects Vertex Flex for %s in %s before submitting', async (model, vertexai_region) => {
        const response = await requestCaption({ ...project, model, vertexai_region, google_use_flex: true });
        expect(response.status).toBe(400);
        expect(await response.text()).toMatch(/flex/i);
        expect(upstreamFetch).not.toHaveBeenCalled();
    });

    test('rejects a Vertex Flex caption whose complete JSON exceeds the byte limit', async () => {
        const data = 'A'.repeat(20_000_000 - 4);
        const response = await requestCaption({
            ...project, model: 'gemini-3.8-flash', google_use_flex: true,
            image: `data:image/png;base64,${data}`,
        });
        expect(response.status).toBe(400);
        expect(await response.text()).toMatch(/20 MB/);
        expect(upstreamFetch).not.toHaveBeenCalled();
    });
});
