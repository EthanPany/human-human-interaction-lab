import type { Tx } from "../schema";

/**
 * What every API function gets: the transaction, plus how to turn a stored
 * photo id into a public link (photos are served by GET /photo?id=...).
 */
export type Ctx = {
  tx: Tx;
  photoUrl(photoId: string | undefined): string | null;
};

export type ApiFn = (ctx: Ctx, args: any) => unknown;

/** Read an argument the way Convex validators would. */
export function str(args: Record<string, unknown>, key: string): string {
  const v = args[key];
  if (typeof v !== "string") throw new ArgError(`Argument ${key} must be a string`);
  return v;
}

export function optStr(args: Record<string, unknown>, key: string): string | undefined {
  const v = args[key];
  if (v === undefined || v === null) return undefined;
  if (typeof v !== "string") throw new ArgError(`Argument ${key} must be a string`);
  return v;
}

export function num(args: Record<string, unknown>, key: string): number {
  const v = args[key];
  if (typeof v !== "number" || !Number.isFinite(v)) throw new ArgError(`Argument ${key} must be a number`);
  return v;
}

/** Bad arguments (the app treats "validat" errors on a stale id as "sign in again"). */
export class ArgError extends Error {
  constructor(message: string) {
    super(`ArgumentValidationError: ${message}`);
  }
}
