// The AI assistant's API (lib/assistant.js), for students and academy admins:
// whether it can answer now, and a message answered as it is written. The
// answer is a stream of JSON lines: { type: 'text', text } as the reply comes,
// then { type: 'done', truncated, remaining } or { type: 'error', message }.
// A refusal before the reply starts (not set up, a test in progress, the day's
// messages used up, the AI unreachable) is an ordinary JSON error. The browser
// calls the function's own URL for it (web/src/api.js), since Firebase
// Hosting would hold the stream back until it ended.

import { Router } from 'express';
import { z } from 'zod';
import { COL, getRow } from '../lib/store.js';
import { asyncHandler, parseBody, badRequest, forbidden, HttpError } from '../lib/http.js';
import { config } from '../lib/config.js';
import { getInstitutionCredentials } from '../lib/institutions.js';
import { streamChat } from '../lib/llm.js';
import {
  LIMITS, REASONS, access, conversation, reasonText, refundMessage, remaining, spendMessage, systemPrompt, takingTest,
} from '../lib/assistant.js';

const router = Router();

router.use((req, _res, next) => next(['student', 'admin'].includes(req.user.role)
  ? undefined
  : forbidden('The AI assistant is for students and academy staff.')));

/** Where the asker stands: their institution and profile, why the assistant cannot answer them now (or null), and their messages left today. */
async function standing(req) {
  const [institution, profile] = await Promise.all([getRow(COL.institutions, req.user.inst), getRow(COL.users, req.user.sub)]);
  const { ready, reason: why } = access(req.user.role, institution);
  let reason = ready ? null : why;
  if (!reason && req.user.role === 'student' && (await takingTest(req.user.sub))) reason = 'test';
  const left = remaining(profile?.assistant_usage);
  if (!reason && left <= 0) reason = 'limit';
  return { institution, profile, reason, left };
}

const refusal = (reason, role) => new HttpError(REASONS[reason].status, reasonText(reason, role), reason);

/** An AI failure in the asker's words: the AI is never named, and only an admin can fix a refused key. */
function failureText(err, role) {
  if (err.kind === 'no_key') return reasonText('not_configured', role);
  if (err.kind === 'bad_key') {
    return role === 'admin'
      ? 'The AI key in Settings was refused. Check it there, or add a new one.'
      : 'AI is not working for your academy right now. Please let your academy know.';
  }
  return 'AI could not answer just now. Please try again in a moment.';
}

const failure = (err, role) => (err.kind === 'no_key'
  ? refusal('not_configured', role)
  : new HttpError(502, failureText(err, role), 'ai_unavailable'));

router.get('/status', asyncHandler(async (req, res) => {
  const { reason, left } = await standing(req);
  res.json({
    ready: !reason,
    reason,
    message: reason ? reasonText(reason, req.user.role) : null,
    remaining: left,
    limit: config.assistantDailyLimit,
  });
}));

// A figure goes as the picture the asker sees (the browser draws it, SVG
// figures included, since the models read only bitmaps).
const FIGURE = /^data:image\/(png|jpeg);base64,([A-Za-z0-9+/]+=*)$/;
// Two of them, with the conversation and the screen, stay under the API's 4 MB body limit (app.js).
const FIGURE_CHARS = 1.5 * 1024 * 1024;

const ChatBody = z.object({
  messages: z.array(z.object({
    role: z.enum(['user', 'assistant']),
    content: z.string().max(LIMITS.historyChars),
  })).min(1).max(200),
  screen: z.object({
    title: z.string().max(LIMITS.title).optional(),
    text: z.string().max(LIMITS.screen * 2).optional(),
    figures: z.array(z.string().max(FIGURE_CHARS).regex(FIGURE)).max(LIMITS.figures).optional(),
  }).optional(),
});

router.post('/chat', asyncHandler(async (req, res) => {
  const body = parseBody(ChatBody, req.body);
  const asked = body.messages.at(-1);
  if (asked.role !== 'user' || !asked.content.trim()) throw badRequest('Ask a question first.');
  if (asked.content.length > LIMITS.message) throw badRequest(`Keep a message under ${LIMITS.message} characters.`);

  const { institution, profile, reason } = await standing(req);
  if (reason) throw refusal(reason, req.user.role);
  const spent = await spendMessage(req.user.sub);
  if (!spent.ok) throw refusal('limit', req.user.role);

  // Stop asking the AI (and paying for it) once the asker has gone.
  const controller = new AbortController();
  res.on('close', () => { if (!res.writableFinished) controller.abort(); });
  const send = (event) => { if (!res.destroyed && !res.writableEnded) res.write(`${JSON.stringify(event)}\n`); };
  let started = false;

  try {
    const screen = body.screen && { ...body.screen, text: (body.screen.text || '').slice(0, LIMITS.screen) };
    const figures = (body.screen?.figures || []).map((url) => {
      const [, type, data] = FIGURE.exec(url);
      return { media: `image/${type}`, data };
    });
    const reply = await streamChat({
      creds: await getInstitutionCredentials(req.user.inst),
      model: config.chatModel,
      system: systemPrompt({ role: req.user.role, mode: institution?.mode, name: profile?.display_name, academy: institution?.name }),
      messages: conversation(body.messages, screen, figures),
      maxTokens: LIMITS.reply,
      signal: controller.signal,
      onStart: () => {
        started = true;
        res.status(200).set({
          'Content-Type': 'application/x-ndjson; charset=utf-8',
          'Cache-Control': 'no-store',
          'X-Accel-Buffering': 'no',
        });
        res.flushHeaders();
        res.socket?.setNoDelay(true);
      },
      onText: (text) => send({ type: 'text', text }),
    });
    send({ type: 'done', truncated: reply.truncated, remaining: spent.left });
    res.end();
  } catch (err) {
    if (controller.signal.aborted) return;
    console.error('[assistant]', err.kind || 'error', err.message);
    if (!started) {
      // Nothing was answered, so the message does not count.
      await refundMessage(req.user.sub, spent.day).catch(() => {});
      throw failure(err, req.user.role);
    }
    send({ type: 'error', message: failureText(err, req.user.role) });
    res.end();
  }
}));

export default router;
