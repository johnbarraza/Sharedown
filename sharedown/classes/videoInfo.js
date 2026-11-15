/**
 * This file is part of the Sharedown (https://github.com/kylon/Sharedown).
 * Copyright (c) 2021 Kylon.
 *
 * This program is free software: you can redistribute it and/or modify
 * it under the terms of the GNU General Public License as published by
 * the Free Software Foundation, version 3.
 *
 * This program is distributed in the hope that it will be useful, but
 * WITHOUT ANY WARRANTY; without even the implied warranty of
 * MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE. See the GNU
 * General Public License for more details.
 *
 * You should have received a copy of the GNU General Public License
 * along with this program. If not, see <http://www.gnu.org/licenses/>.
 */
"use strict";

// file name and class date of a video url
class videoInfo {
    // Teams recordings: name-20260812_124031UTC-Meeting Recording.mp4
    static #teamsDateRx = /(\d{4})(\d{2})(\d{2})_(\d{2})(\d{2})(\d{2})UTC/;

    // server relative path, works for /:v:/r/..., /sites/... and ?id=... urls
    static getPath(url) {
        try {
            const urlObj = new URL(url.replaceAll('#', '%23'));
            const id = urlObj.searchParams.get('id');

            if (id !== null && id.includes('/'))
                return id;

            return decodeURIComponent(urlObj.pathname.replace(/^\/:[a-z]:\/[a-z]\//, '/'));

        } catch (e) {
            return url;
        }
    }

    static getKey(url) {
        return videoInfo.getPath(url).normalize().toLowerCase();
    }

    static getFileName(url) {
        return videoInfo.getPath(url).split('/').filter(s => s !== '').at(-1) ?? url;
    }

    static getDate(url, meta) {
        const m = videoInfo.getFileName(url).match(videoInfo.#teamsDateRx);

        if (m !== null)
            return new Date(Date.UTC(m[1], m[2] - 1, m[3], m[4], m[5], m[6]));
        else if (meta?.created)
            return new Date(meta.created);

        return null;
    }

    // dd mm aa by default (Peru); tokens: dd mm aa aaaa (or yy yyyy)
    static formatDate(date, fmt) {
        const pad = n => n.toString().padStart(2, '0');
        const y = date.getFullYear().toString();

        return (fmt || 'dd-mm-aa').replace(/aaaa|yyyy/gi, y).replace(/aa|yy/gi, y.slice(2))
            .replace(/dd/gi, pad(date.getDate())).replace(/mm/gi, pad(date.getMonth() + 1));
    }

    // mié 12/08/26 07:40 · name.mp4
    static getLabel(url, meta, fmt) {
        const date = videoInfo.getDate(url, meta);
        const name = videoInfo.getFileName(url);

        if (date === null)
            return name;

        const day = date.toLocaleDateString(undefined, {weekday: 'short'});
        const time = date.toLocaleTimeString(undefined, {hour: '2-digit', minute: '2-digit'});

        return `${day} ${videoInfo.formatDate(date, (fmt || 'dd-mm-aa').replaceAll('-', '/'))} ${time} · ${name}`;
    }

    // 12-08-26 miércoles
    static getDatePrefix(url, meta, fmt) {
        const date = videoInfo.getDate(url, meta);

        if (date === null)
            return '';

        const weekday = date.toLocaleDateString(undefined, {weekday: 'long'});

        return `${videoInfo.formatDate(date, fmt)} ${weekday}`;
    }
}
