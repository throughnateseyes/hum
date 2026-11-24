# Hum: sound → feeling → space

**Hum is an experiment in how texture can carry the feeling of a song.**

Drop in a track and Hum dissects it. It pulls apart the kick, snare and hats, the bass and the melody, and the voice. It maps how the song is built: where it waits, where it climbs, where it drops and where it breathes. Underneath that it reads the emotion: how much tension is building, when it releases, how warm or cold the song is, and how big each moment feels.

Then it turns all of that from audio into a space you can see. Concrete facades shift with the rhythm, and brutalist blocks strain into cantilevers through the build before slamming into a new shape on the drop. Fountains wait through the build, then fire all at once. Falling code freezes mid-air, an avenue of gold leaves lifts in a storm, ink prints onto paper, and gardens grow with the song. Each look is a study of one texture and how it might move if it could hear.

![A grid of Hum looks: tumbling cubes, a neon branching organism and its botanical twin, a woodblock willow lake, butterfly wings, halftone flows, a heart of beads, a tower of lit rooms, scattered lyric words, a glass room, jellyfish, a shoal of fish, an orrery above the clouds and a night train](hum/docs/new-looks.jpg)

It's a studio for experimenting rather than a video template. You can make music videos with it, and render what you see, but the real question it asks is: what does this song feel like, and what is that feeling made of?

## What it does

- **Dissects the song.** Tempo, sections (intro, verse, chorus, build, drop, outro), drops rated by how big they are, drum hits, bass and lead notes, harmony and key changes, vocals, genre, instruments and mood. The **Breakdown** view (`B`) shows all of it on a timeline.
- **Finds the feeling.** Hum turns that analysis into one emotional state every look shares: how intense the moment is, the tension winding up before a drop, the afterglow when it lands, and how warm it is. It also tracks a shared wind and a time of day that runs from dawn to dusk across the song, so a cut from one look to the next keeps the same weather and light.
- **Textures that listen.** Nearly 100 hand-built looks: 3D places (concrete, water, gardens, night cities), shader fields, ink and print, paper cut-outs, particles, type and photo treatments. Each one is designed around its quiet parts, its build-up and its drop, not only the beat. Looks come in families of variations, and you can drag any audio layer onto any slider to make it react to that layer too.
- **Lyrics, found and timed.** Lyrics come from the file's tags or from [LRCLIB](https://lrclib.net), a free lyrics library. You can also search LRCLIB or paste lyrics yourself; Hum then times each line by listening to the song on your computer. The lyric style follows the song's mood: soft fades, blur-ins, words that slam in, or a newspaper-cutout ransom note.
- **Make a video.** Hum plans a look for every part of the song (with Claude, or offline) and cuts between them on musical phrases. The **Pace** setting makes it cut slower or faster.
- **Edit it shot by shot.** The timeline shows one block per shot under the song's sections. Click to pick a shot (⌘/Ctrl-click or Shift-click for more), right-click for a menu, split with `C`, combine with `⌘/Ctrl+J`, and zoom in to work closely. The right panel has three tabs: **Video** for the whole video, **Part** for the picked shot (its look, five quick picks on `1`–`5`, hand-drawn, pop-ups, lyrics and fine-tuning) and **Render**. `X` skips the shot playing and `K` likes it, in full screen too.
- **Nothing to save.** Every change is kept as you make it, `⌘/Ctrl+Z` and `⇧⌘Z` undo and redo all of it, and the song, your clips and your video come back after a reload.
- **Your own footage.** Drop in video clips and the footage looks cut them on the beat in the song's colours, with graphics in six styles you can pick and shuffle. **Inside** goes further: Hum reads how deep each clip is, on your computer, and stands the lyrics and shapes in the place itself, so people and cars pass in front of them.
- **Finishes.** A hand-drawn mode, an effect stack (dither, halftone, ASCII, grain…), an Impact knob, pop-up instrument windows, Knockout lyrics (one huge word at a time), and 9:16 / 4:5 / 1:1 frames for reels.
- **Save it.** Render any stretch to MP4 with sound, at any size, make a clip for socials in one click, or save a still PNG.
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
- The last song, your video clips, your photos and the video you made are kept in the browser's own storage on your computer, so a reload brings them back. Loading another song replaces the saved one, and removing a clip forgets it.
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

Visitors without a code can use everything except the AI. When they press an AI action (Make a video, describe a feeling, a new scene), Hum asks for a code and then carries on with that action. The same box links to this repo and explains how to run Hum on their own computer with their own Claude sign-in. If the site has no key at all, the box just says AI is off here. The server is the real check: codes and limits are enforced in `hum/server/`, never in the browser. The welcome screen asks for the code too, under the demos. A saved code can be changed or forgotten under Video → More.

## The full guide

[hum/README.md](hum/README.md) explains every feature, the keyboard shortcuts, how the app is built, and how to add your own scenes, effects and looks.
