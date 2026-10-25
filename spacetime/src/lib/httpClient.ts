import type { ProcedureCtx } from "spacetimedb/server";

/** `ctx.http` in procedures and HTTP handlers (synchronous fetch). */
export type HttpClient = ProcedureCtx<any>["http"];
