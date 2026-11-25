import { test, expect } from '@playwright/test';
import { testSetup } from './frontent-test-utils.js';

test('Carbon task reconnects after reload and executes the complete tool call once', async ({ page, context }) => {
    test.setTimeout(90000);
    await context.route('**/api/settings/get', async route => {
        const res = await route.fetch();
        const data = await res.json();
        data.settings = JSON.stringify({ ...JSON.parse(data.settings), firstRun: false });
        await route.fulfill({ response: res, json: data });
    });
    const jobs = new Map();
    const submissions = [];
    let ready = false;
    let loseStartAck = true;
    let interruptedRead = false;
    let waitingPolls = 0;
    await context.route('**/api/backends/chat-completions/vertex-jobs**', async route => {
        const request = route.request();
        const [id, action] = new URL(request.url()).pathname.split('/vertex-jobs').pop().split('/').slice(1);
        if (!id) {
            const key = String(jobs.size + 1);
            jobs.set(key, { state: 'reserved' });
            return route.fulfill({ status: 201, json: { id: key } });
        }
        const job = jobs.get(id);
        if (!job) return route.fulfill({ status: 404, body: '' });
        if (action === 'start') {
            if (job.state !== 'reserved') throw new Error('Duplicate generation start');
            job.state = 'running';
            const payload = request.postDataJSON();
            job.stream = payload.stream;
            submissions.push(payload);
            if (loseStartAck) { loseStartAck = false; return route.abort('connectionreset'); }
            return route.fulfill({ status: 202, body: '' });
        }
        if (request.method() === 'DELETE') return route.fulfill({ status: 204 });
        if (action === 'claim') {
            if (job.state !== 'ready') return route.fulfill({ status: 409 });
            job.state = 'claimed';
            return route.fulfill({ status: 204 });
        }
        if (action === 'result') {
            if (!interruptedRead) { interruptedRead = true; return route.abort('connectionreset'); }
            const parts = id === '1'
                ? [{ functionCall: { name: 'save_test_story', args: { body: '完整正文' }, id: 'saved-call' }, thoughtSignature: 'saved-signature' }]
                : [{ text: 'Synthetic follow-up finished' }];
            if (!job.stream) return route.fulfill({ json: { choices: [{ message: { content: parts[0].text || '' } }], responseContent: { parts } } });
            return route.fulfill({ contentType: 'text/event-stream', body: 'data: ' + JSON.stringify({ candidates: [{ content: { parts }, finishReason: 'STOP' }] }) + '\r\n\r\n' });
        }
        if (ready && job.state === 'running') job.state = 'ready';
        if (!ready) waitingPolls++;
        return route.fulfill({ json: { state: job.state, bytes: 0 } });
    });
    await context.route('**/api/backends/chat-completions/generate', route => route.abort());
    async function setup(saved) {
        return page.evaluate(async savedChat => {
            const core = await import('./script.js');
            const { oai_settings } = await import('./scripts/openai.js');
            const { ToolManager } = await import('./scripts/tool-calling.js');
            core.changeMainAPI('openai');
            Object.assign(oai_settings, { chat_completion_source: 'vertexai', vertexai_model: 'gemini-4-carbon', vertexai_region: 'global',
                vertexai_auth_mode: 'express', reverse_proxy: '', stream_openai: true, function_calling: true, vertexai_flex: false });
            ToolManager.registerFunctionTool({ name: 'save_test_story', description: 'Store a synthetic response', parameters: { type: 'object', properties: { body: { type: 'string' } } },
                action: ({ body }) => {
                    const calls = JSON.parse(sessionStorage.getItem('test-story-calls') || '[]');
                    calls.push(body);
                    sessionStorage.setItem('test-story-calls', JSON.stringify(calls));
                    return 'ok';
                } });
            if (savedChat) {
                const deadline = Date.now() + 12000;
                do {
                    const id = core.characters.findIndex(ch => ch.avatar === savedChat.avatar);
                    if (id !== -1 && !core.isChatSaving && !core.is_send_press) await core.selectCharacterById(id);
                    if (core.characters[core.this_chid]?.avatar === savedChat.avatar) break;
                    if (Date.now() > deadline) throw new Error('Saved fixture character is unavailable: ' + JSON.stringify({
                        found: id !== -1, saving: core.isChatSaving, busy: core.is_send_press, characters: core.characters.length,
                    }));
                    await new Promise(resolve => setTimeout(resolve, 100));
                } while (true);
                if (core.getCurrentChatId() !== savedChat.file) await core.openCharacterChat(savedChat.file);
            } else {
                await core.newAssistantChat({ temporary: false });
            }
            core.setOnlineStatus('test');
            const checkbox = document.querySelector('#vertex_job_enabled');
            checkbox.checked = true;
            checkbox.dispatchEvent(new Event('change'));
            document.dispatchEvent(new Event('visibilitychange'));
            return { avatar: core.characters[core.this_chid].avatar, file: core.getCurrentChatId() };
        }, saved);
    }
    await testSetup.awaitST({ page });
    const identity = await setup(null);
    await page.locator('#send_textarea').fill('Use the test tool');
    await page.evaluate(async () => {
        const { Generate } = await import('./script.js');
        void Generate('normal').catch(() => {});
    });
    await expect.poll(() => waitingPolls).toBeGreaterThan(0);
    const cdp = await context.newCDPSession(page);
    await cdp.send('Page.setWebLifecycleState', { state: 'frozen' });
    await cdp.send('Page.setWebLifecycleState', { state: 'active' });
    await page.reload();
    await page.waitForFunction(async () => {
        const { eventSource, event_types } = await import('./scripts/events.js');
        return eventSource.autoFireLastArgs.has(event_types.APP_READY);
    });
    await setup(identity);
    ready = true;
    await expect.poll(() => page.evaluate(() => JSON.parse(sessionStorage.getItem('test-story-calls') || '[]')), { timeout: 30000 }).toEqual(['完整正文']);
    await expect.poll(() => page.evaluate(async () => (await import('./script.js')).chat.at(-1)?.mes), { timeout: 30000 }).toBe('Synthetic follow-up finished');
    expect(submissions).toHaveLength(2); // Original request and the distinct post-tool follow-up.
    expect(interruptedRead).toBe(true);
    const invocations = await page.evaluate(async () => (await import('./script.js')).chat.flatMap(m => m.extra?.tool_invocations || []));
    expect(invocations).toHaveLength(1);
    expect(invocations[0]).toMatchObject({ name: 'save_test_story', googleCallId: 'saved-call', signature: 'saved-signature' });
    expect(JSON.parse(invocations[0].parameters)).toEqual({ body: '完整正文' });
});

test('mobile default draws 30 of 120 messages and can load the whole history', async ({ browser }) => {
    const counts = [];
    for (const mobile of [false, true]) {
        const ctx = await browser.newContext({ baseURL: process.env.ST_BASE_URL || process.env.PLAYWRIGHT_BASE_URL || 'http://127.0.0.1:8000',
            ...(mobile ? { userAgent: 'Mozilla/5.0 (Linux; Android 14; Pixel 7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/132.0.0.0 Mobile Safari/537.36', viewport: { width: 390, height: 844 } } : {}) });
        try {
            const page = await ctx.newPage();
            await page.route('**/api/settings/get', async route => {
                const response = await route.fetch();
                const data = await response.json();
                data.settings = JSON.stringify({ ...JSON.parse(data.settings), firstRun: false });
                await route.fulfill({ response, json: data });
            });
            await testSetup.awaitST({ page });
            await expect(page.locator('#vertex_job_enabled')).toBeChecked({ checked: mobile });
            counts.push(await page.evaluate(async () => {
                const { chat, newAssistantChat, printMessages, showMoreMessages } = await import('./script.js');
                const { power_user } = await import('./scripts/power-user.js');
                await newAssistantChat({ temporary: true });
                power_user.chat_truncation = 100;
                chat.splice(0, chat.length, ...Array.from({ length: 120 }, (_, i) => ({ name: 'Test', is_user: true, mes: 'message ' + i, extra: {} })));
                document.querySelector('#chat').replaceChildren();
                await printMessages();
                const initial = document.querySelectorAll('#chat .mes').length;
                await showMoreMessages();
                return [initial, document.querySelectorAll('#chat .mes').length, chat.length, document.getElementById('vertex_job_enabled').checked];
            }));
        } finally { await ctx.close(); }
    }
    expect(counts).toEqual([[100, 120, 120, false], [30, 120, 120, true]]);
});

test('offline Stop is delivered when the connection returns without resubmitting', async ({ page }) => {
    await page.route('**/api/settings/get', async route => {
        const response = await route.fetch();
        const data = await response.json();
        data.settings = JSON.stringify({ ...JSON.parse(data.settings), firstRun: false });
        await route.fulfill({ response, json: data });
    });
    let starts = 0;
    let deletes = 0;
    let offline = true;
    await page.route('**/api/backends/chat-completions/vertex-jobs**', async route => {
        const req = route.request();
        if (req.url().endsWith('/vertex-jobs')) return route.fulfill({ status: 201, json: { id: 'stop-test' } });
        if (req.url().endsWith('/start')) { starts++; return route.fulfill({ status: 202 }); }
        if (req.method() === 'DELETE') {
            if (offline) return route.abort('internetdisconnected');
            deletes++;
            return route.fulfill({ status: 204 });
        }
        return route.fulfill({ json: { state: 'running', bytes: 0 } });
    });
    await testSetup.awaitST({ page });
    await page.evaluate(async () => {
        const { changeMainAPI, newAssistantChat, setOnlineStatus, Generate } = await import('./script.js');
        const { oai_settings } = await import('./scripts/openai.js');
        await newAssistantChat({ temporary: true });
        changeMainAPI('openai');
        Object.assign(oai_settings, { chat_completion_source: 'vertexai', vertexai_auth_mode: 'express', reverse_proxy: '', vertexai_model: 'gemini-4-carbon' });
        setOnlineStatus('test');
        const box = document.querySelector('#vertex_job_enabled');
        box.checked = true;
        box.dispatchEvent(new Event('change'));
        document.querySelector('#send_textarea').value = 'test cancellation';
        void Generate('normal').catch(() => {});
    });
    await expect.poll(() => starts).toBe(1);
    await page.locator('#vertex_job_cancel').click();
    await expect(page.locator('#vertex_job_status')).toContainText('Stop pending');
    offline = false;
    await page.evaluate(() => window.dispatchEvent(new Event('online')));
    await expect.poll(() => deletes).toBe(1);
    await expect(page.locator('#vertex_job_bar')).toBeHidden();
    expect(starts).toBe(1);
});

test('missing tool keeps complete arguments available without claiming or executing it', async ({ page }) => {
    await page.route('**/api/settings/get', async route => {
        const response = await route.fetch();
        const data = await response.json();
        data.settings = JSON.stringify({ ...JSON.parse(data.settings), firstRun: false });
        await route.fulfill({ response, json: data });
    });
    let claims = 0;
    await page.route('**/api/backends/chat-completions/vertex-jobs**', route => {
        const req = route.request();
        if (req.url().endsWith('/vertex-jobs')) return route.fulfill({ status: 201, json: { id: 'missing-tool' } });
        if (req.url().endsWith('/start')) return route.fulfill({ status: 202 });
        if (req.url().endsWith('/claim')) { claims++; return route.fulfill({ status: 204 }); }
        if (req.url().endsWith('/result')) return route.fulfill({ json: { choices: [{ message: { content: '' } }],
            responseContent: { parts: [{ functionCall: { name: 'uninstalled_tool', args: { body: 'complete synthetic story' } } }] } } });
        return route.fulfill({ json: { state: 'ready', bytes: 100 } });
    });
    await testSetup.awaitST({ page });
    await page.waitForFunction(async () => {
        const { eventSource, event_types } = await import('./scripts/events.js');
        return eventSource.autoFireLastArgs.has(event_types.APP_READY);
    });
    await page.evaluate(async () => {
        const { changeMainAPI, newAssistantChat } = await import('./script.js');
        const { oai_settings, sendOpenAIRequest } = await import('./scripts/openai.js');
        await newAssistantChat({ temporary: false });
        changeMainAPI('openai');
        Object.assign(oai_settings, { chat_completion_source: 'vertexai', vertexai_auth_mode: 'express', reverse_proxy: '', vertexai_model: 'gemini-4-carbon', stream_openai: false });
        await sendOpenAIRequest('normal', [{ role: 'user', content: 'test' }], new AbortController().signal,
            { background: { type: 'normal', depth: 0, canPerformToolCalls: true } }).catch(() => {});
    });
    await expect(page.locator('#vertex_job_status')).toContainText('unavailable');
    await page.locator('#vertex_job_open').click();
    await expect(page.locator('dialog[open] textarea[readonly]')).toHaveValue(/complete synthetic story/);
    expect(claims).toBe(0);
});
