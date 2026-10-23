import { defineConfig, loadEnv } from 'vite';
import react from '@vitejs/plugin-react';
import handler from './server/handler.js';
export default defineConfig(({mode})=>{
 const env=loadEnv(mode,process.cwd(),'');
 for(const key of ['DATABASE_URL','DATABASE_TEST_URL'])if(!process.env[key]&&env[key])process.env[key]=env[key];
 const mount=server=>{server.middlewares.use('/api/club',(req,res)=>{Promise.resolve(handler(req,res)).catch(error=>{console.error('Club middleware failed:',error.message);if(!res.headersSent){res.statusCode=500;res.setHeader('Content-Type','application/json');res.end(JSON.stringify({error:'The club is temporarily unavailable.'}));}});});};
 return {server:{fs:{deny:['.env','.env.*','**/.data/**','**/server/**','**/db/**','**/scripts/**','**/.git/**']}},plugins:[react(),{name:'club-api',configureServer:mount,configurePreviewServer:mount}]};
});
