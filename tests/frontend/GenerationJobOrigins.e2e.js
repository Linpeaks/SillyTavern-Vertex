import http from 'node:http';
import { once } from 'node:events';
import { test, expect } from '@playwright/test';
import { testSetup } from './frontent-test-utils.js';

async function openTestChat(page) {
    await page.route('**/api/settings/get', async route => {
        const response = await route.fetch();
        const data = await response.json();
        data.settings = JSON.stringify({ ...JSON.parse(data.settings), firstRun: false, main_api: 'openai' });
        await route.fulfill({ response, json: data });
    });
    await testSetup.awaitST({ page });
    await page.waitForFunction(async () => {
        const { eventSource, event_types } = await import('./scripts/events.js');
        return eventSource.autoFireLastArgs.has(event_types.APP_READY);
    });
}

test.afterEach(async ({ page }) => {
    if (page.isClosed()) return;
    await page.evaluate(async () => {
        const job = JSON.parse(localStorage.getItem('linpeak.vertex.job.default-user'));
        if (job?.id) await fetch('/api/backends/chat-completions/generation-jobs/' + job.id, {
            method: 'DELETE', headers: (await import('./script.js')).getRequestHeaders(),
        });
    });
});

for (const toolsEnabled of [false, true]) {
    test(`old custom stream survives switching to a different API (tools=${toolsEnabled})`, async ({ page }) => {
        const calls = [];
        let sendReply;
        const provider = http.createServer(async (req, res) => {
            const chunks = [];
            for await (const chunk of req) chunks.push(chunk);
            calls.push(JSON.parse(Buffer.concat(chunks)));
            res.writeHead(200, { 'content-type': 'text/event-stream' });
            const frame = (delta, finish_reason = null) => 'data: ' + JSON.stringify({ choices: [{ delta, finish_reason }] }) + '\n\n';
            res.write(frame({ reasoning_content: 'original reasoning' }));
            sendReply = () => {
                if (toolsEnabled) {
                    res.write(frame({ tool_calls: [{ index: 0, id: 'original-call', type: 'function', function: { name: 'record_job_story', arguments: '{"story":' } }] }));
                    res.write(frame({ tool_calls: [{ index: 0, function: { arguments: '"original tool text"}' } }] }, 'tool_calls'));
                } else res.write(frame({ content: 'original model text' }, 'stop'));
                res.end('data: [DONE]\n\n');
            };
        });
        provider.listen(0, '127.0.0.1');
        await once(provider, 'listening');
        try {
            await openTestChat(page);
            await page.evaluate(async ({ port, toolsEnabled }) => {
                const core = await import('./script.js');
                const { oai_settings } = await import('./scripts/openai.js');
                const { ToolManager } = await import('./scripts/tool-calling.js');
                await core.newAssistantChat({ temporary: false });
                core.changeMainAPI('openai');
                Object.assign(oai_settings, { chat_completion_source: 'custom', custom_model: 'original-model',
                    custom_url: 'http://127.0.0.1:' + port + '/v1', stream_openai: true, function_calling: toolsEnabled, show_thoughts: true,
                    custom_include_body: '', custom_exclude_body: '', custom_include_headers: '' });
                ToolManager.registerFunctionTool({ name: 'record_job_story', description: 'record a synthetic story',
                    parameters: { type: 'object', properties: { story: { type: 'string' } } }, action: ({ story }) => {
                        window.recordedStories ??= [];
                        window.recordedStories.push(story);
                        return 'ok';
                    } });
                core.setOnlineStatus('test');
                const setting = document.getElementById('vertex_job_enabled');
                setting.checked = true;
                setting.dispatchEvent(new Event('change'));
                document.querySelector('#send_textarea').value = 'Synthetic request';
                window.originalJob = core.Generate('normal').then(() => 'complete', e => e.message);
            }, { port: provider.address().port, toolsEnabled });
            await expect.poll(() => calls.length).toBe(1);
            await page.evaluate(async () => {
                const { oai_settings } = await import('./scripts/openai.js');
                oai_settings.custom_model = 'another-model';
                oai_settings.chat_completion_source = 'vertexai';
            });
            await page.locator('#API-status-top').click();
            await page.locator('#main_api').selectOption('novel');
            sendReply();
            expect(await page.evaluate(() => window.originalJob)).toBe('complete');
            const saved = await page.evaluate(async () => {
                const { chat, main_api } = await import('./script.js');
                const message = chat.at(-1);
                return { main_api, text: message.mes, extra: message.extra, stories: window.recordedStories || [] };
            });
            expect(saved.main_api).toBe('novel');
            expect(saved.extra).toMatchObject({ api: 'custom', model: 'original-model' });
            expect(saved).toMatchObject(toolsEnabled
                ? { stories: ['original tool text'], extra: { tool_invocations: [expect.anything()] } }
                : { stories: [], text: 'original model text', extra: { reasoning: 'original reasoning' } });
            expect(calls).toHaveLength(1);
        } finally {
            provider.closeAllConnections();
            await new Promise(resolve => provider.close(resolve));
        }
    });
}

for (const streaming of [false, true]) {
    test(`text completion survives switching to chat completion (streaming=${streaming})`, async ({ page }) => {
        let finish;
        const requests = [];
        const provider = http.createServer(async (req, res) => {
            const chunks = [];
            for await (const chunk of req) chunks.push(chunk);
            if (!req.url.includes('completions')) { res.writeHead(404).end(); return; }
            requests.push(JSON.parse(Buffer.concat(chunks)));
            finish = () => {
                if (streaming) {
                    res.writeHead(200, { 'content-type': 'application/json' });
                    res.end('data: {"choices":[{"index":0,"text":"saved "}]}\n\ndata: {"choices":[{"index":0,"text":"completion"}]}\n\ndata: [DONE]\n\n');
                } else {
                    res.writeHead(200, { 'content-type': 'application/json' });
                    res.end(JSON.stringify({ choices: [{ text: 'saved completion' }] }));
                }
            };
        });
        provider.listen(0, '127.0.0.1');
        await once(provider, 'listening');
        try {
            await openTestChat(page);
            await page.evaluate(async ({ port, streaming }) => {
                const core = await import('./script.js');
                const { textgenerationwebui_settings: settings, textgen_types } = await import('./scripts/textgen-settings.js');
                await core.newAssistantChat({ temporary: true });
                core.changeMainAPI('textgenerationwebui');
                settings.streaming = streaming;
                settings.type = textgen_types.GENERIC;
                settings.server_urls[settings.type] = 'http://127.0.0.1:' + port;
                core.setOnlineStatus('original-text-model');
                const setting = document.getElementById('vertex_job_enabled');
                setting.checked = true;
                setting.dispatchEvent(new Event('change'));
                document.querySelector('#send_textarea').value = 'One text completion';
                window.textJob = core.Generate('normal').then(() => 'done', e => e.message);
            }, { port: provider.address().port, streaming });
            await expect.poll(() => requests.length).toBe(1);
            await page.evaluate(async () => { (await import('./script.js')).changeMainAPI('openai'); });
            finish();
            expect(await page.evaluate(() => window.textJob)).toBe('done');
            expect(await page.evaluate(async () => {
                const { chat, main_api } = await import('./script.js');
                const answer = chat.at(-1);
                return [main_api, answer.mes, answer.extra.api, answer.extra.model];
            })).toEqual(['openai', 'saved completion', 'generic', 'original-text-model']);
            expect(requests).toMatchObject([{ stream: streaming }]);
        } finally {
            provider.closeAllConnections();
            await new Promise(resolve => provider.close(resolve));
        }
    });
}

for (const source of ['vertexai', 'makersuite', 'claude']) {
    const google = ['vertexai', 'makersuite'].includes(source);
    const records = google ? [{ candidates: [{ content: { parts: [{ text: 'provider reply' }] }, finishReason: 'STOP' }] }]
        : [{ type: 'content_block_delta', delta: { type: 'text_delta', text: 'provider reply' } }, { type: 'message_stop' }];
    test(`${source} streamed reply uses the original decoder after a model switch`, async ({ page }) => {
        let release;
        let sends = 0;
        const provider = http.createServer((req, res) => {
            req.resume();
            req.on('end', () => {
                sends++;
                release = () => {
                    res.writeHead(200, { 'content-type': 'text/event-stream' });
                    res.end(records.map(value => 'data: ' + JSON.stringify(value) + '\n\n').join(''));
                };
            });
        });
        provider.listen(0, '127.0.0.1'); await once(provider, 'listening');
        try {
            await openTestChat(page);
            await page.evaluate(async ({ source, port }) => {
                const core = await import('./script.js');
                const { oai_settings } = await import('./scripts/openai.js');
                const { accountStorage } = await import('./scripts/util/AccountStorage.js');
                const { getStringHash } = await import('./scripts/utils.js');
                await core.newAssistantChat({ temporary: true });
                document.querySelector('#main_api').value = 'openai';
                core.changeMainAPI('openai');
                const proxy = 'http://127.0.0.1:' + port;
                accountStorage.setItem('Proxy_SkipConfirm_' + getStringHash(proxy), 'true');
                Object.assign(oai_settings, { chat_completion_source: source, reverse_proxy: proxy, proxy_password: 'synthetic',
                    vertexai_model: 'gemini-4-neon', google_model: 'gemini-4-neon', claude_model: 'claude-test',
                    stream_openai: true, function_calling: false, vertexai_flex: false, google_flex: false });
                core.setOnlineStatus('test');
                const box = document.querySelector('#vertex_job_enabled'); box.checked = true; box.dispatchEvent(new Event('change'));
                document.querySelector('#send_textarea').value = 'test';
                window.savedGeneration = core.Generate('normal').then(() => 'saved', e => e.message);
            }, { source, port: provider.address().port });
            await expect.poll(async () => sends || await page.evaluate(async () => Promise.race([
                window.savedGeneration, new Promise(resolve => setTimeout(() => resolve(0), 80)),
            ])), { timeout: 10000 }).toBe(1);
            await page.evaluate(async () => {
                const { oai_settings } = await import('./scripts/openai.js');
                oai_settings.vertexai_model = 'gemini-4-hydrogen';
                oai_settings.google_model = 'gemini-4-hydrogen';
                oai_settings.claude_model = 'another-claude';
            });
            release();
            expect(await page.evaluate(() => window.savedGeneration)).toBe('saved');
            const saved = await page.evaluate(async () => {
                const m = (await import('./script.js')).chat.at(-1); return [m.mes, m.extra.api, m.extra.model];
            });
            expect(saved).toEqual(['provider reply', source, google ? 'gemini-4-neon' : 'claude-test']);
            expect(sends).toBe(1);
        } finally { provider.closeAllConnections(); await new Promise(resolve => provider.close(resolve)); }
    });
}

test('Cohere stream is decoded using its original source after switching to another API', async ({ page }) => {
    await openTestChat(page);
    let submissions = 0;
    let ready = false;
    const frames = [
        { type: 'message-start', delta: { message: { role: 'assistant' } } },
        { type: 'content-delta', delta: { message: { content: { text: 'Cohere reply' } } } },
        { type: 'message-end' },
    ];
    await page.route(/\/generation-jobs(?:[/?]|$)/, route => {
        const path = new URL(route.request().url()).pathname;
        if (path.endsWith('/generation-jobs')) return route.fulfill({ status: 201, json: { id: 'fixture' } });
        if (path.endsWith('/start')) { submissions++; return route.fulfill({ status: 202 }); }
        if (path.endsWith('/claim')) return route.fulfill({ status: 204 });
        if (path.endsWith('/result')) return route.fulfill({ contentType: 'text/event-stream', body: frames.map(x => 'data: ' + JSON.stringify(x) + '\n\n').join('') });
        return route.fulfill({ json: { state: ready ? 'ready' : 'running', bytes: 0 } });
    });
    await page.evaluate(async () => {
        const core = await import('./script.js');
        const { oai_settings, sendOpenAIRequest } = await import('./scripts/openai.js');
        const { generationOrigin } = await import('./scripts/vertex-jobs.js');
        await core.newAssistantChat({ temporary: false });
        document.querySelector('#main_api').value = 'openai';
        core.changeMainAPI('openai');
        Object.assign(oai_settings, { chat_completion_source: 'cohere', cohere_model: 'command-test', stream_openai: true });
        window.cohereRequest = sendOpenAIRequest('normal', [{ role: 'user', content: 'test' }], new AbortController().signal, { background: { type: 'normal' } })
            .then(data => [data.choices[0].message.content, generationOrigin(data).source, generationOrigin(data).model], e => e.message);
    });
    await expect.poll(() => submissions).toBe(1);
    await page.evaluate(async () => { (await import('./script.js')).changeMainAPI('novel'); });
    ready = true;
    expect(await page.evaluate(() => window.cohereRequest)).toEqual(['Cohere reply', 'cohere', 'command-test']);
    expect(submissions).toBe(1);
});

async function returnToChat(mode, page, context, lifecycle, target) {
    const next = mode === 'frozen' ? page : await context.newPage();
    if (mode === 'frozen') {
        await lifecycle.send('Page.setWebLifecycleState', { state: 'active' });
        await next.evaluate(() => document.dispatchEvent(new Event('visibilitychange')));
    } else {
        await openTestChat(next);
        await next.evaluate(async ({ avatar_url, file_name }) => {
            const core = await import('./script.js');
            const index = core.characters.findIndex(c => c.avatar === avatar_url);
            await core.selectCharacterById(index);
            if (core.getCurrentChatId() !== file_name) await core.openCharacterChat(file_name);
        }, { avatar_url: target.avatar_url, file_name: target.file_name });
    }
    return next;
}

for (const [mode, evict] of [['closed', true], ['frozen', true], ['closed', false]]) {
    const suspend = mode === 'closed' ? page => page.close() : (_, session) => session.send('Page.setWebLifecycleState', { state: 'frozen' });
    const clearCache = evict ? (request, url, headers) => request.delete(url, { headers }) : () => {};
    test(`a ${mode} page can read the saved reply (cache evicted: ${evict})`, async ({ page, context }) => {
        const calls = [];
        let complete;
        const provider = http.createServer(async (req, res) => {
            const chunks = [];
            for await (const chunk of req) chunks.push(chunk);
            calls.push(JSON.parse(Buffer.concat(chunks)));
            complete = () => {
                res.writeHead(200, { 'content-type': 'application/json' });
                const message = mode === 'closed' ? { content: 'Saved overnight by the original model' }
                    : { content: null, tool_calls: [{ id: 'original-tool', type: 'function',
                        function: { name: 'save_story', arguments: JSON.stringify({ body: 'Saved overnight by the original model' }) } }] };
                res.end(JSON.stringify({ choices: [{ message }] }));
            };
        });
        provider.listen(0, '127.0.0.1');
        await once(provider, 'listening');
        try {
            await openTestChat(page);
            const target = await page.evaluate(async port => {
                const core = await import('./script.js');
                const { oai_settings } = await import('./scripts/openai.js');
                await core.newAssistantChat({ temporary: false });
                core.changeMainAPI('openai');
                Object.assign(oai_settings, { chat_completion_source: 'custom', custom_url: 'http://127.0.0.1:' + port + '/v1',
                    custom_model: 'overnight', stream_openai: false, function_calling: false });
                core.setOnlineStatus('test');
                const box = document.querySelector('#vertex_job_enabled');
                box.checked = true;
                box.dispatchEvent(new Event('change'));
                document.querySelector('#send_textarea').value = 'Synthetic overnight request';
                void core.Generate('normal');
                return { file_name: core.getCurrentChatId(), avatar_url: core.characters[core.this_chid].avatar, headers: core.getRequestHeaders() };
            }, provider.address().port);
            await expect.poll(() => calls.length).toBe(1);
            const id = await page.evaluate(() => JSON.parse(localStorage.getItem('linpeak.vertex.job.default-user')).id);
            const lifecycle = await context.newCDPSession(page);
            await suspend(page, lifecycle);
            complete();
            const load = async () => (await context.request.post('/api/chats/get', { headers: target.headers,
                data: { file_name: target.file_name, avatar_url: target.avatar_url } })).json();
            await expect.poll(async () => (await load()).at(-1)?.extra?.linpeak_job).toBe(id);
            const rows = await load();
            expect(rows.at(-1)).toMatchObject({ mes: 'Saved overnight by the original model', extra: { api: 'custom', model: 'overnight' } });
            // Evict the same in-memory entry the one-hour timer drops. The chat file is independent.
            await clearCache(context.request, '/api/backends/chat-completions/generation-jobs/' + id, target.headers);
            const next = await returnToChat(mode, page, context, lifecycle, target);
            try {
                await expect(next.locator('#chat .mes_text').filter({ hasText: 'Saved overnight by the original model' })).toHaveCount(1);
                await expect(next.locator('#vertex_job_status')).toContainText('Reply saved');
                const stored = (await load()).filter(row => row.extra?.linpeak_job === id);
                expect(stored).toHaveLength(1);
                await expect.poll(async () => Boolean((await load()).find(row => row.extra?.linpeak_job === id)?.extra.linpeak_autosaved)).toBe(evict);
                expect(calls).toHaveLength(1);
            } finally { await next.close(); }
        } finally {
            provider.closeAllConnections();
            await new Promise(resolve => provider.close(resolve));
        }
    });
}
