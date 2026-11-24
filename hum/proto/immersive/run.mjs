import http from 'http';import fs from 'fs';import path from 'path';import {createRequire} from 'module';
const NM='/Users/nate/Documents/Projects/Hum/hum/node_modules';const {chromium}=createRequire(NM+'/x.js')('playwright-core');
const types={'.html':'text/html','.js':'text/javascript','.jpg':'image/jpeg','.png':'image/png','.woff2':'font/woff2'};
const srv=http.createServer((q,r)=>{let p=decodeURIComponent(q.url.split('?')[0]);const f=p.startsWith('/nm/')?NM+p.slice(3):process.cwd()+p;fs.readFile(f,(e,d)=>{if(e){r.writeHead(404);return r.end()}r.writeHead(200,{'content-type':types[path.extname(f)]||'application/octet-stream'});r.end(d)})}).listen(0);
const port=srv.address().port;const br=await chromium.launch({executablePath:'/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',headless:true,args:['--use-angle=metal','--enable-gpu','--ignore-gpu-blocklist']});
const pg=await br.newPage({viewport:{width:1600,height:900}});pg.on('console',m=>['error','warning'].includes(m.type())&&console.log(m.text().slice(0,900)));pg.on('pageerror',e=>console.log('PE',e.message));
await pg.goto(`http://localhost:${port}/proof.html`);await pg.waitForFunction(()=>window.ready,null,{timeout:30000});
const dir=process.argv[2];fs.rmSync(dir,{recursive:true,force:true});fs.mkdirSync(dir);const B=60/140;
const ts=process.argv[3]==='all'?Array.from({length:Math.round(32*B*30)},(_,i)=>i/30):process.argv[3].split(',').map(x=>+x*B);
const subs=+process.argv[4]||3;const t0=Date.now();let i=0;for(const t of ts){const u=await pg.evaluate(([t,s])=>window.shot(t,s),[t,subs]);fs.writeFileSync(`${dir}/${String(i++).padStart(4,'0')}.jpg`,Buffer.from(u.split(',')[1],'base64'))}
console.log(i,'frames',(Date.now()-t0)/1e3);await br.close();srv.close();
