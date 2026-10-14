import { test } from 'node:test';
import assert from 'node:assert/strict';

process.env.SHAREDOWN_TZ = 'America/Lima';
process.env.SHAREDOWN_LOCALE = 'es-PE';

const { applyNameTemplate, describeVideo, getServerRelativePath, getVideoKey, sortVideos } = await import('../lib/meta.mjs');

const site = '/sites/Course-2026';
const shareUrl = `https://contoso.sharepoint.com/:v:/r${site}/Documentos%20compartidos/General/Recordings/Solo%20vista/` +
                 'lectures-20260812_124031UTC-Meeting%20Recording.mp4?d=w0123456789abcdef0123456789abcdef&csf=1&web=1&e=AbCdEf';
const filePath = `${site}/Documentos compartidos/General/Recordings/Solo vista/lectures-20260812_124031UTC-Meeting Recording.mp4`;

test('server relative path from the different url formats', () => {
    assert.equal(getServerRelativePath(shareUrl), filePath);
    assert.equal(getServerRelativePath(`https://contoso.sharepoint.com${encodeURI(filePath)}?web=1`), filePath);
    assert.equal(getServerRelativePath(`https://contoso.sharepoint.com${site}/_layouts/15/stream.aspx?id=${encodeURIComponent(filePath)}`), filePath);
    assert.equal(getServerRelativePath('https://contoso.sharepoint.com/:v:/s/Site/EabcdEFG'), null);
    assert.equal(getVideoKey(getServerRelativePath(shareUrl)), getVideoKey(filePath.toUpperCase()));
});

test('class date from Teams file name, in local time', () => {
    const v = describeVideo({name: 'lectures-20260812_124031UTC-Meeting Recording.mp4', serverRelPath: filePath, origin: 'https://contoso.sharepoint.com'});

    assert.equal(v.class_date, '2026-08-12');
    assert.equal(v.weekday, 'miércoles');
    assert.equal(v.start_time, '07:40');
    assert.match(v.url, /Solo%20vista\/lectures-20260812_124031UTC-Meeting%20Recording\.mp4\?web=1$/);
});

test('class date falls back to creation time', () => {
    const v = describeVideo({name: 'clase.mp4', serverRelPath: '/sites/a/clase.mp4', origin: 'https://x.sharepoint.com', created: '2026-08-14T01:30:00Z'});

    assert.equal(v.class_date, '2026-08-13');
    assert.equal(v.weekday, 'jueves');
    assert.equal(v.date_source, 'Sharepoint creation time');
});

test('name template', () => {
    const v = describeVideo({name: 'lectures-20260812_124031UTC-Meeting Recording.mp4', serverRelPath: filePath, origin: 'https://contoso.sharepoint.com'});
    const noDate = describeVideo({name: 'intro.mp4', serverRelPath: '/sites/a/intro.mp4', origin: 'https://x.sharepoint.com'});

    assert.equal(applyNameTemplate('{date} {weekday} - {name}', v, 1), '2026-08-12 miércoles - lectures-20260812_124031UTC-Meeting Recording.mp4');
    assert.equal(applyNameTemplate('{index} {date} {time}', v, 3), '03 2026-08-12 07h40.mp4');
    assert.equal(applyNameTemplate('{date} {weekday} - {name}', noDate, 1), 'intro.mp4');
});

test('sort by class date', () => {
    const mk = n => describeVideo({name: n, serverRelPath: `/sites/a/${n}`, origin: 'https://x.sharepoint.com'});
    const sorted = sortVideos([mk('b-20260815_120000UTC-x.mp4'), mk('a-20260812_120000UTC-x.mp4'), mk('nodate.mp4')], 'class_date');

    assert.deepEqual(sorted.map(v => v.name), ['a-20260812_120000UTC-x.mp4', 'b-20260815_120000UTC-x.mp4', 'nodate.mp4']);
});
