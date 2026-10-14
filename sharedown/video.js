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

class video {
    id;
    url;
    settings = {
        _version: 1, // internal
        saveas: '',
        outputPath: ''
    };
    meta = {
        created: 0,
        lastModf: 0
    };

    constructor(url, settings = null, meta = null) {
        this.url = url;

        if (settings !== null) {
            this.settings.saveas = settings.saveas ?? '';
            this.settings.outputPath = settings.outputPath ?? ''
        }

        if (meta !== null) {
            this.meta.created = meta.created ?? 0;
            this.meta.lastModf = meta.lastModf ?? 0;
        }

        this.#generateId();
        Object.freeze(this);
    }

    #generateId() {
        this.id = window.sharedown.genID();
    }
}