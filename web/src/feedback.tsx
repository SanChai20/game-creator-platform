// Creator feedback: while playing their preview, a creator captures the game, circles or points at what is wrong, writes
// a note and adds it to a queue their agent reads with the creator_feedback tool (src/feedback.ts). Each item is removed
// once the agent has read it; the creator can remove items here too.
//
// The picture is the tab's real pixels where the browser can share the tab (desktop Chrome, Edge and other Chromium
// browsers; see capture.ts): the browser asks once per preview, and each capture takes the next frame, cropped to the
// game. Elsewhere, or when the creator declines, the SDK inside the game page redraws the page itself (its canvases and
// the elements over them), which can differ from what was on screen; the editor says so. Either way the creator can
// switch to the other picture, or to a screenshot of their own, before sending.
import { useCallback, useEffect, useRef, useState, useSyncExternalStore, type PointerEvent as RPointerEvent } from 'react';
import { ago, api, bytes, t, useAct, useData } from './lib';
import { Badge, Button, Card, EmptyState, Segmented, Textarea } from './ui';
import type { GameCapture } from './player';
import { canCaptureTab, grabTab, onTabShare, startTabShare, stopTabShare, tabShareDeclined, tabShareOn, type CaptureDiag } from './capture';

export type Tool = 'circle' | 'arrow' | 'box' | 'pen';
export interface Mark { type: Tool; x?: number; y?: number; w?: number; h?: number; x1?: number; y1?: number; x2?: number; y2?: number; points?: [number, number][]; label?: string }
export interface Shot { image: string; method: 'game' | 'page' | 'screen' | 'upload'; capture: Partial<GameCapture>; fullscreen: boolean; version: number | null; partial?: boolean; why?: 'declined' | 'unsupported' | 'fullscreen' | 'failed'; diag?: CaptureDiag;
  /** With an exact picture: the game's own drawing of the same moment, ready in case the exact one looks wrong. */
  alt?: Promise<GameCapture> }
type Pic = { image: string; method: Shot['method']; partial?: boolean };

const COLOR = '#ff3b5c', HALO = 'rgba(0,0,0,.55)';
const MAX_SIDE = 1600, MAX_BYTES = 1_400_000;
// the editor's own canvas: big enough to draw on sharply, small enough for every browser's canvas limits (a phone's own
// screenshot can be 4000 px and more; iOS refuses canvases over about 16 million pixels)
const EDIT_SIDE = 2048;

const loadImage = (src: string) => new Promise<HTMLImageElement>((ok, no) => { const i = new Image(); i.onload = () => ok(i); i.onerror = () => no(new Error(t('The screenshot could not be read.', '无法读取截图。'))); i.src = src; });

/** A screenshot the creator took themselves (pasted or chosen), as a data URL. */
export function readOwnPicture(f: Blob): Promise<string> {
  if (!/^image\/(png|jpeg|webp|gif|bmp)$/.test(f.type)) return Promise.reject(new Error(t('Choose a picture (PNG or JPEG).', '请选择图片（PNG 或 JPEG）。')));
  if (f.size > 25e6) return Promise.reject(new Error(t('That picture is too large.', '图片太大。')));
  return new Promise((ok, no) => { const r = new FileReader(); r.onload = () => ok(String(r.result)); r.onerror = () => no(new Error(t('The screenshot could not be read.', '无法读取截图。'))); r.readAsDataURL(f); });
}
const imageIn = (d: DataTransfer | null) => [...(d?.items || [])].find((i) => i.kind === 'file' && i.type.startsWith('image/'))?.getAsFile() ?? null;

function draw(g: CanvasRenderingContext2D, w: number, h: number, marks: Mark[], draft: Mark | null) {
  const lw = Math.max(3, Math.round(Math.max(w, h) / 260)), all = draft ? [...marks, draft] : marks;
  g.lineCap = 'round'; g.lineJoin = 'round';
  all.forEach((m, i) => {
    const path = () => {
      g.beginPath();
      if (m.type === 'circle') g.ellipse((m.x! + m.w! / 2) * w, (m.y! + m.h! / 2) * h, Math.max(2, (m.w! * w) / 2), Math.max(2, (m.h! * h) / 2), 0, 0, Math.PI * 2);
      else if (m.type === 'box') g.rect(m.x! * w, m.y! * h, m.w! * w, m.h! * h);
      else if (m.type === 'pen') m.points!.forEach(([x, y], j) => (j ? g.lineTo(x * w, y * h) : g.moveTo(x * w, y * h)));
      else {
        const x1 = m.x1! * w, y1 = m.y1! * h, x2 = m.x2! * w, y2 = m.y2! * h, a = Math.atan2(y2 - y1, x2 - x1), hd = lw * 5;
        g.moveTo(x1, y1); g.lineTo(x2, y2);
        g.moveTo(x2, y2); g.lineTo(x2 - hd * Math.cos(a - 0.45), y2 - hd * Math.sin(a - 0.45));
        g.moveTo(x2, y2); g.lineTo(x2 - hd * Math.cos(a + 0.45), y2 - hd * Math.sin(a + 0.45));
      }
    };
    path(); g.strokeStyle = HALO; g.lineWidth = lw + 4; g.stroke();
    path(); g.strokeStyle = COLOR; g.lineWidth = lw; g.stroke();
    // its number, where the agent will look for it
    const [nx, ny] = m.type === 'arrow' ? [m.x1! * w, m.y1! * h] : m.type === 'pen' ? [m.points![0][0] * w, m.points![0][1] * h] : [m.x! * w, m.y! * h];
    const r = lw * 3.4; g.beginPath(); g.arc(Math.min(w - r, Math.max(r, nx)), Math.min(h - r, Math.max(r, ny)), r, 0, Math.PI * 2);
    g.fillStyle = COLOR; g.fill(); g.lineWidth = 2; g.strokeStyle = '#fff'; g.stroke();
    g.fillStyle = '#fff'; g.font = `700 ${Math.round(r * 1.25)}px system-ui, sans-serif`; g.textAlign = 'center'; g.textBaseline = 'middle';
    g.fillText(String(i + 1), Math.min(w - r, Math.max(r, nx)), Math.min(h - r, Math.max(r, ny)) + 1);
  });
}

/** The annotated picture as a JPEG data URL under the upload limit. */
async function flatten(src: string, marks: Mark[]): Promise<{ image: string; width: number; height: number }> {
  const img = await loadImage(src);
  let k = Math.min(1, MAX_SIDE / Math.max(img.naturalWidth, img.naturalHeight));
  for (let tries = 0; tries < 5; tries++) {
    const c = document.createElement('canvas'); c.width = Math.max(1, Math.round(img.naturalWidth * k)); c.height = Math.max(1, Math.round(img.naturalHeight * k));
    const g = c.getContext('2d')!; g.drawImage(img, 0, 0, c.width, c.height); draw(g, c.width, c.height, marks, null);
    for (const q of [0.86, 0.72, 0.58]) { const out = c.toDataURL('image/jpeg', q); if (out.length * 0.75 < MAX_BYTES) return { image: out, width: c.width, height: c.height }; }
    k *= 0.75;
  }
  throw new Error(t('The screenshot is too large.', '截图太大。'));
}

const unit = (v: number) => Math.round(Math.min(1, Math.max(0, v)) * 10000) / 10000;
const toolName = (k: Tool) => ({ circle: t('Circle', '圈选'), arrow: t('Arrow', '箭头'), box: t('Box', '方框'), pen: t('Pen', '画笔') })[k];

/** Mark up a capture and add it to the queue. */
export function FeedbackEditor({ projectId, shot, onDone, onCancel, redraw }: {
  projectId: string; shot: Shot; onDone: (pending: number) => void; onCancel: () => void;
  /** The game page's own drawing of itself (the SDK), offered when the exact picture looks wrong. */
  redraw?: () => Promise<GameCapture>;
}) {
  const canvas = useRef<HTMLCanvasElement>(null), [img, setImg] = useState<HTMLImageElement | null>(null);
  const [tool, setTool] = useState<Tool>('circle'), [marks, setMarks] = useState<Mark[]>([]), [draft, setDraft] = useState<Mark | null>(null);
  const [note, setNote] = useState(''), start = useRef<[number, number] | null>(null);
  const { busy, act } = useAct();
  // the creator can put their own screenshot in place of the captured one (pasted, or chosen from their files)
  // or the game's own drawing of itself, when the browser's picture looks wrong
  const [pic, setPic] = useState<Pic | null>(null), image = pic?.image ?? shot.image, method = pic?.method ?? shot.method, partial = pic ? pic.partial : shot.partial;
  const file = useRef<HTMLInputElement>(null), pointer = useRef<number | null>(null);
  const useOwn = (f: Blob | null | undefined) => { if (f) act('own', async () => { setPic({ image: await readOwnPicture(f), method: 'upload' }); }); };
  const useRedraw = () => act('redraw', async () => {
    const c = await redraw!();
    if ((c.error && c.error !== 'page_elements_missing') || !c.image) throw new Error(t('The game could not draw itself (it has no canvas this can copy, or it draws pictures from another site).', '游戏无法绘制自身画面（没有可复制的画布，或使用了其他网站的图片）。'));
    setPic({ image: c.image, method: c.method === 'page' ? 'page' : 'game', partial: c.error === 'page_elements_missing' });
  });
  useEffect(() => {
    const p = (e: ClipboardEvent) => { const f = imageIn(e.clipboardData); if (f) { e.preventDefault(); useOwn(f); } };
    addEventListener('paste', p); return () => removeEventListener('paste', p);
  });
  useEffect(() => { void loadImage(image).then(setImg, () => setImg(null)); }, [image]);
  useEffect(() => {
    const c = canvas.current; if (!c || !img) return;
    const k = Math.min(1, EDIT_SIDE / Math.max(img.naturalWidth, img.naturalHeight, 1)), w = Math.max(1, Math.round(img.naturalWidth * k)), h = Math.max(1, Math.round(img.naturalHeight * k));
    if (c.width !== w || c.height !== h) { c.width = w; c.height = h; }
    const g = c.getContext('2d')!; g.clearRect(0, 0, w, h); g.drawImage(img, 0, 0, w, h); draw(g, w, h, marks, draft);
  }, [img, marks, draft]);
  // Esc closes this editor, never the preview (and the game) behind it.
  useEffect(() => {
    const k = (e: KeyboardEvent) => { if (e.key !== 'Escape') return; e.stopImmediatePropagation(); e.preventDefault(); if (draft) setDraft(null); else onCancel(); };
    addEventListener('keydown', k, true); return () => removeEventListener('keydown', k, true);
  }, [draft, onCancel]);

  // Where the pointer is on the picture, in picture fractions. Measured at every event from where the picture is drawn
  // right now: inside the element's border, and inside the bars the browser adds when the element's shape differs from the
  // picture's (object-fit: contain), so any window size, zoom or layout change keeps marks under the pointer.
  const at = (e: RPointerEvent<HTMLCanvasElement>): [number, number] => {
    const c = e.currentTarget, r = c.getBoundingClientRect(), bw = c.clientWidth, bh = c.clientHeight;
    const left = r.left + c.clientLeft, top = r.top + c.clientTop;
    const k = Math.min(bw / (c.width || 1), bh / (c.height || 1)), w = c.width * k || bw, h = c.height * k || bh;
    return [unit((e.clientX - left - (bw - w) / 2) / w), unit((e.clientY - top - (bh - h) / 2) / h)];
  };
  const shape = (a: [number, number], b: [number, number]): Mark => tool === 'arrow' ? { type: 'arrow', x1: a[0], y1: a[1], x2: b[0], y2: b[1] }
    : { type: tool, x: Math.min(a[0], b[0]), y: Math.min(a[1], b[1]), w: Math.abs(b[0] - a[0]), h: Math.abs(b[1] - a[1]) };
  // One pointer draws at a time: a second finger, or a pen and a palm together, cannot start a second shape mid-way.
  const down = (e: RPointerEvent<HTMLCanvasElement>) => {
    if (marks.length >= 30 || pointer.current !== null || (e.pointerType === 'mouse' && e.button !== 0)) return;
    pointer.current = e.pointerId; try { e.currentTarget.setPointerCapture(e.pointerId); } catch { /* the pointer is already gone */ }
    const p = at(e); start.current = p;
    setDraft(tool === 'pen' ? { type: 'pen', points: [p] } : shape(p, p));
  };
  const move = (e: RPointerEvent<HTMLCanvasElement>) => {
    if (!start.current || e.pointerId !== pointer.current) return; const p = at(e);
    setDraft((d) => (d?.type === 'pen' ? (d.points!.length < 2000 ? { ...d, points: [...d.points!, p] } : d) : shape(start.current!, p)));
  };
  const up = (e: RPointerEvent<HTMLCanvasElement>) => {
    if (e.pointerId !== pointer.current) return;
    pointer.current = null;
    const d = draft; start.current = null; setDraft(null); if (!d) return;
    // a click without a drag still marks the spot: a small circle (or a short arrow) around it
    const tiny = d.type === 'pen' ? d.points!.length < 2 : d.type === 'arrow' ? Math.hypot(d.x2! - d.x1!, d.y2! - d.y1!) < 0.01 : d.w! < 0.01 && d.h! < 0.01;
    let m = d;
    if (tiny) {
      const [cx, cy] = d.type === 'pen' ? d.points![0] : d.type === 'arrow' ? [d.x2!, d.y2!] : [d.x! + d.w! / 2, d.y! + d.h! / 2];
      m = d.type === 'arrow' ? { type: 'arrow', x1: unit(cx - 0.08), y1: unit(cy - 0.08), x2: cx, y2: cy } : { type: d.type === 'pen' ? 'circle' : d.type, x: unit(cx - 0.04), y: unit(cy - 0.04), w: 0.08, h: 0.08 };
    }
    setMarks((ms) => [...ms, m]);
  };
  const send = () => act('fb', async () => {
    if (!note.trim() && !marks.length) throw new Error(t('Write a note or mark something on the screenshot first.', '请先写一段说明，或在截图上做个标记。'));
    const flat = await flatten(image, marks), c = shot.capture;
    const r = await api<{ pending: number }>(`/console/projects/${projectId}/feedback`, { body: {
      image: flat.image, note: note.trim(), version: shot.version,
      marks: marks.map((m) => ({ ...m, label: m.label?.trim() || undefined })),
      context: { method, viewport: c.viewport, frames: c.frames, fps: c.fps, ready: c.ready, label: c.label, errors: c.errors, warnings: c.warnings, state: c.state,
        fullscreen: shot.fullscreen, touch: matchMedia('(pointer: coarse)').matches, lang: navigator.language, browser: navigator.userAgent,
        dpr: devicePixelRatio || 1, ...(method === 'screen' && shot.diag ? { capture: shot.diag } : {}) },
    } });
    onDone(r.pending);
  }, t('Added. Your agent will see it the next time it checks its feedback.', '已添加。你的智能体下次查看反馈时就会看到。'));

  return (
    <div className="stack fb-editor" onKeyDown={(e) => e.stopPropagation()}>
      <div className="row" style={{ flexWrap: 'wrap', gap: 8 }}>
        <b>{t('Mark what is wrong', '标出问题所在')}</b>
        <Segmented label={t('Drawing tool', '绘制工具')} value={tool} onChange={setTool} options={(['circle', 'arrow', 'box', 'pen'] as Tool[]).map((k) => [k, toolName(k)])} />
        <span className="row right" style={{ gap: 8 }}>
          <Button size="sm" variant="ghost" onClick={() => setMarks((m) => m.slice(0, -1))} disabled={!marks.length}>{t('Undo', '撤销')}</Button>
          <Button size="sm" variant="ghost" onClick={() => setMarks([])} disabled={!marks.length}>{t('Clear', '清除')}</Button>
        </span>
      </div>
      <canvas ref={canvas} className="fb-canvas" onPointerDown={down} onPointerMove={move} onPointerUp={up} onPointerCancel={(e) => { if (e.pointerId !== pointer.current) return; pointer.current = null; start.current = null; setDraft(null); }}
        aria-label={t('Screenshot of the game. Drag on it to circle or point at something.', '游戏截图。在上面拖动即可圈出或指向某处。')} />
      {(method === 'game' || method === 'page') && <p className="dim fs-sm fb-approx">{t('This picture was redrawn by the game page, not taken from your screen, so it can differ from what you saw (icons, fonts, effects).', '这张图由游戏页面重新绘制，并非直接截取屏幕，因此可能与你看到的画面有出入（图标、字体、特效等）。')}
        {partial ? ' ' + t('Only the game\'s canvas is in it: this browser could not draw the menus and panels over it.', '图中只有游戏画布：此浏览器无法绘制其上方的菜单和面板。') : ''}
        {' '}{shot.why === 'unsupported' ? t('This browser cannot share a tab, so an exact picture is not possible here.', '此浏览器无法共享标签页，因此这里无法截取完全一致的画面。')
          : shot.why === 'fullscreen' ? t('For exact pictures in fullscreen, turn on Exact screenshots below the game first.', '如需在全屏时截取完全一致的画面，请先在游戏下方开启“精确截图”。')
          : shot.why === 'failed' ? t('Sharing this tab did not give a picture; try Exact screenshots again.', '共享标签页未能获取画面，请再试一次“精确截图”。')
          : t('For an exact picture, allow sharing this tab when the browser asks (Exact screenshots, below the game).', '如需完全一致的画面，请在浏览器询问时允许共享此标签页（游戏下方的“精确截图”）。')}
        {' '}{t('Or take a screenshot yourself and paste it here, or choose it with Use my own screenshot.', '你也可以自己截图后粘贴到这里，或通过“使用我自己的截图”选择。')}</p>}
      {method === 'upload' && <p className="dim fs-sm">{t('Your own screenshot. Mark it up as usual.', '这是你自己的截图，照常标注即可。')}</p>}
      {method === 'screen' && redraw && <p className="dim fs-sm fb-exact">{t('Taken from this tab exactly as you see it. If the picture does not match the game (cut off, shrunk, black or blank), use the game\'s own drawing instead, or your own screenshot.', '这张图直接取自此标签页，与你所见一致。如果画面与游戏不符（被裁切、缩小、发黑或空白），可改用游戏自己绘制的画面，或你自己的截图。')}
        {' '}<button type="button" className="linkish" onClick={useRedraw} disabled={busy === 'redraw'}>{t('Use the game\'s own drawing', '改用游戏自绘画面')}</button></p>}
      {!!marks.length && <div className="stack s">{marks.map((m, i) => (
        <div className="row fb-mark" key={i}>
          <span className="fb-num">{i + 1}</span><span className="mute fs-sm">{toolName(m.type)}</span>
          <input className="input grow" maxLength={200} value={m.label || ''} placeholder={t('What about it? (optional)', '具体说明（可选）')} onChange={(e) => setMarks((ms) => ms.map((x, j) => (j === i ? { ...x, label: e.target.value } : x)))} aria-label={t('Note for mark {n}', '标记 {n} 的说明', { n: i + 1 })} />
          <Button size="sm" variant="ghost" onClick={() => setMarks((ms) => ms.filter((_, j) => j !== i))}>{t('Remove', '移除')}</Button>
        </div>
      ))}</div>}
      <Textarea rows={3} maxLength={2000} value={note} onChange={(e) => setNote(e.target.value)} placeholder={t('What should your agent fix or change? For example: the score overlaps the health bar on small screens.', '希望智能体修复或修改什么？例如：在小屏幕上分数和血条重叠了。')} aria-label={t('Note for your agent', '给智能体的说明')} />
      <div className="row" style={{ gap: 8 }}>
        <span className="dim fs-sm grow">{t('Your agent reads this with the creator_feedback tool. It leaves the queue once read.', '智能体通过 creator_feedback 工具读取，读取后即从队列移除。')}</span>
        <input ref={file} type="file" accept="image/png,image/jpeg,image/webp" hidden onChange={(e) => { useOwn(e.target.files?.[0]); e.target.value = ''; }} />
        <Button variant="ghost" onClick={() => file.current?.click()} disabled={busy === 'own'} title={t('Use a screenshot you took yourself instead (you can also paste one)', '改用你自己截的图（也可以直接粘贴）')}>{t('Use my own screenshot', '使用我自己的截图')}</Button>
        <Button variant="ghost" onClick={onCancel}>{t('Back to the game', '返回游戏')}</Button>
        <Button variant="primary" onClick={send} disabled={busy === 'fb'}>{t('Add to queue', '加入队列')}</Button>
      </div>
    </div>
  );
}

/** The capture buttons under the preview: Capture, and the switch for exact screenshots (sharing this tab). */
export function CaptureButtons({ onShot, capture, frame, version, fullscreen, disabled, compact }: {
  /** Only the game capture (in fullscreen, beside the menu button). */
  compact?: boolean;
  onShot: (s: Shot) => void; capture: (picture?: boolean) => Promise<GameCapture>; frame: () => Element | null; version: number | null; fullscreen: () => boolean; disabled?: boolean;
}) {
  const { busy, act } = useAct();
  const sharing = useSyncExternalStore(onTabShare, tabShareOn, () => false);
  // the share lasts as long as the preview: closing it stops the share
  useEffect(() => (compact ? undefined : () => stopTabShare()), [compact]);
  const exact = async (base: Omit<Shot, 'image' | 'method' | 'capture'>) => {
    const { image, diag } = await grabTab(frame());
    const c = await capture(false).catch(() => ({} as Partial<GameCapture>));   // the game's own state, if it answers
    // the game's own drawing of the same moment, in the background: the editor offers it if this picture looks wrong
    const alt = capture(true); alt.catch(() => {});
    onShot({ ...base, image, method: 'screen', capture: { ...c, image: '' }, diag, alt });
  };
  const fromGame = () => act('cap', async () => {
    const base = { fullscreen: fullscreen(), version };
    let why: Shot['why'] = !canCaptureTab() ? 'unsupported' : 'declined';
    if (tabShareOn()) {
      try { await exact(base); return; } catch { why = 'failed'; }
    } else if (canCaptureTab() && !tabShareDeclined()) {
      if (base.fullscreen) why = 'fullscreen';   // the browser's question would end fullscreen
      else if (await startTabShare()) {
        (frame() as HTMLElement | null)?.focus();   // the browser's question took the focus away from the game
        // the browser's "sharing this tab" bar can resize the page: let the game draw at its new size first
        await new Promise((r) => setTimeout(r, 350));
        try { await exact(base); return; } catch { why = 'failed'; }
      }
    }
    const c = await capture();
    if (c.error === 'not_allowed') throw new Error(t('Only the preview can be captured, by the game\'s creator.', '只有游戏创作者才能截取预览画面。'));
    if ((c.error && c.error !== 'page_elements_missing') || !c.image) throw new Error(t('The game has no canvas this can capture (or it draws pictures from another site).', '游戏没有可截取的画布（或使用了其他网站的图片）。'));
    onShot({ ...base, image: c.image, method: c.method === 'page' ? 'page' : 'game', capture: c, partial: c.error === 'page_elements_missing', why });
  });
  const toggle = () => act('share', async () => { if (sharing) stopTabShare(); else await startTabShare(); });
  // Pressing a button would move the focus out of the game, and many games close an open menu or pause when they lose
  // it: the picture would no longer show what the creator saw. The press keeps the focus where it is.
  const keepFocus = (e: { preventDefault(): void }) => e.preventDefault();
  return <>
    <Button size="sm" onMouseDown={keepFocus} onClick={fromGame} disabled={disabled || busy === 'cap'} title={t('Take a screenshot to mark up and send to your agent', '截图、标注并发送给你的智能体')}>{t('Capture feedback', '截图反馈')}</Button>
    {!compact && canCaptureTab() && <Button size="sm" variant="ghost" onMouseDown={keepFocus} onClick={toggle} disabled={disabled || busy === 'share'}
      title={sharing ? t('Screenshots are taken from this tab exactly as you see it. Stop sharing the tab.', '截图会按你所见直接从此标签页获取。点击停止共享标签页。') : t('Let the browser share this tab once, so screenshots show exactly what you see. It stops when you close the preview.', '让浏览器共享此标签页一次，截图就会与你所见完全一致。关闭预览时自动停止。')}>
      {sharing ? t('Exact screenshots: on', '精确截图：已开启') : t('Exact screenshots', '精确截图')}</Button>}
  </>;
}

interface Item { id: string; version: number | null; note: string; marks: Mark[]; width: number; height: number; bytes: number; created_at: number }

/** The queue on the project page: what is waiting for the agent, with Remove. */
export function FeedbackQueue({ projectId, stamp }: { projectId: string; stamp: number }) {
  const { data, reload } = useData<{ enabled: boolean; max_pending: number; keep_days: number; items: Item[] }>(`/console/projects/${projectId}/feedback`);
  const { busy, act } = useAct(), [open, setOpen] = useState<string | null>(null);
  useEffect(() => { void reload(); }, [stamp, reload]);
  // the agent takes items off while the creator watches: keep the list fresh
  useEffect(() => { const i = setInterval(() => { if (document.visibilityState === 'visible') void reload(); }, 15000); return () => clearInterval(i); }, [reload]);
  const remove = useCallback((id: string) => act('rm' + id, async () => { await api(`/console/projects/${projectId}/feedback/${id}`, { method: 'DELETE' }); await reload(); }), [act, projectId, reload]);
  if (!data || (!data.enabled && !data.items.length)) return null;
  const items = data.items;
  return (
    <Card title={t('Feedback for your agent', '给智能体的反馈')} aside={items.length ? <Badge tone="info" dot={false}>{t('{n} waiting', '{n} 条待读', { n: items.length })}</Badge> : undefined}>
      {items.length ? <div className="fb-list">{items.map((it) => (
        <div className="fb-item" key={it.id}>
          <button type="button" className="fb-thumb" onClick={() => setOpen(open === it.id ? null : it.id)} aria-expanded={open === it.id} aria-label={t('Show the screenshot', '查看截图')}>
            <img src={`/api/console/projects/${projectId}/feedback/${it.id}/image`} alt="" loading="lazy" />
          </button>
          <div className="stack s grow" style={{ minWidth: 0 }}>
            <span style={{ wordBreak: 'break-word' }}>{it.note || <span className="mute">{t('No note', '没有说明')}</span>}</span>
            {!!it.marks.length && <span className="mute fs-sm">{it.marks.map((m, i) => `${i + 1}. ${toolName(m.type)}${m.label ? `: ${m.label}` : ''}`).join(' · ')}</span>}
            <span className="dim fs-sm">{it.version ? `v${it.version} · ` : ''}{ago(it.created_at)} · {bytes(it.bytes)}</span>
          </div>
          <Button size="sm" variant="ghost" onClick={() => void remove(it.id)} disabled={busy === 'rm' + it.id}>{t('Remove', '移除')}</Button>
          {open === it.id && <img className="fb-full" src={`/api/console/projects/${projectId}/feedback/${it.id}/image`} alt={t('Annotated screenshot', '带标注的截图')} />}
        </div>
      ))}</div> : <div className="pad"><EmptyState compact title={t('Nothing waiting', '暂无待读反馈')}>{t('While you play the preview, press Capture feedback to circle what is wrong and tell your agent. It reads the queue with the creator_feedback tool.', '试玩预览时，按“截图反馈”圈出问题并告诉智能体。智能体会通过 creator_feedback 工具读取队列。')}</EmptyState></div>}
      <p className="dim fs-sm pad" style={{ paddingTop: 0 }}>{t('Up to {max} items wait here; each leaves once your agent has read it. Unread items are deleted after {days} days.', '最多可排队 {max} 条；智能体读取后即移除。未读内容会在 {days} 天后删除。', { max: data.max_pending, days: data.keep_days })}</p>
    </Card>
  );
}
