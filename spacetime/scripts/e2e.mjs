/**
 * End to end check against a SpacetimeDB database, acting as two phones
 * (port of backend/scripts/e2e.ts). Fictional 555-01xx numbers, no real texts.
 *
 *   SPACETIME_HOST=http://127.0.0.1:3000 SPACETIME_DB=hhil npm run e2e
 */
const host = (process.env.SPACETIME_HOST ?? "https://maincloud.spacetimedb.com").replace(/\/+$/, "");
const db = process.env.SPACETIME_DB ?? "hhil";
const base = `${host}/v1/database/${db}/route`;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let failures = 0;
function check(label, ok, detail) {
  console.log(`${ok ? "PASS" : "FAIL"}  ${label}${detail !== undefined ? `  ${JSON.stringify(detail)}` : ""}`);
  if (!ok) failures++;
}

async function call(path, args = {}) {
  const r = await fetch(`${base}/rpc`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ path, args }),
  });
  const body = await r.json();
  if (!r.ok) throw new Error(`${path}: ${r.status} ${body.error}`);
  return body.value;
}

async function upload() {
  const png = Buffer.from(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFBQIAX8jx0gAAAABJRU5ErkJggg==",
    "base64",
  );
  const r = await fetch(`${base}/upload`, { method: "POST", headers: { "content-type": "image/png" }, body: png });
  return (await r.json()).storageId;
}

async function main() {
  const health = await fetch(`${base}/health`);
  check("health route", health.ok);

  const a = await call("users:signIn", { phone: "+14155550190", name: "Test Alice" });
  const b = await call("users:signIn", { phone: "+14155550191", name: "Test Bob" });
  check("sign in", a && b);
  await call("testing:resetTestPair", { phones: ["+14155550190", "+14155550191"] });

  let wrong;
  try {
    await call("users:updateProfile", { userId: a, patch: { bogus: 1 } });
  } catch (e) {
    wrong = String(e);
  }
  check("bad patch is rejected", wrong?.includes("unknown field"), wrong);

  await call("users:updateProfile", {
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
  await call("users:updateProfile", {
    userId: b,
    patch: {
      headline: "Robotics hardware engineer",
      tags: ["Hardware engineer", "Robotics"],
      lookingFor: "iOS engineer for a robot app",
      offers: "robotics hardware, embedded",
      hobbies: ["climbing", "synths"],
    },
  });
  const me = await call("users:me", { userId: a });
  check("profile saved with avatar defaults", me?._id === a && me?.company === "Test Co" && me?.avatarShape && me?.avatarColor, {
    shape: me?.avatarShape,
    color: me?.avatarColor,
  });

  await call("users:setPhoto", { userId: a, storageId: await upload() });
  await call("users:addMoment", { userId: a, storageId: await upload(), caption: "Test moment" });
  const withPhoto = await call("users:me", { userId: a });
  const moments = await call("users:moments", { userId: a });
  check("photo and moment", Boolean(withPhoto?.photoUrl) && moments.length > 0 && withPhoto?.badgeLayout === "photoText", withPhoto?.photoUrl);
  const img = await fetch(withPhoto.photoUrl.replace(/^https?:\/\/[^/]+/, host));
  check("photo is served", img.ok && img.headers.get("content-type") === "image/png");

  console.log("…waiting for scoring");
  await sleep(14_000);

  await call("users:heartbeat", { userId: a });
  await call("users:heartbeat", { userId: b });
  await call("nearby:uploadToken", { userId: a, peerId: b, token: "token-a-for-b" });
  await call("nearby:uploadToken", { userId: b, peerId: a, token: "token-b-for-a" });
  const peers = await call("nearby:peers", { userId: a });
  check("peers include the other phone with its token", peers.some((p) => p.userId === b && p.tokenForMe === "token-b-for-a"));

  await call("nearby:reportDistance", { userId: a, peerId: b, meters: 5 });
  const far = await call("badge:state", { userId: a });
  check("match lights up at 5 m", far.mode === "match" && far.glow > 0, {
    mode: far.mode,
    glow: far.glow,
    closeness: far.closeness,
    color: far.color,
    frontTag: far.frontTag,
    peerAvatar: [far.peerAvatarShape, far.peerAvatarColor],
  });
  const bView = await call("badge:state", { userId: b });
  check("same color on both badges", bView.color === far.color);

  await call("nearby:reportDistance", { userId: a, peerId: b, meters: 1.0 });
  await sleep(10_500);
  await call("nearby:reportDistance", { userId: b, peerId: a, meters: 1.0 });
  const talking = await call("badge:state", { userId: a });
  check("talking after 10 s close", talking.mode === "talking" && talking.conversationId, { mode: talking.mode });

  await call("nearby:reportDistance", { userId: a, peerId: b, meters: 4 });
  if (talking.conversationId) {
    await call("conversations:finish", {
      conversationId: talking.conversationId,
      transcript:
        "Alice: I build iOS apps in SwiftUI. Bob: I make robot arms and need an app to control them. Alice: let's prototype it this weekend and meet Tuesday.",
    });
  }

  const saved = await call("agent:confirmContact", { phone: "+14155550190" });
  check("contact saved by text", saved === "Test Bob", saved);
  console.log("…waiting for the summary");
  await sleep(14_000);
  const people = await call("people:list", { userId: a });
  check("People lists the new contact", people.some((p) => p.id === b));
  const detail = await call("people:detail", { userId: a, otherId: b });
  check("detail has summary and timeline", Boolean(detail?.conversation?.summary) && (detail?.timeline.length ?? 0) > 0, {
    summary: detail?.conversation?.summary,
    followUp: detail?.conversation?.followUp,
  });
  const current = await call("people:current", { userId: a });
  check("current person for iPhone Duo", current === b);

  const ctx = await call("agent:context", { phone: "+14155550190" });
  check("agent context", ctx.user?.name === "Test Alice" && Array.isArray(ctx.topMatches), {
    topMatches: ctx.topMatches.map((m) => `${m.name} ${m.score?.toFixed(2)}`),
  });

  const gone = await call("users:me", { userId: "not-a-user" });
  check("unknown user is null (app signs out)", gone === null);

  console.log(failures ? `\n${failures} check(s) failed` : "\nAll checks passed");
  process.exit(failures ? 1 : 0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
