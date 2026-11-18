# Lyrics legibility audit

How readable overlay lyrics were on every built-in look, what goes wrong, and what each look now prefers.

## How it was measured

Each of the 46 looks was played on the *Pressure* demo, in its loud drop, with test lines on screen. The finished frame (before pop-ups and lyrics) was shrunk to 96×54 and read back five times per look (`src/dev/lyricAudit.ts`, through the lyric layer's probe). For every place text can go (subtitle low, subtitle high, big line in the middle, top, bottom, left half, right half) we measured:

- **miss**: the share of the text box where the old treatment falls under the WCAG contrast target (3:1 for big type, 4.5:1 for subtitles). The old treatment was the look's own text colour over a soft shadow in the look's background colour.
- **busy**: mean neighbour difference of the picture's brightness (calm ≈ 0.01, busy ≥ 0.1). Busy pictures need more than contrast.
- **needs**: the lightest backing the new guard needs there to clear the target at the worst sampled moment (0 none, 1 shadow, 2 soft plate, 3 band).

Rerun it with a track playing: `const { lyricAudit } = await import('/src/dev/lyricAudit.ts'); await lyricAudit()`.

## Worst offenders (old treatment)

| Look | Old miss, subtitle / big | Busy | Why it fails | Now prefers |
|---|---|---|---|---|
| Ripple Postcard | **96%** / 30% | 0.05 | dark ink over the photo's dark lower third | right half or top, look ink, soft plate |
| Paper Ghost | **92%** / 86% | 0.09 | near-black ink on a near-black halftone ghost | light ink, middle, shadow |
| Silk Mourning | **87%** / 58% | 0.07 | pale ink on bright silk folds | top (darkest), soft plate |
| Blue Mosaic | **84%** / 28% | 0.14 | dark ink on a dark, busy mosaic low in frame (needs a band) | right half or top, soft plate |
| Glyph Negative | 82% / 77% | 0.17 | navy ink on a dark glyph field, very busy | light ink on a band, cutouts |
| Flip Cards / Paper | 32–44% / 38–47% | 0.07 | mid-tone cards under any ink; the cards already show the words | their own lyrics (overlay stands down) |
| Pixel Cube (both) | 10–21% / 34–40% | 0.07 | the cube's mid-tones sit right where big words go | top / bottom, dark ink, soft plate |
| Sub Pressure | 15% / 42% | 0.15 | white ink over strobing bright bars | cutouts, bands, low subtitles |
| Kaleido Candy | 36% / 20% | 0.16 | mid-tone kaleidoscope everywhere | cutouts, band behind big type |
| One-Bit Orb | 0% / 36% | 0.12 | the dithered orb is the middle of the frame | above / below the orb |
| Chrome Warehouse | 25% / 20% | 0.10 | bloom highlights behind white ink | light ink, soft plate, low |
| Blomp Grid | 1% / 30% | **0.29** | busiest picture measured, all in the middle | top / bottom only; big type poor |
| Slit Archive | 15% / 33% | 0.05 | bright slit slices through a dark frame | top / bottom, soft plate |
| Glyph Mosaic | 11% / 23% | 0.20 | fine glyph texture under the text | paper strip, cutouts |

Calm everywhere (old treatment already fine): Rain Window, Ink Dissolve, Terminal Swarm, Tunnel Vision, Violet Glass, Mission Control, Song Forecast, Combed Light, Contours.

## The gaps behind them

1. **The palette lies about the picture.** Ink came from the look's palette, which assumes the picture is the palette's background. Photo and halftone looks (Paper Ghost, Ripple Postcard, Glyph Negative, Blue Mosaic, Silk Mourning) put dark ink on dark pixels or pale ink on pale ones: 80–96% of the box unreadable. *Fix: the ink is chosen from the sampled frame.*
2. **Mid-tones have no safe ink.** Pictures averaging 20–50% brightness (Silk, Kaleido, Flip Cards, Pixel Cube, Chrome) fail with any flat ink somewhere in the box. *Fix: a soft plate or band, chosen only when the measurement says so.*
3. **Busy textures beat contrast.** Glyph fields, dithers, strobes and grids (busy ≥ 0.1) stay hard to read even at 3:1. *Fix: busyness raises the target; halos, plates or paper calm it.*
4. **Big words always sat in the middle, which is where most looks keep their subject** (orb, cube, blob, swarm, waveform, target, grid). On ten looks the top and bottom bands were completely calm while the middle needed a plate. *Fix: per-look calm zones, and Auto picks the calmest one per line from the live frame.*
5. **Boards are busiest at the bottom**, exactly where subtitles went (Lab, Oto, Arcade). Their tops are clean paper. *Fix: board subtitles go high, on a paper strip when needed.*
6. **Lyric looks were treated like any other look.** Seven looks show the sung words themselves (Orbit Board, Dear Diary, Diary Ink, Redacted, Highlighter, Flip Cards ×2) and two echo them (Arcade's hi-scores, Forecast's bulletin). Big text already stood down there, but the old Auto never planned around them. *Fix: profiles mark them; the lyric plan hands those parts to the look ("own").*
7. **One treatment for the whole song.** Auto read the mood once (tender / dreamy / punchy / aggressive) and every line looked the same, verse or drop. *Fix: a per-section lyric plan mixing subtitles, big words, cutouts, sparse words and the look's own lyrics, with one-off moments.*
8. **The shadow was in the background colour, not a contrasting one**, so on looks whose picture matches their background it added nothing. *Fix: the plate colour is chosen against the ink.*

## What each look prefers

`src/render/lyricProfiles.ts` holds a profile for all 46 looks (and fallbacks per scene kind), filled from these numbers:

- **suits**: how well subtitles, big words, cutouts and sparse words sit on it (Blomp Grid 0.3 for big words, Rain Window 0.9…)
- **zones**: where the picture was calmest, best first
- **own**: `carries` (shows the words itself), `echoes` (has lyric bits of its own), or `none`
- **ink**: keep the look's ink when it reads, or force light / dark (Paper Ghost light, the boards dark)
- **plate**: which backing family suits it when needed: shadow, soft plate, band, or a torn paper strip (boards and paper looks)

## After the changes

The guard samples the frame every other frame and eases ink and backing toward whatever clears the target under the actual text box (see `src/render/legibility.ts`). Played-video checks (`src/dev/lyricCheck.ts`: made-up lines every ~4 s, a video plan from *Make a video*, sampled five times a second after each line's fade-in, miss share from `stage.lyricLayer.legibilityNow()`):

| Run | Frames | Over 10% miss | Mediums used |
|---|---|---|---|
| Pressure, first guard (before the cut fix) | 152 | 32 | subtitle, sparse, big + giant word |
| Pressure, with the cut fix | 210 | 6 (single frames on a hard cut, recovered within 0.2 s) | subtitle, sparse, big + giant word |
| Pressure with Flip Cards and Dear Diary in the plan | 210 | 0 | subtitle, sparse, big, own (overlay stood down on the lyric looks) |
| Driftwood | 173 | 1 | sparse, subtitle, big |

Two renders of the same song differ: Pressure came back as *subtitle → sparse → big + giant → subtitle* and *subtitle → sparse → cutout + giant → subtitle*; Driftwood as *sparse → subtitle → subtitle → big* (serif) and *sparse → subtitle → big → big*, over different looks. The offline planner varies family and mediums per seed in the same way.

Not covered yet: pop-up windows (the typewriter, UP NEXT, NEWS.WIRE) can still land on top of the lyric box.
