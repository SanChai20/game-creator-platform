// Sharing a game (src/share.ts): the link, the usual places to post it, and the embed card for other sites.
import { useState } from 'react';
import { t, useApp } from './lib';
import { Button, Card, Textarea } from './ui';

const SIZES = { s: [320, 200], m: [480, 300], l: [640, 400] } as const;

export function ShareCard({ slug, title }: { slug: string; title: string }) {
  const { toast } = useApp(), [embed, setEmbed] = useState(false), [size, setSize] = useState<keyof typeof SIZES>('m');
  const url = `${location.origin}/g/${encodeURIComponent(slug)}`;
  const shareUrl = `${url}?ref=share`, text = t('Play {title} in your browser', '在浏览器中玩 {title}', { title });
  const [w, h] = SIZES[size];
  const code = `<iframe src="${location.origin}/embed/${encodeURIComponent(slug)}" width="${w}" height="${h}" title="${title.replace(/"/g, '&quot;')} on HearthCade" style="border:0;border-radius:12px;max-width:100%" loading="lazy" allow="web-share"></iframe>`;
  const copy = async (s: string, ok: string) => { try { await navigator.clipboard.writeText(s); toast(ok); } catch { toast(t('Copying is blocked here. Select the text and copy it.', '此处无法复制，请选中文本后手动复制。'), true); } };
  const e = encodeURIComponent;
  const places: [string, string][] = [
    ['X', `https://x.com/intent/post?text=${e(text)}&url=${e(shareUrl)}`],
    ['Bluesky', `https://bsky.app/intent/compose?text=${e(`${text} ${shareUrl}`)}`],
    ['Reddit', `https://www.reddit.com/submit?url=${e(shareUrl)}&title=${e(title)}`],
    ['Facebook', `https://www.facebook.com/sharer/sharer.php?u=${e(shareUrl)}`],
    ['WhatsApp', `https://wa.me/?text=${e(`${text} ${shareUrl}`)}`],
  ];
  const native = typeof navigator !== 'undefined' && typeof navigator.share === 'function';
  return (
    <Card title={t('Share', '分享')} pad>
      <div className="stack s">
        <div className="row wrap-row">
          {native && <Button size="sm" variant="primary" onClick={() => void navigator.share({ title, text, url: shareUrl }).catch(() => undefined)}>{t('Share…', '分享…')}</Button>}
          <Button size="sm" onClick={() => void copy(shareUrl, t('Link copied.', '链接已复制。'))}>{t('Copy link', '复制链接')}</Button>
          <Button size="sm" variant="ghost" onClick={() => setEmbed(!embed)} aria-expanded={embed}>{t('Embed', '嵌入')}</Button>
        </div>
        <div className="share-to fs-sm">{places.map(([n, href]) => <a key={n} href={href} target="_blank" rel="noopener noreferrer" className="sig">{n}</a>)}</div>
        {embed && (
          <div className="stack s">
            <p className="dim fs-sm">{t('Put this game on your site, blog or wiki. The card shows the cover and how many are playing now; Play opens the game here.', '把这款游戏放到你的网站、博客或维基上。卡片显示封面和当前在玩人数，点击开始会在这里打开游戏。')}</p>
            <div className="row">{(Object.keys(SIZES) as (keyof typeof SIZES)[]).map((k) => <Button key={k} size="sm" variant={k === size ? 'primary' : 'ghost'} onClick={() => setSize(k)}>{`${SIZES[k][0]}×${SIZES[k][1]}`}</Button>)}</div>
            <Textarea readOnly value={code} rows={4} className="mono fs-sm" onFocus={(ev) => ev.currentTarget.select()} aria-label={t('Embed code', '嵌入代码')} />
            <div className="row"><Button size="sm" onClick={() => void copy(code, t('Embed code copied.', '嵌入代码已复制。'))}>{t('Copy embed code', '复制嵌入代码')}</Button><a className="sig fs-sm" href={`/embed/${encodeURIComponent(slug)}`} target="_blank" rel="noopener">{t('Preview', '预览')} ↗</a></div>
          </div>
        )}
      </div>
    </Card>
  );
}
