import { duplicate, focusExisting, localError, state } from '../runtime';
import { Notice } from './Primitives';
import { Setup } from './Setup';
import { Main } from './Main';
import './App.css';

export function App() {
  if (duplicate.value) return <main class="center">
    <h1>DomAgent is already open</h1>
    <p class="muted">Only one DomAgent window can run at a time.</p>
    <button class="primary" onClick={focusExisting}>Switch to it</button>
  </main>;
  const snapshot = state.value;
  if (!snapshot) return <main class="center"><p class="muted" role="status">Starting…</p><Notice code={localError.value}/></main>;
  if (!snapshot.identity) return <Setup snapshot={snapshot}/>;
  return <Main snapshot={snapshot}/>;
}
