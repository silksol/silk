# silk brand

| | |
| --- | --- |
| Name | Silk (wordmark: `silk`, lowercase) |
| Ticker | $SILK |
| npm package | `silk-crawl` (command: `silk`) |
| Pitch | any site in, clean dataset out. |

## The mark

One thread folded into an S: a whole site pulled into one clean strand of data.

The 3D icon is the primary brand. The flat mark is only for sizes under 32px and one-colour uses.

| File | Use |
| --- | --- |
| `assets/icon.png` | 512px 3D icon with rounded corners. Nav, docs, avatars. |
| `assets/logo.svg` | Flat mark in the accent colour. Favicons, small sizes, the README header. |
| `assets/logo-mono.svg` | Flat mark in `currentColor`, for one-ink uses. |
| `assets/coin.png` | 1000x1000 full bleed token image, safe for a circle crop. |
| `assets/banner.png` | 1280x640 social preview. Source: `assets/banner.html`. |

The full kit (favicons, lockups, X banner, OG image, logo sheet) lives outside the repo in the brand folder.

Rules:

- 3D icon at 32px and up, flat mark below that.
- Keep clear space around the icon of at least a quarter of its width.
- Don't recolour, outline, rotate, stretch or add effects to the icon or the mark.
- Wordmark is `silk` in Mona Sans 700, tracking -0.03em, always lowercase.

## Palette

| Role | Hex | Use |
| --- | --- | --- |
| bg | `#0A0A0C` | Canvas. Neutral near-black. |
| panel | `#0F0F12` | Cards, terminal windows. |
| raised | `#151519` | Inputs, title bars, hover. |
| line | `rgba(255,255,255,.08)` | Borders. `.14` for strong borders. |
| text | `#F2F2F3` | Primary text. |
| muted | `#8B8B93` | Secondary text, labels. |
| accent | `#B9A3F5` | The action, the key number and the mark. Nothing else. |
| up / down | `#3DDC84` / `#FF5F6D` | Price data only. |

## Typography

- **Mona Sans** for UI and headings, weight 600 to 700, tracking -0.02em on big type.
- **JetBrains Mono** for every number, code block, URL and CLI line.

## Voice

- Say what it does with a number when you can: "12 pages, 252 words, 17 chunks."
- Talk like a dev posting a changelog. Short lines, lowercase taglines are fine, no hype words, no dashes, no emojis.
- Be straight about limits: no JavaScript rendering, token counts are estimates, example output is labelled.
