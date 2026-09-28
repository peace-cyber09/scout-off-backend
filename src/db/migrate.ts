import fs from 'fs';
import path from 'path';
import { DbDriver } from './driver';
import config from '../config';

const MIGRATIONS_DIR = path.resolve(__dirname, '../../db');

export function getAppliedMigrations(driver: DbDriver): string[] {
  // Ensure migrations table exists first
  const createMigrationsTableSql =
    config.dbDriver === 'postgres'
      ? 'CREATE TABLE IF NOT EXISTS migrations (id TEXT PRIMARY KEY, applied_at BIGINT NOT NULL)'
      : `CREATE TABLE IF NOT EXISTS migrations (id TEXT PRIMARY KEY, applied_at INTEGER NOT NULL)`;

  driver.exec(createMigrationsTableSql);

  const rows = driver.all<{ id: string }>(
    'SELECT id FROM migrations ORDER BY id'
  );
  
  return rows.map(row => row.id);
}

export function getExpectedSchemaVersion(): { migrations: string[] } {
  const files = fs
    .readdirSync(MIGRATIONS_DIR)
    .filter((f) => f.endsWith('.sql') && !f.includes('_postgres'))
    .sort();

  return { migrations: files };
}

export function runMigrations(driver: DbDriver): void {
  const applied = getAppliedMigrations(driver);
  const files = fs
    .readdirSync(MIGRATIONS_DIR)
    .filter((f) => f.endsWith('.sql') && !f.includes('_postgres'))
    .sort();

  for (const file of files) {
    if (applied.includes(file)) continue;

    let sql = fs.readFileSync(path.join(MIGRATIONS_DIR, file), 'utf8');

    // For PostgreSQL migrations, use the _postgres version if available
    if (config.dbDriver === 'postgres') {
      const postgresFile = file.replace('.sql', '_postgres.sql');
      const postgresPath = path.join(MIGRATIONS_DIR, postgresFile);
      if (fs.existsSync(postgresPath)) {
        sql = fs.readFileSync(postgresPath, 'utf8');
      } else {
        // Fall back to converting SQLite SQL to PostgreSQL
        sql = convertSqlToPostgres(sql);
      }
    }

    driver.transaction(() => {
      driver.exec(sql);
      driver.run('INSERT INTO migrations (id, applied_at) VALUES (?, ?)', [
        file,
        Date.now(),
      ]);
    });
  }
}

/**
 * Convert SQLite SQL to PostgreSQL SQL.
 * Handles common dialect differences.
 */
function convertSqlToPostgres(sql: string): string {
  let converted = sql;

  // Replace AUTOINCREMENT with SERIAL
  converted = converted.replace(
    /INTEGER PRIMARY KEY AUTOINCREMENT/gi,
    'SERIAL PRIMARY KEY'
  );

  // Replace INSERT OR IGNORE with ON CONFLICT DO NOTHING
  converted = converted.replace(
    /INSERT OR IGNORE INTO/gi,
    'INSERT INTO'
  );

  // Add ON CONFLICT clause for INSERT ... INTO that would have had OR IGNORE
  // This is a heuristic: if we see INSERT INTO after OR IGNORE removal and
  // there's a UNIQUE constraint, assume ON CONFLICT DO NOTHING is needed
  if (!converted.includes('ON CONFLICT')) {
    converted = converted.replace(
      /INSERT INTO ([a-z_]+) \(([^)]+)\) VALUES/gi,
      (match, table, columns) => {
        // Try to detect if this needs ON CONFLICT based on common patterns
        if (sql.includes('INSERT OR IGNORE')) {
          return match + ' ON CONFLICT DO NOTHING ';
        }
        return match;
      }
    );
  }

  // Replace datetime('now') with now()
  converted = converted.replace(/datetime\('now'\)/gi, "now()");

  return converted;
}
