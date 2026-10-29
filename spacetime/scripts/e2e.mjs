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
      californiaMode: true,
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
  // Both badges worn full screen (ranging only counts then)
  await call("nearby:setRanging", { userId: a, on: true });
  await call("nearby:setRanging", { userId: b, on: true });
  await call("nearby:uploadToken", { userId: a, peerId: b, token: "token-a-for-b" });
  await call("nearby:uploadToken", { userId: b, peerId: a, token: "token-b-for-a" });
  const peers = await call("nearby:peers", { userId: a });
  check("peers include the other phone with its token, as a match", peers.some((p) => p.userId === b && p.tokenForMe === "token-b-for-a" && p.isMatch === true));

  // Respond from: Alice's badge starts reacting at 6 m, so the pair reacts from 6 m (the smaller one)
  await call("users:updateProfile", { userId: a, patch: { respondFromM: 6 } });
  const prefs = await call("users:me", { userId: a });
  check("respond from and drop short are saved", prefs?.respondFromM === 6 && prefs?.dropShortEncounters === true, {
    respondFromM: prefs?.respondFromM,
    dropShortEncounters: prefs?.dropShortEncounters,
  });

  await call("nearby:reportDistance", { userId: a, peerId: b, meters: 7 });
  const tooFar = await call("badge:state", { userId: b });
  check("no reaction past the pair's respond range (7 m > 6 m)", tooFar.mode === "idle", { mode: tooFar.mode });

  await call("nearby:reportDistance", { userId: a, peerId: b, meters: 5 });
  const far = await call("badge:state", { userId: a });
  check("match lights up at 5 m", far.mode === "match" && far.matched === true && far.glow > 0 && far.respondRangeM === 6, {
    mode: far.mode,
    glow: far.glow,
    closeness: far.closeness,
    respondRangeM: far.respondRangeM,
    color: far.color,
    frontTag: far.frontTag,
    peerAvatar: [far.peerAvatarShape, far.peerAvatarColor],
  });
  await call("nearby:reportDistance", { userId: a, peerId: b, meters: 2 });
  const nearer = await call("badge:state", { userId: a });
  check("closeness ramps up as they approach", nearer.closeness > far.closeness, [far.closeness, nearer.closeness]);
  const bView = await call("badge:state", { userId: b });
  check("same color on both badges", bView.color === far.color);

  await call("nearby:reportDistance", { userId: a, peerId: b, meters: 1.3 });
  const notYet = await call("badge:state", { userId: a });
  check("not together at 1.3 m", notYet.mode !== "talking", { mode: notYet.mode });

  // Short encounter: together, then apart after a few seconds (Drop short encounters is on for both)
  await call("nearby:reportDistance", { userId: a, peerId: b, meters: 0.8 });
  await sleep(1_500);
  await call("nearby:reportDistance", { userId: b, peerId: a, meters: 0.9 });
  const talking = await call("badge:state", { userId: a });
  check("together within 1 m after a second", talking.mode === "talking" && talking.conversationId, { mode: talking.mode });
  await call("nearby:reportDistance", { userId: a, peerId: b, meters: 1.4 });
  const stillTogether = await call("badge:state", { userId: a });
  check("still together at 1.4 m (apart only past 1.5 m)", stillTogether.mode === "talking", { mode: stillTogether.mode });

  // California mode is on for new accounts: recording waits for both yeses
  check("California mode needs both to agree", talking.consentRequired === true && talking.recordingAllowed === false, {
    consentRequired: talking.consentRequired,
    recordingAllowed: talking.recordingAllowed,
  });
  await call("conversations:consent", { conversationId: talking.conversationId, userId: a, agree: true });
  const halfway = await call("badge:state", { userId: a });
  check("one yes is not enough", halfway.myConsent === true && halfway.recordingAllowed === false);
  await call("conversations:consent", { conversationId: talking.conversationId, userId: b, agree: true });
  const agreed = await call("badge:state", { userId: b });
  check("both agreed: recording allowed", agreed.recordingAllowed === true && agreed.peerConsent === true);

  // Parting: both phones see it (the pair's distance is the smaller of two recent readings)
  await call("nearby:reportDistance", { userId: a, peerId: b, meters: 4 });
  await call("nearby:reportDistance", { userId: b, peerId: a, meters: 4 });
  await call("conversations:finish", { conversationId: talking.conversationId, transcript: "Alice: hi Bob. Bob: hi." });
  const dropped = await call("people:detail", { userId: a, otherId: b });
  check("short encounter is dropped", (dropped?.encounters ?? []).length === 0, dropped?.encounters);

  // Back together within 5 minutes: the same encounter continues. Alice keeps short ones now.
  await call("users:updateProfile", { userId: a, patch: { dropShortEncounters: false } });
  await call("nearby:reportDistance", { userId: a, peerId: b, meters: 0.7 });
  await sleep(1_500);
  await call("nearby:reportDistance", { userId: b, peerId: a, meters: 0.7 });
  const again = await call("badge:state", { userId: a });
  check("rejoined within 5 min: same encounter", again.mode === "talking" && again.conversationId === talking.conversationId, {
    first: talking.conversationId,
    again: again.conversationId,
  });
  check("consent carries over in the same encounter", again.recordingAllowed === true);

  await call("nearby:reportDistance", { userId: a, peerId: b, meters: 4 });
  await call("nearby:reportDistance", { userId: b, peerId: a, meters: 4 });
  await call("conversations:finish", {
    conversationId: again.conversationId,
    transcript:
      "Alice: I build iOS apps in SwiftUI. Bob: I make robot arms and need an app to control them. Alice: let's prototype it this weekend and meet Tuesday.",
  });

  const saved = await call("agent:confirmContact", { phone: "+14155550190" });
  check("contact saved by text", saved === "Test Bob", saved);
  console.log("…waiting for the summary");
  await sleep(14_000);
  const people = await call("people:list", { userId: a });
  check("People lists the new contact", people.some((p) => p.id === b));
  const detail = await call("people:detail", { userId: a, otherId: b });
  check("Alice keeps the encounter, with summary and timeline", detail?.encounters?.length === 1 && Boolean(detail.encounters[0].summary) && (detail?.timeline.length ?? 0) > 0, {
    encounters: detail?.encounters?.length,
    summary: detail?.encounters?.[0]?.summary,
    followUp: detail?.encounters?.[0]?.followUp,
  });
  const bobDetail = await call("people:detail", { userId: b, otherId: a });
  check("Bob drops it (under a minute, his setting is on)", (bobDetail?.encounters ?? []).length === 0, bobDetail?.encounters?.length);

  // Profile photo (square, People rows and pages), separate from the badge photo
  await call("users:setProfilePhoto", { userId: a, storageId: await upload() });
  const withProfilePhoto = await call("users:me", { userId: a });
  const bobList = await call("people:list", { userId: b });
  const aliceRow = bobList.find((p) => p.id === a);
  check("profile photo on me and in People rows", Boolean(withProfilePhoto?.profilePhotoUrl) && aliceRow?.profilePhotoUrl === withProfilePhoto.profilePhotoUrl && withProfilePhoto.badgeLayout === "photoText", {
    me: withProfilePhoto?.profilePhotoUrl,
    row: aliceRow?.profilePhotoUrl,
  });
  const aliceRowA = (await call("people:list", { userId: a })).find((p) => p.id === b);
  check("People rows carry match, met, topics and notes for filters", typeof aliceRowA?.matchScore === "number" && typeof aliceRowA?.matched === "boolean" && typeof aliceRowA?.metAt === "number" && Array.isArray(aliceRowA?.topics), {
    matchScore: aliceRowA?.matchScore,
    matched: aliceRowA?.matched,
    metAt: aliceRowA?.metAt,
    topics: aliceRowA?.topics,
    notes: aliceRowA?.notes?.slice(0, 60),
  });

  // Contact sharing: nothing is shared until the other person says yes
  const linkedin = await call("sharing:saveItem", { userId: a, item: { kind: "linkedin", value: "@alice-test", includeByDefault: true } });
  const github = await call("sharing:saveItem", { userId: a, item: { kind: "github", value: "alicetest", includeByDefault: false } });
  const qr = await call("sharing:saveItem", { userId: a, item: { kind: "image", label: "My QR code", storageId: await upload(), includeByDefault: true } });
  const bobEmail = await call("sharing:saveItem", { userId: b, item: { kind: "email", value: "bob@example.com" } });
  let badEmail;
  try {
    await call("sharing:saveItem", { userId: b, item: { kind: "email", value: "not an email" } });
  } catch (e) {
    badEmail = String(e);
  }
  check("a bad email is rejected", badEmail?.includes("email"), badEmail);
  const aliceItems = await call("sharing:items", { userId: a });
  check("items saved in order, handles become links, images have a photo", aliceItems.length === 3 && aliceItems[0].url === "https://www.linkedin.com/in/alice-test" && aliceItems[1].url === "https://github.com/alicetest" && Boolean(aliceItems[2].photoUrl) && aliceItems[2].label === "My QR code", aliceItems.map((i) => [i.kind, i.url ?? i.photoUrl]));

  const before0 = await call("sharing:with", { userId: b, otherId: a });
  check("nothing is shared automatically", before0.theirs.length === 0 && before0.mine.length === 0 && !before0.incoming);

  const offer = await call("sharing:request", { userId: a, otherId: b, kind: "offer" });
  const offerAgain = await call("sharing:request", { userId: a, otherId: b, kind: "offer" });
  check("one pending offer per pair", offer.requestId && offer.requestId === offerAgain.requestId);
  const bobInbox = await call("sharing:inbox", { userId: b });
  const card = bobInbox.find((r) => r.id === offer.requestId);
  check("Bob gets an approval card with the default items, no values yet", card?.kind === "offer" && card.from?.id === a && card.items.length === 2 && card.items.every((i) => i.value === undefined && i.url === undefined), card);
  const aliceSide = await call("sharing:with", { userId: a, otherId: b });
  check("Alice sees it waiting", aliceSide.outgoing?.id === offer.requestId && !aliceSide.incoming);

  await call("sharing:respond", { userId: b, requestId: offer.requestId, approve: true, itemIds: [bobEmail] });
  const bobSees = await call("sharing:with", { userId: b, otherId: a });
  const aliceSees = await call("sharing:with", { userId: a, otherId: b });
  check("approved: Bob sees Alice's items, and his email is shared back", bobSees.theirs.length === 2 && bobSees.theirs.some((i) => i.id === linkedin) && bobSees.theirs.some((i) => i.id === qr) && !bobSees.theirs.some((i) => i.id === github) && aliceSees.theirs.length === 1 && aliceSees.theirs[0].url === "mailto:bob@example.com", {
    bob: bobSees.theirs.map((i) => i.kind),
    alice: aliceSees.theirs.map((i) => i.kind),
  });
  check("the card is gone after answering", (await call("sharing:inbox", { userId: b })).length === 0);
  const flags = (await call("people:list", { userId: b })).find((p) => p.id === a);
  check("People rows say shared with you", flags?.sharedWithMe === true && flags?.sharedByMe === true, { sharedWithMe: flags?.sharedWithMe, sharedByMe: flags?.sharedByMe });

  await call("sharing:saveItem", { userId: a, item: { id: linkedin, kind: "linkedin", value: "https://www.linkedin.com/in/alice-new" } });
  const live = await call("sharing:with", { userId: b, otherId: a });
  check("shared items are live (an edit shows up)", live.theirs.find((i) => i.id === linkedin)?.url === "https://www.linkedin.com/in/alice-new");

  const ask = await call("sharing:request", { userId: a, otherId: b, kind: "ask" });
  await call("sharing:respond", { userId: b, requestId: ask.requestId, approve: false });
  const afterDecline = await call("sharing:with", { userId: a, otherId: b });
  check("declining an ask changes nothing", afterDecline.theirs.length === 1 && !afterDecline.outgoing && afterDecline.lastDeclinedAt > 0);

  await call("sharing:revoke", { userId: a, otherId: b });
  const revoked = await call("sharing:with", { userId: b, otherId: a });
  check("revoke: Bob no longer sees Alice's items", revoked.theirs.length === 0 && revoked.mine.length === 1);

  // Phase 6 hook: an Apple Watch handshake shares both ways once both approved
  const half = await call("sharing:handshake", { userId: a, otherId: b, itemIds: [github] });
  const whole = await call("sharing:handshake", { userId: b, otherId: a });
  const afterShake = await call("sharing:with", { userId: b, otherId: a });
  check("handshake: the first waits, the second completes a mutual share", half.status === "waiting" && whole.status === "complete" && afterShake.theirs.some((i) => i.id === github) && afterShake.mine.includes(bobEmail), {
    half: half.status,
    whole,
    theirs: afterShake.theirs.map((i) => i.kind),
  });

  const stranger = await call("users:signIn", { phone: "+14155550192", name: "Test Carol" });
  let notMet;
  try {
    await call("sharing:request", { userId: a, otherId: stranger, kind: "ask" });
  } catch (e) {
    notMet = String(e);
  }
  check("no requests to people you haven't met", notMet?.includes("met"), notMet);

  // Optional (E2E_SLOW=1, about 6 more minutes): meeting again after the window is a second encounter
  if (process.env.E2E_SLOW) {
    console.log("…waiting out the 5 minute window");
    await sleep(5 * 60_000 + 10_000);
    await call("nearby:reportDistance", { userId: a, peerId: b, meters: 0.7 });
    await sleep(1_500);
    await call("nearby:reportDistance", { userId: b, peerId: a, meters: 0.7 });
    const second = await call("badge:state", { userId: a });
    check("after 5 min apart: a new encounter", second.mode === "talking" && second.conversationId !== again.conversationId);
    await call("nearby:reportDistance", { userId: a, peerId: b, meters: 4 });
    await call("nearby:reportDistance", { userId: b, peerId: a, meters: 4 });
    await call("conversations:finish", { conversationId: second.conversationId, transcript: "Alice: hi again. Bob: Tuesday still works." });
    await sleep(12_000);
    const both = await call("people:detail", { userId: a, otherId: b });
    check("two encounters on Alice's page", both?.encounters?.length === 2, both?.encounters?.length);
  }

  const current = await call("people:current", { userId: a });
  check("current person for iPhone Duo", current === b);

  const ctx = await call("agent:context", { phone: "+14155550190" });
  check("agent context", ctx.user?.name === "Test Alice" && Array.isArray(ctx.topMatches), {
    topMatches: ctx.topMatches.map((m) => `${m.name} ${m.score?.toFixed(2)}`),
  });

  // Merged distance: one phone seeing the other is enough for both badges
  await call("nearby:reportDistance", { userId: b, peerId: a, meters: 3 });
  const oneSided = await call("badge:state", { userId: a });
  check("one side's UWB reading reaches both badges", (oneSided.mode === "match" || oneSided.mode === "connected") && Math.abs((oneSided.meters ?? 0) - 3) < 0.01 && oneSided.distanceSource === "uwb", {
    mode: oneSided.mode,
    meters: oneSided.meters,
    source: oneSided.distanceSource,
  });
  const before = Date.now();
  await call("nearby:reportDistance", { userId: a, peerId: b, meters: 4.5 });
  const minOfTwo = await call("badge:state", { userId: b });
  if (Date.now() - before < 900) {
    check("two recent readings: the smaller counts", Math.abs((minOfTwo.meters ?? 0) - 3) < 0.01, minOfTwo.meters);
  } else {
    console.log("  (skipped the min of two check: the calls took longer than the 1 s merge window)");
  }

  // Bluetooth assist: rotating short ids, "in the area", estimated together only when very strong
  const bleA = await call("nearby:bleId", { userId: a });
  const bleB = await call("nearby:bleId", { userId: b });
  check("rotating Bluetooth ids (short, not the user id)", bleA?.bleId?.length === 6 && bleA.bleId !== bleB?.bleId && bleA.expiresAt > Date.now(), [bleA, bleB]);
  const bleAgain = await call("nearby:bleId", { userId: a });
  check("same Bluetooth id until it rotates", bleAgain?.bleId === bleA?.bleId);
  await call("nearby:reportBle", { userId: a, sightings: [{ bleId: bleB.bleId, rssi: -70 }] });
  const blePeers = await call("nearby:peers", { userId: a });
  const pb = blePeers.find((p) => p.userId === b);
  check("peers say in the area, with their Bluetooth id, color and merged distance", pb?.inArea === true && pb?.bleId === bleB.bleId && Boolean(pb?.color) && typeof pb?.meters === "number", pb);
  console.log("…waiting for UWB to go quiet");
  await sleep(4_500);
  await call("nearby:reportBle", { userId: a, sightings: [{ bleId: bleB.bleId, rssi: -72 }] });
  const weak = await call("badge:state", { userId: a });
  check("a Bluetooth estimate is coarse: never together, never closer than 2 m", weak.distanceSource === "ble" && weak.mode !== "talking" && weak.meters >= 2, {
    mode: weak.mode,
    meters: weak.meters,
    source: weak.distanceSource,
  });
  await call("nearby:reportBle", { userId: a, sightings: [{ bleId: bleB.bleId, rssi: -45 }] });
  await sleep(1_200);
  await call("nearby:reportBle", { userId: b, sightings: [{ bleId: bleA.bleId, rssi: -46 }] });
  const estimated = await call("badge:state", { userId: a });
  check("no UWB for 4 s and a very strong signal: together, marked estimated", estimated.mode === "talking" && estimated.estimated === true && estimated.distanceSource === "ble", {
    mode: estimated.mode,
    estimated: estimated.estimated,
    meters: estimated.meters,
  });
  if (estimated.conversationId) await call("conversations:finish", { conversationId: estimated.conversationId });

  await call("nearby:setRanging", { userId: a, on: false });
  await call("nearby:setRanging", { userId: b, on: false });
  const cleared = await call("nearby:peers", { userId: a });
  check("badge off: no peers, Bluetooth ids gone", cleared.length === 0 && (await call("nearby:reportBle", { userId: b, sightings: [{ bleId: bleA.bleId, rssi: -45 }] })) === null);

  await groupChecks();

  const gone = await call("users:me", { userId: "not-a-user" });
  check("unknown user is null (app signs out)", gone === null);

  console.log(failures ? `\n${failures} check(s) failed` : "\nAll checks passed");
  process.exit(failures ? 1 : 0);
}

/**
 * Groups: three more fictional phones (Gina, Hugo, Ivy). Gina and Hugo meet,
 * Ivy walks up to Hugo only and joins (one encounter, the pair's record), one
 * phone records, California mode waits for all three, Ivy leaves and the pair
 * goes on, Ivy comes back within 5 minutes to the same encounter, then they part.
 */
async function groupChecks() {
  const phones = ["+14155550193", "+14155550194", "+14155550195"];
  const [g, h, i] = [
    await call("users:signIn", { phone: phones[0], name: "Test Gina" }),
    await call("users:signIn", { phone: phones[1], name: "Test Hugo" }),
    await call("users:signIn", { phone: phones[2], name: "Test Ivy" }),
  ];
  await call("testing:resetTestGroup", { phones });
  for (const u of [g, h, i]) {
    await call("users:updateProfile", { userId: u, patch: { californiaMode: false, dropShortEncounters: false } });
    await call("users:heartbeat", { userId: u });
    await call("nearby:setRanging", { userId: u, on: true });
  }
  const near = (x, y, m) => call("nearby:reportDistance", { userId: x, peerId: y, meters: m });
  // Readings go stale after 8 s and a member with nobody in reach leaves after 3 s: keep the pairs fresh
  const keep = async (pairs) => {
    for (const [x, y, m] of pairs) await near(x, y, m);
  };

  await keep([[g, h, 0.8]]);
  await sleep(1_200);
  await keep([[h, g, 0.8]]);
  const pair = await call("badge:state", { userId: g });
  check("group: Gina and Hugo together (a pair: both phones record)", pair.mode === "talking" && pair.group === false && pair.members?.length === 1 && pair.isRecorder === true, {
    mode: pair.mode,
    group: pair.group,
    members: pair.members?.map((m) => m.name),
  });

  await keep([[h, i, 0.9], [g, h, 0.8]]);
  await sleep(1_200);
  await keep([[i, h, 0.9], [g, h, 0.8]]);
  const three = await call("badge:state", { userId: g });
  check("group: Ivy joins through Hugo, the pair's encounter becomes the group's", three.group === true && three.conversationId === pair.conversationId && three.members?.length === 2, {
    group: three.group,
    same: three.conversationId === pair.conversationId,
    members: three.members?.map((m) => m.name),
  });
  const views = await Promise.all([g, h, i].map((u) => call("badge:state", { userId: u })));
  const recording = views.filter((v) => v.isRecorder).length;
  check("group: exactly one phone records", recording === 1 && views.every((v) => v.conversationId === pair.conversationId), views.map((v) => [v.isRecorder, v.recordingAllowed]));
  const recorder = [g, h, i][views.findIndex((v) => v.isRecorder)];

  // California mode on for Ivy: recording waits for all three
  await call("users:updateProfile", { userId: i, patch: { californiaMode: true } });
  await keep([[g, h, 0.8], [h, i, 0.9]]);
  const waiting = await call("badge:state", { userId: recorder });
  check("group: California mode on for one member, recording waits", waiting.consentRequired === true && waiting.recordingAllowed === false);
  for (const u of [g, h]) await call("conversations:consent", { conversationId: pair.conversationId, userId: u, agree: true });
  const twoOfThree = await call("badge:state", { userId: recorder });
  check("group: two of three yes is not enough", twoOfThree.recordingAllowed === false);
  await call("conversations:consent", { conversationId: pair.conversationId, userId: i, agree: true });
  const allYes = await call("badge:state", { userId: recorder });
  check("group: all three said yes, the recorder records", allYes.recordingAllowed === true);

  // The recorder uploads; an older phone sends the same stretch too (counts once)
  const recStart = Date.now() - 10_000;
  await call("conversations:finish", {
    conversationId: pair.conversationId,
    userId: recorder,
    startedAt: recStart,
    leaving: false,
    transcript: "Gina: I run a robotics lab. Hugo: we need an iOS app for the arm. Ivy: I can design it. Gina: let's meet Friday.",
  });
  await call("conversations:finish", { conversationId: pair.conversationId, userId: [g, h, i].find((u) => u !== recorder), startedAt: recStart + 500, leaving: false, transcript: "robotics lab ios app" });

  // Ivy steps away: after the short grace she is out, Gina and Hugo go on in the same encounter
  await keep([[h, i, 3], [g, h, 0.8]]);
  await sleep(3_300);
  await keep([[h, i, 3], [g, h, 0.8]]);
  await call("badge:state", { userId: i });
  const ivyOut = await call("badge:state", { userId: i });
  const pairAgain = await call("badge:state", { userId: g });
  check("group: Ivy leaves, the pair goes on in the same encounter", ivyOut.mode !== "talking" && pairAgain.conversationId === pair.conversationId && pairAgain.members?.length === 1 && pairAgain.group === false, {
    ivy: ivyOut.mode,
    pair: pairAgain.members?.map((m) => m.name),
  });

  // Back within 5 minutes: the same encounter
  await keep([[i, g, 0.7], [g, h, 0.8]]);
  await sleep(1_200);
  await keep([[i, g, 0.7], [g, h, 0.8]]);
  const back = await call("badge:state", { userId: i });
  check("group: Ivy back within 5 min rejoins the same encounter", back.conversationId === pair.conversationId && back.group === true, back.members?.map((m) => m.name));

  // Everyone parts: one encounter for all three, with the others listed on each person page
  await keep([[i, g, 4], [g, h, 4], [h, i, 4]]);
  for (const u of [g, h, i]) await call("conversations:finish", { conversationId: pair.conversationId, userId: u });
  const groupsOfGina = await call("groups:list", { userId: g });
  const row = groupsOfGina.find((r) => r.id === pair.conversationId);
  check("group: groups:list shows the group with both others", row?.memberCount === 3 && row.members.length === 2, row?.members?.map((m) => m.name));
  const page = await call("people:detail", { userId: g, otherId: h });
  const onPage = page?.encounters?.find((e) => e.id === pair.conversationId);
  check("group: Hugo's page on Gina's side lists Ivy as also there", onPage?.group === true && onPage.others?.some((o) => o.id === i), onPage?.others?.map((o) => o.name));
  const list = await call("people:list", { userId: h });
  check("group: Ivy is in Hugo's People (they stood together only through the group)", list.some((p) => p.id === i) && list.some((p) => p.id === g));

  console.log("…waiting for the group summary");
  await sleep(14_000);
  const detail = await call("groups:detail", { userId: i, conversationId: pair.conversationId });
  check("group: groups:detail has one summary for everyone, highlights and each member", Boolean(detail?.summary) && Array.isArray(detail?.highlights) && detail.members.length === 2 && detail.hasTranscript === true, {
    summary: detail?.summary,
    highlights: detail?.highlights,
    followUp: detail?.followUp,
  });
  const saved = await call("agent:confirmContact", { phone: phones[1] });
  check("group: Y saves everyone from the group", typeof saved === "string" && saved.includes("Gina") && saved.includes("Ivy"), saved);

  for (const u of [g, h, i]) await call("nearby:setRanging", { userId: u, on: false });
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
