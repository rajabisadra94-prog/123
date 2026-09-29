// دیتابیس محلی بدون نیاز به نصب PostgreSQL: با npm دانلود می‌شود و داده‌ها در پوشهٔ .pgdata می‌مانند.
// اجرا: node scripts/embedded-db.mjs   (پنجره باز بماند)
import EmbeddedPostgres from 'embedded-postgres';
import pg from 'pg';
import copyStreams from 'pg-copy-streams';
import fs from 'fs';
import zlib from 'zlib';
import readline from 'readline';
import path from 'path';
import { fileURLToPath } from 'url';

const here = path.dirname(fileURLToPath(import.meta.url));
const dataDir = path.resolve(here, '..', '.pgdata');
const dumpPath = path.resolve(here, '..', '..', 'staging_db_dump.sql.gz');
const port = Number(process.env.PGPORT_LOCAL || 5432);
const DB = 'factory_local';

const readyFlag = path.join(dataDir, '..', '.pgready');
fs.rmSync(readyFlag, { force: true });
const server = new EmbeddedPostgres({ databaseDir: dataDir, user: 'factory_user', password: 'factory_pass', port, persistent: true, initdbFlags: ['--encoding=UTF8', '--locale=C'] });
const fresh = !fs.existsSync(path.join(dataDir, 'PG_VERSION'));
if (fresh) await server.initialise();
await server.start();
if (fresh) await server.createDatabase(DB);

const client = new pg.Client({ host: 'localhost', port, user: 'factory_user', password: 'factory_pass', database: DB });
await client.connect();
const has = await client.query(`SELECT to_regclass('public."User"') AS t`);
if (!has.rows[0].t) {
  // دامپ به نقش «postgres» اشاره می‌کند؛ اگر نبود بساز
  await client.query(`DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname='postgres') THEN CREATE ROLE postgres SUPERUSER; END IF; END $$`);
  console.log('در حال ریختن دیتابیس نمونه (چند دقیقه صبر کنید)...');
  await importDump(client);
  console.log('دیتابیس نمونه ریخته شد.');
}
await client.end();
fs.writeFileSync(readyFlag, 'ok');
console.log(`\nدیتابیس آماده است (پورت ${port}). این پنجره را باز نگه دارید.`);

// دامپ psql: دستورهای معمولی را اجرا می‌کند و بلوک‌های COPY ... FROM stdin را با جریان COPY وارد می‌کند
async function importDump(c) {
  const rl = readline.createInterface({ input: fs.createReadStream(dumpPath).pipe(zlib.createGunzip()), crlfDelay: Infinity });
  let buf = [];
  let copy = null; // { stream }
  const flush = async () => { const sql = buf.join('\n').trim(); buf = []; if (sql) await c.query(sql); };
  for await (const line of rl) {
    if (copy) {
      if (line === '\\.') { copy.stream.end(); await copy.done; copy = null; continue; }
      if (!copy.stream.write(line + '\n')) await new Promise((r) => copy.stream.once('drain', r));
      continue;
    }
    if (line.startsWith('\\')) continue; // \restrict و \unrestrict
    if (/^COPY .* FROM stdin;$/.test(line)) {
      await flush();
      const stream = c.query(copyStreams.from(line.replace(/;$/, '')));
      copy = { stream, done: new Promise((res, rej) => { stream.on('finish', res); stream.on('error', rej); }) };
      continue;
    }
    buf.push(line);
  }
  await flush();
}

process.on('SIGINT', async () => { await server.stop(); process.exit(0); });
setInterval(() => {}, 1 << 30); // پنجره باز بماند تا سرور کار کند
