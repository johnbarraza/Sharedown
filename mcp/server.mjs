#!/usr/bin/env node
/**
 * This file is part of the Sharedown (https://github.com/kylon/Sharedown).
 *
 * Sharedown MCP server: list Sharepoint folder videos with class date/weekday and download them in batch.
 */
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import './lib/env.mjs';
import fs from 'node:fs';
import path from 'node:path';
import { AUDIO_FORMATS, describeVideo, FORMATS, getServerRelativePath, getVideoKey, sortVideos, VIDEO_EXTS } from './lib/meta.mjs';
import { getRemoteFileInfo, listFolderVideos, login, log, PROFILE_DIR, shutdown } from './lib/sharepoint.mjs';
import { cancelJob, DEFAULT_OUTPUT_DIR, getJob, getJobs, startConvertJob, startDownloadJob, stopAll, summarizeJob } from './lib/downloader.mjs';
import { findDownloaded, loadHistory } from './lib/history.mjs';
import { verifyMedia } from './lib/verify.mjs';
import { checkChrome, checkFFmpeg, checkLoginProfile, checkNode, checkOutputDir, checkYtdlp, formatMissing, missingFor } from './lib/requirements.mjs';

const DEFAULT_TEMPLATE = process.env.SHAREDOWN_NAME_TEMPLATE || '{date} {weekday} - {name}';
const sortEnum = z.enum(['class_date', 'name', 'created', 'modified']);
const formatEnum = z.enum(FORMATS);
const MEDIA_EXTS = [...VIDEO_EXTS, ...AUDIO_FORMATS.map(f => `.${f}`)];
const dateRx = /^\d{4}-\d{2}-\d{2}$/;

const server = new McpServer({name: 'sharedown', version: '1.0.0'});

function ok(data) {
    return {content: [{type: 'text', text: typeof data === 'string' ? data : JSON.stringify(data, null, 2)}]};
}

function fail(e) {
    return {isError: true, content: [{type: 'text', text: e?.message ?? String(e)}]};
}

function tool(fn) {
    return async (args) => {
        try {
            return await fn(args);
        } catch (e) {
            log(e.stack ?? e.message);
            return fail(e);
        }
    };
}

function filterByDate(videos, fromDate, toDate) {
    return videos.filter(v => {
        if (!fromDate && !toDate)
            return true;
        else if (v.class_date === null)
            return false;

        return (!fromDate || v.class_date >= fromDate) && (!toDate || v.class_date <= toDate);
    });
}

function dedupe(videos) {
    const seen = new Set();

    return videos.filter(v => {
        const key = getVideoKey(v.server_relative_path);

        if (seen.has(key))
            return false;

        seen.add(key);
        return true;
    });
}

function markDownloaded(videos, outputDir) {
    const history = loadHistory(outputDir);

    return videos.map(v => {
        const formats = FORMATS.filter(f => findDownloaded(outputDir, v, f, DEFAULT_TEMPLATE, history) !== null);

        return {...v, already_downloaded: formats.length > 0, downloaded_formats: formats.length > 0 ? formats : undefined};
    });
}

function listMediaFiles(p, recursive, out = []) {
    const stat = fs.statSync(p);

    if (stat.isFile()) {
        out.push(path.resolve(p));
        return out;
    }

    for (const entry of fs.readdirSync(p, {withFileTypes: true})) {
        const full = path.join(p, entry.name);

        if (entry.isDirectory() && recursive)
            listMediaFiles(full, recursive, out);
        else if (entry.isFile() && MEDIA_EXTS.includes(path.extname(entry.name).toLowerCase()))
            out.push(path.resolve(full));
    }

    return out;
}

async function infoFromUrl(url, remote) {
    const relPath = getServerRelativePath(url);

    if (remote || relPath === null) // short sharing links need the browser
        return getRemoteFileInfo(url);

    return describeVideo({name: relPath.split('/').at(-1), serverRelPath: relPath, origin: new URL(url).origin});
}

server.registerTool('check_requirements', {
    title: 'Check requirements',
    description: 'Checks that yt-dlp, ffmpeg, Chrome and the output folder are available, and whether a Sharepoint login was saved. ' +
                 'Shows the output folder and settings in use. Run it first when something fails.',
    inputSchema: {
        output_dir: z.string().optional().describe(`Output folder to check (default: ${DEFAULT_OUTPUT_DIR})`)
    }
}, tool(async ({output_dir}) => {
    const checks = [checkNode(), checkYtdlp(), checkFFmpeg(), await checkChrome(),
                    checkOutputDir(path.resolve(output_dir || DEFAULT_OUTPUT_DIR)), checkLoginProfile(PROFILE_DIR)];

    return ok({
        all_ok: checks.every(c => c.ok || c.name === 'saved login'),
        checks,
        settings: {
            default_output_dir: DEFAULT_OUTPUT_DIR,
            name_template: DEFAULT_TEMPLATE,
            formats: FORMATS,
            login_profile: PROFILE_DIR
        }
    });
}));

server.registerTool('sharepoint_login', {
    title: 'Sharepoint login',
    description: 'Opens a visible Chrome window on the given Sharepoint url so the user can sign in (MFA included). ' +
                 'The session is saved in a persistent profile and reused by the other tools. ' +
                 'Call it once, or again when another tool reports "Not logged in". Tell the user to choose "Stay signed in".',
    inputSchema: {
        url: z.string().url().describe('Any Sharepoint url of the tenant (video, folder or site)'),
        timeout_seconds: z.number().int().min(30).max(1800).default(300).describe('How long to wait for the user to sign in')
    }
}, tool(async ({url, timeout_seconds}) => {
    const done = await login(url, timeout_seconds);

    return done ? ok(`Signed in to ${new URL(url).hostname}. Session saved in ${PROFILE_DIR}`)
                : fail(new Error(`Sign in not completed within ${timeout_seconds}s`));
}));

server.registerTool('list_folder_videos', {
    title: 'List videos in a Sharepoint folder',
    description: 'Lists the videos of a Sharepoint folder url (e.g. a Teams "Recordings" folder) with file name, class date, ' +
                 'weekday and start time (taken from the Teams recording file name, or the Sharepoint creation time), size and player url. ' +
                 'Each video says whether it was already downloaded to output_dir.',
    inputSchema: {
        folder_url: z.string().url().describe('Sharepoint folder url (/:f:/r/sites/..., /:f:/s/... or a document library url)'),
        include_subfolders: z.boolean().default(false),
        sort: sortEnum.default('class_date'),
        from_date: z.string().regex(dateRx).optional().describe('Only classes on or after this date (YYYY-MM-DD)'),
        to_date: z.string().regex(dateRx).optional().describe('Only classes on or before this date (YYYY-MM-DD)'),
        output_dir: z.string().optional().describe(`Folder to look for previous downloads (default: ${DEFAULT_OUTPUT_DIR})`)
    }
}, tool(async ({folder_url, include_subfolders, sort, from_date, to_date, output_dir}) => {
    const outDir = path.resolve(output_dir || DEFAULT_OUTPUT_DIR);
    const all = await listFolderVideos(folder_url, include_subfolders);
    const videos = markDownloaded(sortVideos(filterByDate(all, from_date, to_date), sort), outDir).map((v, i) => ({index: i + 1, ...v}));
    const downloaded = videos.filter(v => v.already_downloaded).length;

    return ok({folder: folder_url, output_dir: outDir, total_in_folder: all.length, count: videos.length,
               already_downloaded: downloaded, not_downloaded: videos.length - downloaded, videos});
}));

server.registerTool('get_video_info', {
    title: 'Get Sharepoint video info',
    description: 'Shows the full file name, class date, weekday and start time of a Sharepoint video url. ' +
                 'Useful to tell apart video links that look the same at the beginning.',
    inputSchema: {
        url: z.string().url(),
        remote: z.boolean().default(false).describe('Also read size and creation date from Sharepoint (needs login)')
    }
}, tool(async ({url, remote}) => ok(await infoFromUrl(url, remote))));

server.registerTool('download_videos', {
    title: 'Download Sharepoint videos',
    description: 'Starts a background download job (one video at a time, yt-dlp) for a list of video urls and/or every video in a folder. ' +
                 'Returns immediately with a job id; use download_status to follow progress. Duplicated videos and videos already ' +
                 'downloaded to output_dir before (same format) are skipped, so a folder can be downloaded again to get only the new classes. ' +
                 'format can be a video (mp4, mkv) or audio only (mp3, m4a, opus, wav, flac; faster, downloads only the audio track).',
    inputSchema: {
        urls: z.array(z.string().url()).default([]).describe('Video urls'),
        folder_url: z.string().url().optional().describe('Download every video in this folder'),
        include_subfolders: z.boolean().default(false),
        from_date: z.string().regex(dateRx).optional().describe('Only classes on or after this date (YYYY-MM-DD)'),
        to_date: z.string().regex(dateRx).optional().describe('Only classes on or before this date (YYYY-MM-DD)'),
        output_dir: z.string().optional().describe(`Output folder (default: ${DEFAULT_OUTPUT_DIR})`),
        name_template: z.string().default(DEFAULT_TEMPLATE)
            .describe('Output file name, placeholders: {date} (YYYY-MM-DD) {weekday} {time} {name} {index}. Extension .mp4 is added'),
        format: formatEnum.default('mp4'),
        newest_first: z.boolean().default(false).describe('Download the most recent classes first (default: oldest first)'),
        skip_existing: z.boolean().default(true).describe('Skip videos whose output file already exists'),
        force: z.boolean().default(false).describe('Download again videos found in the download history of output_dir')
    }
}, tool(async ({urls, folder_url, include_subfolders, from_date, to_date, output_dir, name_template, format, newest_first, skip_existing, force}) => {
    const outDir = path.resolve(output_dir || DEFAULT_OUTPUT_DIR);
    const missing = await missingFor('download', outDir);
    let videos = [];

    if (missing.length > 0)
        throw new Error(formatMissing(missing));
    else if (folder_url === undefined && urls.length === 0)
        throw new Error('Pass urls and/or folder_url');

    if (folder_url !== undefined)
        videos.push(...await listFolderVideos(folder_url, include_subfolders));

    for (const url of urls)
        videos.push(await infoFromUrl(url, false));

    videos = sortVideos(filterByDate(dedupe(videos), from_date, to_date), 'class_date');

    if (newest_first)
        videos.reverse();

    if (videos.length === 0)
        return ok('No videos to download (check the folder and the date filters).');

    const job = startDownloadJob(videos, {outputDir: outDir, nameTemplate: name_template, format, skipExisting: skip_existing, force});
    const summary = summarizeJob(job);
    const queued = job.items.filter(i => i.status !== 'skipped').length; // the first one may be already running

    return ok({
        message: queued === 0 ? `Nothing new: all ${videos.length} videos were already downloaded to ${outDir} (use force to download again).`
                              : `Downloading ${queued} videos as ${format} to ${outDir}` +
                                (queued < videos.length ? ` (${videos.length - queued} already downloaded, skipped)` : '') +
                                '. Use download_status to follow it.',
        ...summary
    });
}));

server.registerTool('convert_files', {
    title: 'Convert local files',
    description: 'Converts already downloaded files (or every video/audio file in a local folder) to another format with ffmpeg, ' +
                 'e.g. mp4 -> mp3 to listen to classes. Runs in background; use download_status to follow it. Original files are kept.',
    inputSchema: {
        paths: z.array(z.string()).min(1).describe('Files and/or folders'),
        format: formatEnum,
        recursive: z.boolean().default(false).describe('Include subfolders of the given folders'),
        output_dir: z.string().optional().describe('Where to write the converted files (default: next to each original)'),
        skip_existing: z.boolean().default(true)
    }
}, tool(async ({paths, format, recursive, output_dir, skip_existing}) => {
    const missing = await missingFor('convert', output_dir ? path.resolve(output_dir) : null);

    if (missing.length > 0)
        throw new Error(formatMissing(missing));

    const files = [];

    for (const p of paths) {
        if (!fs.existsSync(p))
            throw new Error(`Not found: ${p}`);

        files.push(...listMediaFiles(p, recursive));
    }

    if (files.length === 0)
        return ok('No video/audio files found.');

    const job = startConvertJob([...new Set(files)], {format, outputDir: output_dir, skipExisting: skip_existing});
    const count = job.items.filter(i => i.status !== 'skipped').length;

    return ok({message: `Converting ${count} files to ${format}. Use download_status to follow it.`, ...summarizeJob(job)});
}));

server.registerTool('verify_files', {
    title: 'Verify downloaded files',
    description: 'Checks downloaded video/audio files for missing fragments (silent or frozen gaps) and missing audio. ' +
                 'New downloads are verified automatically; use this for older files.',
    inputSchema: {
        paths: z.array(z.string()).min(1).describe('Files and/or folders'),
        recursive: z.boolean().default(false)
    }
}, tool(async ({paths, recursive}) => {
    const files = [];
    const results = [];

    for (const p of paths) {
        if (!fs.existsSync(p))
            throw new Error(`Not found: ${p}`);

        files.push(...listMediaFiles(p, recursive).filter(f => !/\.f(v|aud)copy\./.test(f)));
    }

    for (const f of files) {
        try {
            results.push(await verifyMedia(f));
        } catch (e) {
            results.push({ok: false, file: f, problems: [e.message]});
        }
    }

    const bad = results.filter(r => !r.ok);

    return ok({checked: results.length, ok: results.length - bad.length, with_problems: bad.length,
               hint: bad.length ? 'Delete or rename the bad files and download them again (download_videos skips only existing files).' : undefined,
               results});
}));

server.registerTool('download_status', {
    title: 'Download status',
    description: 'Progress of a download or convert job (or of every job when job_id is omitted).',
    inputSchema: {
        job_id: z.string().optional()
    }
}, tool(async ({job_id}) => {
    if (job_id === undefined)
        return ok(getJobs().map(summarizeJob));

    const job = getJob(job_id);

    return job === null ? fail(new Error(`Unknown job ${job_id}`)) : ok(summarizeJob(job));
}));

server.registerTool('cancel_download', {
    title: 'Cancel job',
    description: 'Stops a download or convert job. Finished videos are kept; downloading the same folder/urls again continues ' +
                 'where it stopped (the interrupted video resumes). Use after_current to pause after the current video finishes.',
    inputSchema: {
        job_id: z.string(),
        after_current: z.boolean().default(false).describe('Let the current video finish, then stop')
    }
}, tool(async ({job_id, after_current}) => {
    const job = cancelJob(job_id, {afterCurrent: after_current});

    return job === null ? fail(new Error(`Unknown job ${job_id}`)) : ok(summarizeJob(job));
}));

async function exit() {
    stopAll();
    await shutdown();
    process.exit(0);
}

process.on('SIGINT', exit);
process.on('SIGTERM', exit);
process.stdin.on('close', exit);

await server.connect(new StdioServerTransport());
log('ready');
