import type { Request, Response, NextFunction } from "express";
import crypto from "node:crypto";
import { requireAuthConfig } from "./config.js";

const auth = requireAuthConfig();

function timingSafeEqual(a: string, b: string) {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  if (left.length !== right.length) return false;
  return crypto.timingSafeEqual(left, right);
}

export function basicAuth(req: Request, res: Response, next: NextFunction) {
  const header = req.headers.authorization;
  if (!header?.startsWith("Basic ")) {
    return unauthorized(res);
  }

  const decoded = Buffer.from(header.slice("Basic ".length), "base64").toString("utf8");
  const splitAt = decoded.indexOf(":");
  const username = decoded.slice(0, splitAt);
  const password = decoded.slice(splitAt + 1);

  if (timingSafeEqual(username, auth.username) && timingSafeEqual(password, auth.password)) {
    return next();
  }

  return unauthorized(res);
}

function unauthorized(res: Response) {
  res.setHeader("WWW-Authenticate", 'Basic realm="Forgejo Runner Manager"');
  return res.status(401).send("Authentication required");
}
