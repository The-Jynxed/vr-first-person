# VR First Person (for 3D Canvas)

See your 3D Canvas scene through your token's eyes in a VR headset.
Built and tested-for: Meta Quest 3 → Virtual Desktop → Microsoft Edge → HTTPS Foundry server.

## Install

1. Copy the whole `vr-first-person` folder into your Foundry server's `Data/modules/` folder.
2. Restart Foundry (or return to setup and relaunch the world).
3. In the world: **Game Settings → Manage Modules → enable "VR First Person (for 3D Canvas)"**. 3D Canvas must be enabled too.

## Use

1. Put on the Quest, start **Virtual Desktop**, and make sure it's streaming in **VR mode via SteamVR or OpenXR**
   (Virtual Desktop's settings → *Streaming* → OpenXR Runtime = VDXR is the smoothest option).
2. In Edge on the PC, open Foundry, switch the scene to 3D, and **select your token**.
3. Click **Enter VR** (top-centre of the screen). Edge may ask permission to use the VR device the first time: allow it.

| Control | Does |
|---|---|
| Left stick | Move one square in that direction (holding it keeps stepping) |
| Right stick left/right | Snap turn |
| A or X | Recenter your view on your token |
| B or Y | Leave VR |

## Settings (per user, in Configure Settings → VR First Person)

- **Joystick movement direction**: *Relative to where I'm looking* (default) or *Relative to the map*, which behaves exactly like the arrow keys.
- **Step repeat delay**: how fast you keep walking while holding the stick.
- **Snap turn angle**: 30°/45°/90° or off.
- **Height offset**: raise your eyes if you play seated or your character is tall.
- **World scale multiplier**: if everything looks the wrong size, change this.
- **VR resolution scale**: 0.7 by default. Lower it if VR stutters or stops itself.
- **Hide my own token in VR**, **View follow speed**.

## First test: check what the module can see

Before putting the headset on, open the browser console (F12) with a 3D scene loaded and a token selected, then run:

```js
game.modules.get("vr-first-person").api.diagnose()
```

Every row should say `true` (or show a value). If **"3D Canvas global found"** or **"renderer / scene / camera found"** is false,
3D Canvas stores its internals under different names in your version. Copy the printed **"3D Canvas keys"** list
back to Claude and the lookups in `scripts/main.js` (the "3D Canvas access" section) can be fixed.

## If the page freezes ("Page not responding")

v0.1.2 fixes the most likely cause: the first VR frame rebuilt every shader in the scene at once
(3D Canvas's shaders were built for its post-processing, not for drawing straight to a headset). The module
now builds them in the background after you click **Enter VR**, so expect a short
"Preparing the 3D scene for the headset…" pause. It also asks for a VR-ready graphics context when the page
loads, so **reload the page once after updating** (F5).

If it still freezes, the module logs every step of starting VR, with timings, and stops VR by itself if frames get too slow.

1. Load the 3D scene, select your token, press **F12** and open the **Console** tab.
2. Type `vr-first-person` into the console's filter box.
3. Click **Enter VR** and wait.
4. The last line that appears shows which step it stopped at:
   - `requesting VR session` with nothing after it: Edge or Virtual Desktop never answered. Make sure VD is connected *and* streaming before you load the page.
   - `context xrCompatible false`: the page wasn't reloaded after updating, or another module created the 3D view's graphics context before this one loaded.
   - `building VR shaders in the background` with nothing after it for a long time: the scene is very heavy; it gives up waiting after 60 seconds and carries on.
   - `handing the 3D renderer to the headset (setSession)` with nothing after it: Edge got stuck moving the 3D view to the headset.
   - `XR frame 1 took ...ms` with a big number: each frame is too heavy. Lower **VR resolution scale** or 3D Canvas quality.

## Troubleshooting

- **"No headset found"**: Virtual Desktop must be streaming in VR (SteamVR/VDXR running) *before* you load the Foundry page. Reload the page after starting it.
- **Headset shows black or frozen**: send the result of `diagnose()` and any red console errors.
- **Desktop 3D view freezes after leaving VR**: reload the page (F5) and report it with the `diagnose()` output. Since v0.1.2 the module hands 3D Canvas its render loop back when you leave VR, so this shouldn't happen.
- **Moving forward goes sideways/backwards**: switch *Joystick movement direction* to *Relative to the map*, and report it. The head-relative mode assumes 3D Canvas maps the 2D map's x/y onto the 3D x/z axes.
- **World is huge or tiny**: adjust *World scale multiplier*.
- **Laggy or stuttering**: lower 3D Canvas quality settings (shadows, resolution scale) and Virtual Desktop's bitrate/quality preset. VR draws the scene twice at 72–120 fps.

## Known limitations (v0.1)

- Foundry's interface (chat, sheets, dice) isn't visible inside the headset. Take it off, or use Virtual Desktop's desktop view, for those.
- Post-processing effects from 3D Canvas (bloom etc.) are skipped in VR.
- This reaches into 3D Canvas internals that have no public API, so a 3D Canvas update can break it.
