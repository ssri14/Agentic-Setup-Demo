/**
 * One-time provisioning, run with the MongoDB administrator's credentials:
 * creates or updates the least-privilege `agent` user that the web app connects as.
 * It can read every database (mission data and the registry) and write only agent_app.
 */
import { MongoClient } from 'mongodb';

const host = process.env.MONGO_HOST ?? 'localhost';
const adminPassword = process.env.MONGO_ADMIN_PASSWORD;
const agentPassword = process.env.AGENT_MONGO_PASSWORD;
const appDatabase = process.env.AGENT_DATABASE ?? 'agent_app';
if (!adminPassword || !agentPassword) {
  console.error('MONGO_ADMIN_PASSWORD and AGENT_MONGO_PASSWORD are required');
  process.exit(1);
}
const client = new MongoClient(`mongodb://ingestion:${encodeURIComponent(adminPassword)}@${host}:27017/?authSource=admin`, { serverSelectionTimeoutMS: 15_000 });
await client.connect();
const admin = client.db('admin');
const roles = [{ role: 'readAnyDatabase', db: 'admin' }, { role: 'readWrite', db: appDatabase }];
const existing = await admin.command({ usersInfo: 'agent' });
if (existing.users.length) {
  await admin.command({ updateUser: 'agent', pwd: agentPassword, roles });
  console.log('Updated MongoDB user "agent"');
} else {
  await admin.command({ createUser: 'agent', pwd: agentPassword, roles });
  console.log('Created MongoDB user "agent"');
}
await client.close();
