const mongoose = require('mongoose');
const { AsyncLocalStorage } = require('async_hooks');
const { SITE_TYPES, DEFAULT_SITE, normalizeSite } = require('./sites');

const CONNECT_OPTS = {
  maxPoolSize: 15,
  minPoolSize: 5,
  serverSelectionTimeoutMS: 5000,
  socketTimeoutMS: 45000,
  retryWrites: true,
};

// A site's own cluster is often a smaller tier that can take ten seconds or more
// to accept the first connection, so it gets a longer window than the main one.
const SECONDARY_CONNECT_OPTS = { ...CONNECT_OPTS, serverSelectionTimeoutMS: 20000 };

// ─────────────────────────────────────────────────────────────────────────────
// Which database each site uses
//
// 'main' is mongoose's default connection (MONGODB_URI). A site listed in
// SITE_DB_ENV gets its own connection when that env var is set; otherwise it
// shares the main database and is separated by the `siteType` field only.
// ─────────────────────────────────────────────────────────────────────────────
const SITE_DB_ENV = { vk: 'VK_MONGODB_URI' };

const connections = { main: mongoose.connection }; // dbKey    -> Connection
const siteDbKey = {};                               // siteType -> dbKey
for (const site of SITE_TYPES) siteDbKey[site] = 'main';

const dbKeyForSite = (siteType) => siteDbKey[normalizeSite(siteType)] || 'main';
const connectionForSite = (siteType) => connections[dbKeyForSite(siteType)];
const isMainDb = (siteType) => dbKeyForSite(siteType) === 'main';

// One representative site per database — crons run once per database, not per site.
const distinctDbSites = () => {
  const seen = new Set();
  return SITE_TYPES.filter((site) => {
    const key = dbKeyForSite(site);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
};

// ─────────────────────────────────────────────────────────────────────────────
// Request context: which site the current async call chain belongs to
//
// The Express middleware (middleware/siteContext.js) and the socket layer call
// runWithSite() once per request / event; everything awaited inside inherits it.
// ─────────────────────────────────────────────────────────────────────────────
const siteStore = new AsyncLocalStorage();
const runWithSite = (siteType, fn) => siteStore.run({ siteType: normalizeSite(siteType) }, fn);
const currentSite = () => siteStore.getStore()?.siteType || DEFAULT_SITE;

// ─────────────────────────────────────────────────────────────────────────────
// Routed models
//
// routedModel(name, schema) compiles the schema on the main connection and
// returns a proxy. Each property access resolves to the model compiled on the
// connection of the CURRENT site, so controllers keep writing
// `User.findOne(...)` / `new User(...)` unchanged and hit the right database.
// ─────────────────────────────────────────────────────────────────────────────
const schemas = {}; // name -> Schema (so extra connections can compile everything up front)

const modelOn = (conn, name) => conn.models[name] || conn.model(name, schemas[name]);

const routedModel = (name, schema) => {
  schemas[name] = schema;
  const mainModel = mongoose.model(name, schema);

  const resolve = () => {
    const conn = connectionForSite(currentSite());
    return conn === mongoose.connection ? mainModel : modelOn(conn, name);
  };

  return new Proxy(mainModel, {
    get(_target, prop) {
      const model = resolve();
      const value = Reflect.get(model, prop, model);
      return typeof value === 'function' ? value.bind(model) : value;
    },
    construct(_target, args) {
      const Model = resolve();
      return new Model(...args);
    },
    has(_target, prop) {
      return prop in resolve();
    },
    getPrototypeOf() {
      return Object.getPrototypeOf(resolve());
    },
  });
};

// ─────────────────────────────────────────────────────────────────────────────
// Startup maintenance (runs once per database)
// ─────────────────────────────────────────────────────────────────────────────
const runMaintenance = async (conn, defaultSite) => {
  try {
    // Drop stale single-field unique indexes so Mongoose can recreate the
    // compound { field, siteType } ones
    const users = conn.db.collection('users');
    const indexes = await users.indexes();
    for (const name of ['phone_1', 'email_1']) {
      if (indexes.find((i) => i.name === name)) {
        await users.dropIndex(name);
        console.log(`[DB:${conn.name}] Dropped stale index: ${name}`);
      }
    }

    // Tag documents created before siteType existed so site-scoped queries keep matching them
    for (const name of ['users', 'walletrequests', 'bets', 'spinnerrecords', 'ludomatches']) {
      const r = await conn.db.collection(name).updateMany(
        { siteType: { $exists: false } },
        { $set: { siteType: defaultSite } }
      );
      if (r.modifiedCount > 0) {
        console.log(`[DB:${conn.name}] Tagged ${r.modifiedCount} ${name} with siteType=${defaultSite}`);
      }
    }
  } catch (err) {
    // Collection or index may not exist yet — nothing to fix
  }
};

const connectDB = async () => {
  try {
    // Dedicated connections are registered synchronously, before any await, so
    // routing is already correct when the HTTP server takes its first request.
    for (const [site, envKey] of Object.entries(SITE_DB_ENV)) {
      const uri = process.env[envKey];
      if (!uri) {
        console.log(`[DB] ${envKey} not set — site "${site}" uses the main database (separated by siteType)`);
        continue;
      }
      const conn = mongoose.createConnection(uri, SECONDARY_CONNECT_OPTS);
      connections[site] = conn;
      siteDbKey[site] = site;

      // Compile every schema on this connection straight away. It does not need
      // the socket to be open, and it means populate()/ref lookups can never hit
      // a MissingSchemaError once traffic starts.
      for (const name of Object.keys(schemas)) modelOn(conn, name);

      // Deliberately NOT awaited. One site's database being slow or unreachable
      // must not stop the server from booting for the other sites — that would
      // take every website down at once. Mongoose keeps retrying by itself, and
      // queries for this site buffer until it is up.
      conn.asPromise()
        .then(async () => {
          console.log(`MongoDB Connected (${site}): ${conn.host}/${conn.name}`);
          await runMaintenance(conn, site);
        })
        .catch((err) => {
          console.error(`[DB] site "${site}" database is not reachable: ${err.message}`);
          console.error(`[DB] the other sites keep serving; "${site}" will recover on its own once the cluster answers.`);
        });
    }

    await mongoose.connect(process.env.MONGODB_URI, CONNECT_OPTS);
    console.log(`MongoDB Connected (main): ${mongoose.connection.host}/${mongoose.connection.name}`);
    await runMaintenance(mongoose.connection, DEFAULT_SITE);

  } catch (error) {
    // Only the main database is fatal — without it nothing can be served.
    console.error(`Error: ${error.message}`);
    process.exit(1);
  }
};

const disconnectAll = async () => {
  for (const [key, conn] of Object.entries(connections)) {
    if (key !== 'main') await conn.close();
  }
  await mongoose.disconnect();
};

module.exports = {
  connectDB,
  dbKeyForSite,
  disconnectAll,
  runWithSite,
  currentSite,
  connectionForSite,
  isMainDb,
  distinctDbSites,
  routedModel,
};
