/**
 * This file is part of the Sharedown (https://github.com/kylon/Sharedown).
 *
 * Imported first: puppeteer reads its configuration on import and would pick the Sharedown app
 * puppeteer.config.js when the server is started from the repository folder.
 */
import os from 'node:os';
import path from 'node:path';

process.env.PUPPETEER_CACHE_DIR ??= path.join(os.homedir(), '.cache', 'puppeteer');
