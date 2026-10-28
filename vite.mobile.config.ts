import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import path from 'node:path';
export default defineConfig({ plugins:[react()],root:'mobile/web',base:'./',publicDir:path.resolve('images'),
 build:{outDir:path.resolve('dist-mobile'),emptyOutDir:true,target:'es2020',commonjsOptions:{include:[/node_modules/,/electron\/i18n\.cjs$/]}} });
