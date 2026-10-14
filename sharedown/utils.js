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

const SharedownMessage = (() => {
    return Object.freeze({
        EFFmpegNotFound: 'FFmpeg was not found on your system.\nSharedown requires FFmpeg to work, please install it.\n\nSharedown will now exit.',
        OpenFFmpegWiki: 'Open Sharedown Wiki for instructions on how to install FFmpeg?',
        EYTdlpNotFound: 'yt-dlp was not found on your system.\nSharedown requires yt-dlp to work, please install it.\n\nSharedown will now exit.',
        OpenYtdlpWiki: 'Open Sharedown Wiki for instructions on how to install YT-dlp?',
        EDownloadQueFromDisk: 'Unable to load download queue from disk',
        EEmptyCustomLoginField: 'A required login field is empty!\nAutomatic login will be disabled.\n\nDo you want to continue?',
        EImportAppState: 'Could not import app state from disk',
        EDownloadFail: 'Download failed',
        EInvalidURLsInAddList: 'Some URLs were invalid and they were skipped',
        EDuplicatedURLsInAddList: 'These videos are already in the download queue and they were skipped:',
        EImportFromFolderCanceled: 'Import from folder canceled!',
        EInvalidID: 'Invalid video ID',
        EGeneric: 'Sharedown error',
        EJsonParse: 'JSON parse error',
        ELoginModule: 'Login Module Error',
        EPwdManLoginModuleFormat: 'Invalid credential format for login module!\n\nPlease, delete your credentials and save them again.'
    });
})();

const Utils = (() => {
    const _sharedownApi = window.sharedown;
    const util = {};

    function _getLoginData(globalSettingsModal) {
        const customFieldsLen = _sharedownApi.sharedownLoginModule.getFields()?.length;
        const loginData = {
            msid: globalSettingsModal.querySelector('#username').value
        };

        if (!customFieldsLen) // login module has no fields or not set
            return loginData;

        loginData.custom = {}; // add custom field

        for (let i=0; i<customFieldsLen; ++i) {
            const val = globalSettingsModal.querySelector('#loginModuleField'+i).value;

            if (val === '') {
                loginData.custom = {};
                break;
            }

            loginData.custom["field"+i] = val;
        }

        return loginData;
    }

    function _isValidCustomLogin(loginData) {
        if (loginData.hasOwnProperty('custom') && !Object.keys(loginData.custom).length) {
            const ret = _sharedownApi.showMessage(messageBoxType.Question, SharedownMessage.EEmptyCustomLoginField, SharedownMessage.ELoginModule);

            if (ret === 0) // ret: 0 - cancel button, 1 - ok
                return false;

            delete loginData.custom; // disable automatic login and proceed
        }

        return true;
    }

    util.keytarSaveCredentials = async (globalSettingsModal, loginModule) => {
        const loginModuleVals = [];

        for (let i=0,l=_sharedownApi.sharedownLoginModule.getFieldsCount(); i<l; ++i)
            loginModuleVals.push(globalSettingsModal.querySelector(`#loginModuleField${i}`).value);

        loginModuleVals.push(loginModule);

        await _sharedownApi.keytarSaveLogin({
            msid: globalSettingsModal.querySelector('#username').value,
            lm: loginModuleVals.length > 1 ? loginModuleVals.join(':') : ''
        });
    }

    util.keytarDeleteCredentials = async () => {
        await _sharedownApi.keytarRemoveLogin();
    }

    util.getVideoData = async (globalSettingsModal, video, settings) => {
        if (settings.userdataFold || settings.keepBrowserOpen)
            return ( await _sharedownApi.runPuppeteerGetVideoData(video, null, settings) );

        const loginD = _getLoginData(globalSettingsModal);

        if (!_isValidCustomLogin(loginD))
            return null;

        return ( await _sharedownApi.runPuppeteerGetVideoData(video, loginD, settings) );
    }

    util.getFolderURLsList = async (globalSettingsModal, foldersList, includeSubFolds, urlsSortType, settings) => {
        if (settings.userdataFold || settings.keepBrowserOpen)
            return ( await _sharedownApi.runPuppeteerGetURLListFromFolder(foldersList, includeSubFolds, urlsSortType, null, settings) );

        const loginD = _getLoginData(globalSettingsModal);

        if (!_isValidCustomLogin(loginD))
            return null;

        return ( await _sharedownApi.runPuppeteerGetURLListFromFolder(foldersList, includeSubFolds, urlsSortType, loginD, settings) );
    }

    util.getOutputFolder = (globalFolder, videoFolder) => {
        if (globalFolder === '')
            globalFolder = sharedownApi.getDefaultOutputFolder();

        return videoFolder === '' ? globalFolder:videoFolder;
    }

    util.getOutputFileName = (videoTitle, videoSaveAs) => {
        return videoSaveAs === '' ? videoTitle : `${videoSaveAs}.mp4`;
    }

    util.showSelectOutputFolderDialog = elm => {
        const path = _sharedownApi.showSelectFolderDialog();

        if (path === undefined)
            return false;

        const inpt = elm.parentElement.querySelector('.outpath');

        inpt.value = path[0];
        inpt.setAttribute('title', path[0]);
    }

    util.showSelectCustomChromeDialog = elm => {
        const path = _sharedownApi.showSelectChromeBinDialog();

        if (path === undefined)
            return false;

        const inpt = elm.parentElement.querySelector('.binpath');

        inpt.value = path[0];
        inpt.setAttribute('title', path[0]);
    }

    util.isValidURL = url => {
        return url !== '' && url.includes('sharepoint') && url.substring(0, 8) === 'https://';
    }

    util.setAsWebPlayerURL = url => {
        const urlObj = new URL(url);

        if (urlObj.searchParams.get('web') === null)
            urlObj.searchParams.set('web', '1');

        return urlObj.href;
    }

    util.getYtdlpNVal = n => {
        return Math.min(Math.max(parseInt(n, 10), 1), 5);
    }

    // server relative path of the video, works for /:v:/r/..., /sites/... and ?id=... urls
    util.getVideoPath = url => {
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

    util.getVideoKey = url => {
        return util.getVideoPath(url).normalize().toLowerCase();
    }

    util.getVideoFileName = url => {
        return util.getVideoPath(url).split('/').filter(s => s !== '').at(-1) ?? url;
    }

    // Teams recordings: name-20260812_124031UTC-Meeting Recording.mp4
    util.getVideoDate = (url, meta) => {
        const m = util.getVideoFileName(url).match(/(\d{4})(\d{2})(\d{2})_(\d{2})(\d{2})(\d{2})UTC/);

        if (m !== null)
            return new Date(Date.UTC(m[1], m[2] - 1, m[3], m[4], m[5], m[6]));
        else if (meta?.created)
            return new Date(meta.created);

        return null;
    }

    util.formatVideoDate = date => {
        // month as text: 12/08 is ambiguous between dd/mm and mm/dd
        const day = date.toLocaleDateString(undefined, {weekday: 'short', day: '2-digit', month: 'short', year: 'numeric'});
        const time = date.toLocaleTimeString(undefined, {hour: '2-digit', minute: '2-digit'});

        return `${day} ${time}`;
    }

    util.getVideoLabel = (url, meta) => {
        const date = util.getVideoDate(url, meta);
        const name = util.getVideoFileName(url);

        return date === null ? name : `${util.formatVideoDate(date)} · ${name}`;
    }

    // 2026-08-12 miércoles
    util.getVideoDatePrefix = (url, meta) => {
        const date = util.getVideoDate(url, meta);

        if (date === null)
            return '';

        const pad = n => n.toString().padStart(2, '0');
        const weekday = date.toLocaleDateString(undefined, {weekday: 'long'});

        return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${weekday}`;
    }

    Object.freeze(util);
    return util;
})();