/**
 * This file is part of the Sharedown (https://github.com/kylon/Sharedown).
 *
 * Checks downloaded files for missing audio/video fragments (gaps in the packet timestamps).
 */
import path from 'node:path';
import { spawn } from 'node:child_process';
import { FFPROBE } from './requirements.mjs';

const MIN_GAP_S = 1.5; // fragments are ~2-6 s long

function _gaps(file, stream) {
    return new Promise((resolve, reject) => {
        const proc = spawn(FFPROBE, ['-v', 'error', '-select_streams', stream, '-show_entries', 'packet=pts_time', '-of', 'csv=p=0', file], {windowsHide: true});
        const ret = {packets: 0, gaps: 0, missing_s: 0, first_gap_at: null, end_s: 0};
        let prev = null;
        let rest = '';
        let err = '';

        proc.stdout.on('data', data => {
            const lines = (rest + data.toString()).split(/\r?\n/);

            rest = lines.pop();

            for (const l of lines) {
                const t = parseFloat(l);

                if (isNaN(t))
                    continue;

                if (prev !== null && t - prev > MIN_GAP_S) {
                    ret.gaps++;
                    ret.missing_s += t - prev;
                    ret.first_gap_at ??= prev;
                }

                prev = t;
                ret.packets++;
            }
        });
        proc.stderr.on('data', data => err += data.toString());
        proc.on('error', e => reject(new Error(`Unable to run ${FFPROBE}: ${e.message}`)));
        proc.on('close', code => {
            ret.end_s = prev ?? 0;
            code === 0 ? resolve(ret) : reject(new Error(err.trim() || `ffprobe exit code ${code}`));
        });
    });
}

function _time(s) {
    const m = Math.floor(s / 60);

    return `${Math.floor(m / 60)}:${String(m % 60).padStart(2, '0')}:${String(Math.floor(s % 60)).padStart(2, '0')}`;
}

/**
 * Returns {ok, file, duration, problems: [..]}
 */
export async function verifyMedia(file) {
    const audio = await _gaps(file, 'a:0');
    const video = path.extname(file).toLowerCase() === '.mp4' || path.extname(file).toLowerCase() === '.mkv' ? await _gaps(file, 'v:0') : null;
    const problems = [];

    if (audio.packets === 0)
        problems.push('no audio');

    for (const [name, s] of [['audio', audio], ['video', video]]) {
        if (s !== null && s.gaps > 0)
            problems.push(`${name}: ${s.gaps} gaps, ${Math.round(s.missing_s)} s missing, first at ${_time(s.first_gap_at)}`);
    }

    return {ok: problems.length === 0, file, duration: _time(Math.max(audio.end_s, video?.end_s ?? 0)), problems};
}
