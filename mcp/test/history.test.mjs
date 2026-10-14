import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

process.env.SHAREDOWN_TZ = 'America/Lima';
process.env.SHAREDOWN_LOCALE = 'es-PE';

const { describeVideo } = await import('../lib/meta.mjs');
const { findDownloaded, recordDownload } = await import('../lib/history.mjs');

const tpl = '{date} {weekday} - {name}';
const mk = n => describeVideo({name: n, serverRelPath: `/sites/a/Recordings/${n}`, origin: 'https://x.sharepoint.com'});

test('previous downloads are found by history, template name and original name', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'shd-hist-'));
    const a = mk('a-20260812_124031UTC-Meeting Recording.mp4');
    const b = mk('b-20260814_124031UTC-Meeting Recording.mp4');
    const c = mk('c-20260819_124031UTC-Meeting Recording.mp4');
    const d = mk('d-20260821_124031UTC-Meeting Recording.mp4');

    try {
        fs.writeFileSync(path.join(dir, 'renamed by me.mp4'), '');
        recordDownload(dir, a, 'mp4', path.join(dir, 'renamed by me.mp4'));
        fs.writeFileSync(path.join(dir, '2026-08-14 viernes - b-20260814_124031UTC-Meeting Recording.mp4'), '');
        fs.writeFileSync(path.join(dir, 'c-20260819_124031UTC-Meeting Recording.mp4'), ''); // Sharedown app default name

        assert.equal(path.basename(findDownloaded(dir, a, 'mp4', tpl)), 'renamed by me.mp4');
        assert.equal(findDownloaded(dir, a, 'mp3', tpl), null); // other format is not downloaded
        assert.notEqual(findDownloaded(dir, b, 'mp4', tpl), null);
        assert.notEqual(findDownloaded(dir, c, 'mp4', tpl), null);
        assert.equal(findDownloaded(dir, d, 'mp4', tpl), null);

        fs.rmSync(path.join(dir, 'renamed by me.mp4'));
        assert.equal(findDownloaded(dir, a, 'mp4', tpl), null); // deleted file: download again

    } finally {
        fs.rmSync(dir, {recursive: true, force: true});
    }
});
