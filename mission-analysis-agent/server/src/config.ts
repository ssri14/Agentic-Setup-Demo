/** Runtime configuration from the environment. Nothing secret has a default. */
export interface Config {
  port: number;
  host: string;
  mongoUri: string;
  appDatabase: string;
  registryDatabase: string;
  adminUser?: string;
  adminPassword?: string;
  sessionIdleMinutes: number;
  secureCookies: boolean;
  clientDir: string;
  influxUrl: string;
  influxTokenFile: string;
  influxToken?: string;
  qdrantUrl: string;
  neo4jUri: string;
  neo4jPassword: string;
  embedUrl: string;
  sandboxUrl: string;
}

export function loadConfig(env = process.env): Config {
  const password = env.AGENT_MONGO_PASSWORD;
  const host = env.MONGO_HOST ?? 'localhost';
  const mongoUri = env.AGENT_MONGO_URI ?? (password
    ? `mongodb://agent:${encodeURIComponent(password)}@${host}:27017/?authSource=admin`
    : `mongodb://${host}:27017/`);
  return {
    port: Number(env.PORT ?? 8095),
    host: env.HOST ?? '0.0.0.0',
    mongoUri,
    appDatabase: env.AGENT_DATABASE ?? 'agent_app',
    registryDatabase: env.REGISTRY_DATABASE ?? 'mission_registry',
    adminUser: env.AGENT_ADMIN_USER,
    adminPassword: env.AGENT_ADMIN_PASSWORD,
    sessionIdleMinutes: Number(env.SESSION_IDLE_MINUTES ?? 480),
    secureCookies: env.SECURE_COOKIES === 'true',
    clientDir: env.CLIENT_DIR ?? new URL('../client', import.meta.url).pathname,
    influxUrl: env.INFLUX_URL ?? 'http://localhost:8181',
    influxTokenFile: env.INFLUX_TOKEN_FILE ?? 'secrets/influx-admin.json',
    influxToken: env.INFLUX_TOKEN || undefined,
    qdrantUrl: env.QDRANT_URL ?? 'http://localhost:6333',
    neo4jUri: env.NEO4J_URI ?? 'bolt://localhost:7687',
    neo4jPassword: env.NEO4J_PASSWORD ?? '',
    embedUrl: env.EMBED_URL ?? 'http://localhost:8090/api/embed',
    sandboxUrl: env.SANDBOX_URL ?? 'http://localhost:8097',
  };
}
