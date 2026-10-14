/**
 * This file is part of the Sharedown (https://github.com/kylon/Sharedown).
 *
 * Per output folder download history (.sharedown-history.json), used to skip videos downloaded before.
 */
import fs from 'node:fs';
import path from 'node:path';
import { applyNameTemplate, getVideoKey } from './meta.mjs';

const HISTORY_FILE = '.sharedown-history.json';

export function loadHistory(dir) {
    try {
        return JSON.parse(fs.readFileSync(path.join(dir, HISTORY_FILE), 'utf8'));
    } catch (e) {
        return {};
    }
}

export function recordDownload(dir, info, format, file) {
    const history = loadHistory(dir);
    const key = getVideoKey(info.server_relative_path);
    const tmp = path.join(dir, `${HISTORY_FILE}.tmp`);

    history[key] = {
        ...history[key],
        name: info.name,
        class_date: info.class_date,
        [format]: {file: path.basename(file), downloaded: new Date().toISOString()}
    };

    fs.writeFileSync(tmp, JSON.stringify(history, null, 2), 'utf8');
    fs.renameSync(tmp, path.join(dir, HISTORY_FILE));
}

/**
 * Path of a previous download of this video in this format, or null.
 * Looks at the history file, the name the template would produce and the original name
 * (files downloaded with the Sharedown app, with or without the class date prefix).
 */
export function findDownloaded(dir, info, format, nameTemplate, history = loadHistory(dir)) {
    const recorded = history[getVideoKey(info.server_relative_path)]?.[format]?.file;
    const candidates = [
        recorded,
        applyNameTemplate(nameTemplate, info, 0, format),
        applyNameTemplate('{name}', info, 0, format),
        applyNameTemplate('{date} {weekday} - {name}', info, 0, format)
    ];

    for (const c of candidates) {
        if (c && fs.existsSync(path.join(dir, c)))
            return path.join(dir, c);
    }

    return null;
}
