/** Opens the Lyrics panel from elsewhere (the song menu, the Video tab), on the view that swaps the lyrics. */
import { create } from 'zustand';
import { openPanel, useLayout } from './layout';

export type LyricsMode = 'main' | 'change' | 'edit';

export const useLyricsOpen = create<{ open: boolean; mode: LyricsMode }>(() => ({ open: false, mode: 'main' }));

export function openLyrics(mode: LyricsMode = 'main') {
  useLyricsOpen.setState({ open: true, mode });
  // on the phone it is a panel of the sheet
  if (useLayout.getState().phone) openPanel('lyrics', 'full');
}
export const changeLyrics = () => openLyrics('change');
export const closeLyrics = () => useLyricsOpen.setState({ open: false, mode: 'main' });
