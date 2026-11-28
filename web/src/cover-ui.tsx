// The game's cover, uploaded from the console (PUT /api/console/projects/:id/cover): the picture of its store card, its
// game page and its coming soon page. The agent can also set it (update_project's cover); either way it is the same one.
import { useRef, useState } from 'react';
import { t, useApp, useData } from './lib';
import { Button } from './ui';
import './follow.css';

type CoverState = { cover: string | null; spec: { width: number; height: number; max_bytes: number } };

export function CoverUpload({ id, onChange, compact }: { id: string; onChange?: () => void; compact?: boolean }) {
  const { toast } = useApp(), { data, reload } = useData<CoverState>(`/console/projects/${id}/cover`);
  const input = useRef<HTMLInputElement>(null), [busy, setBusy] = useState(false), [notes, setNotes] = useState<string[]>([]);
  const upload = async (f: File) => {
    if (f.size > 2 * 1024 * 1024) { toast(t('The cover must be under 2 MB.', '封面必须小于 2 MB。'), true); return; }
    setBusy(true);
    try {
      const r = await fetch(`/api/console/projects/${encodeURIComponent(id)}/cover`, { method: 'PUT', credentials: 'same-origin', headers: { 'content-type': f.type || 'application/octet-stream' }, body: f });
      const j = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(j.error || t('The upload failed. Try again.', '上传失败，请重试。'));
      setNotes(j.notes || []); await reload(); onChange?.();
      toast(t('Cover uploaded.', '封面已上传。'));
    } catch (e) { toast((e as Error).message, true); } finally { setBusy(false); if (input.current) input.current.value = ''; }
  };
  if (!data) return null;
  return (
    <div className={'cover-up' + (compact ? ' compact' : '')}>
      <div className="cover-up-art">{data.cover ? <img src={data.cover} alt={t('Current cover', '当前封面')} /> : <span>{t('No cover yet', '还没有封面')}</span>}</div>
      <div className="stack s">
        <span className="dim fs-sm">{t('A png, jpg or webp under 2 MB, 16:9, ideally {w}×{h}. Keep the title and the main subject near the middle.', 'png、jpg 或 webp 格式，小于 2 MB，16:9，最好是 {w}×{h}。标题和主体尽量放在中间。', { w: data.spec.width, h: data.spec.height })}</span>
        <div className="row wrap-row">
          <Button size="sm" variant={data.cover ? undefined : 'primary'} onClick={() => input.current?.click()} disabled={busy}>{busy ? t('Uploading…', '正在上传…') : data.cover ? t('Change cover', '更换封面') : t('Upload a cover', '上传封面')}</Button>
          <input ref={input} type="file" accept="image/png,image/jpeg,image/webp" hidden onChange={(e) => { const f = e.target.files?.[0]; if (f) void upload(f); }} />
        </div>
        {notes.length > 0 && <ul className="fs-sm dim ytx-list">{notes.map((n) => <li key={n}>{n}</li>)}</ul>}
      </div>
    </div>
  );
}
