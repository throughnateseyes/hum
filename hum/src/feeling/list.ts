/** What a sung line can feel like, by id (nothing else from the app in here, so the server's prompt reads the same list) */
export const EMOTION_IDS = ['sad', 'longing', 'tender', 'hopeful', 'joyful', 'desire', 'defiant', 'angry', 'afraid', 'numb', 'playful', 'calm'] as const;
export type Emotion = (typeof EMOTION_IDS)[number];
export const isEmotion = (v: unknown): v is Emotion => typeof v === 'string' && (EMOTION_IDS as readonly string[]).includes(v);
