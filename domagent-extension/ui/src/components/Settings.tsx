import { useEffect, useState } from 'preact/hooks';
import { act, busy, controller, api, browserName } from '../runtime';
import { hostOf } from '../presentation';
import type { Agent, Snapshot } from '../presentation';
import { Dot } from './Primitives';
import './Settings.css';

export function Settings({ snapshot, close, pair }: { snapshot: Snapshot; close: () => void; pair: () => void }) {
  const [name, setName] = useState(snapshot.identity!.name);
  const [scripts, setScripts] = useState<boolean | null>(null);
  useEffect(() => {
    if (browserName === 'firefox') void api.permissions.contains({ permissions: ['userScripts'] }).then(setScripts);
  }, []);
  return <section class="settings" aria-label="Settings">
    <div class="section-head"><h2>Settings</h2><button class="link" onClick={close}>Close</button></div>
    <form class="field" onSubmit={event => { event.preventDefault(); void act('Renaming', () => controller.renameBrowser(name)); }}>
      <label for="browser-name">This browser</label>
      <div class="inline"><input id="browser-name" maxLength={80} value={name} onInput={event => setName(event.currentTarget.value)}/>
        <button type="submit" disabled={busy.value !== null || snapshot.phase !== 'online' || name === snapshot.identity!.name}>Save</button></div>
    </form>
    <div class="field"><span class="label">Server</span><span>{hostOf(snapshot.identity!.origin)}</span></div>
    <div class="field"><span class="label">Agents</span>
      {snapshot.agents.length > 0 && <ul class="plain">{snapshot.agents.map((agent: Agent) => <li key={agent.id} class="inline">
        <span><Dot color={agent.color}/>{agent.name}</span>
        <button disabled={busy.value !== null || snapshot.phase !== 'online'} onClick={() => {
          if (confirm(`Unpair ${agent.name}? Its sessions end and their tabs are ungrouped.`)) void act('Unpairing', () => controller.revokeAgent(agent.id));
        }}>Unpair</button></li>)}</ul>}
      <button class="link" disabled={busy.value !== null || snapshot.phase !== 'online' || Boolean(snapshot.pairing)}
        onClick={pair}>+ Pair an agent</button>
    </div>
    <label class="check">
      <input type="checkbox" checked={snapshot.settings.openAtStartup}
        onChange={event => void act('Saving', () => controller.setOpenAtStartup(event.currentTarget.checked))}/>
      Open DomAgent when the browser starts
    </label>
    {browserName === 'firefox' && <div class="field"><span class="label">Page scripts</span>
      {scripts ? <span>Enabled</span> : <button onClick={() => void act('Enabling', async () => {
        setScripts(await api.permissions.request({ permissions: ['userScripts'] }));
      })}>Enable</button>}</div>}
    <div class="field danger-zone">
      <button class="danger" disabled={busy.value !== null} onClick={() => {
        if (confirm('Forget this browser? All pairings and sessions end. You will need to set DomAgent up again.')) {
          void act('Forgetting', () => controller.forget());
        }
      }}>Forget this browser</button>
    </div>
    <p class="muted small">DomAgent {api.runtime.getManifest().version} · browser ID {snapshot.identity!.browser_id}</p>
  </section>;
}
