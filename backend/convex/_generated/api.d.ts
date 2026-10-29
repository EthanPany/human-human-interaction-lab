/* eslint-disable */
/**
 * Generated `api` utility.
 *
 * THIS CODE IS AUTOMATICALLY GENERATED.
 *
 * To regenerate, run `npx convex dev`.
 * @module
 */

import type * as agent from "../agent.js";
import type * as badge from "../badge.js";
import type * as cloudAgent from "../cloudAgent.js";
import type * as conversations from "../conversations.js";
import type * as crons from "../crons.js";
import type * as event from "../event.js";
import type * as lib_activity from "../lib/activity.js";
import type * as lib_agentCore from "../lib/agentCore.js";
import type * as lib_avatar from "../lib/avatar.js";
import type * as lib_claude from "../lib/claude.js";
import type * as lib_constants from "../lib/constants.js";
import type * as lib_embeddings from "../lib/embeddings.js";
import type * as lib_pairs from "../lib/pairs.js";
import type * as lib_phone from "../lib/phone.js";
import type * as lib_photonApi from "../lib/photonApi.js";
import type * as lib_rescore from "../lib/rescore.js";
import type * as lib_rubric from "../lib/rubric.js";
import type * as lib_scoring from "../lib/scoring.js";
import type * as lib_texts from "../lib/texts.js";
import type * as matching from "../matching.js";
import type * as nearby from "../nearby.js";
import type * as notify from "../notify.js";
import type * as outbox from "../outbox.js";
import type * as people from "../people.js";
import type * as seed from "../seed.js";
import type * as testing from "../testing.js";
import type * as users from "../users.js";

import type {
  ApiFromModules,
  FilterApi,
  FunctionReference,
} from "convex/server";

declare const fullApi: ApiFromModules<{
  agent: typeof agent;
  badge: typeof badge;
  cloudAgent: typeof cloudAgent;
  conversations: typeof conversations;
  crons: typeof crons;
  event: typeof event;
  "lib/activity": typeof lib_activity;
  "lib/agentCore": typeof lib_agentCore;
  "lib/avatar": typeof lib_avatar;
  "lib/claude": typeof lib_claude;
  "lib/constants": typeof lib_constants;
  "lib/embeddings": typeof lib_embeddings;
  "lib/pairs": typeof lib_pairs;
  "lib/phone": typeof lib_phone;
  "lib/photonApi": typeof lib_photonApi;
  "lib/rescore": typeof lib_rescore;
  "lib/rubric": typeof lib_rubric;
  "lib/scoring": typeof lib_scoring;
  "lib/texts": typeof lib_texts;
  matching: typeof matching;
  nearby: typeof nearby;
  notify: typeof notify;
  outbox: typeof outbox;
  people: typeof people;
  seed: typeof seed;
  testing: typeof testing;
  users: typeof users;
}>;

/**
 * A utility for referencing Convex functions in your app's public API.
 *
 * Usage:
 * ```js
 * const myFunctionReference = api.myModule.myFunction;
 * ```
 */
export declare const api: FilterApi<
  typeof fullApi,
  FunctionReference<any, "public">
>;

/**
 * A utility for referencing Convex functions in your app's internal API.
 *
 * Usage:
 * ```js
 * const myFunctionReference = internal.myModule.myFunction;
 * ```
 */
export declare const internal: FilterApi<
  typeof fullApi,
  FunctionReference<any, "internal">
>;

export declare const components: {};
