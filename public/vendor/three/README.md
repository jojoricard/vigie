# three.js

The only third-party code of the page, kept here so the dashboard needs no npm, no build and no network.

- Version: r170 (`three@0.170.0`), the last release whose ES module is a single file
- Source: `build/three.module.min.js` of the npm package, unchanged
- sha256: `08fd7545d13d2c7fb65ab691530a802dafefd638596501854f267d0fb13c39e7`
- Licence: MIT, see `LICENSE`

Only `public/js/plan3d.js` imports it, and only when the House tab draws a plan.

To update: replace the file with the same one from a newer package, update the version and the checksum above, then check the plan on screen. From r171 on the module is split in two files (`three.module.min.js` and `three.core.min.js`): both must then be copied.
