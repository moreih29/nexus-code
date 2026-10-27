/**
 * bun:sqlite databases for tests that keep storage in real files.
 *
 * The app runs better-sqlite3, whose close() finalizes every statement the
 * connection prepared. bun:sqlite's close() leaves the connection open until
 * those statements are garbage-collected, and Windows cannot delete a file
 * that is still open: removing the test's temp directory failed with EBUSY.
 * A database from openTestDatabase finalizes its statements on close, as
 * better-sqlite3 does, and closeTestDatabases closes those a test left open.
 */
import { Database, type Statement } from "bun:sqlite";

/** Each open database, with the statements it prepared. */
const openDatabases = new Map<Database, Set<Statement>>();

export function openTestDatabase(filename: string): Database {
  const db = new Database(filename);
  const statements = new Set<Statement>();
  openDatabases.set(db, statements);

  const prepare = db.prepare.bind(db);
  db.prepare = ((...args: Parameters<typeof prepare>) => {
    const statement = prepare(...args);
    statements.add(statement);
    return statement;
  }) as typeof db.prepare;

  const close = db.close.bind(db);
  db.close = (throwOnError?: boolean) => {
    for (const statement of statements) statement.finalize();
    statements.clear();
    openDatabases.delete(db);
    close(throwOnError);
  };
  return db;
}

/** Closes every database from openTestDatabase that is still open. */
export function closeTestDatabases(): void {
  for (const db of [...openDatabases.keys()]) db.close();
}
