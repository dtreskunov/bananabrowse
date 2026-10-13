import { render } from 'preact';
import { initialize, isPanel, isPopup, localError, report, snapshot } from './client';
import { Panel } from './Panel';
import { Setup } from './Setup';
import { Notice } from './components/Notice';
import { Popup } from './Popup';
import './styles/global.css';

function App() {
  const state = snapshot.value;
  if (!state) return <main class="panel-content"><h1>DomAgent</h1><p role="status">Getting ready...</p><Notice code={localError.value}/></main>;
  if (isPanel) return <Panel snapshot={state}/>;
  return isPopup ? <Popup snapshot={state}/> : <Setup snapshot={state}/>;
}
const root = document.getElementById('app');
if (!root) throw new Error('INVALID_MESSAGE');
render(<App/>, root);
void initialize().catch(report);
