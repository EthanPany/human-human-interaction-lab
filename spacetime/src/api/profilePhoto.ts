import type { Tx } from "../schema";
import { nowMs, UserError } from "../lib/db";
import { ArgError, optStr, str, type Ctx } from "./context";

/**
 * The square profile photo shown in People rows and on person pages. The
 * badge keeps the jelly avatar; the badge photo (users:setPhoto) is separate.
 * Upload flow: POST /upload with the JPEG -> { storageId } -> users:setProfilePhoto.
 */

/** The stored photo id, if any. */
export function profilePhotoIdOf(tx: Tx, userId: string) {
  return tx.db.profilePhotos.userId.find(userId)?.photoId;
}

/** users:setProfilePhoto {userId, storageId?}: no storageId removes it. */
export function setProfilePhoto({ tx }: Ctx, args: Record<string, unknown>) {
  const userId = str(args, "userId");
  if (!tx.db.users.id.find(userId)) throw new UserError("No such user");
  const storageId = optStr(args, "storageId");
  if (storageId && !tx.db.photos.id.find(storageId)) throw new ArgError("Unknown storageId");
  const existing = tx.db.profilePhotos.userId.find(userId);
  if (existing && existing.photoId !== storageId) tx.db.photos.id.delete(existing.photoId);
  if (!storageId) {
    if (existing) tx.db.profilePhotos.userId.delete(userId);
    return null;
  }
  const row = { userId, photoId: storageId, at: nowMs(tx) };
  if (existing) tx.db.profilePhotos.userId.update(row);
  else tx.db.profilePhotos.insert(row);
  return null;
}
