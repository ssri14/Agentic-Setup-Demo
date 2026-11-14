import { buildApp, bootstrapSuperuser } from './app.js';
import { loadConfig } from './config.js';
import { MongoStore } from './store/mongo.js';
import { AgentRunner } from './agent/runner.js';
import { budgetsFromEnv } from './agent/graph.js';
import { OpenAICompatibleModel, providersFromEnv } from './agent/llm.js';
import { currentModelSettings } from './app.js';
import { HttpEmbedder, HttpSandbox, InfluxTimeSeries, MongoSource, Neo4jGraph, QdrantVectors, type Sources } from './tools/sources.js';

const config = loadConfig();
const store = new MongoStore(config.mongoUri, config.appDatabase, config.registryDatabase);

for (let attempt = 1; ; attempt++) {
  try { await store.init(); break; } catch (error) {
    if (attempt >= 30) throw error;
    console.error(`MongoDB not ready (${(error as Error).message}); retrying in 2 s`);
    await new Promise((r) => setTimeout(r, 2000));
  }
}
const mongoSource = new MongoSource(store.mongoClient);
const graph = new Neo4jGraph(config.neo4jUri, config.neo4jPassword);
const sources: Sources = {
  mongo: (name) => mongoSource.mongo(name), graph, vectors: new QdrantVectors(config.qdrantUrl), embedder: new HttpEmbedder(config.embedUrl),
  timeseries: new InfluxTimeSeries(config.influxUrl, config.influxTokenFile, config.influxToken), sandbox: new HttpSandbox(config.sandboxUrl),
};
const providers = providersFromEnv();
const settings = () => currentModelSettings(store, providers);
const runner = new AgentRunner(store, sources, new OpenAICompatibleModel(providers, settings), settings, budgetsFromEnv());
const interrupted = await store.runs.markUnfinished('interrupted', 'The server restarted while this question was in progress');
const app = await buildApp(store, config, sources, { runner, providers });
if (interrupted) app.log.warn(`${interrupted} unfinished runs were marked interrupted`);
if (!providers.length) app.log.warn('No language model configured: set LLM_BASE_URL, OPENROUTER_API_KEY or GROQ_API_KEY');
await bootstrapSuperuser(store, config, (msg) => app.log.info(msg));
await app.listen({ port: config.port, host: config.host });

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, async () => { await app.close(); await graph.close(); await store.close(); process.exit(0); });
}
