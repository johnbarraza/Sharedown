const { join } = require('node:path');
const { homedir } = require('node:os');

/**
 * Keep the MCP Chrome out of the Sharedown app puppeteer folder (the parent puppeteer.config.js would be used otherwise).
 * @type {import("puppeteer").Configuration}
 */
module.exports = {
    cacheDirectory: process.env.PUPPETEER_CACHE_DIR || join(homedir(), '.cache', 'puppeteer')
};
