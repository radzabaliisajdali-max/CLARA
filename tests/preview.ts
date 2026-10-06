// Isolated, disposable UI verification server. Never used by the production start command.
import { database } from './helpers.js';
import { buildApp } from '../src/app.js';
const env=await database(55440);
const app=await buildApp(env.db,{origin:'http://localhost:3000'});
let loseResponse=process.env.TEST_FAULT_ONCE==='1';
app.addHook('onSend',async(req,reply,payload)=>{
 if(loseResponse&&req.url==='/api/v1/receipts'&&reply.statusCode===200){loseResponse=false;reply.raw.destroy();console.log('TEST: receipt committed; response dropped');}
 return payload;
});
await app.listen({host:'127.0.0.1',port:3000});console.log('Isolated CLARA test preview ready');
for(const signal of ['SIGINT','SIGTERM'] as const)process.on(signal,async()=>{await app.close();await env.stop();process.exit(0);});
