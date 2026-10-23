import path from 'node:path';
import fs from 'node:fs';

import express from 'express';
import sanitize from 'sanitize-filename';
import { sync as writeFileSyncAtomic } from 'write-file-atomic';

import { validateAssetFileName } from './assets.js';
import { clientRelativePath } from '../util.js';
import { storeNativePdf } from '../native-pdf.js';
import { NATIVE_PDF_LIMITS, NATIVE_PDF_SIZE_ERROR } from '../../public/scripts/native-pdf.js';

export const router = express.Router();

router.post('/upload-pdf', async (request, response) => {
    try {
        const binary = request.is('application/pdf');
        if (binary) {
            // Bounded raw upload avoids base64/JSON copies in the browser and
            // server. Authentication and CSRF middleware still run first.
            await new Promise((resolve, reject) => {
                express.raw({ type: 'application/pdf', limit: NATIVE_PDF_LIMITS.fileBytes, inflate: false })(request, response,
                    error => error ? reject(error) : resolve());
            });
        }
        return response.send(await storeNativePdf(request.user.directories, binary ? request.body : request.body?.data));
    } catch (error) {
        // No file contents, local paths or user filenames in diagnostics.
        if (response.destroyed) return;
        if (error.type === 'entity.too.large' || error.message === NATIVE_PDF_SIZE_ERROR) {
            return response.status(413).send({ error: NATIVE_PDF_SIZE_ERROR });
        }
        return response.status(400).send({ error: `PDF upload failed. Use a valid, unlocked PDF up to ${NATIVE_PDF_LIMITS.fileBytes / 1e6} MB and ${NATIVE_PDF_LIMITS.pages} pages.` });
    }
});

router.post('/sanitize-filename', async (request, response) => {
    try {
        const fileName = String(request.body.fileName);
        if (!fileName) {
            return response.status(400).send('No fileName specified');
        }

        const sanitizedFilename = sanitize(fileName);
        return response.send({ fileName: sanitizedFilename });
    } catch (error) {
        console.error(error);
        return response.sendStatus(500);
    }
});

router.post('/upload', async (request, response) => {
    try {
        if (!request.body.name) {
            return response.status(400).send('No upload name specified');
        }

        if (!request.body.data) {
            return response.status(400).send('No upload data specified');
        }

        // Validate filename
        const validation = validateAssetFileName(request.body.name);
        if (validation.error)
            return response.status(400).send(validation.message);

        const pathToUpload = path.join(request.user.directories.files, request.body.name);
        writeFileSyncAtomic(pathToUpload, request.body.data, 'base64');
        const url = clientRelativePath(request.user.directories.root, pathToUpload);
        console.info(`Uploaded file: ${url} from ${request.user.profile.handle}`);
        return response.send({ path: url });
    } catch (error) {
        console.error(error);
        return response.sendStatus(500);
    }
});

router.post('/delete', async (request, response) => {
    try {
        if (!request.body.path) {
            return response.status(400).send('No path specified');
        }

        const pathToDelete = path.join(request.user.directories.root, request.body.path);
        if (!pathToDelete.startsWith(request.user.directories.files)) {
            return response.status(400).send('Invalid path');
        }

        if (!fs.existsSync(pathToDelete)) {
            return response.status(404).send('File not found');
        }

        fs.unlinkSync(pathToDelete);
        console.info(`Deleted file: ${request.body.path} from ${request.user.profile.handle}`);
        return response.sendStatus(200);
    } catch (error) {
        console.error(error);
        return response.sendStatus(500);
    }
});

router.post('/verify', async (request, response) => {
    try {
        if (!Array.isArray(request.body.urls)) {
            return response.status(400).send('No URLs specified');
        }

        const verified = {};

        for (const url of request.body.urls) {
            const pathToVerify = path.join(request.user.directories.root, url);
            if (!pathToVerify.startsWith(request.user.directories.files)) {
                console.warn(`File verification: Invalid path: ${pathToVerify}`);
                continue;
            }
            const fileExists = fs.existsSync(pathToVerify);
            verified[url] = fileExists;
        }

        return response.send(verified);
    } catch (error) {
        console.error(error);
        return response.sendStatus(500);
    }
});
