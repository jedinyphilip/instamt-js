import './ui/styles.css';
import { mount } from './ui/App';

const root = document.getElementById('app');
if (!root) throw new Error('Missing #app root');
mount(root);
