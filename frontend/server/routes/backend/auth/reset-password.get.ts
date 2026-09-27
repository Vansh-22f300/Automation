import { getQuery, sendRedirect } from 'h3';
import { setPasswordResetCookie } from '../../../utils/auth-cookie';

/**
 * GET /backend/auth/reset-password?token=… — the email-link handoff.
 *
 * The reset email points here (a top-level browser navigation, so GET and
 * CSRF-exempt). Rather than let the one-time token land in the SPA's URL,
 * history, or any browser-readable state (§12), this handler moves it into a
 * short-lived HttpOnly `aw_pwreset` cookie and 302-redirects to the clean SPA
 * page `/reset-password` — no token in the destination URL. The reset POST
 * later reads the token from that cookie server-side. A missing token still
 * redirects to the page, which shows the generic invalid-link state.
 */
export default defineEventHandler(async (event): Promise<void> => {
  const token = getQuery(event).token;
  if (typeof token === 'string' && token !== '') {
    setPasswordResetCookie(event, token);
    return sendRedirect(event, '/reset-password', 302);
  }
  return sendRedirect(event, '/reset-password?status=invalid', 302);
});
