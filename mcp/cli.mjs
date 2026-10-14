#!/usr/bin/env node
/**
 * This file is part of the Sharedown (https://github.com/kylon/Sharedown).
 *
 * Command line version of the MCP tools, with live progress.
 *
 *   node cli.mjs login    <sharepoint url>
 *   node cli.mjs list     <folder url>
 *   node cli.mjs download <folder or video url>... [--format mp4] [--out <dir>] [--from YYYY-MM-DD] [--to YYYY-MM-DD] [--newest-first] [--force]
 *   node cli.mjs convert  <file or folder>... --format mp3 [--out <dir>]
 *   node cli.mjs verify   <file or folder>...
 */
import './lib/env.mjs';
import path from 'node:path';
import { describeVideo, FORMATS, getServerRelativePath, getVideoKey, sortVideos } from './lib/meta.mjs';
import { getRemoteFileInfo, listFolderVideos, login, NotLoggedInError, shutdown } from './lib/sharepoint.mjs';
import { cancelJob, DEFAULT_OUTPUT_DIR, getJob, startConvertJob, startDownloadJob, stopAll } from './lib/downloader.mjs';
import { formatMissing, missingFor } from './lib/requirements.mjs';
import { verifyMedia } from './lib/verify.mjs';
import fs from 'node:fs';

const DEFAULT_TEMPLATE = process.env.SHAREDOWN_NAME_TEMPLATE || '{date} {weekday} - {name}';

process.env.SHAREDOWN_QUIET ??= '1'; // retries and errors are shown in the progress lines
const MARK = {done: '✔', skipped: '↷', error: '✖', canceled: '■'};
let activeJob = null;

function parseArgs(argv) {
    const opts = {positional: [], format: 'mp4', out: undefined, from: undefined, to: undefined, force: false, newestFirst: false};

    for (let i = 0; i < argv.length; ++i) {
        const a = argv[i];

        if (a === '--force')
            opts.force = true;
        else if (a === '--newest-first')
            opts.newestFirst = true;
        else if (['--format', '--out', '--from', '--to'].includes(a))
            opts[a.substring(2)] = argv[++i];
        else
            opts.positional.push(a);
    }

    if (!FORMATS.includes(opts.format))
        throw new Error(`Unknown format ${opts.format}, use one of: ${FORMATS.join(', ')}`);

    return opts;
}

function isFolderUrl(url) {
    return /\/:f:\//.test(url) || /AllItems\.aspx/i.test(url) || !/\.(mp4|m4v|mov|mkv|webm)(\?|$)/i.test(decodeURIComponent(url.split('?')[0]));
}

function line(text) {
    const width = (process.stdout.columns || 120) - 1;

    process.stdout.write('\r' + text.substring(0, width).padEnd(width));
}

async function follow(job) {
    activeJob = job;

    const total = job.items.length;
    const printed = new Set();
    const started = Date.now();

    while (true) {
        const j = getJob(job.id);
        let current = null;

        for (const item of j.items) {
            if (MARK[item.status] && !printed.has(item.index)) {
                printed.add(item.index);
                line(`${MARK[item.status]} [${item.index}/${total}] ${item.info.class_date ?? ''} ${item.info.weekday ?? ''} ${item.name}` +
                     ` - ${item.status}${item.progress && item.status !== 'done' ? ` (${item.progress})` : ''}${item.error ? `: ${item.error}` : ''}`);
                process.stdout.write('\n');

            } else if (['resolving', 'downloading', 'converting'].includes(item.status)) {
                current = item;
            }
        }

        const doneCount = j.items.filter(i => MARK[i.status]).length;

        if (current !== null) {
            const mins = Math.floor((Date.now() - started) / 60000);

            line(`… [${current.index}/${total}] ${current.info.class_date ?? ''} ${current.name} - ` +
                 `${current.status === 'resolving' ? 'getting video stream' : current.status} ${current.progress ?? ''}` +
                 `  | ${doneCount}/${total} finished, ${mins} min`);
        }

        if (doneCount === total)
            break;

        await new Promise(r => setTimeout(r, 1000));
    }

    const counts = {};

    for (const i of getJob(job.id).items)
        counts[i.status] = (counts[i.status] ?? 0) + 1;

    process.stdout.write('\n');
    console.log(`Finished: ${Object.entries(counts).map(([k, v]) => `${v} ${k}`).join(', ')}`);
    console.log(`Folder: ${job.output_dir ?? 'next to the original files'}`);

    if (counts.error || counts.canceled)
        console.log('Run the same command again to continue: finished files are skipped.');

    return counts.error ?? 0;
}

async function cmdDownload(opts) {
    const outDir = path.resolve(opts.out || DEFAULT_OUTPUT_DIR);
    const missing = await missingFor('download', outDir);
    const seen = new Set();
    let videos = [];

    if (missing.length > 0)
        throw new Error(formatMissing(missing));

    for (const url of opts.positional) {
        if (isFolderUrl(url)) {
            console.log('Reading folder...');
            videos.push(...await listFolderVideos(url, false));

        } else {
            const rel = getServerRelativePath(url);

            videos.push(rel === null ? await getRemoteFileInfo(url) :
                        describeVideo({name: rel.split('/').at(-1), serverRelPath: rel, origin: new URL(url).origin}));
        }
    }

    videos = sortVideos(videos.filter(v => {
        const key = getVideoKey(v.server_relative_path);
        const inRange = (!opts.from || (v.class_date && v.class_date >= opts.from)) && (!opts.to || (v.class_date && v.class_date <= opts.to));

        if (seen.has(key) || !inRange)
            return false;

        seen.add(key);
        return true;
    }), 'class_date');

    if (opts.newestFirst)
        videos.reverse();

    const job = startDownloadJob(videos, {outputDir: outDir, nameTemplate: DEFAULT_TEMPLATE, format: opts.format, skipExisting: true, force: opts.force});
    const toDo = job.items.filter(i => i.status !== 'skipped').length;

    console.log(`${videos.length} videos, ${videos.length - toDo} already downloaded, ${toDo} to download as ${opts.format} to ${outDir}`);
    console.log('Ctrl+C once: pause after the current video. Twice: stop now (the current video resumes next time).');
    console.log('Finished videos are always kept: run the same command again to continue.\n');

    return follow(job);
}

async function cmdConvert(opts) {
    const missing = await missingFor('convert', opts.out ? path.resolve(opts.out) : null);
    const exts = ['.mp4', '.m4v', '.mov', '.mkv', '.webm', '.mp3', '.m4a', '.opus', '.wav', '.flac'];
    const files = [];

    if (missing.length > 0)
        throw new Error(formatMissing(missing));

    for (const p of opts.positional) {
        if (fs.statSync(p).isFile())
            files.push(path.resolve(p));
        else
            files.push(...fs.readdirSync(p).filter(f => exts.includes(path.extname(f).toLowerCase())).map(f => path.resolve(p, f)));
    }

    console.log(`Converting ${files.length} files to ${opts.format}\n`);
    return follow(startConvertJob(files, {format: opts.format, outputDir: opts.out, skipExisting: true}));
}

async function cmdVerify(opts) {
    const exts = ['.mp4', '.mkv', '.mp3', '.m4a', '.opus', '.wav', '.flac'];
    const files = [];
    let bad = 0;

    for (const p of opts.positional) {
        if (fs.statSync(p).isFile())
            files.push(path.resolve(p));
        else
            files.push(...fs.readdirSync(p).filter(f => exts.includes(path.extname(f).toLowerCase()) && !/\.f(v|aud)copy\./.test(f)).map(f => path.resolve(p, f)));
    }

    for (const f of files) {
        line(`… checking ${path.basename(f)}`);

        try {
            const r = await verifyMedia(f);

            bad += r.ok ? 0 : 1;
            line(`${r.ok ? '✔' : '✖'} ${r.duration}  ${path.basename(f)}${r.ok ? '' : `  ->  ${r.problems.join('; ')}`}`);

        } catch (e) {
            ++bad;
            line(`✖ ${path.basename(f)}  ->  ${e.message}`);
        }

        process.stdout.write('\n');
    }

    console.log(`\n${files.length - bad} ok, ${bad} with problems` +
                (bad ? '. Delete (or rename) the bad files and run download again to get them back.' : ''));

    return bad > 0 ? 1 : 0;
}

async function cmdList(opts) {
    const videos = sortVideos(await listFolderVideos(opts.positional[0], false), 'class_date');

    for (const [i, v] of videos.entries())
        console.log(`${String(i + 1).padStart(3)}  ${v.class_date ?? '----------'} ${(v.weekday ?? '').padEnd(10)} ${v.start_time ?? '     '}  ${String(v.size_mb).padStart(7)} MB  ${v.name}`);

    console.log(`\n${videos.length} videos, ${Math.round(videos.reduce((t, v) => t + (v.size_mb ?? 0), 0))} MB`);
    return 0;
}

async function main() {
    const [cmd, ...rest] = process.argv.slice(2);
    const opts = parseArgs(rest);

    if (opts.positional.length === 0 || !['login', 'list', 'download', 'convert', 'verify'].includes(cmd)) {
        console.log(fs.readFileSync(new URL(import.meta.url), 'utf8').match(/\*\s+node cli\.mjs.*$/gm).map(l => l.replace(/^\*\s+/, '  ')).join('\n'));
        return 1;
    }

    let interrupts = 0;

    process.on('SIGINT', async () => {
        if (++interrupts === 1 && activeJob !== null) {
            cancelJob(activeJob.id, {afterCurrent: true});
            console.log('\nPausing: the current video will finish, then it stops. Ctrl+C again to stop now.');
            return;
        }

        console.log('\nStopping now. Run the same command again to continue.');
        stopAll();
        await shutdown();
        process.exit(130);
    });

    switch (cmd) {
        case 'login':
            console.log('Sign in in the Chrome window and choose "Stay signed in"...');
            return (await login(opts.positional[0], 600)) ? (console.log('Signed in.'), 0) : (console.log('Sign in not completed.'), 1);
        case 'list':
            return cmdList(opts);
        case 'download':
            return cmdDownload(opts);
        case 'convert':
            return cmdConvert(opts);
        case 'verify':
            return cmdVerify(opts);
    }
}

try {
    process.exitCode = await main();

} catch (e) {
    console.error(`\n${e.message}`);

    if (e instanceof NotLoggedInError)
        console.error('Run: node cli.mjs login <url>');

    process.exitCode = 1;
}

await shutdown();
