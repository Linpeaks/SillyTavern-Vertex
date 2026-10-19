import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { NATIVE_PDF_LIMITS, getNativePdfReferences, assertNativePdfReferences } from '../public/scripts/native-pdf.js';

const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');

/** Validate using the already bundled PDF.js, without rendering or executing PDF JS.
 * @param {Buffer} bytes @returns {Promise<number>} Page count
 */
async function inspectPdf(bytes) {
    if (!bytes.length || bytes.length > NATIVE_PDF_LIMITS.fileBytes || !bytes.subarray(0, 1024).includes(Buffer.from('%PDF-'))) {
        throw new Error('Original PDF must be a valid PDF of at most 5 MiB.');
    }
    const { getDocument, GlobalWorkerOptions } = await import('../public/lib/pdf.min.mjs');
    GlobalWorkerOptions.workerSrc = new URL('../public/lib/pdf.worker.min.mjs', import.meta.url).href;
    const task = getDocument({ data: Uint8Array.from(bytes), isEvalSupported: false, stopAtErrors: true, verbosity: 0 });
    try {
        const pdf = await task.promise;
        if (pdf.numPages < 1 || pdf.numPages > NATIVE_PDF_LIMITS.pages) throw new Error('PDF page limit exceeded.');
        // Validate the page tree, including scanned pages. Do not extract or alter contents.
        for (let page = 1; page <= pdf.numPages; page++) await pdf.getPage(page);
        return pdf.numPages;
    } catch {
        throw new Error('Cannot read this PDF. Use an unlocked, valid PDF with at most 100 pages.');
    } finally {
        await task.destroy();
    }
}

/** @param {object} directories @param {string} data @returns {Promise<object>} Safe attachment metadata */
export async function storeNativePdf(directories, data) {
    if (typeof data !== 'string' || data.length > Math.ceil(NATIVE_PDF_LIMITS.fileBytes / 3) * 4
        || data.length % 4 !== 0 || /[^A-Za-z0-9+/=]/.test(data)) {
        throw new Error('Invalid or oversized PDF upload.');
    }
    const bytes = Buffer.from(data, 'base64');
    if (bytes.toString('base64') !== data) throw new Error('Invalid PDF encoding.');
    const pages = await inspectPdf(bytes);
    const id = randomUUID();
    const filename = `native-pdf-${id}.pdf`;
    await fs.writeFile(path.join(directories.files, filename), bytes, { flag: 'wx' });
    return { id, sha256: sha256(bytes), pages, size: bytes.length, mimeType: 'application/pdf', mode: 'native',
        url: path.relative(directories.root, path.join(directories.files, filename)).split(path.sep).join('/') };
}

/** Replace references only after all text processing, in their original content position.
 * @param {object} body Google request body
 * @param {object} directories Current authenticated user's directories
 * @param {object[]} expected Selected references before conversion
 * @returns {Promise<void>}
 */
export async function resolveNativePdfs(body, directories, expected) {
    const messages = body.contents.map(content => ({ content: content.parts.map(part => ({ type: 'text', text: part.text })) }));
    assertNativePdfReferences(expected, messages);
    const cache = new Map();
    let totalBytes = 0;
    const root = await fs.realpath(directories.files);
    for (const ref of expected) {
        if (!/^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/.test(ref.id)) throw new Error('Invalid PDF attachment reference.');
        const filename = path.join(root, `native-pdf-${ref.id}.pdf`);
        let bytes;
        try {
            const resolved = await fs.realpath(filename);
            if (path.dirname(resolved) !== root || (await fs.lstat(filename)).isSymbolicLink()) throw new Error('Invalid PDF path.');
            const file = await fs.open(filename, 'r');
            try {
                const stat = await file.stat();
                if (!stat.isFile() || stat.size > NATIVE_PDF_LIMITS.fileBytes) throw new Error('Invalid PDF size.');
                bytes = Buffer.alloc(stat.size + 1);
                let bytesRead = 0;
                while (bytesRead < bytes.length) {
                    const result = await file.read(bytes, bytesRead, bytes.length - bytesRead, bytesRead);
                    if (!result.bytesRead) break;
                    bytesRead += result.bytesRead;
                }
                if (bytesRead !== stat.size) throw new Error('PDF changed during read.');
                bytes = bytes.subarray(0, bytesRead);
            } finally { await file.close(); }
        } catch { throw new Error('Original PDF is missing or unavailable for this user. Reattach the file.'); }
        if (sha256(bytes) !== ref.sha256 || await inspectPdf(bytes) !== ref.pages) throw new Error('PDF attachment changed. Reattach the file.');
        totalBytes += bytes.length;
        if (totalBytes > NATIVE_PDF_LIMITS.totalBytes) throw new Error('Native PDF total exceeds 12 MiB.');
        cache.set(ref.marker, bytes.toString('base64'));
    }
    for (const content of body.contents) {
        content.parts = content.parts.flatMap(part => {
            if (typeof part.text !== 'string') return [part];
            const refs = getNativePdfReferences({ content: part.text });
            if (!refs.length) return [part];
            const parts = [];
            let offset = 0;
            for (const ref of refs) {
                const index = part.text.indexOf(ref.marker, offset);
                if (index > offset) parts.push({ text: part.text.slice(offset, index) });
                parts.push({ inlineData: { mimeType: 'application/pdf', data: cache.get(ref.marker) } });
                offset = index + ref.marker.length;
            }
            if (offset < part.text.length) parts.push({ text: part.text.slice(offset) });
            return parts;
        });
    }
    if (Buffer.byteLength(JSON.stringify(body)) > NATIVE_PDF_LIMITS.requestBytes) {
        throw new Error('Encoded PDF request exceeds 20 MiB. Reduce attachments or context.');
    }
}
