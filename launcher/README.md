# Windows desktop launcher

Double-click `SillyTavern.bat`, or the desktop shortcut **酒馆 SillyTavern**.
The shortcut starts with its console minimized and opens the browser when the
server is ready. Restore the console to read startup errors or press Ctrl+C to
stop the server. Keep that console open while using SillyTavern.

The launcher uses the installed Node.js (20+) and existing dependencies. It reads
the port from `config.yaml` and does not install packages or update the repository.
If dependencies are absent, run the original `Start.bat` once. The original
upstream startup scripts remain available.

Repeated clicks reuse a responding SillyTavern on the configured local port.
A per-project mutex also prevents simultaneous starts through this launcher.
An unidentified occupied port produces an error; the launcher never kills it.
For authenticated servers or a local HTTPS certificate that Windows does not
trust, identification may fail; use the existing browser page in that case.

Diagnostics (no server or browser launch):

```bat
SillyTavern.bat -Check
```

Start without opening a browser:

```bat
SillyTavern.bat -NoBrowser
```

`sillytavern.ico` is an original AI-generated anime tavern hostess sticker,
created with the built-in imagegen tool to match the user's desktop icon style.
It includes 16, 24, 32, 48, 64, 128 and 256 pixel images with transparency.
