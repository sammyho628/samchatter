import { createMiddleware } from "@tanstack/react-start";
import { getRequestHeader } from "@tanstack/react-start/server";
import { readStoredToken, SESSION_STORAGE_KEY } from "./token";

const HEADER_NAME = "x-app-session";

/** Function-type middleware that gates a server function on a valid
 *  HMAC-signed app passcode session token. The client half attaches the
 *  token from localStorage as `x-app-session`; the server half verifies
 *  the signature and expiry. Attach with `.middleware([requireAppPasscode])`
 *  on any server fn that returns or acts on sensitive data. */
export const requireAppPasscode = createMiddleware({ type: "function" })
  .client(async ({ next }) => {
    const token =
      typeof window !== "undefined"
        ? readStoredToken() ?? window.localStorage.getItem(SESSION_STORAGE_KEY)
        : null;
    return next({
      headers: token ? { [HEADER_NAME]: token } : {},
    });
  })
  .server(async ({ next }) => {
    const token = getRequestHeader(HEADER_NAME);
    const { verifySessionTokenServer } = await import("./passcode.server");
    if (!verifySessionTokenServer(token)) {
      throw new Response(
        JSON.stringify({ success: false, message: "Unauthorized" }),
        { status: 401, headers: { "content-type": "application/json" } },
      );
    }
    return next();
  });
