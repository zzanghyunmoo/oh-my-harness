declare module "tar-stream" {
  import type { Readable, Writable } from "node:stream";

  export interface Headers {
    readonly mode?: number;
    readonly name: string;
    readonly type?: string;
  }

  export interface Extract extends Writable {
    on(event: "entry", listener: (header: Headers, stream: Readable, next: () => void) => void): this;
  }

  const tar: {
    extract(): Extract;
  };
  export default tar;
}
