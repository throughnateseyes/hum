# Hum — sound → feeling → space

An experiment in texture, music and emotion. Drop a song in; Hum splits it into layers (sub, bass, mids,
air, kick / snare / hat hits, energy, build-ups, drops), reads its mood, picks a look that fits, and
paints with it. Everything is tweakable: scenes, a stackable effect chain, a modulation matrix that
routes any audio layer to any slider, palettes, photos, and an AI director that writes looks — or
brand-new GLSL scenes — from a sentence.

```bash
npm install
npm run dev          # http://localhost:5173
```

The Claude director works out of the box in dev if Claude Code (`claude`) is installed and signed in:
it runs on your Claude subscription, no key needed. For a deployed site, set `ANTHROPIC_API_KEY`.
With neither, an offline heuristic director answers. See [docs/DIRECTOR.md](docs/DIRECTOR.md).

## Using it

- **Drop audio** anywhere (mp3 / wav / m4a / flac), pick a built-in demo (*Pressure* — 140 bpm
  halftime bass with a build and a drop; *Driftwood* — 72 bpm rain and piano), or use the mic.
- **Drop photos** anywhere — photo scenes and the instrument boards dissolve, mosh and rebuild them
  (a new photo every 4 bars).
- **Looks** (left) are presets. After a track is analysed they're ranked for it ("fits"). Hover any
  look or scene to preview it live in a small window beside the list; click to use it.
- **The timeline** (bottom) is one lane: the waveform, the song's parts (intro, verse, chorus,
  bridge, build, drop, break, outro) with each part's look as a picture and name (or an empty
  "No look yet" slot), drops marked by how big they are, and one playhead. Parts that sound alike
  share a colour, so a returning chorus is easy to spot.
  **Make a video** asks Claude to give every part a look (offline plan if Claude isn't reachable) and
  plays the song from the top. Each part is cut into short shots on musical phrases, rotating
  through 2–4 related looks: busy parts cut faster, calm parts hold longer, extra cuts land when the
  kick or bass comes back, a vocal starts or a lyric line begins, and every big drop is a hard cut.
  Cuts follow the harmony too: a phrase cut slides onto a chord change when one is within a beat,
  a chord coming home (V → I) is a place for the picture to settle with a soft dissolve, and a part
  that repeats an earlier one louder, or sits in a key the song has lifted into, cuts a little faster.
  Transitions come from a library of 15 (crossfade, fades through the background colour or black,
  light and cloud dissolves, film burn, ink, soft wipe, iris, ripple, mosaic, glyphs, zoom push,
  slit-scan, cut), timed in beats and picked to fit the moment: long dissolves in calm parts, wipes
  and slit-scans on builds, quick pushes and glitch swaps in loud ones, and a hard cut on every big
  drop. Dissolves step forward on kicks. **Transition** (Look tab) pins one for everything (videos,
  auto-pilot and your own picks) or Cut, and **Length** sets it in beats.
  **Pace** (Look tab: Slow / Song-driven / Fast) sets how often it cuts. To edit, drag a look onto
  a part (hold ⌥ to change only that one), or pick a look while a part plays, or ask in words in the
  Director's **Video** mode ("calmer chorus", "something brighter on the drop", "fewer pop-ups"):
  only the parts you mention change, on the small model, for a fraction of a cent. Picking a scene
  pauses the song map.
  **Click a part** to open its sheet (a popover over the part on a computer, a bottom sheet on a
  phone: swipe it down or tap outside to close). It has **Play this part**; **Swap the look** with
  the five families that fit the part best and sit well beside its neighbours (filter by mood, or
  **More looks…** for all of them with a search); **Version** to pick a take in one tap;
  **Lyrics** for this part (Subtitles, Big words, A word or two, the look's own) when the song has
  synced lyrics; and **Pop-ups** Auto / Off / Few / Lots (Off also stops the windows). A part you changed wears a dot. Changes are kept
  with the saved video, a new plan keeps them, and **Reset this part** / **Undo** in the sheet put
  things back (`src/ui/PartSheet.tsx`, `src/state/partEdit.ts`).
  **Mood** (the row under the song map) re-plans the whole video in one tap inside one world:
  Brutal, Dreamy, Hacker, Nature, Club, Paper, Night city or Playful. Each mood is a hand-picked set
  of look families and takes plus one finish and transition set (`src/presets/moods.ts`), and both
  the offline planner and Claude stay inside it, as do each part's rotation, drop cuts, skips and
  scene windows. Parts still differ, by take and by neighbouring families of that world. If you've
  changed parts, it asks whether to keep those changes or start fresh. **Any** goes back to no mood.
  **Saved videos:** the last video Claude made for a song stays in this browser (24 songs), edits
  included, so **Make a video** on a song you've done before plays it straight away with no new
  request. **Remake video** (or typing a wish) always asks Claude for a fresh take.
- **Your taste.** Hum learns what you like as you use it. While a video plays (or any look is on
  screen), hover the stage and press **♥ Keep** (`K`) on looks you love or **✕ Skip** (`X`) on ones
  you don't; Skip also takes that look out of the part and moves on. Looks you pick from the list
  or drag onto a part count too, and a look Hum chose that you swap out within a few seconds counts
  a little against it. Each reaction remembers where it happened (chorus, drop…) and what kind of
  song it was (genre, mood, energy), so Hum can learn "Paper looks on choruses" and "no Glyph on
  tender songs" at once. Recent reactions count most and old ones fade (half as much every 30
  days). It steers the offline planner, auto-pilot, each part's rotation and the AI planner, but
  about one pick in five still explores, and every **Make a video** is a new take: renders are
  seeded and Hum remembers the last few plans per song so it doesn't repeat one. **Your taste**
  (Look tab) says in plain words what Hum has learned, with a switch to turn learning off and a
  reset. It all stays in this browser (localStorage); the AI planner only gets a short summary
  (look ids, tags, section names and counts) with a plan you asked for.
- **Breakdown** (button by the timeline, or `B`) shows how Hum took the song apart: its genre,
  mood and instruments, the parts, every drop with how big it is and why, the waveform, energy and
  low / mid / high lanes, the key and chords ("A minor · chords change every bar in the chorus", a box
  per chord, a dot where the harmony comes home, and a tension lane for how far from home it is),
  kick, snare and hat hits, a piano roll of the bass and lead notes, and where the vocals are. Click
  anywhere to jump there.
- **Overlays** (switch by the timeline) turns the pop-up windows off or back on.
- **Lyrics** are found on their own. Hum reads the song's title and artist from the file's tags
  (or its name, like `Artist - Title.mp3`; music-video rips work too, with "(Official Video)",
  "[Lyrics]", "feat. …" and the like ignored), then gets timed lyrics from
  [LRCLIB](https://lrclib.net), a free lyrics library. Lyrics saved inside the file are used first.
  If LRCLIB only has a longer or shorter version (videos add intros and outros), Hum moves the lines
  to where the singing starts in your file. Wrong song or nothing found? **Search LRCLIB** in the
  chip by artist and song, or paste a lrclib.net link.
  Only the title, artist and length are sent, never the audio. The chip beside the track name shows
  what was found. It also switches between **Auto** (the default, a lyric video: see *Auto lyrics*
  below), **Subtitles** (a quiet caption), **Big words** (one display line at a time, each word
  revealed as it's sung), **Collage** (the line as a paper collage: one printed scrap per word, laid
  down as it's sung) and **Off**. On looks that already type the words out (Diary,
  Orbit) the big lines stand down by default; *Show anyway* in the chip brings them back. Lyrics show up in recordings and stills, and the song map's planner reads them
  to fit each part's look to the words. Songs that aren't on LRCLIB (unreleased ones, for example)
  get no lyrics, but you can **paste them** in the chip. Hum then times each line by listening for
  the sung words on this computer (Whisper, about a 95 MB model downloaded once; the audio never
  leaves your machine). If a line is off, **Fix timing** lets you tap along as each line starts, and
  **Shift all lines** moves them all earlier or later. Pasted or fixed lyrics are remembered for that
  song.
  **Synced on their own:** on a computer, once a song's lyrics are found (and the song has been
  analysed), Hum listens and syncs them to the singing by itself, the chip showing the progress
  (the model download the first time). It skips lyrics that are already timed word by word (by hand,
  on LRCLIB or in the file, unless they were made for another length of the song), your pasted and
  saved lyrics, demos and live sound, and it waits while a render or recording runs. A song is only
  listened to once: syncing again, or other lyrics picked for it, reuse what was heard. A new song
  stops a listen under way, and **Stop** in the chip does too. Phones, data saver and low-memory
  devices keep the button instead. **Sync new songs by listening** (chip → More) turns it off.
- **Auto lyrics** direct the words like a lyric video. Each part of the song gets its own medium:
  captions for verses and wordy parts, display lines for choruses and drops, an aside in a margin for
  builds, intros and breaks, and the look's own lyric components where it has them (the Diary
  typewriter, the lyric walls, the word cards: overlay text stands down there). One-off moments land
  too: one giant word on the biggest drop (the key word huge on a third, the rest of the line as a
  small kicker above it), and on loud songs, rarely, one drop line laid down as a paper collage.
  The choice comes from each part's label, energy, words per second and the look planned there.
- **Lyric type** is set like a motion designer would set it (`src/render/lyricAuto.ts`): one line at
  a time, sentence case (lines that arrive in capitals are set back to sentence case), no trailing
  commas, rows balanced so there's no lone word, hung from a margin or a third of the picture rather
  than centred in a box. The whole song keeps one type family, picked to fit its mood:
  *serif* (Instrument Serif for display lines, the key word in its true italic, and the giant word;
  Fraunces for captions and heavier serif lines), *grotesk* (Inter Tight, set tight), *condensed*
  (Archivo narrowed on its width axis, in capitals; Oswald is no longer used) or *mono* (JetBrains
  Mono typed out letter by letter with a caret, IBM Plex Mono captions). The motion comes from the
  voice: words rise out of a mask at their baseline as they're sung (slowly for tender songs, quickly
  for loud ones), tracking opens on held notes (and on Archivo the width steps out too), the weight
  settles as a word lands on loud songs, and lines leave with a quick soft fade. Nothing bounces,
  wobbles or shakes. Captions keep the whole line up quietly and brighten each word with a wipe.
  Everything stays in the middle and lower third, and 9:16 frames keep clear of the bottom band where
  Reels and TikTok put their own captions.
- **Words in the world.** Some looks host the line themselves (`src/render/lyricHosts.ts`): in
  **Night Windows** it's a neon sign over the city whose tubes sit dark until each word is sung, then
  flicker on and buzz with the kick; on **Still Water** the words float on the pool like the leaves,
  each landing as it's sung, casting a shadow on the pebbles and wobbling with the rings. Hosted
  lines get no scrim; they still read the picture under them and keep themselves legible in the
  world's own terms (the wall behind the sign darkens and each tube sits in a dark halo over a bright
  city; floating words sit in a soft dark of the water over bright caustics). More looks can join by
  adding a host (the file's header has the pattern and a few ideas).
- **Make a video** plans the lyrics together with
  the looks (Claude when it's connected, the offline planner otherwise), with a fresh seed each time,
  so two videos of the same song read differently. The chip shows what Auto chose for the part that's
  playing and why. Every style is **guarded for legibility**: every other frame Hum shrinks the
  picture under the text to 96×54 and checks it (windows and pop-ups included: it's read after they
  draw, just before the words), then picks the calmest place for the line, an ink
  that reads there and the lightest backing that clears the contrast target (none, a soft shadow, a
  feathered scrim, a halo, a full-width scrim, or a paper strip on paper looks), easing between them so nothing flickers
  when a cut changes the picture. Words that sit on a pop-up window (or a very busy picture) always
  get the **halo**: a fuzzy, feathered glow hugging the words in a palette colour that inverts
  against the ink (it becomes one flat ink under the hand-drawn finish), so an overlap looks meant. The per-look lyric profiles and the audit behind them are in
  [docs/LYRICS-AUDIT.md](docs/LYRICS-AUDIT.md).
- While a new song is being analysed, the Hum mark floats on the stage, breathing with the music.
- **Busy boards and pop-ups.** Four more instrument boards join Orbit, Lab and Oto: **Arcade** (Pong
  with the ball hitting on the beat, a runner that jumps on kicks, Tetris, a BPM odometer, a
  hi-score table of the most-sung words), **Mission** (a terminal log narrating the song — "BAR 017 · KICK .82",
  "DROP IN 4" — with radar, an XY figure, the song map and meters), **Diary** (the sung line on a
  typewriter, a word cloud of everything sung so far, the next line coming up, a mood weather
  report) and **Forecast** (a weather station for the song: sun, drizzle, a storm on the drop, the
  next parts as a forecast, a news crawl of the whole lyric sheet).
  **Pop-ups** (Look tab) are little framed windows of these instruments that pop in over whatever is
  playing on new parts, drops and some bars, then snap shut a few bars later. They're in recordings too. *In videos* (the default) shows them while a video plan
  plays, busier on choruses and drops; *Always* keeps a few coming. The video planner (Claude or
  offline) marks how busy each part's pop-ups get and can open a part with a board look for its
  first four bars. **Pop-ups keep clear of the words:** the lyric line is laid out before any window
  draws, so windows open away from it (and from where the next line will land), and one already open
  where a line arrives glides out of the way on a spring. With no room to move (small phone frames,
  lots of windows) it shrinks a little and stays, and the words over it get the halo.
  **Per part:** `useStudio.getState().setPartPops(sectionIndex, level)` sets how busy pop-ups get in
  one part (0 none: no instrument pop-ups and no scene windows; 1–3; `null` hands it back to the
  planner). The person's levels win over the plan's, apply with Pop-ups on Always too, and are kept
  per song beside the saved plans (`src/state/planCache.ts`), so they survive Remake video and
  reloads; `partPopsAt(i)` (`src/state/plan.ts`) reads a part's level and whether it was set by hand.
- **Scene windows.** Pop-ups can also be other looks: framed windows (a title bar with the look's
  name, a plain card, or a round cut-out) each playing a different look live over the picture, so
  looks combine like a desktop stacked with programs. They open on new parts and phrases, bump on
  kicks, stamp a cascade of copies on snares, huddle and tremble through a build, slam shut on the
  drop and burst back open a beat later. *Windows show* (Look tab → Video) picks Instruments, Looks
  or Both (the default); the Pop-ups switch turns all of them on or off.
- **Song colours.** A video cut from many looks still reads as one piece: every look leans toward
  the colours of the look the song uses most (choruses and drops count double), and scene windows
  wear them too. Only hue moves, so each look keeps its own lights and darks and stays readable.
  *Song colours* (Look tab → Video): *Blend* (the default) meets halfway, *Match* puts every look on
  the main look's colours, *Off* leaves them alone. See `docs/song-colours.jpg`.
- **Direction.** Every video commits to one direction, so it feels made rather than shuffled: one
  world (the looks' style family), one set of colours (Song colours), one **finish** and one way of
  moving (a transition set). Parts then change how big they feel, not what style they're in. Claude
  picks the direction with the plan; offline, Hum picks it from the main looks' world and the song's
  mood (calm acoustic songs lean to ink wash, warm cinematic ones to film, playful pop to riso, lo-fi
  and retro to tape). The plan's note says what it chose.
- **Finishes** are one surface laid over every look in the video, like shooting the whole thing on the
  same film stock. After colour it's the biggest thing that makes a video hang together. Each takes its
  paper and inks from the colours on screen, so it agrees with Song colours, and each moves with the
  music without shouting:
  - *Film*: 16mm grain that changes every frame, the picture swaying in the gate (more in gusts of
    wind), a red-orange glow round bright things, a little flicker on kicks, a soft vignette, dust,
    the odd scratch and rounded gate corners on dark looks.
  - *Riso*: a risograph print in two or three inks from the palette on off-white paper, grainy, never
    perfectly solid, each ink a little out of line, and the registration jumps on every snare.
  - *Ink wash*: sumi ink on rice paper. The look's background becomes bare paper and what it draws
    becomes soft washes that bleed along the fibres and darken at their edges; vivid parts become
    watered-down colour. A drop wets the paper and the ink spreads. Calm and spacious on purpose.
  - *Tape*: an old VHS tape: soft, colour smeared sideways and late, lines that shake on hits, a
    tracking roll sweeping down the picture on the drop, and the torn lines along the bottom.
  - *Hand-drawn*: the hand-drawn finish (below).
  - *Clean*: nothing.
  **Finish** (Look tab → Video) is *Auto* by default: each video uses its own direction's finish, and
  outside a video it's Hand-drawn when that's switched on, else Clean. Pick one to use it everywhere.
  The Hand-drawn switch (`H`) is the same control: on picks Hand-drawn, off picks Clean. A video's
  transitions lean on its set (*soft* dissolves, *film* burns and fades to black, *graphic* wipes and
  slit-scans, *organic* ink and ripples, *kinetic* cuts and pushes, *glitch* mosaics and glyphs); big
  drops still cut. Finishes go over the picture and under pop-ups, windows and lyrics, and cost under
  1 ms a frame at 1080p.
- **Text wall, particle columns, glass planes, tracking HUD.** **Text Wall** (*Redacted*,
  *Highlighter*) fills the page with the song's lyrics, knocks words out and snaps red, yellow,
  blue and cyan boxes onto them on the beat; the sung line lights up wherever it appears and drops
  flood the wall (no lyrics → title, genre, mood and section names). **Particle Columns** (*Ice*,
  *Sodium*) is a spectrum of stippled glowing dots over a haze band. **Glass Planes** (*Glasshouse*,
  *Violet Glass*) folds isometric glass strips with lime edges and hairlines: kicks extrude, snares
  streak, drops re-fold. **Tracking HUD** (*Tracking HUD*, *Surveillance*) puts red tracking boxes,
  centroids, motion arrows and live x / y readouts over a swirling body of light.
- **Paper, glyphs, a pixel cube and flip cards.** **Paper Visualizer** (*Paper Visualizer*,
  *Paper Tangerine*) stands red cut-paper bars, a curve, a waterfall of slices and a radial ring up
  off white card in soft daylight, folding from one to the next on new parts and drops, with paper
  type, a scrubber bead and dots that hop on kicks. **Glyph Mosaic** (*Glyph Mosaic*, *Glyph
  Negative*) prints dots, rings, crosses and asterisks in one ink; patches flip on kicks, the bands
  pick the glyphs, drops dissolve to the negative. **Pixel Cube** (*Pixel Cube*, *Bubblegum Cube*)
  is a 3×3 puzzle cube with pixel-art faces drawn from the music on a pastel poster: layers turn on
  the beat, it solves itself back, drops make it tumble. **Flip Cards** (*Flip Cards*, *Flip Cards
  Paper*) deals big turned words from the lyrics (else the title) onto colour cards that flip on the
  beat and skew on snares.
- **Worlds.** Places and living things that follow the song's arc. **Willow** is a woodblock willow
  lake where wind is the music and the drop blows the curtain open to let the sun in. **Night
  Windows** is a picture-book tower whose floors are frequency bands, so the facade is an equaliser
  made of people's evenings. **Signal Forest** reads a night glade as contour lines and spectral
  rings round each trunk. **Wing** is a butterfly wing in close-up whose veins carry each kick out
  to its eyespots. **Shoal** puts you inside about 2,000 fish that wind into a bait ball before a
  drop and burst on it; **Jellies** is a tank of jellyfish that pulse on the beat. **Night Train**
  is a dithered pixel-art subway car that bursts out of the tunnel on the drop. **Retro Desktop**
  types the lyrics into a notes window and crashes in a cascade of error dialogs; **Observer** is a
  wall of little windows full of eyes and skies that switches off like a CRT before the drop.
  **Orrery** turns rings of watching eyes over a sea of cloud.
- **Print.** **Bead Fire** (hot-rod flames in beadwork), **Halftone Flow** (poured paint printed as a
  grid of dots), **Confetti** (a pointillist field that falls into rings in a build and bursts on
  the drop) and **Specimen Tiles** (a sheet of tiles, each a plate resonating to one part of the song).
- **Type.** **Ribbon Type** snakes ribbons of type through a gig poster with the sung line on the
  ribbon in focus, and deals a new poster on every drop. **Word Drop** drops every sung word as a
  colour tag that falls, bounces and piles up.
- **Light, particles, forms, data.** **Prism** (light through cut crystal), **Soft Orbs** (each orb
  a voice of the mix), **Neurones** (a branching organism that grows with the song and fires root to
  tip on kicks), **Dot Assembly** (dots pack into the song's title, a few more docking on each kick),
  **Gradient Cubes** (a toy box that rolls with the beat) and **Signal Scan** (the last seconds of
  the song as a black-and-white line-scan recording).
- **Looks come in families.** The Looks list shows one card per look idea (Willow, Night Windows,
  Wing…), not every colourway of it. The little swatches on a card are its **takes**, the same idea
  in another palette or mood (Willow by day and by moonlight); click one to switch. Search finds a look
  by name, idea, take or tag. **Part** filters to looks that do that job in a song (Intro, Verse,
  Build, Drop, Break, Bridge, Outro), and with a song loaded **Playing now** follows the part under
  the playhead. **Theme** filters by what a look is of (Nature, Night city, Club, Light, Paper,
  Graphic, Type, Retro tech, Data, Photo, Boards). With a song loaded the list stays **Ranked for this
  track**; with no song it's grouped by theme. Looks you saved sit under **Yours**. The Scenes tab is
  grouped by style.
- **Takes strip** (top of the right column): the family of the look on screen, what it's best for
  ("Best for intro, verse, breakdown · drifts · quiet to lively") and every take, built-in and your
  own, one click each. **Save take** keeps what's on screen (colours, sliders, effects) as a new take
  of that family; Director looks are filed under the family of the scene they're built on.
- **Impact** (next to the timeline) sets how hard everything reacts: 0% is still, 200% is wild. Every
  look also gets a built-in hit layer: a punch on kicks, a split on snares, a hit on the drop and
  tension during build-ups.
- **Hand-drawn** (next to Impact, or `H`) runs every scene through a hand-made finish. It draws a
  new picture only 12 or 8 times a second, like hand animation (kicks, snares and drops always get
  a fresh drawing so hits land), and lines wobble between drawings. Colours print as a few flat inks
  from the palette, slightly out of line, on paper, with an optional pencil outline. Fine-tune it in
  the Look tab. Lyrics go through it too, and saved looks keep their hand-drawn settings.
- **Scenes** (left) are the raw visual engines; **Inspector** (right) has the scene's sliders, the
  **Effects** stack, **Routing** (the modulation matrix) and **Look** (palette, lyric text, frame
  aspect for 9:16 reels / 4:5 / 1:1, quality, auto-pilot, save look).
- **Drag a layer meter** from the bottom strip onto any slider to make it react to that layer. The
  blue tick on a slider shows its live, modulated value.
- **Director** (bottom of the right column, `/` to focus): a chat with history. Describe a feeling →
  a *Look*; switch to *New scene* → Claude writes a brand-new GLSL scene that's compiled live (errors
  show in the Scene tab); with a video made, *Video* changes it in plain words. A short tweak of the
  look on screen ("warmer", "less busy", "more grain") goes to the small model with a shorter catalog.
- **Render quality** (Look tab → Advanced) is the most detail Hum draws. When frames run late Hum
  eases off by itself, cheapest first: fewer pop-up scene windows, then the main picture drawn a
  little smaller, then effects at that size, then a lighter hand-drawn finish. It tries the detail
  back when there's room, and waits longer after each try that didn't hold, so it settles instead of
  flickering (`src/render/quality.ts`; the field says "easing off" while it is).
- **Thumbnails** for the built-in looks live in `src/assets/thumbs`. After changing looks, regenerate
  them from the browser console with a track playing: `await __hum.makeThumbs()`.
- **Render** (in the top bar's save group, and by the song map) makes videos without you timing a
  thing. The song map turns into a picker: drag across it to choose a stretch (it snaps to bars and
  to the parts' edges; hold ⌥ to snap to beats), drag an edge or the middle to adjust, double-click a
  part to take that whole part, or use **Best part** (the strongest 15–30 s, built around the
  biggest drop or hook) or **Whole song**. While you drag, the song pauses and the playhead and the
  stage follow the edge you're moving, like scrubbing in a video editor: the stage shows that moment's
  look, lyric line and how hard it hits (`src/state/scrub.ts`). Let go and a paused song stays on
  that moment; a playing one plays on from the start of the clip (after moving the end, from 2.5 s
  before it, so you hear the clip end). A click moves the playhead, to play from there. The row
  underneath shows **Start** and **End** to the tenth of a second (click one to see it on the stage),
  each with a button that sets it to the playhead (keys `I` and `O`, as in video editors). Tick the sizes you want (**9:16** 1080×1920 for TikTok, Reels and Shorts, **4:5** 1080×1350
  for the Instagram feed, **1:1** 1080×1080, **16:9** 1920×1080), pick 30 or 60 fps and press
  **Render**. Each size is made one after another and downloads as it's done, named like
  `pressure-0m24s-0m30s-1080x1920.mp4`; the stage shows the frames as they're made and Esc cancels.
  Nothing plays while it works and it never drops a frame, however heavy the look: Hum draws every
  frame itself from the song file, at its own pace (often faster than real time). The same stretch
  comes out exactly the same every time, and every size shows the same moments: the same cuts,
  transitions, pop-ups, windows, lyrics and Song colours that playback shows there. Afterwards the
  look, the playhead and the stage are back as they were. **Clip for TikTok** (top right) does this
  in one click: Best part at 9:16. Browsers that can't encode video themselves (no WebCodecs or AAC)
  fall back to recording the stretch live while it plays, and say so.
- **Record** captures what's on screen live, video + audio (MP4 where supported, else WebM). The
  camera icon saves a PNG. Still, Record, Render and Clip for TikTok sit together as one group in the
  top bar.
- **Full screen** from the stage itself: move the pointer over the picture (tap it on a touch screen)
  and a button fades in at its top-right corner, YouTube style, and out again when the pointer rests.
  Double-clicking the picture or `F` does the same. It's Perform: real fullscreen where the browser
  allows it, a full-window view on iPhone. In full screen, moving the mouse (or a tap) brings up a
  slim bar along the bottom that fades again after a couple of seconds, or as soon as the pointer
  leaves the window, and the cursor hides with it. On top is a seek line you can grab anywhere: it
  thickens under the pointer, the song's parts are small gaps in it and its drops dots above it, and
  hovering shows the time and the part ("Verse 2 · 0:28"). Click to jump; near a part's start or a
  drop the click snaps onto it. Drag to scrub: the song pauses and the picture follows you (as with
  the render handles, `src/state/scrub.ts`), then plays on from where you let go if it was playing.
  Under it: play / pause, the time and the part you're in, volume, the frame and exit
  (`src/ui/SeekBar.tsx`, `PerformControls` in `src/ui/Perform.tsx`). The bar is page-only, so it is
  never in recordings or renders. In full screen `←/→` move 5 s and `⇧←/⇧→` jump to the previous /
  next part (back goes to the start of the part you're in first, like a music player).
- Keys: `space` play/pause · `←/→` previous/next look (in full screen: back / forward 5 s, with `⇧` by part) · `[` / `]` previous/next look (anywhere) · `K` keep · `X` skip · `R` shuffle · `H` hand-drawn · `B` breakdown · `F` full screen (perform mode) · `I` / `O` set the render's start / end to the playhead (render row open) · `esc` exit.

## How it's built

```
audio file / mic
  → AudioEngine (src/audio/engine.ts)      real-time: 6 bands, onset envelopes, beat phase, energy, build, drop
  → analyzeTrack (src/audio/analysis*.ts)  offline worker: bpm, sections (harmony/timbre self-similarity,
                                           bar-aligned, repeats grouped), drops, mood, tags, preset ranking
  → harmony (src/audio/harmony.ts)         in the same worker: chroma, chords, key, key changes, tension
  → lyrics (src/audio/tags.ts, lyrics.ts)    file tags / name → embedded LRC or LRCLIB timed lines
  → video plan (src/state/plan.ts)         a look per section; switches looks along the song
  → taste memory (src/state/taste.ts)      Keep / Skip and hand picks, in context; biases every pick
AudioFrame + analysis → Feel (src/core/feel.ts)       the song's emotional state and a shared world, the same for every look
AudioFrame → modulation matrix (src/state/modulation.ts) → resolved params
  → SceneInstance.render → render target   (src/scenes/{board,three,shader,photo,nature,worlds,print,type})
  → FxChain (src/render/fxChain.ts)        stackable GLSL passes (src/fx/defs)
  → transition (src/render/transitions.ts) blends the outgoing look (still playing) into the new one;
                                           picked by src/state/transitionPick.ts
  → impact, finish (src/render/finishPass.ts, picked by the video's Direction: src/core/direction.ts,
    src/state/direction.ts), then pop-ups and lyrics; or hand-drawn over all of it (handPass.ts)
  → scene windows (src/render/sceneWindows.ts)  other looks, each rendered at its window's size, framed over the picture
  → screen / MediaRecorder
```

**Rendering a video** (`src/render/timeline.ts`) runs the same chain without the speakers or the
clock. A second, hidden stage draws each frame at a fixed frame rate. Its sound comes from
`OfflineAudioFrames` (`src/audio/offlineFrames.ts`): the decoded song, a Blackman window over the last
4096 samples and an FFT that matches the browser's AnalyserNode to a thousandth of a dB, fed to its
own copy of the engine's listening code (`src/audio/frameDsp.ts`, which the live engine uses too), at
60 steps a second. The beat grid is set from the song's tempo and kicks, so the beat count depends
only on where in the song you are. During each frame `performance.now`, `Date.now` and
`Math.random` are swapped for the render's clock and per-frame seeded dice (re-seeded for the scene,
windows, pop-ups and lyrics, so sizes don't drift apart), and the plan's sequencer talks to the hidden
stage. Each video starts drawing 3 s early (frames thrown away) and listening 12 s early, so Feel,
flocks, wind, windows and the levels have settled. Frames go to WebCodecs' H.264 encoder (High
profile, level picked from the size, about 18 Mbps at 1080p30, a keyframe every 2 s) and the song's
slice to its AAC encoder (48 kHz stereo, 40 ms fade in, 350 ms fade out); `src/render/mp4.ts` writes
the MP4 (moov first, so it plays while it downloads, and an edit list that skips the AAC encoder's
start-up delay, measured once per session, so sound and picture line up to the sample).

- `src/core/` — the contracts (`types.ts`), the shared GLSL header + function library (`glsl.ts`),
  and helpers to define scenes (`defineShaderScene`, `defineCanvasScene`, `defineThreeScene`).
- **Feel** (`src/core/feel.ts`, `frame.feel`, `uFeel*` in shaders) is what keeps looks in agreement.
  The audio layers say what is sounding now; Feel says what it means: `intensity` (how big this
  part is), `tension` (winding up, including the last seconds before a drop the analysis already
  knows is coming, so a look can wind up before the hit), `release` (the afterglow of a drop) and
  `warmth`. It also carries a small shared world: wind direction, gusts and a time of day that runs
  from dawn to dusk over the song. Looks with wind, weather or a light source read them from there,
  so a cut between looks keeps the same weather and light.
- **Harmony** (`src/audio/harmony.ts`, `analysis.harmony`) is music theory worked out on the device,
  no AI. Eight times a second a 4096-point spectrum is folded onto the 12 notes (spectral peaks only,
  placed by their exact frequency after the song's tuning is measured, so a track a little sharp or
  flat still reads right), with a separate low-end chroma for the bass note. Averaged per beat, each
  beat gets the major or minor chord that fits best, smoothed so chords don't flicker (changing chord
  costs less on a bar line); each change is then placed from the 8 Hz frames and landed on the nearest
  beat or half-beat. The key (song and per section, with a confidence) comes from key profiles over
  the chords' notes, which chords belong to it, how much time sits on its home chord and V → I moves;
  the relative major and minor share every note, so the song's first and last chords decide between
  them. A section that clearly moves to another key is a key change, and up a half or whole step it
  is a *lift* (`sections[i].lift`). Tension per beat is how far the chord is from home (I 0, IV 0.35,
  V 0.75, outside the key 0.65) plus dissonance; resolutions are V → I, IV → I, bVII → I or tension
  falling onto home. Sections whose chords repeat an earlier part with the same name (even
  transposed) join its group (`repeatOf`, `transpose`). Feel reads it: harmonic tension adds a little
  to `tension` (`feel.harmony`), a resolution gives a soft `release`, a major key is a touch warmer
  and a minor one cooler, and a lift brightens `warmth` (`feel.lift`). The song summary the director
  reads ends with one line, e.g. *Harmony: A minor; chords change about every bar; lifts up a whole
  step at 2:41.* The same spectra feed the section finder, so analysis got about 20% faster, not
  slower. Major and minor triads only (a G7 reads as G); busy, distorted mixes get chord qualities
  wrong more often than the key.
- **Styles** (`src/core/styles.ts`): every scene names one (`world`, `light`, `particles`,
  `form`, `print`, `type`, `data`, `photo`, `board`). The Scenes tab groups by them, and the video
  planner leans towards keeping a part's shots inside one style.
- **Look families and fit** (`src/presets/families.ts`, `src/presets/fit.ts`). A family is one look
  idea; its takes are the presets that are that idea in another palette or setting. Ids never change:
  the family table groups existing preset ids, so saved plans, taste memory and custom looks keep
  working. Each family carries hand-judged **fit**: the song parts it serves best (`roles`, best
  first), the energy range it feels right at, how it moves (`still`, `drifting`, `pulsing`,
  `explosive`), its themes, and the families it **pairs** with or **clashes** with. A take shifts its
  family's energy range a little by its own tags. `fitScore(look, part, energy)` and
  `neighbourScore(a, b)` are what the planner uses: picking a look for each part
  (`tastefulRoles`), the rotation inside a part (`relatedLooks`, judged at that part's own energy),
  the drop look and the board interlude all score by fit, and takes of one family count as the
  same look. Two takes never sit side by side or rotate together, because with Song colours on they
  look almost alike. The Director gets one line per family with its fit, pairs, clashes and takes
  (`compactLooks` in `server/planPrompt.ts`; the format is explained once in the cached system
  prompt), and the shortlist sends 30 families with up to 3 takes each (`src/director/shortlist.ts`).
  At 300 looks that's 37% fewer characters than one line per look.
- **Shared engines for scenes:** `tnoise` / `tfbm` read a shared noise texture (several times cheaper
  than computed noise; `src/core/noise.ts`), and `Flock` (`src/core/flock.ts`) steers a few thousand
  bodies for anything made of a crowd.
- **Song palette** (`src/core/songPalette.ts`): `harmonize(look, key, strength)` rotates a palette's
  hues onto a key palette's in OKLCH, keeping lightness exactly. Colours far round the wheel commit
  to the key's hue rather than stopping halfway in mud; greys take a breath of the key's ground. The
  plan applies it as looks come on screen (`songTinted` in `src/state/plan.ts`).
- **Adding a scene:** write a `SceneDef` with params and a `style`, and drop it in one of the
  `src/scenes/*/index.ts` arrays. A shader scene is only a `void main()` — see
  `src/scenes/shader/guide.ts` (this is also the guide the AI reads).
- **Seeing a scene while you build it:** `/solo.html` (dev only; `src/dev/solo.ts`) plays one scene
  against a scripted 64-second test song (`src/dev/testSong.ts`: intro, verse, build, a drop at
  0:32, break, outro) with no audio to load. With `npm run dev` running
  (and `npm i -D playwright-core` done once, which drives your installed Chrome),
  `node scripts/look-shot.mjs --preset willow-print --out sheet.png` renders a contact sheet of the
  song's key moments in a headless browser and prints shader errors and the frame cost
  (`--scene <id>`, `--mod <file>` for a scene not registered yet, `--portrait`, `--at 16,32.1`).
  `/solo.html?finish=clean,film,riso,ink,tape,hand` (or `"finish"` in the `--look` JSON) shows each
  finish side by side for every moment and reports what each finish pass costs.
  `&windows=1&popups=1&pops=3` puts scene windows and instrument pop-ups over it (seeded, so sheets
  repeat; `&dodge=0` stops them keeping clear of the words, to look at the halo, and each cell's label
  names the lyric backing). Add `&lyrics=auto` (or `subtitle`, `big`, `cutout`) to the solo page, or a `lyrics` entry in the
  `--look` json, to draw lyric type over the look: test lyrics are sung in every part (with held
  notes), and `{ "lyrics": { "style": "auto", "family": "serif", "motion": "tender", "parts":
  ["sparse", "subtitle", "sparse", "big+giant", "sparse", "subtitle"] } }` fixes the plan per part so
  sheets compare shot for shot.
- **Smooth frames:** the quality governor (`src/render/quality.ts`) watches frame times from the
  stage's own loop and steps detail down and back up (see Render quality above). Anything that renders
  frame by frame for export must call `quality.freeze(true)` first (and `freeze(false)` after) so
  every frame gets full detail; the stage also ignores the governor while `setOutputSize` pins an
  output size. `quality.force(n)` pins a rung to look at it. Shaders for the song map's next look,
  its effects and the next pop-up window compile in the background ahead of the cut
  (`src/render/warmup.ts`, `renderer.compileAsync` with KHR_parallel_shader_compile), so cuts don't
  stall on a compile. Dev console: `await __hum.perf.moments()`, `__hum.perf.rungs()`,
  `__hum.perf.hitch(ids, 'async')` time frames at 1080p (`src/dev/perfProbe.ts`).
- **Adding an effect:** an `EffectDef` with a fragment shader in `src/fx/defs/`.
- **Adding a look:** an entry in `src/presets/library.ts`. Tags matter: the analyser matches on them,
  and they're what fit is guessed from when a look has none. Then file it:
  - *a new take of an existing family*: add its id to that family's `takes` in
    `src/presets/families.ts` with a short name (the first take is the one cards lead with), or put
    `family: '<family id>', variant: '<take name>'` on the preset itself;
  - *a new idea*: add a family entry to `FAMILY_TABLE` with `roles`, `energy`, `motion`, `themes` and
    any `pairs` / `clashes` (a one-take family can be keyed by the look's own id);
  - *nothing*: the look shows as a family of its own with fit inferred from its tags and style. That
    works, but hand-judged fit plans better. A preset can also carry a partial `fit` to correct only
    what the guess gets wrong.
  In dev the console warns about family entries that name looks or families that don't exist.

Colour management is off on purpose: palette hex values go into shaders untouched.

## Deploying (e.g. on your site)

It's a static Vite app plus one serverless function (`api/director.ts`, Web-standard `POST`).
On Vercel: import the folder and set `ANTHROPIC_API_KEY`. Without a key the site still works with the
offline director.

Limits (all in `server/limits.ts`, every one optional):

| Setting | What it does | Default |
|---|---|---|
| `HUM_ACCESS_CODES` | One code per person: `sam=river-42, jo=blue-moon`. Delete an entry to cut that person off. Counts and logs use the name, never the code. | off (open) |
| `HUM_ACCESS_CODE` | One shared code (counted as "shared") | off |
| `HUM_DAILY_BUDGET` | Dollars per day for everyone together | 5 |
| `HUM_CODE_DAILY_BUDGET` | Dollars per day per code | 1 |
| `HUM_RATE_LIMIT` | Requests per visitor (IP) per hour | 20 |
| `HUM_TIMEZONE` | When the day resets (e.g. `America/Los_Angeles`) | UTC |
| `UPSTASH_REDIS_REST_URL` + `_TOKEN` (or `KV_REST_API_URL` + `_TOKEN`) | Keeps the counts in Upstash Redis so they hold across every Vercel instance | memory |

Spend is counted from each response's real token usage at the model's price. A request is refused
once today's total has reached the cap, so a cap can go over by at most the calls already running
(about $0.03 each for Make a video). Refused requests fall back to the offline director. If Redis
can't be reached, the counts drop to memory for that request instead of failing. Each call is logged
as `[hum-director] plan on claude-sonnet-5-5 for sam: $0.0213 (today $0.53) · …tokens…` in the
function logs. Your Claude
subscription in `npm run dev` skips the limits and the access codes (it only answers your own computer).

In the app, an AI action that comes back needing a code opens a small box (`src/ui/AccessGate.tsx`,
logic in `src/director/access.ts`): the code is checked with the free `mode: "check"` request (no
Claude call, same rule as a real request), saved, and the action retries. Closing it keeps the offline
result. On a site with no key the box explains how to run Hum yourself instead.

What each action costs (a 12-part song with lyrics; "warm" = the fixed rules were read from the
prompt cache because someone asked within the last 5 minutes):

| Action | Model | Tokens in / out | Cost |
|---|---|---|---|
| Make a video | Sonnet 5.5 | ~9,400 (4,200 cacheable) / ~1,050 | ≈ $0.031 cold, $0.021 warm |
| Make a video again on the same song | — | none (saved in the browser) | $0 |
| Change the video in words (*Video* mode) | Haiku 5.5 | ~4,200 (3,500 cacheable) / ~900 | ≈ $0.001 |
| Describe a feeling → look | Sonnet 5.5 | ~14,400 (13,000 cacheable) / ~800 | ≈ $0.044 cold, $0.011 warm |
| Tweak the look on screen ("warmer") | Haiku 5.5 | ≤ 14,400 / ~800 | ≈ $0.002 |
| A new GLSL scene | Sonnet 5.5 | ~7,000 (mostly cacheable) / up to 16,000 | ≈ $0.05–0.10 |

Which model does what (all optional, `server/models.ts`):

| Setting | Used for | Default |
|---|---|---|
| `HUM_MODEL` | everything below unless set | `claude-sonnet-5-5` |
| `HUM_PLAN_MODEL` | Make a video | `HUM_MODEL` |
| `HUM_SHADER_MODEL` | New scene | `HUM_MODEL` |
| `HUM_EDIT_MODEL` | small edits: changing a video in words, tweaking the look on screen (`main` = use `HUM_MODEL`) | `claude-haiku-5-5` |
| `HUM_CLI_MODEL` / `HUM_CLI_EDIT_MODEL` | the same split for your subscription in `npm run dev` | `sonnet` / `haiku` |

`HUM_MODEL=claude-haiku-5-5` makes everything about 20× cheaper, at some cost to the plans. Each
call is logged with its tokens (`… · 5236 in, 4170 from cache, 0 into cache, 1045 out`). Also set a
monthly spend limit for the key in the Anthropic Console as the hard backstop.
