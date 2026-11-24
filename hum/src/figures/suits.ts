/**
 * Which drawing style an idea suits: line figures are for built things (a radio, a car, a stair), pen
 * drawings for living and loose ones (rain, petals, a hand). A plain word match on the object, with the
 * brief as a tie-break; 0 is surely a pen drawing, 1 surely a line figure.
 */
export interface FigureBrief {
  object: string;
  brief?: string;
  mood?: string;
  section?: string;
}

const BUILT =
  'radio boombox stereo speaker amp amplifier turntable record vinyl cassette tape deck walkman piano keyboard synth synthesizer sampler drum drums guitar microphone mic telephone phone payphone booth television tv monitor computer laptop console arcade camera projector lamp lantern lighthouse streetlight clock watch metronome typewriter sewing machine car van truck bus taxi train tram subway carriage bicycle bike motorcycle scooter boat ship ferry plane airplane rocket satellite elevator escalator stairs staircase stair ladder bridge tower skyscraper building block house home cabin motel hotel diner shop store kiosk cinema theatre theater station garage church window door doorway room bed sofa couch chair armchair table desk shelf bookshelf cabinet drawer fridge oven stove kettle toaster cup mug bottle glass box crate suitcase luggage trunk chest safe key lock mailbox letterbox billboard sign vending machine jukebox slot pinball dice chess cards robot crane factory pylon antenna aerial dish road street city town skyline pool swimming fountain bench swing carousel ferris wheel fairground tent ladder rooftop balcony fire escape pier dock traffic light gas pump petrol engine gear'.split(' ');
const LIVING =
  'rain raindrop snow snowflake petal petals flower flowers rose tulip daisy tree trees leaf leaves branch forest grass vine fern mushroom bird birds crow swallow dove moth butterfly bee fish whale cat dog horse wolf deer fox snake animal hand hands face eye eyes lips heart body hair person people girl boy woman man dancer angel ghost skeleton skull cloud clouds sky sun moon star stars wave waves sea ocean river water smoke fire flame flames wind storm lightning shadow feather wing wings fruit apple cherry lemon mountain hill hills ribbon veil curtain tears tear'.split(' ');

const has = (text: string, list: string[]) => {
  const words = text.toLowerCase().replace(/[^\p{L} ]/gu, ' ').split(/\s+/).filter(Boolean);
  const bare = words.map((w) => (w.length > 3 && w.endsWith('s') ? w.slice(0, -1) : w));
  return list.filter((x) => words.includes(x) || bare.includes(x)).length;
};

export function figureScore(b: FigureBrief): number {
  const built = has(b.object, BUILT);
  const living = has(b.object, LIVING);
  if (!!built !== !!living) return built ? 0.9 : 0.1;
  if (built) {
    // "a car in the rain": the thing named first is the subject
    const at = (list: string[]) => b.object.toLowerCase().split(/[^\p{L}]+/u).findIndex((w) => list.includes(w) || list.includes(w.replace(/s$/, '')));
    const a = at(BUILT);
    const z = at(LIVING);
    return a >= 0 && (z < 0 || a < z) ? 0.7 : 0.3;
  }
  const text = `${b.brief ?? ''}`;
  const lean = has(text, BUILT) - has(text, LIVING);
  return lean > 0 ? 0.6 : lean < 0 ? 0.25 : 0.4;
}

export const suitsFigure = (b: FigureBrief): boolean => figureScore(b) >= 0.5;
