/**
 * This file is part of the Sharedown (https://github.com/kylon/Sharedown).
 *
 * Background jobs, one item at a time:
 * - download: Sharepoint video with yt-dlp (DASH manifest), like Sharedown does with the yt-dlp downloader
 * - convert: local file to another format with ffmpeg
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { applyNameTemplate, AUDIO_FORMATS } from './meta.mjs';
import { findDownloaded, loadHistory, recordDownload } from './history.mjs';
import { FFMPEG, YTDLP } from './requirements.mjs';
import { getVideoManifest, log } from './sharepoint.mjs';
import { verifyMedia } from './verify.mjs';

export const DEFAULT_OUTPUT_DIR = path.resolve(process.env.SHAREDOWN_OUTPUT_DIR || path.join(os.homedir(), 'Downloads', 'sharedownVideos'));
// Sharepoint answers 429 Too Many Requests when too many fragments are requested at once
const YTDLP_N = String(Math.min(Math.max(parseInt(process.env.SHAREDOWN_YTDLP_N ?? '3', 10) || 3, 1), 5));
const FFMPEG_CODECS = {
    mp4: ['-c', 'copy', '-movflags', '+faststart'],
    mkv: ['-c', 'copy'],
    mp3: ['-vn', '-c:a', 'libmp3lame', '-q:a', '4'],
    m4a: ['-vn', '-c:a', 'aac', '-b:a', '128k'],
    opus: ['-vn', '-c:a', 'libopus', '-b:a', '64k'],
    wav: ['-vn', '-c:a', 'pcm_s16le'],
    flac: ['-vn', '-c:a', 'flac']
};

const _jobs = new Map();
const _queue = []; // {job, item}
let _worker = null;
let _current = null; // {item, proc}

function _run(cmd, args, onLine) {
    return new Promise((resolve, reject) => {
        const proc = spawn(cmd, args, {windowsHide: true, env: {...process.env, PYTHONIOENCODING: 'utf-8'}});
        let lastErr = '';

        _current.proc = proc;

        const onData = data => {
            for (const line of data.toString().split(/\r?\n/)) {
                if (/ERROR|Error |Invalid|No such file/.test(line))
                    lastErr = line.trim();

                onLine(line);
            }
        };

        proc.stdout.on('data', onData);
        proc.stderr.on('data', onData);
        proc.on('error', e => reject(new Error(`Unable to run ${cmd}: ${e.message}`)));
        proc.on('close', code => code === 0 ? resolve() : reject(new Error(lastErr || `${cmd} exit code ${code}`)));
    });
}

function _ytdlpArgs(manifestUrl, outFile, format) {
    const base = outFile.substring(0, outFile.length - path.extname(outFile).length).replaceAll('%', '%%'); // '%' is a yt-dlp template char
    // never skip a fragment (default yt-dlp behaviour): it leaves silent gaps in the video
    const args = ['--no-part', '--newline', '--encoding', 'utf-8', '-N', YTDLP_N,
                  '--retries', '20', '--fragment-retries', '20', '--abort-on-unavailable-fragments',
                  '--retry-sleep', 'http:exp=2:120', '--retry-sleep', 'fragment:exp=2:120',
                  '-o', `${base}.%(ext)s`];

    if (AUDIO_FORMATS.includes(format))
        args.push('-f', 'bestaudio/best', '-x', '--audio-format', format); // audio only: much smaller download
    else
        args.push('--merge-output-format', format);

    if (process.env.SHAREDOWN_FFMPEG_PATH)
        args.push('--ffmpeg-location', process.env.SHAREDOWN_FFMPEG_PATH);

    args.push(manifestUrl);
    return args;
}

function _killCurrent() {
    const proc = _current?.proc;

    if (!proc || proc.exitCode !== null)
        return;

    if (process.platform === 'win32')
        spawn('taskkill', ['/pid', String(proc.pid), '/f', '/t'], {windowsHide: true});
    else
        proc.kill();
}

async function _resolve(job, item) {
    item.status = 'resolving';

    try {
        return await getVideoManifest(item.url);

    } catch (e) {
        if (job.canceled || e.name === 'NotLoggedInError')
            throw e;

        log(`retrying ${item.name}: ${e.message}`);
        item.progress = 'retrying';
        return getVideoManifest(item.url);
    }
}

// yt-dlp leftovers of a failed download: name.fvcopy.mp4, name.faudcopy.m4a-Frag12, name.*.ytdl, ...
function _removePartialFiles(outFile) {
    const dir = path.dirname(outFile);
    const base = path.parse(outFile).name;

    for (const f of fs.readdirSync(dir)) {
        if (f.startsWith(`${base}.`) && path.join(dir, f) !== outFile)
            fs.rmSync(path.join(dir, f), {force: true});
    }
}

async function _download(job, item) {
    let {manifestUrl, title} = await _resolve(job, item);

    if (job.canceled)
        throw new Error('canceled');

    const info = title ? {...item.info, name: title} : item.info;
    const outFile = path.join(job.output_dir, applyNameTemplate(job.name_template, info, item.index, job.format));
    let streams = 0;

    item.file = outFile;

    if (job.skip_existing && fs.existsSync(outFile)) {
        item.status = 'skipped';
        item.progress = 'file already exists';
        return;
    }

    fs.mkdirSync(job.output_dir, {recursive: true});
    item.status = 'downloading';
    item.progress = 'starting';

    // a failed fragment (network error, expired token) fails the whole download: start again with a new manifest url
    for (let attempt = 1; ; ++attempt) {
        try {
            await _run(YTDLP, _ytdlpArgs(manifestUrl, outFile, job.format), line => {
                const m = line.match(/^\[download\]\s+(\d+(?:\.\d+)?)%/);

                if (line.includes('Destination:'))
                    ++streams;
                else if (line.startsWith('[Merger]') || line.startsWith('[ExtractAudio]'))
                    item.progress = 'converting';
                else if (m !== null)
                    item.progress = AUDIO_FORMATS.includes(job.format) ? `${m[1]}%` : `${streams <= 1 ? 'video' : 'audio'} ${m[1]}%`;
                else if (/HTTP Error 429/.test(line))
                    item.progress = `${item.progress.replace(/ \(throttled.*$/, '')} (throttled by Sharepoint, waiting)`;
            });

            if (!fs.existsSync(outFile))
                throw new Error(`yt-dlp finished but ${outFile} was not found`);

            item.progress = 'verifying';

            const check = await verifyMedia(outFile);

            if (!check.ok) {
                fs.rmSync(outFile, {force: true});
                throw new Error(`incomplete download (${check.problems.join('; ')})`);
            }

            break;

        } catch (e) {
            if (job.canceled) // keep the partial files: yt-dlp resumes them on the next run
                throw e;

            _removePartialFiles(outFile);

            if (attempt >= 2)
                throw e;

            log(`download failed, retrying ${item.name}: ${e.message}`);
            streams = 0;
            ({manifestUrl} = await _resolve(job, item));
            item.status = 'downloading';
            item.progress = 'retrying';
        }
    }

    recordDownload(job.output_dir, item.info, job.format, outFile);
    item.status = 'done';
    item.progress = '100%';
}

async function _convert(job, item) {
    if (fs.existsSync(item.file) && job.skip_existing) {
        item.status = 'skipped';
        item.progress = 'file already exists';
        return;
    }

    let duration = 0;

    fs.mkdirSync(path.dirname(item.file), {recursive: true});
    item.status = 'converting';
    item.progress = 'starting';

    await _run(FFMPEG, ['-hide_banner', '-nostdin', '-y', '-i', item.src, ...FFMPEG_CODECS[job.format], '-progress', 'pipe:1', '-nostats', item.file], line => {
        const d = line.match(/Duration: (\d+):(\d+):(\d+(?:\.\d+)?)/);
        const t = line.match(/^out_time_us=(\d+)/);

        if (d !== null && duration === 0)
            duration = (+d[1] * 3600 + +d[2] * 60 + +d[3]) * 1e6;
        else if (t !== null && duration > 0)
            item.progress = `${Math.min(100, Math.floor(+t[1] / duration * 100))}%`;
    });

    item.status = 'done';
    item.progress = '100%';
}

async function _work() {
    while (_queue.length > 0) {
        const {job, item} = _queue.shift();

        if (job.canceled || item.status === 'canceled') {
            item.status = 'canceled';
            continue;
        }

        _current = {item, proc: null};
        item.started = new Date().toISOString();

        try {
            await (job.kind === 'convert' ? _convert(job, item) : _download(job, item));

        } catch (e) {
            item.status = job.canceled ? 'canceled' : 'error';
            item.error = job.canceled ? undefined : e.message;

            if (job.canceled && job.kind === 'download')
                item.progress = 'stopped, it continues from here on the next run';
            log(`${job.kind} failed: ${item.name}: ${e.message}`);

            if (job.kind === 'convert' && fs.existsSync(item.file))
                fs.rmSync(item.file, {force: true}); // partial output

        } finally {
            item.finished = new Date().toISOString();
            _current = null;
        }
    }

    _worker = null;
}

function _startJob(job) {
    _jobs.set(job.id, job);

    for (const item of job.items) {
        if (item.status === 'queued')
            _queue.push({job, item});
    }

    if (_worker === null)
        _worker = _work();

    return job;
}

/**
 * videos: list of describeVideo() objects. Videos downloaded before in output_dir are skipped unless force is set.
 */
export function startDownloadJob(videos, {outputDir, nameTemplate, format, skipExisting, force}) {
    const outDir = path.resolve(outputDir || DEFAULT_OUTPUT_DIR);
    const history = loadHistory(outDir);

    return _startJob({
        id: crypto.randomBytes(4).toString('hex'),
        kind: 'download',
        created: new Date().toISOString(),
        output_dir: outDir,
        name_template: nameTemplate,
        format,
        skip_existing: skipExisting,
        canceled: false,
        items: videos.map((v, i) => {
            const prev = force ? null : findDownloaded(outDir, v, format, nameTemplate, history);

            return {
                index: i + 1, name: v.name, url: v.url, info: v,
                status: prev === null ? 'queued' : 'skipped',
                progress: prev === null ? '' : 'already downloaded',
                file: prev
            };
        })
    });
}

export function startConvertJob(files, {format, outputDir, skipExisting}) {
    return _startJob({
        id: crypto.randomBytes(4).toString('hex'),
        kind: 'convert',
        created: new Date().toISOString(),
        output_dir: outputDir ? path.resolve(outputDir) : null,
        format,
        skip_existing: skipExisting,
        canceled: false,
        items: files.map((src, i) => {
            const parsed = path.parse(src);
            const file = path.join(outputDir ? path.resolve(outputDir) : parsed.dir, `${parsed.name}.${format}`);

            return {index: i + 1, name: parsed.base, src, info: {}, status: file === src ? 'skipped' : 'queued',
                    progress: file === src ? 'already in this format' : '', file};
        })
    });
}

/**
 * afterCurrent: let the current item finish and drop the queued ones (pause), else stop now.
 * Finished items are always kept, run the same download again to continue.
 */
export function cancelJob(id, {afterCurrent = false} = {}) {
    const job = _jobs.get(id);

    if (job === undefined)
        return null;

    for (const item of job.items) {
        if (item.status === 'queued')
            item.status = 'canceled';
    }

    if (afterCurrent)
        return job;

    job.canceled = true;

    if (_current !== null && job.items.includes(_current.item))
        _killCurrent();

    return job;
}

export function getJob(id) {
    return _jobs.get(id) ?? null;
}

export function getJobs() {
    return [..._jobs.values()];
}

export function summarizeJob(job) {
    const counts = {};

    for (const item of job.items)
        counts[item.status] = (counts[item.status] ?? 0) + 1;

    return {
        job_id: job.id,
        kind: job.kind,
        format: job.format,
        created: job.created,
        output_dir: job.output_dir ?? 'same folder as each file',
        canceled: job.canceled,
        counts,
        items: job.items.map(i => ({
            index: i.index,
            name: i.name,
            class_date: i.info.class_date,
            weekday: i.info.weekday,
            status: i.status,
            progress: i.progress || undefined,
            file: i.file ?? undefined,
            error: i.error
        }))
    };
}

export function stopAll() {
    for (const job of _jobs.values())
        job.canceled = true;

    _killCurrent();
}
