// Question figures and academy logos: images in the Storage bucket under
// assets/<id>, with their type as the object's content type. The API serves
// them (GET /api/assets/:id) to the <img> tags that show them.

import { bucket } from './firebase.js';
import { isDocId, newId } from './store.js';

const file = (id) => bucket().file(`assets/${id}`);

/** Store an image ({ mime, bytes }); its new id. */
export async function saveAsset({ mime, bytes }, id = newId()) {
  await file(id).save(Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes), {
    resumable: false,
    contentType: mime || 'image/png',
    metadata: { cacheControl: 'public, max-age=86400' },
  });
  return id;
}

/** An image by id: { mime, bytes }, or null. */
export async function readAsset(id) {
  if (!isDocId(id)) return null;
  try {
    const f = file(id);
    const [[bytes], [meta]] = await Promise.all([f.download(), f.getMetadata()]);
    return { mime: meta.contentType || 'application/octet-stream', bytes };
  } catch (err) {
    if (err.code === 404) return null;
    throw err;
  }
}
