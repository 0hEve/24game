import {readFileSync} from 'node:fs';
import {fileURLToPath} from 'node:url';
import postgres from 'postgres';
import dotenv from 'dotenv';
dotenv.config({path:fileURLToPath(new URL('../.env.local',import.meta.url)),quiet:true});
if(!process.env.DATABASE_URL)throw new Error('Set DATABASE_URL before running migrations.');
const sql=postgres(process.env.DATABASE_URL,{max:1,prepare:false,onnotice:()=>{}});
try{await sql.unsafe(readFileSync(new URL('../db/schema.sql',import.meta.url),'utf8'));console.log('PostgreSQL schema is ready. Existing leaderboard and history were preserved.');}finally{await sql.end();}
