import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { createHash } from 'node:crypto';
import { afterEach, beforeEach, expect, jest, test } from '@jest/globals';
import { storeNativePdf, resolveNativePdfs } from '../src/native-pdf.js';
import { nativePdfMarker, getNativePdfReferences, assertNativePdfReferences, validateNativePdfRequest, estimateNativePdfTokens } from '../public/scripts/native-pdf.js';
import { makePdf } from './fixtures/native-pdf.js';

jest.unstable_mockModule('../src/util.js', () => ({
    getConfigValue: (_key, fallback) => fallback,
    tryParse: value => { try { return JSON.parse(value); } catch { return undefined; } },
}));
const { postProcessPrompt, convertGooglePrompt, PROMPT_PROCESSING_TYPE } = await import('../src/prompt-converters.js');
let directories;
beforeEach(async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'st-native-pdf-test-'));
    directories = { root, files: path.join(root, 'files') };
    await fs.mkdir(directories.files);
});
afterEach(async () => {
    const resolved = path.resolve(directories.root);
    if (path.dirname(resolved) !== path.resolve(os.tmpdir()) || !path.basename(resolved).startsWith('st-native-pdf-test-')) throw new Error('Unsafe test cleanup path');
    await fs.rm(resolved, { recursive: true, force: true });
});
const request = messages => ({ messages, model: 'gemini-4-argon', chat_completion_source: 'vertexai', vertexai_auth_mode: 'full' });

test('stores original bytes and metadata, including text, vector chart and raster image', async () => {
    const bytes = makePdf();
    const file = await storeNativePdf(directories, bytes.toString('base64'));
    expect(file).toMatchObject({ mode: 'native', mimeType: 'application/pdf', pages: 1, size: bytes.length,
        sha256: createHash('sha256').update(bytes).digest('hex') });
    expect(await fs.readFile(path.join(directories.root, file.url))).toEqual(bytes);
    expect(file).not.toHaveProperty('data');
    expect(file.url).toMatch(/^files\/native-pdf-[a-f0-9-]+\.pdf$/);
});

test('survives text-only preset JSON wrapping, merge_tools and Google conversion without duplication', async () => {
    const bytes = makePdf();
    const file = await storeNativePdf(directories, bytes.toString('base64'));
    const marker = nativePdfMarker(file);
    const selected = [{ role: 'user', content: marker + '\nquestion' }];
    const refs = validateNativePdfRequest(request(selected));
    // Same destructive content-to-text / JSON string shape as preset squash processing.
    const squashed = [{ role: 'user', content: JSON.stringify({ history: selected.map(message => message.content) }) }];
    assertNativePdfReferences(refs, squashed);
    const names = { charName: '', userName: '', startsWithGroupName: () => false };
    const processed = postProcessPrompt(squashed, PROMPT_PROCESSING_TYPE.MERGE_TOOLS, names);
    assertNativePdfReferences(refs, processed);
    const body = convertGooglePrompt(processed, 'gemini-4-argon', false, names);
    await resolveNativePdfs(body, directories, refs);
    const pdfParts = body.contents.flatMap(content => content.parts).filter(part => part.inlineData);
    expect(pdfParts).toHaveLength(1);
    expect(pdfParts[0].inlineData.mimeType).toBe('application/pdf');
    expect(Buffer.from(pdfParts[0].inlineData.data, 'base64')).toEqual(bytes);
    expect(JSON.stringify(body)).not.toContain('ST_NATIVE_PDF');
    expect(JSON.stringify(body)).toContain('question');
    expect(estimateNativePdfTokens(selected)).toBe(4096);
});

test('preserves placement in history and multiple files; metadata survives JSON reload', async () => {
    const one = await storeNativePdf(directories, makePdf('one').toString('base64'));
    const two = await storeNativePdf(directories, makePdf('two').toString('base64'));
    const saved = JSON.parse(JSON.stringify({ extra: { files: [{ ...one, name: '中文图表.pdf' }, two] } }));
    const messages = saved.extra.files.map(file => ({ content: nativePdfMarker(file) }));
    const refs = getNativePdfReferences(messages);
    const body = { contents: messages.map(message => ({ role: 'user', parts: [{ text: message.content }, { text: 'question' }] })) };
    await resolveNativePdfs(body, directories, refs);
    expect(body.contents.map(content => Buffer.from(content.parts[0].inlineData.data, 'base64'))).toEqual([makePdf('one'), makePdf('two')]);
    expect(body.contents[0].parts[1]).toEqual({ text: 'question' });
});

test('rejects missing, changed and another user files before submission', async () => {
    const file = await storeNativePdf(directories, makePdf().toString('base64'));
    const refs = getNativePdfReferences({ content: nativePdfMarker(file) });
    const body = () => ({ contents: [{ role: 'user', parts: [{ text: refs[0].marker }] }] });
    const other = path.join(directories.root, 'other-files');
    await fs.mkdir(other);
    await expect(resolveNativePdfs(body(), { files: other }, refs)).rejects.toThrow(/missing|unavailable/);
    await fs.writeFile(path.join(directories.root, file.url), makePdf('changed'));
    await expect(resolveNativePdfs(body(), directories, refs)).rejects.toThrow('changed');
    await fs.unlink(path.join(directories.root, file.url));
    await expect(resolveNativePdfs(body(), directories, refs)).rejects.toThrow(/missing|unavailable/);
});

test('rejects corrupt, non-PDF, bad encoding and oversized files', async () => {
    for (const data of ['!bad', Buffer.from('not PDF').toString('base64'), Buffer.from('%PDF-1.4\ninvalid').toString('base64'), 'A'.repeat(7 * 1024 * 1024)]) {
        await expect(storeNativePdf(directories, data)).rejects.toThrow();
    }
    expect(await fs.readdir(directories.files)).toEqual([]);
    await expect(storeNativePdf(directories, makePdf('many pages', 101).toString('base64'))).rejects.toThrow(/100 pages/);
});

test('enforces aggregate bytes and encoded request size before generation', async () => {
    const padded = Buffer.concat([makePdf(), Buffer.alloc(Math.floor(4.1 * 1024 * 1024), 32)]);
    const file = await storeNativePdf(directories, padded.toString('base64'));
    const marker = nativePdfMarker(file);
    const refs = getNativePdfReferences({ content: marker.repeat(3) });
    await expect(resolveNativePdfs({ contents: [{ parts: [{ text: marker.repeat(3) }] }] }, directories, refs)).rejects.toThrow(/12 MiB/);
    const small = await storeNativePdf(directories, makePdf().toString('base64'));
    const smallMarker = nativePdfMarker(small);
    await expect(resolveNativePdfs({ contents: [{ parts: [{ text: smallMarker }, { text: 'x'.repeat(20 * 1024 * 1024) }] }] },
        directories, getNativePdfReferences({ content: smallMarker }))).rejects.toThrow(/20 MiB/);
});

test('rejects a real password-protected PDF without storing it', async () => {
    // Generated from makePdf() with pypdf; password is synthetic-test-password.
    const encrypted = await fs.readFile(new URL('./fixtures/native-pdf-encrypted.pdf', import.meta.url));
    await expect(storeNativePdf(directories, encrypted.toString('base64'))).rejects.toThrow(/unlocked/);
    expect(await fs.readdir(directories.files)).toEqual([]);
});

test('rejects unsupported models/providers/proxies and lost or duplicated references', async () => {
    const file = await storeNativePdf(directories, makePdf().toString('base64'));
    const marker = nativePdfMarker(file);
    const messages = [{ role: 'user', content: marker }];
    for (const change of [{ model: 'gemini-unknown' }, { chat_completion_source: 'openai' }, { reverse_proxy: 'https://example.com' }]) {
        expect(() => validateNativePdfRequest({ ...request(messages), ...change })).toThrow(/require/);
    }
    const refs = getNativePdfReferences(messages);
    expect(() => assertNativePdfReferences(refs, [{ content: 'stripped' }])).toThrow(/removed/);
    expect(() => assertNativePdfReferences(refs, [{ content: marker + marker }])).toThrow(/duplicated/);
    expect(() => validateNativePdfRequest({ ...request([]), native_pdf_refs: [marker] })).toThrow(/removed/);
    expect(() => getNativePdfReferences({ content: '[[ST_NATIVE_PDF:../../secret]]' })).toThrow(/damaged/);
    expect(() => validateNativePdfRequest(request(Array(5).fill(messages[0])))).toThrow(/4 attachments/);
    expect(validateNativePdfRequest({ messages: [{ content: 'ordinary text' }], model: 'anything' })).toEqual([]);
});
