import crypto from "crypto";
import { Request, Response, NextFunction } from "express";

export const validateWebhook =
  (publicKey: string) => (req: Request, res: Response, next: NextFunction) => {
    // DEMO ONLY: WEBHOOK_SKIP_VERIFY bypasses Fireblocks webhook signature
    // verification so the demo can run without a publicly reachable, correctly
    // configured webhook signing key. NEVER enable this outside local demos —
    // it lets any caller POST forged webhook events. Leave unset in production.
    if (process.env.WEBHOOK_SKIP_VERIFY === "true") {
      console.log("[webhook] signature verification skipped via WEBHOOK_SKIP_VERIFY");
      next();
      return;
    }

    const message = JSON.stringify(req.body);
    const signature = req.headers["fireblocks-signature"];

    if (typeof signature !== "string") {
      next(new Error(`Invalid signature`));
      return;
    }

    const verifier = crypto.createVerify("RSA-SHA512");
    verifier.write(message);
    verifier.end();

    const isVerified = verifier.verify(publicKey, signature, "base64");
    if (isVerified) {
      next();
    } else {
      next(new Error(`Invalid signature`));
    }
  };
