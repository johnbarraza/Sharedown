# Sharedown MCP server

MCP server to list and download Sharepoint videos (e.g. Teams class recordings) from an AI assistant such as Claude Code.

It shows the **full file name**, the **class date, weekday and start time** of each video, and downloads whole folders in batch.

## Requirements

* Node.js 18+
* [yt-dlp](https://github.com/yt-dlp/yt-dlp/releases) and FFmpeg (with ffprobe) in your `PATH` (same as Sharedown)
* Chrome for puppeteer: `npm run install-chrome` (installed automatically by `npm install` in most cases)

## Install

```
cd mcp
npm install
```

### Claude Code

```
claude mcp add sharedown --scope user -- node /absolute/path/to/Sharedown/mcp/server.mjs
```

### Other MCP clients (Claude Desktop, etc.)

```json
{
  "mcpServers": {
    "sharedown": {
      "command": "node",
      "args": ["/absolute/path/to/Sharedown/mcp/server.mjs"]
    }
  }
}
```

## Tools

| Tool | What it does |
| --- | --- |
| `check_requirements` | Checks yt-dlp, ffmpeg/ffprobe, Chrome, the output folder and the saved login; tells how to install what is missing. |
| `sharepoint_login` | Opens a visible Chrome window to sign in (MFA works). Choose **Stay signed in**: the session is saved and reused. |
| `list_folder_videos` | Videos of a folder url with name, class date, weekday, start time, size, player url and whether it was already downloaded. Filters `from_date` / `to_date`, optional subfolders. |
| `get_video_info` | Full name and class date of a single video url (no login needed unless `remote: true`). |
| `download_videos` | Background job that downloads a folder and/or a list of urls, one video at a time, as `mp4`/`mkv` or audio only (`mp3`, `m4a`, `opus`, `wav`, `flac`). Skips duplicates and videos downloaded before; `newest_first` to start with the latest classes. Every file is verified when it finishes. |
| `download_status` | Progress of the jobs. |
| `cancel_download` | Stops a job now, or after the current video with `after_current`. Finished videos are kept; downloading again continues. |
| `convert_files` | Converts downloaded files or folders to another format with ffmpeg (originals are kept). |
| `verify_files` | Finds files with missing fragments (audio/video gaps) or without audio. |

Class date: Teams recordings contain the meeting start time in the file name (`lectures-20260812_124031UTC-Meeting Recording.mp4`
is Wednesday 2026-08-12 07:40 in Lima). For other videos the Sharepoint creation time is used.

Output file names use `name_template`, default `{date} {weekday} - {name}` →
`2026-08-12 miércoles - lectures-20260812_124031UTC-Meeting Recording.mp4`.
Placeholders: `{date}` `{weekday}` `{time}` `{name}` `{index}`.

Example prompts:

* "List the videos in this folder: https://tenant.sharepoint.com/:f:/r/sites/..."
* "Download the classes from August from this folder to D:\Classes"

## Command line

The same features without an AI assistant, with live progress:

```
node cli.mjs login    <sharepoint url>
node cli.mjs list     <folder url>
node cli.mjs download <folder or video url>... [--format mp4] [--out <dir>] [--from YYYY-MM-DD] [--to YYYY-MM-DD] [--newest-first] [--force]
node cli.mjs verify   <file or folder>...
node cli.mjs convert  <file or folder>... --format mp3 [--out <dir>]
```

Videos are downloaded oldest class first (`--newest-first` for the opposite). `download` skips videos already downloaded to the output folder, so running it again only gets the new classes
(or continues after Ctrl+C).

## Settings (environment variables)

| Variable | Default |
| --- | --- |
| `SHAREDOWN_OUTPUT_DIR` | `~/Downloads/sharedownVideos` |
| `SHAREDOWN_NAME_TEMPLATE` | `{date} {weekday} - {name}` |
| `SHAREDOWN_TZ` | system time zone |
| `SHAREDOWN_LOCALE` | system locale (weekday language) |
| `SHAREDOWN_MCP_HEADLESS` | `1`; set `0` to always show the browser |
| `SHAREDOWN_MCP_PROFILE` | `<appData>/Sharedown/mcp-profile` (saved login) |
| `SHAREDOWN_CHROME_PATH` | Chrome downloaded by puppeteer |
| `SHAREDOWN_YTDLP_PATH` | `yt-dlp` |
| `SHAREDOWN_FFMPEG_PATH` | `ffmpeg` (ffprobe is looked up next to it) |
| `SHAREDOWN_YTDLP_N` | `3` (parallel fragments, 1-5; lower it if Sharepoint answers 429 Too Many Requests) |
| `SHAREDOWN_TIMEOUT` | `90` seconds |

Example with Claude Code: `claude mcp add sharedown -e SHAREDOWN_OUTPUT_DIR=D:/Classes -- node .../mcp/server.mjs`

**We take NO responsibility for your actions, do not violate your tenant rules!**
