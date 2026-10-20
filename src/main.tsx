import React from 'react';
import { createRoot } from 'react-dom/client';
import App from './App';
import './styles.css';
import './anime.css';
import './i18n.css';
import './layouts.css';

createRoot(document.getElementById('root')!).render(<React.StrictMode><App /></React.StrictMode>);
