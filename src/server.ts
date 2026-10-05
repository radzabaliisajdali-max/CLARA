import { makePool } from './db.js';
import { migrate } from './migrate.js';
import { bootstrap } from './bootstrap.js';
import { buildApp } from './app.js';
const db=makePool();
await migrate(db);await bootstrap(db);
const app=await buildApp(db,{logger:true});
await app.listen({host:'0.0.0.0',port:Number(process.env.PORT??3000)});
for(const signal of ['SIGINT','SIGTERM'] as const)process.on(signal,async()=>{await app.close();await db.end();process.exit(0);});
