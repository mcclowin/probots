declare module "sql.js" {
  interface Database {
    run(sql: string, params?: any[]): void;
    exec(sql: string, params?: any[]): { columns: string[]; values: any[][] }[];
    export(): Uint8Array;
    close(): void;
  }

  interface SqlJsStatic {
    Database: new (data?: ArrayLike<number>) => Database;
  }

  export type { Database, SqlJsStatic };
  export default function initSqlJs(config?: any): Promise<SqlJsStatic>;
}
