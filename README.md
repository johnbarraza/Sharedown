![](sharedown/img/logo.png)

> **Fork de [kylon/Sharedown](https://github.com/kylon/Sharedown)** (basado en Sharedown 6.0) con servidor MCP,
> descarga por lotes de carpetas, fecha de cada clase y verificación de descargas.
> Ver [Novedades de este fork](#novedades-de-este-fork).

Sharedown is an Electron application to download Sharepoint videos, especially meant for students.

**We take NO responsibility for your actions, do not violate your tenant rules!**

### Sharedown Wiki
See [Sharedown Wiki](https://github.com/kylon/Sharedown/wiki) for more info or help!

### Requirements
* A recent version of FFmpeg
* YT-dlp - [releases](https://github.com/yt-dlp/yt-dlp/releases)
* Python 3
* A recent OS (Windows, Linux, or macOS)

### Releases
* Este fork (con las novedades de abajo): [última compilación](https://github.com/johnbarraza/Sharedown/releases/latest)
* Sharedown original: [latest build](https://github.com/kylon/Sharedown/releases/latest)

### Novedades de este fork

#### Servidor MCP (`mcp/`)
Permite que un asistente de IA (Claude Code, Claude Desktop u otro cliente MCP) liste y descargue las grabaciones
de clases de SharePoint/Teams con instrucciones en lenguaje natural, por ejemplo:
*"descarga las clases de agosto de esta carpeta"* o *"¿cuáles clases me faltan bajar?"*.

| Herramienta | Qué hace |
| --- | --- |
| `check_requirements` | Revisa yt-dlp, ffmpeg, Chrome, la carpeta de salida y la sesión; dice cómo instalar lo que falte |
| `sharepoint_login` | Abre Chrome para iniciar sesión (MFA incluido) una sola vez; la sesión queda guardada |
| `list_folder_videos` | Lista los videos de una carpeta con nombre completo, **fecha, día y hora de la clase**, tamaño y si ya se descargó |
| `get_video_info` | Muestra qué video es un link (nombre completo y fecha), útil cuando los links se ven iguales |
| `download_videos` | Descarga una carpeta o lista de links en segundo plano: mp4/mkv o solo audio (mp3, m4a, opus, wav, flac) |
| `download_status` / `cancel_download` | Progreso, pausa (al terminar el video actual) o detención |
| `convert_files` | Convierte archivos ya descargados a otro formato (por ejemplo mp4 → mp3) |
| `verify_files` | Detecta descargas con fragmentos faltantes (huecos de audio/video) |

También incluye una **versión de consola** con progreso en vivo:

```
cd mcp && npm install
node cli.mjs login    <link de SharePoint>
node cli.mjs list     <link de carpeta>
node cli.mjs download <link de carpeta o video> [--format mp4|mp3|...] [--newest-first] [--from 2026-08-01]
node cli.mjs verify   <carpeta>
node cli.mjs convert  <carpeta> --format mp3
```

Características:
* **Fecha de la clase**: se toma del nombre de las grabaciones de Teams (`...-20260812_124031UTC-...` → miércoles 2026-08-12 07:40, hora local)
  o de la fecha de creación en SharePoint. Los archivos se guardan como `2026-08-12 miércoles - <nombre original>.mp4`.
* **No vuelve a descargar**: cada carpeta de salida guarda un historial; volver a correr la descarga solo baja las clases nuevas
  o las que fallaron. Ctrl+C pausa o detiene sin perder lo terminado.
* **Descargas confiables**: reintentos con espera cuando SharePoint limita (HTTP 429), sin saltar fragmentos,
  y verificación automática de cada video al terminar.
* Funciona con carpetas de solo lectura ("Solo vista"), igual que el descargador yt-dlp de Sharedown.

Instalación y configuración: [mcp/README.md](mcp/README.md).

#### Mejoras en la aplicación
* La cola muestra **fecha, día y nombre real** de cada video (antes solo el inicio de la URL, igual para todos).
* Avisa y omite **videos duplicados** en la cola, aunque el link tenga otro formato.
* Importar desde carpeta conserva la fecha y permite **ordenar por fecha de clase**.
* Opción para **agregar la fecha de la clase al nombre del archivo**.
* Opción para **mantener la sesión de Microsoft al cerrar Sharedown** (no volver a iniciar sesión en cada uso).

### Build

Run the following commands in a terminal to build Sharedown.

```
$ git clone https://github.com/johnbarraza/Sharedown.git
$ cd Sharedown
$ npm i
$ npm run dist
```

### Run from source

Run the following commands in a terminal to run Sharedown from source.

```
$ git clone https://github.com/johnbarraza/Sharedown.git
$ cd Sharedown
$ npm i
$ npm start
```

---

![](sharedown.png)
