import EmbeddedPostgres from 'embedded-postgres';
import { randomBytes } from 'node:crypto';
import { resolve } from 'node:path';
import { makePool } from '../src/db.js';
import { migrate } from '../src/migrate.js';
import { bootstrap } from '../src/bootstrap.js';
export async function database(port=55439) {
 const password=randomBytes(20).toString('hex');
 const embedded=new EmbeddedPostgres({databaseDir:resolve('.test-pg/run-'+Date.now()+'-'+port),user:'postgres',password,port,persistent:true,initdbFlags:['--encoding=UTF8','--locale=C'],postgresFlags:['-h','127.0.0.1'],onLog:()=>{},onError:()=>{}});
 let url=process.env.TEST_DATABASE_URL;
 if(!url){await embedded.initialise();await embedded.start();await embedded.createDatabase('clara_test');url=`postgres://postgres:${password}@127.0.0.1:${port}/clara_test`;}
 const admin=makePool(url);const name='clara_test_'+randomBytes(8).toString('hex');
 await admin.query('CREATE SCHEMA '+name);
 const target=new URL(url!);target.searchParams.set('options','-c search_path='+name);
 const db=makePool(target.href);await migrate(db);await migrate(db);await bootstrap(db,'owner','test-password-12345');
 return {db,url:target.href,embedded,stop:async()=>{await db.end();await admin.query('DROP SCHEMA '+name+' CASCADE');await admin.end();if(!process.env.TEST_DATABASE_URL)await embedded.stop();}};
}
