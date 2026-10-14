import { render } from 'preact';
import { App } from './App';
import { boot, localError } from './runtime';
import './styles/global.css';

const root = document.getElementById('app');
if (!root) throw new Error('INVALID_MESSAGE');
render(<App/>, root);
void boot().catch(error => {
  localError.value = error?.code || error?.message || 'INVALID_MESSAGE';
  console.error('DomAgent:', localError.value);
});
