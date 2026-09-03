# PWA icons

`pwa-icon-source.svg` is the master for the installed-app icons. It is a full-bleed
512×512 board: the mark sits inside the centre 60% so a circular or squircle
maskable crop never clips it, and the letter/tittle colors are literal rather than
`prefers-color-scheme` (rasterisers ignore media queries).

Regenerate `public/pwa-192.png` and `public/pwa-512.png` after editing it:

```bash
magick -background none icons/pwa-icon-source.svg -resize 512x512 public/pwa-512.png
magick -background none icons/pwa-icon-source.svg -resize 192x192 public/pwa-192.png
```
