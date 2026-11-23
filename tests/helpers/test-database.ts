import { Database, type Statement } from "bun:sqlite";

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

export function closeTestDatabases(): void {
  for (const db of [...openDatabases.keys()]) db.close();
}
