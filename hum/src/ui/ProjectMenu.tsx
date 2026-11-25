/**
 * The project: its name, whether it is saved, and everything that opens or keeps one. Sits in the top bar.
 * What saving means is src/project/project.ts.
 */
import { useEffect, useRef, useState } from 'react';
import { useStudio } from '../state/store';
import { canKeepFolders, forgetRecent, recents, type Recent } from '../project/places';
import { closeAsk, guarded, hasWork, keepDisk, keepHere, openFile, openFolder, openRecent, openVersion, reconnect, rename, save, saveFile, saveInFolder, shownName, startNew, unsaved, useProject, versions, type ProjectState, type Version } from '../project/project';
import { Chevron, Film, Folder, Plus, Save, Upload } from './Icons';
import './project.css';

const when = (t: number) => {
  const d = new Date(t);
  const day = (x: Date) => new Date(x.getFullYear(), x.getMonth(), x.getDate()).getTime();
  const ago = Math.round((day(new Date()) - day(d)) / 86400e3);
  const time = d.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });
  return ago === 0 ? `Today, ${time}` : ago === 1 ? `Yesterday, ${time}` : `${d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' })}, ${time}`;
};

/** one or two words for the pill */
function word(p: ProjectState, work: boolean): string {
  if (p.busy) return `${Math.round(p.busy.frac * 100)}%`;
  if (!work && !p.place) return '';
  if (p.status === 'saving') return 'Saving…';
  if (p.status === 'saved') return 'Saved';
  if (p.status === 'locked') return 'Reconnect';
  if (p.status === 'newer') return 'Which one?';
  if (p.status === 'error') return 'Not saved';
  return p.status === 'dirty' && p.place === 'folder' ? 'Saving…' : 'Not saved';
}

/** the menu, and the file and folder pickers it opens */
export function ProjectMenu() {
  const p = useProject();
  const work = useStudio((s) => hasWork(s));
  useStudio((s) => s.track);
  const [open, setOpen] = useState(false);
  const [list, setList] = useState<'' | 'recent' | 'versions'>('');
  const [recent, setRecent] = useState<Recent[]>([]);
  const [older, setOlder] = useState<Version[]>([]);
  const box = useRef<HTMLDivElement>(null);
  const input = useRef<HTMLInputElement>(null);
  const shown = open || !!p.asking;
  const folders = canKeepFolders();

  useEffect(() => {
    if (!shown) return;
    void recents().then(setRecent);
    void versions().then(setOlder);
  }, [shown, p.savedAt]);

  useEffect(() => {
    if (!shown) return;
    const shut = () => {
      setOpen(false);
      setList('');
      closeAsk();
    };
    const close = (e: PointerEvent) => {
      if (!box.current?.contains(e.target as Node)) shut();
    };
    const esc = (e: KeyboardEvent) => {
      if (e.key === 'Escape') shut();
    };
    window.addEventListener('pointerdown', close);
    window.addEventListener('keydown', esc);
    return () => {
      window.removeEventListener('pointerdown', close);
      window.removeEventListener('keydown', esc);
    };
  }, [shown]);

  const pick = (fn: () => void) => () => {
    setOpen(false);
    setList('');
    fn();
  };
  const go = (fn: () => void) => pick(() => guarded(fn));
  // any file: iOS greys out an extension it doesn't know
  const openHum = () => input.current?.click();
  const name = work || p.place ? shownName(p) : '';
  const state = word(p, work);
  const wants = p.status === 'locked' || p.status === 'newer' || p.status === 'error';

  return (
    <div className="src proj" ref={box}>
      <button
        className={`trackpill proj-pill ${shown ? 'open' : ''} ${wants ? 'wants' : ''}`}
        onClick={() => {
          setOpen(!open);
          setList('');
        }}
        aria-haspopup="menu"
        aria-expanded={shown}
        aria-label={name ? `Project ${name}${state ? `, ${state}` : ''}` : 'Projects'}
        disabled={!!p.busy}
      >
        <Folder width={14} height={14} />
        <span className="name">{name && p.place ? name : 'Project'}</span>
        {state && <span className="meta">{state}</span>}
        <Chevron width={12} height={12} className="caret" />
      </button>
      {p.asking ? (
        <div className="menu" role="dialog" aria-label="Save first?">
          <p className="proj-note">{unsaved(p) ? `“${shownName(p)}” isn’t saved. Opening another puts it away.` : 'Saved.'}</p>
          {unsaved(p) ? (
            <div className="proj-btns">
              <button className="btn primary" onClick={() => void save()}>
                Save first
              </button>
              <button
                className="btn"
                onClick={() => {
                  const g = p.asking;
                  closeAsk();
                  g?.();
                }}
              >
                Don’t save
              </button>
              <button className="btn ghost" onClick={closeAsk}>
                Cancel
              </button>
            </div>
          ) : (
            <div className="proj-btns">
              <button
                className="btn primary"
                onClick={() => {
                  const g = p.asking;
                  closeAsk();
                  g?.();
                }}
              >
                Continue
              </button>
            </div>
          )}
        </div>
      ) : (
        open && (
          <div className="menu" role="menu">
            {list ? (
              <>
                <button role="menuitem" className="menu-item row" onClick={() => setList('')}>
                  <Chevron width={12} height={12} className="proj-back" />
                  <b>{list === 'recent' ? 'Recent projects' : 'Earlier versions'}</b>
                </button>
                <div className="menu-sep" />
                <div className="proj-list">
                  {list === 'recent'
                    ? recent.map((r) => (
                        <button
                          key={r.id}
                          role="menuitem"
                          className={`menu-item ${r.id === p.id && p.place ? 'on' : ''}`}
                          onClick={go(() => void openRecent(r))}
                          onContextMenu={(e) => {
                            e.preventDefault();
                            void forgetRecent(r.id).then(() => recents().then(setRecent));
                          }}
                        >
                          <b>{r.name}</b>
                          <span>{when(r.at)}</span>
                        </button>
                      ))
                    : older.map((v) => (
                        <button key={v.file} role="menuitem" className="menu-item" onClick={pick(() => void openVersion(v))}>
                          <b>{when(v.at)}</b>
                        </button>
                      ))}
                </div>
                {list === 'versions' && <p className="menu-foot">The video on now is kept as a version too.</p>}
              </>
            ) : (
              <>
                {(work || p.place) && (
                  <>
                    <input
                      key={p.id + shownName(p)}
                      className="proj-name"
                      defaultValue={shownName(p)}
                      aria-label="Project name"
                      spellCheck={false}
                      onBlur={(e) => rename(e.target.value || shownName(p))}
                      onKeyDown={(e) => {
                        if (e.key === 'Enter') e.currentTarget.blur();
                      }}
                    />
                    {p.note && <p className="proj-note">{p.note}</p>}
                    {p.status === 'locked' && (
                      <div className="proj-btns">
                        <button className="btn primary" onClick={pick(() => void reconnect())}>
                          Reconnect
                        </button>
                      </div>
                    )}
                    {p.status === 'newer' && (
                      <div className="proj-btns">
                        <button className="btn primary" onClick={pick(() => void keepDisk())}>
                          Open the saved one
                        </button>
                        <button className="btn" onClick={pick(() => void keepHere())}>
                          Keep this one
                        </button>
                      </div>
                    )}
                    {!p.note && (
                      <p className="proj-note">
                        {p.place === 'folder' ? (p.savedAt ? `Saves itself in its folder. Last: ${when(p.savedAt)}` : 'Saves itself in its folder.') : p.place === 'file' ? 'Saved as one file. Save again to keep changes.' : 'Not saved yet. Only this browser remembers it.'}
                      </p>
                    )}
                    <button role="menuitem" className="menu-item row" onClick={pick(() => void save())}>
                      <Save width={14} height={14} />
                      <b>{p.place === 'folder' ? 'Save a version' : folders && p.place !== 'file' ? 'Save project…' : 'Save project'}</b>
                      <span className="proj-key">{/Mac|iP/.test(navigator.platform) ? '⌘S' : 'Ctrl S'}</span>
                    </button>
                    {folders && p.place && (
                      <button role="menuitem" className="menu-item row" onClick={pick(() => void saveInFolder(true))}>
                        <Folder width={14} height={14} />
                        <b>{p.place === 'file' ? 'Save in a folder…' : 'Save a copy in another folder…'}</b>
                      </button>
                    )}
                    {folders && (
                      <button role="menuitem" className="menu-item row" onClick={pick(() => void saveFile())}>
                        <Film width={14} height={14} />
                        <b>Save as one file…</b>
                      </button>
                    )}
                    {p.place === 'folder' && older.length > 0 && (
                      <button role="menuitem" className="menu-item row" onClick={() => setList('versions')}>
                        <Chevron width={12} height={12} className="proj-fwd" />
                        <b>Earlier versions</b>
                        <span className="proj-key">{older.length}</span>
                      </button>
                    )}
                    <div className="menu-sep" />
                  </>
                )}
                {recent.length > 0 && (
                  <button role="menuitem" className="menu-item row" onClick={() => setList('recent')}>
                    <Chevron width={12} height={12} className="proj-fwd" />
                    <b>Recent projects</b>
                  </button>
                )}
                {folders && (
                  <button role="menuitem" className="menu-item row" onClick={go(() => void openFolder())}>
                    <Folder width={14} height={14} />
                    <b>Open a project folder…</b>
                  </button>
                )}
                <button role="menuitem" className="menu-item row" onClick={go(openHum)}>
                  <Upload width={14} height={14} />
                  <b>Open a .hum file…</b>
                </button>
                {(work || p.place) && (
                  <button role="menuitem" className="menu-item row" onClick={go(() => void startNew())}>
                    <Plus width={14} height={14} />
                    <b>New project</b>
                  </button>
                )}
              </>
            )}
          </div>
        )
      )}
      <input
        ref={input}
        type="file"
        hidden
        onChange={(e) => {
          const f = e.target.files?.[0];
          e.target.value = '';
          if (f) void openFile(f);
        }}
      />
    </div>
  );
}
