import { expect, test } from '@playwright/test';
import { testSetup } from './frontent-test-utils.js';

test.beforeEach(async ({ page }) => {
    await page.route('**/api/settings/get', async route => {
        const response = await route.fetch();
        const data = await response.json();
        data.settings = JSON.stringify({ ...JSON.parse(data.settings), firstRun: false });
        await route.fulfill({ response, json: data });
    });
    await testSetup.awaitST({ page });
});

test('turn image scope leaves saved history, PDFs and the selected video intact', async ({ page }) => {
    const result = await page.evaluate(async () => {
        const { applyTurnImageScope } = await import('./scripts/composer-attachments.js');
        const image = { type: 'image', url: '/image.png' };
        const video = { type: 'video', url: '/video.mp4' };
        const history = [
            { is_user: true, extra: { media: [image, video], media_display: 'gallery', media_index: 1, files: [{ mode: 'native', name: 'notes.pdf' }] } },
            { is_user: false, extra: { media: [image] } },
            { is_user: true, extra: { media: [image], onlyTurnImages: true } },
            { is_system: true, is_user: true, extra: {} },
        ];
        const reference = JSON.stringify(history);
        const scoped = applyTurnImageScope(history);
        const nextTurn = [...history, { is_user: true, extra: {} }];
        return [scoped[0].extra.media.map(x => x.type), scoped[0].extra.media_index, scoped[0].extra.files[0].name,
            scoped[1].extra.media.length, scoped[2].extra.media.length, JSON.stringify(history) === reference,
            applyTurnImageScope(nextTurn) === nextTurn];
    });
    expect(result).toEqual([['video'], 0, 'notes.pdf', 0, 1, true, true]);
});

test('review can cancel a prepared Google request or send it exactly once', async ({ page }) => {
    const calls = [];
    await page.route('**/api/backends/chat-completions/generate', async route => {
        calls.push(route.request().postDataJSON());
        await route.fulfill({ json: { candidates: [{ content: { parts: [{ text: 'ok' }] } }] } });
    });
    await page.evaluate(async () => {
        const { changeMainAPI } = await import('./script.js');
        const { oai_settings, sendOpenAIRequest } = await import('./scripts/openai.js');
        changeMainAPI('openai');
        Object.assign(oai_settings, { chat_completion_source: 'vertexai', vertexai_model: 'gemini-4-neon',
            vertexai_region: 'global', vertexai_auth_mode: 'express', reverse_proxy: '', stream_openai: false, vertexai_flex: false });
        const { chat } = await import('./script.js');
        const { nativePdfMarker } = await import('./scripts/native-pdf.js');
        const file = { id: '01234567-89ab-cdef-0123-456789abcdef', sha256: 'f'.repeat(64), pages: 1, name: '<notes>.pdf', mode: 'native' };
        chat.push({ is_user: true, extra: { files: [file] } });
        window.testReviewRequest = () => sendOpenAIRequest('normal', [{ role: 'user', content: nativePdfMarker(file) }]);
        const panel = document.querySelector('#composer_attachments');
        panel.open = true;
    });
    for (const accept of [false, true]) {
        await page.locator('#composer_review_once').check();
        await page.evaluate(() => { window.reviewResult = window.testReviewRequest().then(() => 'sent', error => error.name); });
        const dialog = page.locator('dialog[open]').filter({ hasText: 'gemini-4-neon' });
        await expect(dialog).toContainText('Standard');
        await expect(dialog).toContainText('Original PDFs: 1');
        await expect(dialog.locator('li')).toHaveText('<notes>.pdf');
        expect(calls).toHaveLength(0);
        await dialog.locator(accept ? '.popup-button-ok' : '.popup-button-cancel').click();
        expect(await page.evaluate(() => window.reviewResult)).toBe(accept ? 'sent' : 'AbortError');
        await expect(page.locator('#composer_review_once')).not.toBeChecked();
    }
    expect(calls).toHaveLength(1);
});

test('a new upload can be sent without resending saved images', async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    const image = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScLbtAAAAABJRU5ErkJggg==', 'base64');
    const dataUrl = 'data:image/png;base64,' + image.toString('base64');
    const calls = [];
    await page.route('**/api/backends/chat-completions/generate', async route => {
        calls.push(route.request().postDataJSON());
        await route.fulfill({ json: { candidates: [{ content: { parts: [{ text: 'ok' }] } }] } });
    });
    await page.evaluate(async url => {
        const { chat, changeMainAPI, newAssistantChat, setOnlineStatus } = await import('./script.js');
        const { oai_settings } = await import('./scripts/openai.js');
        await newAssistantChat({ temporary: true });
        changeMainAPI('openai');
        Object.assign(oai_settings, { chat_completion_source: 'vertexai', vertexai_model: 'gemini-4-neon',
            vertexai_region: 'global', vertexai_auth_mode: 'express', reverse_proxy: '', media_inlining: true,
            stream_openai: false, vertexai_flex: false });
        setOnlineStatus('test');
        chat.push({ name: 'User', is_user: true, mes: 'previous image', extra: { media: [{ type: 'image', url }] } });
        document.querySelector('#composer_attachments').open = true;
    }, dataUrl);
    await page.locator('#file_form_input').setInputFiles({ name: 'new.png', mimeType: 'image/png', buffer: image });
    await expect(page).toHaveTitle('Linpeak');
    await expect(page.locator('#composer_image_count')).toHaveText('New images: 1 · History: 1');
    const bounds = await page.locator('#composer_attachments').boundingBox();
    expect(bounds.x + bounds.width).toBeLessThanOrEqual(390);
    await page.locator('#composer_turn_images').check();
    await expect(page.locator('#composer_image_count')).toHaveText('New images: 1 · History: 0');
    await page.locator('#send_textarea').fill('Describe the new image');
    await page.evaluate(async () => { const { Generate } = await import('./script.js'); await Generate('normal'); });
    expect(calls).toHaveLength(1);
    const countImages = body => body.messages.flatMap(message => Array.isArray(message.content) ? message.content : []).filter(part => part.type === 'image_url').length;
    expect(countImages(calls[0])).toBe(1);
    await expect(page.locator('#composer_turn_images')).not.toBeChecked();
    expect(await page.evaluate(async () => {
        const { chat } = await import('./script.js');
        return chat.filter(message => message.is_user && message.extra?.media?.length).map(message => !!message.extra.onlyTurnImages);
    })).toEqual([false, true]);
    await page.locator('#send_textarea').fill('Now use the whole history');
    await page.evaluate(async () => { const { Generate } = await import('./script.js'); await Generate('normal'); });
    expect(calls).toHaveLength(2);
    expect(countImages(calls[1])).toBe(2);
});
