# Hum: sound → sight

**Hum turns a song into a music video, live in your browser.** Drop in a track and Hum takes it apart: the kick, snare and hats, the bass and melody notes, the vocals, the build-ups and the drops. It reads what kind of song it is and the mood it's going for, finds the lyrics, and then plays one of nearly 50 hand-built visual "looks" that react to every hit. Press **Make a video** and it cuts between looks along the song, with faster cuts in busy parts and a hard cut on every big drop. Then record the result.

![A grid of Hum looks: paper bars, an arcade board, a glyph mosaic, a tracking HUD, a pixel cube, a lyric text wall, a photo board, particle columns, flip cards, glass planes, a lyric zine, halftone bars, a particle swarm, a mission-control board, a kaleidoscope and violet glass](hum/docs/looks.jpg)

It's for musicians, editors and anyone who wants visuals for a track (reels, lyric videos, live backdrops) without making them frame by frame, and for people who want to play with how sound can show feeling.

## What it does

- **Takes the song apart.** Tempo, sections (intro, verse, chorus, build, drop, outro), drops rated by how big they are, drum hits, bass and lead notes, vocals, genre, instruments and mood. The **Breakdown** view (`B`) shows all of it on a timeline.
- **Looks that react.** Instrument boards, 3D forms, shader fields, photo treatments, paper cut-outs, particle fields, lyric walls and more. Every look reacts to the music. You can drag any audio layer onto any slider to make it react to that layer too.
- **Lyrics, found and timed.** Lyrics come from the file's tags or from [LRCLIB](https://lrclib.net), a free lyrics library. You can also search LRCLIB or paste lyrics yourself; Hum then times each line by listening to the song on your computer. The lyric style follows the song's mood: soft fades, blur-ins, words that slam in, or a newspaper-cutout ransom note.
- **Make a video.** Hum plans a look for every part of the song (with Claude, or offline) and cuts between them on musical phrases. The **Pace** setting makes it cut slower or faster.
- **Finishes.** A hand-drawn mode, an effect stack (dither, halftone, ASCII, grain…), an Impact knob, pop-up instrument windows, and 9:16 / 4:5 / 1:1 frames for reels.
- **Record.** Save video with sound (MP4 or WebM) or a still PNG.
- **An AI director.** Describe a feeling and get a look, or a brand-new GLSL scene written and compiled live.

## Run it

You need [Node.js](https://nodejs.org) 22 or newer.

```bash
git clone https://github.com/throughnateseyes/hum.git
cd hum/hum
npm install
npm run dev
```

Open http://localhost:5173 and drop a song onto the page, or pick one of the two built-in demo tracks.

### The AI director (optional)

Everything works without AI: the video planner and director have offline fallbacks. To plan videos and write looks with Claude, do one of these:

- **Claude Code installed and signed in:** in `npm run dev`, Hum uses the `claude` command on your own computer, so there's no key to manage. It only answers requests from that computer.
- **An Anthropic API key:** copy `hum/.env.example` to `hum/.env.local` and set `ANTHROPIC_API_KEY`. The key stays on the server and is never sent to the browser. `.env*` files are ignored by git.

More detail is in [hum/docs/DIRECTOR.md](hum/docs/DIRECTOR.md).

## Privacy

- Your audio never leaves your computer. Analysis and lyric timing run in the browser.
- Lyric lookup sends only the song's title, artist and length to LRCLIB.
- The AI director sends a text description of the song (its sections, mood and tags, and lyrics when there are any) to Claude, and nothing else.

## Hosting it

Hum is a static Vite app plus one serverless function (`hum/api/director.ts`) for the AI director. On Vercel, import the `hum` folder and set `ANTHROPIC_API_KEY`. These settings keep the bill small:

- `HUM_ACCESS_CODES` gives each person their own code, like `sam=river-42, jo=blue-moon`. Remove someone's entry to cut them off. (`HUM_ACCESS_CODE` still works as one shared code.)
- `HUM_DAILY_BUDGET` is the most the AI may spend per day for everyone together, in dollars (default 5). `HUM_CODE_DAILY_BUDGET` is the most per code per day (default 1). Spending is counted from what each Claude call actually used.
- `HUM_RATE_LIMIT` caps requests per visitor per hour (default 20).
- Add Upstash Redis (free tier, through Vercel's Marketplace) so these counts are shared by every server instance. Without it, each instance counts on its own and the limits are only approximate.

A Make a video costs about $0.04 on the default model. When a limit is hit, the offline director takes over, so the site keeps working. Also set a monthly spend limit on the API key in the Anthropic Console as a hard backstop.

Without a key, the hosted site still works with the offline director.

## The full guide

[hum/README.md](hum/README.md) explains every feature, the keyboard shortcuts, how the app is built, and how to add your own scenes, effects and looks.
