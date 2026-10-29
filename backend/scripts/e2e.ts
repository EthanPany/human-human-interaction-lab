/**
 * End to end check against the deployment in .env.local, acting as two phones.
 * Uses fictional 555-01xx numbers, so no real texts go out.
 *
 *   npm run e2e
 */
import { ConvexHttpClient } from "convex/browser";
import { api } from "../convex/_generated/api";
import type { Id } from "../convex/_generated/dataModel";

const url = process.env.CONVEX_URL;
if (!url) throw new Error("CONVEX_URL missing (run npx convex dev once)");
const client = new ConvexHttpClient(url);

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
let failures = 0;
function check(label: string, ok: unknown, detail?: unknown) {
  console.log(`${ok ? "PASS" : "FAIL"}  ${label}${detail !== undefined ? `  ${JSON.stringify(detail)}` : ""}`);
  if (!ok) failures++;
}

async function main() {
  // Two people who want each other.
  const a = (await client.mutation(api.users.signIn, { phone: "+14155550190", name: "Test Alice" })) as Id<"users">;
  const b = (await client.mutation(api.users.signIn, { phone: "+14155550191", name: "Test Bob" })) as Id<"users">;
  check("sign in", a && b);
  await client.mutation(api.testing.resetTestPair, { phones: ["+14155550190", "+14155550191"] });

  await client.mutation(api.users.updateProfile, {
    userId: a,
    patch: {
      headline: "iOS engineer",
      company: "Test Co",
      location: "Berkeley, CA",
      tags: ["iOS engineer", "SwiftUI", "Student"],
      lookingFor: "robotics hardware engineer",
      offers: "SwiftUI apps, iOS",
      hobbies: ["climbing", "chess"],
    },
  });
  await client.mutation(api.users.updateProfile, {
    userId: b,
    patch: {
      headline: "Robotics hardware engineer",
      tags: ["Hardware engineer", "Robotics"],
      lookingFor: "iOS engineer for a robot app",
      offers: "robotics hardware, embedded",
      hobbies: ["climbing", "synths"],
    },
  });
  const me = await client.query(api.users.me, { userId: a });
  check("profile saved with avatar defaults", me?.company === "Test Co" && me?.avatarShape && me?.avatarColor, {
    shape: me?.avatarShape,
    color: me?.avatarColor,
  });

  // Photo upload
  await client.mutation(api.users.setPhoto, { userId: a, storageId: (await upload()) as Id<"_storage"> });
  await client.mutation(api.users.addMoment, { userId: a, storageId: (await upload()) as Id<"_storage">, caption: "Test moment" });
  const withPhoto = await client.query(api.users.me, { userId: a });
  const moments = await client.query(api.users.moments, { userId: a });
  check("photo and moment", Boolean(withPhoto?.photoUrl) && moments.length > 0 && withPhoto?.badgeLayout === "photoText");

  // Scoring runs after the debounce.
  console.log("…waiting for scoring");
  await sleep(14_000);

  // Both phones at the event, exchanging Nearby tokens.
  await client.mutation(api.users.heartbeat, { userId: a });
  await client.mutation(api.users.heartbeat, { userId: b });
  await client.mutation(api.nearby.uploadToken, { userId: a, peerId: b, token: "token-a-for-b" });
  await client.mutation(api.nearby.uploadToken, { userId: b, peerId: a, token: "token-b-for-a" });
  const peers = await client.query(api.nearby.peers, { userId: a });
  check("peers include the other phone with its token", peers.some((p) => p.userId === b && p.tokenForMe === "token-b-for-a"));

  // Approaching
  await client.mutation(api.nearby.reportDistance, { userId: a, peerId: b, meters: 5 });
  const far = await client.query(api.badge.state, { userId: a });
  check("match lights up at 5 m", far.mode === "match" && far.glow > 0, {
    mode: far.mode,
    glow: far.glow,
    closeness: far.closeness,
    color: far.color,
    frontTag: far.frontTag,
    peerAvatar: [far.peerAvatarShape, far.peerAvatarColor],
  });
  const bView = await client.query(api.badge.state, { userId: b });
  check("same color on both badges", bView.color === far.color);

  // Talking
  await client.mutation(api.nearby.reportDistance, { userId: a, peerId: b, meters: 1.0 });
  await sleep(10_500);
  await client.mutation(api.nearby.reportDistance, { userId: b, peerId: a, meters: 1.0 });
  const talking = await client.query(api.badge.state, { userId: a });
  check("talking after 10 s close", talking.mode === "talking" && talking.conversationId, { mode: talking.mode });

  // Step apart, phone uploads the transcript
  await client.mutation(api.nearby.reportDistance, { userId: a, peerId: b, meters: 4 });
  if (talking.conversationId) {
    await client.mutation(api.conversations.finish, {
      conversationId: talking.conversationId as Id<"conversations">,
      transcript:
        "Alice: I build iOS apps in SwiftUI. Bob: I make robot arms and need an app to control them. Alice: let's prototype it this weekend and meet Tuesday.",
    });
  }

  // Confirm the contact by text, like replying Y
  const saved = await client.mutation(api.agent.confirmContact, { phone: "+14155550190" });
  check("contact saved by text", saved === "Test Bob", saved);
  console.log("…waiting for the summary");
  await sleep(14_000);
  const people = await client.query(api.people.list, { userId: a });
  check("People lists the new contact", people.some((p) => p.id === b));
  const detail = await client.query(api.people.detail, { userId: a, otherId: b });
  check("detail has summary and timeline", Boolean(detail?.conversation?.summary) && (detail?.timeline.length ?? 0) > 0, {
    summary: detail?.conversation?.summary,
    followUp: detail?.conversation?.followUp,
  });
  const current = await client.query(api.people.current, { userId: a });
  check("current person for iPhone Duo", current === b);

  const ctx = await client.query(api.agent.context, { phone: "+14155550190" });
  check("agent context", ctx.user?.name === "Test Alice" && Array.isArray(ctx.topMatches), {
    topMatches: ctx.topMatches.map((m) => `${m.name} ${m.score?.toFixed(2)}`),
  });

  console.log(failures ? `\n${failures} check(s) failed` : "\nAll checks passed");
  process.exit(failures ? 1 : 0);
}

async function upload() {
  const u = await client.mutation(api.users.generateUploadUrl, {});
  const png = Buffer.from(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFBQIAX8jx0gAAAABJRU5ErkJggg==",
    "base64",
  );
  const r = await fetch(u, { method: "POST", headers: { "Content-Type": "image/png" }, body: png });
  return ((await r.json()) as { storageId: string }).storageId;
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
