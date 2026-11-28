// Publish elsewhere: the console card that exports a verified version as a YouTube Playables package (src/youtube-export.ts).
// The creator sees what will and will not work inside YouTube first, then downloads the zip and submits it to YouTube.
import { useState } from 'react';
import { bytes, t, useData } from './lib';
import { Button, Card, Notice } from './ui';
import './follow.css';

type Item = { code: string; message: string };
type Check = { version: number; live: boolean; status: string; blockers: Item[]; warnings: Item[]; bytes: number; platform_files: number };

export function PublishElsewhereCard({ id }: { id: string }) {
  const [open, setOpen] = useState(false);
  return (
    <Card title={t('Publish elsewhere', '发布到其他平台')} pad>
      <div className="stack">
        <p className="mute fs-sm">{t('Export a verified version as a YouTube Playables package: a zip with your game, the files it loads from HearthCade, and YouTube\'s SDK wired to saves, pause, sound and scores. You submit it to YouTube yourself.', '将已验证的版本导出为 YouTube Playables 安装包：一个包含你的游戏、它从 HearthCade 加载的文件，以及已接好存档、暂停、声音和分数的 YouTube SDK 的 zip。你需要自己提交给 YouTube。')}</p>
        {!open ? <div><Button size="sm" onClick={() => setOpen(true)}>{t('Check for YouTube Playables', '检查能否导出到 YouTube Playables')}</Button></div> : <YouTubeCheck id={id} />}
      </div>
    </Card>
  );
}

function YouTubeCheck({ id }: { id: string }) {
  const { data, error } = useData<Check>(`/console/projects/${id}/export/youtube`);
  if (error) return <Notice tone="bad">{error.message}</Notice>;
  if (!data) return <p className="mute fs-sm">{t('Checking the game…', '正在检查游戏…')}</p>;
  const href = `/api/console/projects/${encodeURIComponent(id)}/export/youtube/download?version=${data.version}`;
  return (
    <div className="stack s">
      <span className="fs-sm">{data.live ? t('Version {n} (live) · {size}', '版本 {n}（已上线）· {size}', { n: data.version, size: bytes(data.bytes) }) : t('Version {n} · {size}', '版本 {n} · {size}', { n: data.version, size: bytes(data.bytes) })}</span>
      {data.blockers.map((b) => <Notice key={b.code} tone="bad">{b.message}</Notice>)}
      {data.warnings.length > 0 && (
        <div className="stack s">
          <b className="fs-sm">{t('What will not work the same inside YouTube', '在 YouTube 中会有所不同的地方')}</b>
          <ul className="fs-sm dim ytx-list">{data.warnings.map((w) => <li key={w.code}>{w.message}</li>)}</ul>
        </div>
      )}
      {!data.blockers.length && !data.warnings.length && <p className="fs-sm">{t('Nothing to change: the game should run inside YouTube as it is.', '无需修改：游戏应可直接在 YouTube 中运行。')}</p>}
      {!data.blockers.length && <div className="row wrap-row"><Button size="sm" variant="primary" href={href}>{t('Download the package', '下载安装包')}</Button><span className="dim fs-sm">{t('PLAYABLES.md inside lists the steps to submit it.', '包内的 PLAYABLES.md 列出了提交步骤。')}</span></div>}
    </div>
  );
}
