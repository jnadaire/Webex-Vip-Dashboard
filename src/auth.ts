import jwt from "jsonwebtoken";
import { Request, Response, NextFunction } from "express";
import { adminUsers, config, readonlyUsers } from "./config.js";
import { AuthUser, UserRole } from "./types.js";

declare global {
  namespace Express {
    interface Request {
      user?: AuthUser;
    }
  }
}

export function issueToken(email: string) {
  const normalized = email.trim().toLowerCase();
  const role = resolveRole(normalized);
  return jwt.sign({ email: normalized, role }, config.JWT_SECRET, { expiresIn: "12h" });
}

function resolveRole(email: string): UserRole {
  if (adminUsers.has(email)) {
    return "admin";
  }
  if (readonlyUsers.has(email)) {
    return "readonly";
  }
  return "readonly";
}

export function requireAuth(req: Request, res: Response, next: NextFunction) {
  const header = req.header("authorization");
  if (!header?.startsWith("Bearer ")) {
    res.status(401).json({ error: "Missing Bearer token" });
    return;
  }

  const token = header.substring("Bearer ".length);
  try {
    const payload = jwt.verify(token, config.JWT_SECRET) as AuthUser;
    req.user = payload;
    next();
  } catch {
    res.status(401).json({ error: "Invalid token" });
  }
}

export function requireRole(role: UserRole) {
  return (req: Request, res: Response, next: NextFunction) => {
    if (!req.user) {
      res.status(401).json({ error: "Unauthenticated" });
      return;
    }
    if (req.user.role !== role && req.user.role !== "admin") {
      res.status(403).json({ error: "Forbidden" });
      return;
    }
    next();
  };
}
