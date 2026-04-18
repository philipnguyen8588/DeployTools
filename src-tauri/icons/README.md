# Icons

Replace the placeholder icons before the first release. You can generate all
required sizes from a single source PNG with:

```bash
npm install -g @tauri-apps/cli
tauri icon path/to/source.png
```

The required files are listed in `tauri.conf.json` → `bundle.icon`:

- `32x32.png`, `128x128.png`, `128x128@2x.png`
- `icon.icns` (macOS)
- `icon.ico` (Windows)
