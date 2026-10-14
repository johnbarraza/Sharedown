/**
 * This file is part of the Sharedown (https://github.com/kylon/Sharedown).
 *
 * Browser session (persistent Chrome profile), Sharepoint REST calls and video manifest extraction.
 * The manifest logic is a port of runPuppeteerGetVideoData in preload.js.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import puppeteer from 'puppeteer';
import { describeVideo, getServerRelativePath, getSitePrefix, isVideoFile } from './meta.mjs';

const appDataPath = process.env.APPDATA ??
    (process.platform === 'darwin' ? path.join(os.homedir(), 'Library', 'Application Support') : path.join(os.homedir(), '.config'));

export const PROFILE_DIR = process.env.SHAREDOWN_MCP_PROFILE || path.join(appDataPath, 'Sharedown', 'mcp-profile');
const HEADLESS = process.env.SHAREDOWN_MCP_HEADLESS !== '0';
const TIMEOUT = (parseInt(process.env.SHAREDOWN_TIMEOUT ?? '90', 10) || 90) * 1000;
const IDLE_CLOSE_MS = 120000;
const KNOWN_RESPONSES = [
    'RenderListDataAsStream?@a1=', 'RenderListDataAsStream?@listUrl',
    'SP.List.GetListDataAsStream?listFullUrl'
];

export class NotLoggedInError extends Error {
    constructor(url) {
        super(`Not logged in to Sharepoint (redirected to ${new URL(url).hostname}). ` +
              'Run the sharepoint_login tool first, sign in in the browser window and choose "Stay signed in".');
        this.name = 'NotLoggedInError';
    }
}

let _browser = null;
let _browserHeadless = null;
let _idleTimer = null;
let _lock = Promise.resolve();

const _sleep = ms => new Promise(r => setTimeout(r, ms));

// some puppeteer calls (e.g. reading a response body) can wait forever
function _withTimeout(promise, ms, what) {
    let timer;

    return Promise.race([
        promise,
        new Promise((_, rej) => { timer = setTimeout(() => rej(new Error(`Timed out: ${what}`)), ms); })
    ]).finally(() => clearTimeout(timer));
}

export function log(msg) {
    if (process.env.SHAREDOWN_QUIET !== '1')
        process.stderr.write(`[sharedown-mcp] ${msg}\n`); // stdout is the MCP channel
}

async function _closeBrowser() {
    const b = _browser;

    _browser = null;
    _browserHeadless = null;

    if (b !== null)
        await b.close().catch(() => {});
}

async function _getBrowser(headless) {
    if (_browser !== null && _browser.connected && _browserHeadless === headless)
        return _browser;

    await _closeBrowser();
    fs.mkdirSync(PROFILE_DIR, {recursive: true});

    _browser = await puppeteer.launch({
        headless,
        userDataDir: PROFILE_DIR,
        executablePath: process.env.SHAREDOWN_CHROME_PATH || undefined,
        defaultViewport: null,
        args: ['--disable-dev-shm-usage']
    });
    _browserHeadless = headless;
    _browser.on('disconnected', () => { _browser = null; _browserHeadless = null; });

    return _browser;
}

/**
 * Run fn(page) with exclusive access to the browser (the profile can only be opened once).
 */
export function withPage(fn, {headless = HEADLESS, opTimeout = TIMEOUT * 4} = {}) {
    const run = _lock.then(async () => {
        clearTimeout(_idleTimer);

        const browser = await _getBrowser(headless);
        const page = await browser.newPage();

        page.setDefaultTimeout(TIMEOUT);
        page.setDefaultNavigationTimeout(TIMEOUT);

        try {
            return await _withTimeout(fn(page), opTimeout, 'browser operation');
        } finally {
            await page.close().catch(() => {});
            _idleTimer = setTimeout(() => _closeBrowser(), IDLE_CLOSE_MS);
        }
    });

    _lock = run.catch(() => {});
    return run;
}

export async function shutdown() {
    clearTimeout(_idleTimer);
    await _closeBrowser();
}

function _isOnHost(page, host) {
    try {
        return new URL(page.url()).hostname === host;
    } catch (e) {
        return false;
    }
}

async function _gotoSharepoint(page, url) {
    const host = new URL(url).hostname;
    const deadline = Date.now() + 20000;

    await page.goto(url, {waitUntil: 'domcontentloaded'});

    while (!_isOnHost(page, host)) { // SSO redirects go back to sharepoint by themselves when the session is valid
        if (Date.now() > deadline)
            throw new NotLoggedInError(page.url());

        await _sleep(500);
    }
}

async function _spGetJson(page, apiUrl, method = 'GET') {
    const resp = await page.evaluate(async (u, m) => {
        const r = await fetch(u, {method: m, headers: {Accept: 'application/json;odata=nometadata'}});

        return {status: r.status, body: await r.text()};
    }, apiUrl, method);

    if (resp.status === 401 || resp.status === 403)
        throw new Error(`Access denied (${resp.status}) for ${apiUrl}`);
    else if (resp.status !== 200)
        throw new Error(`Sharepoint API error ${resp.status}: ${resp.body.substring(0, 300)}`);

    return JSON.parse(resp.body);
}

function _odataPath(serverRelPath) {
    return encodeURIComponent(serverRelPath.replaceAll("'", "''"));
}

// short sharing links (/:f:/s/..., /:v:/s/...) only reveal the real path after navigation
async function _resolveServerRelativePath(page, url) {
    const known = getServerRelativePath(url);

    if (known !== null)
        return known;

    await _gotoSharepoint(page, url);

    const deadline = Date.now() + TIMEOUT;

    while (Date.now() < deadline) {
        const resolved = getServerRelativePath(page.url());

        if (resolved !== null && !resolved.startsWith('/:'))
            return resolved;

        await _sleep(500);
    }

    throw new Error(`Unable to resolve Sharepoint path for ${url}`);
}

export async function login(url, timeoutSec = 300) {
    await _lock;
    await _closeBrowser(); // need a visible browser

    return withPage(async (page) => {
        const host = new URL(url).hostname;
        const deadline = Date.now() + timeoutSec * 1000;

        await page.goto(url, {waitUntil: 'domcontentloaded'}).catch(() => {});

        while (Date.now() < deadline) {
            if (_isOnHost(page, host) && (await page.evaluate(() => document.readyState).catch(() => '')) === 'complete') {
                await _sleep(3000); // let the session cookies settle
                await _closeBrowser(); // flush cookies to the profile

                return true;
            }

            await _sleep(1000);
        }

        await _closeBrowser();
        return false;

    }, {headless: false, opTimeout: timeoutSec * 1000 + 60000});
}

async function _listFolder(page, origin, folderPath, includeSubFolds, out) {
    const api = `${origin}${getSitePrefix(folderPath)}/_api/web/GetFolderByServerRelativePath(decodedurl='${_odataPath(folderPath)}')`;
    const files = await _spGetJson(page, `${api}/Files?$select=Name,ServerRelativeUrl,TimeCreated,TimeLastModified,Length&$top=5000`);

    for (const f of files.value ?? []) {
        if (!isVideoFile(f.Name))
            continue;

        out.push(describeVideo({
            name: f.Name,
            serverRelPath: f.ServerRelativeUrl,
            origin,
            created: f.TimeCreated,
            modified: f.TimeLastModified,
            size: f.Length
        }));
    }

    if (!includeSubFolds)
        return;

    const folders = await _spGetJson(page, `${api}/Folders?$select=Name,ServerRelativeUrl`);

    for (const sub of folders.value ?? []) {
        if (sub.Name !== 'Forms')
            await _listFolder(page, origin, sub.ServerRelativeUrl, includeSubFolds, out);
    }
}

export function listFolderVideos(folderUrl, includeSubFolds = false) {
    return withPage(async (page) => {
        const origin = new URL(folderUrl).origin;
        const folderPath = await _resolveServerRelativePath(page, folderUrl);
        const out = [];

        if (!_isOnHost(page, new URL(origin).hostname))
            await _gotoSharepoint(page, `${origin}${getSitePrefix(folderPath)}`);

        await _listFolder(page, origin, folderPath, includeSubFolds, out);
        return out;
    });
}

export function getRemoteFileInfo(url) {
    return withPage(async (page) => {
        const origin = new URL(url).origin;
        const filePath = await _resolveServerRelativePath(page, url);

        if (!_isOnHost(page, new URL(origin).hostname))
            await _gotoSharepoint(page, `${origin}${getSitePrefix(filePath)}`);

        const f = await _spGetJson(page, `${origin}${getSitePrefix(filePath)}/_api/web/GetFileByServerRelativePath(decodedurl='${_odataPath(filePath)}')` +
                                         '?$select=Name,ServerRelativeUrl,TimeCreated,TimeLastModified,Length');

        return describeVideo({
            name: f.Name,
            serverRelPath: f.ServerRelativeUrl,
            origin,
            created: f.TimeCreated,
            modified: f.TimeLastModified,
            size: f.Length
        });
    });
}

/* --- video manifest (port of preload.js) --- */

function _findRow(rows, vID) {
    return (rows ?? []).find(r => r['FileRef'] === vID) ?? null;
}

async function _getSpItmUrlFromApiRequest(page) {
    const urlObj = new URL(page.url());
    const pathNameAr = urlObj.pathname.split('/');
    const rootFoldParam = urlObj.searchParams.get('id');

    if (pathNameAr.length < 6)
        return '';

    pathNameAr.pop();
    pathNameAr.pop();

    const a1 = pathNameAr.join('/');
    const apiUrl = `${urlObj.origin}/sites/${pathNameAr[2]}/_api/web/GetList(@a1)/RenderListDataAsStream?@a1='${a1}'&RootFolder=${rootFoldParam}`;
    const resp = await _withTimeout(page.evaluate(async (u) => (await fetch(u, {method: 'post'})).json(), apiUrl), TIMEOUT, 'list data request');

    return resp['CurrentFolderSpItemUrl'] ?? '';
}

async function _makeManifestUrl(donor, page, vID) {
    const data = {
        '{.mediaBaseUrl}': donor.ListSchema['.mediaBaseUrl'] ?? '',
        '{.fileType}': 'mp4',
        '{.callerStack}': donor.ListSchema['.callerStack'] ?? '',
        '{.spItemUrl}': donor.ListData['CurrentFolderSpItemUrl'] ?? '',
        '{.driveAccessToken}': donor.ListSchema['.driveAccessToken'] ?? ''
    };
    let manifest = donor.ListSchema['.videoManifestUrl'];

    if (data['{.spItemUrl}'] === '')
        data['{.spItemUrl}'] = _findRow(donor.ListData['Row'], vID)?.['.spItemUrl'] ?? '';

    if (data['{.spItemUrl}'] === '')
        data['{.spItemUrl}'] = await _getSpItmUrlFromApiRequest(page);

    if (!manifest)
        throw new Error('No video manifest template found');

    for (const [placeholder, value] of Object.entries(data)) {
        if (value === '' || !manifest.includes(placeholder))
            throw new Error(`Unable to build video manifest url: missing ${placeholder}`);

        manifest = manifest.replace(placeholder, value);
    }

    const urlObj = new URL(manifest);

    urlObj.searchParams.set('action', 'Access');
    urlObj.searchParams.set('part', 'Index');
    urlObj.searchParams.set('format', 'dash');
    urlObj.searchParams.set('useScf', 'True');
    urlObj.searchParams.set('pretranscode', '0');
    urlObj.searchParams.set('transcodeahead', '0');

    return urlObj;
}

async function _getFileName(manifestUrlObj) {
    const docid = manifestUrlObj.searchParams.get('docid');
    const tok = manifestUrlObj.searchParams.get('access_token');

    try {
        const resp = await fetch(`${docid}&access_token=${tok}`, {signal: AbortSignal.timeout(30000)});

        return (await resp.json())['name'] ?? '';

    } catch (e) {
        return '';
    }
}

/**
 * Returns {manifestUrl, title} for a video player url. The manifest url contains a short lived token,
 * get it right before downloading.
 */
export function getVideoManifest(videoUrl) {
    return withPage(async (page) => {
        const responses = [];
        const catchResponse = resp => {
            const req = resp.request();
            const type = req.resourceType();

            if ((type === 'fetch' || type === 'xhr') && KNOWN_RESPONSES.some(k => resp.url().includes(k)))
                responses.push(resp);
        };
        let donor = null;

        await _gotoSharepoint(page, videoUrl);
        await page.waitForSelector('.StreamWebApp-container');

        page.on('response', catchResponse);
        await page.reload({waitUntil: 'networkidle0'});
        page.off('response', catchResponse);

        for (const resp of responses) {
            try {
                donor = await _withTimeout(resp.json(), 15000, 'response body');
                break;
            } catch (e) {
                log(`no json body in ${resp.url()}: ${e.message}`);
            }
        }

        if (donor === null)
            throw new Error('Unable to find a valid donor response (is this a video player url?)');

        const vID = new URL(page.url()).searchParams.get('id')?.trim();
        const manifestUrl = await _makeManifestUrl(donor, page, vID);

        return {manifestUrl: manifestUrl.toString(), title: await _getFileName(manifestUrl)};
    });
}
