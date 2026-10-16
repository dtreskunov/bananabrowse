import { render } from 'preact';
import './styles/global.css';
import { App } from './components/App';
import { boot, localError } from './runtime';

const root = document.getElementById('app');
if (!root) throw new Error('INVALID_MESSAGE');
render(<App />, root);
void boot().catch((error) => {
  localError.value = error?.code || error?.message || 'INVALID_MESSAGE';
  console.error('DomAgent:', localError.value);
});
