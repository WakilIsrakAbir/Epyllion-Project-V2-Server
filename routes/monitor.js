/* Atlas Monitor API (/api/monitor) for Data Management > Atlas Monitor.
   GET /stats  : database health (sizes against the Atlas free-tier limit, collections, orders, plans,
                 uploads, daily history, last backup). Admin, or the menus.dataManagement.atlasMonitor permission.
   GET /backup : the whole database as one gzip file, one document per line (Admin only).
   Reads everything; writes only two small collections: monitorsnapshots (one reading per day)
   and backuplogs (one line per backup). Restore with scripts/restore-backup.js. */
const express = require('express');
const zlib = require('zlib');
const mongoose = require('mongoose');
const { authenticateToken, requireAdmin } = require('../middleware/auth');
const S = require('../lib/batch/source');

const router = express.Router();
router.use(authenticateToken);

const { EJSON } = mongoose.mongo.BSON;
// Atlas counts data size + index size against this limit (free tier: 512 MB).
const LIMIT_BYTES = (Number(process.env.ATLAS_STORAGE_LIMIT_MB) || 512) * 1024 * 1024;
const DEPTS = ['yd', 'knitting', 'dyeing', 'finishing', 'delivery'];
const SNAPSHOTS = 'monitorsnapshots';
const BACKUP_LOGS = 'backuplogs';
const BACKUP_FORMAT = 'abir-backup';
const HISTORY_DAYS = 180;

const dhaka = (d = new Date()) => new Date(d.getTime() + 6 * 3600e3); // Bangladesh time, no DST
const dhakaDay = d => dhaka(d).toISOString().slice(0, 10);

function requireMonitorAccess(req, res, next) {
  if (S.can(req.user, 'menus.dataManagement.atlasMonitor')) return next();
  return res.status(403).json({ message: 'Access forbidden: Atlas Monitor permission required.' });
}

function liveDb(res) {
  if (mongoose.connection.readyState !== 1 || !mongoose.connection.db) {
    res.status(503).json({ message: 'Database not ready. Please try again.' });
    return null;
  }
  return mongoose.connection.db;
}

async function collectionNames(db) {
  return (await db.listCollections({}, { nameOnly: true }).toArray())
    .map(c => c.name).filter(n => !n.startsWith('system.')).sort();
}

// ==========================================
// GET /api/monitor/stats
// ==========================================
router.get('/stats', requireMonitorAccess, async (req, res) => {
  const db = liveDb(res);
  if (!db) return;
  try {
    const now = new Date();
    const [st, build] = await Promise.all([
      db.command({ dbStats: 1 }),
      db.admin().command({ buildInfo: 1 }).catch(() => ({}))
    ]);
    // One reading per day (Bangladesh date): today's is updated each time the page loads.
    // Saved first, so the very first call already lists the monitorsnapshots collection.
    const today = dhakaDay(now);
    await db.collection(SNAPSHOTS).updateOne({ day: today }, {
      $set: { day: today, at: now, dataSize: st.dataSize, indexSize: st.indexSize, storageSize: st.storageSize, objects: st.objects }
    }, { upsert: true });
    const names = await collectionNames(db);

    const collections = await Promise.all(names.map(async name => {
      const s = await db.command({ collStats: name }).catch(() => null);
      return {
        name,
        count: s ? s.count : await db.collection(name).estimatedDocumentCount(),
        size: s ? s.size : 0,
        storageSize: s ? s.storageSize : 0,
        freeStorageSize: s && s.freeStorageSize ? s.freeStorageSize : 0,
        indexSize: s ? s.totalIndexSize : 0,
        indexes: s ? s.nindexes : 0
      };
    }));

    // Orders and plan status per department, with the same filters as the plan list pages.
    const orders = db.collection('orders');
    const valid = Object.fromEntries((await db.collection('deptvalidorders')
      .find({}, { projection: { dept: 1, validOrderNos: 1 } }).toArray())
      .map(d => [d.dept, d.validOrderNos || []]));
    const departments = {};
    await Promise.all(DEPTS.map(async dept => {
      const match = { [dept + 'Items.0']: { $exists: true } };
      if (valid[dept] && valid[dept].length) match.orderNo = { $in: valid[dept] };
      const groups = await orders.aggregate([{ $match: match }, { $group: { _id: '$' + dept + 'PlanStatus', n: { $sum: 1 } } }]).toArray();
      const counts = { Confirm: 0, Tentative: 0, Pending: 0, Completed: 0 };
      for (const g of groups) {
        if (g._id === 'Confirm' || g._id === 'Tentative' || g._id === 'Completed') counts[g._id] += g.n;
        else counts.Pending += g.n; // Pending, empty or missing, as the Pending tab shows them
      }
      departments[dept] = counts;
    }));
    const generalValid = valid.general || [];
    const orderDates = db.collection('orderdates');
    const [ordersTotal, ordersActive, savedPlans, usersTotal, usersOnline] = await Promise.all([
      orders.estimatedDocumentCount(),
      generalValid.length ? orders.countDocuments({ orderNo: { $in: generalValid } }) : orders.estimatedDocumentCount(),
      orderDates.estimatedDocumentCount(),
      db.collection('users').estimatedDocumentCount(),
      db.collection('users').countDocuments({ lastActive: { $gte: new Date(now.getTime() - 3 * 60 * 1000) } })
    ]);
    const completed = {};
    await Promise.all(DEPTS.map(async dept => { completed[dept] = await orderDates.countDocuments({ [dept + 'Status']: 'Completed' }); }));

    // Uploads: history per category, file copies kept, uploads per day (last 30 days)
    const files = db.collection('files');
    const history = await files.aggregate([
      { $sort: { createdAt: -1 } },
      { $group: {
        _id: { $ifNull: ['$category', 'General'] },
        uploads: { $sum: 1 },
        copiesDeleted: { $sum: { $cond: [{ $eq: ['$blobDeleted', true] }, 1, 0] } },
        lastAt: { $first: '$createdAt' }, lastBy: { $first: '$uploadedBy' }, lastName: { $first: '$originalName' }
      } }
    ]).toArray();
    const copies = await db.collection('uploads.files').aggregate([
      { $group: { _id: { $ifNull: ['$metadata.category', 'General'] }, copies: { $sum: 1 }, bytes: { $sum: '$length' } } }
    ]).toArray();
    const copyBy = new Map(copies.map(c => [c._id, c]));
    const categories = history.map(h => ({
      category: h._id, uploads: h.uploads, copiesDeleted: h.copiesDeleted,
      copiesKept: copyBy.get(h._id) ? copyBy.get(h._id).copies : 0,
      copyBytes: copyBy.get(h._id) ? copyBy.get(h._id).bytes : 0,
      lastAt: h.lastAt, lastBy: h.lastBy || '', lastName: h.lastName || ''
    })).sort((a, b) => a.category.localeCompare(b.category));
    const since = new Date(dhaka(now).toISOString().slice(0, 10) + 'T00:00:00+06:00');
    since.setUTCDate(since.getUTCDate() - 29);
    const perDayRaw = await files.aggregate([
      { $match: { createdAt: { $gte: since } } },
      { $group: { _id: { day: { $dateToString: { date: '$createdAt', format: '%Y-%m-%d', timezone: '+06:00' } }, category: { $ifNull: ['$category', 'General'] } }, n: { $sum: 1 } } }
    ]).toArray();
    const perDay = [];
    for (let i = 0; i < 30; i++) {
      const day = dhakaDay(new Date(since.getTime() + i * 86400e3));
      const byCategory = {};
      perDayRaw.filter(r => r._id.day === day).forEach(r => { byCategory[r._id.category] = r.n; });
      perDay.push({ day, total: Object.values(byCategory).reduce((a, n) => a + n, 0), byCategory });
    }

    const sinceDay = dhakaDay(new Date(now.getTime() - HISTORY_DAYS * 86400e3));
    const snapshots = await db.collection(SNAPSHOTS).find({ day: { $gte: sinceDay } }, { projection: { _id: 0 } }).sort({ day: 1 }).toArray();

    const [lastBackup, backupCount] = await Promise.all([
      db.collection(BACKUP_LOGS).find({ ok: true }, { projection: { _id: 0 } }).sort({ at: -1 }).limit(1).next(),
      db.collection(BACKUP_LOGS).countDocuments({ ok: true })
    ]);

    res.set('Cache-Control', 'no-store');
    res.json({
      generatedAt: now,
      canDownloadBackup: S.isAdmin(req.user),
      database: {
        name: db.databaseName, serverVersion: build.version || '',
        dataSize: st.dataSize, indexSize: st.indexSize, storageSize: st.storageSize,
        freeStorageSize: collections.reduce((a, c) => a + c.freeStorageSize, 0),
        objects: st.objects, collections: names.length, limitBytes: LIMIT_BYTES
      },
      collections,
      orders: { total: ordersTotal, active: ordersActive, departments },
      plans: { saved: savedPlans, completed },
      users: { total: usersTotal, online: usersOnline },
      uploads: { categories, perDay },
      history: snapshots,
      backups: { last: lastBackup || null, count: backupCount }
    });
  } catch (error) {
    console.error('Monitor stats error:', error);
    res.status(500).json({ message: 'Could not load database stats.' });
  }
});

// ==========================================
// GET /api/monitor/backup?files=1|0
// Line 1: header (collections, indexes). Then {"c":collection,"d":document} per line (Extended JSON,
// canonical, so every type survives). Last line: {"type":"end","counts":{...}}. A file without the
// end line is incomplete. files=0 leaves out uploads.files/uploads.chunks (the stored Excel copies).
// ==========================================
router.get('/backup', requireAdmin, async (req, res) => {
  const db = liveDb(res);
  if (!db) return;
  const started = new Date();
  const includeFiles = req.query.files !== '0';
  const log = { at: started, by: req.user.username || '', includesExcelFiles: includeFiles, ok: false };
  // The browser closed the download before it finished (res, not req: a GET request's own stream closes early).
  let aborted = false;
  res.on('close', () => { if (!res.writableFinished) aborted = true; });
  // Resolves on the stream event or when the connection closes, so a cancelled download never hangs the cursor.
  const until = (emitter, event) => new Promise(resolve => {
    const done = () => { emitter.off(event, done); res.off('close', done); resolve(); };
    emitter.once(event, done); res.once('close', done);
  });

  let gzip;
  try {
    const names = (await collectionNames(db)).filter(n => includeFiles || !n.startsWith('uploads.'));
    const collections = await Promise.all(names.map(async name => ({
      name,
      estimatedCount: await db.collection(name).estimatedDocumentCount(),
      indexes: (await db.collection(name).indexes()).filter(i => i.name !== '_id_')
    })));
    const stamp = dhaka(started).toISOString().slice(0, 16).replace('T', '_').replace(':', '');
    const filename = `${db.databaseName}_backup_${stamp}${includeFiles ? '' : '_no-files'}.jsonl.gz`;
    res.set({
      'Content-Type': 'application/gzip',
      'Content-Disposition': `attachment; filename="${filename}"`,
      'Cache-Control': 'no-store',
      'Access-Control-Expose-Headers': 'Content-Disposition'
    });

    gzip = zlib.createGzip({ level: 6 });
    let bytes = 0;
    gzip.on('data', chunk => { bytes += chunk.length; });
    gzip.pipe(res);
    const write = async line => { if (!gzip.write(line + '\n') && !aborted) await until(gzip, 'drain'); };

    await write(JSON.stringify({
      type: 'header', format: BACKUP_FORMAT, version: 1, database: db.databaseName,
      createdAt: started.toISOString(), createdBy: log.by, includesExcelFiles: includeFiles, collections
    }));
    const counts = {};
    for (const name of names) {
      counts[name] = 0;
      const cursor = db.collection(name).find({}, { batchSize: 1000 }); // fewer round trips to Atlas
      for await (const doc of cursor) {
        if (aborted) { await cursor.close(); break; }
        await write('{"c":' + JSON.stringify(name) + ',"d":' + EJSON.stringify(doc, { relaxed: false }) + '}');
        counts[name]++;
      }
      if (aborted) break;
    }
    if (aborted) { gzip.destroy(); throw new Error('Download cancelled by the browser'); }
    await write(JSON.stringify({ type: 'end', counts, finishedAt: new Date().toISOString() }));
    const finished = until(res, 'finish');
    gzip.end();
    await finished;
    if (aborted) throw new Error('Download cancelled by the browser');
    Object.assign(log, { ok: true, bytes, counts, durationMs: Date.now() - started.getTime(), finishedAt: new Date() });
  } catch (error) {
    console.error('Backup error:', error.message);
    log.error = error.message;
    if (!res.headersSent) res.status(500).json({ message: 'Backup failed: ' + error.message });
    else if (gzip && !gzip.destroyed) gzip.end(); // the file has no end line, so it is marked incomplete
  } finally {
    await db.collection(BACKUP_LOGS).insertOne(log).catch(e => console.error('Backup log not saved:', e.message));
  }
});

module.exports = router;
