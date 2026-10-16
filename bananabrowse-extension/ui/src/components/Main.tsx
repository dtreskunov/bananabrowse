import { useEffect, useState } from 'preact/hooks';
import { act, controller, localError } from '../runtime';
import { connectionNotice, failureMessage, hostOf, windowTitle } from '../presentation';
import type { Snapshot } from '../presentation';
import { Notice } from './Primitives';
import { Settings } from './Settings';
import { Requests } from './Requests';
import { Agents } from './Agents';
import { Activity } from './Activity';
import './Main.css';

export function Main({ snapshot }: { snapshot: Snapshot }) {
  const [settings, setSettings] = useState(false);
  const title = windowTitle(snapshot);
  // The OS title bar carries connection and pending state, so the page needs no header.
  useEffect(() => {
    document.title = title;
  }, [title]);
  const pair = () =>
    void act('Pairing', () => {
      setSettings(false);
      controller.startPairing();
    });
  return (
    <div class="app" data-phase={snapshot.phase}>
      <Connection snapshot={snapshot} />
      <main>
        <Notice code={localError.value} />
        {settings ? (
          <Settings snapshot={snapshot} close={() => setSettings(false)} pair={pair} />
        ) : (
          <>
            <Requests snapshot={snapshot} />
            <Agents snapshot={snapshot} pair={pair} openSettings={() => setSettings(true)} />
            <Activity snapshot={snapshot} />
          </>
        )}
      </main>
    </div>
  );
}

function Connection({ snapshot }: { snapshot: Snapshot }) {
  const notice = connectionNotice(snapshot);
  if (!notice) return null;
  if (notice.kind === 'connecting')
    return (
      <p class="connecting muted small" role="status">
        Connecting…
      </p>
    );
  return (
    <div class="strip" role="status">
      <div>
        <strong>
          {notice.code ? failureMessage(notice.code) : `Offline: can't reach ${hostOf(snapshot.identity!.origin)}`}
        </strong>
        <span>Agents can't reach this browser.</span>
      </div>
      <button disabled={snapshot.phase === 'connecting'} onClick={() => controller.retry()}>
        {snapshot.phase === 'connecting' ? 'Retrying…' : 'Retry'}
      </button>
    </div>
  );
}
