/**
 * The colours a whole video is painted in, picked by hand. One set lasts the video: the fields are what
 * parts of the picture turn into on the beat, in order, and the word colours always read on the field
 * they are paired with.
 */
export interface InsidePalette {
  id: string;
  name: string;
  ink: string;
  paper: string;
  /** each step: the flat field, the lighter tone its bright parts take, and the word's colour on it */
  steps: { field: string; light: string; word: string }[];
  /** colours for ribbons, posts and streaks */
  accents: string[];
}

const set = (id: string, name: string, ink: string, paper: string, steps: [string, string, string][], accents: string[]): InsidePalette => ({ id, name, ink, paper, steps: steps.map(([field, light, word]) => ({ field, light, word })), accents });

export const INSIDE_PALETTES: InsidePalette[] = [
  set('poster', 'Poster', '#0f141c', '#fff3dc', [['#ffae5c', '#ffe0b4', '#2446ff'], ['#2446ff', '#86b0ff', '#fff3dc'], ['#a6ecf0', '#e6fbf6', '#ff4a2b'], ['#ffd94a', '#fff2b4', '#ff4a2b'], ['#ff4a2b', '#ff9c5c', '#fff3dc']], ['#ff4a2b', '#fff3dc', '#ffd94a', '#2446ff', '#a6ecf0']),
  set('citrus', 'Citrus', '#10180f', '#fbfbe9', [['#d7f205', '#f0ff9c', '#10180f'], ['#ff5a1f', '#ffa270', '#fbfbe9'], ['#0fa968', '#7fe0b0', '#fbfbe9'], ['#ffe14d', '#fff4ae', '#ff5a1f']], ['#ff5a1f', '#d7f205', '#fbfbe9', '#0fa968']),
  set('blossom', 'Blossom', '#1d0f1c', '#fff4f2', [['#ff9fc0', '#ffd7e2', '#c8102e'], ['#c8102e', '#f2707f', '#fff4f2'], ['#b9e3ff', '#e8f6ff', '#ff3d7f'], ['#ffd2a8', '#ffeeda', '#c8102e']], ['#c8102e', '#fff4f2', '#ff9fc0', '#7cc5ff']),
  set('night', 'Night drive', '#06070d', '#f4f1ff', [['#1b1464', '#5a48d6', '#ff5ad1'], ['#ff2e88', '#ff8bbd', '#f4f1ff'], ['#06b6c9', '#8ff1f5', '#06070d'], ['#5b1fd1', '#a87cff', '#e9ff4f']], ['#ff2e88', '#22e1f0', '#e9ff4f', '#f4f1ff']),
  set('rust', 'Rust and sky', '#1a100b', '#f6ead8', [['#d9532c', '#f0a071', '#f6ead8'], ['#8fc7d9', '#d6eef2', '#1a100b'], ['#efb23a', '#f9dd97', '#8c2413'], ['#274b63', '#6d9cb5', '#f6ead8']], ['#d9532c', '#f6ead8', '#8fc7d9', '#efb23a']),
  set('signal', 'Signal', '#0b0b0b', '#f6f6f2', [['#ff3217', '#ff8a70', '#0b0b0b'], ['#f6f6f2', '#ffffff', '#ff3217'], ['#0b0b0b', '#3a3a3a', '#ff3217'], ['#cfcfc6', '#eeeee8', '#0b0b0b']], ['#ff3217', '#f6f6f2', '#0b0b0b']),
  set('lagoon', 'Lagoon', '#04202a', '#f1fbf6', [['#19c3b2', '#92eee0', '#04202a'], ['#0556d6', '#69a5ff', '#f1fbf6'], ['#fff07a', '#fffac9', '#0556d6'], ['#ff7a66', '#ffc0b1', '#f1fbf6']], ['#ff7a66', '#fff07a', '#f1fbf6', '#19c3b2', '#0556d6']),
  set('dusk', 'Dusk', '#150c24', '#ffefe0', [['#7a5cff', '#bcaaff', '#ffefe0'], ['#ff8f5a', '#ffcba8', '#3a1180'], ['#f2c4de', '#fbe6f1', '#7a2bd0'], ['#2d1a78', '#7a63dd', '#ffb27a']], ['#ff8f5a', '#ffefe0', '#7a5cff', '#f25fa0']),
  set('bone', 'Bone and blue', '#0b1526', '#f3efe4', [['#f3efe4', '#ffffff', '#1438c8'], ['#1438c8', '#6f8cf0', '#f3efe4'], ['#c9d8e6', '#eef4f9', '#0b1526'], ['#0b1526', '#33496e', '#9fc0ff']], ['#1438c8', '#f3efe4', '#9fc0ff']),
  set('moss', 'Moss', '#0e1a12', '#f4f5e6', [['#3f7d3a', '#9bc48a', '#f4f5e6'], ['#e8d25a', '#f6ecae', '#22421f'], ['#f2a7a0', '#fbd9d4', '#7a1f1a'], ['#bfe0c8', '#e6f4e9', '#1f5a33']], ['#e8d25a', '#f4f5e6', '#f2735f', '#3f7d3a']),
];

/** what each set is like, for the director */
export const PALETTE_LINES: Record<string, string> = {
  poster: 'orange, cobalt, red, yellow and ice blue, loud and warm like a screen print',
  citrus: 'acid green, orange and leaf green, fresh and restless',
  blossom: 'pink, deep red and baby blue, romantic and bright',
  night: 'violet, hot pink, cyan and acid yellow, a city after dark',
  rust: 'brick, dusty sky blue and ochre, road trip, nostalgic',
  signal: 'red, black and white only, severe, hard, urgent',
  lagoon: 'turquoise, blue, lemon and coral, open air and water',
  dusk: 'violet, apricot and pale pink, tender, dreamy',
  bone: 'off white, deep blue and pale grey blue, restrained and cold',
  moss: 'leaf green, straw and dusty rose, calm, outdoors, handmade',
};

export const insidePalette = (id: string | undefined, seed: number): InsidePalette => INSIDE_PALETTES.find((p) => p.id === id) ?? INSIDE_PALETTES[Math.abs(Math.floor(seed)) % INSIDE_PALETTES.length];
