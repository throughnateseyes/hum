/** Opens the Lyrics panel from elsewhere (the song menu, the Video tab), on the view that swaps the lyrics. */
import { create } from 'zustand';

export type LyricsMode = 'main' | 'change' | 'edit';

export const useLyricsOpen = create<{ open: boolean; mode: LyricsMode }>(() => ({ open: false, mode: 'main' }));

export const openLyrics = (mode: LyricsMode = 'main') => useLyricsOpen.setState({ open: true, mode });
export const changeLyrics = () => openLyrics('change');
export const closeLyrics = () => useLyricsOpen.setState({ open: false, mode: 'main' });
