# Jane


## Start

manually:
```
cd modules/jane-ui
npm install
npm run dev
```

## First Run

The onboarding wizard will ask for your GPU type:
- **NVIDIA** → downloads CUDA build of llama-server
- **AMD** → downloads Vulkan build  
- **Intel Arc/Iris** → downloads Vulkan build
- **CPU only** → downloads AVX2 build

llama-server is downloaded automatically. No manual setup needed.

## Models

Models live in `~/.visrodeck/models/`

To add a custom GGUF model:
1. Open model selector → click the **+** card
2. This opens the models folder
3. Paste any `.gguf` file there
4. It appears automatically in the selector

## FLOAT

Press **Alt+J** to toggle the FLOAT overlay (bottom pill).  
It expands into a mini chat with quick actions.

## Keyboard Shortcuts

| Key | Action |
|-----|--------|
| Alt+J | Toggle FLOAT |
| Alt+Space | Toggle overlay chat |
| Ctrl+Shift+I | Dev tools |

## File Structure

```
jane-complete/
├── modules/
│   ├── jane-ui/        ← Electron app
│   │   ├── main.js     ← Main process
│   │   ├── preload.js  ← IPC bridge
│   │   └── renderer/   ← UI pages
│   └── jane/src/       ← AI agent
│       └── vre_client.js
├── vre/src/            ← VRE kernel (tools engine)
├── config/             ← License & VRE config
└── package.json
```




## Custom Splash Logo
Place your logo file at:
  modules/jane-ui/renderer/splash-logo.png
(or .ico converted to .png — any 256×256 or smaller image works)
The splash screen will automatically use it. If missing, the default Visrodeck "H" mark shows.
