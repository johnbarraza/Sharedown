/**
 * This file is part of the Sharedown (https://github.com/kylon/Sharedown).
 *
 * Video metadata helpers: file name, class date/weekday, output file names.
 */
import path from 'node:path';

const resolvedIntl = Intl.DateTimeFormat().resolvedOptions();

export const LOCALE = process.env.SHAREDOWN_LOCALE || resolvedIntl.locale;
export const TIME_ZONE = process.env.SHAREDOWN_TZ || resolvedIntl.timeZone;
export const VIDEO_EXTS = ['.mp4', '.m4v', '.mov', '.mkv', '.webm'];
export const VIDEO_FORMATS = ['mp4', 'mkv'];
export const AUDIO_FORMATS = ['mp3', 'm4a', 'opus', 'wav', 'flac'];
export const FORMATS = [...VIDEO_FORMATS, ...AUDIO_FORMATS];

// Teams recordings: name-20260812_124031UTC-Meeting Recording.mp4
const TEAMS_DATE_RX = /(\d{4})(\d{2})(\d{2})_(\d{2})(\d{2})(\d{2})UTC/;

/**
 * Server relative path of a Sharepoint file/folder url.
 * Handles /:v:/r/sites/..., /sites/... and ...?id=/sites/... urls.
 * Returns null for short sharing links (/:v:/s/<site>/<token>) which must be resolved by navigating.
 */
export function getServerRelativePath(url) {
    const urlObj = new URL(url.replaceAll('#', '%23'));
    const id = urlObj.searchParams.get('id');

    if (id !== null && id.startsWith('/'))
        return id;

    const pathname = decodeURIComponent(urlObj.pathname);
    const shareLink = pathname.match(/^\/:[a-z]:\/([a-z])(\/.*)$/);

    if (shareLink === null)
        return pathname;

    return shareLink[1] === 'r' ? shareLink[2] : null;
}

export function getSitePrefix(serverRelPath) {
    return serverRelPath.match(/^\/(sites|teams|personal)\/[^/]+/)?.[0] ?? '';
}

export function getVideoKey(serverRelPath) {
    return serverRelPath.normalize().toLowerCase();
}

export function makePlayerUrl(origin, serverRelPath) {
    return `${origin}${encodeURI(serverRelPath).replaceAll('#', '%23')}?web=1`;
}

export function isVideoFile(name) {
    return VIDEO_EXTS.includes(path.extname(name).toLowerCase());
}

/**
 * Class date: meeting start time from Teams file name, else Sharepoint creation time.
 */
export function getClassDate(fileName, created = null) {
    const m = fileName.match(TEAMS_DATE_RX);

    if (m !== null)
        return {date: new Date(Date.UTC(m[1], m[2] - 1, m[3], m[4], m[5], m[6])), source: 'file name (Teams recording)'};
    else if (created)
        return {date: new Date(created), source: 'Sharepoint creation time'};

    return null;
}

function _datePart(date, opts) {
    return new Intl.DateTimeFormat('en-CA', {timeZone: TIME_ZONE, ...opts}).format(date);
}

export function describeDate(date) {
    return {
        date: _datePart(date, {year: 'numeric', month: '2-digit', day: '2-digit'}), // YYYY-MM-DD
        time: _datePart(date, {hour: '2-digit', minute: '2-digit', hourCycle: 'h23'}),
        weekday: new Intl.DateTimeFormat(LOCALE, {timeZone: TIME_ZONE, weekday: 'long'}).format(date),
        iso: date.toISOString()
    };
}

export function describeVideo({name, serverRelPath, origin, created = null, modified = null, size = null}) {
    const classDate = getClassDate(name, created);
    const ret = {
        name,
        url: makePlayerUrl(origin, serverRelPath),
        server_relative_path: serverRelPath,
        class_date: null,
        weekday: null,
        start_time: null,
        date_source: null
    };

    if (classDate !== null) {
        const d = describeDate(classDate.date);

        ret.class_date = d.date;
        ret.weekday = d.weekday;
        ret.start_time = d.time;
        ret.date_source = classDate.source;
    }

    if (created)
        ret.created = new Date(created).toISOString();

    if (modified)
        ret.modified = new Date(modified).toISOString();

    if (size !== null)
        ret.size_mb = Math.round(Number(size) / 1024 / 1024 * 10) / 10;

    return ret;
}

export function sortVideos(list, sort) {
    const key = {
        class_date: v => v.class_date === null ? '9999' : `${v.class_date} ${v.start_time}`,
        name: v => v.name.toLowerCase(),
        created: v => v.created ?? '',
        modified: v => v.modified ?? ''
    }[sort];

    if (key === undefined)
        return list;

    return [...list].sort((a, b) => key(a).localeCompare(key(b)));
}

export function sanitizeFileName(name) {
    return name.replace(/[<>:"/\\|?*\x00-\x1f]/g, '_').replace(/\s+/g, ' ').replace(/[. ]+$/, '').trim();
}

/**
 * Placeholders: {date} {weekday} {time} {name} {index}
 */
export function applyNameTemplate(template, info, index, ext = 'mp4') {
    const noDate = info.class_date === null;
    const name = path.parse(info.name).name;
    let out = template
        .replaceAll('{date}', noDate ? '' : info.class_date)
        .replaceAll('{weekday}', noDate ? '' : info.weekday)
        .replaceAll('{time}', noDate ? '' : info.start_time.replace(':', 'h'))
        .replaceAll('{index}', String(index).padStart(2, '0'))
        .replaceAll('{name}', name);

    out = sanitizeFileName(out.replace(/^[\s\-_]+/, ''));

    return `${out === '' ? sanitizeFileName(name) : out}.${ext}`;
}
