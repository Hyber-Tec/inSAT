// Multipart uploads (files and their form fields), in place of multer: Cloud
// Functions reads a request's body before the app sees it, so the parser has
// to take it from req.rawBody there, and from the stream everywhere else.
// Files land in memory as multer's did: { fieldname, originalname, mimetype,
// buffer, size } on req.files (or req.file), the text fields on req.body.

import Busboy from 'busboy';
import { badRequest } from './http.js';

/** Middleware reading `field`: one file (`single`) or up to `files` of them. */
export function multipart({ field, files = 1, fileSize, single = false }) {
  return (req, _res, next) => {
    if (!String(req.headers['content-type'] || '').startsWith('multipart/form-data')) {
      req.body = req.body && typeof req.body === 'object' ? req.body : {};
      if (single) req.file = undefined; else req.files = [];
      return next();
    }
    let parser;
    try {
      parser = Busboy({ headers: req.headers, limits: { fileSize, files } });
    } catch (err) {
      return next(badRequest(err.message));
    }
    const body = {};
    const got = [];
    let failure = null;
    const work = [];

    parser.on('field', (name, value) => { body[name] = value; });
    parser.on('file', (name, stream, info) => {
      if (name !== field) { stream.resume(); return; }
      const parts = [];
      let truncated = false;
      stream.on('data', (d) => parts.push(d));
      stream.on('limit', () => { truncated = true; });
      work.push(new Promise((resolve) => stream.on('close', () => {
        if (truncated) failure ||= badRequest(`${info.filename || 'A file'} is too large.`);
        else {
          const buffer = Buffer.concat(parts);
          got.push({ fieldname: name, originalname: info.filename, mimetype: info.mimeType, encoding: info.encoding, buffer, size: buffer.length });
        }
        resolve();
      })));
    });
    parser.on('filesLimit', () => { failure ||= badRequest(`Upload at most ${files} file${files === 1 ? '' : 's'} at a time.`); });
    parser.on('error', (err) => { failure ||= badRequest(err.message); });
    parser.on('close', async () => {
      await Promise.all(work);
      if (failure) return next(failure);
      req.body = body;
      if (single) req.file = got[0]; else req.files = got;
      next();
    });

    if (req.rawBody) parser.end(req.rawBody);
    else req.pipe(parser);
  };
}
