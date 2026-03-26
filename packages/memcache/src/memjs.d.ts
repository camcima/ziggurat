declare module "memjs" {
  export interface GetResult {
    value: Buffer | null;
    flags: Buffer | null;
  }

  export interface SetOptions {
    expires?: number;
  }

  export class Client {
    static create(servers?: string, options?: Record<string, unknown>): Client;
    get(key: string): Promise<GetResult>;
    set(key: string, value: string, options?: SetOptions): Promise<boolean>;
    delete(key: string): Promise<boolean>;
    flush(): Promise<boolean>;
    close(): void;
  }
}
