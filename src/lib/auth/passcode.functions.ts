import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import {
  issueSessionToken,
  safeEqualStr,
  verifySessionTokenServer,
} from "./passcode.server";

export const verifyPasscode = createServerFn({ method: "POST" })
  .inputValidator((data: { passcode: string }) =>
    z.object({ passcode: z.string().min(1).max(256) }).parse(data),
  )
  .handler(async ({ data }) => {
    const expected = process.env.APP_PASSCODE;
    if (!expected) throw new Error("Server is not configured for passcode auth.");

    if (!safeEqualStr(data.passcode, expected)) {
      throw new Response(
        JSON.stringify({ success: false, message: "Invalid passcode" }),
        { status: 401, headers: { "content-type": "application/json" } },
      );
    }

    const { token, expiresAt } = issueSessionToken();
    return { success: true as const, token, expiresAt };
  });

export const verifySessionToken = createServerFn({ method: "POST" })
  .inputValidator((data: { token: string }) =>
    z.object({ token: z.string().min(1).max(2048) }).parse(data),
  )
  .handler(async ({ data }) => {
    return { valid: verifySessionTokenServer(data.token) };
  });
