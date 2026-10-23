import {mkdirSync,existsSync,writeFileSync,readFileSync,unlinkSync,chmodSync} from 'node:fs';
import {resolve} from 'node:path';
import {execFileSync} from 'node:child_process';
import {randomBytes} from 'node:crypto';
import {fileURLToPath} from 'node:url';
import dotenv from 'dotenv';
const root=fileURLToPath(new URL('../',import.meta.url));
const data=resolve(root,'.data'),cluster=resolve(data,'postgres'),sockets=resolve(data,'sockets');
const pg='/opt/homebrew/opt/postgresql@17/bin';
dotenv.config({path:resolve(root,'.env.local'),quiet:true});
export function ensureLocalDatabase(){
 const existing=process.env.DATABASE_URL;
 if(existing && !existing.includes('127.0.0.1:54324/')){console.log('Using configured external PostgreSQL.');return;}
 mkdirSync(data,{recursive:true,mode:0o700});mkdirSync(sockets,{recursive:true,mode:0o700});
 let secret;
 if(!existing){
  if(existsSync(cluster))throw new Error('Database exists but its connection file is missing. Restore .env.local; the data will not be reset.');
  secret=randomBytes(32).toString('hex');
  const source=`DATABASE_URL=postgres://club24:${secret}@127.0.0.1:54324/club24\nDATABASE_TEST_URL=postgres://club24:${secret}@127.0.0.1:54324/club24_test\n`;
  writeFileSync(resolve(root,'.env.local'),source,{flag:'wx',mode:0o600});
  dotenv.config({path:resolve(root,'.env.local'),quiet:true});
 }else secret=decodeURIComponent(new URL(existing).password);
 chmodSync(resolve(root,'.env.local'),0o600);
 if(!existsSync(resolve(cluster,'PG_VERSION'))){
  const password=resolve(data,'init-password');writeFileSync(password,secret,{mode:0o600});
  try{execFileSync(resolve(pg,'initdb'),['-D',cluster,'-U','club24','--auth-host=scram-sha-256','--auth-local=trust','--pwfile',password,'--encoding=UTF8','--locale=en_US.UTF-8'],{stdio:'inherit'});}finally{unlinkSync(password);}
 }
 let running=false;try{execFileSync(resolve(pg,'pg_ctl'),['-D',cluster,'status'],{stdio:'ignore'});running=true;}catch{}
 if(!running)execFileSync(resolve(pg,'pg_ctl'),['-D',cluster,'-l',resolve(data,'postgres.log'),'-o',`-h 127.0.0.1 -p 54324 -k "${sockets}"`,'-w','start'],{stdio:'inherit'});
 const env={...process.env,PGPASSWORD:secret};
 const databases=execFileSync(resolve(pg,'psql'),['-h','127.0.0.1','-p','54324','-U','club24','-d','postgres','-Atc','SELECT datname FROM pg_database'],{env,encoding:'utf8'}).split('\n');
 for(const name of ['club24','club24_test'])if(!databases.includes(name))execFileSync(resolve(pg,'createdb'),['-h','127.0.0.1','-p','54324','-U','club24',name],{env,stdio:'inherit'});
 console.log('24 CLUB PostgreSQL ready on 127.0.0.1:54324. Existing ratings are preserved.');
}
if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url))ensureLocalDatabase();
