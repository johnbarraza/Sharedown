/**
 * This file is part of the Sharedown (https://github.com/kylon/Sharedown).
 *
 * Checks for the external programs and folders the MCP server needs.
 */
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import puppeteer from 'puppeteer';

export const YTDLP = process.env.SHAREDOWN_YTDLP_PATH || 'yt-dlp';
export const FFMPEG = process.env.SHAREDOWN_FFMPEG_PATH || 'ffmpeg';
export const FFPROBE = process.env.SHAREDOWN_FFMPEG_PATH ?
    path.join(path.dirname(process.env.SHAREDOWN_FFMPEG_PATH), `ffprobe${process.platform === 'win32' ? '.exe' : ''}`) : 'ffprobe';

const winget = process.platform === 'win32';

function _version(cmd, args) {
    const res = spawnSync(cmd, args, {encoding: 'utf8', windowsHide: true, timeout: 20000});

    if (res.error || res.status !== 0)
        return null;

    return res.stdout.split(/\r?\n/)[0].trim();
}

async function _chromePath() {
    const p = process.env.SHAREDOWN_CHROME_PATH || await puppeteer.executablePath();

    return fs.existsSync(p) ? p : null;
}

export function checkYtdlp() {
    const v = _version(YTDLP, ['--version']);

    return {name: 'yt-dlp', ok: v !== null, version: v ?? undefined,
            fix: v === null ? (winget ? 'winget install yt-dlp.yt-dlp' : 'https://github.com/yt-dlp/yt-dlp/releases') +
                              ' (or set SHAREDOWN_YTDLP_PATH)' : undefined};
}

export function checkFFmpeg() {
    const v = _version(FFPROBE, ['-version']) === null ? null : _version(FFMPEG, ['-version']); // ffprobe checks the downloads

    return {name: 'ffmpeg', ok: v !== null, version: v?.split(' ').slice(0, 3).join(' '),
            fix: v === null ? (winget ? 'winget install Gyan.FFmpeg' : 'https://ffmpeg.org/download.html') +
                              ' (or set SHAREDOWN_FFMPEG_PATH)' : undefined};
}

export async function checkChrome() {
    const p = await _chromePath();

    return {name: 'chrome', ok: p !== null, path: p ?? undefined,
            fix: p === null ? 'run "npm run install-chrome" in the Sharedown mcp folder (or set SHAREDOWN_CHROME_PATH)' : undefined};
}

export function checkNode() {
    const major = parseInt(process.versions.node.split('.')[0], 10);

    return {name: 'node', ok: major >= 18, version: process.versions.node, fix: major >= 18 ? undefined : 'install Node.js 18 or newer'};
}

export function checkOutputDir(dir) {
    try {
        fs.mkdirSync(dir, {recursive: true});
        fs.accessSync(dir, fs.constants.W_OK);

        return {name: 'output folder', ok: true, path: dir};

    } catch (e) {
        return {name: 'output folder', ok: false, path: dir, fix: `choose another output_dir (${e.code ?? e.message})`};
    }
}

export function checkLoginProfile(profileDir) {
    const hasProfile = fs.existsSync(path.join(profileDir, 'Default'));

    return {name: 'saved login', ok: hasProfile, path: profileDir,
            fix: hasProfile ? undefined : 'run sharepoint_login once',
            note: hasProfile ? 'a session was saved; if it expired the tools will ask to log in again' : undefined};
}

/**
 * Returns a list of failed checks for the given needs ('download', 'convert')
 */
export async function missingFor(need, outputDir) {
    const checks = need === 'convert' ? [checkFFmpeg()] : [checkYtdlp(), checkFFmpeg(), await checkChrome()];

    if (outputDir)
        checks.push(checkOutputDir(outputDir));

    return checks.filter(c => !c.ok);
}

export function formatMissing(missing) {
    return 'Missing requirements:\n' + missing.map(c => `- ${c.name}: ${c.fix}`).join('\n');
}
